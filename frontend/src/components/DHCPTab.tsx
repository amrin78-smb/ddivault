'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/components/Toast';

// ── Types ─────────────────────────────────────────────────────
interface Scope {
  id: number;
  scope_id: string;
  name: string;
  server_id: number;
  server_hostname: string;
  server_ip: string;
  start_range: string;
  end_range: string;
  total_ips: number;
  in_use: number;
  free: number;
  reserved: number;
  percent_used: number;
  state: string;
  lease_duration: string;
  last_updated: string;
}

interface Lease {
  id: number;
  ip_address: string;
  hostname: string;
  mac_address: string;
  scope_id: string;
  server_id: number;
  address_state: string;
  lease_start: string;
  lease_expiry: string;
  last_seen: string;
}

// ── Shared styles ─────────────────────────────────────────────
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
};
const BTN: React.CSSProperties = {
  padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12,
};
const BTN_RED: React.CSSProperties = { ...BTN, background: '#C8102E', color: '#fff', border: 'none' };
const INPUT: React.CSSProperties = {
  width: '100%', padding: '6px 10px', border: '1px solid var(--border)',
  borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13,
};
const TH: React.CSSProperties = {
  background: '#f9fafb', color: '#6b7280', fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.05em', padding: '10px 12px',
  borderBottom: '1px solid var(--border)', textAlign: 'left', whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = { padding: '9px 12px', fontSize: 13 };

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

function pctColor(pct: number) {
  if (pct >= 90) return '#dc2626';
  if (pct >= 80) return '#ca8a04';
  return '#16a34a';
}

// ── Scope gauge ───────────────────────────────────────────────
function ScopeGauge({ pct, size = 72 }: { pct: number; size?: number }) {
  const r     = (size / 2) - 7;
  const circ  = 2 * Math.PI * r;
  const arc   = circ * 0.75;
  const filled = (Math.min(100, pct) / 100) * arc;
  const color = pctColor(pct);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(135deg)', flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={6} strokeDasharray={`${arc} ${circ}`} strokeLinecap="round" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={6} strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.5s' }} />
      <text x={size/2} y={size/2+5} textAnchor="middle" fontSize={12} fontWeight={700} fill={color}
        style={{ transform: `rotate(-135deg)`, transformOrigin: `${size/2}px ${size/2}px` }}>
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

// ── Reserve IP modal ──────────────────────────────────────────
function ReserveModal({ scope, lease, onClose, onDone }: {
  scope: Scope; lease?: Lease; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = useState({
    ip_address:  lease?.ip_address  || '',
    mac_address: lease?.mac_address || '',
    name:        lease?.hostname    || '',
    description: '',
  });
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const reserve = async () => {
    if (!form.ip_address || !form.mac_address) {
      toast('IP address and MAC address are required', 'error'); return;
    }
    setLoading(true);
    try {
      await api('/dhcp/reservations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: scope.server_id, scope_id: scope.scope_id, ...form }),
      });
      toast(`Reserved ${form.ip_address} on DHCP server`, 'success');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ ...CARD, padding: 24, width: 440 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Reserve IP — {scope.scope_id}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)' }}>×</button>
        </div>
        <div style={{ background: '#fef9c3', border: '1px solid #fde047', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 14, color: '#a16207' }}>
          ⚡ This will run <code>Add-DhcpServerv4Reservation</code> on your Windows DHCP server via PowerShell remoting.
        </div>
        {[
          { k: 'ip_address',  l: 'IP Address to Reserve *', ph: '192.168.1.100' },
          { k: 'mac_address', l: 'MAC Address (client) *',  ph: 'AA-BB-CC-DD-EE-FF' },
          { k: 'name',        l: 'Name / Hostname',          ph: 'PRINTER-01' },
          { k: 'description', l: 'Description',              ph: 'Network printer, Floor 2' },
        ].map(f => (
          <div key={f.k} style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>{f.l}</label>
            <input value={(form as any)[f.k]} placeholder={f.ph}
              onChange={e => setForm(p => ({ ...p, [f.k]: e.target.value }))} style={INPUT} />
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={BTN}>Cancel</button>
          <button onClick={reserve} disabled={loading} style={{ ...BTN_RED, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Reserving...' : '✓ Reserve on DHCP Server'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN DHCP TAB
// ════════════════════════════════════════════════════════════
export default function DHCPTab() {
  const [scopes, setScopes]       = useState<Scope[]>([]);
  const [expandedScope, setExpandedScope] = useState<string | null>(null);
  const [leases, setLeases]       = useState<Lease[]>([]);
  const [leasesLoading, setLeasesLoading] = useState(false);
  const [search, setSearch]       = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [serverFilter, setServerFilter] = useState('');
  const [reserveTarget, setReserveTarget] = useState<{ scope: Scope; lease?: Lease } | null>(null);
  const [view, setView]           = useState<'scopes' | 'leases' | 'reservations'>('scopes');
  const [allLeases, setAllLeases] = useState<Lease[]>([]);
  const [allLeasesLoading, setAllLeasesLoading] = useState(false);
  const [leasePage, setLeasePage] = useState(1);
  const [leaseTotal, setLeaseTotal] = useState(0);
  const [leaseSearch, setLeaseSearch] = useState('');
  const LEASE_LIMIT = 50;

  const { toast } = useToast();

  // Load scopes
  const loadScopes = useCallback(async () => {
    const d = await api('/scopes').catch(() => null);
    if (d) setScopes(d.data || []);
  }, []);

  useEffect(() => { loadScopes(); const t = setInterval(loadScopes, 30000); return () => clearInterval(t); }, [loadScopes]);

  // Load leases for expanded scope
  const loadScopeLeases = useCallback(async (scopeId: string) => {
    setLeasesLoading(true);
    try {
      const d = await api(`/scopes/${encodeURIComponent(scopeId)}/leases?limit=200`);
      setLeases(d.data || []);
    } finally { setLeasesLoading(false); }
  }, []);

  const toggleScope = (scope: Scope) => {
    if (expandedScope === scope.scope_id) {
      setExpandedScope(null); setLeases([]);
    } else {
      setExpandedScope(scope.scope_id);
      loadScopeLeases(scope.scope_id);
    }
  };

  // Load all leases for Leases view
  const loadAllLeases = useCallback(async (page = 1, search = leaseSearch, state = stateFilter) => {
    setAllLeasesLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LEASE_LIMIT) });
      if (search) params.set('search', search);
      if (state)  params.set('state', state);
      const d = await api(`/leases?${params}`);
      setAllLeases(d.data || []);
      setLeaseTotal(d.total || 0);
    } finally { setAllLeasesLoading(false); }
  }, [leaseSearch, stateFilter]);

  useEffect(() => { if (view === 'leases') loadAllLeases(); }, [view]);

  // Filter scopes
  const filteredScopes = useMemo(() => {
    let s = scopes;
    if (serverFilter) s = s.filter(sc => sc.server_ip === serverFilter || sc.server_hostname === serverFilter);
    if (search) { const q = search.toLowerCase(); s = s.filter(sc => sc.scope_id.includes(q) || sc.name?.toLowerCase().includes(q)); }
    return s;
  }, [scopes, serverFilter, search]);

  // Unique servers
  const servers = useMemo(() => [...new Set(scopes.map(s => s.server_ip))], [scopes]);

  // Stats
  const totalScopes    = scopes.length;
  const criticalScopes = scopes.filter(s => parseFloat(String(s.percent_used)) >= 90).length;
  const warningScopes  = scopes.filter(s => parseFloat(String(s.percent_used)) >= 80 && parseFloat(String(s.percent_used)) < 90).length;
  const totalIPs       = scopes.reduce((a, s) => a + (s.total_ips || 0), 0);
  const usedIPs        = scopes.reduce((a, s) => a + (s.in_use   || 0), 0);

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>DHCP Management</h2>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {(['scopes','leases','reservations'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
              background: view === v ? '#1a2744' : 'var(--bg-card)',
              color: view === v ? '#fff' : 'var(--text-secondary)',
              textTransform: 'capitalize',
            }}>{v}</button>
          ))}
        </div>
        <button onClick={loadScopes} style={BTN}>⟳ Refresh</button>
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10 }}>
        {[
          { l: 'Total Scopes',   v: totalScopes,   c: '#1a2744' },
          { l: '⚠ Warning',     v: warningScopes,  c: warningScopes  > 0 ? '#ca8a04' : '#16a34a' },
          { l: '🔴 Critical',   v: criticalScopes, c: criticalScopes > 0 ? '#dc2626' : '#16a34a' },
          { l: 'Total IPs',     v: totalIPs,       c: '#2563eb' },
          { l: 'Available IPs', v: totalIPs - usedIPs, c: '#16a34a' },
        ].map((t, i) => (
          <div key={i} style={{ ...CARD, padding: '12px 16px' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: t.c }}>{t.v}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{t.l}</div>
          </div>
        ))}
      </div>

      {/* ── SCOPES VIEW ── */}
      {view === 'scopes' && (
        <>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 10 }}>
            <input placeholder="Search scope ID or name..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ ...INPUT, width: 240 }} />
            {servers.length > 1 && (
              <select value={serverFilter} onChange={e => setServerFilter(e.target.value)}
                style={{ ...INPUT, width: 200 }}>
                <option value="">All servers</option>
                {servers.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </div>

          {/* Scope gauge grid */}
          <div style={{ ...CARD, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Scope Utilization</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
              Auto-refreshes every 30s · Click a scope to view leases
            </div>
            {scopes.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>
                No scopes found — add a DHCP server in Known Servers tab
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {filteredScopes.map(sc => {
                  const pct = parseFloat(String(sc.percent_used));
                  const isExp = expandedScope === sc.scope_id;
                  return (
                    <div key={sc.id} onClick={() => { setView('scopes'); toggleScope(sc); }}
                      style={{
                        width: 160, padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                        border: `2px solid ${isExp ? '#C8102E' : 'var(--border)'}`,
                        background: isExp ? '#fff8f8' : 'var(--bg-primary)',
                        transition: 'all 0.15s', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                      }}
                      onMouseEnter={e => { if (!isExp) e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)'; }}
                      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}
                    >
                      <ScopeGauge pct={pct} />
                      <div style={{ fontSize: 12, fontWeight: 700, textAlign: 'center', color: 'var(--text-primary)', lineHeight: 1.2 }}>
                        {sc.name || sc.scope_id}
                      </div>
                      <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{sc.scope_id}</div>
                      <div style={{ fontSize: 11, color: pctColor(pct) }}>{sc.in_use} / {sc.total_ips} IPs</div>
                      {sc.free < 10 && sc.free > 0 && (
                        <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 600 }}>⚠ Only {sc.free} left!</div>
                      )}
                      <div style={{ display: 'flex', gap: 4 }}>
                        <span className={`badge ${sc.state === 'Active' ? 'badge-green' : 'badge-gray'}`} style={{ fontSize: 9 }}>{sc.state}</span>
                        {sc.server_hostname && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{sc.server_hostname}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Expanded scope leases */}
          {expandedScope && (
            <div style={{ ...CARD, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', background: '#1a2744', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontWeight: 700, color: '#fff', fontFamily: 'monospace' }}>{expandedScope}</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                  {leases.length} leases
                </div>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => {
                    const scope = scopes.find(s => s.scope_id === expandedScope);
                    if (scope) setReserveTarget({ scope });
                  }}
                  style={{ ...BTN_RED, fontSize: 12 }}
                >
                  + Reserve IP
                </button>
                <button onClick={() => { setExpandedScope(null); setLeases([]); }}
                  style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 6, color: '#fff', padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>
                  ✕ Close
                </button>
              </div>
              {leasesLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Loading leases...</div>
              ) : (
                <div style={{ maxHeight: 400, overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={TH}>IP Address</th><th style={TH}>Hostname</th>
                      <th style={TH}>MAC Address</th><th style={TH}>State</th>
                      <th style={TH}>Expires</th><th style={TH}>Actions</th>
                    </tr></thead>
                    <tbody>
                      {leases.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No leases in this scope</td></tr>}
                      {leases.map(l => {
                        const scope = scopes.find(s => s.scope_id === expandedScope);
                        return (
                          <tr key={l.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{l.ip_address}</td>
                            <td style={TD}>{l.hostname || '—'}</td>
                            <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{l.mac_address || '—'}</td>
                            <td style={TD}>
                              <span className={`badge ${l.address_state === 'Active' ? 'badge-green' : l.address_state === 'Reservation' ? 'badge-blue' : 'badge-gray'}`}>
                                {l.address_state}
                              </span>
                            </td>
                            <td style={{ ...TD, fontSize: 11 }}>{l.lease_expiry ? new Date(l.lease_expiry).toLocaleString() : '—'}</td>
                            <td style={TD}>
                              {l.address_state !== 'Reservation' && l.mac_address && scope && (
                                <button
                                  onClick={() => setReserveTarget({ scope, lease: l })}
                                  style={{ fontSize: 11, color: '#7c3aed', background: 'none', border: 'none', cursor: 'pointer' }}
                                >
                                  Reserve
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Scope summary table */}
          <div style={CARD}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={TH}>Scope ID</th><th style={TH}>Name</th><th style={TH}>Range</th>
                <th style={TH}>Total</th><th style={TH}>In Use</th><th style={TH}>Free</th>
                <th style={TH}>Reserved</th><th style={TH}>Utilization</th><th style={TH}>Server</th>
              </tr></thead>
              <tbody>
                {filteredScopes.map(sc => {
                  const pct = parseFloat(String(sc.percent_used));
                  return (
                    <tr key={sc.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => toggleScope(sc)}>
                      <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{sc.scope_id}</td>
                      <td style={TD}>{sc.name || '—'}</td>
                      <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{sc.start_range} – {sc.end_range}</td>
                      <td style={TD}>{sc.total_ips}</td>
                      <td style={TD}>{sc.in_use}</td>
                      <td style={{ ...TD, color: sc.free < 10 ? '#dc2626' : 'inherit', fontWeight: sc.free < 10 ? 700 : 400 }}>{sc.free}</td>
                      <td style={TD}>{sc.reserved}</td>
                      <td style={{ ...TD, minWidth: 160 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3 }}>
                            <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: pctColor(pct), borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 600, color: pctColor(pct), minWidth: 38 }}>{pct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>{sc.server_hostname || sc.server_ip || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── LEASES VIEW ── */}
      {view === 'leases' && (
        <div style={CARD}>
          <div style={{ padding: '12px 16px', display: 'flex', gap: 10, borderBottom: '1px solid var(--border)' }}>
            <input placeholder="Search IP, hostname, MAC..." value={leaseSearch}
              onChange={e => { setLeaseSearch(e.target.value); setLeasePage(1); loadAllLeases(1, e.target.value, stateFilter); }}
              style={{ ...INPUT, width: 260 }} />
            <select value={stateFilter} onChange={e => { setStateFilter(e.target.value); setLeasePage(1); loadAllLeases(1, leaseSearch, e.target.value); }}
              style={{ ...INPUT, width: 160 }}>
              <option value="">All states</option>
              <option value="Active">Active</option>
              <option value="Expired">Expired</option>
              <option value="Reservation">Reservation</option>
            </select>
            <div style={{ flex: 1 }} />
            <a href="/api/leases/export" download style={{ ...BTN, textDecoration: 'none', display: 'flex', alignItems: 'center' }}>⬇ Export CSV</a>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>{leaseTotal} total</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={TH}>IP Address</th><th style={TH}>Hostname</th><th style={TH}>MAC Address</th>
              <th style={TH}>Scope</th><th style={TH}>State</th><th style={TH}>Expires</th><th style={TH}>Actions</th>
            </tr></thead>
            <tbody>
              {allLeasesLoading && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Loading...</td></tr>}
              {!allLeasesLoading && allLeases.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No leases found</td></tr>}
              {allLeases.map(l => {
                const scope = scopes.find(s => s.scope_id === l.scope_id);
                return (
                  <tr key={l.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{l.ip_address}</td>
                    <td style={TD}>{l.hostname || '—'}</td>
                    <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{l.mac_address || '—'}</td>
                    <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{l.scope_id || '—'}</td>
                    <td style={TD}>
                      <span className={`badge ${l.address_state === 'Active' ? 'badge-green' : l.address_state === 'Reservation' ? 'badge-blue' : 'badge-gray'}`}>
                        {l.address_state}
                      </span>
                    </td>
                    <td style={{ ...TD, fontSize: 11 }}>{l.lease_expiry ? new Date(l.lease_expiry).toLocaleString() : '—'}</td>
                    <td style={TD}>
                      {l.address_state !== 'Reservation' && l.mac_address && scope && (
                        <button onClick={() => setReserveTarget({ scope, lease: l })}
                          style={{ fontSize: 11, color: '#7c3aed', background: 'none', border: 'none', cursor: 'pointer' }}>
                          Reserve
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: 12 }}>
            {leasePage > 1 && <button onClick={() => { setLeasePage(p => p-1); loadAllLeases(leasePage-1); }} style={BTN}>← Prev</button>}
            <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>Page {leasePage} · {leaseTotal} leases</span>
            {allLeases.length === LEASE_LIMIT && <button onClick={() => { setLeasePage(p => p+1); loadAllLeases(leasePage+1); }} style={BTN}>Next →</button>}
          </div>
        </div>
      )}

      {/* ── RESERVATIONS VIEW ── */}
      {view === 'reservations' && (
        <div style={CARD}>
          <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>DHCP Reservations</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Select a scope above then click Reserve on a lease to add reservations
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={TH}>IP Address</th><th style={TH}>Hostname</th>
              <th style={TH}>MAC Address</th><th style={TH}>Scope</th><th style={TH}>Server</th>
            </tr></thead>
            <tbody>
              {scopes.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No DHCP servers configured</td></tr>}
              {/* Show reserved leases from DB */}
              {allLeases.filter(l => l.address_state === 'Reservation').map(l => (
                <tr key={l.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{l.ip_address}</td>
                  <td style={TD}>{l.hostname || '—'}</td>
                  <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{l.mac_address || '—'}</td>
                  <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{l.scope_id || '—'}</td>
                  <td style={TD}>{scopes.find(s => s.scope_id === l.scope_id)?.server_hostname || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Reserve modal */}
      {reserveTarget && (
        <ReserveModal
          scope={reserveTarget.scope}
          lease={reserveTarget.lease}
          onClose={() => setReserveTarget(null)}
          onDone={() => {
            setReserveTarget(null);
            loadScopes();
            if (expandedScope) loadScopeLeases(expandedScope);
          }}
        />
      )}
    </div>
  );
}
