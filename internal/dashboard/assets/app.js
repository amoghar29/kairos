class Component extends DCLogic {
  STATES = ['pending', 'queued', 'running', 'awaiting_retry', 'paused', 'success', 'dead', 'cancelled', 'expired'];
  CRON_PRESETS = [
    { expr: '*/5 * * * *', label: 'every 5 minutes' },
    { expr: '*/1 * * * *', label: 'every minute' },
    { expr: '0 * * * *', label: 'hourly, on the hour' },
    { expr: '0 9 * * *', label: 'daily at 09:00 UTC' },
    { expr: '0 3 * * 0', label: 'weekly, Sunday 03:00 UTC' },
    { expr: '0 0 1 * *', label: 'monthly, 1st at 00:00 UTC' }
  ];
  cronHuman(expr) {
    const p = this.CRON_PRESETS.filter(x => x.expr === expr)[0];
    return p ? p.label : 'custom expression';
  }
  cronFields(expr) {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length !== 5) throw new Error('expected 5 fields (minute hour dom month dow), got ' + parts.length);
    const spec = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    return parts.map((raw, idx) => {
      const lo = spec[idx][0], hi = spec[idx][1];
      const set = {};
      raw.split(',').forEach(tok => {
        let step = 1, range = tok;
        const sl = tok.split('/');
        if (sl.length === 2) { range = sl[0]; step = parseInt(sl[1], 10); if (!(step >= 1)) throw new Error('bad step in "' + tok + '"'); }
        else if (sl.length > 2) throw new Error('bad token "' + tok + '"');
        let a, b;
        if (range === '*') { a = lo; b = hi; }
        else {
          const dash = range.split('-');
          a = parseInt(dash[0], 10);
          b = dash.length === 2 ? parseInt(dash[1], 10) : a;
          if (dash.length > 2 || isNaN(a) || isNaN(b)) throw new Error('bad range "' + tok + '"');
        }
        if (a < lo || b > hi || b < a) throw new Error('"' + tok + '" out of range ' + lo + '-' + hi);
        for (let n = a; n <= b; n += step) set[n] = true;
      });
      return set;
    });
  }
  dueLabel(ts) {
    if (!ts) return 'not armed';
    const d = (Date.parse(ts) - Date.now()) / 1000;
    if (d <= 0) return d > -60 ? 'due now' : 'overdue ' + this.dur(-d);
    return 'in ' + this.dur(d);
  }
  cronValidate(expr) { try { this.cronFields(expr); return null; } catch (e) { return e.message; } }
  cronNextRun(expr, after, startsAt, endsAt) {
    let fields;
    try { fields = this.cronFields(expr); } catch (e) { return { ok: false, err: e.message }; }
    const mins = fields[0], hrs = fields[1], doms = fields[2], mons = fields[3], dows = fields[4];
    const t = Math.max(after || Date.now(), startsAt ? Date.parse(startsAt) : 0);
    const d = new Date(t);
    d.setUTCSeconds(0, 0);
    d.setUTCMinutes(d.getUTCMinutes() + 1);
    const limit = d.getTime() + 366 * 86400000;
    while (d.getTime() <= limit) {
      if (!mons[d.getUTCMonth() + 1]) { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0, 0, 0); continue; }
      if (!doms[d.getUTCDate()] || !dows[d.getUTCDay()]) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0, 0, 0); continue; }
      if (!hrs[d.getUTCHours()]) { d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0); continue; }
      if (!mins[d.getUTCMinutes()]) { d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0); continue; }
      const ms = d.getTime();
      if (endsAt && ms >= Date.parse(endsAt)) return { ok: false };
      return { ok: true, t: new Date(ms).toISOString() };
    }
    return { ok: false, err: 'expression never fires' };
  }
  cronPreview(expr, startsAt, endsAt, n) {
    const out = [];
    let cursor = Date.now();
    for (let i = 0; i < (n || 3); i++) {
      const res = this.cronNextRun(expr, cursor, startsAt, endsAt);
      if (!res.ok) break;
      out.push(res.t);
      cursor = Date.parse(res.t);
    }
    return out;
  }
  workerName(id) { const w = (this.state.workers || []).filter(x => x.id === id)[0]; return w ? w.name : id; }

  // Live worker activity is whatever the registry reports in flight right now. Finished
  // attempts are not derivable client-side without an attempts fetch per job, so the pane
  // shows current work only.
  workerActivity(workerId) {
    const w = (this.state.workers || []).filter(x => x.id === workerId)[0];
    if (!w || !w.in_flight_jobs) return [];
    return w.in_flight_jobs.map(j => ({
      job_id: j.id, job_name: j.name, queue: j.queue,
      outcome: 'in_progress', started_at: j.started_at, finished_at: null
    })).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  }
  // jobs.handler is a plain text column — no registry table, so the handler list is
  // an aggregation over job rows plus their attempts.
  state = {
    url: typeof location !== 'undefined' ? (location.pathname + location.search) : '/',
    tick: 0,
    queues: null, queuesErr: null, queuesCode: null, queuesDone: false,
    odead: null,
    theme: 'light',
    workers: null, workersErr: null, workersCode: null, workersDone: false,
    jobs: null, pagination: null, jobsErr: null, jobsCode: null, jobsDone: false,
    detail: null, detailErr: null, detailCode: null, detailDone: false,
    handlers: null, handlersErr: null, handlersCode: null, handlersDone: false,
    hdetail: null, hdetailErr: null, hdetailCode: null, hdetailDone: false,
    hSortKey: 'dead', hSortDir: 'desc',
    workerExpanded: {},
    schedules: null, schedErr: null, schedCode: null, schedDone: false,
    schedOpen: false, schedBusy: false,
    schedForm: { cron: '*/5 * * * *', preset: '*/5 * * * *', startsAt: '', endsAt: '' },
    payloadOpen: true, copied: false, expanded: {}, attemptsFilter: 'last5',
    search: '', sortKey: null, sortDir: 'asc', rowExpanded: {}, rowAttempts: {},
    detailTab: 'payload',
    actionErr: null, actionCode: null, actionOk: null,
    lastUpdated: null, connLost: false, hidden: false,
    form: { mode: 'once', cron: '*/5 * * * *', startsAt: '', endsAt: '', name: 'send_email', handler: 'email.send', queue: 'default', priority: 5, payload: '{\n  "to": "a@b.com",\n  "template": "welcome"\n}' },
    payloadError: null, submitErr: null, submitCode: null, submitting: false, createdId: null
  };

  // ── API layer — one line per endpoint ─────────────────────────────────
  API_BASE = '/api/v1';
  err(code, message, status) { const e = new Error(message); e.code = code; e.status = status || 500; return e; }
  async api(path, opts) {
    const res = await fetch(this.API_BASE + path, opts);       // same-origin, relative
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // The server returns the error flat: { message, code, fields? }
      const env = body && body.code ? body : { code: 'unknown', message: 'request failed' };
      throw this.err(env.code, env.message, res.status);
    }
    return body;
  }
  getQueues() { return this.api('/queues'); }
  getWorkers() { return this.api('/workers'); }
  getHandlers() { return this.api('/handlers'); }
  getHandler(name) { return this.api('/handlers/' + encodeURIComponent(name)); }
  getJobs(qs) { return this.api('/jobs?' + qs); }
  // The server keeps the job and its attempts on separate endpoints, so the detail view
  // composes them here. attempt_no is positional (attempts come back started_at ascending)
  // and the server calls the failure text `result`.
  async getJob(id) {
    const [job, at] = await Promise.all([
      this.api('/jobs/' + id),
      this.api('/jobs/' + id + '/attempts')
    ]);
    return {
      job: job,
      attempts: (at.attempts || []).map((a, i) => Object.assign({}, a, {
        attempt_no: i + 1, error: a.result
      }))
    };
  }
  // Every mutation sends the version the client last saw. The server enforces it, so a stale
  // tab gets a 409 instead of silently clobbering a concurrent change.
  postJSON(path, body) {
    return this.api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
  postCancel(id, version) { return this.postJSON('/jobs/' + id + '/cancel', { version: version }); }
  postRerun(id, version) { return this.postJSON('/jobs/' + id + '/rerun', { version: version }); }
  // One endpoint carries both directions; there is no /resume route.
  pauseCall(id, paused, version) { return this.postJSON('/jobs/' + id + '/pause', { paused: paused, version: version }); }
  postPause(id, version) { return this.pauseCall(id, true, version); }
  postResume(id, version) { return this.pauseCall(id, false, version); }
  postSchedule(id, body) { return this.api('/jobs/' + id + '/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  postJob(body) {
    return this.postJSON('/jobs', body);
  }

  polls = 0;
  route() {
    const h = this.state.url || '/';
    const bits = h.split('?');
    const params = new URLSearchParams(bits[1] || '');
    const dm = bits[0].match(/^\/jobs\/(.+)$/);
    const wm = bits[0].match(/^\/workers\/(.+)$/);
    const hm = bits[0].match(/^\/handlers\/(.+)$/);
    return {
      path: bits[0], detailId: dm ? dm[1] : null, workerId: wm ? wm[1] : null,
      handlerId: hm ? decodeURIComponent(hm[1]) : null,
      states: params.getAll('state'), queue: params.get('queue') || '',
      handler: params.get('handler') || '', q: params.get('q') || '', jobType: params.get('job_type') || '',
      offset: parseInt(params.get('offset') || '0', 10)
    };
  }
  limit() { return this.props.rowsPerPage || 25; }
  jobsQuery(r) {
    const qp = new URLSearchParams();
    r.states.forEach(s => qp.append('state', s));
    if (r.queue) qp.set('queue', r.queue);
    if (r.handler) qp.set('handler', r.handler);
    if (r.q) qp.set('q', r.q);
    if (r.jobType) qp.set('job_type', r.jobType);
    qp.set('limit', String(this.limit()));
    qp.set('offset', String(r.offset));
    return qp.toString();
  }
  urlFor(r) {
    const qp = new URLSearchParams();
    r.states.forEach(s => qp.append('state', s));
    if (r.queue) qp.set('queue', r.queue);
    if (r.handler) qp.set('handler', r.handler);
    if (r.q) qp.set('q', r.q);
    if (r.jobType) qp.set('job_type', r.jobType);
    if (r.offset) qp.set('offset', String(r.offset));
    const q = qp.toString();
    return '/jobs' + (q ? '?' + q : '');
  }
  // Real paths via the History API — the Go handler falls back to index.html for any
  // extension-less path, so a cold load or refresh on /jobs/<id> resolves.
  go(h) {
    if (h === location.pathname + location.search) return;
    history.pushState(null, '', h);
    this.onNav();
  }

  // ── loading ───────────────────────────────────────────────────────────
  fail(key, e) {
    const has = this.state[key] !== null && this.state[key] !== undefined;
    if (has) this.setState({ connLost: true });
    else { const p = {}; p[key + 'Err'] = e.message; p[key + 'Code'] = e.code; p[key + 'Done'] = true; this.setState(p); }
  }
  ok(patch) { this.setState(Object.assign({ lastUpdated: Date.now(), connLost: false }, patch)); }
  async load(force) {
    const r = this.route();
    if (r.path === '/') {
      try { const d = await this.getQueues(); this.ok({ queues: d, queuesErr: null, queuesDone: true }); } catch (e) { this.fail('queues', e); }
      try { const d = await this.getWorkers(); this.ok({ workers: d.workers, workersErr: null, workersDone: true }); } catch (e) { this.fail('workers', e); }
      try { const d = await this.getJobs('state=dead&limit=6&offset=0'); this.ok({ odead: d.jobs }); } catch (e) { /* tiles degrade */ }
      try { const d = await this.getJobs('job_type=cron&limit=100&offset=0'); this.ok({ schedules: d.jobs }); } catch (e) { /* tiles degrade */ }
    } else if (r.path === '/jobs') {
      try { const d = await this.getJobs(this.jobsQuery(r)); this.ok({ jobs: d.jobs, pagination: d.pagination, jobsErr: null, jobsDone: true }); } catch (e) { this.fail('jobs', e); }
      // Only to populate the queue and handler filter pickers — a failure here must not
      // blank the table, so it degrades to "all queues" / "all handlers" instead.
      try { const d = await this.getQueues(); this.ok({ queues: d }); } catch (e) { /* pickers degrade */ }
      try { const d = await this.getHandlers(); this.ok({ handlers: d.handlers }); } catch (e) { /* pickers degrade */ }
    } else if (r.path === '/submit') {
      try {
        const d = await this.getQueues();
        this.ok({ queues: d });
        // The form's seeded queue is a guess; snap it to a real one so an untouched form
        // submits instead of 422ing on an unknown queue.
        const names = d.map(q => q.queue);
        if (names.length && names.indexOf(this.state.form.queue) === -1) this.setForm('queue', names[0]);
      } catch (e) { /* pickers degrade */ }
      try { const d = await this.getHandlers(); this.ok({ handlers: d.handlers }); } catch (e) { /* pickers degrade */ }
    } else if (r.detailId) {
      try { const d = await this.getJob(r.detailId); this.ok({ detail: d, detailErr: null, detailDone: true }); } catch (e) { this.fail('detail', e); }
    } else if (r.handlerId) {
      try { const d = await this.getHandler(r.handlerId); this.ok({ hdetail: d, hdetailErr: null, hdetailDone: true }); } catch (e) { this.fail('hdetail', e); }
    } else if (r.path === '/schedules') {
      try { const d = await this.getJobs('job_type=cron&limit=100&offset=0'); this.ok({ schedules: d.jobs, schedErr: null, schedDone: true }); } catch (e) { this.fail('sched', e); }
    } else if (r.path === '/handlers') {
      try { const d = await this.getHandlers(); this.ok({ handlers: d.handlers, handlersErr: null, handlersDone: true }); } catch (e) { this.fail('handlers', e); }
    } else if (r.path === '/queues') {
      try { const d = await this.getQueues(); this.ok({ queues: d, queuesErr: null, queuesDone: true }); } catch (e) { this.fail('queues', e); }
      try { const d = await this.getWorkers(); this.ok({ workers: d.workers, workersErr: null, workersDone: true }); } catch (e) { this.fail('workers', e); }
    } else if (r.path === '/workers' || r.workerId) {
      try { const d = await this.getWorkers(); this.ok({ workers: d.workers, workersErr: null, workersDone: true }); } catch (e) { this.fail('workers', e); }
    }
    if (force) this.setState({ tick: this.state.tick + 1 });
  }
  componentDidMount() {
    let t = 'light';
    try { t = localStorage.getItem('kairos-theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (e) {}
    this.state.theme = t;
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', t);
    this.onNav = () => {
      this.setState({
        url: location.pathname + location.search, jobs: null, jobsErr: null, jobsDone: false,
        detail: null, detailErr: null, detailDone: false, actionErr: null, actionOk: null,
        hdetail: null, hdetailErr: null, hdetailDone: false, handlersDone: false, schedDone: false, schedOpen: false, schedBusy: false,
        queuesDone: false, queues: this.state.queues, expanded: {}, attemptsFilter: 'last5',
        search: new URLSearchParams(location.search).get('q') || '',
        workerExpanded: {},
    schedules: null, schedErr: null, schedCode: null, schedDone: false,
    schedOpen: false, schedBusy: false,
    schedForm: { cron: '*/5 * * * *', preset: '*/5 * * * *', startsAt: '', endsAt: '' },
        sortKey: null, sortDir: 'asc', rowExpanded: {}, rowAttempts: {}, detailTab: 'payload'
      }, () => this.load());
    };
    window.addEventListener('popstate', this.onNav);
    // Same-origin links route in-app; modified clicks and new-tab intents fall through
    // to the browser so middle-click and ctrl-click still open a real tab.
    this.onLinkClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || a.target === '_blank') return;
      const href = a.getAttribute('href');
      if (!href || href.charAt(0) !== '/') return;
      e.preventDefault();
      this.go(href);
    };
    document.addEventListener('click', this.onLinkClick);
    this.onVis = () => this.setState({ hidden: document.hidden });
    document.addEventListener('visibilitychange', this.onVis);
    this.onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf((e.target.tagName || '')) !== -1) return;
      const now = Date.now();
      if (e.key === 'g') { this.gAt = now; return; }
      if (this.gAt && now - this.gAt < 900) {
        this.gAt = 0;
        if (e.key === 'o') return this.go('/');
        if (e.key === 'q') return this.go('/queues');
        if (e.key === 'j') return this.go('/jobs');
        if (e.key === 'c') return this.go('/schedules');
        if (e.key === 'd') return this.go('/docs');
        if (e.key === 'h') return this.go('/handlers');
        if (e.key === 'w') return this.go('/workers');
        if (e.key === 's') return this.go('/submit');
        return;
      }
      if (e.key === 'r') this.load(true);
      if (e.key === 'j') this.stepPage(1);
      if (e.key === 'k') this.stepPage(-1);
    };
    window.addEventListener('keydown', this.onKey);
    this.load();
    this.poll = setInterval(() => {
      if (document.hidden) return;                    // single shared 3s interval, paused when hidden
      this.polls += 1;
      this.load();
    }, (this.props.pollSeconds || 3) * 1000);
    this.ticker = setInterval(() => this.setState({ tick: this.state.tick + 1 }), 1000);
  }
  componentWillUnmount() {
    clearInterval(this.poll); clearInterval(this.ticker);
    window.removeEventListener('popstate', this.onNav);
    document.removeEventListener('click', this.onLinkClick);
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('visibilitychange', this.onVis);
  }

  // ── formatting ────────────────────────────────────────────────────────
  dur(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
  }
  rel(iso) { if (!iso) return '—'; return this.dur((Date.now() - Date.parse(iso)) / 1000) + ' ago'; }
  relShort(iso) { if (!iso) return '—'; return this.dur((Date.now() - Date.parse(iso)) / 1000); }
  abs(iso) { return iso || '—'; }
  msDur(a, b) { if (!a || !b) return '—'; const ms = Date.parse(b) - Date.parse(a); return ms < 10000 ? (ms / 1000).toFixed(2) + 's' : this.dur(ms / 1000); }

  badge(state) {
    const map = {
      pending: { background: 'var(--k-surface2)', color: 'var(--k-text2)', border: '1px solid var(--k-line)' },
      queued: { background: 'var(--k-line)', color: 'var(--k-ink900)', border: '1px solid var(--k-faint)' },
      running: { background: 'var(--color-accent)', color: 'var(--color-bg)', border: '1px solid var(--color-accent-700)' },
      awaiting_retry: { background: 'var(--k-warn-bg)', color: 'var(--k-warn-fg)', border: '1px solid var(--k-warn-border)' },
      success: { background: 'var(--k-ok-bg)', color: 'var(--k-ok-fg)', border: '1px solid var(--k-ok-border)' },
      dead: { background: 'var(--k-crit-bg2)', color: 'var(--k-crit-fg)', border: '1px solid var(--k-crit-border)' },
      cancelled: { background: 'transparent', color: 'var(--k-faint2)', border: '1px dashed var(--k-faint)' },
      expired: { background: 'transparent', color: 'var(--k-warn-fg)', border: '1px dashed var(--k-warn-border)' },
      paused: { background: 'var(--k-warn-bg)', color: 'var(--k-warn-fg)', border: '1px solid var(--k-warn-border)' },
      in_progress: { background: 'var(--color-accent)', color: 'var(--color-bg)', border: '1px solid var(--color-accent-700)' },
      failed: { background: 'var(--k-crit-bg2)', color: 'var(--k-crit-fg)', border: '1px solid var(--k-crit-border)' },
      superseded: { background: 'transparent', color: 'var(--k-faint2)', border: '1px dashed var(--k-faint)' }
    };
    return Object.assign({
      display: 'inline-block', fontFamily: 'var(--font-heading)', fontWeight: 600,
      fontSize: '11px', letterSpacing: '.06em', textTransform: 'uppercase',
      padding: '1px 7px', whiteSpace: 'nowrap'
    }, map[state] || map.pending);
  }
  applyTheme(t) {
    this.setState({ theme: t });
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('kairos-theme', t); } catch (e) {}
  }
  seg(n, counts, color) {
    const total = counts.pending + counts.queued + counts.running + counts.awaiting_retry;
    return { width: (total ? (n / total) * 100 : 0) + '%', background: color };
  }
  ageStyle(sec) {
    const base = { display: 'inline-block', fontVariantNumeric: 'tabular-nums', fontSize: '13px', padding: '1px 8px', fontWeight: 500 };
    if (sec > 300) return Object.assign(base, { background: 'var(--k-crit-bg2)', color: 'var(--k-crit-fg)', border: '1px solid var(--k-crit-border)', fontWeight: 700 });
    if (sec > 60) return Object.assign(base, { background: 'var(--k-warn-bg)', color: 'var(--k-warn-fg)', border: '1px solid var(--k-warn-border)' });
    return Object.assign(base, { color: 'var(--k-text2)', border: '1px solid transparent' });
  }

  // ── actions ───────────────────────────────────────────────────────────
  stepPage(d) {
    const r = this.route();
    if (r.path !== '/jobs') return;
    if (d > 0 && !(this.state.pagination && this.state.pagination.has_more)) return;
    const off = Math.max(0, r.offset + d * this.limit());
    r.offset = off; this.go(this.urlFor(r));
  }
  toggleSort(key) {
    if (this.state.sortKey === key) this.setState({ sortDir: this.state.sortDir === 'asc' ? 'desc' : 'asc' });
    else this.setState({ sortKey: key, sortDir: 'asc' });
  }
  async toggleRowExpand(job) {
    const open = !this.state.rowExpanded[job.id];
    this.setState({ rowExpanded: Object.assign({}, this.state.rowExpanded, { [job.id]: open }) });
    if (open && !this.state.rowAttempts[job.id]) {
      this.setState({ rowAttempts: Object.assign({}, this.state.rowAttempts, { [job.id]: 'loading' }) });
      try {
        const d = await this.getJob(job.id);
        this.setState({ rowAttempts: Object.assign({}, this.state.rowAttempts, { [job.id]: d.attempts || [] }) });
      } catch (e) {
        this.setState({ rowAttempts: Object.assign({}, this.state.rowAttempts, { [job.id]: 'error' }) });
      }
    }
  }
  toggleState(s) {
    const r = this.route();
    const i = r.states.indexOf(s);
    if (i === -1) r.states = r.states.concat([s]); else r.states = r.states.filter(x => x !== s);
    r.offset = 0; this.go(this.urlFor(r));
  }
  async write(kind) {
    const r = this.route();
    this.setState({ actionErr: null, actionOk: null });
    try {
      const v = ((this.state.detail || {}).job || {}).version;
      const call = { cancel: () => this.postCancel(r.detailId, v), rerun: () => this.postRerun(r.detailId, v), pause: () => this.postPause(r.detailId, v), resume: () => this.postResume(r.detailId, v) }[kind];
      const res = await call();
      const said = { cancel: 'Cancelled', rerun: 'Requeued', pause: 'Paused', resume: 'Resumed' }[kind];
      this.setState({ actionOk: said + ' — state is now ' + res.state });
      const d = await this.getJob(r.detailId); this.ok({ detail: d });
    } catch (e) {
      this.setState({ actionErr: e.message, actionCode: 'error · ' + e.code + ' · ' + e.status });
      try { const d = await this.getJob(r.detailId); this.ok({ detail: d }); } catch (e2) { /* keep stale */ }
    }
  }
  setSchedForm(k, val) { this.setState(s => ({ schedForm: Object.assign({}, s.schedForm, { [k]: val }) })); }
  openSchedule() {
    const j = (this.state.detail || {}).job || {};
    const toLocal = (iso) => iso ? iso.slice(0, 16) : '';
    this.setState({
      schedOpen: true, actionErr: null, actionOk: null,
      schedForm: {
        cron: j.cron_expr || '*/5 * * * *',
        preset: j.cron_expr || '*/5 * * * *',
        startsAt: toLocal(j.starts_at), endsAt: toLocal(j.ends_at)
      }
    });
  }
  async applySchedule() {
    const sf = this.state.schedForm;
    const body = { cron: sf.cron, version: ((this.state.detail || {}).job || {}).version };
    if (sf.startsAt) body.starts_at = this.formIso(sf.startsAt);
    if (sf.endsAt) body.ends_at = this.formIso(sf.endsAt);
    this.setState({ schedBusy: true, actionErr: null, actionOk: null });
    try {
      const res = await this.postSchedule(this.route().detailId, body);
      const d = await this.getJob(this.route().detailId);
      this.setState({
        schedBusy: false, schedOpen: false, detail: d,
        actionOk: 'Schedule set to ' + res.cron + ' — next fire ' + res.next_check_at
      });
    } catch (e) {
      this.setState({ schedBusy: false, actionErr: e.message, actionCode: e.code });
    }
  }
  copy(text) {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
    } catch (e) { /* ignore */ }
    this.setState({ copied: true });
    setTimeout(() => this.setState({ copied: false }), 1600);
  }
  formIso(v) { return v ? new Date(v + ':00Z').toISOString() : null; }
  formSchedule() {
    const f = this.state.form;
    const out = {};
    if (f.mode !== 'cron') return out;
    out.cron = f.cron;
    if (f.startsAt) out.starts_at = this.formIso(f.startsAt);
    if (f.endsAt) out.ends_at = this.formIso(f.endsAt);
    return out;
  }
  formBody() {
    const f = this.state.form;
    let payload = {};
    try { payload = JSON.parse(f.payload); } catch (e) { payload = null; }
    return Object.assign({ name: f.name, handler: f.handler, queue: f.queue, payload: payload, priority: Number(f.priority) }, this.formSchedule());
  }
  async submit() {
    const f = this.state.form;
    let payload;
    try { payload = JSON.parse(f.payload); } catch (e) { return this.setState({ payloadError: 'invalid JSON — ' + e.message, submitErr: null, createdId: null }); }
    this.setState({ payloadError: null, submitErr: null, createdId: null, submitting: true });
    try {
      const res = await this.postJob(Object.assign({ name: f.name, handler: f.handler, queue: f.queue, payload: payload, priority: Number(f.priority) }, this.formSchedule()));
      this.setState({ createdId: res.id, submitting: false });
    } catch (e) {
      this.setState({ submitErr: e.message, submitCode: e.code + ' · ' + e.status, submitting: false });
    }
  }
  setForm(k, v) { this.setState({ form: Object.assign({}, this.state.form, { [k]: v }) }); }

  renderVals() {
    const r = this.route();
    const s = this.state;
    const isDetail = !!r.detailId;
    const isJobs = r.path === '/jobs' && !isDetail;
    const v = {
      navOverview: r.path === '/' ? 'page' : undefined,
      navJobs: (isJobs || isDetail) ? 'page' : undefined,
      navWorkers: (r.path === '/workers' || !!r.workerId) ? 'page' : undefined,
      navSubmit: r.path === '/submit' ? 'page' : undefined,
      isOverview: r.path === '/', isJobs: isJobs, isDetail: isDetail,
      isWorkers: r.path === '/workers' || !!r.workerId, isSubmit: r.path === '/submit',
      isWorkerDetail: !!r.workerId, isWorkerList: !r.workerId,
      navHandlers: (r.path === '/handlers' || !!r.handlerId) ? 'page' : undefined,
      isHandlers: r.path === '/handlers' || !!r.handlerId,
      isHandlerList: !r.handlerId, isHandlerDetail: !!r.handlerId,
      isSchedules: r.path === '/schedules',
      navSchedules: r.path === '/schedules' ? 'page' : undefined,
      isDocs: r.path === '/docs',
      navDocs: r.path === '/docs' ? 'page' : undefined,
      isQueues: r.path === '/queues',
      navQueues: r.path === '/queues' ? 'page' : undefined,
      // Anything the router does not claim. Derived from the known paths rather than a
      // second list, so adding a page cannot leave a route falling through to 404.
      isNotFound: ['/', '/jobs', '/queues', '/schedules', '/handlers', '/workers', '/submit', '/docs']
        .indexOf(r.path) === -1 && !r.detailId && !r.workerId && !r.handlerId,
      notFoundPath: r.path,
      connLost: s.connLost,
      themeLabel: s.theme === 'dark' ? '◑ light mode' : '◐ dark mode',
      onToggleTheme: () => this.applyTheme(s.theme === 'dark' ? 'light' : 'dark'),
      lastUpdatedLabel: s.lastUpdated ? 'last updated ' + this.dur((Date.now() - s.lastUpdated) / 1000) + ' ago' : 'never updated',
      pollLabel: s.hidden ? 'polling paused · tab hidden' : (s.lastUpdated ? 'updated ' + this.dur((Date.now() - s.lastUpdated) / 1000) + ' ago' : 'connecting…'),
      pollDotStyle: {
        width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block',
        background: s.connLost ? 'var(--k-red)' : s.hidden ? 'var(--k-faint)' : 'var(--color-accent)'
      },
      onRetry: () => { this.setState({ queuesErr: null, jobsErr: null, workersErr: null, detailErr: null, handlersErr: null, hdetailErr: null, queuesDone: false, jobsDone: false, workersDone: false, detailDone: false, handlersDone: false, hdetailDone: false }, () => this.load(true)); }
    };
    // handlers
    const fmtMs = (ms) => ms === null || ms === undefined ? '—' : (ms < 10000 ? (ms / 1000).toFixed(2) + 's' : this.dur(ms / 1000));
    const fmtRate = (x) => x === null || x === undefined ? '—' : (x * 100).toFixed(x >= 0.995 || x === 0 ? 0 : 1) + '%';
    const rateStyle = (x) => {
      const base = { display: 'inline-block', fontVariantNumeric: 'tabular-nums', fontSize: '13px', padding: '1px 7px' };
      if (x === null || x === undefined) return Object.assign(base, { color: 'var(--k-faint)' });
      if (x < 0.6) return Object.assign(base, { background: 'var(--k-crit-bg2)', color: 'var(--k-crit-fg)', border: '1px solid var(--k-crit-border)', fontWeight: 700 });
      if (x < 0.9) return Object.assign(base, { background: 'var(--k-warn-bg)', color: 'var(--k-warn-fg)', border: '1px solid var(--k-warn-border)' });
      return Object.assign(base, { color: 'var(--k-ok-fg)', border: '1px solid transparent' });
    };
    const hs = s.handlers;
    v.handlersLoading = !s.handlersDone && !hs && !s.handlersErr;
    v.handlersError = s.handlersErr; v.handlersErrorCode = s.handlersCode;
    v.handlersEmpty = !!hs && hs.length === 0;
    v.handlersReady = !!hs && hs.length > 0;
    v.handlerCount = hs ? hs.length : '–';
    v.handlersFailing = hs ? hs.filter(h => h.counts.dead > 0).length : '–';
    v.handlersRunning = hs ? hs.reduce((a, h) => a + h.counts.running, 0) : '–';
    const hkey = s.hSortKey, hdir = s.hSortDir === 'asc' ? 1 : -1;
    const hval = (h) => hkey === 'handler' ? h.handler : hkey === 'total' ? h.total : hkey === 'running' ? h.counts.running
      : hkey === 'dead' ? h.counts.dead : hkey === 'rate' ? (h.success_rate === null ? -1 : h.success_rate) : (h.avg_run_ms === null ? -1 : h.avg_run_ms);
    const hsorted = (hs || []).slice().sort((a, b) => { const av = hval(a), bv = hval(b); return av < bv ? -hdir : av > bv ? hdir : 0; });
    const hArrow = (k) => s.hSortKey === k ? (s.hSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    v.hArrowHandler = hArrow('handler'); v.hArrowTotal = hArrow('total'); v.hArrowRunning = hArrow('running');
    v.hArrowDead = hArrow('dead'); v.hArrowRate = hArrow('rate'); v.hArrowAvg = hArrow('avg');
    const hSort = (k) => () => this.setState(s.hSortKey === k ? { hSortDir: s.hSortDir === 'asc' ? 'desc' : 'asc' } : { hSortKey: k, hSortDir: k === 'handler' ? 'asc' : 'desc' });
    v.onHSortHandler = hSort('handler'); v.onHSortTotal = hSort('total'); v.onHSortRunning = hSort('running');
    v.onHSortDead = hSort('dead'); v.onHSortRate = hSort('rate'); v.onHSortAvg = hSort('avg');
    const flagStyle = (bad) => ({ display: 'inline-block', marginTop: '3px', whiteSpace: 'nowrap', font: '600 9.5px var(--font-heading)', letterSpacing: '.06em', textTransform: 'uppercase', padding: '1px 7px', background: bad ? 'var(--k-crit-bg2)' : 'var(--k-warn-bg)', color: bad ? 'var(--k-crit-fg)' : 'var(--k-warn-fg)', border: '1px solid ' + (bad ? 'var(--k-crit-border)' : 'var(--k-warn-border)') });
    v.handlerRows = hsorted.map(h => {
      const bad = h.success_rate !== null && h.success_rate < 0.6;
      const warn = h.counts.awaiting_retry > 0;
      return {
        handler: h.handler, total: h.total,
        queuesShown: h.queues.slice(0, 2),
        queuesMore: h.queues.length > 2 ? '+' + (h.queues.length - 2) : '',
        queuesAll: h.queues.join(', '),
        backlog: h.counts.pending + h.counts.queued,
        running: h.counts.running, awaiting_retry: h.counts.awaiting_retry, dead: h.counts.dead,
        retryStyle: { color: h.counts.awaiting_retry ? 'var(--k-warn-fg)' : 'var(--k-muted)' },
        deadStyle: { color: h.counts.dead ? 'var(--k-crit-fg)' : 'var(--k-muted)', fontWeight: h.counts.dead ? 700 : 500 },
        successRate: fmtRate(h.success_rate), rateStyle: rateStyle(h.success_rate),
        avgRun: fmtMs(h.avg_run_ms),
        lastRel: this.relShort(h.last_activity_at), lastAbs: h.last_activity_at || '—',
        unhealthy: bad || warn,
        unhealthyLabel: bad ? 'failing · ' + h.counts.dead + ' dead' : 'retrying · ' + h.counts.awaiting_retry,
        unhealthyStyle: flagStyle(bad),
        onOpen: () => this.go('/handlers/' + encodeURIComponent(h.handler)),
        onKey: (e) => { if (e.key === 'Enter') this.go('/handlers/' + encodeURIComponent(h.handler)); }
      };
    });

    // handler detail
    if (r.handlerId) {
      v.handlerDetailId = r.handlerId;
      v.handlerJobsHref = '/jobs?handler=' + encodeURIComponent(r.handlerId);
      v.handlerFound = !!s.hdetail; v.handlerNotFound = !!s.hdetailErr;
      const hd = s.hdetail;
      if (hd) {
        const h = hd.handler;
        const bad = h.success_rate !== null && h.success_rate < 0.6;
        v.handlerHealthLabel = bad ? 'failing' : h.counts.awaiting_retry ? 'retrying' : 'healthy';
        v.handlerHealthStyle = Object.assign(this.badge(bad ? 'dead' : h.counts.awaiting_retry ? 'awaiting_retry' : 'success'), { fontSize: '12px' });
        v.hd = {
          total: h.total, successRate: fmtRate(h.success_rate), avgRun: fmtMs(h.avg_run_ms),
          dead: h.counts.dead, queues: h.queues,
          lastRel: this.rel(h.last_activity_at), lastAbs: h.last_activity_at || '—',
          stateRows: this.STATES.map(st => ({
            state: st, count: h.counts[st], badgeStyle: this.badge(st),
            share: h.total ? Math.round((h.counts[st] / h.total) * 100) + '%' : '—'
          })),
          recentCount: hd.jobs.length + (hd.jobs.length === 1 ? ' job' : ' jobs'),
          recentRows: hd.jobs.map(j => ({
            idShort: j.id.slice(0, 8) + '…', name: j.name, queue: j.queue, state: j.state,
            badgeStyle: this.badge(j.state), retry_count: j.retry_count,
            retryStyle: { color: j.retry_count > 3 ? 'var(--k-crit-fg)' : j.retry_count > 0 ? 'var(--k-warn-fg)' : 'var(--k-muted)' },
            updatedRel: this.relShort(j.updated_at), updatedAbs: j.updated_at,
            onOpen: () => this.go('/jobs/' + j.id)
          }))
        };
      }
    }

    // overview
    const qs = s.queues;
    v.queuesLoading = !s.queuesDone && !qs && !s.queuesErr;
    v.queuesError = s.queuesErr; v.queuesErrorCode = s.queuesCode;
    v.queuesEmpty = !!qs && qs.length === 0;
    v.queuesReady = !!qs && qs.length > 0;
    v.queueCount = qs ? qs.length : '–';
    v.liveWorkers = s.workers ? s.workers.length : '–';
    v.totalInFlight = s.workers ? s.workers.reduce((a, w) => a + w.in_flight, 0) : '–';
    v.queueRows = (qs || []).map(q => {
      const workerCount = (s.workers || []).filter(w => w.queues.indexOf(q.queue) !== -1).length;
      const hasBacklog = q.counts.pending + q.counts.queued + q.counts.running + q.counts.awaiting_retry > 0;
      const isDead = workerCount === 0 && hasBacklog;
      return {
        queue: q.queue,
        workerCount: workerCount,
        workersStyle: { color: workerCount === 0 ? 'var(--k-crit-fg)' : 'var(--k-text2)', fontWeight: workerCount === 0 ? 700 : 500 },
        isDead: isDead,
        deadStyle: { display: 'inline-block', marginTop: '3px', whiteSpace: 'nowrap', font: '600 9.5px var(--font-heading)', letterSpacing: '.06em', textTransform: 'uppercase', padding: '1px 7px', background: 'var(--k-crit-bg2)', color: 'var(--k-crit-fg)', border: '1px solid var(--k-crit-border)' },
        pending: q.counts.pending, queued: q.counts.queued, running: q.counts.running,
        awaiting_retry: q.counts.awaiting_retry, redis_buffered: q.redis_buffered,
        depth: q.counts.pending + q.counts.queued + q.counts.running + q.counts.awaiting_retry,
        retryStyle: { color: q.counts.awaiting_retry ? 'var(--k-warn-fg)' : 'inherit', fontWeight: q.counts.awaiting_retry ? 600 : 500 },
        barPending: this.seg(q.counts.pending, q.counts, 'var(--k-faint)'),
        barQueued: this.seg(q.counts.queued, q.counts, 'var(--k-muted)'),
        barRunning: this.seg(q.counts.running, q.counts, 'var(--color-accent)'),
        barRetry: this.seg(q.counts.awaiting_retry, q.counts, 'var(--k-gold)'),
        ageLabel: q.counts.pending ? this.dur(q.oldest_pending_age_seconds) : '—',
        ageStyle: q.counts.pending ? this.ageStyle(q.oldest_pending_age_seconds) : { color: 'var(--k-faint)', fontSize: '13px', padding: '1px 8px' },
        onOpen: () => this.go('/jobs?queue=' + q.queue),
        onKey: (e) => { if (e.key === 'Enter') this.go('/jobs?queue=' + q.queue); }
      };
    });

    v.totalBacklog = qs ? qs.reduce((t, q) => t + q.counts.pending + q.counts.queued + q.counts.running + q.counts.awaiting_retry, 0) : '–';

    v.onGoQueues = () => this.go('/queues');    v.queueNames = qs ? qs.map(q => q.queue).join(' · ') : '—';
    v.backlogLabel = qs ? v.totalBacklog + ' queued up' : '';
    v.onGoDead = () => this.go('/jobs?state=dead');
    v.onGoSchedules = () => this.go('/schedules');
    const scheds = s.schedules;
    v.schedCount = scheds ? scheds.length : '–';
    const upcoming = (scheds || []).filter(j => j.next_check_at).sort((a, b) => Date.parse(a.next_check_at) - Date.parse(b.next_check_at))[0];
    v.schedNextLabel = upcoming ? 'next ' + this.dueLabel(upcoming.next_check_at) : (scheds ? 'none armed' : '');
    const stalled = (scheds || []).filter(j => j.state === 'dead' || j.state === 'expired');
    const stag = (kind) => ({
      display: 'inline-block', whiteSpace: 'nowrap', font: '600 9px var(--font-heading)', letterSpacing: '.06em',
      textTransform: 'uppercase', padding: '2px 7px',
      background: kind === 'crit' ? 'var(--k-crit-bg2)' : 'transparent',
      color: kind === 'crit' ? 'var(--k-crit-fg)' : 'var(--k-warn-fg)',
      border: '1px ' + (kind === 'crit' ? 'solid var(--k-crit-border)' : 'dashed var(--k-warn-border)')
    });
    v.hasStalled = stalled.length > 0;
    v.stalledSummary = stalled.length + (stalled.length === 1 ? ' schedule is not firing' : ' schedules are not firing');
    v.stalledRows = stalled.slice(0, 6).map(j => ({
      name: j.name, cron_expr: j.cron_expr,
      tag: j.state === 'dead' ? 'retries exhausted' : 'window closed',
      tagStyle: stag(j.state === 'dead' ? 'crit' : 'warn'),
      detail: j.state === 'dead'
        ? 'died after ' + j.retry_count + ' retries on ' + j.queue
        : 'ends_at passed on ' + j.queue,
      metric: 'last run ' + this.rel(j.last_run_at),
      fix: j.state === 'dead' ? 'rerun to revive →' : 'resubmit with a new window →',
      onOpen: () => this.go('/jobs/' + j.id)
    }));

    const dead = s.odead;
    v.deadCount = dead ? dead.length + (dead.length >= 6 ? '+' : '') : '–';
    v.deadTileColor = dead && dead.length ? 'color:var(--k-crit-fg)' : '';
    v.hasDead = !!dead && dead.length > 0;
    v.noDead = !!dead && dead.length === 0;
    v.deadRows = (dead || []).slice(0, 5).map(j => ({
      name: j.name, queue: j.queue, handler: j.handler, retry_count: j.retry_count,
      updatedRel: this.relShort(j.updated_at), updatedAbs: j.updated_at,
      onOpen: () => this.go('/jobs/' + j.id)
    }));

    // jobs
    v.jobsRequestPath = '/jobs?' + this.jobsQuery(r);
    v.urlQuery = this.urlFor(r).split('?')[1] || '';
    const chipStyle = (on) => ({
      font: '600 11.5px var(--font-heading)', letterSpacing: '.04em', textTransform: 'uppercase',
      padding: '4px 9px', cursor: 'pointer', borderRadius: 0,
      background: on ? 'var(--color-accent)' : 'transparent',
      color: on ? 'var(--color-bg)' : 'var(--k-text2)',
      border: '1px solid ' + (on ? 'var(--color-accent-700)' : 'var(--color-divider)')
    });
    v.typeChips = [['', 'all'], ['adhoc', 'one-shot'], ['cron', 'recurring']].map(pair => ({
      label: pair[1], pressed: r.jobType === pair[0] ? 'true' : 'false',
      style: chipStyle(r.jobType === pair[0]),
      onPick: () => { const rr = this.route(); rr.jobType = pair[0]; rr.offset = 0; this.go(this.urlFor(rr)); }
    }));
    v.stateChips = this.STATES.map(st => {
      const on = r.states.indexOf(st) !== -1;
      return {
        label: st, pressed: on ? 'true' : 'false',
        onToggle: () => this.toggleState(st),
        style: {
          font: '600 11.5px var(--font-heading)', letterSpacing: '.04em', textTransform: 'uppercase',
          padding: '4px 9px', cursor: 'pointer', borderRadius: 0,
          background: on ? 'var(--color-accent)' : 'transparent',
          color: on ? 'var(--color-bg)' : 'var(--k-text2)',
          border: '1px solid ' + (on ? 'var(--color-accent-700)' : 'var(--color-divider)')
        }
      };
    });
    v.queueOptions = [{ value: '', label: 'all queues' }].concat((s.queues || []).map(q => ({ value: q.queue, label: q.queue })));
    v.queueValue = r.queue;
    v.onQueueChange = (e) => { const rr = this.route(); rr.queue = e.target.value; rr.offset = 0; this.go(this.urlFor(rr)); };
    v.onClearFilters = () => { this.setState({ search: '', sortKey: null }); this.go('/jobs'); };
    const handlerList = (s.handlers || []).map(h => h.handler);
    v.handlerOptions = [{ value: '', label: 'all handlers' }].concat(
      (handlerList.indexOf(r.handler) === -1 && r.handler ? handlerList.concat([r.handler]) : handlerList).map(h => ({ value: h, label: h }))
    );
    v.handlerValue = r.handler;
    v.onHandlerChange = (e) => { const rr = this.route(); rr.handler = e.target.value; rr.offset = 0; this.go(this.urlFor(rr)); };
    const fsum = [];
    fsum.push(r.states.length ? r.states.length + ' of 7 states' : 'all states');
    fsum.push(r.queue ? 'queue ' + r.queue : 'all queues');
    fsum.push(r.handler ? 'handler ' + r.handler : 'all handlers');
    if (r.q) fsum.push('lookup "' + r.q + '"');
    v.filterSummary = fsum.join(' · ');
    v.jobsLoading = !s.jobsDone && !s.jobs && !s.jobsErr;
    v.jobsError = s.jobsErr; v.jobsErrorCode = s.jobsCode;
    v.jobsEmpty = !!s.jobs && s.jobs.length === 0;
    v.jobsReady = !!s.jobs && s.jobs.length > 0;
    v.emptyTitle = r.q
      ? 'No job matches "' + r.q + '"'
      : 'No jobs match ' + (r.states.length ? r.states.join(' or ') : 'any state') + (r.queue ? ' in ' + r.queue : ' in any queue');
    v.emptyDetail = r.q
      ? 'The lookup runs server-side over id, name and handler across every page. Check the id, or clear the state chips — a dead job stays hidden while the filter excludes dead.'
      : r.offset > 0
        ? 'This page is past the end of the result set — offset ' + r.offset + ' with limit ' + this.limit() + '. Rows may have moved under concurrent inserts; step back a page.'
        : 'Filters active: ' + v.filterSummary + '. Nothing in the store matches that combination right now.';
    v.searchValue = s.search;
    v.onSearchChange = (e) => this.setState({ search: e.target.value });
    const submitSearch = () => { const rr = this.route(); rr.q = (this.state.search || '').trim(); rr.offset = 0; this.go(this.urlFor(rr)); };
    v.onSearchSubmit = submitSearch;
    v.onSearchKey = (e) => { if (e.key === 'Enter') submitSearch(); };
    const arrow = (key) => s.sortKey === key ? (s.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    v.sortArrowId = arrow('id'); v.sortArrowName = arrow('name'); v.sortArrowQueue = arrow('queue');
    v.sortArrowHandler = arrow('handler'); v.onSortHandler = () => this.toggleSort('handler');
    v.sortArrowPriority = arrow('priority'); v.sortArrowRetry = arrow('retry_count');
    v.sortArrowCreated = arrow('created_at'); v.sortArrowUpdated = arrow('updated_at');
    v.onSortId = () => this.toggleSort('id'); v.onSortName = () => this.toggleSort('name'); v.onSortQueue = () => this.toggleSort('queue');
    v.onSortPriority = () => this.toggleSort('priority'); v.onSortRetry = () => this.toggleSort('retry_count');
    v.onSortCreated = () => this.toggleSort('created_at'); v.onSortUpdated = () => this.toggleSort('updated_at');
    let filtered = (s.jobs || []).slice();
    if (s.sortKey) {
      const k = s.sortKey, dir = s.sortDir === 'asc' ? 1 : -1;
      filtered = filtered.slice().sort((a, b) => {
        const av = k === 'created_at' || k === 'updated_at' ? Date.parse(a[k]) : a[k];
        const bv = k === 'created_at' || k === 'updated_at' ? Date.parse(b[k]) : b[k];
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }
    v.jobRows = filtered.map(j => {
      const exp = !!s.rowExpanded[j.id];
      const cache = s.rowAttempts[j.id];
      const atRows = Array.isArray(cache) ? cache.slice().sort((a, b) => a.attempt_no - b.attempt_no) : [];
      return {
        id: j.id, idShort: j.id.slice(0, 8) + '…', href: '/jobs/' + j.id,
        name: j.name, queue: j.queue, state: j.state, badgeStyle: this.badge(j.state),
        handler: j.handler, handlerHref: '/handlers/' + encodeURIComponent(j.handler || ''),
        priority: j.priority,
        prioStyle: { color: j.priority <= 2 ? 'var(--k-crit-fg)' : j.priority <= 4 ? 'var(--k-warn-fg)' : 'var(--k-text2)', fontWeight: j.priority <= 2 ? 700 : 500 },
        retry_count: j.retry_count,
        retryStyle: { color: j.retry_count > 3 ? 'var(--k-crit-fg)' : j.retry_count > 0 ? 'var(--k-warn-fg)' : 'var(--k-muted)' },
        delivery_count: j.delivery_count,
        createdRel: this.relShort(j.created_at), createdAbs: j.created_at,
        updatedRel: this.relShort(j.updated_at), updatedAbs: j.updated_at,
        isCron: (j.job_type || 'adhoc') === 'cron',
        cron_expr: j.cron_expr, cronHuman: j.cron_expr ? this.cronHuman(j.cron_expr) : '',
        nextRun: j.next_check_at ? this.dueLabel(j.next_check_at) : '—',
        nextRunAbs: j.next_check_at || 'not armed',
        nextRunStyle: { color: j.next_check_at ? 'var(--k-text2)' : 'var(--k-faint)' },
        expanded: exp, expandArrow: exp ? '▾' : '▸',
        onToggleExpand: () => this.toggleRowExpand(j),
        attemptsLoading: cache === 'loading',
        attemptsEmpty: Array.isArray(cache) && cache.length === 0,
        attemptsReady: Array.isArray(cache) && cache.length > 0,
        attemptsRows: atRows.map(a => ({
          attempt_no: a.attempt_no, worker_id: this.workerName(a.worker_id), workerIdRaw: a.worker_id, outcome: a.outcome,
          outcomeStyle: this.badge(a.outcome), error: a.error || '—',
          startedRel: this.relShort(a.started_at),
          duration: a.finished_at ? this.msDur(a.started_at, a.finished_at) : 'running…',
          onOpen: () => this.go('/jobs/' + j.id)
        }))
      };
    });

    const pg = s.pagination;
    v.prevDisabled = r.offset === 0;
    v.nextDisabled = !(pg && pg.has_more);
    v.onPrev = () => this.stepPage(-1);
    v.onNext = () => this.stepPage(1);
    v.pageLabel = pg ? 'rows ' + (pg.offset + 1) + '–' + (pg.offset + (s.jobs ? s.jobs.length : 0)) + (pg.has_more ? ' · more available' : ' · end of results') : '';

    // schedules
    v.schedLoading = !s.schedDone && !s.schedules && !s.schedErr;
    v.schedEmpty = !!s.schedules && s.schedules.length === 0;
    v.schedReady = !!s.schedules && s.schedules.length > 0;
    v.schedRows = (s.schedules || []).slice().sort((a, b) => {
      const av = a.next_check_at ? Date.parse(a.next_check_at) : Infinity;
      const bv = b.next_check_at ? Date.parse(b.next_check_at) : Infinity;
      return av - bv;
    }).map(j => ({
      name: j.name, handler: j.handler, queue: j.queue, state: j.state,
      cron_expr: j.cron_expr, human: this.cronHuman(j.cron_expr),
      badgeStyle: this.badge(j.state),
      stalledNote: j.state === 'dead' ? 'will not fire until rerun' : j.state === 'expired' ? 'window closed' : '',
      lastRel: j.last_run_at ? this.rel(j.last_run_at) : 'never',
      lastAbs: j.last_run_at || '—',
      nextRel: this.dueLabel(j.next_check_at),
      nextAbs: j.next_check_at || 'no next fire',
      nextStyle: { color: j.next_check_at ? 'var(--k-text2)' : 'var(--k-crit-fg)', fontWeight: j.next_check_at ? 500 : 700 },
      windowFrom: j.starts_at ? 'from ' + j.starts_at.slice(5, 16).replace('T', ' ') : 'from creation',
      windowTo: j.ends_at ? 'to ' + j.ends_at.slice(5, 16).replace('T', ' ') : 'no end',
      runs: j.delivery_count,
      canHold: ['pending', 'awaiting_retry', 'paused'].indexOf(j.state) !== -1,
      holdLabel: j.state === 'paused' ? 'resume' : 'pause',
      onHold: async (e) => {
        e.stopPropagation();
        try {
          await (j.state === 'paused' ? this.postResume(j.id, j.version) : this.postPause(j.id, j.version));
        } catch (err) { /* surfaced on the row's next poll */ }
        this.load(true);
      },
      onOpen: () => this.go('/jobs/' + j.id)
    }));

    // detail
    v.detailId = r.detailId || '';
    v.backHref = this.urlFor({ states: [], queue: '', offset: 0 });
    v.detailLoading = !s.detailDone && !s.detail && !s.detailErr;
    v.detailError = s.detailErr; v.detailErrorCode = s.detailCode;
    v.detailReady = !!s.detail;
    const d = s.detail;
    if (d) {
      const j = d.job;
      v.job = j;
      v.jobBadgeStyle = this.badge(j.state);
      v.jobHandlerHref = '/handlers/' + encodeURIComponent(j.handler || '');
      v.nextCheckLabel = j.next_check_at ? 'in ' + this.dur((Date.parse(j.next_check_at) - Date.now()) / 1000) : '—';
      v.nextCheckAbs = this.abs(j.next_check_at);
      v.createdRel = this.rel(j.created_at); v.createdAbs = j.created_at;
      v.updatedRel = this.rel(j.updated_at); v.updatedAbs = j.updated_at;
      v.payloadOpen = s.payloadOpen;
      v.payloadToggleLabel = (s.payloadOpen ? '▾ ' : '▸ ') + 'payload';
      v.payloadJson = JSON.stringify(j.payload, null, 2);
      v.onTogglePayload = () => this.setState({ payloadOpen: !s.payloadOpen });
      v.copyLabel = s.copied ? 'copied' : 'copy';
      v.onCopyPayload = () => this.copy(JSON.stringify(j.payload, null, 2));
      const isCron = (j.job_type || 'adhoc') === 'cron';
      const runCount = (d.attempts || []).length;
      v.jobIsCron = isCron;
      v.jobCronExpr = j.cron_expr || '';
      v.jobCronHuman = j.cron_expr ? this.cronHuman(j.cron_expr) : '';
      v.schedTagStyle = {
        display: 'inline-block', font: '600 9.5px var(--font-heading)', letterSpacing: '.08em',
        textTransform: 'uppercase', padding: '2px 8px', background: 'var(--k-warn-bg)',
        color: 'var(--k-warn-fg)', border: '1px solid var(--k-warn-border)'
      };
      v.jobStalled = isCron && (j.state === 'dead' || j.state === 'expired');
      v.jobStalledNote = j.state === 'dead'
        ? 'This schedule stopped. One occurrence exhausted max_retries, so the row went dead and will not re-arm — rerun it once the handler is fixed.'
        : 'The window closed at ' + (j.ends_at || '—') + '. Expired is terminal and not rerunnable; submit a new schedule with a new ends_at.';
      v.jobStartsLabel = j.starts_at ? (Date.parse(j.starts_at) > Date.now() ? this.dueLabel(j.starts_at) : this.rel(j.starts_at)) : 'from creation';
      v.jobStartsAbs = j.starts_at || '—';
      v.jobEndsLabel = j.ends_at ? (Date.parse(j.ends_at) > Date.now() ? 'in ' + this.dur((Date.parse(j.ends_at) - Date.now()) / 1000) : 'closed ' + this.rel(j.ends_at)) : 'no end';
      v.jobEndsAbs = j.ends_at || '—';
      v.lastRunLabel = j.last_run_at ? this.rel(j.last_run_at) : 'never run';
      v.lastRunAbs = j.last_run_at || '—';
      v.jobRunCount = runCount;
      const up = isCron && ['dead', 'expired', 'cancelled'].indexOf(j.state) === -1 ? this.cronPreview(j.cron_expr, j.starts_at, j.ends_at, 3) : [];
      v.jobHasUpcoming = up.length > 0;
      v.jobUpcoming = up.map(t => ({ abs: t.slice(0, 16).replace('T', ' ') + 'Z', rel: this.dur((Date.parse(t) - Date.now()) / 1000) }));
      const terminal = ['success', 'dead', 'cancelled', 'expired'].indexOf(j.state) !== -1;
      // Hold/release is a schedule operation: the server only pauses cron rows.
      const canPause = isCron && ['pending', 'queued', 'awaiting_retry', 'success'].indexOf(j.state) !== -1;
      v.jobIsPaused = j.state === 'paused';
      v.showResume = j.state === 'paused';
      v.showPause = isCron && j.state !== 'paused';
      v.pauseDisabled = !canPause;
      v.pauseHint = canPause
        ? 'POST /jobs/' + j.id + '/pause — holds the schedule; missed slots are not backfilled on resume'
        : 'Pause applies to an armed cron row — a running attempt is left to finish';
      v.resumeHint = 'POST /jobs/' + j.id + '/pause {"paused":false} — re-arms at the next slot, not the ones missed';
      v.onPause = () => this.write('pause');
      v.onResume = () => this.write('resume');
      // No paused_at column on the server; updated_at is the transition that paused it.
      v.pausedRel = j.updated_at ? this.rel(j.updated_at) : '';
      v.pausedNote = 'The scheduler skips this row entirely. Resuming arms it at the next slot — occurrences missed while paused are dropped, not backfilled.';

      v.scheduleLabel = isCron ? 'Reschedule' : 'Schedule';
      v.scheduleDisabled = terminal;
      v.scheduleHint = terminal
        ? 'A terminal job cannot be rescheduled — submit a new one'
        : 'POST /jobs/' + j.id + '/schedule';
      v.scheduleOpen = !!s.schedOpen;
      v.onOpenSchedule = () => this.openSchedule();
      v.onCloseSchedule = () => this.setState({ schedOpen: false });
      v.scheduleBlurb = isCron
        ? 'Replaces the expression and window on this row. The next fire is recomputed immediately; history, run count and identity are untouched.'
        : 'Turns this one-shot into a recurring job. Same row, same id — the payload and handler do not change.';
      const sf = s.schedForm;
      v.schedForm = sf;
      v.onSchedPreset = (e) => { this.setSchedForm('preset', e.target.value); if (e.target.value !== 'custom') this.setSchedForm('cron', e.target.value); };
      v.onSchedCron = (e) => this.setSchedForm('cron', e.target.value);
      v.onSchedStarts = (e) => this.setSchedForm('startsAt', e.target.value);
      v.onSchedEnds = (e) => this.setSchedForm('endsAt', e.target.value);
      v.schedCronError = this.cronValidate(sf.cron);
      const sprev = v.schedCronError ? []
        : this.cronPreview(sf.cron, this.formIso(sf.startsAt), this.formIso(sf.endsAt), 3);
      v.schedPreviewRows = sprev.map(t => ({ abs: t.slice(0, 16).replace('T', ' ') + 'Z', rel: this.dur((Date.parse(t) - Date.now()) / 1000) }));
      v.schedPreviewEmpty = sprev.length === 0;
      v.schedShowsReplace = isCron;
      v.schedApplyDisabled = !!s.schedBusy || !!v.schedCronError || sprev.length === 0;
      v.schedApplyLabel = s.schedBusy ? 'applying…' : (isCron ? 'Replace schedule' : 'Apply schedule');
      v.schedApplyNote = isCron ? 'the row stays pending, re-armed at the new time' : 'the row becomes recurring';
      v.onApplySchedule = () => this.applySchedule();

      const canCancel = ['pending', 'queued', 'running', 'awaiting_retry', 'paused'].indexOf(j.state) !== -1;
      v.cancelDisabled = !canCancel;
      v.rerunDisabled = j.state !== 'dead';
      v.cancelHint = canCancel
        ? (isCron ? 'POST /jobs/' + j.id + '/cancel — stops the schedule, including mid-occurrence' : 'POST /jobs/' + j.id + '/cancel')
        : 'Cancel applies to any non-terminal state — the server is authoritative';
      v.rerunHint = j.state === 'dead' ? 'POST /jobs/' + j.id + '/rerun' : 'Rerun applies to dead jobs only — expired schedules are not revivable';
      v.onCancel = () => this.write('cancel');
      v.onRerun = () => this.write('rerun');
      v.actionError = s.actionErr; v.actionErrorCode = s.actionCode; v.actionOk = s.actionOk;
      v.onDismissActionError = () => this.setState({ actionErr: null });
      const atAll = (d.attempts || []).slice().sort((a, b) => a.attempt_no - b.attempt_no);
      const jl = [{ t: j.created_at, line: 'created · queue=' + j.queue + ' priority=' + j.priority }];
      atAll.forEach(a => {
        jl.push({ t: a.started_at, line: 'attempt ' + a.attempt_no + ' started on ' + this.workerName(a.worker_id) + ' (' + a.worker_id + ')' });
        if (a.finished_at) {
          if (a.outcome === 'success') jl.push({ t: a.finished_at, line: 'attempt ' + a.attempt_no + ' succeeded' });
          else if (a.outcome === 'failed') jl.push({ t: a.finished_at, line: 'attempt ' + a.attempt_no + ' failed: ' + a.error });
          else if (a.outcome === 'superseded') jl.push({ t: a.finished_at, line: 'attempt ' + a.attempt_no + ' superseded (job cancelled)' });
        }
      });
      if (j.state === 'dead') jl.push({ t: j.updated_at, line: 'exhausted retries · moved to dead' });
      if (j.state === 'cancelled') jl.push({ t: j.updated_at, line: 'cancelled by operator' });
      if (j.state === 'awaiting_retry' && j.next_check_at) jl.push({ t: j.updated_at, line: 'scheduled for retry at ' + j.next_check_at });
      v.jobLogRows = jl.sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).map(l => ({ t: new Date(l.t).toLocaleTimeString(), line: l.line }));
      const at = s.attemptsFilter === 'last5' ? atAll.slice(-5) : s.attemptsFilter === 'last10' ? atAll.slice(-10) : atAll;
      v.attemptsCount = at.length + ' of ' + atAll.length + (atAll.length === 1 ? ' attempt' : ' attempts') + ' shown';
      v.attemptsEmpty = atAll.length === 0;
      v.attemptsReady = at.length > 0;
      v.attemptsFilter = s.attemptsFilter;
      v.attemptsFilterOptions = [{ value: 'last5', label: 'last 5 attempts' }, { value: 'last10', label: 'last 10 attempts' }, { value: 'all', label: 'all attempts' }];
      v.onAttemptsFilterChange = (e) => this.setState({ attemptsFilter: e.target.value });
      v.attemptRows = at.map(a => {
        const long = !!a.error && a.error.length > 74;
        const open = !!s.expanded[a.attempt_no];
        return {
          attempt_no: a.attempt_no, worker_id: this.workerName(a.worker_id), workerIdRaw: a.worker_id, outcome: a.outcome,
          outcomeStyle: this.badge(a.outcome),
          error: a.error || '—',
          canExpand: long,
          toggleLabel: open ? 'collapse' : 'expand',
          onToggle: () => this.setState({ expanded: Object.assign({}, s.expanded, { [a.attempt_no]: !open }) }),
          errorStyle: {
            fontSize: '12.5px', color: a.error ? 'var(--k-crit-fg2)' : 'var(--k-faint)', lineHeight: 1.45,
            fontFamily: a.error ? 'ui-monospace,Menlo,Consolas,monospace' : 'inherit',
            whiteSpace: open ? 'pre-wrap' : 'nowrap',
            overflow: open ? 'visible' : 'hidden',
            textOverflow: 'ellipsis', wordBreak: open ? 'break-word' : 'normal'
          },
          startedRel: this.relShort(a.started_at), startedAbs: a.started_at,
          finishedRel: a.finished_at ? this.relShort(a.finished_at) : 'running',
          finishedAbs: this.abs(a.finished_at),
          duration: a.finished_at ? this.msDur(a.started_at, a.finished_at) : this.dur((Date.now() - Date.parse(a.started_at)) / 1000) + '…'
        };
      });
    }

    // workers
    v.workersLoading = !s.workersDone && !s.workers && !s.workersErr;
    v.workersError = s.workersErr; v.workersErrorCode = s.workersCode;
    v.workersEmpty = !!s.workers && s.workers.length === 0;
    v.workersReady = !!s.workers && s.workers.length > 0;
    v.workerRows = (s.workers || []).map(w => ({
      id: w.id, name: w.name || w.id, queues: w.queues, in_flight: w.in_flight,
      idle: !(w.in_flight_jobs || []).length,
      busy: (w.in_flight_jobs || []).length > 0,
      expanded: !!s.workerExpanded[w.id],
      expandArrow: s.workerExpanded[w.id] ? '▾' : '▸',
      runningLabel: (w.in_flight_jobs || []).length === 1
        ? w.in_flight_jobs[0].name
        : (w.in_flight_jobs || []).length + ' jobs',
      oldestLabel: (w.in_flight_jobs || []).length
        ? this.dur((Date.now() - Date.parse(w.in_flight_jobs[0].started_at)) / 1000) + (w.in_flight_jobs.length > 1 ? ' oldest' : '')
        : '',
      onToggleRunning: (e) => {
        e.stopPropagation();
        const next = Object.assign({}, this.state.workerExpanded);
        if (next[w.id]) delete next[w.id]; else next[w.id] = true;
        this.setState({ workerExpanded: next });
      },
      running: (w.in_flight_jobs || []).map(j => {
        const secs = (Date.now() - Date.parse(j.started_at)) / 1000;
        return {
          idShort: j.id.slice(0, 8) + '…', name: j.name, handler: j.handler, queue: j.queue,
          elapsed: this.dur(secs),
          elapsedStyle: { color: secs > 300 ? 'var(--k-crit-fg)' : secs > 60 ? 'var(--k-warn-fg)' : 'var(--k-text2)', fontWeight: secs > 300 ? 700 : 500 },
          onOpen: (e) => { e.stopPropagation(); this.go('/jobs/' + j.id); }
        };
      }),
      lastSeenRel: this.rel(w.last_seen), lastSeenAbs: w.last_seen,
      uptime: this.dur((Date.now() - Date.parse(w.started_at)) / 1000), startedAbs: w.started_at,
      onOpen: () => this.go('/workers/' + w.id)
    }));

    // worker detail
    if (r.workerId) {
      v.workerDetailId = r.workerId;
      const w = (s.workers || []).filter(x => x.id === r.workerId)[0];
      v.workerDetailName = w ? (w.name || w.id) : r.workerId;
      v.workerFound = !!w; v.workerNotFound = !w;
      if (w) {
        const staleSec = (Date.now() - Date.parse(w.last_seen)) / 1000;
        // Two registry_intervals (10s each). At exactly one interval a healthy worker
        // flickers stale every cycle; past two it has really missed a beat, and its key
        // expires at registry_ttl (30s) anyway, which removes it from this list entirely.
        const online = staleSec < 20;
        v.workerStatusLabel = online ? 'online' : 'stale heartbeat';
        v.workerStatusStyle = Object.assign(this.badge(online ? 'running' : 'awaiting_retry'), { fontSize: '12px' });
        v.workerQueueTags = w.queues;
        v.workerInFlight = w.in_flight;
        v.workerLastSeenRel = this.rel(w.last_seen); v.workerLastSeenAbs = w.last_seen;
        v.workerUptime = this.dur((Date.now() - Date.parse(w.started_at)) / 1000) + ' up'; v.workerStartedAbs = w.started_at;
        const rj = w.in_flight_jobs || [];
        v.workerIdle = rj.length === 0;
        v.workerRunningReady = rj.length > 0;
        v.workerRunningNote = rj.length
          ? rj.length + (rj.length === 1 ? ' job in flight' : ' jobs in flight') + ' · from GET /workers'
          : 'from GET /workers';
        v.workerRunningRows = rj.map(j => {
          const secs = (Date.now() - Date.parse(j.started_at)) / 1000;
          return {
            idShort: j.id.slice(0, 8) + '…', name: j.name, handler: j.handler, queue: j.queue,
            elapsed: this.dur(secs),
            elapsedStyle: { color: secs > 300 ? 'var(--k-crit-fg)' : secs > 60 ? 'var(--k-warn-fg)' : 'var(--k-text2)', fontWeight: secs > 300 ? 700 : 500 },
            onOpen: () => this.go('/jobs/' + j.id)
          };
        });
        const act = this.workerActivity(w.id);
        v.workerActivityEmpty = act.length === 0;
        v.workerActivityReady = act.length > 0;
        v.workerActivityCount = act.length + (act.length === 1 ? ' attempt' : ' attempts') + ' (last 60)';
        v.workerActivityRows = act.map(a => ({
          job_name: a.job_name, queue: a.queue, outcome: a.outcome,
          outcomeStyle: this.badge(a.outcome),
          startedRel: this.relShort(a.started_at), startedAbs: a.started_at,
          duration: a.finished_at ? this.msDur(a.started_at, a.finished_at) : 'running…',
          onOpen: () => this.go('/jobs/' + a.job_id)
        }));
      }
    }

    // submit
    v.form = s.form;
    v.formQueueOptions = (s.queues || []).map(q => q.queue);
    const mode = s.form.mode || 'once';
    v.modeChips = [['once', 'run once'], ['cron', 'recurring']].map(pair => ({
      label: pair[1], pressed: mode === pair[0] ? 'true' : 'false',
      style: chipStyle(mode === pair[0]),
      onPick: () => this.setForm('mode', pair[0])
    }));
    v.formIsCron = mode === 'cron';
    v.formHasWindow = mode === 'cron';
    v.cronPresetOptions = this.CRON_PRESETS.map(p => ({ value: p.expr, label: p.expr + '  ·  ' + p.label }))
      .concat([{ value: 'custom', label: 'custom — type below' }]);
    v.onFormCronPreset = (e) => { if (e.target.value !== 'custom') this.setForm('cron', e.target.value); };
    v.onFormCron = (e) => this.setForm('cron', e.target.value);
    v.onFormStarts = (e) => this.setForm('startsAt', e.target.value);
    v.onFormEnds = (e) => this.setForm('endsAt', e.target.value);
    v.cronError = mode === 'cron' ? this.cronValidate(s.form.cron) : null;
    const prev = mode === 'cron' && !v.cronError
      ? this.cronPreview(s.form.cron, this.formIso(s.form.startsAt), this.formIso(s.form.endsAt), 3) : [];
    v.cronPreviewRows = prev.map(t => ({ abs: t.slice(0, 16).replace('T', ' ') + 'Z', rel: this.dur((Date.parse(t) - Date.now()) / 1000) }));
    v.previewEmpty = mode === 'cron' && !v.cronError && prev.length === 0;
    v.onFormName = (e) => this.setForm('name', e.target.value);
    v.onFormQueue = (e) => this.setForm('queue', e.target.value);
    v.onFormHandler = (e) => this.setForm('handler', e.target.value);
    v.formHandlerOptions = (s.handlers || []).map(h => h.handler);
    v.onFormPriority = (e) => this.setForm('priority', e.target.value);
    v.onFormPayload = (e) => this.setForm('payload', e.target.value);
    v.onFormatPayload = () => {
      try { this.setForm('payload', JSON.stringify(JSON.parse(s.form.payload), null, 2)); this.setState({ payloadError: null }); }
      catch (e) { this.setState({ payloadError: 'invalid JSON — ' + e.message }); }
    };
    v.payloadError = s.payloadError;
    v.submitting = s.submitting;
    v.submitLabel = s.submitting ? 'submitting…' : 'Submit job';
    v.onSubmit = () => this.submit();
    v.submitError = s.submitErr; v.submitErrorCode = s.submitCode;
    v.createdId = s.createdId; v.createdHref = s.createdId ? '/jobs/' + s.createdId : '/jobs';
    const body = this.formBody();
    v.requestPreview = 'POST /jobs\n' + 'Content-Type: application/json\n\n' +
      (body.payload === null ? '{ payload is not valid JSON }' : JSON.stringify(body, null, 2));
    return v;
  }
}
