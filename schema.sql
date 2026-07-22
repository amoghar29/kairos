-- ============================================================================
-- Distributed Job Scheduler — Data Model (v1)
-- Postgres holds ONLY what must be durable and survive a total Redis wipe:
-- the jobs themselves and their execution history. Everything ephemeral or
-- static lives elsewhere:
--   * Queue config (names, N_Q, retry defaults) -> deploy-time config/env.
--     The API validates job.queue against the config allowlist at creation.
--   * Worker registry (live liveness) -> Redis with TTL (see note at bottom).
--
-- Tables:
--   * jobs         = identity + CURRENT state + counters + scheduling (1 row/job)
--   * job_attempts = one row per execution TRY (history survives retries)
--
-- Conventions:
--   * higher `priority` int = higher priority (served first).
--   * `next_trigger_at` is THE column the Store Consumer polls on; it holds
--     whichever time is currently relevant for the job's state. On each
--     heartbeat the worker bumps it to (now + heartbeat_timeout), so the
--     consumer detects a dead worker without joining job_attempts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
-- The 7 job states. No `in_queue` (== ready), no `timeout` (recovery is
-- invisible at job level — state stays `running` until requeued), no bare
-- `error` (use `dead`).
CREATE TYPE job_state AS ENUM (
    'pending',          -- created, never dispatched
    'ready',            -- pushed to the Redis list (in queue)
    'running',          -- claimed by a worker
    'awaiting_retry',   -- handler signaled retriable failure; backing off
    'succeeded',        -- terminal: done
    'dead',             -- terminal: retry/delivery budget exhausted -> DLQ
    'cancelled'         -- terminal: cancelled before claim
);

-- Per-attempt outcome (NULL while the attempt is still running).
CREATE TYPE attempt_outcome AS ENUM (
    'success',
    'retriable',        -- handler asked to retry
    'fatal',            -- handler said don't retry -> dead
    'recovered_stale'   -- attempt abandoned: heartbeat went stale, consumer requeued
);

-- ---------------------------------------------------------------------------
-- jobs  (identity + current state + counters + scheduling)
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                text        NOT NULL,                 -- task_name -> handler on workers
    payload             jsonb       NOT NULL DEFAULT '{}',
    queue               text        NOT NULL,                 -- validated against config allowlist by API
    state               job_state   NOT NULL DEFAULT 'pending',

    -- priority
    priority            int         NOT NULL DEFAULT 0,       -- user-set, static
    effective_priority  int         NOT NULL DEFAULT 0,       -- after aging promotion, dynamic

    -- retry vs delivery: two counters, two purposes (D6/D7)
    retry_count         int         NOT NULL DEFAULT 0,       -- handler-signaled retriable failures
    max_retries         int         NOT NULL DEFAULT 5,
    -- delivery_count      int         NOT NULL DEFAULT 0,       -- every (re)dispatch; poison-pill guard
    -- max_delivery_count  int         NOT NULL DEFAULT 10,

    -- scheduling
    next_trigger_at     timestamptz,                          -- WHEN the consumer should look again; NULL = terminal
    -- available_at        timestamptz NOT NULL DEFAULT now(),   -- earliest eligible time (= now for run-now; future for delayed)

    -- concurrency control for the READY->RUNNING CAS and all transitions
    -- version             int         NOT NULL DEFAULT 0,

    -- optional D4 extension; cheap to keep now, painful to add later
    idempotency_key     text,

    -- audit
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT counts_nonneg CHECK (
        retry_count >= 0 AND delivery_count >= 0
        AND max_retries >= 0 AND max_delivery_count >= 0
    ),
    -- terminal states must have no future trigger; non-terminal must have one
    CONSTRAINT trigger_matches_state CHECK (
        (state IN ('succeeded','dead','cancelled') AND next_trigger_at IS NULL)
        OR
        (state IN ('pending','ready','running','awaiting_retry') AND next_trigger_at IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- job_attempts  (one row per execution try)
-- ---------------------------------------------------------------------------
-- worker_id is plain text, NOT a FK: the worker registry lives in Redis and is
-- ephemeral; we still want attempt history after a worker disappears.
CREATE TABLE job_attempts (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id            bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_number    int    NOT NULL,
    worker_id         text,
    started_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz,
    last_heartbeat_at timestamptz,         -- display/audit only; recovery is driven by jobs.next_trigger_at
    outcome           attempt_outcome,     -- NULL while running
    error             text,
    -- duration is DERIVED, not stored: (finished_at - started_at)
    UNIQUE (job_id, attempt_number)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- THE hot path: the Store Consumer's poll. Partial index over non-terminal
-- rows only, ordered by trigger time. Keeps dispatch+retry+recovery cheap.
CREATE INDEX jobs_poll_idx
    ON jobs (next_trigger_at)
    WHERE state IN ('pending','ready','running','awaiting_retry');

-- Per-queue priority top-up (ROW_NUMBER() OVER (PARTITION BY queue
-- ORDER BY effective_priority DESC ...)). Partial to non-terminal rows.
CREATE INDEX jobs_queue_priority_idx
    ON jobs (queue, effective_priority DESC, next_trigger_at)
    WHERE state IN ('pending','ready','awaiting_retry');

-- Dashboard: counts by state/queue.
CREATE INDEX jobs_state_queue_idx ON jobs (state, queue);

-- D4 optional: enforce one live job per idempotency key when present.
CREATE UNIQUE INDEX jobs_idempotency_key_idx
    ON jobs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Attempt history lookups for a job (dashboard, DLQ debugging).
CREATE INDEX job_attempts_job_id_idx ON job_attempts (job_id);

-- ============================================================================
-- updated_at maintenance (version is app-managed: bump it on every CAS)
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_set_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Worker registry — NOT in Postgres. Lives in Redis, dashboard-only (#9/#7).
-- Each worker on every heartbeat:
--     SET worker:<id> '{"queues":[...],"load":N,"status":"alive",
--                       "started_at":"..."}'  EX 30
-- TTL ~= 2-3x heartbeat interval, so a dead worker's key simply expires
-- (no reaper needed to clean it up). Dashboard reads via SCAN worker:*.
-- This registry NEVER drives job recovery — recovery is task-level, off
-- jobs.next_trigger_at.
-- ============================================================================
