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

func (r *Repository) handlerStats(ctx context.Context, name pgtype.Text) ([]HandlerStat, error) {
	rows, err := r.q.HandlerStats(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("handler stats: %w", err)
	}

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
			Queues: row.Queues,
		}
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
	return out, nil
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
