import { getConsumer, getQueues } from '../api/client';
import { Blueprint } from '../components/Blueprint';
import { LogStream } from '../components/LogStream';
import { HEARTBEAT_STALE_SECONDS } from '../config';
import { badgeStyle } from '../lib/badge';
import { EM_DASH, rel } from '../lib/format';
import { useResource } from '../lib/resource';

function isConsumerHealthy(heartbeatAt: string | null): boolean {
  if (!heartbeatAt) return false;
  return (Date.now() - Date.parse(heartbeatAt)) / 1000 < HEARTBEAT_STALE_SECONDS;
}

export function Consumer() {
  const queues = useResource('consumer:queues', getQueues);
  const consumer = useResource('consumer:status', getConsumer);

  const healthy = isConsumerHealthy(consumer.data?.heartbeat_at ?? null);
  const totalBuffered = queues.data
    ? queues.data.reduce((a, q) => a + (q.redis_buffered ?? 0), 0)
    : '–';

  return (
    <div>
      <div className="k-title-row">
        <h1>Consumer</h1>
        <span className="k-endpoint">internal poll loop · redis → queue → worker</span>
      </div>

      <p className="m-0 mb-5 max-w-[640px] text-[12px] text-muted">
        The scheduler's own poll loop — claims due jobs, pushes their ids onto{' '}
        <span className="k-mono">queue:&lt;name&gt;</span> in redis, then marks them{' '}
        <span className="k-mono">queued</span>. It is not exposed as a REST resource, so nothing on
        this page has a real endpoint behind it.
      </p>

      <div className="k-tile-row">
        <Blueprint className="k-tile" style={{ minWidth: 170 }}>
          <div className="k-kicker">status</div>
          <div className="mt-1">
            <span style={badgeStyle(healthy ? 'running' : 'awaiting_retry')}>
              {consumer.data?.heartbeat_at ? (healthy ? 'healthy' : 'unknown') : 'unknown'}
            </span>
          </div>
        </Blueprint>

        <Blueprint className="k-tile" style={{ minWidth: 170 }}>
          <div className="k-kicker">heartbeat</div>
          <div className="mt-0.5 text-[18px]" title={consumer.data?.heartbeat_at ?? EM_DASH}>
            {consumer.data?.heartbeat_at ? rel(consumer.data.heartbeat_at) : EM_DASH}
          </div>
        </Blueprint>

        <Blueprint className="k-tile" style={{ minWidth: 170 }}>
          <div className="k-kicker">total redis_buffered</div>
          <div className="k-tile-value" style={{ fontSize: 32 }}>
            {totalBuffered}
          </div>
        </Blueprint>
      </div>

      <div className="flex flex-wrap items-start gap-6.5">
        <Blueprint className="min-w-[340px] flex-none basis-[420px]" style={{ padding: 0 }}>
          <table className="k-t">
            <thead>
              <tr>
                <th>queue</th>
                <th className="k-num">redis_buffered</th>
                <th className="k-num">pulled in</th>
              </tr>
            </thead>
            <tbody>
              {(queues.data ?? []).map((q) => (
                <tr key={q.queue}>
                  <td className="font-cond font-semibold">{q.queue}</td>
                  <td className="k-num">{q.redis_buffered ?? EM_DASH}</td>
                  <td className="k-num text-dim">{q.counts.queued + q.counts.running}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Blueprint>

        <div className="min-w-[420px] flex-1 basis-[480px]">
          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 className="m-0 text-[19px]">Activity</h2>
            <span className="text-[11px] text-muted">poll · pull from redis · push to worker</span>
          </div>
          <LogStream lines={consumer.data?.activity ?? []} maxHeight={340} />
        </div>
      </div>
    </div>
  );
}
