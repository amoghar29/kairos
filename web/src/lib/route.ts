import { useSearchParams } from 'react-router-dom';
import type { JobState } from '../api/types';

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

// /jobs' own filter state, read out of the URL's query string so filters are shareable/back-
// button-able. Path params (job/worker id) come from react-router's useParams instead.
export function useJobsFilter(): JobsFilter {
  const [searchParams] = useSearchParams();
  return {
    states: searchParams.getAll('state') as JobState[],
    queue: searchParams.get('queue') ?? '',
    offset: Number.parseInt(searchParams.get('offset') ?? '0', 10) || 0,
  };
}
