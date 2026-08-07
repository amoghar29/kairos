import type { LogLine } from '../api/types';
import { clock } from '../lib/format';
import { Blueprint } from './Blueprint';

interface Props {
  lines: LogLine[];
  emptyLabel?: string;
  maxHeight?: number;
}

// Newest first — an operator watching a live stream reads the top line, not the bottom one.
export function LogStream({ lines, emptyLabel = 'waiting for the next poll…', maxHeight }: Props) {
  const rows = lines.slice().reverse();
  return (
    <Blueprint className="k-log k-mono" style={maxHeight ? { maxHeight } : undefined}>
      {rows.length === 0 ? (
        <div className="text-muted">{emptyLabel}</div>
      ) : (
        rows.map((l, i) => (
          <div key={`${l.t}-${i}`}>
            <span className="k-log-time">{clock(l.t)}</span> {l.line}
          </div>
        ))
      )}
    </Blueprint>
  );
}
