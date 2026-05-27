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
  RadialBarChart, RadialBar, PieChart, Pie, Cell,
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  BarChart, Bar, Legend,
} from 'recharts';

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
  lease_duration: string;
  server_hostname: string;
  last_updated: string;
}

interface Lease {
  id: number;
  ip_address: string;
  hostname: string;
  mac_address: string;
  scope_id: string;
  address_state: string;
  lease_start: string;
  lease_expiry: string;
  last_seen: string;
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

interface DnsZone {
  id: number;
  zone_name: string;
  zone_type: string;
  is_reverse: boolean;
  record_count: number;
  server_hostname: string;
  last_updated: string;
}

interface Subnet {
  id: number;
  network: string;
  prefix_length: number;
  name: string;
  description: string;
  gateway: string;
  vlan_id: number;
  site: string;
  owner: string;
  used_ips: number;
}

type Tab = 'dashboard' | 'scopes' | 'ipam' | 'dns' | 'events' | 'servers' | 'settings';

// ── Shared styles ─────────────────────────────────────────────
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow-sm)',
  padding: '20px 24px',
};

const TITLE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: 4,
};

const MUTED: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-muted)',
  marginBottom: 14,
};

// ── Utilization colour helper ─────────────────────────────────
function pctColor(pct: number): string {
  if (pct >= 90) return '#dc2626';
  if (pct >= 80) return '#ca8a04';
  return '#16a34a';
}

function pctBadge(pct: number): string {
  if (pct >= 90) return 'badge-red';
  if (pct >= 80) return 'badge-yellow';
  return 'badge-green';
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

// ════════════════════════════════════════════════════════════
// TAB: DASHBOARD
// ════════════════════════════════════════════════════════════
function DashboardTab({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const [stats, setStats]   = useState<any>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [events, setEvents] = useState<DhcpEvent[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);

  useEffect(() => {
    const load = async () => {
      const [s, sc, ev, al] = await Promise.allSettled([
        api('/dashboard/stats'),
        api('/scopes'),
        api('/dashboard/recent-events?limit=10'),
        api('/alerts?unacked=true&limit=5'),
      ]);
      if (s.status  === 'fulfilled') setStats(s.value);
      if (sc.status === 'fulfilled') setScopes(sc.value.data || []);
      if (ev.status === 'fulfilled') setEvents(ev.value.data || []);
      if (al.status === 'fulfilled') setAlerts(al.value.data || []);
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  // KPI tiles
  const kpiTiles = stats ? [
    { label: 'Total Scopes',    value: stats.scopes?.total    ?? '—', sub: `${stats.scopes?.critical ?? 0} critical`,  color: stats.scopes?.critical > 0 ? '#dc2626' : '#16a34a' },
    { label: 'Active Leases',   value: stats.active_leases    ?? '—', sub: 'DHCP clients',                              color: '#2563eb' },
    { label: 'Available IPs',   value: stats.ips?.free        ?? '—', sub: `${stats.ips?.in_use ?? 0} in use`,          color: '#7c3aed' },
    { label: 'DNS Zones',       value: stats.dns_zones        ?? '—', sub: 'managed zones',                             color: '#0891b2' },
    { label: 'Unacked Alerts',  value: stats.unacked_alerts   ?? '—', sub: 'need attention',                            color: stats.unacked_alerts > 0 ? '#dc2626' : '#16a34a' },
  ] : [];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Page header */}
      <div>
        <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.4px' }}>Dashboard</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>Infrastructure overview</div>
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 }}>
        {kpiTiles.map((t, i) => (
          <div key={i} style={{
            ...CARD, padding: '20px 24px',
            transition: 'box-shadow 0.2s, transform 0.2s',
            cursor: 'default',
          }}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; e.currentTarget.style.transform = 'none'; }}
          >
            <div style={{ fontSize: 36, fontWeight: 800, color: t.color, lineHeight: 1, letterSpacing: '-1px' }}>{t.value}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginTop: 8 }}>{t.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{t.sub}</div>
          </div>
        ))}
      </div>

      {/* Scope gauges */}
      <div style={{ ...CARD, padding: '20px 24px' }}>
        <div style={{ ...TITLE }}>Scope Utilization</div>
        <div style={{ ...MUTED }}>Live — updates every 30s · Click scope to view leases</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {scopes.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 20 }}>
              No scopes found. Configure a DHCP server in Known Servers to begin monitoring.
            </div>
          )}
          {scopes.map(sc => (
            <div
              key={sc.id}
              onClick={() => onNavigate('scopes')}
              style={{
                cursor: 'pointer',
                textAlign: 'center',
                padding: '12px 16px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-primary)',
                minWidth: 140,
                transition: 'box-shadow 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)')}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
            >
              {/* Circular gauge via SVG */}
              <ScopeGauge pct={parseFloat(String(sc.percent_used))} size={80} />
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginTop: 8, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {sc.name || sc.scope_id}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{sc.scope_id}</div>
              <div style={{ fontSize: 11, color: pctColor(parseFloat(String(sc.percent_used))), marginTop: 2 }}>
                {sc.in_use} / {sc.total_ips} IPs
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Alerts + Recent events */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14 }}>

        {/* Active alerts */}
        <div style={{ ...CARD, padding: '20px 24px' }}>
          <div style={TITLE}>Active Alerts</div>
          <div style={MUTED}>{alerts.length} unacknowledged</div>
          {alerts.length === 0 ? (
            <div style={{ color: '#16a34a', fontSize: 13, fontWeight: 500 }}>✓ All clear</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {alerts.map(a => (
                <div key={a.id} style={{
                  padding: '8px 10px',
                  background: a.severity === 'critical' ? '#fee2e2' : '#fef9c3',
                  borderRadius: 6,
                  borderLeft: `3px solid ${a.severity === 'critical' ? '#dc2626' : '#ca8a04'}`,
                }}>
                  <div style={{ fontSize: 12, color: a.severity === 'critical' ? '#b91c1c' : '#a16207', fontWeight: 500 }}>
                    {a.message}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {new Date(a.fired_at).toLocaleString()}
                  </div>
                </div>
              ))}
              <button
                onClick={() => onNavigate('events')}
                style={{ fontSize: 11, color: '#C8102E', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
              >
                View all alerts →
              </button>
            </div>
          )}
        </div>

        {/* Recent events */}
        <div style={{ ...CARD, padding: '20px 24px' }}>
          <div style={TITLE}>Recent DHCP Events</div>
          <div style={MUTED}>Last 10 events from DHCP log</div>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>IP Address</th>
                <th>Hostname</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No events yet</td></tr>
              )}
              {events.map(e => (
                <tr key={e.id}>
                  <td className="mono">{e.event_time ? new Date(e.event_time).toLocaleTimeString() : '—'}</td>
                  <td><EventTypeBadge type={e.event_type} /></td>
                  <td className="mono">{e.ip_address || '—'}</td>
                  <td style={{ color: 'var(--text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.hostname || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Scope gauge SVG ───────────────────────────────────────────
function ScopeGauge({ pct, size }: { pct: number; size: number }) {
  const r = (size / 2) - 8;
  const circ = 2 * Math.PI * r;
  const filled = (pct / 100) * circ * 0.75; // 270deg arc
  const color = pctColor(pct);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(135deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={7} strokeDasharray={`${circ * 0.75} ${circ}`} strokeLinecap="round" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={7} strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.5s ease' }} />
      <text x={size/2} y={size/2 + 5} textAnchor="middle" fontSize={14} fontWeight={700} fill={color} style={{ transform: `rotate(-135deg)`, transformOrigin: `${size/2}px ${size/2}px` }}>
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

// ── Event type badge ──────────────────────────────────────────
function EventTypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    Assign: 'badge-green', Renew: 'badge-blue', Release: 'badge-gray',
    ScopeFull: 'badge-red', ScopeWarning: 'badge-yellow', Conflict: 'badge-red',
    NACK: 'badge-orange', RogueDHCP: 'badge-red', Expired: 'badge-gray',
  };
  return <span className={`badge ${map[type] || 'badge-gray'}`}>{type}</span>;
}

// ════════════════════════════════════════════════════════════
// TAB: DHCP SCOPES
function EventsTab() {
  const [events, setEvents]   = useState<DhcpEvent[]>([]);
  const [alerts, setAlerts]   = useState<AlertEvent[]>([]);
  const [evTotal, setEvTotal] = useState(0);
  const [alTotal, setAlTotal] = useState(0);
  const [page, setPage]       = useState(1);
  const [hours, setHours]     = useState(24);
  const [typeFilter, setTypeFilter] = useState('');
  const [view, setView]       = useState<'events' | 'alerts'>('alerts');
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: '50', hours: String(hours) });
    if (typeFilter) params.set('type', typeFilter);
    api(`/events?${params}`).then(d => { setEvents(d.data || []); setEvTotal(d.total || 0); });
    api('/alerts?limit=50').then(d => { setAlerts(d.data || []); setAlTotal(d.total || 0); });
  }, [page, hours, typeFilter]);

  const ack = async (id: number) => {
    await api(`/alerts/${id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin' }) });
    toast('Alert acknowledged', 'success');
    api('/alerts?limit=50').then(d => setAlerts(d.data || []));
  };

  const ackAll = async () => {
    await api('/alerts/acknowledge-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin' }) });
    toast('All alerts acknowledged', 'success');
    api('/alerts?limit=50').then(d => setAlerts(d.data || []));
  };

  return (
    <div style={{ padding: 20 }}>
      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', width: 'fit-content' }}>
        {(['alerts','events'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '7px 18px', background: view === v ? '#C8102E' : 'var(--bg-card)',
            color: view === v ? '#fff' : 'var(--text-secondary)',
            border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, textTransform: 'capitalize',
          }}>
            {v === 'alerts' ? `Alerts (${alTotal})` : `DHCP Events (${evTotal})`}
          </button>
        ))}
      </div>

      {view === 'alerts' && (
        <div style={CARD}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={TITLE}>Alert History</div>
            <button onClick={ackAll} style={{ ...btnStyle, background: '#C8102E', color: '#fff', border: 'none', fontSize: 12 }}>Acknowledge All</button>
          </div>
          <table>
            <thead><tr><th>Severity</th><th>Message</th><th>Scope</th><th>Fired</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {alerts.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No alerts</td></tr>}
              {alerts.map(a => (
                <tr key={a.id}>
                  <td><span className={`badge ${a.severity === 'critical' ? 'badge-red' : 'badge-yellow'}`}>{a.severity}</span></td>
                  <td>{a.message}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{a.scope_id || '—'}</td>
                  <td style={{ fontSize: 11 }}>{new Date(a.fired_at).toLocaleString()}</td>
                  <td><span className={`badge ${a.acknowledged ? 'badge-gray' : 'badge-red'}`}>{a.acknowledged ? 'ACK' : 'Open'}</span></td>
                  <td>
                    {!a.acknowledged && (
                      <button onClick={() => ack(a.id)} style={{ fontSize: 11, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer' }}>Ack</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'events' && (
        <div style={CARD}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <div style={TITLE}>DHCP Event Log</div>
            <div style={{ flex: 1 }} />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              style={{ padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13 }}>
              <option value="">All types</option>
              {['Assign','Renew','Release','Conflict','ScopeFull','ScopeWarning','NACK','RogueDHCP'].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select value={hours} onChange={e => { setHours(parseInt(e.target.value)); setPage(1); }}
              style={{ padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13 }}>
              {[1,6,24,48,168].map(h => <option key={h} value={h}>Last {h}h</option>)}
            </select>
          </div>
          <table>
            <thead><tr><th>Time</th><th>Type</th><th>IP</th><th>Hostname</th><th>MAC</th><th>Description</th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No events</td></tr>}
              {events.map(e => (
                <tr key={e.id}>
                  <td style={{ fontSize: 11 }}>{e.event_time ? new Date(e.event_time).toLocaleString() : '—'}</td>
                  <td><EventTypeBadge type={e.event_type} /></td>
                  <td className="mono">{e.ip_address || '—'}</td>
                  <td>{e.hostname || '—'}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{e.mac_address || '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
            {page > 1 && <button onClick={() => setPage(p => p-1)} style={btnStyle}>← Prev</button>}
            <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>Page {page} · {evTotal} events</span>
            {events.length === 50 && <button onClick={() => setPage(p => p+1)} style={btnStyle}>Next →</button>}
          </div>
        </div>
      )}
    </div>
  );
}
// ════════════════════════════════════════════════════════════
// TAB: SETTINGS
// ════════════════════════════════════════════════════════════
function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const { toast } = useToast();

  useEffect(() => {
    api('/settings').then(d => setSettings(d.data || {}));
  }, []);

  const save = async (key: string, value: string) => {
    await api('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
    toast('Saved', 'success');
  };

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Settings</h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* Branding */}
        <div style={CARD}>
          <div style={{ ...TITLE, marginBottom: 12 }}>Branding</div>
          {[
            { key: 'app_name', label: 'App Name' },
            { key: 'company_name', label: 'Company Name' },
          ].map(f => (
            <div key={f.key} style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>{f.label}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  defaultValue={settings[f.key] || ''}
                  onBlur={e => save(f.key, e.target.value)}
                  style={{ flex: 1, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }}
                />
              </div>
            </div>
          ))}
        </div>

        {/* Data retention */}
        <div style={CARD}>
          <div style={{ ...TITLE, marginBottom: 12 }}>Data Retention</div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Retention (days)</label>
            <input
              defaultValue={settings.retention_days || '90'}
              onBlur={e => save('retention_days', e.target.value)}
              style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }}
            />
          </div>
        </div>

        {/* About */}
        <div style={CARD}>
          <div style={{ ...TITLE, marginBottom: 12 }}>About</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            <div><strong>DDIVault</strong> v1.0.0</div>
            <div style={{ color: 'var(--text-muted)' }}>Part of the NexVault network intelligence suite</div>
            <div style={{ marginTop: 8 }}>API Port: 3007 · App Port: 3006</div>
            <div style={{ marginTop: 4 }}>
              <a href="http://192.168.6.111:3000/launcher" style={{ color: '#C8102E', textDecoration: 'none' }}>← NexVault Hub</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared button style ───────────────────────────────────────
const btnStyle: React.CSSProperties = {
  padding: '6px 14px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

// ════════════════════════════════════════════════════════════
// SIDEBAR + MAIN APP
// ════════════════════════════════════════════════════════════

// SVG icons for sidebar
const ICONS: Record<string, React.ReactNode> = {
  dashboard: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  scopes:    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  ipam:      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  dns:       <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
  events:    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  servers:   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  settings:  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
};

const SIDEBAR_ITEMS: { id: Tab; label: string; badge?: string }[] = [
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

  useEffect(() => {
    const check = () => {
      fetch('/api/health').then(r => setCollectorOnline(r.ok)).catch(() => setCollectorOnline(false));
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header collectorOnline={collectorOnline} />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Sidebar */}
        <nav style={{
          width: 'var(--sidebar-width)',
          background: '#1a2744',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          overflowY: 'auto',
          paddingTop: 8,
          paddingBottom: 16,
        }}>
          {/* Section label */}
          <div style={{
            padding: '12px 20px 8px',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            color: 'rgba(255,255,255,0.25)',
            textTransform: 'uppercase',
          }}>
            Navigation
          </div>

          {SIDEBAR_ITEMS.map(item => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '11px 20px',
                  margin: '1px 10px',
                  background: active ? 'rgba(200,16,46,0.15)' : 'transparent',
                  borderLeft: 'none',
                  border: 'none',
                  borderRadius: 10,
                  color: active ? '#fff' : 'rgba(255,255,255,0.5)',
                  cursor: 'pointer',
                  fontSize: 13.5,
                  fontWeight: active ? 600 : 400,
                  textAlign: 'left',
                  width: 'calc(100% - 20px)',
                  transition: 'all 0.15s',
                  position: 'relative',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; } }}
              >
                {/* Active indicator */}
                {active && (
                  <div style={{
                    position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                    width: 3, height: 20, background: '#C8102E', borderRadius: '0 3px 3px 0',
                  }} />
                )}
                <span style={{ color: active ? '#C8102E' : 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
                  {ICONS[item.id]}
                </span>
                <span>{item.label}</span>
                {item.badge && (
                  <span style={{
                    marginLeft: 'auto', background: '#C8102E', color: '#fff',
                    borderRadius: 10, padding: '1px 7px', fontSize: 10, fontWeight: 700,
                  }}>{item.badge}</span>
                )}
              </button>
            );
          })}

          {/* Bottom spacer + version */}
          <div style={{ flex: 1 }} />
          <div style={{ padding: '12px 20px', fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>
            DDIVault v1.0
          </div>
        </nav>

        {/* Content area */}
        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}>
          <ErrorBoundary name={tab}>
            {tab === 'dashboard' && <DashboardTab onNavigate={setTab} />}
            {tab === 'scopes'    && <DHCPTab />}
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
