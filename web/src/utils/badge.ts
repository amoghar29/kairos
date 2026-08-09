import type { CSSProperties } from 'react';

import { AGE_CRITICAL, AGE_WARNING, COLORS } from '@/constants';

type Tone = { background: string; color: string; border: string };

const NEUTRAL: Tone = {
  background: COLORS.NEUTRAL_BG,
  color: COLORS.MUTED,
  border: `1px solid ${COLORS.NEUTRAL_BORDER}`,
};
const ACTIVE: Tone = {
  background: COLORS.ACCENT,
  color: COLORS.ON_ACCENT,
  border: `1px solid ${COLORS.ACCENT_BORDER}`,
};
const WARN: Tone = {
  background: COLORS.WARN_BG,
  color: COLORS.WARN_INK,
  border: `1px solid ${COLORS.WARN_BORDER}`,
};
const GOOD: Tone = {
  background: COLORS.GOOD_BG,
  color: COLORS.GOOD_INK,
  border: `1px solid ${COLORS.GOOD_BORDER}`,
};
const BAD: Tone = {
  background: COLORS.BAD_BG,
  color: COLORS.BAD_INK,
  border: `1px solid ${COLORS.BAD_BORDER}`,
};
const GHOST: Tone = {
  background: 'transparent',
  color: COLORS.DISABLED,
  border: `1px dashed ${COLORS.NEUTRAL_STRONG_BORDER}`,
};

const TONES: Record<string, Tone> = {
  pending: NEUTRAL,
  queued: {
    background: COLORS.NEUTRAL_STRONG_BG,
    color: COLORS.NEUTRAL_STRONG_INK,
    border: `1px solid ${COLORS.NEUTRAL_STRONG_BORDER}`,
  },
  running: ACTIVE,
  awaiting_retry: WARN,
  success: GOOD,
  dead: BAD,
  cancelled: GHOST,
  in_progress: ACTIVE,
  failed: BAD,
  superseded: GHOST,
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
  if (seconds > AGE_CRITICAL) return { ...base, ...BAD, fontWeight: 700 };
  if (seconds > AGE_WARNING) return { ...base, ...WARN };
  return { ...base, color: COLORS.MUTED, border: '1px solid transparent' };
}

export function priorityStyle(priority: number): CSSProperties {
  return {
    color: priority <= 2 ? COLORS.BAD_INK : priority <= 4 ? COLORS.WARN_INK : COLORS.MUTED,
    fontWeight: priority <= 2 ? 700 : 500,
  };
}

export function retryStyle(retries: number): CSSProperties {
  return { color: retries > 3 ? COLORS.BAD_INK : retries > 0 ? COLORS.WARN_INK : COLORS.FAINT };
}
