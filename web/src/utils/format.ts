export const EM_DASH = '—';

export function dur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function rel(iso: string | null): string {
  if (!iso) return EM_DASH;
  return `${dur((Date.now() - Date.parse(iso)) / 1000)} ago`;
}

export function relShort(iso: string | null): string {
  if (!iso) return EM_DASH;
  return dur((Date.now() - Date.parse(iso)) / 1000);
}

export function abs(iso: string | null): string {
  return iso ?? EM_DASH;
}

export function span(from: string | null, to: string | null): string {
  if (!from || !to) return EM_DASH;
  const ms = Date.parse(to) - Date.parse(from);
  return ms < 10000 ? `${(ms / 1000).toFixed(2)}s` : dur(ms / 1000);
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
