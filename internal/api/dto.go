package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
	"github.com/amoghar29/kairos/internal/config"
	"github.com/amoghar29/kairos/internal/cron"
	"github.com/amoghar29/kairos/internal/db"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	defaultPriority   = 5
	defaultMaxRetries = 3

	minPriority   = 1
	maxPriority   = 10
	minMaxRetries = 0
	maxMaxRetries = 25
)

type CreateJobRequest struct {
	Name           string          `json:"name"`
	Queue          string          `json:"queue"`
	Handler        string          `json:"handler"`
	Payload        json.RawMessage `json:"payload"`
	Priority       *int32          `json:"priority"`
	MaxRetries     *int32          `json:"max_retries"`
	IdempotencyKey string          `json:"idempotency_key"`
	Cron           string          `json:"cron"`
	StartsAt       *time.Time      `json:"starts_at"`
	EndsAt         *time.Time      `json:"ends_at"`
}

func validateSchedule(cronExpr string, startsAt, endsAt *time.Time) map[string]string {
	fields := map[string]string{}
	now := time.Now().UTC()

	if cronExpr != "" {
		if err := cron.ValidateExpression(cronExpr); err != nil {
			fields["cron"] = "must be a valid cron expression"
		}
		if startsAt == nil {
			fields["starts_at"] = "must be provided for a cron job"
		}
	}

	if startsAt != nil && !startsAt.After(now) {
		fields["starts_at"] = "must be in the future"
	}

	if endsAt != nil {
		switch {
		case !endsAt.After(now):
			fields["ends_at"] = "must be in the future"
		case startsAt != nil && !endsAt.After(*startsAt):
			fields["ends_at"] = "must be after starts_at"
		}
	}

	if len(fields) == 0 {
		return nil
	}
	return fields
}

func timestamptz(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: t.UTC(), Valid: true}
}

func (r *CreateJobRequest) Validate(queues config.Queues) map[string]string {
	fields := map[string]string{}

	switch {
	case r.Name == "":
		fields["name"] = "must be provided"
	case len(r.Name) > 200:
		fields["name"] = "must not exceed 200 characters"
	}

	switch {
	case r.Queue == "":
		fields["queue"] = "must be provided"
	case !queues.Exists(r.Queue):
		fields["queue"] = fmt.Sprintf("unknown queue %q", r.Queue)
	}

	switch {
	case r.Handler == "":
		fields["handler"] = "must be provided"
	case len(r.Handler) > 200:
		fields["handler"] = "must not exceed 200 characters"
	}

	if r.Priority != nil && (*r.Priority < minPriority || *r.Priority > maxPriority) {
		fields["priority"] = fmt.Sprintf("must be between %d and %d", minPriority, maxPriority)
	}

	if r.MaxRetries != nil && (*r.MaxRetries < minMaxRetries || *r.MaxRetries > maxMaxRetries) {
		fields["max_retries"] = fmt.Sprintf("must be between %d and %d", minMaxRetries, maxMaxRetries)
	}

	if len(r.IdempotencyKey) > 255 {
		fields["idempotency_key"] = "must not exceed 255 characters"
	}

	if len(r.Payload) > 0 && !json.Valid(r.Payload) {
		fields["payload"] = "must be valid JSON"
	}

	for name, msg := range validateSchedule(r.Cron, r.StartsAt, r.EndsAt) {
		fields[name] = msg
	}

	if len(fields) == 0 {
		return nil
	}
	return fields
}


func (r *CreateJobRequest) ToParams() db.CreateJobParams {
	priority := int32(defaultPriority)
	if r.Priority != nil {
		priority = *r.Priority
	}

	maxRetries := int32(defaultMaxRetries)
	if r.MaxRetries != nil {
		maxRetries = *r.MaxRetries
	}

	payload := []byte(r.Payload)
	if len(payload) == 0 {
		payload = []byte("{}")
	}

	arg := db.CreateJobParams{
		Name:           r.Name,
		Queue:          r.Queue,
		Handler:        r.Handler,
		Payload:        payload,
		Priority:       priority,
		MaxRetries:     maxRetries,
		IdempotencyKey: pgtype.Text{String: r.IdempotencyKey, Valid: r.IdempotencyKey != ""},
		JobType:        db.JobTypeAdhoc,
		StartsAt:       timestamptz(r.StartsAt),
		EndsAt:         timestamptz(r.EndsAt),
		NextCheckAt:    pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	}

	if r.StartsAt != nil {
		arg.NextCheckAt = timestamptz(r.StartsAt)
	}

	if r.Cron != "" {
		arg.JobType = db.JobTypeCron
		arg.CronExpr = pgtype.Text{String: r.Cron, Valid: true}
		arg.NextRunAt = arg.StartsAt
	}

	return arg
}

type VersionRequest struct {
	Version int32 `json:"version"`
}

func (r *VersionRequest) Validate() map[string]string {
	if r.Version < 1 {
		return map[string]string{"version": "must be a positive integer"}
	}
	return nil
}

type PauseRequest struct {
	Version int32 `json:"version"`
	Paused  *bool `json:"paused"`
}

func (r *PauseRequest) Validate() map[string]string {
	fields := map[string]string{}
	if r.Version < 1 {
		fields["version"] = "must be a positive integer"
	}
	if r.Paused == nil {
		fields["paused"] = "must be provided"
	}

	if len(fields) == 0 {
		return nil
	}
	return fields
}

type RescheduleRequest struct {
	Version  int32      `json:"version"`
	Cron     string     `json:"cron"`
	StartsAt *time.Time `json:"starts_at"`
	EndsAt   *time.Time `json:"ends_at"`
}

func (r *RescheduleRequest) Validate() map[string]string {
	fields := map[string]string{}
	if r.Version < 1 {
		fields["version"] = "must be a positive integer"
	}

	for name, msg := range validateSchedule(r.Cron, r.StartsAt, r.EndsAt) {
		fields[name] = msg
	}

	if len(fields) == 0 {
		return nil
	}
	return fields
}

func (r *RescheduleRequest) ToParams(id pgtype.UUID) db.RescheduleJobParams {
	arg := db.RescheduleJobParams{
		ID:          id,
		Version:     r.Version,
		JobType:     db.JobTypeAdhoc,
		StartsAt:    timestamptz(r.StartsAt),
		EndsAt:      timestamptz(r.EndsAt),
		NextCheckAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	}

	if r.StartsAt != nil {
		arg.NextCheckAt = timestamptz(r.StartsAt)
	}

	if r.Cron != "" {
		arg.JobType = db.JobTypeCron
		arg.CronExpr = pgtype.Text{String: r.Cron, Valid: true}
		arg.NextRunAt = arg.StartsAt
	}

	return arg
}

type JobResponse struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Queue          string          `json:"queue"`
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

func NewJobResponse(j db.Job) JobResponse {
	return JobResponse{
		ID:             j.ID.String(),
		Name:           j.Name,
		Queue:          j.Queue,
		State:          string(j.State),
		Payload:        json.RawMessage(j.Payload),
		Priority:       j.Priority,
		RetryCount:     j.RetryCount,
		MaxRetries:     j.MaxRetries,
		DeliveryCount:  j.DeliveryCount,
		Version:        j.Version,
		NextCheckAt:    timePtr(j.NextCheckAt),
		IdempotencyKey: stringPtr(j.IdempotencyKey),
		JobType:        string(j.JobType),
		Cron:           stringPtr(j.CronExpr),
		NextRunAt:      timePtr(j.NextRunAt),
		StartsAt:       timePtr(j.StartsAt),
		EndsAt:         timePtr(j.EndsAt),
		CreatedAt:      utc(j.CreatedAt),
		UpdatedAt:      utc(j.UpdatedAt),
	}
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

func NewJobAttemptResponse(a db.JobAttempt) JobAttemptResponse {
	return JobAttemptResponse{
		ID:         a.ID.String(),
		JobID:      a.JobID.String(),
		WorkerID:   stringPtr(a.WorkerID),
		Outcome:    string(a.Outcome),
		Result:     stringPtr(a.Result),
		StartedAt:  utc(a.StartedAt),
		FinishedAt: timePtr(a.FinishedAt),
	}
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

type Pagination struct {
	Limit  int32
	Offset int32
}

func (p Pagination) fetchLimit() int32 {
	return p.Limit + 1
}

func splitPage[T any](rows []T, p Pagination) ([]T, PaginationResponse) {
	hasMore := int32(len(rows)) > p.Limit
	if hasMore {
		rows = rows[:p.Limit]
	}
	return rows, PaginationResponse{Limit: p.Limit, Offset: p.Offset, HasMore: hasMore}
}

const (
	defaultLimit = 20
	maxLimit     = 100
)

func (p Pagination) toListJobsParams() db.ListJobsParams {
	return db.ListJobsParams{
		Limit:  p.fetchLimit(),
		Offset: p.Offset,
	}
}

func parsePagination(r *http.Request) (Pagination, map[string]string) {
	p := Pagination{Limit: defaultLimit, Offset: 0}
	q := r.URL.Query()
	fields := map[string]string{}

	if raw := q.Get("limit"); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || v < 1 || v > maxLimit {
			fields["limit"] = "must be an integer between 1 and 100"
		} else {
			p.Limit = int32(v)
		}
	}

	if raw := q.Get("offset"); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || v < 0 {
			fields["offset"] = "must be a non-negative integer"
		} else {
			p.Offset = int32(v)
		}
	}

	if len(fields) == 0 {
		return p, nil
	}
	return p, fields
}

func utc(t pgtype.Timestamptz) time.Time {
	return t.Time.UTC()
}

func timePtr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	u := t.Time.UTC()
	return &u
}

func stringPtr(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	return &t.String
}
