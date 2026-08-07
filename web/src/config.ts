// The queue registry is a closed set owned by consumer.yaml, and no endpoint exposes it yet,
// so the dashboard carries its own copy. Keep this list in step with consumer.yaml's `queues:`
// until GET /v1/queues lands (see changes_req.md).
export const QUEUES = ['testing1', 'high_priority'];

export const POLL_SECONDS = 3;
export const ROWS_PER_PAGE = 25;

// Oldest-pending-age thresholds, in seconds — the Overview table colours against these.
export const AGE_WARNING = 60;
export const AGE_CRITICAL = 300;

// A worker or consumer whose heartbeat is older than this reads as stale.
export const HEARTBEAT_STALE_SECONDS = 10;
