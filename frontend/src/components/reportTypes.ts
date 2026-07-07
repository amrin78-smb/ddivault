// Shared types + helpers for the reporting overhaul. No React here.

export interface ChartSeries {
  label: string;
  points: (number | null)[];
  color?: string;
}

export interface ChartSpec {
  type: 'line' | 'area' | 'bar';
  title: string;
  x: string[];
  series: ChartSeries[];
  yFormat?: 'number' | 'percent' | 'ms';
}

export interface DrillMeta {
  entity: 'scope' | 'subnet' | 'zone';
  idKey: string;
}

export type RangePreset = '24h' | '7d' | '30d' | '90d' | 'custom' | 'asof';

export interface RangeValue {
  preset: RangePreset;
  from?: string;
  to?: string;
  asOf?: string;
}

export const SERIES_COLORS = ['#3b82f6', '#C8102E', '#16a34a', '#d97706', '#8b5cf6', '#0ea5e9'];

// days each fixed preset covers
const PRESET_DAYS: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

// Convert a `YYYY-MM-DD` date-input string to an ISO timestamp.
// endOfDay=true snaps to 23:59:59.999 local time so a `to` bound is inclusive.
function dateStrToIso(d: string, endOfDay = false): string | null {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return null;
  const dt = endOfDay
    ? new Date(y, m - 1, day, 23, 59, 59, 999)
    : new Date(y, m - 1, day, 0, 0, 0, 0);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

// Convert a RangeValue to URL query params for the reports API.
export function rangeToParams(v: RangeValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v) return out;

  if (v.preset === 'custom') {
    const from = dateStrToIso(v.from || '');
    const to = dateStrToIso(v.to || '', true);
    if (from) out.from = from;
    if (to) out.to = to;
    return out;
  }

  if (v.preset === 'asof') {
    const asOf = dateStrToIso(v.asOf || '', true);
    if (asOf) out.as_of = asOf;
    return out;
  }

  const days = PRESET_DAYS[v.preset];
  if (days) {
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    out.from = from.toISOString();
    out.to = now.toISOString();
  }
  return out;
}

// Format a numeric value for axis/label display.
export function yfmt(n: number | null, f?: 'number' | 'percent' | 'ms'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (f === 'percent') return `${Math.round(n)}%`;
  if (f === 'ms') return `${Math.round(n)}ms`;
  // compact integer
  const r = Math.round(n);
  const abs = Math.abs(r);
  if (abs >= 1_000_000) return `${(r / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(r / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(r);
}
