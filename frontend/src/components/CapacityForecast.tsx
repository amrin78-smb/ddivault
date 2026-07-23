'use client';

import { useState, useEffect, useCallback } from 'react';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { forecastColor as daysToFullColor } from '@/components/palette';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface ScopeForecast {
  scope_id: string;
  scope_cidr: string;
  scope_name: string;
  server_hostname: string;
  site_id: number | string | null;
  current_pct: number | null;
  growth_rate_per_day: number | null;
  days_to_80pct: number | null;
  days_to_90pct: number | null;
  days_to_full: number | null;
  confidence: string | null;
  recommendation: string | null;
}

// ════════════════════════════════════════════════════════════
// API helper
// ════════════════════════════════════════════════════════════
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ════════════════════════════════════════════════════════════
// Styles / helpers
// ════════════════════════════════════════════════════════════
const TD: React.CSSProperties = { padding: '8px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' };
const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)' };

const CARD: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', overflow: 'hidden',
};

function num(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function confidenceBadge(confidence: string | null): string {
  const c = (confidence || '').toLowerCase();
  if (c === 'high') return 'badge-green';
  if (c === 'medium' || c === 'med') return 'badge-yellow';
  if (c === 'low') return 'badge-orange';
  return 'badge-gray';
}

function fmtDays(days: number | null): string {
  return days == null ? '—' : `${Math.round(days)}d`;
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════
export default function CapacityForecast({ onViewAll, onRowClick }: { onViewAll?: () => void; onRowClick?: (scopeId: string) => void }) {
  const [rows, setRows] = useState<ScopeForecast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api('/forecasts/scopes');
      setRows(Array.isArray(d?.data) ? d.data : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load forecasts');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = rows.filter(r => (num(r.growth_rate_per_day) ?? 0) > 0.1);
  const shown = visible.slice(0, 4);
  const extra = visible.length - shown.length;

  return (
    <div style={CARD}>
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>Capacity Forecast</div>
        {!loading && !error && visible.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {visible.length} scope{visible.length > 1 ? 's' : ''} trending up
            </div>
            {onViewAll && (
              <button
                onClick={() => onViewAll?.()}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 600, fontSize: 'var(--text-sm)' }}
              >
                View all →
              </button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <TableSkeleton rows={5} cols={7} />
      ) : error ? (
        <EmptyState icon="⚠" title="Unable to load forecasts" message={error} />
      ) : visible.length === 0 ? (
        <EmptyState icon="✓" title="No capacity concerns — all scopes healthy" message="No scopes are showing meaningful utilization growth." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Site</th>
                <th>Current %</th>
                <th>Growth/day</th>
                <th>Days to 80%</th>
                <th>Days to Full</th>
                <th>Confidence</th>
                <th>Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const daysFull = num(r.days_to_full);
                const days80 = num(r.days_to_80pct);
                const growth = num(r.growth_rate_per_day);
                const cur = num(r.current_pct);
                return (
                  <tr
                    key={r.scope_id}
                    className={onRowClick ? 'clickable' : undefined}
                    style={onRowClick ? { cursor: 'pointer' } : undefined}
                    onClick={onRowClick ? () => onRowClick(r.scope_cidr) : undefined}
                  >
                    <td style={TD}>
                      <div style={{ ...MONO, fontWeight: 600 }}>{r.scope_cidr || '—'}</div>
                      {r.scope_name && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.scope_name}</div>}
                    </td>
                    <td style={{ ...TD, color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{r.site_id != null && r.site_id !== '' ? String(r.site_id) : '—'}</td>
                    <td style={{ ...TD, fontWeight: 600 }}>{cur != null ? `${cur.toFixed(1)}%` : '—'}</td>
                    <td style={{ ...TD, ...MONO }}>{growth != null ? growth.toFixed(2) : '—'}</td>
                    <td style={TD}>{fmtDays(days80)}</td>
                    <td style={{ ...TD, fontWeight: 700, color: daysToFullColor(daysFull) }}>{fmtDays(daysFull)}</td>
                    <td style={TD}><span className={`badge ${confidenceBadge(r.confidence)}`}>{r.confidence || 'unknown'}</span></td>
                    <td style={{ ...TD, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                      <div title={r.recommendation || ''} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.recommendation || '—'}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {extra > 0 && (
            <div style={{ padding: '6px 12px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {onViewAll ? (
                <button
                  onClick={() => onViewAll?.()}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 600, fontSize: 'var(--text-xs)' }}
                >
                  +{extra} more — View all →
                </button>
              ) : (
                <>+{extra} more</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
