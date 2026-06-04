'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from '@/components/Header';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
import { useRBAC } from '@/components/RBACContext';
import { useLicense, LicenseDisabledScreen } from '@/components/LicenseGuard';
import IPAMTab    from '@/components/IPAMTab';
import DHCPTab    from '@/components/DHCPTab';
import DNSTab     from '@/components/DNSTab';
import ServersTab from '@/components/ServersTab';
import AuditTab   from '@/components/AuditTab';
import ReportsTab from '@/components/ReportsTab';
import InfraHealthTab from '@/components/InfraHealthTab';
import IntelligenceTab from '@/components/IntelligenceTab';
import SmtpSettings from '@/components/SmtpSettings';
import AlertRecipients from '@/components/AlertRecipients';
import AlertRules from '@/components/AlertRules';
import CapacityForecast from '@/components/CapacityForecast';
import SiteHealth from '@/components/SiteHealth';
import SecurityOverview from '@/components/SecurityOverview';
import DeviceDonut from '@/components/DeviceDonut';
import { ApiKeysSection } from '@/components/ApiKeysSection';
import {
  PageHeader, EmptyState, UtilBar, Trend, TableSkeleton, Skeleton, pctColor,
} from '@/components/ui';

// ── Types ─────────────────────────────────────────────────────
interface Scope {
  id: number;
  scope_id: string;
  name: string;
  start_range: string;
  end_range: string;
  total_ips: number;
  in_use: number;
  free: number;
  reserved: number;
  percent_used: number;
  state: string;
  server_hostname: string;
  server_ip: string;
  last_updated: string;
}

interface DhcpEvent {
  id: number;
  event_id: number;
  event_type: string;
  ip_address: string;
  hostname: string;
  mac_address: string;
  description: string;
  event_time: string;
}

interface AlertEvent {
  id: number;
  message: string;
  severity: string;
  scope_id: string;
  acknowledged: boolean;
  fired_at: string;
  rule_name: string;
}

interface ScopeHistory {
  scope_id: string;
  name: string;
  history: { percent_used: number; in_use: number; recorded_at: string }[];
}

type Tab = 'dashboard' | 'scopes' | 'ipam' | 'dns' | 'events' | 'intelligence' | 'servers' | 'infra' | 'reports' | 'audit' | 'settings';

// ── Shared styles ─────────────────────────────────────────────
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow-sm)',
};
const TITLE: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' };

// ── Section header (compact, uppercase) ───────────────────────
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 12, marginTop: 4 }}>
      {children}
    </div>
  );
}

// ── API helper ────────────────────────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Event type badge ──────────────────────────────────────────
const EVENT_BADGE: Record<string, string> = {
  Assign: 'badge-green', Renew: 'badge-blue', Release: 'badge-gray',
  ScopeFull: 'badge-red', ScopeWarning: 'badge-yellow', Conflict: 'badge-red',
  NACK: 'badge-orange', RogueDHCP: 'badge-red', Expired: 'badge-gray',
};
function EventTypeBadge({ type }: { type: string }) {
  return <span className={`badge ${EVENT_BADGE[type] || 'badge-gray'}`}>{type || '—'}</span>;
}

// ── Sparkline (inline SVG, 7-day trend) ───────────────────────
function Sparkline({ data, color, width = 220, height = 44 }: {
  data: { percent_used: number }[]; color: string; width?: number; height?: number;
}) {
  if (data.length < 2) return <div style={{ height, ...MUTED, display: 'flex', alignItems: 'center' }}>Not enough history</div>;
  const max = Math.max(100, ...data.map(d => d.percent_used));
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (d.percent_used / max) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${height} ${pts.join(' ')} ${width},${height}`;
  const lastX = width, lastY = height - (data[data.length - 1].percent_used / max) * height;
  const gid = `spark-${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg width={width} height={height} style={{ display: 'block', width: '100%' }} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="2.5" fill={color} />
    </svg>
  );
}

// ── Donut chart (IP status distribution) ──────────────────────
function Donut({ data, dim = 110 }: { data: { label: string; value: number; color: string }[]; dim?: number }) {
  const total = data.reduce((a, b) => a + b.value, 0);
  if (total === 0) return <div style={{ ...MUTED, padding: 20, textAlign: 'center' }}>No address data yet</div>;
  const R = 52, SW = 18, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <svg width={dim} height={dim} viewBox="0 0 140 140" style={{ flexShrink: 0 }}>
        <g transform="rotate(-90 70 70)">
          {data.filter(d => d.value > 0).map((d, i) => {
            const frac = d.value / total;
            const dash = frac * C;
            const seg = <circle key={i} cx="70" cy="70" r={R} fill="none" stroke={d.color} strokeWidth={SW} strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset} />;
            offset += dash;
            return seg;
          })}
        </g>
        <text x="70" y="66" textAnchor="middle" fontSize="22" fontWeight="800" fill="var(--text-primary)">{total}</text>
        <text x="70" y="84" textAnchor="middle" fontSize="10" fill="var(--text-muted)">addresses</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.map(d => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text-secondary)', minWidth: 76 }}>{d.label}</span>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Simple line chart (lease trend) ───────────────────────────
function LineChart({ points, color = 'var(--blue)', height = 120 }: { points: number[]; color?: string; height?: number }) {
  if (points.length < 2) return <div style={{ ...MUTED, height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Not enough history yet</div>;
  const W = 480, H = height, pad = 8;
  const max = Math.max(1, ...points), min = Math.min(...points);
  const span = Math.max(1, max - min);
  const xy = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (W - pad * 2);
    const y = pad + (1 - (p - min) / span) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon points={`${pad},${H - pad} ${xy.join(' ')} ${W - pad},${H - pad}`} fill={color} opacity="0.08" />
      <polyline points={xy.join(' ')} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: DASHBOARD — operations center
// ════════════════════════════════════════════════════════════
function DashboardTab({ onNavigate, onFocusScope }: { onNavigate: (tab: Tab) => void; onFocusScope: (scopeId: string) => void }) {
  const [stats, setStats]   = useState<any>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeHistory, setScopeHistory] = useState<ScopeHistory[]>([]);
  const [events, setEvents] = useState<DhcpEvent[]>([]);
  const [infra, setInfra]   = useState<any>(null);
  const [ipDist, setIpDist] = useState<Record<string, number> | null>(null);
  const [leaseTrend, setLeaseTrend] = useState<{ day: string; leases: number }[]>([]);
  const [audit, setAudit]   = useState<any[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api('/dashboard/stats'),
      api('/scopes'),
      api('/dashboard/recent-events?limit=20'),
      api('/scopes/history/all?hours=168'),
      api('/infrastructure/health'),
      api('/dashboard/ip-distribution'),
      api('/dashboard/lease-trend?days=7'),
      api('/audit?limit=10'),
      api('/alerts?limit=10'),
    ]);
    const [s, sc, ev, hist, inf, dist, lt, au, al] = results;
    if (s.status  === 'fulfilled') setStats(s.value);
    if (sc.status === 'fulfilled') setScopes(sc.value.data || []);
    if (ev.status === 'fulfilled') setEvents(ev.value.data || []);
    if (hist.status === 'fulfilled') setScopeHistory(hist.value.data || []);
    if (inf.status === 'fulfilled') setInfra(inf.value);
    if (dist.status === 'fulfilled') setIpDist(dist.value.data || null);
    if (lt.status === 'fulfilled') setLeaseTrend((lt.value.data || []).map((d: any) => ({ day: d.day, leases: parseInt(d.leases) || 0 })));
    if (au.status === 'fulfilled') setAudit(au.value.data || []);
    if (al.status === 'fulfilled') setAlerts((al.value.data || []).filter((a: AlertEvent) => !a.acknowledged));
    setLoading(false);
  }, []);

  const ackAlert = useCallback(async (id: number) => {
    await api(`/alerts/${id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin' }) }).catch(() => {});
    setAlerts(prev => prev.filter(a => a.id !== id));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  // Trends derived from real history (start vs end of window)
  const trends = useMemo(() => {
    let critNow = 0, critThen = 0, warnNow = 0, warnThen = 0, usedNow = 0, usedThen = 0;
    for (const sh of scopeHistory) {
      const h = sh.history || [];
      if (!h.length) continue;
      const first = h[0], last = h[h.length - 1];
      if (last.percent_used >= 90) critNow++;
      if (first.percent_used >= 90) critThen++;
      if (last.percent_used >= 80 && last.percent_used < 90) warnNow++;
      if (first.percent_used >= 80 && first.percent_used < 90) warnThen++;
      usedNow += last.in_use || 0; usedThen += first.in_use || 0;
    }
    return { crit: critNow - critThen, warn: warnNow - warnThen, used: usedNow - usedThen };
  }, [scopeHistory]);

  const attention = useMemo(
    () => scopes
      .map(s => ({ ...s, pct: parseFloat(String(s.percent_used)) }))
      .filter(s => s.pct >= 80)
      .sort((a, b) => b.pct - a.pct),
    [scopes],
  );

  const topByUtil = useMemo(() => {
    const latest = (sh: ScopeHistory) => sh.history?.[sh.history.length - 1]?.percent_used ?? 0;
    return [...scopeHistory].filter(sh => (sh.history?.length ?? 0) >= 2).sort((a, b) => latest(b) - latest(a)).slice(0, 6);
  }, [scopeHistory]);

  const kpis = stats ? [
    { label: 'Managed IPs',     value: stats.ips?.total ?? 0,       sub: 'across all scopes',         color: 'var(--navy)',  delta: 0,            invert: false },
    { label: 'Active Leases',   value: stats.active_leases ?? 0,    sub: 'live DHCP clients',         color: 'var(--blue)',  delta: trends.used,  invert: true },
    { label: 'DNS Zones',       value: stats.dns_zones ?? 0,        sub: 'forward & reverse',         color: 'var(--teal)',  delta: 0,            invert: false },
    { label: 'Critical Scopes', value: stats.scopes?.critical ?? 0, sub: '≥ 90% utilization',         color: (stats.scopes?.critical ?? 0) > 0 ? 'var(--red)' : 'var(--green)',    delta: trends.crit, invert: false },
    { label: 'Unknown Devices', value: ipDist?.unknown ?? 0,        sub: 'rogue / unmanaged',         color: (ipDist?.unknown ?? 0) > 0 ? 'var(--yellow)' : 'var(--green)', delta: 0, invert: false },
    { label: 'Open Alerts',     value: stats.unacked_alerts ?? 0,   sub: 'unacknowledged',            color: (stats.unacked_alerts ?? 0) > 0 ? 'var(--red)' : 'var(--green)',  delta: 0, invert: false },
  ] : [];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title="Operations Center" subtitle="Live DDI health — scope exhaustion, recent activity, and utilization trends. Refreshes every 30s." />

      {/* Real-time status strip */}
      {(() => {
        const ov = infra?.overall || 'healthy';
        const c = ov === 'critical' ? 'var(--red)' : ov === 'warning' ? 'var(--yellow)' : 'var(--green)';
        const txt = ov === 'critical' ? 'Critical issues detected' : ov === 'warning' ? 'Warnings present' : 'All systems healthy';
        const srvCount = infra?.data?.length ?? 0;
        return (
          <div onClick={() => onNavigate('infra')} className="clickable" style={{ borderRadius: 'var(--radius)', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 14, background: c, color: '#fff', cursor: 'pointer', boxShadow: 'var(--shadow-sm)' }}>
            <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#fff', boxShadow: '0 0 0 4px rgba(255,255,255,0.3)' }} />
            <span style={{ fontWeight: 700, fontSize: 14 }}>{txt}</span>
            <span style={{ opacity: 0.9, fontSize: 12.5 }}>{srvCount} server{srvCount === 1 ? '' : 's'} monitored{infra?.worst_score != null && ` · lowest health ${infra.worst_score}/100`}</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12.5, opacity: 0.9 }}>Infrastructure →</span>
          </div>
        );
      })()}

      {/* Infrastructure status — server health cards */}
      {(infra?.data?.length ?? 0) > 0 && (
        <div style={CARD}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={TITLE}>Infrastructure Status</div>
            <span style={MUTED}>{infra.data.length} servers</span>
          </div>
          <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {infra.data.map((s: any) => {
              const score = s.health_score;
              const col = score == null ? 'var(--text-muted)' : score >= 90 ? 'var(--green)' : score >= 70 ? 'var(--yellow)' : 'var(--red)';
              return (
                <div key={s.id} onClick={() => onNavigate('infra')} className="clickable" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderLeft: `4px solid ${col}`, borderRadius: 10, padding: 12, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.hostname}</div>
                      <div style={{ ...MUTED, fontFamily: "'JetBrains Mono', monospace" }}>{s.ip}</div>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: col, lineHeight: 1 }}>{score ?? '—'}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <span className="badge badge-gray">{(s.role || '').toUpperCase()}</span>
                    <span className={`badge ${s.winrm_test_ok === false ? 'badge-red' : s.winrm_test_ok ? 'badge-green' : 'badge-gray'}`}>WinRM</span>
                  </div>
                  <div style={{ ...MUTED, marginTop: 8 }}>{s.scope_count} scopes · {s.zone_count} zones</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 2 — KPI tiles (6 across, compact) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
        {loading && !stats
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="kpi-card" style={{ borderLeftColor: 'var(--border)', padding: '14px 16px' }}>
                <Skeleton height={28} width="45%" /><div style={{ height: 6 }} /><Skeleton height={12} width="75%" />
              </div>
            ))
          : kpis.map((k, i) => (
              <div key={i} className="kpi-card" style={{ borderLeftColor: k.color, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: k.color, lineHeight: 1, letterSpacing: '-0.5px' }}>{k.value}</div>
                  <Trend delta={k.delta} invert={k.invert} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginTop: 6 }}>{k.label}</div>
                <div style={{ ...MUTED, marginTop: 2 }}>{k.sub}</div>
              </div>
            ))}
      </div>

      {/* Row 3 — DHCP Overview: attention table (60%) + lease trend (40%) */}
      <div>
        <SectionHeader>DHCP Overview</SectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 16 }}>
          <div style={CARD}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={TITLE}>Scopes Requiring Attention</div>
              <span style={MUTED}>{attention.length} over 80%</span>
            </div>
            {loading ? <TableSkeleton rows={5} cols={3} /> : attention.length === 0 ? (
              <EmptyState
                icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>}
                title="All scopes healthy"
                message="No DHCP scope is above 80% utilization."
              />
            ) : (
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th>Scope</th><th>Used / Total</th><th style={{ minWidth: 150 }}>Utilization</th></tr></thead>
                  <tbody>
                    {attention.map(s => (
                      <tr key={s.id} className="clickable" onClick={() => onFocusScope(s.scope_id)}>
                        <td style={{ padding: '8px 12px' }}>
                          <div style={{ fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}>{s.scope_id}</div>
                          <div style={{ ...MUTED, marginTop: 1 }}>{s.name || s.server_hostname || '—'}</div>
                        </td>
                        <td className="mono" style={{ padding: '8px 12px', fontSize: 12.5, whiteSpace: 'nowrap' }}>
                          {s.in_use} / {s.total_ips}
                          {s.free < 10 && <span style={{ color: 'var(--red)', fontWeight: 700 }}> · {s.free} left</span>}
                        </td>
                        <td style={{ padding: '8px 12px' }}><UtilBar pct={s.pct} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={CARD}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={TITLE}>Active Lease Trend</div>
              <span style={MUTED}>last 7 days</span>
            </div>
            <div style={{ padding: '16px 20px' }}>
              {loading ? <Skeleton height={180} /> : <LineChart points={leaseTrend.map(d => d.leases)} height={180} />}
            </div>
          </div>
        </div>
      </div>

      {/* Row 4 — Recent activity + capacity forecast */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={CARD}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={TITLE}>Recent Activity</div>
            <button onClick={() => onNavigate('events')} style={{ ...MUTED, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 600 }}>
              View all →
            </button>
          </div>
          {loading ? <TableSkeleton rows={8} cols={4} /> : events.length === 0 ? (
            <EmptyState title="No recent activity" message="DHCP log events will appear here as they are collected." />
          ) : (
            <div style={{ maxHeight: 340, overflow: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Type</th><th>IP Address</th><th>Hostname</th><th>Time</th></tr></thead>
                <tbody>
                  {events.map(e => (
                    <tr key={e.id}>
                      <td style={{ padding: '8px 12px' }}><EventTypeBadge type={e.event_type} /></td>
                      <td className="mono" style={{ padding: '8px 12px', fontSize: 12.5 }}>{e.ip_address || '—'}</td>
                      <td style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--text-secondary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.hostname || '—'}</td>
                      <td className="mono" style={{ ...MUTED, padding: '8px 12px', whiteSpace: 'nowrap' }}>{e.event_time ? new Date(e.event_time).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <CapacityForecast />
      </div>

      {/* Row 5 — Intelligence & Security */}
      <div>
        <SectionHeader>Intelligence &amp; Security</SectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <SecurityOverview />
          <SiteHealth />
        </div>
      </div>

      {/* Row 6 — IPAM Overview: IP distribution donut (40%) + device mix (60%) */}
      <div>
        <SectionHeader>IPAM Overview</SectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: 16 }}>
          <div style={CARD}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)' }}><div style={TITLE}>IP Address Distribution</div></div>
            <div style={{ padding: '16px 20px' }}>
              {loading ? <Skeleton height={110} /> : (
                <Donut dim={110} data={[
                  { label: 'Available', value: ipDist?.available ?? 0, color: 'var(--green)' },
                  { label: 'DHCP', value: ipDist?.dhcp ?? 0, color: 'var(--blue)' },
                  { label: 'Reserved', value: ipDist?.reserved ?? 0, color: 'var(--teal)' },
                  { label: 'Unknown', value: ipDist?.unknown ?? 0, color: 'var(--yellow)' },
                  { label: 'Offline', value: ipDist?.offline ?? 0, color: 'var(--text-muted)' },
                ]} />
              )}
            </div>
          </div>
          <DeviceDonut />
        </div>
      </div>

      {/* Utilization trends — top 6 scopes by utilization */}
      <div style={CARD}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={TITLE}>Utilization Trends</div>
          <span style={MUTED}>Top 6 scopes · last 7 days</span>
        </div>
        <div style={{ padding: '16px 20px' }}>
          {loading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={70} />)}
            </div>
          ) : topByUtil.length === 0 ? (
            <EmptyState title="No trend data yet" message="Utilization history accumulates as scopes are polled over time." />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
              {topByUtil.map(sh => {
                const latest = sh.history[sh.history.length - 1].percent_used;
                const first = sh.history[0].percent_used;
                const color = pctColor(latest);
                return (
                  <div key={sh.scope_id} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>{sh.scope_id}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color }}>{latest.toFixed(1)}%</span>
                        <Trend delta={latest - first} invert={false} />
                      </div>
                    </div>
                    <Sparkline data={sh.history} color={color} />
                    <div style={{ ...MUTED, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sh.name || sh.scope_id}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Row 7 — Open Alerts (primary) + Recent Changes, full width at bottom */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={CARD}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={TITLE}>Open Alerts</div>
            <button onClick={() => onNavigate('events')} style={{ ...MUTED, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 600 }}>View all →</button>
          </div>
          {loading ? <TableSkeleton rows={4} cols={2} /> : alerts.length === 0 ? (
            <EmptyState title="No open alerts" message="All fired alerts have been acknowledged." />
          ) : (
            <table className="data-table">
              <tbody>
                {alerts.slice(0, 5).map(a => (
                  <tr key={a.id}>
                    <td style={{ padding: '8px 12px', width: 70 }}><span className={`badge ${a.severity === 'critical' ? 'badge-red' : 'badge-yellow'}`}>{a.severity}</span></td>
                    <td style={{ padding: '8px 12px', fontSize: 12.5 }}>{a.message}</td>
                    <td style={{ padding: '8px 12px', width: 50 }}><button onClick={() => ackAlert(a.id)} style={{ fontSize: 11, color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer' }}>Ack</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={CARD}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={TITLE}>Recent Changes</div>
            <button onClick={() => onNavigate('audit')} style={{ ...MUTED, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 600 }}>Audit log →</button>
          </div>
          {loading ? <TableSkeleton rows={4} cols={3} /> : audit.length === 0 ? (
            <EmptyState title="No changes yet" message="Configuration changes will appear here as they happen." />
          ) : (
            <table className="data-table">
              <tbody>
                {audit.map((a: any) => (
                  <tr key={a.id}>
                    <td style={{ padding: '8px 12px', width: 70 }}><span className={`badge ${a.action === 'create' ? 'badge-green' : a.action === 'delete' ? 'badge-red' : a.action === 'modify' ? 'badge-yellow' : 'badge-gray'}`}>{(a.action || '').toUpperCase()}</span></td>
                    <td style={{ padding: '8px 12px', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{a.change_summary || `${a.action} ${a.entity_type}`}<div style={MUTED}>{a.username}</div></td>
                    <td style={{ ...MUTED, padding: '8px 12px', whiteSpace: 'nowrap', width: 90 }}>{a.timestamp ? new Date(a.timestamp).toLocaleTimeString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: EVENTS & ALERTS
// ════════════════════════════════════════════════════════════
function EventsTab() {
  const [events, setEvents]   = useState<DhcpEvent[]>([]);
  const [alerts, setAlerts]   = useState<AlertEvent[]>([]);
  const [evTotal, setEvTotal] = useState(0);
  const [alTotal, setAlTotal] = useState(0);
  const [page, setPage]       = useState(1);
  const [hours, setHours]     = useState(24);
  const [typeFilter, setTypeFilter] = useState('');
  const [view, setView]       = useState<'alerts' | 'events'>('alerts');
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: '50', hours: String(hours) });
    if (typeFilter) params.set('type', typeFilter);
    api(`/events?${params}`).then(d => { setEvents(d.data || []); setEvTotal(d.total || 0); }).catch(() => {});
    api('/alerts?limit=50').then(d => { setAlerts(d.data || []); setAlTotal(d.total || 0); }).catch(() => {});
  }, [page, hours, typeFilter]);

  const reloadAlerts = () => api('/alerts?limit=50').then(d => { setAlerts(d.data || []); setAlTotal(d.total || 0); }).catch(() => {});

  const ack = async (id: number) => {
    await api(`/alerts/${id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin' }) });
    toast('Alert acknowledged', 'success');
    reloadAlerts();
  };
  const ackAll = async () => {
    await api('/alerts/acknowledge-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin' }) });
    toast('All alerts acknowledged', 'success');
    reloadAlerts();
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title="Events & Alerts" subtitle="Fired alerts and the raw DHCP event log from your servers">
        <div className="segmented">
          <button className={view === 'alerts' ? 'active' : ''} onClick={() => setView('alerts')}>Alerts ({alTotal})</button>
          <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>DHCP Events ({evTotal})</button>
        </div>
      </PageHeader>

      {view === 'alerts' && (
        <div style={CARD}>
          <div style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-light)' }}>
            <div style={TITLE}>Alert History</div>
            {alerts.some(a => !a.acknowledged) && <button className="btn btn-primary" onClick={ackAll}>Acknowledge All</button>}
          </div>
          <table className="data-table">
            <thead><tr><th>Severity</th><th>Message</th><th>Scope</th><th>Fired</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {alerts.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 28, ...MUTED }}>No alerts</td></tr>}
              {alerts.map(a => (
                <tr key={a.id}>
                  <td><span className={`badge ${a.severity === 'critical' ? 'badge-red' : 'badge-yellow'}`}>{a.severity}</span></td>
                  <td>{a.message}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{a.scope_id || '—'}</td>
                  <td style={{ fontSize: 11 }}>{new Date(a.fired_at).toLocaleString()}</td>
                  <td><span className={`badge ${a.acknowledged ? 'badge-gray' : 'badge-red'}`}>{a.acknowledged ? 'ACK' : 'Open'}</span></td>
                  <td>{!a.acknowledged && <button onClick={() => ack(a.id)} style={{ fontSize: 11, color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer' }}>Ack</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'events' && (
        <div style={CARD}>
          <div style={{ padding: '12px 18px', display: 'flex', gap: 10, alignItems: 'center', borderBottom: '1px solid var(--border-light)' }}>
            <div style={TITLE}>DHCP Event Log</div>
            <div style={{ flex: 1 }} />
            <select className="input" value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(1); }}>
              <option value="">All types</option>
              {['Assign','Renew','Release','Conflict','ScopeFull','ScopeWarning','NACK','RogueDHCP'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="input" value={hours} onChange={e => { setHours(parseInt(e.target.value)); setPage(1); }}>
              {[1,6,24,48,168].map(h => <option key={h} value={h}>Last {h}h</option>)}
            </select>
          </div>
          <table className="data-table">
            <thead><tr><th>Time</th><th>Type</th><th>IP</th><th>Hostname</th><th>MAC</th><th>Description</th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 28, ...MUTED }}>No events</td></tr>}
              {events.map(e => (
                <tr key={e.id}>
                  <td style={{ fontSize: 11 }}>{e.event_time ? new Date(e.event_time).toLocaleString() : '—'}</td>
                  <td><EventTypeBadge type={e.event_type} /></td>
                  <td className="mono">{e.ip_address || '—'}</td>
                  <td>{e.hostname || '—'}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{e.mac_address || '—'}</td>
                  <td style={{ fontSize: 11, ...MUTED, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: 12 }}>
            {page > 1 && <button className="btn" onClick={() => setPage(p => p - 1)}>← Prev</button>}
            <span style={{ ...MUTED, padding: '6px 0' }}>Page {page} · {evTotal} events</span>
            {events.length === 50 && <button className="btn" onClick={() => setPage(p => p + 1)}>Next →</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: SETTINGS
// ════════════════════════════════════════════════════════════
function SettingField({ label, value, settingKey, placeholder, helpText, type, onSave }: {
  label: string; value: string; settingKey: string; placeholder?: string; helpText?: string; type?: string;
  onSave: (key: string, value: string) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        className="input" style={{ width: '100%' }} type={type} defaultValue={value} placeholder={placeholder}
        onBlur={e => { if (e.target.value !== value) onSave(settingKey, e.target.value); }}
      />
      {helpText && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{helpText}</div>}
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const { toast } = useToast();

  useEffect(() => { api('/settings').then(d => setSettings(d.data || {})).catch(() => {}); }, []);

  const save = useCallback(async (key: string, value: string) => {
    await api('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
    setSettings(prev => ({ ...prev, [key]: value }));
    toast('Saved', 'success');
  }, [toast]);

  const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border-light)' };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader title="Settings" subtitle="Configure DDIVault thresholds, scanning, and data retention" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ ...CARD, padding: 20 }}>
          <div style={sectionTitle}>Branding</div>
          <SettingField label="App Name" value={settings.app_name || ''} settingKey="app_name" placeholder="DDIVault" onSave={save} />
          <SettingField label="Company Name" value={settings.company_name || ''} settingKey="company_name" placeholder="Your Company" onSave={save} />
        </div>
        <div style={{ ...CARD, padding: 20 }}>
          <div style={sectionTitle}>IPAM Scan Settings</div>
          <SettingField label="DNS Server for Scans" value={settings.scan_dns_server || ''} settingKey="scan_dns_server" placeholder="e.g. 192.168.1.10 (leave blank for system default)" helpText="Used for PTR / reverse DNS lookups during IPAM subnet scans." onSave={save} />
          <SettingField label="Scope Warning Threshold (%)" value={settings.scope_warning_pct || '80'} settingKey="scope_warning_pct" type="number" onSave={save} />
          <SettingField label="Scope Critical Threshold (%)" value={settings.scope_critical_pct || '90'} settingKey="scope_critical_pct" type="number" onSave={save} />
        </div>
        <div style={{ ...CARD, padding: 20 }}>
          <div style={sectionTitle}>Data Retention</div>
          <SettingField label="Retention Period (days)" value={settings.retention_days || ''} settingKey="retention_days" placeholder="90" helpText="DHCP events and scan history older than this are cleaned up automatically." onSave={save} />
        </div>
        <div style={{ ...CARD, padding: 20 }}>
          <div style={sectionTitle}>About</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 2 }}>
            <div><strong>DDIVault</strong> <span style={MUTED}>v1.0.0</span></div>
            <div style={MUTED}>Part of the NocVault network intelligence suite</div>
            <div style={{ marginTop: 12 }}>
              <a href={`${process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000'}/launcher`} style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: 13, fontWeight: 500 }}>← NocVault Hub</a>
            </div>
          </div>
        </div>

        {/* API key management spans the full grid width */}
        <ApiKeysSection />

        <div style={{ ...CARD, padding: 20, gridColumn: '1 / -1' }}>
          <div style={sectionTitle}>Email / SMTP</div>
          <SmtpSettings />
        </div>
        <div style={{ ...CARD, padding: 20, gridColumn: '1 / -1' }}>
          <div style={sectionTitle}>Alert Recipients</div>
          <AlertRecipients />
        </div>
        <div style={{ ...CARD, padding: 20, gridColumn: '1 / -1' }}>
          <div style={sectionTitle}>Alert Rules</div>
          <AlertRules />
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// SIDEBAR + APP SHELL
// ════════════════════════════════════════════════════════════
const ICONS: Record<string, React.ReactNode> = {
  dashboard: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  scopes:    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  ipam:      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  dns:       <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
  events:    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  intelligence: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/><line x1="9" y1="21" x2="15" y2="21"/></svg>,
  servers:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  settings:  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  infra:     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  reports:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  audit:     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
};

const SIDEBAR_ITEMS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'scopes',    label: 'DHCP' },
  { id: 'ipam',      label: 'IPAM' },
  { id: 'dns',       label: 'DNS' },
  { id: 'events',    label: 'Events & Alerts' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'servers',   label: 'Known Servers' },
  { id: 'infra',     label: 'Infrastructure' },
  { id: 'reports',   label: 'Reports' },
  { id: 'audit',     label: 'Audit Log' },
  { id: 'settings',  label: 'Settings' },
];

export default function DDIVaultApp() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [collectorOnline, setCollectorOnline] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [focusScope, setFocusScope] = useState<string | null>(null);
  const { canManageSystem, isViewer, isSiteAdmin } = useRBAC();
  const { state: licenseState, loading: licenseLoading } = useLicense();

  // Settings is super_admin only; Audit Log is hidden from viewers and site_admins.
  const visibleItems = useMemo(() => SIDEBAR_ITEMS.filter(item => {
    if (item.id === 'settings') return canManageSystem;
    if (item.id === 'audit')    return !isViewer && !isSiteAdmin;
    return true;
  }), [canManageSystem, isViewer, isSiteAdmin]);

  // If the active tab is no longer permitted, fall back to the dashboard.
  useEffect(() => {
    if (!visibleItems.some(i => i.id === tab)) setTab('dashboard');
  }, [visibleItems, tab]);

  useEffect(() => {
    const check = () => fetch('/api/health').then(r => setCollectorOnline(r.ok)).catch(() => setCollectorOnline(false));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  // Global keyboard shortcut: "R" refreshes the current tab (broadcast event)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (typing) return;
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        window.dispatchEvent(new Event('ddivault:refresh'));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const navigate = useCallback((t: Tab) => { setTab(t); }, []);
  const focusScopeNav = useCallback((scopeId: string) => { setFocusScope(scopeId); setTab('scopes'); }, []);

  const sidebarWidth = collapsed ? 64 : 240;

  if (!licenseLoading && licenseState.disabled) {
    return <LicenseDisabledScreen />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header collectorOnline={collectorOnline} onNavigate={navigate} />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Sidebar */}
        <nav style={{
          width: sidebarWidth, background: '#1a2744', display: 'flex', flexDirection: 'column',
          flexShrink: 0, overflowY: 'auto', overflowX: 'hidden', paddingTop: 8, paddingBottom: 12,
          transition: 'width 0.18s ease',
        }}>
          {!collapsed && (
            <div style={{ padding: '12px 20px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase' }}>
              Navigation
            </div>
          )}
          {collapsed && <div style={{ height: 12 }} />}

          {visibleItems.map(item => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                title={collapsed ? item.label : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  padding: collapsed ? '11px 0' : '11px 20px',
                  margin: '1px 10px', background: active ? 'rgba(200,16,46,0.15)' : 'transparent',
                  border: 'none', borderRadius: 10,
                  color: active ? '#fff' : 'rgba(255,255,255,0.5)', cursor: 'pointer',
                  fontSize: 13.5, fontWeight: active ? 600 : 400, textAlign: 'left',
                  width: 'calc(100% - 20px)', transition: 'all 0.15s', position: 'relative',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; } }}
              >
                {active && <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: 3, height: 20, background: '#C8102E', borderRadius: '0 3px 3px 0' }} />}
                <span style={{ color: active ? '#C8102E' : 'rgba(255,255,255,0.45)', flexShrink: 0, display: 'flex' }}>{ICONS[item.id]}</span>
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}

          <div style={{ flex: 1 }} />

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, justifyContent: collapsed ? 'center' : 'flex-start',
              margin: '4px 10px', padding: collapsed ? '10px 0' : '10px 20px', width: 'calc(100% - 20px)',
              background: 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer',
              color: 'rgba(255,255,255,0.4)', fontSize: 12.5, transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}>
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            {!collapsed && <span>Collapse</span>}
          </button>

          {!collapsed && <div style={{ padding: '6px 20px', fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>DDIVault v1.0</div>}
        </nav>

        {/* Content area */}
        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}>
          <ErrorBoundary name={tab}>
            {tab === 'dashboard' && <DashboardTab onNavigate={navigate} onFocusScope={focusScopeNav} />}
            {tab === 'scopes'    && <DHCPTab focusScope={focusScope} />}
            {tab === 'ipam'      && <IPAMTab />}
            {tab === 'dns'       && <DNSTab />}
            {tab === 'events'    && <EventsTab />}
            {tab === 'intelligence' && <IntelligenceTab />}
            {tab === 'servers'   && <ServersTab />}
            {tab === 'infra'     && <InfraHealthTab />}
            {tab === 'reports'   && <ReportsTab />}
            {tab === 'audit'     && !isViewer && !isSiteAdmin && <AuditTab />}
            {tab === 'settings'  && canManageSystem && <SettingsTab />}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
