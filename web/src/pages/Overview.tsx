import { useNavigate } from 'react-router-dom';
import { getQueues, getWorkers } from '../api/client';
import type { QueueStats, Worker } from '../api/types';
import { Blueprint } from '../components/Blueprint';
import { EmptyPanel, ErrorPanel, LoadingPanel } from '../components/Panels';
import { ageStyle } from '../lib/badge';
import { EM_DASH, dur } from '../lib/format';
import { useResource, useStatus } from '../lib/resource';

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <Blueprint className="k-tile">
      <div className="k-kicker">{label}</div>
      <div className="k-tile-value">{value}</div>
    </Blueprint>
  );
}

function QueueRow({ q, workers }: { q: QueueStats; workers: Worker[] }) {
  const navigate = useNavigate();
  const workerCount = workers.filter((w) => w.queues.includes(q.queue)).length;
  const backlog =
    q.counts.pending + q.counts.queued + q.counts.running + q.counts.awaiting_retry;
  // Work waiting with nobody subscribed to it: the queue is dead, not merely idle.
  const isDead = workerCount === 0 && backlog > 0;
  const open = () => navigate(`/jobs?queue=${q.queue}`);

  return (
    <tr
      className="k-click"
      onClick={open}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open();
      }}
      title="Open /jobs filtered to this queue"
    >
      <td className="font-cond text-[15px] font-semibold tracking-[.02em]">
        <div>{q.queue}</div>
        {isDead && (
          <span
            className="font-cond mt-[3px] inline-block whitespace-nowrap px-[7px] py-px text-[9.5px] font-semibold uppercase tracking-[.06em]"
            style={{ background: '#f3d3d1', color: '#7f2320', border: '1px solid #c98b86' }}
          >
            dead · no workers
          </span>
        )}
      </td>
      <td
        className="k-num"
        style={{ color: workerCount === 0 ? '#7f2320' : '#5d5d60', fontWeight: workerCount === 0 ? 700 : 500 }}
      >
        {workerCount}
      </td>
      <td className="k-num">{q.counts.pending}</td>
      <td className="k-num">{q.counts.queued}</td>
      <td className="k-num">{q.counts.running}</td>
      <td className="k-num">{q.counts.awaiting_retry}</td>
      <td className="k-num text-muted">{q.redis_buffered ?? EM_DASH}</td>
      <td>
        {q.counts.pending ? (
          <span style={ageStyle(q.oldest_pending_age_seconds)}>{dur(q.oldest_pending_age_seconds)}</span>
        ) : (
          <span className="px-2 py-px text-[13px] text-hairline">{EM_DASH}</span>
        )}
      </td>
    </tr>
  );
}

export function Overview() {
  const { retry } = useStatus();
  const queues = useResource('overview:queues', getQueues);
  const workers = useResource('overview:workers', getWorkers);

  const workerRows = workers.data ?? [];
  const inFlight = workers.data ? workers.data.reduce((a, w) => a + w.in_flight, 0) : '–';

  return (
    <div>
      <div className="k-title-row">
        <h1>Overview</h1>
        <span className="text-[11px] tracking-[.04em] text-muted">GET /queues · GET /workers</span>
      </div>

      <div className="k-tile-row">
        <Tile label="live workers" value={workers.data ? workers.data.length : '–'} />
        <Tile label="in flight" value={inFlight} />
        <Tile label="queues" value={queues.data ? queues.data.length : '–'} />
        <div className="flex min-w-[240px] flex-1 items-end pb-1">
          <p className="m-0 max-w-[390px] text-[11.5px] leading-relaxed text-muted">
            Oldest pending age is the page's load-bearing number: it shows whether anti-starvation
            aging is keeping up. Warning past 60s, critical past 300s.
          </p>
        </div>
      </div>

      {queues.loading && <LoadingPanel label="/queues" />}
      {queues.error && <ErrorPanel error={queues.error} onRetry={retry} />}
      {queues.ready && queues.data!.length === 0 && (
        <EmptyPanel
          title="No queues registered"
          detail="A queue appears here once it is declared in consumer.yaml and a job is enqueued to it."
        />
      )}

      {queues.ready && queues.data!.length > 0 && (
        <Blueprint style={{ padding: 0 }}>
          <table className="k-t">
            <thead>
              <tr>
                <th style={{ width: '18%' }}>queue</th>
                <th className="k-num" style={{ width: 70 }}>
                  workers
                </th>
                <th className="k-num">pending</th>
                <th className="k-num">queued</th>
                <th className="k-num">running</th>
                <th className="k-num">awaiting_retry</th>
                <th className="k-num">redis_buffered</th>
                <th style={{ width: 190 }}>oldest pending age</th>
              </tr>
            </thead>
            <tbody>
              {queues.data!.map((q) => (
                <QueueRow key={q.queue} q={q} workers={workerRows} />
              ))}
            </tbody>
          </table>
        </Blueprint>
      )}
    </div>
  );
}
