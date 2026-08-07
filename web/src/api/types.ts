export type JobState =
  | 'pending'
  | 'queued'
  | 'running'
  | 'awaiting_retry'
  | 'success'
  | 'dead'
  | 'cancelled';

export type AttemptOutcome = 'in_progress' | 'success' | 'failed' | 'cancelled' | 'superseded';

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

export interface Job {
  id: string;
  name: string;
  queue: string;
  state: JobState;
  payload: unknown;
  priority: number;
  retry_count: number;
  max_retries: number;
  delivery_count: number;
  version: number;
  next_check_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobAttempt {
  id: string;
  job_id: string;
  attempt_number: number;
  worker_id: string;
  outcome: AttemptOutcome;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface PageInfo {
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface JobListResult {
  jobs: Job[];
  pagination: PageInfo;
}

export interface AttemptListResult {
  attempts: JobAttempt[];
  pagination: PageInfo;
}

export interface QueueStats {
  queue: string;
  counts: Record<'pending' | 'queued' | 'running' | 'awaiting_retry', number>;
  oldest_pending_age_seconds: number;
  redis_buffered: number | null;
}

export interface Worker {
  id: string;
  queues: string[];
  in_flight: number;
  last_seen: string;
  started_at: string;
}

export interface ConsumerStatus {
  heartbeat_at: string | null;
  activity: LogLine[];
}

export interface LogLine {
  t: string;
  line: string;
}

export interface CreateJobInput {
  name: string;
  queue: string;
  payload: unknown;
  priority: number;
  max_retries?: number;
  idempotency_key?: string;
}

export interface JobQuery {
  states: JobState[];
  queue: string;
  limit: number;
  offset: number;
}
