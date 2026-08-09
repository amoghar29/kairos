import { useRef, useState } from 'react';

import { Link } from 'react-router-dom';

import { Blueprint } from '@/components/Blueprint';
import { QUEUES } from '@/constants';
import { createJob } from '@/services';
import { type ApiError, asApiError } from '@/services/api';

const DEFAULT_PAYLOAD = '{\n  "to": "a@b.com",\n  "template": "welcome"\n}';

// Keyed on the exact fields that go in the request body: while they're unchanged, repeat
// clicks of "Submit job" replay the same key instead of minting a new job every time.
function idempotencySignature(fields: {
  name: string;
  queue: string;
  payload: string;
  priority: string;
  maxRetries: string;
}): string {
  return JSON.stringify(fields);
}

export function Submit() {
  const [name, setName] = useState('send_email');
  const [queue, setQueue] = useState(QUEUES[0] ?? '');
  const [priority, setPriority] = useState('5');
  const [maxRetries, setMaxRetries] = useState('3');
  const [payload, setPayload] = useState(DEFAULT_PAYLOAD);

  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<{ id: string; created: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const idemRef = useRef<{ key: string; signature: string } | null>(null);

  const parsePayload = (): unknown | undefined => {
    try {
      return JSON.parse(payload);
    } catch {
      return undefined;
    }
  };

  const signature = idempotencySignature({ name, queue, payload, priority, maxRetries });
  const reusableKey = idemRef.current?.signature === signature ? idemRef.current.key : null;

  const body = {
    name,
    queue,
    payload: parsePayload() ?? null,
    priority: Number(priority),
    max_retries: Number(maxRetries),
    idempotency_key: reusableKey ?? '<generated on submit>',
  };

  // The real endpoint takes idempotency_key in the body, not as a header — the preview shows
  // exactly what goes on the wire so it can be replayed with curl.
  const preview = [
    'POST /v1/jobs',
    'Content-Type: application/json',
    '',
    JSON.stringify(body, null, 2),
  ].join('\n');

  const formatPayload = () => {
    try {
      setPayload(JSON.stringify(JSON.parse(payload), null, 2));
      setPayloadError(null);
    } catch (e) {
      setPayloadError(`invalid JSON — ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const submit = async () => {
    const parsed = parsePayload();
    if (parsed === undefined) {
      setPayloadError('invalid JSON — fix the payload before submitting');
      setSubmitError(null);
      setResult(null);
      return;
    }

    setPayloadError(null);
    setSubmitError(null);
    setResult(null);
    setBusy(true);
    try {
      const idempotency_key = reusableKey ?? crypto.randomUUID();
      idemRef.current = { key: idempotency_key, signature };
      const { job, created } = await createJob({
        name,
        queue,
        payload: parsed,
        priority: Number(priority),
        max_retries: Number(maxRetries),
        idempotency_key,
      });
      setResult({ id: job.id, created });
    } catch (e) {
      setSubmitError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="k-title-row">
        <h1>Submit job</h1>
        <span className="k-endpoint">POST /v1/jobs</span>
      </div>

      <div className="grid max-w-[1080px] items-start gap-7.5 lg:grid-cols-[minmax(320px,440px)_minmax(280px,1fr)]">
        <Blueprint className="px-4.5 py-4">
          <div className="flex flex-col gap-3.5">
            <div className="field">
              <label htmlFor="job-name">name</label>
              <input
                id="job-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="send_email"
              />
            </div>

            <div className="field">
              <label htmlFor="job-queue">queue — closed set, declared in consumer.yaml</label>
              <select
                id="job-queue"
                className="input"
                value={queue}
                onChange={(e) => setQueue(e.target.value)}
              >
                {QUEUES.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-3.5">
              <div className="field flex-1">
                <label htmlFor="job-priority">priority — 1 highest, 10 lowest</label>
                <input
                  id="job-priority"
                  className="input"
                  type="number"
                  min={1}
                  max={10}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />
              </div>
              <div className="field flex-1">
                <label htmlFor="job-max-retries">max_retries — 0 to 25</label>
                <input
                  id="job-max-retries"
                  className="input"
                  type="number"
                  min={0}
                  max={25}
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(e.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="job-payload">payload · JSON</label>
              <textarea
                id="job-payload"
                className="input k-mono min-h-[150px] text-[12.5px]"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
              />
              {payloadError && (
                <div className="mt-1.5 text-[11.5px] text-bad-ink">{payloadError}</div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
                {busy ? 'submitting…' : 'Submit job'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={formatPayload}>
                format JSON
              </button>
            </div>

            {submitError && (
              <div className="border border-bad-line bg-bad-bg px-2.5 py-2">
                <div className="k-label text-bad-ink">{submitError.label}</div>
                <div className="text-[12.5px] text-bad-deep">{submitError.message}</div>
                {submitError.fields && (
                  <ul className="mt-1 list-none space-y-0.5 p-0 text-[12px] text-bad-deep">
                    {Object.entries(submitError.fields).map(([field, detail]) => (
                      <li key={field}>
                        <span className="k-mono">{field}</span> — {detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {result && (
              <div className="border border-good-line bg-good-bg px-3 py-2.5">
                <div className="k-label text-good-ink">
                  {result.created
                    ? '201 created · state pending'
                    : '200 ok · idempotency key replayed an existing job'}
                </div>
                <Link to={`/jobs/${result.id}`} className="k-mono text-[12.5px]">
                  {result.id} →
                </Link>
              </div>
            )}
          </div>
        </Blueprint>

        <Blueprint className="px-4 py-3.5">
          <div className="k-kicker mb-2">request preview</div>
          <pre className="k-mono m-0 overflow-auto border border-[var(--color-divider)] bg-panel p-3 text-[12px] leading-relaxed">
            {preview}
          </pre>
        </Blueprint>
      </div>
    </div>
  );
}
