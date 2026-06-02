'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from '@/components/Header';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
import IPAMTab    from '@/components/IPAMTab';
import DHCPTab    from '@/components/DHCPTab';
import DNSTab     from '@/components/DNSTab';
import ServersTab from '@/components/ServersTab';
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

type Tab = 'dashboard' | 'scopes' | 'ipam' | 'dns' | 'events' | 'servers' | 'settings';

// ── Shared styles ─────────────────────────────────────────────
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow-sm)',
};
const TITLE: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' };

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

// ════════════════════════════════════════════════════════════
// TAB: DASHBOARD — operations center
// ════════════════════════════════════════════════════════════
function DashboardTab({ onNavigate, onFocusScope }: { onNavigate: (tab: Tab) => void; onFocusScope: (scopeId: string) => void }) {
  const [stats, setStats]   = useState<any>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeHistory, setScopeHistory] = useState<ScopeHistory[]>([]);
  const [events, setEvents] = useState<DhcpEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api('/dashboard/stats'),
      api('/scopes'),
      api('/dashboard/recent-events?limit=20'),
      api('/scopes/history/all?hours=168'),
    ]);
    const [s, sc, ev, hist] = results;
    if (s.status  === 'fulfilled') setStats(s.value);
    if (sc.status === 'fulfilled') setScopes(sc.value.data || []);
    if (ev.status === 'fulfilled') setEvents(ev.value.data || []);
    if (hist.status === 'fulfilled') setScopeHistory(hist.value.data || []);
    setLoading(false);
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
    { label: 'Total Scopes',   value: stats.scopes?.total ?? 0,    sub: 'DHCP scopes monitored',     color: 'var(--navy)',  delta: 0,            invert: false },
    { label: 'Critical Scopes', value: stats.scopes?.critical ?? 0, sub: '≥ 90% utilization',         color: (stats.scopes?.critical ?? 0) > 0 ? 'var(--red)' : 'var(--green)',    delta: trends.crit, invert: false },
    { label: 'Warning Scopes',  value: stats.scopes?.warning ?? 0,  sub: '80 – 90% utilization',      color: (stats.scopes?.warning ?? 0) > 0 ? 'var(--yellow)' : 'var(--green)', delta: trends.warn, invert: false },
    { label: 'Active Leases',   value: stats.active_leases ?? 0,    sub: 'live DHCP clients',         color: 'var(--blue)',  delta: trends.used,  invert: true },
    { label: 'DNS Zones',       value: stats.dns_zones ?? 0,        sub: 'forward & reverse',         color: 'var(--teal)',  delta: 0,            invert: false },
  ] : [];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader title="Operations Center" subtitle="Live DDI health — scope exhaustion, recent activity, and utilization trends. Refreshes every 30s." />

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 }}>
        {loading && !stats
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="kpi-card" style={{ borderLeftColor: 'var(--border)' }}>
                <Skeleton height={30} width="45%" /><div style={{ height: 8 }} /><Skeleton height={12} width="75%" />
              </div>
            ))
          : kpis.map((k, i) => (
              <div key={i} className="kpi-card" style={{ borderLeftColor: k.color }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 30, fontWeight: 800, color: k.color, lineHeight: 1, letterSpacing: '-0.5px' }}>{k.value}</div>
                  <Trend delta={k.delta} invert={k.invert} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginTop: 8 }}>{k.label}</div>
                <div style={{ ...MUTED, marginTop: 2 }}>{k.sub}</div>
              </div>
            ))}
      </div>

      {/* Second row: attention (40%) + activity (60%) */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: 14 }}>

        {/* Scopes requiring attention */}
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
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Scope</th><th>Used / Total</th><th style={{ minWidth: 150 }}>Utilization</th></tr></thead>
                <tbody>
                  {attention.map(s => (
                    <tr key={s.id} className="clickable" onClick={() => onFocusScope(s.scope_id)}>
                      <td>
                        <div style={{ fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}>{s.scope_id}</div>
                        <div style={{ ...MUTED, marginTop: 1 }}>{s.name || s.server_hostname || '—'}</div>
                      </td>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                        {s.in_use} / {s.total_ips}
                        {s.free < 10 && <span style={{ color: 'var(--red)', fontWeight: 700 }}> · {s.free} left</span>}
                      </td>
                      <td><UtilBar pct={s.pct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recent activity */}
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
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Type</th><th>IP Address</th><th>Hostname</th><th>Time</th></tr></thead>
                <tbody>
                  {events.map(e => (
                    <tr key={e.id}>
                      <td><EventTypeBadge type={e.event_type} /></td>
                      <td className="mono">{e.ip_address || '—'}</td>
                      <td style={{ color: 'var(--text-secondary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.hostname || '—'}</td>
                      <td className="mono" style={{ ...MUTED, whiteSpace: 'nowrap' }}>{e.event_time ? new Date(e.event_time).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Third row: sparklines for top 6 scopes by utilization */}
      <div style={CARD}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={TITLE}>Utilization Trends</div>
          <span style={MUTED}>Top 6 scopes · last 7 days</span>
        </div>
        <div style={{ padding: 18 }}>
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
  servers:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  settings:  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
};

const SIDEBAR_ITEMS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'scopes',    label: 'DHCP' },
  { id: 'ipam',      label: 'IPAM' },
  { id: 'dns',       label: 'DNS' },
  { id: 'events',    label: 'Events & Alerts' },
  { id: 'servers',   label: 'Known Servers' },
  { id: 'settings',  label: 'Settings' },
];

export default function DDIVaultApp() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [collectorOnline, setCollectorOnline] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [focusScope, setFocusScope] = useState<string | null>(null);

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

          {SIDEBAR_ITEMS.map(item => {
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
            {tab === 'servers'   && <ServersTab />}
            {tab === 'settings'  && <SettingsTab />}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
