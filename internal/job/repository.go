package job

import (
	"context"
	"errors"

	"github.com/amoghar29/kairos/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

var (
	ErrNotFound             = errors.New("job not found")
	ErrConflict             = errors.New("job was modified or is not in a cancellable state")
	ErrIdempotencyCollision = errors.New("idempotency key already used by a different job")
)

const uniqueViolation = "23505"

type Repository struct {
	q db.Querier
}

func NewRepository(q db.Querier) *Repository {
	return &Repository{q: q}
}

func (r *Repository) Create(ctx context.Context, arg db.CreateJobParams) (job db.Job, created bool, err error) {
	job, err = r.q.CreateJob(ctx, arg)
	if err == nil {
		return job, true, nil
	}

	var pgErr *pgconn.PgError
	if !arg.IdempotencyKey.Valid || !errors.As(err, &pgErr) || pgErr.Code != uniqueViolation {
		return db.Job{}, false, err
	}

	existing, err := r.q.GetJobByIdempotencyKey(ctx, arg.IdempotencyKey)
	if err != nil {
		return db.Job{}, false, err
	}
	if existing.Name != arg.Name || existing.Queue != arg.Queue {
		return db.Job{}, false, ErrIdempotencyCollision
	}
	return existing, false, nil
}

func (r *Repository) GetByID(ctx context.Context, id pgtype.UUID) (db.Job, error) {
	job, err := r.q.GetJobById(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Job{}, ErrNotFound
	}
	return job, err
}

func (r *Repository) List(ctx context.Context, limit, offset int32) ([]db.Job, error) {
	return r.q.GetAllJobs(ctx, db.GetAllJobsParams{Limit: limit, Offset: offset})
}

func (r *Repository) Delete(ctx context.Context, id pgtype.UUID) error {
	_, err := r.q.DeleteJobById(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func (r *Repository) Cancel(ctx context.Context, id pgtype.UUID, version int32) (db.Job, error) {
	job, err := r.q.CancelJob(ctx, db.CancelJobParams{ID: id, Version: version})
	if err == nil {
		return job, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.Job{}, err
	}

	if _, err := r.GetByID(ctx, id); err != nil {
		return db.Job{}, err
	}
	return db.Job{}, ErrConflict
}

func (r *Repository) ListAttempts(ctx context.Context, jobID pgtype.UUID, limit, offset int32) ([]db.JobAttempt, error) {
	return r.q.GetJobAttemptsByJobId(ctx, db.GetJobAttemptsByJobIdParams{
		JobID:  jobID,
		Limit:  limit,
		Offset: offset,
	})
}
