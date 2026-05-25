'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from '@/components/Header';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
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

type Tab = 'dashboard' | 'scopes' | 'leases' | 'ipam' | 'dns' | 'events' | 'servers' | 'settings';

// ── Shared styles ─────────────────────────────────────────────
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: 16,
  boxShadow: 'var(--shadow-sm)',
};

const TITLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: 4,
};

const MUTED: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  marginBottom: 12,
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
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        {kpiTiles.map((t, i) => (
          <div key={i} style={CARD}>
            <div style={{ fontSize: 28, fontWeight: 700, color: t.color, lineHeight: 1 }}>{t.value}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginTop: 4 }}>{t.label}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t.sub}</div>
          </div>
        ))}
      </div>

      {/* Scope gauges */}
      <div style={CARD}>
        <div style={TITLE}>Scope Utilization</div>
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>

        {/* Active alerts */}
        <div style={CARD}>
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
        <div style={CARD}>
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
// ════════════════════════════════════════════════════════════
function ScopesTab() {
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/scopes').then(d => { setScopes(d.data || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const toggleScope = async (scopeId: string) => {
    if (expanded === scopeId) { setExpanded(null); return; }
    setExpanded(scopeId);
    const d = await api(`/scopes/${encodeURIComponent(scopeId)}/leases?limit=100`);
    setLeases(d.data || []);
  };

  const filtered = useMemo(() => {
    if (!search) return scopes;
    const q = search.toLowerCase();
    return scopes.filter(s =>
      s.scope_id?.includes(q) || s.name?.toLowerCase().includes(q) ||
      s.start_range?.includes(q) || s.end_range?.includes(q)
    );
  }, [scopes, search]);

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>DHCP Scopes</h2>
        <input
          placeholder="Search scopes..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 6,
            background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, width: 220,
          }}
        />
      </div>

      <div style={CARD}>
        <table>
          <thead>
            <tr>
              <th>Scope ID</th>
              <th>Name</th>
              <th>Range</th>
              <th>Total</th>
              <th>In Use</th>
              <th>Free</th>
              <th>Reserved</th>
              <th>% Used</th>
              <th>State</th>
              <th>Lease</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</td></tr>}
            {!loading && filtered.length === 0 && <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No scopes found</td></tr>}
            {filtered.map(sc => (
              <>
                <tr key={sc.id} onClick={() => toggleScope(sc.scope_id)} style={{ cursor: 'pointer' }}>
                  <td className="mono">{sc.scope_id}</td>
                  <td style={{ fontWeight: 500 }}>{sc.name || '—'}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{sc.start_range} – {sc.end_range}</td>
                  <td>{sc.total_ips}</td>
                  <td>{sc.in_use}</td>
                  <td style={{ color: sc.free < 10 ? '#dc2626' : 'inherit' }}>{sc.free}</td>
                  <td>{sc.reserved}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, minWidth: 60 }}>
                        <div style={{ height: '100%', width: `${Math.min(100, parseFloat(String(sc.percent_used)))}%`, background: pctColor(parseFloat(String(sc.percent_used))), borderRadius: 3, transition: 'width 0.3s' }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: pctColor(parseFloat(String(sc.percent_used))), minWidth: 36 }}>
                        {parseFloat(String(sc.percent_used)).toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td><span className={`badge ${sc.state === 'Active' ? 'badge-green' : 'badge-gray'}`}>{sc.state}</span></td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{sc.lease_duration || '—'}</td>
                </tr>
                {expanded === sc.scope_id && (
                  <tr key={`${sc.id}-leases`}>
                    <td colSpan={10} style={{ background: 'var(--bg-primary)', padding: 0 }}>
                      <div style={{ padding: '12px 16px' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>
                          Active leases in {sc.scope_id} ({leases.length} shown)
                        </div>
                        <table>
                          <thead>
                            <tr>
                              <th>IP Address</th>
                              <th>Hostname</th>
                              <th>MAC Address</th>
                              <th>State</th>
                              <th>Expires</th>
                            </tr>
                          </thead>
                          <tbody>
                            {leases.map(l => (
                              <tr key={l.id}>
                                <td className="mono">{l.ip_address}</td>
                                <td>{l.hostname || '—'}</td>
                                <td className="mono">{l.mac_address || '—'}</td>
                                <td><span className={`badge ${l.address_state === 'Active' ? 'badge-green' : 'badge-gray'}`}>{l.address_state}</span></td>
                                <td style={{ fontSize: 11 }}>{l.lease_expiry ? new Date(l.lease_expiry).toLocaleString() : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: LEASE TRACKER
// ════════════════════════════════════════════════════════════
function LeasesTab() {
  const [leases, setLeases]   = useState<Lease[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [search, setSearch]   = useState('');
  const [state, setState]     = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<{ip: string; rows: any[]} | null>(null);
  const limit = 50;

  const load = useCallback(async (p = 1, q = search, st = state) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(limit) });
      if (q) params.set('search', q);
      if (st) params.set('state', st);
      const d = await api(`/leases?${params}`);
      setLeases(d.data || []);
      setTotal(d.total || 0);
    } finally {
      setLoading(false);
    }
  }, [search, state]);

  useEffect(() => { load(); }, []);

  const showHistory = async (ip: string) => {
    const d = await api(`/leases/ip/${encodeURIComponent(ip)}/history`);
    setHistory({ ip, rows: d.data || [] });
  };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Lease Tracker</h2>
        <input
          placeholder="Search IP, hostname, MAC..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); load(1, e.target.value, state); }}
          style={{ padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, width: 240 }}
        />
        <select
          value={state}
          onChange={e => { setState(e.target.value); setPage(1); load(1, search, e.target.value); }}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13 }}
        >
          <option value="">All states</option>
          <option value="Active">Active</option>
          <option value="Expired">Expired</option>
          <option value="Reservation">Reservation</option>
        </select>
        <div style={{ flex: 1 }} />
        <a href="/api/leases/export" download style={{ padding: '6px 14px', background: '#1a2744', color: '#fff', borderRadius: 6, fontSize: 12, textDecoration: 'none' }}>
          Export CSV
        </a>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{total} leases</span>
      </div>

      <div style={CARD}>
        <table>
          <thead>
            <tr>
              <th>IP Address</th>
              <th>Hostname</th>
              <th>MAC Address</th>
              <th>Scope</th>
              <th>State</th>
              <th>Expires</th>
              <th>History</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</td></tr>}
            {!loading && leases.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No leases found</td></tr>}
            {leases.map(l => (
              <tr key={l.id}>
                <td className="mono">{l.ip_address}</td>
                <td>{l.hostname || '—'}</td>
                <td className="mono">{l.mac_address || '—'}</td>
                <td className="mono" style={{ fontSize: 11 }}>{l.scope_id || '—'}</td>
                <td><span className={`badge ${l.address_state === 'Active' ? 'badge-green' : l.address_state === 'Reservation' ? 'badge-blue' : 'badge-gray'}`}>{l.address_state}</span></td>
                <td style={{ fontSize: 11 }}>{l.lease_expiry ? new Date(l.lease_expiry).toLocaleString() : '—'}</td>
                <td>
                  <button
                    onClick={() => showHistory(l.ip_address)}
                    style={{ fontSize: 11, color: '#C8102E', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                  >
                    IP History
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Pagination */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
          {page > 1 && <button onClick={() => { setPage(p => p-1); load(page-1); }} style={btnStyle}>← Prev</button>}
          <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>Page {page}</span>
          {leases.length === limit && <button onClick={() => { setPage(p => p+1); load(page+1); }} style={btnStyle}>Next →</button>}
        </div>
      </div>

      {/* IP History modal */}
      {history && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ ...CARD, width: 600, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 700 }}>IP History: {history.ip}</div>
              <button onClick={() => setHistory(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)' }}>✕</button>
            </div>
            <table>
              <thead><tr><th>Time</th><th>Event</th><th>Hostname</th><th>MAC</th></tr></thead>
              <tbody>
                {history.rows.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No history</td></tr>}
                {history.rows.map((r: any, i: number) => (
                  <tr key={i}>
                    <td style={{ fontSize: 11 }}>{new Date(r.event_time).toLocaleString()}</td>
                    <td><EventTypeBadge type={r.event_type} /></td>
                    <td>{r.hostname || '—'}</td>
                    <td className="mono">{r.mac_address || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: IPAM
// ════════════════════════════════════════════════════════════
function IPAMTab() {
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm]       = useState({ network: '', prefix_length: '24', name: '', description: '', gateway: '', vlan_id: '', site: '', owner: '' });
  const { toast } = useToast();

  const load = () => api('/subnets').then(d => setSubnets(d.data || []));
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      await api('/subnets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      toast('Subnet added', 'success');
      setShowAdd(false);
      setForm({ network: '', prefix_length: '24', name: '', description: '', gateway: '', vlan_id: '', site: '', owner: '' });
      load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const del = async (id: number) => {
    if (!confirm('Delete this subnet?')) return;
    await api(`/subnets/${id}`, { method: 'DELETE' });
    toast('Subnet deleted', 'info');
    load();
  };

  const totalIps = (prefix: number) => Math.pow(2, 32 - prefix) - 2;

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>IPAM — Subnet Management</h2>
        <button onClick={() => setShowAdd(true)} style={{ ...btnStyle, background: '#C8102E', color: '#fff', border: 'none' }}>
          + Add Subnet
        </button>
      </div>

      {/* Subnet heatmap */}
      <div style={{ ...CARD, marginBottom: 12 }}>
        <div style={TITLE}>Subnet Utilization Heatmap</div>
        <div style={MUTED}>Each cell = one subnet · Color by utilization</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {subnets.map(s => {
            const total = totalIps(s.prefix_length);
            const used  = parseInt(String(s.used_ips)) || 0;
            const pct   = total > 0 ? (used / total) * 100 : 0;
            return (
              <div key={s.id} title={`${s.network}/${s.prefix_length} — ${s.name || ''}\n${used}/${total} IPs (${pct.toFixed(1)}%)`}
                style={{ width: 48, height: 48, borderRadius: 6, background: pctColor(pct), opacity: 0.2 + (pct / 100) * 0.8,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'opacity 0.2s' }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'scale(1.1)'; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = String(0.2 + (pct / 100) * 0.8); e.currentTarget.style.transform = 'scale(1)'; }}
              >
                <span style={{ fontSize: 9, color: '#fff', fontWeight: 700 }}>{Math.round(pct)}%</span>
              </div>
            );
          })}
          {subnets.length === 0 && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No subnets added yet</span>}
        </div>
      </div>

      {/* Subnet table */}
      <div style={CARD}>
        <table>
          <thead>
            <tr>
              <th>Network</th>
              <th>Name</th>
              <th>Gateway</th>
              <th>VLAN</th>
              <th>Site</th>
              <th>Owner</th>
              <th>Used IPs</th>
              <th>% Used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {subnets.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No subnets configured</td></tr>}
            {subnets.map(s => {
              const total = totalIps(s.prefix_length);
              const used  = parseInt(String(s.used_ips)) || 0;
              const pct   = total > 0 ? (used / total) * 100 : 0;
              return (
                <tr key={s.id}>
                  <td className="mono">{s.network}/{s.prefix_length}</td>
                  <td>{s.name || '—'}</td>
                  <td className="mono">{s.gateway || '—'}</td>
                  <td>{s.vlan_id || '—'}</td>
                  <td>{s.site || '—'}</td>
                  <td>{s.owner || '—'}</td>
                  <td>{used} / {total}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, minWidth: 50 }}>
                        <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: pctColor(pct), borderRadius: 3 }} />
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: pctColor(pct), minWidth: 36 }}>{pct.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td>
                    <button onClick={() => del(s.id)} style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add subnet modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ ...CARD, width: 480 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontWeight: 700 }}>Add Subnet</div>
              <button onClick={() => setShowAdd(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)' }}>✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { key: 'network', label: 'Network (e.g. 192.168.1.0)', full: true },
                { key: 'prefix_length', label: 'Prefix Length (/24)' },
                { key: 'name', label: 'Name' },
                { key: 'gateway', label: 'Gateway IP' },
                { key: 'vlan_id', label: 'VLAN ID' },
                { key: 'site', label: 'Site' },
                { key: 'owner', label: 'Owner' },
                { key: 'description', label: 'Description', full: true },
              ].map(f => (
                <div key={f.key} style={f.full ? { gridColumn: '1 / -1' } : {}}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>{f.label}</label>
                  <input
                    value={(form as any)[f.key]}
                    onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAdd(false)} style={btnStyle}>Cancel</button>
              <button onClick={save} style={{ ...btnStyle, background: '#C8102E', color: '#fff', border: 'none' }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: DNS
// ════════════════════════════════════════════════════════════
function DNSTab() {
  const [zones, setZones]     = useState<DnsZone[]>([]);
  const [records, setRecords] = useState<any[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [search, setSearch]   = useState('');
  const [type, setType]       = useState('');
  const [breakdown, setBreakdown] = useState<any[]>([]);
  const [selectedZone, setSelectedZone] = useState<number | null>(null);

  const RECORD_COLORS = ['#C8102E','#2563eb','#16a34a','#ca8a04','#7c3aed','#0891b2','#ea580c'];

  useEffect(() => {
    api('/dns/zones').then(d => setZones(d.data || []));
    api('/dns/record-type-breakdown').then(d => setBreakdown(d.data || []));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: '50' });
    if (search) params.set('search', search);
    if (type)   params.set('type', type);
    if (selectedZone) params.set('zone_id', String(selectedZone));
    api(`/dns/records?${params}`).then(d => { setRecords(d.data || []); setTotal(d.total || 0); });
  }, [search, type, selectedZone, page]);

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700 }}>DNS</h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Zones table */}
        <div style={CARD}>
          <div style={TITLE}>DNS Zones ({zones.length})</div>
          <table>
            <thead><tr><th>Zone Name</th><th>Type</th><th>Records</th><th>Kind</th></tr></thead>
            <tbody>
              {zones.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No zones — DNS server not yet configured</td></tr>}
              {zones.map(z => (
                <tr key={z.id} onClick={() => setSelectedZone(z.id === selectedZone ? null : z.id)} style={{ cursor: 'pointer', background: selectedZone === z.id ? 'var(--primary-light, #fef2f4)' : undefined }}>
                  <td style={{ fontWeight: 500 }}>{z.zone_name}</td>
                  <td><span className="badge badge-blue">{z.zone_type}</span></td>
                  <td>{z.record_count}</td>
                  <td><span className={`badge ${z.is_reverse ? 'badge-orange' : 'badge-gray'}`}>{z.is_reverse ? 'Reverse' : 'Forward'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Record type breakdown */}
        <div style={CARD}>
          <div style={TITLE}>Record Types</div>
          {breakdown.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>No DNS records synced yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={breakdown} dataKey="count" nameKey="record_type" cx="50%" cy="50%" outerRadius={80} label={({ record_type, count }) => `${record_type}: ${count}`}>
                  {breakdown.map((_, i) => <Cell key={i} fill={RECORD_COLORS[i % RECORD_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* DNS records */}
      <div style={CARD}>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={TITLE}>DNS Records</div>
          <div style={{ flex: 1 }} />
          <input
            placeholder="Search hostname or IP..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            style={{ padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, width: 200 }}
          />
          <select value={type} onChange={e => { setType(e.target.value); setPage(1); }}
            style={{ padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13 }}>
            <option value="">All types</option>
            {['A','AAAA','CNAME','MX','PTR','SRV','TXT','NS'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '5px 0' }}>{total} records</span>
        </div>
        <table>
          <thead><tr><th>Hostname</th><th>Type</th><th>Data</th><th>TTL</th><th>Zone</th></tr></thead>
          <tbody>
            {records.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No records found</td></tr>}
            {records.map((r: any, i: number) => (
              <tr key={i}>
                <td className="mono">{r.hostname}</td>
                <td><span className="badge badge-blue">{r.record_type}</span></td>
                <td className="mono" style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.record_data}</td>
                <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.ttl}</td>
                <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.zone_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
// TAB: KNOWN SERVERS
// ════════════════════════════════════════════════════════════
function ServersTab() {
  interface Server {
    id: number;
    hostname: string;
    ip_address: string;
    role: string;
    description: string;
    is_active: boolean;
    last_polled: string;
    poll_status: string;
    poll_error: string;
  }

  const [servers, setServers] = useState<Server[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm]       = useState({ hostname: '', ip_address: '', role: 'both', description: '' });
  const { toast } = useToast();

  const load = () => api('/servers').then(d => setServers(d.data || []));
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      await api('/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      toast('Server added', 'success');
      setShowAdd(false);
      setForm({ hostname: '', ip_address: '', role: 'both', description: '' });
      load();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const del = async (id: number) => {
    if (!confirm('Remove this server?')) return;
    await api(`/servers/${id}`, { method: 'DELETE' });
    toast('Server removed', 'info');
    load();
  };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>Known Servers</h2>
        <button onClick={() => setShowAdd(true)} style={{ ...btnStyle, background: '#C8102E', color: '#fff', border: 'none' }}>+ Add Server</button>
      </div>

      <div style={CARD}>
        <table>
          <thead><tr><th>Hostname</th><th>IP Address</th><th>Role</th><th>Status</th><th>Last Polled</th><th>Description</th><th></th></tr></thead>
          <tbody>
            {servers.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                  No servers configured.<br />
                  <span style={{ fontSize: 12 }}>Add your DHCP/DNS server to begin monitoring.</span>
                </td>
              </tr>
            )}
            {servers.map(s => (
              <tr key={s.id}>
                <td style={{ fontWeight: 500 }}>{s.hostname || '—'}</td>
                <td className="mono">{s.ip_address || '—'}</td>
                <td><span className="badge badge-blue">{s.role}</span></td>
                <td>
                  <span className={`badge ${s.poll_status === 'ok' ? 'badge-green' : s.poll_status === 'error' ? 'badge-red' : 'badge-gray'}`}>
                    {s.poll_status || 'pending'}
                  </span>
                  {s.poll_error && <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }}>{s.poll_error}</div>}
                </td>
                <td style={{ fontSize: 11 }}>{s.last_polled ? new Date(s.last_polled).toLocaleString() : 'Never'}</td>
                <td style={{ color: 'var(--text-muted)' }}>{s.description || '—'}</td>
                <td>
                  <button onClick={() => del(s.id)} style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ ...CARD, width: 420 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontWeight: 700 }}>Add Server</div>
              <button onClick={() => setShowAdd(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)' }}>✕</button>
            </div>
            {[
              { key: 'hostname', label: 'Hostname or FQDN' },
              { key: 'ip_address', label: 'IP Address' },
              { key: 'description', label: 'Description' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>{f.label}</label>
                <input value={(form as any)[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }} />
              </div>
            ))}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Role</label>
              <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }}>
                <option value="both">DHCP + DNS</option>
                <option value="dhcp">DHCP only</option>
                <option value="dns">DNS only</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAdd(false)} style={btnStyle}>Cancel</button>
              <button onClick={save} style={{ ...btnStyle, background: '#C8102E', color: '#fff', border: 'none' }}>Add Server</button>
            </div>
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
const SIDEBAR_ITEMS: { id: Tab; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard',     icon: '◉' },
  { id: 'scopes',    label: 'DHCP Scopes',   icon: '⬡' },
  { id: 'leases',    label: 'Lease Tracker', icon: '📋' },
  { id: 'ipam',      label: 'IPAM',          icon: '🗺' },
  { id: 'dns',       label: 'DNS',           icon: '🌐' },
  { id: 'events',    label: 'Events & Alerts', icon: '🔔' },
  { id: 'servers',   label: 'Known Servers', icon: '🖥' },
  { id: 'settings',  label: 'Settings',      icon: '⚙' },
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
          padding: '12px 0',
          flexShrink: 0,
          overflowY: 'auto',
        }}>
          {SIDEBAR_ITEMS.map(item => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 16px',
                background: tab === item.id ? 'rgba(200,16,46,0.12)' : 'transparent',
                borderLeft: tab === item.id ? '3px solid #C8102E' : '3px solid transparent',
                border: 'none',
                borderRadius: 0,
                color: tab === item.id ? '#fff' : 'rgba(255,255,255,0.55)',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: tab === item.id ? 600 : 400,
                textAlign: 'left',
                width: '100%',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 14 }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Content area */}
        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}>
          <ErrorBoundary name={tab}>
            {tab === 'dashboard' && <DashboardTab onNavigate={setTab} />}
            {tab === 'scopes'    && <ScopesTab />}
            {tab === 'leases'    && <LeasesTab />}
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
