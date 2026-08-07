import type { CSSProperties } from 'react';
import { AGE_CRITICAL, AGE_WARNING } from '../config';

type Tone = { background: string; color: string; border: string };

const TONES: Record<string, Tone> = {
  pending: { background: '#e7e7ea', color: '#5d5d60', border: '1px solid #d4d4d7' },
  queued: { background: '#d4d4d7', color: '#2b2b2d', border: '1px solid #b7b7ba' },
  running: {
    background: 'var(--color-accent)',
    color: '#f2f2f3',
    border: '1px solid var(--color-accent-700)',
  },
  awaiting_retry: { background: '#f4e3c0', color: '#6b4a10', border: '1px solid #d9bd7e' },
  success: { background: '#cfe6d4', color: '#1f5130', border: '1px solid #8fbb9c' },
  dead: { background: '#f3d3d1', color: '#7f2320', border: '1px solid #c98b86' },
  cancelled: { background: 'transparent', color: '#98989b', border: '1px dashed #b7b7ba' },
  in_progress: {
    background: 'var(--color-accent)',
    color: '#f2f2f3',
    border: '1px solid var(--color-accent-700)',
  },
  failed: { background: '#f3d3d1', color: '#7f2320', border: '1px solid #c98b86' },
  superseded: { background: 'transparent', color: '#98989b', border: '1px dashed #b7b7ba' },
};

export function badgeStyle(key: string, fontSize = '11px'): CSSProperties {
  return {
    display: 'inline-block',
    fontFamily: 'var(--font-heading)',
    fontWeight: 600,
    fontSize,
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    padding: '1px 7px',
    whiteSpace: 'nowrap',
    ...(TONES[key] ?? TONES.pending),
  };
}

export function ageStyle(seconds: number): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-block',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '13px',
    padding: '1px 8px',
    fontWeight: 500,
  };
  if (seconds > AGE_CRITICAL) {
    return { ...base, background: '#f3d3d1', color: '#7f2320', border: '1px solid #c98b86', fontWeight: 700 };
  }
  if (seconds > AGE_WARNING) {
    return { ...base, background: '#f4e3c0', color: '#6b4a10', border: '1px solid #d9bd7e' };
  }
  return { ...base, color: '#5d5d60', border: '1px solid transparent' };
}

export function priorityStyle(priority: number): CSSProperties {
  return {
    color: priority <= 2 ? '#7f2320' : priority <= 4 ? '#6b4a10' : '#5d5d60',
    fontWeight: priority <= 2 ? 700 : 500,
  };
}

export function retryStyle(retries: number): CSSProperties {
  return { color: retries > 3 ? '#7f2320' : retries > 0 ? '#6b4a10' : '#7a7a7d' };
}
