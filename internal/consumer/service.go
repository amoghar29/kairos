package consumer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/amoghar29/kairos/internal/config"
	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/amoghar29/kairos/internal/queue"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/go-redis/v9"
)

type JobConsumer struct {
	jobRepository *job.JobRepository
	rdb           *redis.Client
	cfg           config.ConsumerConfig
	logger        *slog.Logger
}

func NewJobConsumer(jobRepository *job.JobRepository, rdb *redis.Client, cfg config.ConsumerConfig, logger *slog.Logger) *JobConsumer {
	return &JobConsumer{
		jobRepository: jobRepository,
		rdb:           rdb,
		cfg:           cfg,
		logger:        logger,
	}
}

func (jc *JobConsumer) pushJobsToRedis(ctx context.Context, jobs []db.GetDueJobsRow) ([]pgtype.UUID, error) {
	var pushed []pgtype.UUID
	var errs []error

	for start := 0; start < len(jobs); {
		currQueue := jobs[start].Queue

		end := start
		for end < len(jobs) && jobs[end].Queue == currQueue {
			end++
		}
		group := jobs[start:end]
		start = end

		ids := make([]any, 0, len(group))
		for _, job := range group {
			ids = append(ids, job.ID.String())
		}

		key := queue.Key(currQueue)
		if err := jc.rdb.LPush(ctx, key, ids...).Err(); err != nil {
			errs = append(errs, fmt.Errorf("lpush %s: %w", key, err))
			continue
		}

		for _, job := range group {
			pushed = append(pushed, job.ID)
		}
	}

	return pushed, errors.Join(errs...)
}

func (jc *JobConsumer) claimDeadline() pgtype.Interval {
	return pgtype.Interval{
		Microseconds: int64(jc.cfg.ClaimDeadline) * int64(time.Second/time.Microsecond),
		Valid:        true,
	}
}

func (jc *JobConsumer) markJobAsQueued(ctx context.Context, ids []pgtype.UUID) ([]pgtype.UUID, error) {
	return jc.jobRepository.MarksJobAsQueued(ctx, ids, jc.claimDeadline())
}

func (jc *JobConsumer) runOnce(ctx context.Context) (int, error) {
	if err := jc.reclaimStale(ctx); err != nil {
		return 0, err
	}

	if err := jc.updateLostJobs(ctx); err != nil {
		return 0, err
	}

	if err := jc.finalizeExpiredJobs(ctx); err != nil {
		return 0, err
	}

	jobs, err := jc.claimDue(ctx)
	if err != nil {
		return 0, fmt.Errorf("claim due jobs: %w", err)
	}

	if len(jobs) == 0 {
		return 0, nil
	}

	pushed, err := jc.pushJobsToRedis(ctx, jobs)
	if len(pushed) == 0 {
		if err != nil {
			return 0, fmt.Errorf("push jobs to redis: %w", err)
		}
		return 0, nil
	}
	if err != nil {
		jc.logger.Warn("pushed jobs but some queues failed",
			slog.Int("pushed", len(pushed)),
			slog.Int("claimed", len(jobs)),
			slog.Any("error", err),
		)
	}

	queued, err := jc.markJobAsQueued(ctx, pushed)
	if err != nil {
		return 0, fmt.Errorf("mark %d pushed jobs as queued: %w", len(pushed), err)
	}
	if len(queued) != len(pushed) {
		jc.logger.Warn("some pushed jobs were no longer eligible to queue",
			slog.Int("pushed", len(pushed)),
			slog.Int("queued", len(queued)),
		)
	}

	jc.logger.Info("poll complete",
		slog.Int("claimed", len(jobs)),
		slog.Int("queued", len(queued)),
	)
	return len(queued), nil
}

func (jc *JobConsumer) reclaimStale(ctx context.Context) error {
	reclaimed, err := jc.jobRepository.ReclaimStale(ctx, int32(jc.cfg.MaxDeliveryCount))
	if err != nil {
		return fmt.Errorf("reclaim stale jobs: %w", err)
	}

	if len(reclaimed) == 0 {
		return nil
	}

	ids := make([]pgtype.UUID, len(reclaimed))
	for i, reclaimedJob := range reclaimed {
		ids[i] = reclaimedJob.ID
	}

	if err := jc.jobRepository.SupersedeOpenAttempts(ctx, ids); err != nil {
		jc.logger.Error("supersede open attempts", slog.Any("error", err))
	}

	jc.logger.Info("reclaimed stale jobs", slog.Int("count", len(reclaimed)))

	return nil
}

const lostDispatchResult = "dispatched to redis but no worker claimed it before the claim deadline passed"

func (jc *JobConsumer) updateLostJobs(ctx context.Context) error {
	lost, err := jc.jobRepository.UpdateLostJob(ctx, lostDispatchResult)
	if err != nil {
		return fmt.Errorf("update lost jobs: %w", err)
	}
	if len(lost) == 0 {
		return nil
	}

	jc.logger.Info("requeued jobs past their claim deadline", slog.Int("count", len(lost)))

	return nil
}

func (jc *JobConsumer) finalizeExpiredJobs(ctx context.Context) error {
	expired, err := jc.jobRepository.FinalizeExpiredJobs(ctx)
	if err != nil {
		return fmt.Errorf("finalize expired jobs: %w", err)
	}
	if len(expired) == 0 {
		return nil
	}

	jc.logger.Info("expired jobs past their end date", slog.Int("count", len(expired)))

	return nil
}

func (jc *JobConsumer) claimDue(ctx context.Context) ([]db.GetDueJobsRow, error) {
	dueJobs, err := jc.jobRepository.GetJobsReadyToRun(ctx, jc.cfg.QueueLimit, jc.cfg.AgingRate)
	if err != nil {
		return nil, err
	}
	return dueJobs, nil
}

func (jc *JobConsumer) RunConsumer(ctx context.Context) {
	interval := time.Duration(jc.cfg.PollInterval) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	jc.logger.Info("consumer started", slog.Duration("poll_interval", interval))

	for {
		if count, err := jc.runOnce(ctx); err != nil {
			jc.logger.Error("poll failed", slog.Any("error", err))
		} else {
			jc.logger.Info("poll complete", slog.Int("queued", count))
		}

		select {
		case <-ctx.Done():
			jc.logger.Info("consumer stopping", slog.Any("reason", ctx.Err()))
			return
		case <-ticker.C:
		}
	}
}
