import type { ReactNode } from 'react';

import type { ApiError } from '@/services/api';

import { Blueprint } from './Blueprint';

export function LoadingPanel({ label }: { label: string }) {
  return <Blueprint className="k-panel-note">loading {label}</Blueprint>;
}

export function ErrorPanel({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <Blueprint className="k-panel-error">
      <div className="k-kicker mb-1 text-bad-ink">error · {error.label}</div>
      <div className="mb-2.5 text-[13.5px] text-bad-deep">{error.message}</div>
      {error.fields && (
        <ul className="mb-2.5 list-none space-y-0.5 p-0 text-[12.5px] text-bad-deep">
          {Object.entries(error.fields).map(([field, detail]) => (
            <li key={field}>
              <span className="k-mono">{field}</span> — {detail}
            </li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </Blueprint>
  );
}

export function EmptyPanel({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Blueprint className="k-panel-empty">
      <div className="font-cond text-[17px] font-semibold">{title}</div>
      {detail && (
        <div className="mx-auto mt-1.5 max-w-[520px] text-[12.5px] text-muted">{detail}</div>
      )}
      {action && <div className="mt-3.5">{action}</div>}
    </Blueprint>
  );
}
