# Installation and setup

Everything needed to get kairos installed, running, configured and deployed. For what kairos is
and how it works, see the [main README](../README.md).

## Contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Docker and deployment](#docker-and-deployment)
- [Development](#development)

## Prerequisites

| | Version | Why |
| --- | --- | --- |
| Go | 1.26+ | module targets `go 1.26.3` |
| PostgreSQL | 16 | `jobs`, `job_attempts`, partitioned `job_logs`; enum types and check constraints |
| Redis | 8 | dispatch lists and the worker registry, disposable |
| goose | any | one migration, `internal/db/migrations` (run for you by docker compose) |

## Install

```bash
go get github.com/amoghar29/kairos
```

While developing against a local checkout:

```bash
go mod edit -replace github.com/amoghar29/kairos=/path/to/kairos
go mod tidy
```

## Quick start

```bash
docker compose up -d --build
```

That starts Postgres and Redis, runs the migration, and brings up `api` and `consumer`.
The dashboard is at **<http://localhost:8000>**.

Submit a job:

```bash
curl -X POST http://localhost:8000/api/v1/jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: welcome-42' \
  -d '{
        "name": "welcome email",
        "queue": "default",
        "handler": "email.send",
        "payload": {"to": "a@b.com"},
        "priority": 5,
        "max_retries": 3
      }'
```

```json
{
  "id": "0b9f6a1e-4e7c-4a2f-9d1b-2f0c8b6d5a31",
  "name": "welcome email",
  "queue": "default",
  "handler": "email.send",
  "state": "pending",
  "payload": {"to": "a@b.com"},
  "priority": 5,
  "retry_count": 0,
  "max_retries": 3,
  "delivery_count": 0,
  "version": 1,
  "next_check_at": "2026-08-18T09:14:02.113Z",
  "idempotency_key": "welcome-42",
  "job_type": "adhoc",
  "cron": null,
  "next_run_at": null,
  "starts_at": null,
  "ends_at": null,
  "created_at": "2026-08-18T09:14:02.113Z",
  "updated_at": "2026-08-18T09:14:02.113Z"
}
```

`queue` must already be declared in `consumer.yaml`, which ships with a single `default` queue.
Nothing executes it yet: that needs a worker, which is the next section.

## Configuration

Three files, and none of them merge with a built-in default. Whatever you supply is the whole
configuration, so a key you leave out is a key set to zero, and almost every zero is rejected at
startup rather than silently accepted.

| File | Required by | If it is missing or incomplete |
| --- | --- | --- |
| `consumer.yaml` | `cmd/api` and `cmd/consumer` | both refuse to start |
| `worker.yaml` | your worker binary, only if you set `WorkerConfigPath` | leave `WorkerConfigPath` empty to use the embedded defaults; set it and the file must be complete |
| `.env` | `cmd/api` and `cmd/consumer` | any missing or malformed variable stops startup |

### `consumer.yaml` (repo root)

Every key below must be present. There are no defaults: an omitted key parses as zero and fails
validation. Both the api and the consumer read this file, so both need it, and the path comes
from `CONSUMER_CONFIG_PATH`, which itself must be set.

```yaml
poll_interval: 5        # seconds between polls
queue_limit: 10         # max jobs in flight toward one queue per poll
max_delivery_count: 3   # redeliveries before a stale job is declared dead
aging_rate: 0.0025      # see Scheduling in the main README
claim_deadline: 6000    # seconds a queued job may go unclaimed before requeue

# one entry per queue your workers will serve
queues:
  - name: default
```

| Key | Required | Rule enforced at startup |
| --- | --- | --- |
| `poll_interval` | yes | greater than 0 |
| `queue_limit` | yes | greater than 0 |
| `max_delivery_count` | yes | greater than 0 |
| `claim_deadline` | yes | greater than 0, **and** greater than `poll_interval`, since expiry is only ever noticed on a poll |
| `queues` | yes | at least one entry, every `name` non-empty, no duplicates |
| `aging_rate` | no | not validated. Omitting it means `0`, which turns aging off and leaves priority as a pure ranking |

Queue names are declared here and nowhere else, and kairos has no opinion about what they should
be. It ships with a single `default` queue; add an entry for every queue your workers serve, and
the API will reject submissions to anything not on the list.

### `worker.yaml`

Optional. Leave `WorkerConfigPath` empty and the values embedded at
`internal/worker/default.yaml` are used, so an importing application does not have to vendor a
copy and re-vendor it every time a key is added.

If you do point `WorkerConfigPath` at a file, **that file must contain every key**. It is not
merged over the defaults, so a partial file fails validation on the first key you left out. Start
from the block below and change what you need.

```yaml
database:
  partitioning:
    interval: monthly        # weekly | monthly | quarterly | half_yearly | yearly
    create_ahead: 6          # intervals kept provisioned ahead of now
  retention:
    days: 0                  # 0 = retain forever

concurrency: 3

brpop_timeout: 1s
queue_strategy: round_robin  # priority = queue order always wins | round_robin = equal turns

retry_backoff_base: 10s
retry_backoff_max: 1h

outcome_write_timeout: 5s
shutdown_grace: 30s

heartbeat_interval: 5s
stale_multiplier: 3
registry_interval: 10s
registry_ttl: 30s
log_flush_interval: 1s
log_flush_timeout: 5s
log_flush_threshold: 256
log_buffer_capacity: 4096
```

| Key | Meaning | Rule enforced at startup |
| --- | --- | --- |
| `database.partitioning.interval` | `job_logs` partitioning cadence | one of `weekly`, `monthly`, `quarterly`, `half_yearly`, `yearly` |
| `database.partitioning.create_ahead` | future partitions kept provisioned | greater than 0 |
| `database.retention.days` | days of `job_logs` kept; `0` retains forever | not negative |
| `concurrency` | max jobs executed at once | greater than 0 |
| `brpop_timeout` | Redis blocking-pop timeout | greater than 0; keep it at 1s or above, Redis `BRPOP` has one-second granularity |
| `queue_strategy` | how a worker picks between its queues | `priority` or `round_robin` |
| `retry_backoff_base` | first backoff window, doubled per retry | greater than 0 |
| `retry_backoff_max` | ceiling on the backoff window | at least `retry_backoff_base` |
| `outcome_write_timeout` | deadline for the detached write that records an outcome | greater than 0 |
| `shutdown_grace` | how long a drain may take before in-flight jobs are abandoned | greater than 0 |
| `heartbeat_interval` | how often a claim is renewed | greater than 0 |
| `stale_multiplier` | a claim is stale after `heartbeat_interval × multiplier` | at least 2 |
| `registry_interval` | how often a worker republishes its registry entry | greater than 0 |
| `registry_ttl` | TTL on that entry | at least twice `registry_interval` |
| `log_flush_interval` | how often buffered job logs are written | greater than 0 |
| `log_flush_timeout` | deadline for the final flush during shutdown | greater than 0 |
| `log_flush_threshold` | buffered lines that trigger an early flush | greater than 0 |
| `log_buffer_capacity` | size of the in-worker log buffer | at least twice `log_flush_threshold` |

Every duration is a string such as `"30s"`, `"1h"` or `"1s"`. A bare number is a parse error, not
a count of seconds.

`database.partitioning.interval` is effectively immutable after the first migration.

### `.env` (`cmd/api` and `cmd/consumer` only)

Both binaries call `godotenv.Load()` and then read every one of these from the environment.
**All are required**, with no fallback; a missing or malformed value fails startup.

```ini
PORT=8000
DBDSN=postgres://kairos:kairos@localhost:5432/kairos?sslmode=disable

DB_MAX_CONNS=10
DB_MIN_CONNS=0
DB_MAX_CONN_LIFETIME=1h
DB_MAX_CONN_IDLE_TIME=30m
DB_HEALTH_CHECK_PERIOD=1m

REDIS_ADDR=localhost:6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_PROTOCOL=2

CONSUMER_CONFIG_PATH=consumer.yaml
API_LOG_FILE=logs/api.log          # empty = stdout, text handler at debug level
CONSUMER_LOG_FILE=logs/consumer.log

# used by docker-compose
POSTGRES_USER=kairos
POSTGRES_PASSWORD=kairos
POSTGRES_DB=kairos
```

`REDIS_PASSWORD` alone may be empty (no auth); the log-file variables may be empty (selects
stdout). Everything else must be present and parse as the expected type. `DB_MIN_CONNS` must be
between 0 and `DB_MAX_CONNS`, and `DB_MAX_CONNS` must be greater than 0.

A worker built on the library does not read `.env`. It takes its Postgres and Redis settings from
the `kairos.Config` you pass to `kairos.New`, where only `PostgresCfg.DSN` is required.

## Docker and deployment

`docker-compose.yml` defines five services:

| Service | Notes |
| --- | --- |
| `postgres` (postgres:16), `redis` (redis:8) | health-checked; everything else waits on them |
| `migrate` | one-shot `goose up` (`restart: "no"`), must exit 0 before `api` and `consumer` start |
| `api` | built from the `Dockerfile`'s `api` target, published on `${API_PORT:-8000}` |
| `consumer` | built from the `consumer` target; **never run more than one instance**, see [Scaling](../README.md#scaling) |

`consumer.yaml` is bind-mounted read-only into both `api` and `consumer`, so changing the queue
list is `docker compose restart api consumer` rather than a rebuild. Rebuild after changing Go
code or dashboard assets:

```bash
docker compose up -d --build api consumer
docker compose logs -f consumer
```

Your worker is not in compose; it is your own binary. Postgres and Redis are
published to the host, so a worker run from the checkout reaches the stack on `localhost`.

**Running the services on the host instead**, useful when iterating on the api or consumer:

```bash
docker compose up -d postgres redis
goose -dir internal/db/migrations postgres "$DBDSN" up
go run ./cmd/api
go run ./cmd/consumer
```

Nothing runs without the consumer; it is the only path that moves a job from Postgres to Redis.

## Development

```bash
sqlc generate                                       # after editing anything in internal/db/query/
goose -dir internal/db/migrations postgres "$DBDSN" up
go build ./... && go vet ./...
```

Queries live in `internal/db/query/`: `jobs.sql` is the job lifecycle, `dashboard.sql` the
read-only aggregates. The Go in `internal/db/*.sql.go` is generated: edit the SQL and regenerate,
never the output.
