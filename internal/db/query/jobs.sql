-- name: CreateJob :one
INSERT INTO jobs
    (name, queue, payload, handler, priority, max_retries, next_check_at, idempotency_key,
     job_type, cron_expr, next_run_at, starts_at, ends_at)
VALUES (@name, @queue, @payload, @handler, @priority, @max_retries, @next_check_at,
        @idempotency_key, @job_type, @cron_expr, @next_run_at, @starts_at, @ends_at)
RETURNING *;

-- name: GetJobById :one
SELECT * FROM jobs WHERE id = @id;

-- name: GetJobByIdempotencyKey :one
SELECT * FROM jobs WHERE idempotency_key = @idempotency_key;

-- Fetch LIMIT+1 in the app layer; if len(rows) > limit, has_more=true, trim the extra row.
-- name: ListJobs :many
SELECT * FROM jobs
-- States arrive as text[], not job_state[]: pgx has no encode plan for an enum array unless
-- the type is registered on every connection. The API validates each value before it gets here.
WHERE (cardinality(@states::text[]) = 0 OR state::text = ANY(@states::text[]))
  AND (sqlc.narg(queue)::text     IS NULL OR queue = sqlc.narg(queue)::text)
  AND (sqlc.narg(handler)::text   IS NULL OR handler = sqlc.narg(handler)::text)
  AND (sqlc.narg(job_type)::job_type IS NULL OR job_type = sqlc.narg(job_type)::job_type)
  AND (sqlc.narg(search)::text    IS NULL
       OR name ILIKE '%' || sqlc.narg(search)::text || '%'
       OR handler ILIKE '%' || sqlc.narg(search)::text || '%'
       OR id::text ILIKE '%' || sqlc.narg(search)::text || '%')
ORDER BY updated_at DESC, id DESC
LIMIT @page_limit OFFSET @page_offset;

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
            ORDER BY (j.priority + sqlc.arg(aging_rate)::float
                      * extract(epoch from COALESCE(j.next_run_at, j.created_at))) ASC,
                     COALESCE(j.next_run_at, j.created_at) ASC
        ) AS rn
    FROM jobs j
    WHERE (
            (j.state IN ('pending', 'awaiting_retry') AND j.next_check_at <= now())
         OR (j.state = 'success' AND j.next_run_at IS NOT NULL AND j.next_run_at <= now())
          )
      AND (j.ends_at IS NULL OR now() < j.ends_at)
)
SELECT ranked.id,ranked.queue,ranked.version FROM ranked
LEFT JOIN queued_counts qc ON qc.queue = ranked.queue
WHERE ranked.rn <= (sqlc.arg(max_fetch_per_queue)::int - COALESCE(qc.queued_count, 0))
ORDER BY ranked.queue, ranked.rn;


-- name: CancelJob :one
UPDATE jobs
SET state = 'cancelled', next_check_at = NULL, next_run_at = NULL, version = version + 1
WHERE id = @id
  AND version = @version
  AND (state IN ('pending', 'queued', 'awaiting_retry', 'paused')
       OR (state = 'success' AND next_run_at IS NOT NULL))
RETURNING *;

-- name: RerunDeadJob :one
UPDATE jobs
SET state = 'pending',
    retry_count = 0,
    delivery_count = 0,
    next_check_at = now(),
    next_run_at = CASE WHEN job_type = 'cron' THEN now() ELSE NULL END,
    version = version + 1
WHERE id = @id
  AND version = @version
  AND state = 'dead'
  AND (ends_at IS NULL OR now() < ends_at)
RETURNING *;

-- name: PauseJob :one
UPDATE jobs
SET state = 'paused', next_check_at = NULL, version = version + 1
WHERE id = @id
  AND version = @version
  AND job_type = 'cron'
  AND state IN ('pending', 'queued', 'awaiting_retry', 'success')
RETURNING *;

-- name: ResumeJob :one
UPDATE jobs
SET state = 'pending',
    next_check_at  = next_run_at,
    retry_count    = 0,
    delivery_count = 0,
    version        = version + 1
WHERE id = @id AND version = @version AND state = 'paused'
RETURNING *;

-- name: RescheduleJob :one
UPDATE jobs
SET job_type       = @job_type,
    cron_expr      = @cron_expr,
    starts_at      = @starts_at,
    ends_at        = @ends_at,
    next_run_at    = @next_run_at,
    state          = CASE WHEN state = 'paused' THEN 'paused'::job_state
                          ELSE 'pending'::job_state END,
    next_check_at  = CASE WHEN state = 'paused' THEN NULL
                          ELSE @next_check_at::timestamptz END,
    retry_count    = 0,
    delivery_count = 0,
    version        = version + 1
WHERE id = @id
  AND version = @version
  AND state IN ('pending', 'awaiting_retry', 'success', 'expired', 'paused')
  AND (state <> 'paused' OR @job_type::job_type = 'cron')
RETURNING *;

-- name: FinalizeExpiredJobs :many
UPDATE jobs
SET state = 'expired', next_check_at = NULL, next_run_at = NULL, version = version + 1
WHERE ends_at IS NOT NULL
  AND now() >= ends_at
  AND state NOT IN ('running', 'expired')
  AND (next_check_at IS NOT NULL OR next_run_at IS NOT NULL)
RETURNING id;

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
    next_check_at = now() + @claim_deadline::interval,
    version = version + 1
WHERE id = ANY(@ids::uuid[])
  AND (state IN ('pending', 'awaiting_retry')
       OR (state = 'success' AND next_run_at IS NOT NULL))
RETURNING id;

-- A queued job past its claim deadline was never picked up by any worker, so it goes back to pending.
-- name: UpdateLostJob :many
WITH lost AS (
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
    SELECT lost.id, NULL, 'lost', @result::text, now() FROM lost
    RETURNING job_attempts.job_id
)
SELECT lost.id FROM lost JOIN attempt ON attempt.job_id = lost.id;

-- name: ClaimJobForExecution :one
WITH claimed AS (
    UPDATE jobs
    SET state='running',
        delivery_count = delivery_count+1,
        version = version +1 ,
        next_check_at = now() + @stale_delta_threshold::interval
    WHERE jobs.id = @id AND state='queued'
    RETURNING jobs.id,name,queue,payload,handler,retry_count,max_retries,delivery_count,version,
              job_type,cron_expr,ends_at
),
attempt AS (
    INSERT INTO job_attempts (job_id, worker_id)
    SELECT claimed.id, @worker_id FROM claimed
    RETURNING job_attempts.id, job_attempts.job_id
)
SELECT c.id, c.name, c.queue, c.payload, c.handler, c.retry_count, c.max_retries,
       c.delivery_count, c.version,
       c.job_type, c.cron_expr, c.ends_at,
       a.id AS attempt_id
FROM claimed c
JOIN attempt a ON a.job_id = c.id;

-- name: RefreshHeartBeats :many
UPDATE jobs
SET next_check_at = now() + @stale_delta_threshold::interval
FROM (
    SELECT unnest(@ids::uuid[]) AS id, unnest(@versions::int[]) AS version
) AS claim
WHERE jobs.id = claim.id AND jobs.version = claim.version AND jobs.state = 'running'
RETURNING jobs.id;

-- name: UpdateJobCompletion :execrows
UPDATE jobs
SET state = CASE WHEN job_type = 'cron' AND @next_run_at::timestamptz IS NULL
                 THEN 'expired'::job_state
                 ELSE 'success'::job_state END,
    next_check_at  = NULL,
    next_run_at    = @next_run_at,
    retry_count    = 0,
    delivery_count = 0,
    version        = version + 1
WHERE id = @id AND version = @version AND state = 'running';

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
    next_run_at = CASE
      WHEN retry_count >= max_retries THEN NULL
      ELSE next_run_at END,
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

-- name: GetJobAttempt :one
SELECT * FROM job_attempts
WHERE id = @id AND job_id = @job_id;

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
