import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { dur } from '../lib/format';
import { useStatus } from '../lib/resource';

const NAV = [
  { href: '/', label: 'Overview', match: (p: string) => p === '/' },
  { href: '/jobs', label: 'Jobs', match: (p: string) => p.startsWith('/jobs') },
  { href: '/workers', label: 'Workers', match: (p: string) => p.startsWith('/workers') },
  { href: '/consumer', label: 'Consumer', match: (p: string) => p === '/consumer' },
  { href: '/submit', label: 'Submit', match: (p: string) => p === '/submit' },
];

export function Shell({ path, children }: { path: string; children: ReactNode }) {
  const { hidden, lastUpdated, connLost } = useStatus();

  const since = lastUpdated ? dur((Date.now() - lastUpdated) / 1000) : null;
  const pollLabel = hidden
    ? 'polling paused · tab hidden'
    : since
      ? `updated ${since} ago`
      : 'connecting…';
  const dotColor = connLost ? '#c0574f' : hidden ? '#b7b7ba' : 'var(--color-accent)';

  return (
    <div className="k-page">
      <header className="k-header">
        <div className="k-header-bar">
          <Link to="/" className="k-brand">
            <span className="k-brand-name">KAIROS</span>
            <span className="k-brand-sub">scheduler ops</span>
          </Link>
          <nav className="k-nav">
            {NAV.map((item) => (
              <Link key={item.href} to={item.href} aria-current={item.match(path) ? 'page' : undefined}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2 text-[11px] tracking-[.02em] text-muted">
            <span className="k-dot" style={{ background: dotColor }} />
            <span>{pollLabel}</span>
          </div>
        </div>
        {connLost && (
          <div className="k-banner">
            <div className="mx-auto max-w-[1480px]">
              connection lost — polling failed, showing last good data
              {since ? ` (last updated ${since} ago)` : ''}
            </div>
          </div>
        )}
      </header>

      <div className="k-shell">
        {children}

        <div className="k-footer">
          <span>
            keys: <b>g o</b> overview · <b>g j</b> jobs · <b>g w</b> workers · <b>g s</b> submit ·{' '}
            <b>j / k</b> page · <b>r</b> refresh
          </span>
          <span className="ml-auto">poll 3s · shared interval · paused when tab hidden</span>
        </div>
      </div>
    </div>
  );
}
