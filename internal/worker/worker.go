package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"runtime/debug"
	"sort"
	"sync"
	"time"

	"github.com/amoghar29/kairos/internal/cron"
	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/amoghar29/kairos/internal/queue"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/go-redis/v9"
)

type WorkerService struct {
	jobRepo     *job.Repository
	rdb         *redis.Client
	log         *slog.Logger
	logs        *logSink
	cfg         Config
	queues      []string
	name        string
	id          uuid.UUID
	startedAt   time.Time
	mu          sync.RWMutex
	inflight    map[pgtype.UUID]InflightJob
	concurrency int
	sem         chan struct{}
	handlers    map[string]HandlerFunc
}

func NewWorkerService(jobRepo *job.Repository, rdb *redis.Client, log *slog.Logger, cfg Config, name string, queues []string, concurrency int, handlers map[string]HandlerFunc) *WorkerService {
	return &WorkerService{
		jobRepo:     jobRepo,
		rdb:         rdb,
		log:         log,
		logs:        newLogSink(cfg.LogFlushThreshold, cfg.LogBufferCapacity),
		cfg:         cfg,
		name:        name,
		queues:      queues,
		handlers:    handlers,
		concurrency: concurrency,
		sem:         make(chan struct{}, concurrency),
		id:          uuid.New(),
		startedAt:   time.Now().UTC(),
		inflight:    make(map[pgtype.UUID]InflightJob),
	}
}

// The name is operator-chosen and reused across restarts, so the run id is what keeps two
// processes of the same name apart. Together they are the worker's identity everywhere it
// is recorded: the registry key and job_attempts.worker_id.
func (w *WorkerService) identity() string {
	return fmt.Sprintf("%s:%s", w.name, w.id)
}

const registryKeyPrefix = "kairos:worker:"

func (w *WorkerService) registryKey() string {
	return registryKeyPrefix + w.identity()
}

func (w *WorkerService) staleDelta() pgtype.Interval {
	return pgtype.Interval{
		Microseconds: w.cfg.StaleDelta().Microseconds(),
		Valid:        true,
	}
}

func (w *WorkerService) trackJob(j InflightJob) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.inflight[j.ID] = j
}

func (w *WorkerService) abandonJob(id pgtype.UUID, version int32) (InflightJob, bool) {
	w.mu.Lock()
	runningJob, tracked := w.inflight[id]
	if tracked && runningJob.Version == version {
		delete(w.inflight, id)
	}
	w.mu.Unlock()

	if !tracked || runningJob.Version != version {
		return InflightJob{}, false
	}
	if runningJob.Cancel != nil {
		runningJob.Cancel()
	}
	return runningJob, true
}

func (w *WorkerService) untrackJob(id pgtype.UUID) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.inflight, id)
}
func (w *WorkerService) publishRegistry(ctx context.Context) error {
	w.mu.RLock()
	jobs := make([]InflightJob, 0, len(w.inflight))
	for _, runningJob := range w.inflight {
		jobs = append(jobs, runningJob)
	}

	w.mu.RUnlock()
	handlers := make([]string, 0, len(w.handlers))
	for h := range w.handlers {
		handlers = append(handlers, h)
	}
	sort.Strings(handlers)

	payload, err := json.Marshal((RegistryEntry{
		Name:      w.name,
		ID:        w.id,
		Queues:    w.queues,
		Handlers:  handlers,
		InFlight:  jobs,
		StartedAt: w.startedAt,
		LastSeen:  time.Now().UTC(),
	}))

	if err != nil {
		return fmt.Errorf("marshal registry entry: %w", err)

	}
	return w.rdb.Set(ctx, w.registryKey(), payload, w.cfg.RegistryTTL.Std()).Err()
}

func (w *WorkerService) deregister() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := w.rdb.Del(ctx, w.registryKey()).Err(); err != nil {
		w.log.Warn("deregister failed, entry will expire via TTL", "err", err)
	}
}

func (w *WorkerService) runRegistry(ctx context.Context) error {
	if err := w.publishRegistry(ctx); err != nil {
		w.log.Warn("initial registry announce failed", "err", err)
	}

	t := time.NewTicker(w.cfg.RegistryInterval.Std())
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			w.deregister()
			return nil

		case <-t.C:
			if err := w.publishRegistry(ctx); err != nil {
				w.log.Warn("registry refresh failed", "err", err)
			}
		}
	}
}

func (w *WorkerService) runHeartbeatRefresher(ctx context.Context) error {
	t := time.NewTicker(w.cfg.HeartbeatInterval.Std())
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			if err := w.refreshHeartbeat(ctx); err != nil {
				w.log.Warn("heartbeat refresh failed", "err", err)
			}
		}
	}
}

func (w *WorkerService) refreshHeartbeat(ctx context.Context) error {
	w.mu.RLock()
	claims := make([]job.JobClaim, 0, len(w.inflight))
	for _, runningJob := range w.inflight {
		claims = append(claims, job.JobClaim{
			ID:      runningJob.ID,
			Version: runningJob.Version,
		})
	}
	w.mu.RUnlock()

	if len(claims) == 0 {
		return nil
	}

	renewed, err := w.jobRepo.RefreshHeartbeats(ctx, claims, w.staleDelta())
	if err != nil {
		return fmt.Errorf("refresh heartbeats: %w", err)
	}

	held := make(map[pgtype.UUID]struct{}, len(renewed))
	for _, id := range renewed {
		held[id] = struct{}{}
	}
	for _, c := range claims {
		if _, ok := held[c.ID]; ok {
			continue
		}
		abandoned, ok := w.abandonJob(c.ID, c.Version)
		if !ok {
			continue
		}
		w.log.Warn("lost job claim, cancelling execution", "job_id", c.ID, "version", c.Version)

		if _, err := w.jobRepo.CompleteAttempt(ctx, abandoned.AttemptID, db.AttemptOutcomeCancelled, pgtype.Text{String: lostClaimResult, Valid: true}); err != nil {
			w.log.Error("close attempt for lost claim",
				"job_id", c.ID, "attempt_id", abandoned.AttemptID, "err", err)
		}
	}

	return nil
}

func (w *WorkerService) flushLogger(ctx context.Context) error {
	t := time.NewTicker(w.cfg.LogFlushInterval.Std())
	defer t.Stop()
	// TODO: if the insert fails, try not to drain and try to insert again in next run
	for {
		select {
		case <-ctx.Done():
			final, cancel := context.WithTimeout(context.Background(), w.cfg.LogFlushTimeout.Std())
			w.flushLogs(final)
			cancel()
			return nil

		case <-t.C:
			w.flushLogs(ctx)

		case <-w.logs.wake:
			w.flushLogs(ctx)
		}
	}
}

func (w *WorkerService) flushLogs(ctx context.Context) {
	lines, dropped := w.logs.drain()
	if dropped > 0 {
		w.log.Warn("log buffer full, lines discarded", "dropped", dropped)
	}
	if len(lines) == 0 {
		return
	}

	if _, err := w.jobRepo.InsertJobLogs(ctx, lines); err != nil {
		w.log.Error("flush job logs", "lines", len(lines), "err", err)
	}
}

func (w *WorkerService) executeJob(ctx context.Context, jobID pgtype.UUID) {
	defer func() { <-w.sem }()

	claimed, err := w.jobRepo.ClaimForExecution(ctx, jobID, w.identity(), w.staleDelta())
	if err != nil {
		// Someone else claimed it, or it is gone
		if errors.Is(err, job.ErrConflict) || errors.Is(err, job.ErrNotFound) {
			return
		}
		w.log.Error("claim job for execution", "job_id", jobID, "err", err)
		return
	}

	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	w.trackJob(InflightJob{
		Name:      claimed.Name,
		ID:        claimed.ID,
		AttemptID: claimed.AttemptID,
		Version:   claimed.Version,
		Queue:     claimed.Queue,
		Handler:   claimed.Handler,
		StartedAt: time.Now().UTC(),
		Cancel:    cancel,
	})
	defer w.untrackJob(claimed.ID)

	logs := newJobLogger(w.logs, claimed.AttemptID)
	result, runErr := w.runHandler(jobCtx, claimed, logs)

	w.recordOutcome(ctx, claimed, result, runErr)
}

func (w *WorkerService) nextRun(claimed db.ClaimJobForExecutionRow) pgtype.Timestamptz {
	if claimed.JobType != db.JobTypeCron {
		return pgtype.Timestamptz{}
	}

	now := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	next, err := cron.NextRun(claimed.CronExpr.String, now)
	if err != nil {
		w.log.Error("compute next cron run", "job_id", claimed.ID, "cron", claimed.CronExpr.String, "err", err)
		return pgtype.Timestamptz{}
	}
	return next
}

func (w *WorkerService) recordOutcome(ctx context.Context, claimed db.ClaimJobForExecutionRow, result string, runErr error) {
	// Detached: this runs *because* the context ended, so inheriting its cancellation
	// would mean a job that finished during shutdown never records that it did, and gets
	// reclaimed and run a second time.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), w.cfg.OutcomeWriteTimeout.Std())
	defer cancel()

	outcome, attemptResult := db.AttemptOutcomeSuccess, result
	if runErr != nil {
		outcome, attemptResult = db.AttemptOutcomeFailed, runErr.Error()
		w.log.Error("job execution failed", "job_id", claimed.ID, "handler", claimed.Handler, "err", runErr)
	}

	if _, err := w.jobRepo.CompleteAttempt(ctx, claimed.AttemptID, outcome, pgtype.Text{String: attemptResult, Valid: true}); err != nil {
		w.log.Error("close attempt", "job_id", claimed.ID, "attempt_id", claimed.AttemptID, "err", err)
	}

	if runErr == nil {
		applied, err := w.jobRepo.CompleteJob(ctx, claimed.ID, claimed.Version, w.nextRun(claimed))
		if err != nil {
			w.log.Error("mark job success", "job_id", claimed.ID, "err", err)
		} else if !applied {
			w.log.Warn("job no longer ours at completion", "job_id", claimed.ID, "version", claimed.Version)
		}
		return
	}

	nextCheckAt := pgtype.Timestamptz{Time: time.Now().UTC().Add(w.retryDelay(claimed.RetryCount)), Valid: true}
	applied, err := w.jobRepo.RecordExecutionFailure(ctx, claimed.ID, claimed.Version, nextCheckAt)
	if err != nil {
		w.log.Error("record job failure", "job_id", claimed.ID, "err", err)
	} else if !applied {
		w.log.Warn("job no longer ours at completion", "job_id", claimed.ID, "version", claimed.Version)
	}
}

func (w *WorkerService) retryDelay(retryCount int32) time.Duration {
	base := w.cfg.RetryBackoffBase.Std()
	window := w.cfg.RetryBackoffMax.Std()

	if retryCount < 32 {
		if scaled := base << uint(retryCount); scaled > 0 && scaled < window {
			window = scaled
		}
	}
	return time.Duration(rand.Int64N(int64(window)) + 1)
}

func (w *WorkerService) runHandler(ctx context.Context, claimed db.ClaimJobForExecutionRow, logs *JobLogger) (result string, err error) {
	fn, ok := w.handlers[claimed.Handler]
	if !ok {
		return "", fmt.Errorf("no handler registered for %q", claimed.Handler)
	}

	defer func() {
		if r := recover(); r != nil {
			result = ""
			err = fmt.Errorf("handler %q panicked: %v\n%s", claimed.Handler, r, debug.Stack())
		}
	}()

	return fn(ctx, Job{
		ID:         uuid.UUID(claimed.ID.Bytes),
		Name:       claimed.Name,
		Queue:      claimed.Queue,
		Handler:    claimed.Handler,
		Payload:    claimed.Payload,
		RetryCount: claimed.RetryCount,
		MaxRetries: claimed.MaxRetries,
		Logs:       logs,
	})
}

func rotate(keys []string) {
	if len(keys) < 2 {
		return
	}
	first := keys[0]
	copy(keys, keys[1:])
	keys[len(keys)-1] = first
}

func (w *WorkerService) PopAndDispatchJobs(ctx context.Context) error {
	keys := make([]string, len(w.queues))
	for i, q := range w.queues {
		keys[i] = queue.Key(q)
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case w.sem <- struct{}{}:
		}

		popped, err := w.rdb.BRPop(ctx, w.cfg.BRPopTimeout.Std(), keys...).Result()
		if err != nil {
			<-w.sem
			if errors.Is(err, redis.Nil) {
				continue
			}
			if ctx.Err() != nil {
				return nil
			}
			w.log.Error("brpop", "queues", w.queues, "err", err)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(w.cfg.BRPopTimeout.Std()):
			}
			continue
		}

		if w.cfg.QueueStrategy == QueueStrategyRoundRobin {
			rotate(keys)
		}

		var id pgtype.UUID
		if err := id.Scan(popped[1]); err != nil {
			<-w.sem
			w.log.Error("bad job id in queue", "queue", popped[0], "value", popped[1], "err", err)
			continue
		}

		go w.executeJob(ctx, id)
	}
}

// ctx cancellation only stops new work being taken. The maintenance loops run on a
// detached context so claims keep being renewed and logs keep flushing while in-flight
// jobs drain; they stop once the drain is over.
func (w *WorkerService) Run(ctx context.Context) error {
	bgCtx, stopBackground := context.WithCancel(context.WithoutCancel(ctx))
	defer stopBackground()

	var wg sync.WaitGroup
	for _, loop := range []func(context.Context) error{
		w.runRegistry,
		w.runHeartbeatRefresher,
		w.flushLogger,
	} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := loop(bgCtx); err != nil {
				w.log.Error("worker loop exited", "err", err)
			}
		}()
	}

	err := w.PopAndDispatchJobs(ctx)

	w.drainInflight()
	stopBackground()
	wg.Wait()

	return err
}

func (w *WorkerService) drainInflight() {
	grace := time.NewTimer(w.cfg.ShutdownGrace.Std())
	defer grace.Stop()

	for held := 0; held < w.concurrency; held++ {
		select {
		case w.sem <- struct{}{}:
		case <-grace.C:
			w.log.Warn("shutdown grace expired, abandoning in-flight jobs",
				"remaining", w.concurrency-held)
			return
		}
	}
}
