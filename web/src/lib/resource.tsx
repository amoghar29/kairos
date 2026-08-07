import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, asApiError } from '../api/error';
import { usePoll } from './hooks';

interface Status {
  generation: number;
  retryToken: number;
  hidden: boolean;
  lastUpdated: number | null;
  connLost: boolean;
  markOk: () => void;
  markFail: (hadData: boolean) => void;
  retry: () => void;
  refresh: () => void;
}

const StatusContext = createContext<Status | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  const [retryToken, setRetryToken] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [connLost, setConnLost] = useState(false);

  const { hidden } = usePoll(() => setGeneration((g) => g + 1));

  const markOk = useCallback(() => {
    setLastUpdated(Date.now());
    setConnLost(false);
  }, []);

  // A failed refresh with data already on screen is a connection problem, not an empty
  // page: keep the last good rows and say they are stale.
  const markFail = useCallback((hadData: boolean) => {
    if (hadData) setConnLost(true);
  }, []);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
    setGeneration((g) => g + 1);
  }, []);

  return (
    <StatusContext.Provider
      value={{ generation, retryToken, hidden, lastUpdated, connLost, markOk, markFail, retry, refresh }}
    >
      {children}
    </StatusContext.Provider>
  );
}

export function useStatus(): Status {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error('useStatus must be used inside StatusProvider');
  return ctx;
}

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
