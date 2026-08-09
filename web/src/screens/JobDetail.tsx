import { useState } from 'react';

import { Link, useParams } from 'react-router-dom';

import { Badge } from '@/components/Badge';
import { Blueprint } from '@/components/Blueprint';
import { LogStream } from '@/components/LogStream';
import { ErrorPanel, LoadingPanel } from '@/components/Panels';
import { CANCELLABLE_STATES } from '@/constants';
import { useStatus } from '@/contexts/StatusContext';
import { useResource } from '@/hooks/useResource';
import { cancelJob, getJob, listAttempts, rerunJob } from '@/services';
import { type ApiError, asApiError } from '@/services/api';
import type { Job, JobAttempt, LogLine } from '@/services/types';
import { EM_DASH, abs, dur, rel, relShort, span } from '@/utils/format';

const ERROR_CLAMP = 74;

function Field({ label, value, title }: { label: string; value: string | number; title?: string }) {
  return (
    <div>
      <div className="k-label">{label}</div>
      <div className="text-[14px]" title={title}>
        {value}
      </div>
    </div>
  );
}

// The job has no server-side event log, so the timeline is folded together from the row's
// own timestamps and its attempt history.
function timeline(job: Job, attempts: JobAttempt[]): LogLine[] {
  const lines: LogLine[] = [
    { t: job.created_at, line: `created · queue=${job.queue} priority=${job.priority}` },
  ];

  for (const a of attempts) {
    lines.push({ t: a.started_at, line: `attempt ${a.attempt_number} started on ${a.worker_id}` });
    if (!a.finished_at) continue;
    if (a.outcome === 'success') {
      lines.push({ t: a.finished_at, line: `attempt ${a.attempt_number} succeeded` });
    } else if (a.outcome === 'failed') {
      lines.push({ t: a.finished_at, line: `attempt ${a.attempt_number} failed: ${a.error}` });
    } else if (a.outcome === 'superseded') {
      lines.push({
        t: a.finished_at,
        line: `attempt ${a.attempt_number} superseded (job cancelled)`,
      });
    }
  }

  if (job.state === 'dead')
    lines.push({ t: job.updated_at, line: 'exhausted retries · moved to dead' });
  if (job.state === 'cancelled') lines.push({ t: job.updated_at, line: 'cancelled by operator' });
  if (job.state === 'awaiting_retry' && job.next_check_at) {
    lines.push({ t: job.updated_at, line: `scheduled for retry at ${job.next_check_at}` });
  }

  return lines.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

function AttemptRow({ a }: { a: JobAttempt }) {
  const [open, setOpen] = useState(false);
  const long = !!a.error && a.error.length > ERROR_CLAMP;

  return (
    <tr>
      <td className="k-num text-muted">{a.attempt_number}</td>
      <td className="k-mono whitespace-nowrap">{a.worker_id}</td>
      <td>
        <Badge value={a.outcome} />
      </td>
      <td style={{ minWidth: 280 }}>
        <div
          style={{
            fontSize: '12.5px',
            color: a.error ? '#5c1a17' : '#b7b7ba',
            lineHeight: 1.45,
            fontFamily: a.error ? 'ui-monospace,Menlo,Consolas,monospace' : 'inherit',
            whiteSpace: open ? 'pre-wrap' : 'nowrap',
            overflow: open ? 'visible' : 'hidden',
            textOverflow: 'ellipsis',
            wordBreak: open ? 'break-word' : 'normal',
          }}
        >
          {a.error ?? EM_DASH}
        </div>
        {long && (
          <button
            type="button"
            className="btn btn-ghost p-0 text-[10.5px] tracking-[.06em]"
            onClick={() => setOpen(!open)}
          >
            {open ? 'collapse' : 'expand'}
          </button>
        )}
      </td>
      <td className="k-num text-dim" title={abs(a.started_at)}>
        {relShort(a.started_at)}
      </td>
      <td className="k-num text-dim" title={abs(a.finished_at)}>
        {a.finished_at ? relShort(a.finished_at) : 'running'}
      </td>
      <td className="k-num">
        {a.finished_at
          ? span(a.started_at, a.finished_at)
          : `${dur((Date.now() - Date.parse(a.started_at)) / 1000)}…`}
      </td>
    </tr>
  );
}

export function JobDetail() {
  const { jobId = '' } = useParams<{ jobId: string }>();
  const { retry, refresh } = useStatus();
  const job = useResource(`job:${jobId}`, () => getJob(jobId));
  const attempts = useResource(`job-attempts:${jobId}`, () => listAttempts(jobId));

  const [payloadOpen, setPayloadOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [attemptsFilter, setAttemptsFilter] = useState<'last5' | 'last10' | 'all'>('last5');
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (job.loading) return <LoadingPanel label="job" />;
  if (job.error) {
    return (
      <div>
        <Breadcrumb jobId={jobId} />
        <ErrorPanel error={job.error} onRetry={retry} />
      </div>
    );
  }
  if (!job.data) return null;

  const j = job.data;
  const all = (attempts.data?.attempts ?? [])
    .slice()
    .sort((a, b) => a.attempt_number - b.attempt_number);
  const shown = attemptsFilter === 'all' ? all : all.slice(attemptsFilter === 'last5' ? -5 : -10);

  const canCancel = CANCELLABLE_STATES.includes(j.state);
  const canRerun = j.state === 'dead';
  const payloadJson = JSON.stringify(j.payload, null, 2);

  // Both writes are version-guarded: the version we send is the one this page last read, so
  // a concurrent change anywhere else comes back as a 409 instead of silently winning.
  const write = async (kind: 'cancel' | 'rerun') => {
    setBusy(true);
    setActionError(null);
    setActionOk(null);
    try {
      const updated =
        kind === 'cancel' ? await cancelJob(j.id, j.version) : await rerunJob(j.id, j.version);
      setActionOk(
        kind === 'cancel'
          ? `Cancelled — state is now ${updated.state}`
          : `Requeued — state is now ${updated.state}`,
      );
    } catch (e) {
      setActionError(asApiError(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const copyPayload = () => {
    void navigator.clipboard?.writeText(payloadJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div>
      <Breadcrumb jobId={jobId} />

      <Blueprint className="mb-5.5 px-5 py-4">
        <div className="flex flex-wrap items-start gap-4.5">
          <div className="min-w-[260px] flex-1">
            <div className="mb-2.5 flex items-center gap-3">
              <Badge value={j.state} />
              <h1 className="m-0 text-[26px]">{j.name}</h1>
              <span className="text-[12.5px] text-muted">{j.queue}</span>
            </div>
            <div className="k-grid">
              <Field
                label="priority"
                value={`${j.priority} of 10`}
                title="1 is highest, 10 lowest"
              />
              <Field label="retry_count" value={`${j.retry_count} of ${j.max_retries}`} />
              <Field label="delivery_count" value={j.delivery_count} />
              <Field label="version" value={j.version} title="optimistic concurrency guard" />
              <Field
                label="next_check_at"
                value={
                  j.next_check_at
                    ? `in ${dur((Date.parse(j.next_check_at) - Date.now()) / 1000)}`
                    : EM_DASH
                }
                title={abs(j.next_check_at)}
              />
              <Field label="created_at" value={rel(j.created_at)} title={j.created_at} />
              <Field label="updated_at" value={rel(j.updated_at)} title={j.updated_at} />
            </div>
          </div>

          <div className="flex min-w-[210px] flex-col gap-2">
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!canCancel || busy}
                onClick={() => write('cancel')}
                title={
                  canCancel
                    ? `POST /v1/jobs/${j.id}/cancel with version ${j.version}`
                    : 'Cancel applies to pending, queued or awaiting_retry — the server is authoritative'
                }
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canRerun || busy}
                onClick={() => write('rerun')}
                title={
                  canRerun
                    ? `POST /v1/jobs/${j.id}/rerun with version ${j.version}`
                    : 'Rerun applies to dead jobs only — the server is authoritative'
                }
              >
                Rerun
              </button>
            </div>

            {actionError && (
              <div className="max-w-[280px] border border-bad-line bg-bad-bg px-2.5 py-2">
                <div className="k-label text-bad-ink">{actionError.label}</div>
                <div className="text-[12.5px] leading-snug text-bad-deep">
                  {actionError.message}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost mt-0.5 px-0 py-0.5 text-[11px]"
                  onClick={() => setActionError(null)}
                >
                  dismiss
                </button>
              </div>
            )}
            {actionOk && (
              <div className="max-w-[280px] border border-good-line bg-good-bg px-2.5 py-[7px] text-[12px] text-good-ink">
                {actionOk}
              </div>
            )}
          </div>
        </div>
      </Blueprint>

      <div className="flex flex-wrap items-start gap-6.5">
        <Blueprint className="min-w-[280px] flex-none basis-[320px] px-3.5 py-3">
          <div className="mb-2 flex items-center gap-2.5">
            <button
              type="button"
              className="btn btn-ghost px-0 py-0.5 text-[11px] uppercase tracking-[.12em]"
              onClick={() => setPayloadOpen(!payloadOpen)}
            >
              {payloadOpen ? '▾ payload' : '▸ payload'}
            </button>
            <button
              type="button"
              className="btn btn-secondary ml-auto min-h-[26px] px-[9px] py-0.5 text-[11px]"
              onClick={copyPayload}
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          {payloadOpen && (
            <pre className="k-mono m-0 max-h-[340px] overflow-auto border border-[var(--color-divider)] bg-panel p-2.5 text-[12px] leading-relaxed">
              {payloadJson}
            </pre>
          )}
        </Blueprint>

        <div className="min-w-[620px] flex-1 basis-[620px]">
          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 className="m-0 text-[19px]">Logs</h2>
            <span className="text-[11px] text-muted">
              lifecycle + attempt history for this job, oldest first — derived client-side
            </span>
          </div>
          <div className="mb-5.5">
            <LogStream lines={timeline(j, all).reverse()} emptyLabel="nothing recorded yet" />
          </div>

          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 className="m-0 text-[19px]">Attempts</h2>
            <span className="text-[11px] text-muted">
              {shown.length} of {all.length} {all.length === 1 ? 'attempt' : 'attempts'} shown ·
              ordered by attempt_number asc
            </span>
            <select
              className="input ml-auto min-h-[28px] w-[150px] text-[12.5px]"
              value={attemptsFilter}
              onChange={(e) => setAttemptsFilter(e.target.value as typeof attemptsFilter)}
            >
              <option value="last5">last 5 attempts</option>
              <option value="last10">last 10 attempts</option>
              <option value="all">all attempts</option>
            </select>
          </div>

          {attempts.error && <ErrorPanel error={attempts.error} onRetry={retry} />}
          {attempts.ready && all.length === 0 && (
            <Blueprint className="p-6 text-center text-[12.5px] text-muted">
              No attempts yet — the job has not been delivered to a worker.
            </Blueprint>
          )}
          {all.length > 0 && (
            <Blueprint style={{ padding: 0 }}>
              <div className="max-h-[520px] overflow-auto">
                <table className="k-t">
                  <thead>
                    <tr>
                      <th className="k-num" style={{ width: 34 }}>
                        #
                      </th>
                      <th style={{ width: 80 }}>worker</th>
                      <th style={{ width: 96 }}>outcome</th>
                      <th style={{ minWidth: 280 }}>error</th>
                      <th className="k-num" style={{ width: 80 }}>
                        started
                      </th>
                      <th className="k-num" style={{ width: 80 }}>
                        finished
                      </th>
                      <th className="k-num" style={{ width: 74 }}>
                        duration
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((a) => (
                      <AttemptRow key={a.id} a={a} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Blueprint>
          )}
        </div>
      </div>
    </div>
  );
}

function Breadcrumb({ jobId }: { jobId: string }) {
  return (
    <div className="mb-2.5 text-[11.5px] text-muted">
      <Link to="/jobs" className="no-underline">
        ← Jobs
      </Link>
      <span className="mx-2">/</span>
      <span className="k-mono">{jobId}</span>
    </div>
  );
}
