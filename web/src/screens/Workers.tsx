import { useNavigate } from 'react-router-dom';

import { Blueprint } from '@/components/Blueprint';
import { EmptyPanel, ErrorPanel, LoadingPanel } from '@/components/Panels';
import { HEARTBEAT_STALE_SECONDS } from '@/constants';
import { useStatus } from '@/contexts/StatusContext';
import { useResource } from '@/hooks/useResource';
import { getWorkers } from '@/services';
import { dur, rel } from '@/utils/format';

export function staleSeconds(lastSeen: string): number {
  return (Date.now() - Date.parse(lastSeen)) / 1000;
}

export function isOnline(lastSeen: string): boolean {
  return staleSeconds(lastSeen) < HEARTBEAT_STALE_SECONDS;
}

export function Workers() {
  const navigate = useNavigate();
  const { retry } = useStatus();
  const res = useResource('workers', getWorkers);

  return (
    <div>
      <div className="k-title-row">
        <h1>Workers</h1>
        <span className="k-endpoint">GET /workers</span>
      </div>

      {res.loading && <LoadingPanel label="/workers" />}
      {res.error && <ErrorPanel error={res.error} onRetry={retry} />}
      {res.ready && res.data!.length === 0 && (
        <EmptyPanel
          title="No workers registered"
          detail="The registry self-expires, so an idle fleet shows nothing here."
        />
      )}

      {res.ready && res.data!.length > 0 && (
        <Blueprint style={{ padding: 0 }}>
          <table className="k-t">
            <thead>
              <tr>
                <th style={{ width: 130 }}>id</th>
                <th>queues</th>
                <th className="k-num" style={{ width: 90 }}>
                  in_flight
                </th>
                <th className="k-num" style={{ width: 120 }}>
                  last_seen
                </th>
                <th className="k-num" style={{ width: 120 }}>
                  uptime
                </th>
              </tr>
            </thead>
            <tbody>
              {res.data!.map((w) => (
                <tr
                  key={w.id}
                  className="k-click"
                  onClick={() => navigate(`/workers/${w.id}`)}
                  title="Open worker detail"
                >
                  <td className="k-mono text-[12.5px]">{w.id}</td>
                  <td>
                    <div className="flex flex-wrap gap-1.5">
                      {w.queues.map((q) => (
                        <span key={q} className="tag tag-accent px-2 py-0.5 text-[10.5px]">
                          {q}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="k-num">{w.in_flight}</td>
                  <td
                    className="k-num"
                    style={{ color: isOnline(w.last_seen) ? '#5d5d60' : '#7f2320' }}
                    title={w.last_seen}
                  >
                    {rel(w.last_seen)}
                  </td>
                  <td className="k-num text-dim" title={w.started_at}>
                    {dur(staleSeconds(w.started_at))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Blueprint>
      )}
    </div>
  );
}
