-- name: CreateJob :one
INSERT INTO jobs
    (name, queue, payload, priority, max_retries, next_check_at, idempotency_key)
VALUES ($1, $2, $3, $4, $5, now(), $6)
RETURNING *;

-- name: GetJobById :one
SELECT * FROM jobs WHERE id = $1;

-- name: GetJobByIdempotencyKey :one
SELECT * FROM jobs WHERE idempotency_key = $1;

-- Fetch LIMIT+1 in the app layer; if len(rows) > limit, has_more=true, trim the extra row.
-- name: ListJobs :many
SELECT * FROM jobs
ORDER BY created_at DESC, id DESC
LIMIT $1 OFFSET $2;

-- name: DeleteJobById :one
DELETE FROM jobs WHERE id = $1 RETURNING *;

-- name: CancelJob :one
UPDATE jobs
SET state = 'cancelled', next_check_at = NULL, version = version + 1
WHERE id = $1
  AND version = $2
  AND state IN ('pending', 'queued', 'awaiting_retry')
RETURNING *;

-- name: RerunDeadJob :one
UPDATE jobs
SET state = 'pending',
    retry_count = 0,
    next_check_at = now(),
    version = version + 1
WHERE id = $1
  AND version = $2
  AND state = 'dead'
RETURNING *;

-- name: RecordHandlerFailure :one
UPDATE jobs
SET retry_count = retry_count + 1,
    state = CASE WHEN retry_count + 1 >= max_retries THEN 'dead' ELSE 'awaiting_retry' END,
    next_check_at = CASE WHEN retry_count + 1 >= max_retries THEN NULL ELSE $3 END,
    version = version + 1
WHERE id = $1 AND version = $2
RETURNING *;

-- name: GetJobAttemptsByJobId :many
SELECT * FROM job_attempts
WHERE job_id = $1
ORDER BY attempt_number ASC
LIMIT $2 OFFSET $3;

-- name: CreateJobAttempt :one
INSERT INTO job_attempts
    (job_id, attempt_number, worker_id)
VALUES ($1, $2, $3)
RETURNING *;

-- name: UpdateJobAttemptOutcome :one
UPDATE job_attempts
SET outcome = $2, error = $3, finished_at = now()
WHERE id = $1
RETURNING *;

-- name: RefreshHeartbeat :one
UPDATE jobs
SET next_check_at = now() + sqlc.arg(stale_threshold)::interval,
    version = version + 1
WHERE id = $1 AND version = $2 AND state = 'running'
RETURNING *;
