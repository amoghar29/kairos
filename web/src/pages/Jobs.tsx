import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listAttempts, listJobs } from '../api/client';
import type { Job, JobAttempt, JobState } from '../api/types';
import { JOB_STATES } from '../api/types';
import { QUEUES, ROWS_PER_PAGE } from '../config';
import { Badge } from '../components/Badge';
import { Blueprint } from '../components/Blueprint';
import { EmptyPanel, ErrorPanel, LoadingPanel } from '../components/Panels';
import { priorityStyle, retryStyle } from '../lib/badge';
import { EM_DASH, relShort, shortId, span } from '../lib/format';
import { jobsHref, useJobsFilter, type JobsFilter } from '../lib/route';
import { useResource, useStatus } from '../lib/resource';

type SortKey = 'id' | 'name' | 'queue' | 'priority' | 'retry_count' | 'created_at' | 'updated_at';

function StateChips({ active, onToggle }: { active: JobState[]; onToggle: (s: JobState) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {JOB_STATES.map((state) => {
        const on = active.includes(state);
        return (
          <button
            key={state}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(state)}
            className="font-cond cursor-pointer px-[9px] py-1 text-[11.5px] font-semibold uppercase tracking-[.04em]"
            style={{
              background: on ? 'var(--color-accent)' : 'transparent',
              color: on ? '#f2f2f3' : '#5d5d60',
              border: `1px solid ${on ? 'var(--color-accent-700)' : 'var(--color-divider)'}`,
            }}
          >
            {state}
          </button>
        );
      })}
    </div>
  );
}

function AttemptsInline({ jobId }: { jobId: string }) {
  const navigate = useNavigate();
  const res = useResource(`attempts:${jobId}`, () => listAttempts(jobId));

  if (res.loading) return <div className="text-[11.5px] text-muted">loading attempts…</div>;
  if (res.error) return <div className="text-[11.5px] text-bad-ink">{res.error.message}</div>;

  const attempts = res.data?.attempts ?? [];
  if (attempts.length === 0) {
    return <div className="text-[11.5px] text-muted">No attempts yet — not delivered to a worker.</div>;
  }

  return (
    <>
      <table className="k-t bg-transparent">
        <thead>
          <tr>
            <th className="k-num" style={{ width: 34 }}>
              #
            </th>
            <th style={{ width: 80 }}>worker</th>
            <th style={{ width: 96 }}>outcome</th>
            <th>error</th>
            <th className="k-num" style={{ width: 80 }}>
              started
            </th>
            <th className="k-num" style={{ width: 70 }}>
              duration
            </th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a: JobAttempt) => (
            <tr key={a.id} className="k-click" onClick={() => navigate(`/jobs/${jobId}`)} title="Open full job detail">
              <td className="k-num text-muted">{a.attempt_number}</td>
              <td className="k-mono whitespace-nowrap">{a.worker_id}</td>
              <td>
                <Badge value={a.outcome} />
              </td>
              <td className="max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-bad-deep">
                {a.error ?? EM_DASH}
              </td>
              <td className="k-num text-dim">{relShort(a.started_at)}</td>
              <td className="k-num">{a.finished_at ? span(a.started_at, a.finished_at) : 'running…'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1.5">
        <Link to={`/jobs/${jobId}`} className="text-[11.5px] no-underline">
          open full job detail →
        </Link>
      </div>
    </>
  );
}

export function Jobs() {
  const navigate = useNavigate();
  const route = useJobsFilter();
  const { retry } = useStatus();
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const query = {
    states: route.states,
    queue: route.queue,
    limit: ROWS_PER_PAGE,
    offset: route.offset,
  };
  const key = `jobs:${route.states.join(',')}|${route.queue}|${route.offset}`;
  const res = useResource(key, () => listJobs(query));

  const setFilters = (next: Partial<Pick<JobsFilter, 'states' | 'queue'>>) => {
    navigate(jobsHref({ states: next.states ?? route.states, queue: next.queue ?? route.queue, offset: 0 }));
  };

  const toggleState = (s: JobState) => {
    const states = route.states.includes(s) ? route.states.filter((x) => x !== s) : [...route.states, s];
    setFilters({ states });
  };

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir('asc');
    }
  };
  const arrow = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const needle = search.trim().toLowerCase();
  const fetched = res.data?.jobs ?? [];
  let rows = fetched.filter(
    (j) => !needle || j.name.toLowerCase().includes(needle) || j.id.toLowerCase().includes(needle),
  );
  if (sortKey) {
    const dir = sortDir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const av = sortKey === 'created_at' || sortKey === 'updated_at' ? Date.parse(a[sortKey]) : a[sortKey];
      const bv = sortKey === 'created_at' || sortKey === 'updated_at' ? Date.parse(b[sortKey]) : b[sortKey];
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  const page = res.data?.pagination;
  const urlQuery = jobsHref({ states: route.states, queue: route.queue, offset: route.offset }).split('?')[1] ?? '';
  const summary = [
    route.states.length ? `${route.states.length} of ${JOB_STATES.length} states` : 'all states',
    route.queue ? `queue ${route.queue}` : 'all queues',
    ...(search ? [`search "${search}"`] : []),
  ].join(' · ');

  const clearFilters = () => {
    setSearch('');
    setSortKey(null);
    navigate('/jobs');
  };

  return (
    <div>
      <div className="k-title-row">
        <h1>Jobs</h1>
        <span className="k-endpoint">
          GET /v1/jobs?limit={ROWS_PER_PAGE}&amp;offset={route.offset}
        </span>
      </div>

      {res.data?.filteredWithinPage && (
        <div className="k-caveat">
          <b>state / queue narrowing is client-side</b> — <code>GET /v1/jobs</code> takes only{' '}
          <code>limit</code> and <code>offset</code> today, so the filter applies to this page of{' '}
          {ROWS_PER_PAGE} rows, not the whole store. Counts and paging reflect the unfiltered
          result set. See changes_req.md.
        </div>
      )}

      <Blueprint className="mb-5 flex flex-wrap items-end gap-4.5 px-3.5 py-3">
        <div>
          <div className="k-kicker mb-1.5">state · multi</div>
          <StateChips active={route.states} onToggle={toggleState} />
        </div>
        <div>
          <div className="k-kicker mb-1.5">queue · single</div>
          <select
            className="input min-h-[30px] w-[170px] text-[13px]"
            value={route.queue}
            onChange={(e) => setFilters({ queue: e.target.value })}
          >
            <option value="">all queues</option>
            {QUEUES.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="k-kicker mb-1.5">search · id or name</div>
          <input
            className="input min-h-[30px] w-[190px] text-[13px]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="send_email or 0e04…"
          />
        </div>
        <button type="button" className="btn btn-secondary min-h-[30px] px-3 py-1" onClick={clearFilters}>
          Clear filters
        </button>
        <div className="ml-auto text-right text-[11px] leading-relaxed text-muted">
          <div>{summary}</div>
          <div className="k-mono text-[10.5px]">?{urlQuery}</div>
        </div>
      </Blueprint>

      {res.loading && <LoadingPanel label="/v1/jobs" />}
      {res.error && <ErrorPanel error={res.error} onRetry={retry} />}

      {res.ready && rows.length === 0 && (
        <EmptyPanel
          title={
            needle && fetched.length > 0
              ? `No jobs on this page match "${search}"`
              : `No jobs match ${route.states.length ? route.states.join(' or ') : 'any state'}${
                  route.queue ? ` in ${route.queue}` : ' in any queue'
                }`
          }
          detail={
            needle && fetched.length > 0
              ? 'Search filters within the currently loaded page only — clear it or check another page.'
              : route.offset > 0
                ? `This page is past the end of the result set — offset ${route.offset} with limit ${ROWS_PER_PAGE}. Rows may have moved under concurrent inserts; step back a page.`
                : `Filters active: ${summary}. Nothing in the store matches that combination right now.`
          }
          action={
            <button type="button" className="btn btn-secondary" onClick={clearFilters}>
              Clear filters
            </button>
          }
        />
      )}

      {res.ready && rows.length > 0 && (
        <div>
          <Blueprint style={{ padding: 0 }}>
            <table className="k-t">
              <thead>
                <tr>
                  <th style={{ width: 26 }} />
                  <th className="cursor-pointer" style={{ width: 130 }} onClick={() => toggleSort('id')}>
                    id{arrow('id')}
                  </th>
                  <th className="cursor-pointer" onClick={() => toggleSort('name')}>
                    name{arrow('name')}
                  </th>
                  <th className="cursor-pointer" onClick={() => toggleSort('queue')}>
                    queue{arrow('queue')}
                  </th>
                  <th style={{ width: 120 }}>state</th>
                  <th
                    className="k-num cursor-pointer"
                    title="1 is highest, 10 lowest"
                    onClick={() => toggleSort('priority')}
                  >
                    prio{arrow('priority')}
                  </th>
                  <th className="k-num cursor-pointer" onClick={() => toggleSort('retry_count')}>
                    retry{arrow('retry_count')}
                  </th>
                  <th className="k-num">deliv</th>
                  <th className="k-num cursor-pointer" onClick={() => toggleSort('created_at')}>
                    created{arrow('created_at')}
                  </th>
                  <th className="k-num cursor-pointer" onClick={() => toggleSort('updated_at')}>
                    updated{arrow('updated_at')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((j: Job) => {
                  const open = !!expanded[j.id];
                  return (
                    <Fragment key={j.id}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost h-5 min-h-0 w-5 p-0 text-[11px]"
                            title="Show attempts"
                            onClick={() => setExpanded({ ...expanded, [j.id]: !open })}
                          >
                            {open ? '▾' : '▸'}
                          </button>
                        </td>
                        <td>
                          <Link to={`/jobs/${j.id}`} className="k-mono no-underline">
                            {shortId(j.id)}
                          </Link>
                        </td>
                        <td className="font-cond text-[14.5px] font-semibold">{j.name}</td>
                        <td className="text-dim">{j.queue}</td>
                        <td>
                          <Badge value={j.state} />
                        </td>
                        <td className="k-num" style={priorityStyle(j.priority)} title="1 is highest, 10 lowest">
                          {j.priority}
                        </td>
                        <td className="k-num" style={retryStyle(j.retry_count)}>
                          {j.retry_count}
                        </td>
                        <td className="k-num text-muted">{j.delivery_count}</td>
                        <td className="k-num text-dim" title={j.created_at}>
                          {relShort(j.created_at)}
                        </td>
                        <td className="k-num text-dim" title={j.updated_at}>
                          {relShort(j.updated_at)}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10} className="bg-panel py-2.5 pl-10 pr-3.5">
                            <div className="k-kicker mb-1.5">
                              attempts for {shortId(j.id)} — click a row for full detail
                            </div>
                            <AttemptsInline jobId={j.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Blueprint>

          <div className="mt-3.5 flex items-center gap-3.5 text-[12px] text-dim">
            <button
              type="button"
              className="btn btn-secondary min-h-[30px] px-3 py-1"
              disabled={route.offset === 0}
              onClick={() =>
                navigate(
                  jobsHref({
                    states: route.states,
                    queue: route.queue,
                    offset: Math.max(0, route.offset - ROWS_PER_PAGE),
                  }),
                )
              }
            >
              ← Prev
            </button>
            <button
              type="button"
              className="btn btn-secondary min-h-[30px] px-3 py-1"
              disabled={!page?.has_more}
              onClick={() =>
                navigate(
                  jobsHref({
                    states: route.states,
                    queue: route.queue,
                    offset: route.offset + ROWS_PER_PAGE,
                  }),
                )
              }
            >
              Next →
            </button>
            {page && (
              <span className="k-mono text-[11.5px]">
                rows {page.offset + 1}–{page.offset + fetched.length}
                {page.has_more ? ' · more available' : ' · end of results'}
              </span>
            )}
            <span className="text-[11px] text-faint">
              offset pagination — rows can shift between pages under concurrent inserts
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
