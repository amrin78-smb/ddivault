'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import {
  PageHeader, EmptyState, TableSkeleton, UtilBar, Spinner,
  pctColor, useRefreshKey, useEscape,
} from '@/components/ui';

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
  percent_used: number | string;
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

type View = 'scopes' | 'leases' | 'reservations';

// ── API helper ────────────────────────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────
function pctNum(v: number | string): number {
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

function stateBadge(state: string): string {
  if (state === 'Active') return 'badge-green';
  if (state === 'Reservation') return 'badge-blue';
  if (state === 'Full') return 'badge-red';
  if (state === 'Disabled' || state === 'Inactive') return 'badge-gray';
  if (state === 'Expired') return 'badge-yellow';
  return 'badge-gray';
}

function fmtDate(d: string): string {
  return d ? new Date(d).toLocaleString() : '—';
}

// ── Shared inline styles (design-system aligned) ──────────────
const INPUT: React.CSSProperties = {
  padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, outline: 'none',
  fontFamily: 'inherit',
};

// ════════════════════════════════════════════════════════════
// ReserveModal (module scope)
// ════════════════════════════════════════════════════════════
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
  useEscape(onClose);

  const reserve = async () => {
    if (!form.ip_address.trim() || !form.mac_address.trim()) {
      toast('IP address and MAC address are required', 'error'); return;
    }
    setLoading(true);
    try {
      await api('/dhcp/reservations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: scope.server_id, scope_id: scope.scope_id, ...form }),
      });
      toast(`Reserved ${form.ip_address} on ${scope.server_hostname || 'DHCP server'}`, 'success');
      onDone();
    } catch (e: any) {
      toast(e.message || 'Failed to create reservation', 'error');
    } finally { setLoading(false); }
  };

  const fields: { k: keyof typeof form; l: string; ph: string }[] = [
    { k: 'ip_address',  l: 'IP Address *',          ph: '192.168.1.100' },
    { k: 'mac_address', l: 'MAC Address (client) *', ph: 'AA-BB-CC-DD-EE-FF' },
    { k: 'name',        l: 'Name / Hostname',        ph: 'PRINTER-01' },
    { k: 'description', l: 'Description',            ph: 'Network printer, Floor 2' },
  ];

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 24, width: 460,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Reserve IP Address</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Scope <span className="mono">{scope.scope_id}</span>{scope.name ? ` · ${scope.name}` : ''}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, lineHeight: 1, color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{
          background: 'var(--primary-light)', border: '1px solid #fde047',
          borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 12, marginBottom: 16, color: 'var(--yellow)',
        }}>
          This runs <span className="mono">Add-DhcpServerv4Reservation</span> on your Windows DHCP server via PowerShell remoting.
        </div>

        {fields.map(f => (
          <div key={f.k} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>{f.l}</label>
            <input
              value={form[f.k]}
              placeholder={f.ph}
              onChange={e => setForm(p => ({ ...p, [f.k]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') reserve(); }}
              style={{ ...INPUT, width: '100%' }}
            />
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={reserve} disabled={loading} style={{ opacity: loading ? 0.7 : 1 }}>
            {loading ? <><Spinner size={12} color="#fff" /> Reserving…</> : 'Reserve on DHCP Server'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN DHCP TAB
// ════════════════════════════════════════════════════════════
export default function DHCPTab({ focusScope }: { focusScope?: string | null }) {
  const { toast } = useToast();
  const { canWrite } = useRBAC();

  // Scopes state
  const [scopes, setScopes]       = useState<Scope[]>([]);
  const [scopesLoading, setScopesLoading] = useState(true);
  const [view, setView]           = useState<View>('scopes');

  // Scope filters
  const [search, setSearch]       = useState('');
  const [serverFilter, setServerFilter] = useState('');
  const [scopeStateFilter, setScopeStateFilter] = useState('');

  // Accordion (expanded scope) state
  const [expandedScope, setExpandedScope] = useState<string | null>(null);
  const [scopeLeases, setScopeLeases]     = useState<Lease[]>([]);
  const [scopeLeasesLoading, setScopeLeasesLoading] = useState(false);
  const [scopeLeaseSearch, setScopeLeaseSearch]     = useState('');

  // Reserve modal
  const [reserveTarget, setReserveTarget] = useState<{ scope: Scope; lease?: Lease } | null>(null);

  // Leases view (server-side pagination)
  const LEASE_LIMIT = 50;
  const [allLeases, setAllLeases] = useState<Lease[]>([]);
  const [allLeasesLoading, setAllLeasesLoading] = useState(false);
  const [leasePage, setLeasePage] = useState(1);
  const [leaseTotal, setLeaseTotal] = useState(0);
  const [leaseSearch, setLeaseSearch] = useState('');
  const [leaseStateFilter, setLeaseStateFilter] = useState('');

  // Reservations view
  const [reservations, setReservations] = useState<Lease[]>([]);
  const [reservationsLoading, setReservationsLoading] = useState(false);
  const [reservationSearch, setReservationSearch] = useState('');

  // ── Load scopes ─────────────────────────────────────────────
  const loadScopes = useCallback(async () => {
    try {
      const d = await api('/scopes');
      setScopes(d.data || []);
    } catch (e: any) {
      toast(e.message || 'Failed to load scopes', 'error');
    } finally {
      setScopesLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadScopes();
    const t = setInterval(loadScopes, 30000);
    return () => clearInterval(t);
  }, [loadScopes]);

  useRefreshKey(loadScopes);

  // ── Load leases for an expanded scope ───────────────────────
  const loadScopeLeases = useCallback(async (scopeId: string) => {
    setScopeLeasesLoading(true);
    try {
      const d = await api(`/scopes/${encodeURIComponent(scopeId)}/leases?limit=200`);
      setScopeLeases(d.data || []);
    } catch (e: any) {
      toast(e.message || 'Failed to load leases', 'error');
      setScopeLeases([]);
    } finally {
      setScopeLeasesLoading(false);
    }
  }, [toast]);

  const toggleScope = useCallback((scope: Scope) => {
    if (expandedScope === scope.scope_id) {
      setExpandedScope(null);
      setScopeLeases([]);
      setScopeLeaseSearch('');
    } else {
      setExpandedScope(scope.scope_id);
      setScopeLeaseSearch('');
      loadScopeLeases(scope.scope_id);
    }
  }, [expandedScope, loadScopeLeases]);

  // ── focusScope handling ─────────────────────────────────────
  useEffect(() => {
    if (focusScope && focusScope.trim()) {
      setView('scopes');
      setSearch(focusScope);
      setExpandedScope(focusScope);
      setScopeLeaseSearch('');
      loadScopeLeases(focusScope);
    }
  }, [focusScope, loadScopeLeases]);

  // ── Load all leases (Leases view) ───────────────────────────
  const loadAllLeases = useCallback(async (page: number, searchQ: string, state: string) => {
    setAllLeasesLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LEASE_LIMIT) });
      if (searchQ) params.set('search', searchQ);
      if (state)   params.set('state', state);
      const d = await api(`/leases?${params}`);
      setAllLeases(d.data || []);
      setLeaseTotal(d.total || 0);
    } catch (e: any) {
      toast(e.message || 'Failed to load leases', 'error');
      setAllLeases([]); setLeaseTotal(0);
    } finally {
      setAllLeasesLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (view === 'leases') loadAllLeases(leasePage, leaseSearch, leaseStateFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, leasePage]);

  // ── Load reservations (Reservations view) ───────────────────
  const loadReservations = useCallback(async (searchQ: string) => {
    setReservationsLoading(true);
    try {
      const params = new URLSearchParams({ state: 'Reservation', limit: '500' });
      if (searchQ) params.set('search', searchQ);
      const d = await api(`/leases?${params}`);
      setReservations(d.data || []);
    } catch (e: any) {
      toast(e.message || 'Failed to load reservations', 'error');
      setReservations([]);
    } finally {
      setReservationsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (view === 'reservations') loadReservations(reservationSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ── Derived: unique servers ─────────────────────────────────
  const servers = useMemo(() => {
    const map = new Map<string, string>(); // value -> label
    scopes.forEach(s => {
      const val = s.server_hostname || s.server_ip;
      if (val && !map.has(val)) map.set(val, s.server_hostname ? `${s.server_hostname}${s.server_ip ? ` (${s.server_ip})` : ''}` : s.server_ip);
    });
    return Array.from(map.entries());
  }, [scopes]);

  // ── Derived: filtered scopes ────────────────────────────────
  const filteredScopes = useMemo(() => {
    let s = scopes;
    if (serverFilter) s = s.filter(sc => sc.server_hostname === serverFilter || sc.server_ip === serverFilter);
    if (scopeStateFilter) {
      if (scopeStateFilter === 'Full') s = s.filter(sc => (sc.free ?? 0) <= 0);
      else if (scopeStateFilter === 'Active') s = s.filter(sc => sc.state === 'Active');
      else if (scopeStateFilter === 'Disabled') s = s.filter(sc => sc.state !== 'Active');
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      s = s.filter(sc => sc.scope_id.toLowerCase().includes(q) || (sc.name || '').toLowerCase().includes(q));
    }
    return s;
  }, [scopes, serverFilter, scopeStateFilter, search]);

  // ── Derived: filtered scope leases (accordion inline search) ─
  const filteredScopeLeases = useMemo(() => {
    if (!scopeLeaseSearch.trim()) return scopeLeases;
    const q = scopeLeaseSearch.toLowerCase();
    return scopeLeases.filter(l =>
      (l.ip_address || '').toLowerCase().includes(q) ||
      (l.hostname || '').toLowerCase().includes(q) ||
      (l.mac_address || '').toLowerCase().includes(q)
    );
  }, [scopeLeases, scopeLeaseSearch]);

  // ── Derived: KPI stats ──────────────────────────────────────
  const stats = useMemo(() => {
    const total = scopes.length;
    let warning = 0, critical = 0, totalIPs = 0, usedIPs = 0;
    scopes.forEach(s => {
      const p = pctNum(s.percent_used);
      if (p >= 90) critical++;
      else if (p >= 80) warning++;
      totalIPs += s.total_ips || 0;
      usedIPs += s.in_use || 0;
    });
    return { total, warning, critical, totalIPs, available: totalIPs - usedIPs };
  }, [scopes]);

  const kpis = [
    { label: 'Total Scopes',   value: stats.total,      color: 'var(--navy)' },
    { label: 'Warning 80–90%', value: stats.warning,    color: 'var(--yellow)' },
    { label: 'Critical ≥90%',  value: stats.critical,   color: 'var(--red)' },
    { label: 'Total IPs',      value: stats.totalIPs,   color: 'var(--blue)' },
    { label: 'Available IPs',  value: stats.available,  color: 'var(--green)' },
  ];

  // ── Render ──────────────────────────────────────────────────
  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <PageHeader title="DHCP" subtitle="Scope utilization, leases, and reservations across your DHCP servers">
        <div className="segmented" role="tablist">
          {(['scopes', 'leases', 'reservations'] as View[]).map(v => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)} style={{ textTransform: 'capitalize' }}>
              {v}
            </button>
          ))}
        </div>
        <button className="btn" onClick={loadScopes} title="Refresh (R)">⟳ Refresh</button>
      </PageHeader>

      <ReadOnlyBanner />

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        {kpis.map((k, i) => (
          <div key={i} className="kpi-card" style={{ borderLeftColor: k.color }}>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.5px', color: k.color }}>
              {k.value.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontWeight: 500 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* ── SCOPES VIEW ── */}
      {view === 'scopes' && (
        <>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              placeholder="Search scope ID or name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...INPUT, width: 260 }}
            />
            {servers.length > 1 && (
              <select value={serverFilter} onChange={e => setServerFilter(e.target.value)} style={{ ...INPUT, width: 220 }}>
                <option value="">All servers</option>
                {servers.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
              </select>
            )}
            <select value={scopeStateFilter} onChange={e => setScopeStateFilter(e.target.value)} style={{ ...INPUT, width: 150 }}>
              <option value="">All states</option>
              <option value="Active">Active</option>
              <option value="Full">Full</option>
              <option value="Disabled">Disabled</option>
            </select>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {filteredScopes.length} of {scopes.length} scopes · auto-refresh 30s
            </span>
          </div>

          {/* Dense scope table */}
          <div className="card" style={{ overflow: 'hidden' }}>
            {scopesLoading ? (
              <TableSkeleton rows={8} cols={10} />
            ) : scopes.length === 0 ? (
              <EmptyState
                icon="◇"
                title="No DHCP scopes yet"
                message="Add a DHCP server in the Known Servers tab to begin monitoring."
              />
            ) : filteredScopes.length === 0 ? (
              <EmptyState icon="◇" title="No scopes match your filters" message="Try adjusting the search or filters above." />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Scope ID</th>
                      <th>Name</th>
                      <th>Server</th>
                      <th>Range</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th style={{ textAlign: 'right' }}>Used</th>
                      <th style={{ textAlign: 'right' }}>Free</th>
                      <th style={{ minWidth: 160 }}>% Used</th>
                      <th>State</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredScopes.map(sc => {
                      const pct = pctNum(sc.percent_used);
                      const isExp = expandedScope === sc.scope_id;
                      const lowFree = (sc.free ?? 0) < 10;
                      return (
                        <ScopeRow
                          key={sc.id}
                          scope={sc}
                          pct={pct}
                          isExpanded={isExp}
                          lowFree={lowFree}
                          onToggle={() => toggleScope(sc)}
                          onReserve={() => setReserveTarget({ scope: sc })}
                          leases={filteredScopeLeases}
                          leasesLoading={scopeLeasesLoading}
                          leaseSearch={scopeLeaseSearch}
                          onLeaseSearch={setScopeLeaseSearch}
                          onReserveLease={(l) => setReserveTarget({ scope: sc, lease: l })}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── LEASES VIEW ── */}
      {view === 'leases' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', display: 'flex', gap: 10, borderBottom: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              placeholder="Search IP, hostname, MAC…"
              value={leaseSearch}
              onChange={e => { setLeaseSearch(e.target.value); setLeasePage(1); loadAllLeases(1, e.target.value, leaseStateFilter); }}
              style={{ ...INPUT, width: 280 }}
            />
            <select
              value={leaseStateFilter}
              onChange={e => { setLeaseStateFilter(e.target.value); setLeasePage(1); loadAllLeases(1, leaseSearch, e.target.value); }}
              style={{ ...INPUT, width: 160 }}
            >
              <option value="">All states</option>
              <option value="Active">Active</option>
              <option value="Expired">Expired</option>
              <option value="Reservation">Reservation</option>
            </select>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{leaseTotal.toLocaleString()} total</span>
            <a href="/api/leases/export" download className="btn" style={{ textDecoration: 'none' }}>⬇ Export CSV</a>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>IP Address</th><th>Hostname</th><th>MAC Address</th>
                  <th>Scope</th><th>State</th><th>Expires</th><th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allLeasesLoading && (
                  <tr><td colSpan={7} style={{ padding: 0 }}><TableSkeleton rows={6} cols={7} /></td></tr>
                )}
                {!allLeasesLoading && allLeases.length === 0 && (
                  <tr><td colSpan={7}><EmptyState icon="◇" title="No leases found" message="Try a different search or state filter." /></td></tr>
                )}
                {!allLeasesLoading && allLeases.map(l => {
                  const scope = scopes.find(s => s.scope_id === l.scope_id);
                  const canReserve = l.address_state !== 'Reservation' && !!l.mac_address && !!scope;
                  return (
                    <tr key={l.id}>
                      <td className="mono" style={{ fontWeight: 600 }}>{l.ip_address}</td>
                      <td>{l.hostname || '—'}</td>
                      <td className="mono">{l.mac_address || '—'}</td>
                      <td className="mono">{l.scope_id || '—'}</td>
                      <td><span className={`badge ${stateBadge(l.address_state)}`}>{l.address_state}</span></td>
                      <td style={{ fontSize: 12 }}>{fmtDate(l.lease_expiry)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {canWrite && canReserve && (
                          <button onClick={() => setReserveTarget({ scope: scope!, lease: l })}
                            style={{ fontSize: 12, color: 'var(--purple)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
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
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, padding: 14, borderTop: '1px solid var(--border)' }}>
            <button className="btn" disabled={leasePage <= 1} onClick={() => setLeasePage(p => Math.max(1, p - 1))}
              style={{ opacity: leasePage <= 1 ? 0.5 : 1 }}>← Prev</button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Page {leasePage} of {Math.max(1, Math.ceil(leaseTotal / LEASE_LIMIT))} · {leaseTotal.toLocaleString()} leases
            </span>
            <button className="btn" disabled={allLeases.length < LEASE_LIMIT} onClick={() => setLeasePage(p => p + 1)}
              style={{ opacity: allLeases.length < LEASE_LIMIT ? 0.5 : 1 }}>Next →</button>
          </div>
        </div>
      )}

      {/* ── RESERVATIONS VIEW ── */}
      {view === 'reservations' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', display: 'flex', gap: 10, borderBottom: '1px solid var(--border)', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>DHCP Reservations</div>
            <div style={{ flex: 1 }} />
            <input
              placeholder="Search IP, hostname, MAC…"
              value={reservationSearch}
              onChange={e => { setReservationSearch(e.target.value); loadReservations(e.target.value); }}
              style={{ ...INPUT, width: 280 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{reservations.length.toLocaleString()} reservations</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>IP Address</th><th>Hostname</th><th>MAC Address</th><th>Scope</th><th>Server</th>
                </tr>
              </thead>
              <tbody>
                {reservationsLoading && (
                  <tr><td colSpan={5} style={{ padding: 0 }}><TableSkeleton rows={6} cols={5} /></td></tr>
                )}
                {!reservationsLoading && reservations.length === 0 && (
                  <tr><td colSpan={5}>
                    <EmptyState
                      icon="◇"
                      title="No reservations yet"
                      message="Open a scope in the Scopes view and reserve an IP from one of its leases."
                    />
                  </td></tr>
                )}
                {!reservationsLoading && reservations.map(l => {
                  const scope = scopes.find(s => s.scope_id === l.scope_id);
                  return (
                    <tr key={l.id}>
                      <td className="mono" style={{ fontWeight: 600 }}>{l.ip_address}</td>
                      <td>{l.hostname || '—'}</td>
                      <td className="mono">{l.mac_address || '—'}</td>
                      <td className="mono">{l.scope_id || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{scope?.server_hostname || scope?.server_ip || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
            if (view === 'reservations') loadReservations(reservationSearch);
            if (view === 'leases') loadAllLeases(leasePage, leaseSearch, leaseStateFilter);
          }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// ScopeRow (module scope) — table row + inline accordion panel
// ════════════════════════════════════════════════════════════
function ScopeRow({
  scope, pct, isExpanded, lowFree, onToggle, onReserve,
  leases, leasesLoading, leaseSearch, onLeaseSearch, onReserveLease,
}: {
  scope: Scope;
  pct: number;
  isExpanded: boolean;
  lowFree: boolean;
  onToggle: () => void;
  onReserve: () => void;
  leases: Lease[];
  leasesLoading: boolean;
  leaseSearch: string;
  onLeaseSearch: (v: string) => void;
  onReserveLease: (l: Lease) => void;
}) {
  const { canWrite } = useRBAC();
  return (
    <>
      <tr
        className="clickable"
        onClick={onToggle}
        style={{
          background: isExpanded ? 'var(--primary-light)' : undefined,
          boxShadow: isExpanded ? 'inset 3px 0 0 var(--primary)' : undefined,
        }}
      >
        <td className="mono" style={{ fontWeight: 700 }}>
          <span style={{ display: 'inline-block', width: 12, color: 'var(--text-muted)', marginRight: 4 }}>{isExpanded ? '▾' : '▸'}</span>
          {scope.scope_id}
        </td>
        <td>{scope.name || '—'}</td>
        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{scope.server_hostname || scope.server_ip || '—'}</td>
        <td className="mono" style={{ fontSize: 12 }}>{scope.start_range} – {scope.end_range}</td>
        <td style={{ textAlign: 'right' }}>{(scope.total_ips ?? 0).toLocaleString()}</td>
        <td style={{ textAlign: 'right' }}>{(scope.in_use ?? 0).toLocaleString()}</td>
        <td style={{ textAlign: 'right', color: lowFree ? 'var(--red)' : undefined, fontWeight: lowFree ? 700 : 400 }}>
          {(scope.free ?? 0).toLocaleString()}
        </td>
        <td><UtilBar pct={pct} /></td>
        <td><span className={`badge ${stateBadge((scope.free ?? 0) <= 0 ? 'Full' : scope.state)}`}>{(scope.free ?? 0) <= 0 ? 'Full' : scope.state}</span></td>
        <td style={{ textAlign: 'right' }}>
          {canWrite && (
            <button
              onClick={(e) => { e.stopPropagation(); onReserve(); }}
              style={{ fontSize: 12, color: 'var(--purple)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
            >
              Reserve
            </button>
          )}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={10} style={{ padding: 0, background: 'var(--bg-primary)' }}>
            <div style={{ padding: 16 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                <input
                  placeholder="Filter leases by IP, hostname, MAC…"
                  value={leaseSearch}
                  onChange={e => onLeaseSearch(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  style={{ ...INPUT, width: 280 }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {leasesLoading ? 'Loading…' : `${leases.length} lease${leases.length === 1 ? '' : 's'}`}
                </span>
                <div style={{ flex: 1 }} />
                {canWrite && (
                  <button className="btn btn-primary" onClick={(e) => { e.stopPropagation(); onReserve(); }}>+ Reserve IP</button>
                )}
              </div>

              <div className="card" style={{ overflow: 'hidden', maxHeight: 420, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>IP Address</th><th>Hostname</th><th>MAC Address</th>
                      <th>State</th><th>Expires</th><th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leasesLoading && (
                      <tr><td colSpan={6} style={{ padding: 0 }}><TableSkeleton rows={4} cols={6} /></td></tr>
                    )}
                    {!leasesLoading && leases.length === 0 && (
                      <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No leases in this scope</td></tr>
                    )}
                    {!leasesLoading && leases.map(l => {
                      const canReserve = l.address_state !== 'Reservation' && !!l.mac_address;
                      return (
                        <tr key={l.id}>
                          <td className="mono" style={{ fontWeight: 600 }}>{l.ip_address}</td>
                          <td>{l.hostname || '—'}</td>
                          <td className="mono">{l.mac_address || '—'}</td>
                          <td><span className={`badge ${stateBadge(l.address_state)}`}>{l.address_state}</span></td>
                          <td style={{ fontSize: 12 }}>{fmtDate(l.lease_expiry)}</td>
                          <td style={{ textAlign: 'right' }}>
                            {canWrite && canReserve && (
                              <button onClick={(e) => { e.stopPropagation(); onReserveLease(l); }}
                                style={{ fontSize: 12, color: 'var(--purple)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
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
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
