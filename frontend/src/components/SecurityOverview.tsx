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

interface Anomaly {
  id?: number | string;
  detected_at: string | null;
  anomaly_type?: string;
  type?: string;
  severity: string | null;
  description?: string;
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
const TD: React.CSSProperties = { padding: '8px 12px', fontSize: 12.5, color: 'var(--text-primary)' };

function severityBadge(severity: string | null): string {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'badge-red';
  if (s === 'medium' || s === 'warning' || s === 'warn') return 'badge-orange';
  if (s === 'low' || s === 'info') return 'badge-blue';
  return 'badge-gray';
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleString();
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════
export default function SecurityOverview() {
  const [summary, setSummary] = useState<AnomalySummary | null>(null);
  const [recent, setRecent] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sumRes, recentRes] = await Promise.allSettled([
        api('/anomalies/summary'),
        api('/anomalies?limit=5'),
      ]);
      if (sumRes.status === 'fulfilled') {
        const data = sumRes.value?.data || {};
        setSummary({
          byType: Array.isArray(data.byType) ? data.byType : [],
          today: Number(data.today) || 0,
          week: Number(data.week) || 0,
        });
      } else {
        setSummary({ byType: [], today: 0, week: 0 });
      }
      if (recentRes.status === 'fulfilled') {
        setRecent(Array.isArray(recentRes.value?.data) ? recentRes.value.data : []);
      } else {
        setRecent([]);
      }
      if (sumRes.status === 'rejected' && recentRes.status === 'rejected') {
        const reason = sumRes.reason;
        setError(reason instanceof Error ? reason.message : 'Failed to load security data');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load security data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasData = (summary && (summary.today > 0 || summary.week > 0 || summary.byType.length > 0)) || recent.length > 0;

  return (
    <div style={CARD}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>Security Overview</div>
      </div>

      {loading ? (
        <TableSkeleton rows={4} cols={4} />
      ) : error ? (
        <EmptyState icon="⚠" title="Unable to load security data" message={error} />
      ) : !hasData ? (
        <EmptyState icon="🛡" title="No security anomalies detected" message="Your environment is clean." />
      ) : (
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
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

          {/* Risk distribution */}
          {summary && summary.byType.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Risk Distribution</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {summary.byType.map((t, i) => (
                  <div key={i} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                    padding: '5px 10px', fontSize: 11,
                  }}>
                    <span className={`badge ${severityBadge(t.severity)}`}>{t.severity || 'unknown'}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{t.anomaly_type}</span>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{Number(t.count) || 0}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent anomalies */}
          {recent.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Recent Anomalies</div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Detected</th>
                      <th>Type</th>
                      <th>Severity</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.slice(0, 5).map((a, i) => (
                      <tr key={a.id ?? i}>
                        <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(a.detected_at)}</td>
                        <td style={TD}>{a.anomaly_type || a.type || '—'}</td>
                        <td style={TD}><span className={`badge ${severityBadge(a.severity)}`}>{a.severity || 'unknown'}</span></td>
                        <td style={{ ...TD, fontSize: 12, color: 'var(--text-muted)' }}>{a.description || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
