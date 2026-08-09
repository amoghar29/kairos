-- +goose Up

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TYPE job_state AS ENUM (
    'pending',
    'queued',
    'running',
    'awaiting_retry',
    'success',
    'dead',
    'cancelled'
);


CREATE TYPE attempt_outcome AS ENUM (
    'in_progress',
    'success',
    'failed',
    'cancelled',
    'superseded'
);

-- The DEFAULTs below are a safety net for manual/psql inserts. The API always
-- names these columns in its INSERT, so the application supplies the real
-- defaults (see defaultPriority / defaultMaxRetries in internal/api/dto.go).
-- The priority/max_retries CHECK bounds mirror the constants in that same file.
-- The API copy exists to return a 422 with a readable field error; these exist
-- because workers and psql write here without passing through the API.
CREATE TABLE jobs (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text        NOT NULL,
    queue               text        NOT NULL,
    state               job_state   NOT NULL DEFAULT 'pending',
    payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,

    priority            int         NOT NULL DEFAULT 5,
    retry_count         int         NOT NULL DEFAULT 0,
    max_retries         int         NOT NULL DEFAULT 3,
    delivery_count      int         NOT NULL DEFAULT 0,

    version             int         NOT NULL DEFAULT 1,

    next_check_at       timestamptz,

    idempotency_key     text        UNIQUE,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT priority_range          CHECK (priority BETWEEN 1 AND 10),
    CONSTRAINT max_retries_range       CHECK (max_retries BETWEEN 0 AND 25),
    CONSTRAINT retry_count_valid       CHECK (retry_count >= 0),
    CONSTRAINT delivery_count_valid    CHECK (delivery_count >= 0),

    CONSTRAINT next_check_matches_state CHECK (
        (state IN ('success', 'dead', 'cancelled') AND next_check_at IS NULL)
        OR
        (state NOT IN ('success', 'dead', 'cancelled') AND next_check_at IS NOT NULL)
    )
);

CREATE TRIGGER jobs_set_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE job_attempts (
    id                uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id            uuid            NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_number    int             NOT NULL,
    worker_id         text            NOT NULL,
    outcome           attempt_outcome NOT NULL DEFAULT 'in_progress',
    result             text           DEFAULT NULL  ,
    started_at        timestamptz     NOT NULL DEFAULT now(),
    finished_at       timestamptz,

    UNIQUE (job_id, attempt_number)
);


-- +goose Down
DROP TABLE IF EXISTS job_attempts;
DROP TABLE IF EXISTS jobs;
DROP TYPE IF EXISTS attempt_outcome;
DROP TYPE IF EXISTS job_state;
DROP FUNCTION IF EXISTS set_updated_at();