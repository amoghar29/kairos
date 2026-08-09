import type { JobState } from '@/services/types';

export interface JobsFilter {
  states: JobState[];
  queue: string;
  offset: number;
}

export function jobsHref(r: JobsFilter): string {
  const params = new URLSearchParams();
  for (const s of r.states) params.append('state', s);
  if (r.queue) params.set('queue', r.queue);
  if (r.offset) params.set('offset', String(r.offset));
  const q = params.toString();
  return `/jobs${q ? `?${q}` : ''}`;
}
