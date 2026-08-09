import { ApiError } from './error';
import type {
  AttemptListResult,
  ConsumerStatus,
  CreateJobInput,
  Job,
  JobListResult,
  JobQuery,
  QueueStats,
  Worker,
} from './types';

const BASE = 'http://localhost:8000/v1';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = BASE + path;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new ApiError(
      'unreachable',
      `could not reach the scheduler API at ${url}: ${e instanceof Error ? e.message : String(e)}`,
      0,
    );
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // internal/api/errors.go writes {message, code, fields?} on every non-2xx.
    const code = (body?.code as string) ?? 'unknown';
    const message = (body?.message as string) ?? `request failed with ${res.status}`;
    throw new ApiError(code, message, res.status, body?.fields);
  }
  return body as T;
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

// Not yet served by internal/api/routes.go — see changes_req.md items 2-4. These calls fail
// with a 404 ApiError until the backend grows the endpoint; the pages already render that
// through ErrorPanel.
export function getQueues(): Promise<QueueStats[]> {
  return request<QueueStats[]>('/queues');
}

export function getWorkers(): Promise<Worker[]> {
  return request<Worker[]>('/workers');
}

export function getConsumer(): Promise<ConsumerStatus> {
  return request<ConsumerStatus>('/consumer');
}

// GET /v1/jobs takes only limit+offset today, so state/queue narrowing happens on the page
// we were handed. filteredWithin tells the caller so it can say so on screen.
export async function listJobs(q: JobQuery): Promise<JobListResult & { filteredWithinPage: boolean }> {
  const params = new URLSearchParams({ limit: String(q.limit), offset: String(q.offset) });
  const page = await request<JobListResult>(`/jobs?${params}`);

  const narrowing = q.states.length > 0 || q.queue !== '';
  if (!narrowing) return { ...page, filteredWithinPage: false };

  const jobs = page.jobs.filter(
    (j) =>
      (q.states.length === 0 || q.states.includes(j.state)) &&
      (q.queue === '' || j.queue === q.queue),
  );
  return { jobs, pagination: page.pagination, filteredWithinPage: true };
}

export function getJob(id: string): Promise<Job> {
  return request<Job>(`/jobs/${id}`);
}

export function listAttempts(id: string, limit = 100): Promise<AttemptListResult> {
  return request<AttemptListResult>(`/jobs/${id}/attempts?limit=${limit}&offset=0`);
}

export function cancelJob(id: string, version: number): Promise<Job> {
  return request<Job>(`/jobs/${id}/cancel`, jsonBody({ version }));
}

export function rerunJob(id: string, version: number): Promise<Job> {
  return request<Job>(`/jobs/${id}/rerun`, jsonBody({ version }));
}

// POST /v1/jobs answers 201 for a fresh insert and 200 when an idempotency key replays an
// existing job, so the caller needs the status, not just the body.
export async function createJob(input: CreateJobInput): Promise<{ job: Job; created: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (e) {
    throw new ApiError('unreachable', e instanceof Error ? e.message : String(e), 0);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      (body?.code as string) ?? 'unknown',
      (body?.message as string) ?? `request failed with ${res.status}`,
      res.status,
      body?.fields,
    );
  }
  return { job: body as Job, created: res.status === 201 };
}
