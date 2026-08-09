import { httpJson, httpJsonWithStatus } from './api';
import type { AttemptListResult, CreateJobInput, Job, JobListResult, JobQuery } from './types';

// GET /v1/jobs takes only limit+offset today, so state/queue narrowing happens on the page
// we were handed. filteredWithinPage tells the caller so it can say so on screen.
export async function listJobs(
  q: JobQuery,
): Promise<JobListResult & { filteredWithinPage: boolean }> {
  const params = new URLSearchParams({ limit: String(q.limit), offset: String(q.offset) });
  const page = await httpJson<JobListResult>(`/jobs?${params}`);

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
  return httpJson<Job>(`/jobs/${id}`);
}

export function listAttempts(id: string, limit = 100): Promise<AttemptListResult> {
  return httpJson<AttemptListResult>(`/jobs/${id}/attempts?limit=${limit}&offset=0`);
}

export function cancelJob(id: string, version: number): Promise<Job> {
  return httpJson<Job>(`/jobs/${id}/cancel`, { method: 'POST', body: { version } });
}

export function rerunJob(id: string, version: number): Promise<Job> {
  return httpJson<Job>(`/jobs/${id}/rerun`, { method: 'POST', body: { version } });
}

// POST /v1/jobs answers 201 for a fresh insert and 200 when an idempotency key replays an
// existing job, so the caller needs the status, not just the body.
export async function createJob(input: CreateJobInput): Promise<{ job: Job; created: boolean }> {
  const { data, status } = await httpJsonWithStatus<Job>('/jobs', { method: 'POST', body: input });
  return { job: data, created: status === 201 };
}
