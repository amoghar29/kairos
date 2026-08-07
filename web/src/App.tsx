import { ROWS_PER_PAGE } from './config';
import { Shell } from './components/Shell';
import { EmptyPanel } from './components/Panels';
import { useKeyboard, useTicker } from './lib/hooks';
import { StatusProvider, useStatus } from './lib/resource';
import { go, jobsHref, useRoute } from './lib/route';
import { Consumer } from './pages/Consumer';
import { JobDetail } from './pages/JobDetail';
import { Jobs } from './pages/Jobs';
import { Overview } from './pages/Overview';
import { Submit } from './pages/Submit';
import { WorkerDetail } from './pages/WorkerDetail';
import { Workers } from './pages/Workers';

const GOTO: Record<string, string> = { o: '#/', j: '#/jobs', w: '#/workers', c: '#/consumer', s: '#/submit' };

function Router() {
  const route = useRoute();
  const { refresh } = useStatus();
  // Relative timestamps must keep ticking even when the 3s poll brings back identical data.
  useTicker();

  useKeyboard({
    onGoto: (key) => {
      const href = GOTO[key];
      if (href) go(href);
    },
    onRefresh: refresh,
    onPage: (delta) => {
      if (route.path !== '/jobs' || route.jobId) return;
      const offset = Math.max(0, route.offset + delta * ROWS_PER_PAGE);
      if (offset === route.offset) return;
      go(jobsHref({ states: route.states, queue: route.queue, offset }));
    },
  });

  return (
    <Shell path={route.path}>
      {route.jobId ? (
        <JobDetail jobId={route.jobId} />
      ) : route.workerId ? (
        <WorkerDetail workerId={route.workerId} />
      ) : route.path === '/' ? (
        <Overview />
      ) : route.path === '/jobs' ? (
        <Jobs route={route} />
      ) : route.path === '/workers' ? (
        <Workers />
      ) : route.path === '/consumer' ? (
        <Consumer />
      ) : route.path === '/submit' ? (
        <Submit />
      ) : (
        <EmptyPanel
          title="No such page"
          detail={`${route.path} is not a route in this dashboard.`}
          action={
            <a className="btn btn-secondary" href="#/">
              Back to overview
            </a>
          }
        />
      )}
    </Shell>
  );
}

export function App() {
  return (
    <StatusProvider>
      <Router />
    </StatusProvider>
  );
}
