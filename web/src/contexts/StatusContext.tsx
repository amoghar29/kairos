import { type ReactNode, createContext, useCallback, useContext, useState } from 'react';

import { usePoll } from '@/hooks/usePoll';

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
      value={{
        generation,
        retryToken,
        hidden,
        lastUpdated,
        connLost,
        markOk,
        markFail,
        retry,
        refresh,
      }}
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
