import { useEffect, useState } from 'react';

// Relative timestamps ("14s ago") need a repaint every second even when no data changed.
export function useTicker(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return tick;
}
