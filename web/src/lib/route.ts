import { useEffect, useState } from 'react';
import type { JobState } from '../api/types';

export interface Route {
  path: string;
  jobId: string | null;
  workerId: string | null;
  states: JobState[];
  queue: string;
  offset: number;
}

export function parseRoute(hash: string): Route {
  const raw = (hash || '#/').replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query ?? '');
  const job = path.match(/^\/jobs\/(.+)$/);
  const worker = path.match(/^\/workers\/(.+)$/);

  return {
    path,
    jobId: job ? job[1] : null,
    workerId: worker ? worker[1] : null,
    states: params.getAll('state') as JobState[],
    queue: params.get('queue') ?? '',
    offset: Number.parseInt(params.get('offset') ?? '0', 10) || 0,
  };
}

export function jobsHref(r: Pick<Route, 'states' | 'queue' | 'offset'>): string {
  const params = new URLSearchParams();
  for (const s of r.states) params.append('state', s);
  if (r.queue) params.set('queue', r.queue);
  if (r.offset) params.set('offset', String(r.offset));
  const q = params.toString();
  return `#/jobs${q ? `?${q}` : ''}`;
}

export function go(href: string): void {
  window.location.hash = href.replace(/^#/, '') || '/';
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return parseRoute(hash);
}
