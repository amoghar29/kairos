import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ROWS_PER_PAGE } from './config';
import { Shell } from './components/Shell';
import { EmptyPanel } from './components/Panels';
import { useKeyboard, useTicker } from './lib/hooks';
import { StatusProvider, useStatus } from './lib/resource';
import { jobsHref } from './lib/route';
import type { JobState } from './api/types';
import { Consumer } from './pages/Consumer';
import { JobDetail } from './pages/JobDetail';
import { Jobs } from './pages/Jobs';
import { Overview } from './pages/Overview';
import { Submit } from './pages/Submit';
import { WorkerDetail } from './pages/WorkerDetail';
import { Workers } from './pages/Workers';

const GOTO: Record<string, string> = { o: '/', j: '/jobs', w: '/workers', c: '/consumer', s: '/submit' };

function AppShell() {
  const { refresh } = useStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Relative timestamps must keep ticking even when the 3s poll brings back identical data.
  useTicker();

  const offset = Number.parseInt(searchParams.get('offset') ?? '0', 10) || 0;
  const queue = searchParams.get('queue') ?? '';
  const states = searchParams.getAll('state') as JobState[];

  useKeyboard({
    onGoto: (key) => {
      const href = GOTO[key];
      if (href) navigate(href);
    },
    onRefresh: refresh,
    onPage: (delta) => {
      if (location.pathname !== '/jobs') return;
      const next = Math.max(0, offset + delta * ROWS_PER_PAGE);
      if (next === offset) return;
      navigate(jobsHref({ states, queue, offset: next }));
    },
  });

  return (
    <Shell path={location.pathname}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/:jobId" element={<JobDetail />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/workers/:workerId" element={<WorkerDetail />} />
        <Route path="/consumer" element={<Consumer />} />
        <Route path="/submit" element={<Submit />} />
        <Route
          path="*"
          element={
            <EmptyPanel
              title="No such page"
              detail={`${location.pathname} is not a route in this dashboard.`}
              action={
                <Link className="btn btn-secondary" to="/">
                  Back to overview
                </Link>
              }
            />
          }
        />
      </Routes>
    </Shell>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <StatusProvider>
        <AppShell />
      </StatusProvider>
    </BrowserRouter>
  );
}
