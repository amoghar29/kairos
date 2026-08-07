import { getWorkers } from '../api/client';
import { Blueprint } from '../components/Blueprint';
import { ErrorPanel, LoadingPanel } from '../components/Panels';
import { badgeStyle } from '../lib/badge';
import { dur, rel } from '../lib/format';
import { useResource, useStatus } from '../lib/resource';
import { isOnline, staleSeconds } from './Workers';

export function WorkerDetail({ workerId }: { workerId: string }) {
  const { retry } = useStatus();
  const res = useResource('workers', getWorkers);

  const worker = res.data?.find((w) => w.id === workerId);

  return (
    <div>
      <div className="mb-2.5 text-[11.5px] text-muted">
        <a href="#/workers" className="no-underline">
          ← Workers
        </a>
        <span className="mx-2">/</span>
        <span className="k-mono">{workerId}</span>
      </div>

      {res.loading && <LoadingPanel label="/workers" />}
      {res.error && <ErrorPanel error={res.error} onRetry={retry} />}

      {res.ready && !worker && (
        <Blueprint className="p-8 text-center text-muted">
          Worker not found — the registry self-expires, so it may have dropped out since you clicked.
        </Blueprint>
      )}

      {worker && (
        <div>
          <Blueprint className="mb-5.5 px-5 py-4">
            <div className="mb-3 flex items-center gap-3">
              <span style={badgeStyle(isOnline(worker.last_seen) ? 'running' : 'awaiting_retry', '12px')}>
                {isOnline(worker.last_seen) ? 'online' : 'stale heartbeat'}
              </span>
              <h1 className="k-mono m-0 text-[26px]">{worker.id}</h1>
            </div>

            <div className="grid max-w-[820px] grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-5 gap-y-3">
              <div>
                <div className="k-label">subscribed queues</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {worker.queues.map((q) => (
                    <span key={q} className="tag tag-accent px-2 py-0.5 text-[10.5px]">
                      {q}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div className="k-label">in_flight</div>
                <div className="text-[14px]">{worker.in_flight}</div>
              </div>
              <div>
                <div className="k-label">heartbeat · last_seen</div>
                <div className="text-[14px]" title={worker.last_seen}>
                  {rel(worker.last_seen)}
                </div>
              </div>
              <div>
                <div className="k-label">started_at · uptime</div>
                <div className="text-[14px]" title={worker.started_at}>
                  {dur(staleSeconds(worker.started_at))} up
                </div>
              </div>
            </div>

            <p className="mt-3 max-w-[640px] text-[11px] leading-relaxed text-muted">
              A <span className="k-mono">/workers</span> registry carries live state only (queues,
              in_flight, last_seen, started_at) — no downtime history and no log stream. There is no
              endpoint yet for per-worker job attempt history either; see changes_req.md.
            </p>
          </Blueprint>
        </div>
      )}
    </div>
  );
}
