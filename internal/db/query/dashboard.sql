
-- name: QueueStats :many
SELECT queue,
       count(*) FILTER (WHERE state = 'pending')::bigint        AS pending,
       count(*) FILTER (WHERE state = 'queued')::bigint         AS queued,
       count(*) FILTER (WHERE state = 'running')::bigint        AS running,
       count(*) FILTER (WHERE state = 'awaiting_retry')::bigint AS awaiting_retry,
       count(*) FILTER (WHERE state = 'paused')::bigint         AS paused,
       count(*) FILTER (WHERE state = 'success')::bigint        AS success,
       count(*) FILTER (WHERE state = 'dead')::bigint           AS dead,
       count(*) FILTER (WHERE state = 'cancelled')::bigint      AS cancelled,
       count(*) FILTER (WHERE state = 'expired')::bigint        AS expired,
       COALESCE(
           extract(epoch FROM now() - min(created_at) FILTER (WHERE state = 'pending')),
           0
       )::double precision AS oldest_pending_age_seconds
FROM jobs
GROUP BY queue
ORDER BY queue;


-- name: HandlerStats :many
WITH runs AS (
    SELECT j.handler,
           avg(extract(epoch FROM (a.finished_at - a.started_at)) * 1000)::double precision AS avg_run_ms
    FROM job_attempts a
    JOIN jobs j ON j.id = a.job_id
    WHERE a.outcome = 'success' AND a.finished_at IS NOT NULL
    GROUP BY j.handler
)
SELECT j.handler,
       count(*)::bigint AS total,
       count(*) FILTER (WHERE j.state = 'pending')::bigint        AS pending,
       count(*) FILTER (WHERE j.state = 'queued')::bigint         AS queued,
       count(*) FILTER (WHERE j.state = 'running')::bigint        AS running,
       count(*) FILTER (WHERE j.state = 'awaiting_retry')::bigint AS awaiting_retry,
       count(*) FILTER (WHERE j.state = 'paused')::bigint         AS paused,
       count(*) FILTER (WHERE j.state = 'success')::bigint        AS success,
       count(*) FILTER (WHERE j.state = 'dead')::bigint           AS dead,
       count(*) FILTER (WHERE j.state = 'cancelled')::bigint      AS cancelled,
       count(*) FILTER (WHERE j.state = 'expired')::bigint        AS expired,
       array_agg(DISTINCT j.queue ORDER BY j.queue)::text[] AS queues,
       max(j.updated_at)::timestamptz AS last_activity_at,
       max(runs.avg_run_ms) AS avg_run_ms
FROM jobs j
LEFT JOIN runs ON runs.handler = j.handler
WHERE (sqlc.narg(handler)::text IS NULL OR j.handler = sqlc.narg(handler)::text)
GROUP BY j.handler
ORDER BY j.handler;

-- name: RecentJobsByHandler :many
SELECT * FROM jobs
WHERE handler = @handler
ORDER BY updated_at DESC
LIMIT @page_limit;
