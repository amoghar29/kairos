import type { JobState } from '@/services/types';

// The queue registry is a closed set owned by consumer.yaml, and no endpoint exposes it yet,
// so the dashboard carries its own copy. Keep this list in step with consumer.yaml's `queues:`
// until GET /v1/queues lands (see changes_req.md).
export const QUEUES = ['testing1', 'high_priority'];

export const JOB_STATES: JobState[] = [
  'pending',
  'queued',
  'running',
  'awaiting_retry',
  'success',
  'dead',
  'cancelled',
];

export const NON_TERMINAL_STATES: JobState[] = ['pending', 'queued', 'running', 'awaiting_retry'];

export const CANCELLABLE_STATES: JobState[] = ['pending', 'queued', 'awaiting_retry'];

export const POLL_SECONDS = 3;
export const ROWS_PER_PAGE = 25;

// Oldest-pending-age thresholds, in seconds — the Overview table colours against these.
export const AGE_WARNING = 60;
export const AGE_CRITICAL = 300;

// A worker or consumer whose heartbeat is older than this reads as stale.
export const HEARTBEAT_STALE_SECONDS = 10;

export const COLORS = {
  MUTED: '#5d5d60',
  FAINT: '#7a7a7d',
  DISABLED: '#98989b',

  WARN_BG: '#f4e3c0',
  WARN_INK: '#6b4a10',
  WARN_BORDER: '#d9bd7e',

  BAD_BG: '#f3d3d1',
  BAD_INK: '#7f2320',
  BAD_BORDER: '#c98b86',

  GOOD_BG: '#cfe6d4',
  GOOD_INK: '#1f5130',
  GOOD_BORDER: '#8fbb9c',

  NEUTRAL_BG: '#e7e7ea',
  NEUTRAL_BORDER: '#d4d4d7',
  NEUTRAL_STRONG_BG: '#d4d4d7',
  NEUTRAL_STRONG_INK: '#2b2b2d',
  NEUTRAL_STRONG_BORDER: '#b7b7ba',

  ACCENT: 'var(--color-accent)',
  ACCENT_BORDER: 'var(--color-accent-700)',
  ON_ACCENT: '#f2f2f3',
} as const;
