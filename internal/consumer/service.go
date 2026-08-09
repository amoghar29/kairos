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
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/go-redis/v9"
)

const queueKeyPrefix = "queue:"

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

// Rows arrive ordered by queue, so each contiguous run is one queue's batch.
// A queue whose push fails is skipped, not returned: its jobs stay unclaimed and are refetched next poll.
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

		key := queueKeyPrefix + currQueue
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

func (jc *JobConsumer) markJobAsQueued(ctx context.Context, ids []pgtype.UUID) ([]pgtype.UUID, error) {
	return jc.jobRepository.MarksJobAsQueued(ctx, ids)
}

func (jc *JobConsumer) runOnce(ctx context.Context) (int, error) {
	if err := jc.reclaimStale(ctx); err != nil {
		return 0, err
	}

	jobs, err := jc.claimDue(ctx)
	if err != nil {
		return 0, fmt.Errorf("claim due jobs: %w", err)
	}

	if len(jobs) == 0 {
		return 0, nil
	}

	//  push to redis first and then update postgres
	// since we cannot have transaction support when operating btw different services
	// So we first push to redis and then update db, even if the system crashes after push and before update
	// it is fine, since we gurantee Atleast once execution .
	pushed, err := jc.pushJobsToRedis(ctx, jobs)
	if len(pushed) == 0 {
		if err != nil {
			return 0, fmt.Errorf("push jobs to redis: %w", err)
		}
		return 0, nil
	}
	if err != nil {
		// Some queues made it. Mark those and let the rest come back next poll.
		jc.logger.Warn("pushed jobs but some queues failed",
			slog.Int("pushed", len(pushed)),
			slog.Int("claimed", len(jobs)),
			slog.Any("error", err),
		)
	}

	queued, err := jc.markJobAsQueued(ctx, pushed)
	if err != nil {
		// The ids are in redis but still look unclaimed in postgres, so the next poll refetches
		// and repushes them. At-least-once still holds; the count says how many may duplicate.
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

	for _, reclaimedJob := range reclaimed {
		// The reclaim already committed; a stuck-open attempt row is cosmetic, so log and keep going.
		if err := jc.jobRepository.SupersedeOpenAttempt(ctx, reclaimedJob.ID); err != nil {
			jc.logger.Error("supersede open attempt",
				slog.String("job_id", reclaimedJob.ID.String()),
				slog.Any("error", err),
			)
		}
	}

	jc.logger.Info("reclaimed stale jobs", slog.Int("count", len(reclaimed)))

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
