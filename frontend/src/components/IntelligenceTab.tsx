'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
import { PageHeader, EmptyState, TableSkeleton, Skeleton, useRefreshKey } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface Anomaly {
  id: number;
  detected_at: string;
  anomaly_type: string;
  severity: string;
  entity_type: string | null;
  entity_id: string | null;
  description: string | null;
  details: Record<string, any> | null;
  acknowledged: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

interface ByType {
  anomaly_type: string;
  severity: string;
  count: number;
}

interface Summary {
  byType: ByType[];
  today: number;
  week: number;
}

// ════════════════════════════════════════════════════════════
// API helper
// ════════════════════════════════════════════════════════════
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// ════════════════════════════════════════════════════════════
// Helpers / shared styles
// ════════════════════════════════════════════════════════════
const CARD: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)' };
const TITLE: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' };

const TYPE_LABELS: Record<string, string> = {
  lease_spike: 'Lease Spike',
  after_hours_device: 'After-Hours Device',
  mac_spoofing: 'MAC Spoofing',
  subnet_jumping: 'Subnet Jumping',
  ip_conflict: 'IP Conflict',
  new_device_vip_subnet: 'New Device on Sensitive Subnet',
  dhcp_starvation: 'DHCP Starvation',
  scope_exhaustion_forecast: 'Scope Exhaustion',
};
function typeLabel(t: string | null | undefined): string {
  if (!t) return '—';
  return TYPE_LABELS[t] || t;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'badge-red',
  warning: 'badge-orange',
  info: 'badge-blue',
};

const TIME_RANGES: { label: string; value: string }[] = [
  { label: 'Today', value: 'today' },
  { label: '7 days', value: '7 days' },
  { label: '30 days', value: '30 days' },
];

// ── Stat tile ─────────────────────────────────────────────────
function StatTile({ value, label, sub, color }: { value: React.ReactNode; label: string; sub?: string; color?: string }) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: color || 'var(--navy)' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || 'var(--navy)', lineHeight: 1, letterSpacing: '-0.5px' }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginTop: 8 }}>{label}</div>
      {sub && <div style={{ ...MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const s = (severity || '').toLowerCase();
  return <span className={`badge ${SEVERITY_BADGE[s] || 'badge-blue'}`}>{(severity || 'info').toUpperCase()}</span>;
}

// ════════════════════════════════════════════════════════════
// Main component
// ════════════════════════════════════════════════════════════
export default function IntelligenceTab({ initialType }: { initialType?: string } = {}) {
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  const [summary, setSummary] = useState<Summary | null>(null);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState<number | null>(null);
  const [ackingAll, setAckingAll] = useState(false);
  const [ackedOpen, setAckedOpen] = useState(false);

  // filters
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState(initialType || '');
  const [range, setRange] = useState('7 days');

  // Seed the type filter from initialType (e.g. opened pre-filtered from the dashboard)
  useEffect(() => { if (initialType) setType(initialType); }, [initialType]);

  // since maps 'today' → '1 day' for the API window
  const since = range === 'today' ? '1 day' : range;

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ limit: '200', since });
    if (type) p.set('type', type);
    if (severity) p.set('severity', severity);
    return p.toString();
  }, [type, severity, since]);

  const loadList = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const list = await api(`/anomalies?${queryString}`);
      setAnomalies(Array.isArray(list?.data) ? list.data : []);
    } catch {
      /* ignore transient */
    }
    setLoading(false);
  }, [queryString]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await api('/anomalies/summary');
      const d = res?.data || {};
      setSummary({
        byType: Array.isArray(d.byType) ? d.byType : [],
        today: Number(d.today) || 0,
        week: Number(d.week) || 0,
      });
    } catch {
      /* ignore transient */
    }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadList(true); }, [loadList]);
  useRefreshKey(() => { loadSummary(); loadList(true); });

  // Distinct types (with their summed counts) from summary.byType
  const distinctTypes = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const b of summary?.byType || []) {
      if (b.anomaly_type && !seen.has(b.anomaly_type)) {
        seen.add(b.anomaly_type);
        out.push(b.anomaly_type);
      }
    }
    return out;
  }, [summary]);

  const mostCommon = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of summary?.byType || []) {
      if (!b.anomaly_type) continue;
      totals.set(b.anomaly_type, (totals.get(b.anomaly_type) || 0) + (Number(b.count) || 0));
    }
    let best: string | null = null;
    let bestCount = -1;
    for (const [t, c] of totals) {
      if (c > bestCount) { best = t; bestCount = c; }
    }
    return best ? typeLabel(best) : '—';
  }, [summary]);

  const acknowledge = async (id: number) => {
    setAcking(id);
    try {
      await api(`/anomalies/${id}/ack`, { method: 'POST' });
      toast('Anomaly acknowledged', 'success');
      await Promise.all([loadList(false), loadSummary()]);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setAcking(null);
  };

  const acknowledgeAll = async () => {
    setAckingAll(true);
    try {
      await api('/anomalies/acknowledge-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      toast('All anomalies acknowledged', 'success');
      await Promise.all([loadList(false), loadSummary()]);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setAckingAll(false);
  };

  // Split anomalies into open (unacknowledged) and acknowledged
  const openAnoms = useMemo(() => anomalies.filter(a => !a.acknowledged), [anomalies]);
  const ackedAnoms = useMemo(() => anomalies.filter(a => a.acknowledged), [anomalies]);

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title="Intelligence" subtitle="Behavioral & security anomaly detection" />

      {/* Stat tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        {!summary
          ? Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="kpi-card"><Skeleton height={26} width="40%" /><div style={{ height: 8 }} /><Skeleton height={12} width="70%" /></div>
            ))
          : (
            <>
              <StatTile value={summary.today} label="Anomalies Today" sub="since midnight" color="var(--primary)" />
              <StatTile value={summary.week} label="This Week" sub="last 7 days" color="var(--navy)" />
              <StatTile value={mostCommon} label="Most Common" sub="past 7 days" color="var(--blue)" />
            </>
          )}
      </div>

      {/* Filters */}
      <div style={{ ...CARD, padding: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="input" value={severity} onChange={e => setSeverity(e.target.value)}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select className="input" value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>
          {distinctTypes.map(t => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </select>
        <select className="input" value={range} onChange={e => setRange(e.target.value)}>
          {TIME_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>

      {/* Timeline */}
      <div style={CARD}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={TITLE}>Anomaly Timeline</div>
            <span style={MUTED}>{anomalies.length} events</span>
          </div>
          {canWrite && openAnoms.length > 0 && (
            <button className="btn btn-primary" disabled={ackingAll} onClick={acknowledgeAll}>
              {ackingAll ? 'Acking…' : 'Acknowledge All'}
            </button>
          )}
        </div>
        {loading ? <TableSkeleton rows={8} cols={6} /> : anomalies.length === 0 ? (
          <EmptyState
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 3 7v6c0 5 3.5 8 9 9 5.5-1 9-4 9-9V7l-9-5z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>}
            title="No anomalies detected"
            message="Behavioral and security anomalies will appear here as the collector flags unusual DHCP, DNS or IPAM activity."
          />
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Time</th>
                    <th style={{ textAlign: 'left' }}>Type</th>
                    <th style={{ textAlign: 'left' }}>Severity</th>
                    <th style={{ textAlign: 'left' }}>Entity</th>
                    <th style={{ textAlign: 'left' }}>Description</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {openAnoms.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ ...MUTED, padding: '14px 18px' }}>No open anomalies</td>
                    </tr>
                  ) : openAnoms.map(a => (
                    <tr key={a.id}>
                      <td style={{ whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-secondary)' }}>
                        {a.detected_at ? new Date(a.detected_at).toLocaleString() : '—'}
                      </td>
                      <td style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{typeLabel(a.anomaly_type)}</td>
                      <td><SeverityBadge severity={a.severity} /></td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {a.entity_type || a.entity_id
                          ? <>{a.entity_type || ''}{a.entity_type && a.entity_id ? ' · ' : ''}<span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{a.entity_id || ''}</span></>
                          : '—'}
                      </td>
                      <td style={{ fontSize: 13, color: 'var(--text-primary)' }}>{a.description || '—'}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {canWrite ? (
                          <button className="btn" disabled={acking === a.id} onClick={() => acknowledge(a.id)}>
                            {acking === a.id ? 'Acking…' : 'Acknowledge'}
                          </button>
                        ) : (
                          <span style={MUTED}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {ackedAnoms.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-light)' }}>
                <div
                  onClick={() => setAckedOpen(o => !o)}
                  style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: ackedOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}><polyline points="6 9 12 15 18 9"/></svg>
                  <span>✓ Acknowledged ({ackedAnoms.length} {ackedAnoms.length === 1 ? 'anomaly' : 'anomalies'})</span>
                </div>
                {ackedOpen && (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left' }}>Time</th>
                          <th style={{ textAlign: 'left' }}>Type</th>
                          <th style={{ textAlign: 'left' }}>Severity</th>
                          <th style={{ textAlign: 'left' }}>Entity</th>
                          <th style={{ textAlign: 'left' }}>Description</th>
                          <th style={{ textAlign: 'right' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ackedAnoms.map(a => (
                          <tr key={a.id}>
                            <td style={{ whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-muted)' }}>
                              {a.detected_at ? new Date(a.detected_at).toLocaleString() : '—'}
                            </td>
                            <td style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{typeLabel(a.anomaly_type)}</td>
                            <td><span className="badge badge-gray">{(a.severity || 'info').toUpperCase()}</span></td>
                            <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              {a.entity_type || a.entity_id
                                ? <>{a.entity_type || ''}{a.entity_type && a.entity_id ? ' · ' : ''}<span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{a.entity_id || ''}</span></>
                                : '—'}
                            </td>
                            <td style={{ fontSize: 13, color: 'var(--text-muted)' }}>{a.description || '—'}</td>
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <span style={MUTED}>✓ acked{a.acknowledged_by ? ` by ${a.acknowledged_by}` : ''}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
