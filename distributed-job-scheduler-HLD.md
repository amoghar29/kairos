# Distributed Job Scheduler — High-Level Design (v1)

A Celery/ATF-style distributed task framework. Clients define **task handlers** (business logic); clients schedule **jobs** (a task name + payload) which the system executes **at least once** across a pool of distributed workers. Stack: **Go** (API + workers + store consumer), **Redis** (dispatch buffer), **Postgres** (source of truth).

> Naming: a **task** is a registered handler (`task_name → function`); a **job** is one scheduled execution of a task with a concrete payload. A **queue** is a named routing + isolation unit a job is assigned to at creation.

---

## 1. System Guarantees & Scope

| Guarantee / Scope | v1 stance |
|---|---|
| Delivery | **At-least-once.** A job runs one or more times; never zero. |
| Concurrency | **At-most-one *claim* per dispatch**, but **concurrent execution is possible** under a slow-but-alive worker (knowingly accepted; mitigated by idempotency). |
| Correctness on re-run | **Task-author responsibility** — handlers MUST be idempotent (documented requirement). |
| Source of truth | **Postgres.** Redis is a rebuildable dispatch buffer; losing it loses no jobs. |
| Scheduling | **Run-now only** in v1. Delayed/cron deferred to a later phase. |
| Cancel | **"Don't start"** in v1 (cancel a not-yet-running job). Stopping a running job deferred. |
| Failure sink | **Dead Letter Queue** for jobs beyond retry/delivery limits. |

---

## 2. Components

### 2.1 Frontend UI
**What it is:** A dashboard web app.
**Responsibilities:**
- Display jobs, their state, history, retry counts, and execution details.
- Show per-queue depth, throughput, and the worker registry (who's alive, load, which queues each serves).
- Create jobs, cancel jobs, inspect the DLQ.
- Reads everything via the API server (no direct DB/Redis access).

### 2.2 API Server (Go)
**What it is:** The client-facing control plane. Stateless; horizontally scalable.
**Responsibilities:**
- **Create job:** validate, write a `PENDING` row to Postgres. *Never writes to Redis* (preserves single-enqueuer invariant).
- **Fetch:** jobs, queues, status counts, worker registry, DLQ contents — the dashboard's read models.
- **Cancel (write-with-semantics, not plain CRUD):** CAS the row to `CANCELLED` only if not already terminal. Effect depends on current state — `PENDING`/`READY` → it simply never gets claimed; `RUNNING` → v1 lets it finish (don't-stop-running scope).
- **Expose `/metrics`** (Prometheus) for the dashboard and observability.

### 2.3 Postgres
**What it is:** The persistent source of truth and the home of the job **state machine**.
**Responsibilities:**
- Store every job: payload, queue, state, `retry_count`, `delivery_count`, timestamps, `next_trigger_at`, worker_id, result/error.
- Be the **sole redelivery authority** — recovery and retry are derived here, never in Redis.
- Back the worker registry table (optional; can also live in Redis with TTL).

### 2.4 Redis
**What it is:** A fire-once, in-memory **dispatch buffer** — one plain list per queue.
**Responsibilities:**
- Hold at most `N_Q` ready jobs per queue (`N_Q` = per-queue budget).
- Hand jobs to workers via atomic pop (`BRPOP`) — fire-once: once popped, it's gone from Redis.
- Treated as **rebuildable**: if Redis is wiped, the Store Consumer reconstructs every list from Postgres `READY` rows. It does **not** redeliver on its own.

### 2.5 Store Consumer (the brain)
**What it is:** The single background loop that moves work from Postgres → Redis. (One instance in v1.)
**Responsibilities — one polling query does four jobs at once:**
```
SELECT ... WHERE status IN (PENDING, READY, RUNNING, AWAITING_RETRY)
  AND next_trigger_at <= now()
[per queue: rank by effective_priority, take top (N_Q − x_Q)]
FOR UPDATE SKIP LOCKED
```
- **Dispatch** new work (`PENDING` → `READY`, push to Redis).
- **Retry** backed-off jobs (`AWAITING_RETRY` whose backoff elapsed).
- **Recover** jobs whose *task-heartbeat* went stale (`RUNNING` past `next_trigger_at` ⇒ presumed-dead worker ⇒ re-dispatch) — this *is* the dead-worker reaper; no separate daemon.
- **Re-enqueue** jobs that rotted in the list (`READY` past `enqueue_timeout`).
- **DLQ transition:** when `retry_count` exhausts its budget **or** `delivery_count` exceeds `max_delivery_count`, flip to `DEAD` instead of re-enqueuing.
- **Bounded fill:** derive in-queue count `x_Q` from Postgres `READY` count (not from Redis), push only the top `(N_Q − x_Q)` highest-priority jobs per queue. Sole component that writes to Redis.

### 2.6 Worker = Executor + Worker-Heartbeat (Go)
**What it is:** A process that pulls and runs jobs. Distributed — many workers, possibly across machines. Holds the **task registry** (`task_name → handler`); can only run tasks it has registered. Subscribes to a **set of queues**.
**Responsibilities (Executor):**
- **Multi-queue pull with round-robin** across its subscribed queues (avoids left-to-right `BRPOP` starvation).
- **Cancel-check:** if the row is `CANCELLED`, drop it (cancel-before-start wins the race).
- **Claim:** CAS `READY → RUNNING` (set worker_id, started_at) — the at-most-one-*claim* guarantee.
- **Execute** the handler with the payload.
- **Task-heartbeat:** while running, bump the row's `last_heartbeat_at` → pushes `next_trigger_at` forward (this is what recovery keys off).
- **Panic recovery:** a crashing handler converts to `AWAITING_RETRY`/`DEAD`, never takes down the worker or orphans sibling jobs.
- **Terminal update:** success → `SUCCEEDED`; retriable failure → `AWAITING_RETRY` (backoff) or `DEAD` (budget gone); fatal → `DEAD`.
- **Graceful shutdown:** stop pulling, finish or release in-flight jobs, deregister.

**Responsibilities (Worker-Heartbeat / Registry — dashboard-only):**
- Periodically write a `workers` record (Redis key w/ TTL or Postgres row): alive, last-seen, load, subscribed queues.
- **Never** triggers requeues — recovery is task-level, not worker-level (see D1/D3). This is purely observability (#9, dashboard).

### 2.7 Observability (cross-cutting, not a box)
- Prometheus metrics from day one: per-queue depth, jobs-by-status, dispatch latency, success/fail rate, live worker count. Dashboard reads these.

---

## 3. Job State Machine

`next_trigger_at` = "when should the Store Consumer look at me again." Every non-terminal state sets it; terminal states set it `NULL`.

| State | Meaning | `next_trigger_at` |
|---|---|---|
| `PENDING` | Created, never dispatched | `available_at` (now for run-now) |
| `READY` | Pushed to Redis list | `enqueued_at + enqueue_timeout` |
| `RUNNING` | Claimed by a worker | `last_heartbeat_at + heartbeat_timeout` (bumped each heartbeat) |
| `AWAITING_RETRY` | Handler signaled retriable failure | `next_retry_at` (exponential backoff) |
| `SUCCEEDED` | Done | `NULL` |
| `DEAD` | Retry/delivery budget exhausted → DLQ | `NULL` |
| `CANCELLED` | Cancelled before claim | `NULL` |

**Two counters, different jobs:**
- `retry_count` — handler-signaled retriable failures. Drives backoff + DLQ-on-exhaustion.
- `delivery_count` — every dispatch/redispatch. Guards against **poison pills** (jobs that crash workers before signaling anything, which never touch `retry_count`). Exceeds `max_delivery_count` → `DEAD`. A stale-heartbeat recovery increments `delivery_count` but **not** `retry_count`.

---

## 4. Key Decisions & Trade-offs

**D0 — No dual write (single enqueuer).** API writes only Postgres; Store Consumer is the only writer to Redis.
*Alternative:* API writes both Postgres + Redis. *Rejected:* a crash between the two writes yields ghosts/orphans on every transition. Single enqueuer makes Postgres-as-truth real in code.

**D1 — Task-level heartbeat (not worker-level).** Recovery timeout lives on each job row; Store Consumer finds individually-stale jobs.
*Alternative:* one heartbeat per worker + a reaper mapping dead-worker → its in-flight jobs. *Rejected:* requires a worker→jobs ownership map and a separate coordinated reaper daemon. Task-level folds recovery into the existing dispatch query — fewer moving parts. Cost: more heartbeat writes (one per in-flight job); negligible at this scale, batchable later.

**D2 — Plain Redis lists, fire-once; Postgres is the sole redelivery authority.**
*Alternative:* Redis Streams + consumer groups (XPENDING/XCLAIM) doing their own redelivery. *Rejected for v1:* with Postgres owning recovery, Redis-side redelivery is redundant and risks double-enqueue (at-least-once → at-least-twice-per-failure). Lists are simpler. *Cost:* a plain list can't re-sort (see N as the priority dial, below). Streams remains a reasonable future swap for nicer consumer-group ergonomics.

**D3 — No executor self-termination in v1; accept possible concurrency.** Under a slow-but-alive worker (GC pause, partition), the Store Consumer may requeue a still-running job and a second worker claims it ⇒ two copies run. Accepted; idempotency (D4) makes it safe. The CAS stops double-*claim*, not double-*execution-across-a-requeue*.
*Alternative (deferred):* ATF's self-termination — worker kills itself after N failed heartbeats, tuned to die before requeue ⇒ no-concurrent-execution guarantee. Planned as a later hardening phase.

**D4 — Idempotency is the task author's responsibility.** Framework is at-least-once; handlers must be idempotent (documented, ATF-style).
*Alternative:* framework-provided idempotency key with server-side de-dupe of succeeded keys. Deferred as an optional extension.

**D5 — Single Store Consumer in v1; multi-instance via `SELECT … FOR UPDATE SKIP LOCKED` later (optional).**
*Alternative:* leader-elected singleton (Raft/etcd). *Rejected:* over-engineering — `SKIP LOCKED` gives HA + horizontal scale from a DB primitive. Note: the "derive `x` from Postgres" trick (below) needs queue partitioning once multiple consumers run, to avoid two consumers both reading `x` and overfilling.

**D6 — `max_delivery_count` (poison-pill cap) in addition to retry budget.** Without it, a job that crashes workers before signaling loops forever (dispatch → kill → stale heartbeat → requeue → kill…) and never reaches the DLQ. The DLQ only catches *clean* failures otherwise.

**D7 — Recovery requeues don't consume `retry_count`.** Keep `retry_count` purely for handler-signaled retries; let `delivery_count`'s cap govern recovery loops. Cleaner semantics.

**Bounded fill — derive `x_Q` from Postgres `READY` count, not from Redis.** The only thing that changes the count between read and push is workers *claiming* (`READY→RUNNING`), which only decreases it ⇒ the race is **one-directional, benign, self-healing**: worst case the queue is momentarily under-full and the next tick corrects; never over-fills past `N_Q`.
**N is the priority-fidelity dial.** A plain list can't promote a job that becomes top-priority *after* enqueue — it waits behind ≤ N lower-priority jobs. Small `N` = tight priority adherence + more DB polling; large `N` = less DB churn but priority degrades toward FIFO. **Keep `N` modest.** (Escape hatch if ever needed: per-queue sorted set + `ZPOPMIN` for true in-queue ordering.)

**Multiple queues, queue-local independent priority.** A queue = routing + isolation unit, own Redis list, own budget `N_Q`, own internal priority+aging (computed in Postgres). No global priority heap; priorities are not comparable across queues. One windowed query (`ROW_NUMBER() OVER (PARTITION BY queue ORDER BY effective_priority …)`) tops up every queue in a single round-trip.

**Multi-queue workers with round-robin pull.** A worker subscribes to a *set* of queues and pulls across them fairly.
*Alternative:* dedicated pools (one worker = one queue, ATF-style) — simpler, zero cross-queue starvation, but static capacity that can't spill to a busy queue. *Chosen multi-queue* because it's a strict superset (subscribe a worker to one queue = a dedicated pool) and the richer distributed story. *Cost:* needs a pull-fairness policy — naive `BRPOP listA listB listC` checks left-to-right and starves `listC`; fixed by rotating key order per pull. This is a *fairness* decision only; it never reintroduces cross-queue priority comparison.

---

## 5. Deferred to Later Phases
- **Priority + anti-starvation aging** mechanism (the per-queue `effective_priority` / promotion logic — referenced paper to be applied here).
- **Delayed / cron / periodic** scheduling (reuses the `next_trigger_at` + `available_at` machinery already in the state machine).
- **Stop a running job** (cooperative cancellation: signal the worker, handlers observe a cancel context).
- **Executor self-termination** (D3 hardening toward no-concurrent-execution).
- **Multi-instance Store Consumer** via `SKIP LOCKED` (D5) with queue partitioning.
- **Framework-level idempotency keys** (D4 extension).
- **Richer DLQ tooling** (one-click requeue after a fix, ATF "Extending ATF" parity-plus).
