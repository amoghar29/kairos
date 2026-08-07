import { badgeStyle } from '../lib/badge';

export function Badge({ value, fontSize }: { value: string; fontSize?: string }) {
  return <span style={badgeStyle(value, fontSize)}>{value}</span>;
}
