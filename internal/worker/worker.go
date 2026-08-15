package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/go-redis/v9"
)

const lostLeaseResult = "lease lost while executing: the job was reclaimed or finished elsewhere"

type InflightJob struct {
	Name      string
	ID        pgtype.UUID
	AttemptID pgtype.UUID
	Version   int32
	Queue     string
	Handler   string
	Cancel    context.CancelFunc `json:"-"`
}
type registryEntry struct {
	ID        uuid.UUID     `json:"id"`
	Queues    []string      `json:"queues"`
	InFlight  []InflightJob `json:"in_flight"`
	StartedAt time.Time     `json:"started_at"`
	LastSeen  time.Time     `json:"last_seen"`
}
type WorkerService struct {
	jobRepo   *job.JobRepository
	rdb       *redis.Client
	log       *slog.Logger
	logs      *logSink
	cfg       Config
	queues    []string
	id        uuid.UUID
	startedAt time.Time
	mu        sync.RWMutex
	inflight  map[pgtype.UUID]InflightJob
}

func NewWorkerService(jobRepo *job.JobRepository, rdb *redis.Client, log *slog.Logger, cfg Config, queues []string) (*WorkerService, error) {
	if len(queues) == 0 {
		return nil, fmt.Errorf("worker must serve at least one queue")
	}
	seen := make(map[string]struct{}, len(queues))
	for _, q := range queues {
		if q == "" {
			return nil, fmt.Errorf("queue name must not be empty")
		}
		if _, dup := seen[q]; dup {
			return nil, fmt.Errorf("duplicate queue name %q", q)
		}
		seen[q] = struct{}{}
	}

	return &WorkerService{
		jobRepo:   jobRepo,
		rdb:       rdb,
		log:       log,
		logs:      newLogSink(cfg.LogFlushThreshold, cfg.LogBufferCapacity),
		cfg:       cfg,
		queues:    queues,
		id:        uuid.New(),
		startedAt: time.Now().UTC(),
		inflight:  make(map[pgtype.UUID]InflightJob),
	}, nil
}

func (w *WorkerService) registryKey() string {
	return fmt.Sprintf("kairos:worker:%s", w.id)
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
	payload, err := json.Marshal((registryEntry{
		ID:        w.id,
		Queues:    w.queues,
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
	leases := make([]job.JobLease, 0, len(w.inflight))
	for _, runningJob := range w.inflight {
		leases = append(leases, job.JobLease{
			ID:      runningJob.ID,
			Version: runningJob.Version,
		})
	}
	w.mu.RUnlock()

	if len(leases) == 0 {
		return nil
	}

	renewed, err := w.jobRepo.RefreshHeartbeats(ctx, leases, w.staleDelta())
	if err != nil {
		return fmt.Errorf("refresh heartbeats: %w", err)
	}

	held := make(map[pgtype.UUID]struct{}, len(renewed))
	for _, id := range renewed {
		held[id] = struct{}{}
	}
	for _, l := range leases {
		if _, ok := held[l.ID]; ok {
			continue
		}
		abandoned, ok := w.abandonJob(l.ID, l.Version)
		if !ok {
			continue
		}
		w.log.Warn("lost job lease, cancelling execution", "job_id", l.ID, "version", l.Version)

		if _, err := w.jobRepo.CompleteAttempt(ctx, abandoned.AttemptID, db.AttemptOutcomeCancelled, pgtype.Text{String: lostLeaseResult, Valid: true}); err != nil {
			w.log.Error("close attempt for lost lease",
				"job_id", l.ID, "attempt_id", abandoned.AttemptID, "err", err)
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

func (w *WorkerService) Run(ctx context.Context) error {

	go w.runRegistry(ctx)
	go w.runHeartbeatRefresher(ctx)
	go w.flushLogger(ctx)

	return nil
}
