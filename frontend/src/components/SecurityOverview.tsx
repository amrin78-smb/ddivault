'use client';

import { useState, useEffect, useCallback } from 'react';
import { EmptyState, TableSkeleton } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface AnomalyTypeRow {
  anomaly_type: string;
  severity: string;
  count: number;
}

interface AnomalySummary {
  byType: AnomalyTypeRow[];
  today: number;
  week: number;
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
// Helpers
// ════════════════════════════════════════════════════════════
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', overflow: 'hidden',
};

function severityBadge(severity: string | null): string {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'badge-red';
  if (s === 'medium' || s === 'warning' || s === 'warn') return 'badge-orange';
  if (s === 'low' || s === 'info') return 'badge-blue';
  return 'badge-gray';
}

function severityColor(severity: string | null): string {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'var(--red)';
  if (s === 'medium' || s === 'warning' || s === 'warn') return 'var(--orange)';
  if (s === 'low' || s === 'info') return 'var(--blue)';
  return 'var(--text-muted)';
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════
export default function SecurityOverview({ onViewAll }: { onViewAll?: () => void }) {
  const [summary, setSummary] = useState<AnomalySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sumRes = await api('/anomalies/summary');
      const data = sumRes?.data || {};
      setSummary({
        byType: Array.isArray(data.byType) ? data.byType : [],
        today: Number(data.today) || 0,
        week: Number(data.week) || 0,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load security data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasData = !!summary && (summary.today > 0 || summary.week > 0 || summary.byType.length > 0);

  const topTypes = summary
    ? [...summary.byType].sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0)).slice(0, 3)
    : [];
  const maxCount = topTypes.reduce((m, t) => Math.max(m, Number(t.count) || 0), 0) || 1;

  return (
    <div style={CARD}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>Security Overview</div>
        {onViewAll && (
          <button
            type="button"
            onClick={() => onViewAll?.()}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 600, fontSize: 12 }}
          >
            View all →
          </button>
        )}
      </div>

      {loading ? (
        <TableSkeleton rows={4} cols={4} />
      ) : error ? (
        <EmptyState icon="⚠" title="Unable to load security data" message={error} />
      ) : !hasData ? (
        <EmptyState icon="🛡" title="No security anomalies detected" message="Your environment is clean." />
      ) : (
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 180, overflow: 'hidden' }}>
          {/* Counts */}
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--red)' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--red)' }}>{summary?.today ?? 0}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>Anomalies today</div>
            </div>
            <div style={{ flex: 1, padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--orange)' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--orange)' }}>{summary?.week ?? 0}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>This week</div>
            </div>
          </div>

          {/* Top types */}
          {topTypes.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Top types</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {topTypes.map((t, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={`badge ${severityBadge(t.severity)}`}>{t.severity || 'unknown'}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: '0 1 auto' }}>{t.anomaly_type}</span>
                    <div style={{ flex: 1, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden', minWidth: 24 }}>
                      <div style={{ width: `${((Number(t.count) || 0) / maxCount) * 100}%`, height: '100%', background: severityColor(t.severity), borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>{Number(t.count) || 0}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
