-- name: CreateJob :one
INSERT INTO jobs
    (name, queue, payload, priority, effective_priority, max_retries, next_trigger_at, idempotency_key)
VALUES ($1, $2, $3, $4, $4, $5, now(), $6)
RETURNING *;

-- name: GetJobById :one
SELECT * FROM jobs WHERE id = $1;

-- name: GetAllJobs :many
SELECT * FROM jobs
ORDER BY created_at DESC, id DESC
LIMIT $1 OFFSET $2;

-- name: GetJobByIdempotencyKey :one
SELECT * FROM jobs WHERE idempotency_key = $1;

-- name: DeleteJobById :one
DELETE FROM jobs WHERE id = $1 RETURNING *;

-- name: UpdateJobState :one
UPDATE jobs
SET state = $2, next_trigger_at = $3, version = version + 1
WHERE id = $1 AND version = $4
RETURNING *;

-- name: UpdateJobPriority :one
UPDATE jobs
SET priority = $2, effective_priority = $2
WHERE id = $1
RETURNING *;

-- name: UpdateJobEffectivePriority :one
UPDATE jobs
SET effective_priority = $2
WHERE id = $1
RETURNING *;

-- name: CancelJob :one
UPDATE jobs
SET state = 'cancelled', next_trigger_at = NULL, version = version + 1
WHERE id = $1
  AND version = $2
  AND state IN ('pending', 'queued', 'awaiting_retry')
RETURNING *;

-- name: RetryJob :one
UPDATE jobs
SET state = 'pending',
    retry_count = 0,
    next_trigger_at = now(),
    version = version + 1
WHERE id = $1
  AND state = 'dead'
RETURNING *;

-- name: UpdateRetryCount :one
UPDATE jobs
SET retry_count = retry_count + 1
WHERE id = $1
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

-- name: UpdateJobAttemptHeartbeat :one
UPDATE job_attempts
SET last_heartbeat_at = now()
WHERE id = $1
RETURNING *;