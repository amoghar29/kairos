import { useEffect, useRef, useState } from 'react';
import { POLL_SECONDS } from '../config';

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

// Relative timestamps ("14s ago") need a repaint every second even when no data changed.
export function useTicker(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return tick;
}

type KeyHandlers = {
  onGoto: (key: string) => void;
  onRefresh: () => void;
  onPage: (delta: number) => void;
};

// vim-style leader: `g` then a destination key, within 900ms.
export function useKeyboard(handlers: KeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

      const now = Date.now();
      if (e.key === 'g') {
        gAt = now;
        return;
      }
      if (gAt && now - gAt < 900) {
        gAt = 0;
        ref.current.onGoto(e.key);
        return;
      }
      if (e.key === 'r') ref.current.onRefresh();
      if (e.key === 'j') ref.current.onPage(1);
      if (e.key === 'k') ref.current.onPage(-1);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
