import { useEffect, useRef } from 'react';

interface KeyHandlers {
  onGoto: (key: string) => void;
  onRefresh: () => void;
  onPage: (delta: number) => void;
}

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
