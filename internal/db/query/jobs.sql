-- name: CreateJob :one
INSERT INTO jobs
    (name, queue, payload, handler, priority, max_retries, next_check_at, idempotency_key)
VALUES (@name, @queue, @payload, @handler, @priority, @max_retries, now(), @idempotency_key)
RETURNING *;

-- name: GetJobById :one
SELECT * FROM jobs WHERE id = @id;

-- name: GetJobByIdempotencyKey :one
SELECT * FROM jobs WHERE idempotency_key = @idempotency_key;

-- Fetch LIMIT+1 in the app layer; if len(rows) > limit, has_more=true, trim the extra row.
-- name: ListJobs :many
SELECT * FROM jobs
ORDER BY created_at DESC, id DESC
LIMIT $1 OFFSET $2;

-- name: GetDueJobs :many
WITH queued_counts AS (
    SELECT queue, count(*) AS queued_count
    FROM jobs
    WHERE state = 'queued'
    GROUP BY queue
),
ranked AS (
    SELECT j.*,
        ROW_NUMBER() OVER (
            PARTITION BY j.queue
            ORDER BY (j.priority + sqlc.arg(aging_rate)::float * extract(epoch from j.created_at)) ASC,
                     j.created_at ASC
        ) AS rn
    FROM jobs j
    WHERE j.state IN ('pending', 'awaiting_retry')
      AND j.next_check_at <= now()
)
SELECT ranked.id,ranked.queue,ranked.version FROM ranked
LEFT JOIN queued_counts qc ON qc.queue = ranked.queue
WHERE ranked.rn <= (sqlc.arg(max_fetch_per_queue)::int - COALESCE(qc.queued_count, 0))
ORDER BY ranked.queue, ranked.rn;


-- name: CancelJob :one
UPDATE jobs
SET state = 'cancelled', next_check_at = NULL, version = version + 1
WHERE id = @id
  AND version = @version
  AND state IN ('pending', 'queued', 'awaiting_retry')
RETURNING *;

-- name: RerunDeadJob :one
UPDATE jobs
SET state = 'pending',
    retry_count = 0,
    delivery_count = 0,
    next_check_at = now(),
    version = version + 1
WHERE id = @id
  AND version = @version
  AND state = 'dead'
RETURNING *;

-- name: ReclaimStaleJobs :many
UPDATE jobs
SET state = CASE
        WHEN delivery_count >= @max_delivery_count::int THEN 'dead'::job_state
        ELSE 'awaiting_retry'
    END,
    next_check_at = CASE
        WHEN delivery_count >= @max_delivery_count::int THEN NULL
        ELSE now()
    END,
    version = version + 1
WHERE state = 'running' AND next_check_at <= now()
RETURNING *;

-- name: MarkQueued :many
UPDATE jobs
SET state = 'queued',
    next_check_at = now() + @dispatch_lease::interval,
    version = version + 1
WHERE id = ANY(@ids::uuid[])
  AND state IN ('pending', 'awaiting_retry')
RETURNING id;

-- A queued job whose lease ran out was never claimed by any worker, so it goes back to pending.
-- name: ExpireDispatchLeases :many
WITH expired AS (
    UPDATE jobs
    SET state = 'pending',
        delivery_count = jobs.delivery_count + 1,
        next_check_at = now(),
        version = jobs.version + 1
    WHERE jobs.state = 'queued'
      AND jobs.next_check_at <= now()
    RETURNING jobs.id
),
attempt AS (
    INSERT INTO job_attempts (job_id, worker_id, outcome, result, finished_at)
    SELECT expired.id, NULL, 'lost', @result::text, now() FROM expired
    RETURNING job_attempts.job_id
)
SELECT expired.id FROM expired JOIN attempt ON attempt.job_id = expired.id;

-- name: ClaimJobForExecution :one
WITH claimed AS (
    UPDATE jobs
    SET state='running',
        delivery_count = delivery_count+1,
        version = version +1 ,
        next_check_at = now() + @stale_delta_threshold::interval
    WHERE jobs.id = @id AND state='queued'
    RETURNING jobs.id,name,queue,payload,handler,retry_count,max_retries,delivery_count,version
),
attempt AS (
    INSERT INTO job_attempts (job_id, worker_id)
    SELECT claimed.id, @worker_id FROM claimed
    RETURNING job_attempts.id, job_attempts.job_id
)
SELECT c.id, c.name, c.queue, c.payload, c.handler, c.retry_count, c.max_retries,
       c.delivery_count, c.version,
       a.id AS attempt_id
FROM claimed c
JOIN attempt a ON a.job_id = c.id;

-- name: RefreshHeartBeats :many
UPDATE jobs
SET next_check_at = now() + @stale_delta_threshold::interval
FROM (
    SELECT unnest(@ids::uuid[]) AS id, unnest(@versions::int[]) AS version
) AS lease
WHERE jobs.id = lease.id AND jobs.version = lease.version AND jobs.state = 'running'
RETURNING jobs.id;

-- name: UpdateJobCompletion :execrows
UPDATE jobs
SET state='success',
    version=version+1,
    next_check_at=NULL
WHERE id = @id AND version = @version AND state='running';

-- name: RecordJobExecutionFailure :execrows
UPDATE jobs
SET retry_count= CASE
        WHEN  retry_count<max_retries THEN retry_count+1
        ELSE retry_count END,
    state=CASE
        WHEN retry_count>=max_retries THEN 'dead'::job_state
        ELSE 'awaiting_retry'::job_state END,
    next_check_at  = CASE
      WHEN retry_count >= max_retries THEN NULL
      ELSE @next_check_at::timestamptz END,
    version = version +1
WHERE id = @id AND version = @version AND state = 'running';

-- name: DeleteJobById :one
DELETE FROM jobs WHERE id = @id RETURNING *;

-- name: CreateJobAttempt :one
INSERT INTO job_attempts (job_id, worker_id)
VALUES (@job_id, @worker_id)
RETURNING id;

-- name: GetJobAttemptsByJobId :many
SELECT * FROM job_attempts
WHERE job_id = $1
ORDER BY started_at ASC, id ASC
LIMIT $2 OFFSET $3;

-- name: UpdateJobAttemptExecutionCompletion :execrows
UPDATE job_attempts
SET outcome = @outcome,
    result = @result,
    finished_at=now()
WHERE id = @id AND outcome='in_progress';

-- name: SupersedeOpenAttempts :exec
UPDATE job_attempts
SET outcome = 'superseded', finished_at = now()
WHERE job_id = ANY(@job_ids::uuid[]) AND outcome = 'in_progress';


-- name: InsertJobLogs :execrows
INSERT INTO job_logs (attempt_id, seq, level, line, created_at)
SELECT
    unnest(@attempt_ids::uuid[]),
    unnest(@seqs::int[]),
    unnest(@levels::log_level[]),
    unnest(@lines::text[]),
    unnest(@created_ats::timestamptz[])
ON CONFLICT DO NOTHING;

-- name: GetAttemptLogs :many
SELECT seq, level, line, created_at
FROM job_logs
WHERE attempt_id = @attempt_id
  AND created_at >= @from_ts
  AND created_at <  @to_ts
  AND seq > @after_seq
ORDER BY seq ASC
LIMIT @page_limit;
