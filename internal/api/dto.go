package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/amoghar29/kairos/internal/config"
	"github.com/amoghar29/kairos/internal/cron"
	"github.com/amoghar29/kairos/internal/dashboard"
	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/worker"
	"github.com/amoghar29/kairos/models"
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
	} else if startsAt != nil {
		fields["starts_at"] = "requires cron — an adhoc job runs as soon as it is picked up"
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

// idempotencyKey comes from the Idempotency-Key header, not the body, so it is validated
// alongside the body fields rather than on its own.
func validateCreateJob(r *models.CreateJobRequest, queues config.Queues, idempotencyKey string) map[string]string {
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

	if len(idempotencyKey) > 255 {
		fields["Idempotency-Key"] = "header must not exceed 255 characters"
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

func createJobParams(r *models.CreateJobRequest, idempotencyKey string) db.CreateJobParams {
	priority := int32(defaultPriority)
	if r.Priority != nil {
		priority = *r.Priority
	}

	maxRetries := int32(defaultMaxRetries)
	if r.MaxRetries != nil {
		maxRetries = *r.MaxRetries
	}

	payload := []byte(r.Payload)
	if len(payload) == 0 || string(payload) == "null" {
		payload = []byte("{}")
	}

	arg := db.CreateJobParams{
		Name:           r.Name,
		Queue:          r.Queue,
		Handler:        r.Handler,
		Payload:        payload,
		Priority:       priority,
		MaxRetries:     maxRetries,
		IdempotencyKey: pgtype.Text{String: idempotencyKey, Valid: idempotencyKey != ""},
		JobType:        db.JobTypeAdhoc,
		StartsAt:       timestamptz(r.StartsAt),
		EndsAt:         timestamptz(r.EndsAt),
		NextCheckAt:    pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	}

	if r.Cron != "" {
		arg.JobType = db.JobTypeCron
		arg.CronExpr = pgtype.Text{String: r.Cron, Valid: true}
		arg.NextRunAt = arg.StartsAt
		arg.NextCheckAt = arg.StartsAt
	}

	return arg
}

func validateVersion(r *models.VersionRequest) map[string]string {
	if r.Version < 1 {
		return map[string]string{"version": "must be a positive integer"}
	}
	return nil
}

func validatePause(r *models.PauseRequest) map[string]string {
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

func validateReschedule(r *models.RescheduleRequest) map[string]string {
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

func rescheduleParams(r *models.RescheduleRequest, id pgtype.UUID) db.RescheduleJobParams {
	arg := db.RescheduleJobParams{
		ID:          id,
		Version:     r.Version,
		JobType:     db.JobTypeAdhoc,
		StartsAt:    timestamptz(r.StartsAt),
		EndsAt:      timestamptz(r.EndsAt),
		NextCheckAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	}

	if r.Cron != "" {
		arg.JobType = db.JobTypeCron
		arg.CronExpr = pgtype.Text{String: r.Cron, Valid: true}
		arg.NextRunAt = arg.StartsAt
		arg.NextCheckAt = arg.StartsAt
	}

	return arg
}

func NewJobResponse(j db.Job) models.JobResponse {
	return models.JobResponse{
		ID:             j.ID.String(),
		Name:           j.Name,
		Queue:          j.Queue,
		Handler:        j.Handler,
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

func NewJobAttemptResponse(a db.JobAttempt) models.JobAttemptResponse {
	return models.JobAttemptResponse{
		ID:         a.ID.String(),
		JobID:      a.JobID.String(),
		WorkerID:   stringPtr(a.WorkerID),
		Outcome:    string(a.Outcome),
		Result:     stringPtr(a.Result),
		StartedAt:  utc(a.StartedAt),
		FinishedAt: timePtr(a.FinishedAt),
	}
}

func NewJobLogResponse(l db.GetAttemptLogsRow) models.JobLogResponse {
	return models.JobLogResponse{
		Seq:       l.Seq,
		Level:     string(l.Level),
		Line:      l.Line,
		CreatedAt: utc(l.CreatedAt),
	}
}

func parseAttemptFilter(r *http.Request) (dashboard.AttemptFilter, map[string]string) {
	q := r.URL.Query()
	fields := map[string]string{}
	f := dashboard.AttemptFilter{
		Handler: q.Get("handler"),
		Queue:   q.Get("queue"),
	}

	if raw := q.Get("outcome"); raw != "" {
		if !db.AttemptOutcome(raw).Valid() {
			fields["outcome"] = fmt.Sprintf("unknown outcome %q", raw)
		} else {
			f.Outcome = raw
		}
	}

	if len(fields) == 0 {
		return f, nil
	}
	return f, fields
}

type Pagination struct {
	Limit  int32
	Offset int32
}

func (p Pagination) fetchLimit() int32 {
	return p.Limit + 1
}

func splitPage[T any](rows []T, p Pagination) ([]T, models.PaginationResponse) {
	hasMore := int32(len(rows)) > p.Limit
	if hasMore {
		rows = rows[:p.Limit]
	}
	return rows, models.PaginationResponse{Limit: p.Limit, Offset: p.Offset, HasMore: hasMore}
}

const (
	defaultLimit = 20
	maxLimit     = 100

	handlerRecentJobs = 20
)

type JobFilter struct {
	States  []db.JobState
	Queue   string
	Handler string
	JobType string
	Search  string
}

func (f JobFilter) toListJobsParams(p Pagination) db.ListJobsParams {
	states := make([]string, 0, len(f.States))
	for _, s := range f.States {
		states = append(states, string(s))
	}
	arg := db.ListJobsParams{
		States:     states,
		Queue:      pgtype.Text{String: f.Queue, Valid: f.Queue != ""},
		Handler:    pgtype.Text{String: f.Handler, Valid: f.Handler != ""},
		Search:     pgtype.Text{String: f.Search, Valid: f.Search != ""},
		PageLimit:  p.fetchLimit(),
		PageOffset: p.Offset,
	}
	if f.JobType != "" {
		arg.JobType = db.NullJobType{JobType: db.JobType(f.JobType), Valid: true}
	}
	return arg
}

func parseJobFilter(r *http.Request) (JobFilter, map[string]string) {
	q := r.URL.Query()
	fields := map[string]string{}
	f := JobFilter{
		Queue:   q.Get("queue"),
		Handler: q.Get("handler"),
		Search:  q.Get("q"),
	}

	for _, raw := range q["state"] {
		if raw == "" {
			continue
		}
		state := db.JobState(raw)
		if !state.Valid() {
			fields["state"] = fmt.Sprintf("unknown state %q", raw)
			continue
		}
		f.States = append(f.States, state)
	}

	if raw := q.Get("job_type"); raw != "" {
		if !db.JobType(raw).Valid() {
			fields["job_type"] = fmt.Sprintf("unknown job_type %q", raw)
		} else {
			f.JobType = raw
		}
	}

	if len(fields) == 0 {
		return f, nil
	}
	return f, fields
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

func NewWorkerResponse(e worker.RegistryEntry) models.WorkerResponse {
	jobs := make([]models.InflightJobResponse, 0, len(e.InFlight))
	for _, j := range e.InFlight {
		jobs = append(jobs, models.InflightJobResponse{
			ID:        j.ID.String(),
			Name:      j.Name,
			Queue:     j.Queue,
			Handler:   j.Handler,
			StartedAt: j.StartedAt.UTC(),
		})
	}
	queues := e.Queues
	if queues == nil {
		queues = []string{}
	}
	return models.WorkerResponse{
		ID:           e.ID.String(),
		Name:         e.Name,
		Queues:       queues,
		InFlight:     len(e.InFlight),
		InFlightJobs: jobs,
		StartedAt:    e.StartedAt.UTC(),
		LastSeen:     e.LastSeen.UTC(),
	}
}
