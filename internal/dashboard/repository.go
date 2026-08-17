package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/queue"
	"github.com/amoghar29/kairos/internal/worker"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/go-redis/v9"
)

type Repository struct {
	q   db.Querier
	rdb *redis.Client
}

func New(q db.Querier, rdb *redis.Client) *Repository {
	return &Repository{q: q, rdb: rdb}
}

type StateCounts struct {
	Pending       int64 `json:"pending"`
	Queued        int64 `json:"queued"`
	Running       int64 `json:"running"`
	AwaitingRetry int64 `json:"awaiting_retry"`
	Paused        int64 `json:"paused"`
	Success       int64 `json:"success"`
	Dead          int64 `json:"dead"`
	Cancelled     int64 `json:"cancelled"`
	Expired       int64 `json:"expired"`
}

type QueueStat struct {
	Queue                   string      `json:"queue"`
	Counts                  StateCounts `json:"counts"`
	RedisBuffered           int64       `json:"redis_buffered"`
	OldestPendingAgeSeconds float64     `json:"oldest_pending_age_seconds"`
}

type HandlerStat struct {
	Handler        string      `json:"handler"`
	Total          int64       `json:"total"`
	Counts         StateCounts `json:"counts"`
	Queues         []string    `json:"queues"`
	Workers        []string    `json:"workers"`
	Registered     bool        `json:"registered"`
	SuccessRate    *float64    `json:"success_rate"`
	AvgRunMs       *float64    `json:"avg_run_ms"`
	LastActivityAt *time.Time  `json:"last_activity_at"`
}

func (r *Repository) QueueStats(ctx context.Context, configured []string) ([]QueueStat, error) {
	rows, err := r.q.QueueStats(ctx)
	if err != nil {
		return nil, fmt.Errorf("queue stats: %w", err)
	}

	stats := make(map[string]*QueueStat, len(rows)+len(configured))
	order := make([]string, 0, len(rows)+len(configured))
	for _, name := range configured {
		stats[name] = &QueueStat{Queue: name}
		order = append(order, name)
	}
	for _, row := range rows {
		if _, ok := stats[row.Queue]; !ok {
			stats[row.Queue] = &QueueStat{Queue: row.Queue}
			order = append(order, row.Queue)
		}
		stats[row.Queue].Counts = StateCounts{
			Pending:       row.Pending,
			Queued:        row.Queued,
			Running:       row.Running,
			AwaitingRetry: row.AwaitingRetry,
			Paused:        row.Paused,
			Success:       row.Success,
			Dead:          row.Dead,
			Cancelled:     row.Cancelled,
			Expired:       row.Expired,
		}
		stats[row.Queue].OldestPendingAgeSeconds = row.OldestPendingAgeSeconds
	}

	pipe := r.rdb.Pipeline()
	lens := make(map[string]*redis.IntCmd, len(order))
	for _, name := range order {
		lens[name] = pipe.LLen(ctx, queue.Key(name))
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, fmt.Errorf("queue depths: %w", err)
	}
	for name, cmd := range lens {
		if n, err := cmd.Result(); err == nil {
			stats[name].RedisBuffered = n
		}
	}

	out := make([]QueueStat, 0, len(order))
	for _, name := range order {
		out = append(out, *stats[name])
	}
	return out, nil
}

func (r *Repository) HandlerStats(ctx context.Context) ([]HandlerStat, error) {
	return r.handlerStats(ctx, pgtype.Text{})
}

func (r *Repository) HandlerStat(ctx context.Context, name string) (*HandlerStat, error) {
	stats, err := r.handlerStats(ctx, pgtype.Text{String: name, Valid: true})
	if err != nil {
		return nil, err
	}
	if len(stats) == 0 {
		return nil, nil
	}
	return &stats[0], nil
}

// Counts come from job rows; presence comes from the live worker registry. The two answer
// different questions — history versus what a running process can execute right now — and a
// handler can appear in either without the other.
func (r *Repository) handlerStats(ctx context.Context, name pgtype.Text) ([]HandlerStat, error) {
	rows, err := r.q.HandlerStats(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("handler stats: %w", err)
	}

	live := r.liveHandlers(ctx)
	seen := make(map[string]struct{}, len(rows))

	out := make([]HandlerStat, 0, len(rows))
	for _, row := range rows {
		stat := HandlerStat{
			Handler: row.Handler,
			Total:   row.Total,
			Counts: StateCounts{
				Pending:       row.Pending,
				Queued:        row.Queued,
				Running:       row.Running,
				AwaitingRetry: row.AwaitingRetry,
				Paused:        row.Paused,
				Success:       row.Success,
				Dead:          row.Dead,
				Cancelled:     row.Cancelled,
				Expired:       row.Expired,
			},
			Queues:     row.Queues,
			Workers:    live[row.Handler],
			Registered: len(live[row.Handler]) > 0,
		}
		if stat.Workers == nil {
			stat.Workers = []string{}
		}
		seen[row.Handler] = struct{}{}
		if row.LastActivityAt.Valid {
			t := row.LastActivityAt.Time.UTC()
			stat.LastActivityAt = &t
		}
		if v, ok := row.AvgRunMs.(float64); ok {
			stat.AvgRunMs = &v
		}
		if terminal := row.Success + row.Dead; terminal > 0 {
			rate := float64(row.Success) / float64(terminal)
			stat.SuccessRate = &rate
		}
		out = append(out, stat)
	}

	// A registered handler with no job rows is invisible to the query — a fresh deploy, or
	// one nothing has ever been enqueued for. Those are exactly the ones worth seeing.
	for handler, workers := range live {
		if _, ok := seen[handler]; ok {
			continue
		}
		if name.Valid && handler != name.String {
			continue
		}
		out = append(out, HandlerStat{
			Handler:    handler,
			Queues:     []string{},
			Workers:    workers,
			Registered: true,
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Handler < out[j].Handler })
	return out, nil
}


func (r *Repository) liveHandlers(ctx context.Context) map[string][]string {
	entries, err := r.Workers(ctx)
	if err != nil {

		return nil
	}

	byHandler := make(map[string]map[string]struct{})
	for _, entry := range entries {
		for _, handler := range entry.Handlers {
			if byHandler[handler] == nil {
				byHandler[handler] = make(map[string]struct{})
			}
			byHandler[handler][entry.Name] = struct{}{}
		}
	}

	out := make(map[string][]string, len(byHandler))
	for handler, names := range byHandler {
		workers := make([]string, 0, len(names))
		for n := range names {
			workers = append(workers, n)
		}
		sort.Strings(workers)
		out[handler] = workers
	}
	return out
}

func (r *Repository) RecentJobsByHandler(ctx context.Context, handler string, limit int32) ([]db.Job, error) {
	jobs, err := r.q.RecentJobsByHandler(ctx, db.RecentJobsByHandlerParams{
		Handler:   handler,
		PageLimit: limit,
	})
	if err != nil {
		return nil, fmt.Errorf("recent jobs for handler %s: %w", handler, err)
	}
	return jobs, nil
}

type AttemptFilter struct {
	Outcome string
	Handler string
	Queue   string
}

type AttemptStat struct {
	ID         string     `json:"id"`
	JobID      string     `json:"job_id"`
	JobName    string     `json:"job_name"`
	Queue      string     `json:"queue"`
	Handler    string     `json:"handler"`
	WorkerID   *string    `json:"worker_id"`
	Outcome    string     `json:"outcome"`
	Result     *string    `json:"result"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

func (r *Repository) Attempts(ctx context.Context, f AttemptFilter, limit, offset int32) ([]AttemptStat, error) {
	arg := db.RecentAttemptsParams{
		Handler:    pgtype.Text{String: f.Handler, Valid: f.Handler != ""},
		Queue:      pgtype.Text{String: f.Queue, Valid: f.Queue != ""},
		PageLimit:  limit,
		PageOffset: offset,
	}
	if f.Outcome != "" {
		arg.Outcome = db.NullAttemptOutcome{AttemptOutcome: db.AttemptOutcome(f.Outcome), Valid: true}
	}

	rows, err := r.q.RecentAttempts(ctx, arg)
	if err != nil {
		return nil, fmt.Errorf("recent attempts: %w", err)
	}

	out := make([]AttemptStat, 0, len(rows))
	for _, row := range rows {
		stat := AttemptStat{
			ID:        row.ID.String(),
			JobID:     row.JobID.String(),
			JobName:   row.JobName,
			Queue:     row.Queue,
			Handler:   row.Handler,
			Outcome:   string(row.Outcome),
			StartedAt: row.StartedAt.Time.UTC(),
		}
		if row.WorkerID.Valid {
			stat.WorkerID = &row.WorkerID.String
		}
		if row.Result.Valid {
			stat.Result = &row.Result.String
		}
		if row.FinishedAt.Valid {
			t := row.FinishedAt.Time.UTC()
			stat.FinishedAt = &t
		}
		out = append(out, stat)
	}
	return out, nil
}

func (r *Repository) Workers(ctx context.Context) ([]worker.RegistryEntry, error) {
	var keys []string
	iter := r.rdb.Scan(ctx, 0, worker.RegistryMatchPattern(), 100).Iterator()
	for iter.Next(ctx) {
		keys = append(keys, iter.Val())
	}
	if err := iter.Err(); err != nil {
		return nil, fmt.Errorf("scan worker registry: %w", err)
	}
	if len(keys) == 0 {
		return []worker.RegistryEntry{}, nil
	}

	values, err := r.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("read worker registry: %w", err)
	}

	entries := make([]worker.RegistryEntry, 0, len(values))
	for _, v := range values {
		s, ok := v.(string)
		if !ok {
			continue
		}
		var entry worker.RegistryEntry
		if err := json.Unmarshal([]byte(s), &entry); err != nil {
			return nil, fmt.Errorf("decode worker registry entry: %w", err)
		}
		entries = append(entries, entry)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Name != entries[j].Name {
			return entries[i].Name < entries[j].Name
		}
		return entries[i].ID.String() < entries[j].ID.String()
	})
	return entries, nil
}
