import { useEffect, useRef, useState } from 'react';

import { useStatus } from '@/contexts/StatusContext';
import { type ApiError, asApiError } from '@/services/api';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  ready: boolean;
}

// `key` identifies the thing being fetched. When it changes the resource resets to loading;
// when only the poll generation advances the previous data stays on screen so rows do not
// flicker every three seconds.
export function useResource<T>(key: string, load: () => Promise<T>, enabled = true): Resource<T> {
  const { generation, retryToken, markOk, markFail } = useStatus();
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; done: boolean }>({
    data: null,
    error: null,
    done: false,
  });

  const loadRef = useRef(load);
  loadRef.current = load;
  const dataRef = useRef<T | null>(null);
  dataRef.current = state.data;

  const resetKey = `${key}|${retryToken}`;
  const lastReset = useRef(resetKey);
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    dataRef.current = null;
  }

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    if (dataRef.current === null) setState({ data: null, error: null, done: false });

    // Promise.resolve().then wraps the call so a loader that throws synchronously becomes a
    // rejection instead of an uncaught error that tears the tree down.
    Promise.resolve()
      .then(() => loadRef.current())
      .then((data) => {
        if (!live) return;
        setState({ data, error: null, done: true });
        markOk();
      })
      .catch((e: unknown) => {
        if (!live) return;
        const err = asApiError(e);
        if (dataRef.current !== null) {
          markFail(true);
          return;
        }
        setState({ data: null, error: err, done: true });
        markFail(false);
      });

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, generation, enabled]);

  return {
    data: state.data,
    error: state.error,
    loading: !state.done && state.data === null && state.error === null,
    ready: state.data !== null,
  };
}
