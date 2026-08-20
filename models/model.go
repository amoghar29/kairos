// Package models holds the wire contract shared by the Kairos HTTP API and
// its clients. Nothing here may import internal packages.
package models

import (
	"encoding/json"
	"time"
)

const (
	CodeInvalidJSON      = "invalid_json"
	CodeValidationFailed = "validation_failed"
	CodeNotFound         = "not_found"
	CodeConflict         = "conflict"
	CodeInternal         = "internal_error"
)

type ErrorResponse struct {
	Message string            `json:"message"`
	Code    string            `json:"code"`
	Fields  map[string]string `json:"fields,omitempty"`
}

type CreateJobRequest struct {
	Name       string          `json:"name"`
	Queue      string          `json:"queue"`
	Handler    string          `json:"handler"`
	Payload    json.RawMessage `json:"payload"`
	Priority   *int32          `json:"priority"`
	MaxRetries *int32          `json:"max_retries"`
	Cron       string          `json:"cron"`
	StartsAt   *time.Time      `json:"starts_at"`
	EndsAt     *time.Time      `json:"ends_at"`
}

type VersionRequest struct {
	Version int32 `json:"version"`
}

type PauseRequest struct {
	Version int32 `json:"version"`
	Paused  *bool `json:"paused"`
}

type RescheduleRequest struct {
	Version  int32      `json:"version"`
	Cron     string     `json:"cron"`
	StartsAt *time.Time `json:"starts_at"`
	EndsAt   *time.Time `json:"ends_at"`
}

type JobResponse struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Queue          string          `json:"queue"`
	Handler        string          `json:"handler"`
	State          string          `json:"state"`
	Payload        json.RawMessage `json:"payload"`
	Priority       int32           `json:"priority"`
	RetryCount     int32           `json:"retry_count"`
	MaxRetries     int32           `json:"max_retries"`
	DeliveryCount  int32           `json:"delivery_count"`
	Version        int32           `json:"version"`
	NextCheckAt    *time.Time      `json:"next_check_at"`
	IdempotencyKey *string         `json:"idempotency_key"`
	JobType        string          `json:"job_type"`
	Cron           *string         `json:"cron"`
	NextRunAt      *time.Time      `json:"next_run_at"`
	StartsAt       *time.Time      `json:"starts_at"`
	EndsAt         *time.Time      `json:"ends_at"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

type JobAttemptResponse struct {
	ID         string     `json:"id"`
	JobID      string     `json:"job_id"`
	WorkerID   *string    `json:"worker_id"`
	Outcome    string     `json:"outcome"`
	Result     *string    `json:"result"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

type JobLogResponse struct {
	Seq       int32     `json:"seq"`
	Level     string    `json:"level"`
	Line      string    `json:"line"`
	CreatedAt time.Time `json:"created_at"`
}

type JobLogListResponse struct {
	Logs    []JobLogResponse `json:"logs"`
	NextSeq *int32           `json:"next_seq"`
}

type PaginationResponse struct {
	Limit   int32 `json:"limit"`
	Offset  int32 `json:"offset"`
	HasMore bool  `json:"has_more"`
}

type JobListResponse struct {
	Jobs       []JobResponse      `json:"jobs"`
	Pagination PaginationResponse `json:"pagination"`
}

type JobAttemptListResponse struct {
	Attempts   []JobAttemptResponse `json:"attempts"`
	Pagination PaginationResponse   `json:"pagination"`
}

type AttemptListResponse struct {
	Attempts   []AttemptStat      `json:"attempts"`
	Pagination PaginationResponse `json:"pagination"`
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

type QueueListResponse struct {
	Queues []QueueStat `json:"queues"`
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

type InflightJobResponse struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Queue     string    `json:"queue"`
	Handler   string    `json:"handler"`
	StartedAt time.Time `json:"started_at"`
}

type WorkerResponse struct {
	ID           string                `json:"id"`
	Name         string                `json:"name"`
	Queues       []string              `json:"queues"`
	InFlight     int                   `json:"in_flight"`
	InFlightJobs []InflightJobResponse `json:"in_flight_jobs"`
	StartedAt    time.Time             `json:"started_at"`
	LastSeen     time.Time             `json:"last_seen"`
}

type WorkerListResponse struct {
	Workers []WorkerResponse `json:"workers"`
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

type HandlerListResponse struct {
	Handlers []HandlerStat `json:"handlers"`
}

type HandlerDetailResponse struct {
	Handler HandlerStat   `json:"handler"`
	Jobs    []JobResponse `json:"jobs"`
}
