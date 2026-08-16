package job

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/amoghar29/kairos/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

var (
	ErrNotFound = errors.New("job not found")
	ErrConflict = errors.New("job was modified or is not in a valid state for this transition")
)

const uniqueViolation = "23505"

type JobClaim struct {
	ID      pgtype.UUID
	Version int32
}

type Repository struct {
	q db.Querier
}

func New(q db.Querier) *Repository {
	return &Repository{q: q}
}

func (r *Repository) Create(ctx context.Context, arg db.CreateJobParams) (job db.Job, created bool, err error) {
	job, err = r.q.CreateJob(ctx, arg)
	if err == nil {
		return job, true, nil
	}

	var pgErr *pgconn.PgError
	if !arg.IdempotencyKey.Valid || !errors.As(err, &pgErr) || pgErr.Code != uniqueViolation {
		return db.Job{}, false, fmt.Errorf("create job: %w", err)
	}

	existing, err := r.q.GetJobByIdempotencyKey(ctx, arg.IdempotencyKey)
	if err != nil {
		return db.Job{}, false, fmt.Errorf("get job by idempotency key: %w", err)
	}
	return existing, false, nil
}

func (r *Repository) GetByID(ctx context.Context, id pgtype.UUID) (db.Job, error) {
	job, err := r.q.GetJobById(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Job{}, ErrNotFound
	}
	if err != nil {
		return db.Job{}, fmt.Errorf("get job %s: %w", id, err)
	}
	return job, nil
}

func (r *Repository) List(ctx context.Context, arg db.ListJobsParams) ([]db.Job, error) {
	jobs, err := r.q.ListJobs(ctx, arg)
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	return jobs, nil
}

func (r *Repository) Delete(ctx context.Context, id pgtype.UUID) error {
	_, err := r.q.DeleteJobById(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("delete job %s: %w", id, err)
	}
	return nil
}

func (r *Repository) Cancel(ctx context.Context, id pgtype.UUID, version int32) (db.Job, error) {
	return r.guardedUpdate(ctx, id, func() (db.Job, error) {
		return r.q.CancelJob(ctx, db.CancelJobParams{ID: id, Version: version})
	})
}

func (r *Repository) Rerun(ctx context.Context, id pgtype.UUID, version int32) (db.Job, error) {
	return r.guardedUpdate(ctx, id, func() (db.Job, error) {
		return r.q.RerunDeadJob(ctx, db.RerunDeadJobParams{ID: id, Version: version})
	})
}

func (r *Repository) Pause(ctx context.Context, id pgtype.UUID, version int32) (db.Job, error) {
	return r.guardedUpdate(ctx, id, func() (db.Job, error) {
		return r.q.PauseJob(ctx, db.PauseJobParams{ID: id, Version: version})
	})
}

func (r *Repository) Resume(ctx context.Context, id pgtype.UUID, version int32) (db.Job, error) {
	return r.guardedUpdate(ctx, id, func() (db.Job, error) {
		return r.q.ResumeJob(ctx, db.ResumeJobParams{ID: id, Version: version})
	})
}

func (r *Repository) Reschedule(ctx context.Context, arg db.RescheduleJobParams) (db.Job, error) {
	return r.guardedUpdate(ctx, arg.ID, func() (db.Job, error) {
		return r.q.RescheduleJob(ctx, arg)
	})
}

func (r *Repository) guardedUpdate(ctx context.Context, id pgtype.UUID, update func() (db.Job, error)) (db.Job, error) {
	job, err := update()
	if err == nil {
		return job, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.Job{}, fmt.Errorf("update job %s: %w", id, err)
	}

	if _, err := r.GetByID(ctx, id); err != nil {
		return db.Job{}, err
	}
	return db.Job{}, ErrConflict
}

func (r *Repository) ReclaimStale(ctx context.Context, maxDeliveryCount int32) ([]db.Job, error) {
	jobs, err := r.q.ReclaimStaleJobs(ctx, maxDeliveryCount)
	if err != nil {
		return nil, fmt.Errorf("error reclaim stale jobs: %w", err)
	}
	return jobs, nil
}

func (r *Repository) SupersedeOpenAttempts(ctx context.Context, jobIDs []pgtype.UUID) error {
	if len(jobIDs) == 0 {
		return nil
	}
	if err := r.q.SupersedeOpenAttempts(ctx, jobIDs); err != nil {
		return fmt.Errorf("error supersede open attempts for %d jobs: %w", len(jobIDs), err)
	}
	return nil
}

func (r *Repository) ListAttempts(ctx context.Context, jobID pgtype.UUID, limit, offset int32) ([]db.JobAttempt, error) {
	attempts, err := r.q.GetJobAttemptsByJobId(ctx, db.GetJobAttemptsByJobIdParams{
		JobID:  jobID,
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		return nil, fmt.Errorf("list attempts for job %s: %w", jobID, err)
	}
	return attempts, nil
}

func (r *Repository) GetJobsReadyToRun(ctx context.Context, maxFetchPerQueue int, agingRate float64) ([]db.GetDueJobsRow, error) {
	jobs, err := r.q.GetDueJobs(ctx, db.GetDueJobsParams{
		MaxFetchPerQueue: int32(maxFetchPerQueue),
		AgingRate:        agingRate,
	})
	if err != nil {
		return nil, fmt.Errorf("error in get due jobs: %w", err)
	}
	return jobs, nil
}

func (r *Repository) MarksJobAsQueued(ctx context.Context, ids []pgtype.UUID, claimDeadline pgtype.Interval) ([]pgtype.UUID, error) {
	queued, err := r.q.MarkQueued(ctx, db.MarkQueuedParams{Ids: ids, ClaimDeadline: claimDeadline})
	if err != nil {
		return nil, fmt.Errorf("mark jobs as queued: %w", err)
	}
	return queued, nil
}

func (r *Repository) UpdateLostJob(ctx context.Context, result string) ([]pgtype.UUID, error) {
	lost, err := r.q.UpdateLostJob(ctx, result)
	if err != nil {
		return nil, fmt.Errorf("update lost jobs: %w", err)
	}
	return lost, nil
}

func (r *Repository) FinalizeExpiredJobs(ctx context.Context) ([]pgtype.UUID, error) {
	expired, err := r.q.FinalizeExpiredJobs(ctx)
	if err != nil {
		return nil, fmt.Errorf("finalize expired jobs: %w", err)
	}
	return expired, nil
}

func (r *Repository) ClaimForExecution(ctx context.Context, id pgtype.UUID, workerID string, staleDelta pgtype.Interval) (db.ClaimJobForExecutionRow, error) {
	// worker_id is nullable only so a lost dispatch can record an attempt with no worker.
	// A claim always has one, so callers keep passing a plain string.
	claimed, err := r.q.ClaimJobForExecution(ctx, db.ClaimJobForExecutionParams{
		ID:                  id,
		WorkerID:            pgtype.Text{String: workerID, Valid: true},
		StaleDeltaThreshold: staleDelta,
	})
	if err == nil {
		return claimed, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.ClaimJobForExecutionRow{}, fmt.Errorf("claim job %s: %w", id, err)
	}

	if _, err := r.GetByID(ctx, id); err != nil {
		return db.ClaimJobForExecutionRow{}, err
	}
	return db.ClaimJobForExecutionRow{}, ErrConflict
}

func (r *Repository) RefreshHeartbeats(ctx context.Context, claims []JobClaim, staleDelta pgtype.Interval) ([]pgtype.UUID, error) {
	if len(claims) == 0 {
		return nil, nil
	}
	ids := make([]pgtype.UUID, len(claims))
	versions := make([]int32, len(claims))
	for i, c := range claims {
		ids[i] = c.ID
		versions[i] = c.Version
	}
	renewed, err := r.q.RefreshHeartBeats(ctx, db.RefreshHeartBeatsParams{
		Ids:                 ids,
		Versions:            versions,
		StaleDeltaThreshold: staleDelta,
	})
	if err != nil {
		return nil, fmt.Errorf("error in refresh heartbeats: %w", err)
	}
	return renewed, nil
}

func (r *Repository) CompleteJob(ctx context.Context, id pgtype.UUID, version int32, nextRunAt pgtype.Timestamptz) (bool, error) {
	rows, err := r.q.UpdateJobCompletion(ctx, db.UpdateJobCompletionParams{
		ID:        id,
		Version:   version,
		NextRunAt: nextRunAt,
	})
	if err != nil {
		return false, fmt.Errorf("complete job %s: %w", id, err)
	}
	return rows > 0, nil
}

func (r *Repository) RecordExecutionFailure(ctx context.Context, id pgtype.UUID, version int32, nextCheckAt pgtype.Timestamptz) (bool, error) {
	rows, err := r.q.RecordJobExecutionFailure(ctx, db.RecordJobExecutionFailureParams{
		ID:          id,
		Version:     version,
		NextCheckAt: nextCheckAt,
	})
	if err != nil {
		return false, fmt.Errorf("record execution failure for job %s: %w", id, err)
	}
	return rows > 0, nil
}

func (r *Repository) CompleteAttempt(ctx context.Context, attemptID pgtype.UUID, outcome db.AttemptOutcome, result pgtype.Text) (bool, error) {
	rows, err := r.q.UpdateJobAttemptExecutionCompletion(ctx, db.UpdateJobAttemptExecutionCompletionParams{
		ID:      attemptID,
		Outcome: outcome,
		Result:  result,
	})
	if err != nil {
		return false, fmt.Errorf("complete attempt %s: %w", attemptID, err)
	}
	return rows > 0, nil
}

type LogLine struct {
	AttemptID pgtype.UUID
	Seq       int32
	Level     db.LogLevel
	Line      string
	CreatedAt pgtype.Timestamptz
}

const defaultLogLevel = db.LogLevelInfo

func (r *Repository) InsertJobLogs(ctx context.Context, lines []LogLine) (int64, error) {
	if len(lines) == 0 {
		return 0, nil
	}

	arg := db.InsertJobLogsParams{
		AttemptIds: make([]pgtype.UUID, len(lines)),
		Seqs:       make([]int32, len(lines)),
		Levels:     make([]db.LogLevel, len(lines)),
		Lines:      make([]string, len(lines)),
		CreatedAts: make([]pgtype.Timestamptz, len(lines)),
	}
	for i, l := range lines {
		level := l.Level
		if level == "" {
			level = defaultLogLevel
		}
		arg.AttemptIds[i] = l.AttemptID
		arg.Seqs[i] = l.Seq
		arg.Levels[i] = level
		arg.Lines[i] = l.Line
		arg.CreatedAts[i] = l.CreatedAt
	}

	inserted, err := r.q.InsertJobLogs(ctx, arg)
	if err != nil {
		return 0, fmt.Errorf("insert %d job logs: %w", len(lines), err)
	}
	return inserted, nil
}

const logQueryPadding = 10 * time.Second

func (r *Repository) GetJobAttemptLogs(ctx context.Context, attemptID pgtype.UUID, fromTS, toTS pgtype.Timestamptz, afterSeq, limit int32) ([]db.GetAttemptLogsRow, error) {
	if !fromTS.Valid || !toTS.Valid {
		return nil, fmt.Errorf("get logs for attempt %s: from/to timestamps are required", attemptID)
	}

	logs, err := r.q.GetAttemptLogs(ctx, db.GetAttemptLogsParams{
		AttemptID: attemptID,
		FromTs:    pgtype.Timestamptz{Time: fromTS.Time.Add(-logQueryPadding), Valid: true},
		ToTs:      pgtype.Timestamptz{Time: toTS.Time.Add(logQueryPadding), Valid: true},
		AfterSeq:  afterSeq,
		PageLimit: limit,
	})
	if err != nil {
		return nil, fmt.Errorf("get logs for attempt %s: %w", attemptID, err)
	}
	return logs, nil
}
