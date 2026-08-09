import { useEffect, useRef, useState } from 'react';

import { POLL_SECONDS } from '@/constants';

// One shared interval for the whole app, paused while the tab is hidden: a dashboard left
// open in a background tab must not keep hammering the scheduler.
export function usePoll(load: () => void): { hidden: boolean; refresh: () => void } {
  const [hidden, setHidden] = useState(() => document.hidden);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);

    const id = window.setInterval(() => {
      if (document.hidden) return;
      loadRef.current();
    }, POLL_SECONDS * 1000);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return { hidden, refresh: () => loadRef.current() };
}
