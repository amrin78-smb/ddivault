'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { PageHeader, EmptyState, TableSkeleton, Skeleton, useRefreshKey } from '@/components/ui';
import { useRBAC } from '@/components/RBACContext';

// ── Types ─────────────────────────────────────────────────────
interface AuditEntry {
  id: number;
  timestamp: string;
  username: string;
  user_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  old_value: unknown;
  new_value: unknown;
  change_summary: string | null;
  ip_address: string | null;
  user_agent: string | null;
  result: string;
  error_message: string | null;
  duration_ms: number | null;
}
interface AuditStats {
  today: number;
  week: number;
  top_user: string;
  top_entity: string;
  top_actions: { action: string; c: string }[];
}

const CARD: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)' };
const TITLE: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' };

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// ── Action → badge colour ─────────────────────────────────────
const ACTION_BADGE: Record<string, string> = {
  create: 'badge-green', delete: 'badge-red', modify: 'badge-yellow',
  login: 'badge-blue', logout: 'badge-blue',
  scan: 'badge-purple', export: 'badge-gray', import: 'badge-purple',
  reserve: 'badge-teal', release: 'badge-gray', test: 'badge-blue', acknowledge: 'badge-blue',
};
function ActionBadge({ action }: { action: string }) {
  const a = (action || '').toLowerCase();
  return <span className={`badge ${ACTION_BADGE[a] || 'badge-gray'}`}>{action?.toUpperCase() || '—'}</span>;
}

function avatarInitial(name: string) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div style={{ flex: 1, minWidth: 200 }}>
      <div style={{ ...MUTED, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <pre style={{
        margin: 0, fontSize: 11, lineHeight: 1.5, padding: 10, borderRadius: 8, overflow: 'auto', maxHeight: 200,
        background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
        fontFamily: "'JetBrains Mono', monospace",
      }}>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

// ── Stat tile ─────────────────────────────────────────────────
function StatTile({ value, label, sub, color }: { value: React.ReactNode; label: string; sub?: string; color?: string }) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: color || 'var(--navy)' }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: color || 'var(--navy)', lineHeight: 1, letterSpacing: '-0.5px' }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginTop: 8 }}>{label}</div>
      {sub && <div style={{ ...MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function AuditTab() {
  const { canManageSystem } = useRBAC();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  // filters
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [username, setUsername] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: '50' });
    if (action) p.set('action', action);
    if (entityType) p.set('entity_type', entityType);
    if (username) p.set('username', username);
    if (from) p.set('from', new Date(from).toISOString());
    if (to) p.set('to', new Date(to).toISOString());
    if (search) p.set('q', search);
    return p.toString();
  }, [page, action, entityType, username, from, to, search]);

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const [list, st] = await Promise.all([api(`/audit?${queryString}`), api('/audit/stats')]);
      setEntries(list.data || []);
      setTotal(list.total || 0);
      setStats(st);
    } catch { /* ignore transient */ }
    setLoading(false);
  }, [queryString]);

  useEffect(() => { load(true); }, [load]);
  // real-time: poll every 10s on the first page with no active expansion
  useEffect(() => {
    const t = setInterval(() => { if (page === 1) load(false); }, 10000);
    return () => clearInterval(t);
  }, [load, page]);
  useRefreshKey(() => load(true));

  const exportCsv = () => {
    const p = new URLSearchParams();
    if (action) p.set('action', action);
    if (entityType) p.set('entity_type', entityType);
    if (username) p.set('username', username);
    if (from) p.set('from', new Date(from).toISOString());
    if (to) p.set('to', new Date(to).toISOString());
    if (search) p.set('q', search);
    window.open(`/api/audit/export?${p.toString()}`, '_blank');
  };

  const resetFilters = () => { setAction(''); setEntityType(''); setUsername(''); setFrom(''); setTo(''); setSearch(''); setPage(1); };
  const hasFilters = action || entityType || username || from || to || search;

  const entityTypes = ['server', 'dns_zone', 'dns_record', 'dhcp_reservation', 'subnet', 'supernet', 'ip_address', 'setting', 'api_key', 'report', 'audit_log'];
  const actions = ['create', 'modify', 'delete', 'scan', 'import', 'export', 'reserve', 'release', 'test', 'login', 'logout'];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader title="Audit Log" subtitle="Every change across DNS, DHCP, IPAM and settings — who, what, when, and from where. Live-updates every 10s.">
        {canManageSystem && (
          <button className="btn" onClick={exportCsv}>Export CSV</button>
        )}
      </PageHeader>

      {/* Stat tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        {!stats
          ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="kpi-card"><Skeleton height={26} width="40%" /><div style={{ height: 8 }} /><Skeleton height={12} width="70%" /></div>)
          : (
            <>
              <StatTile value={stats.today} label="Changes Today" sub="since midnight" color="var(--blue)" />
              <StatTile value={stats.week} label="This Week" sub="last 7 days" color="var(--teal)" />
              <StatTile value={stats.top_user} label="Most Active User" sub="past 7 days" color="var(--primary)" />
              <StatTile value={stats.top_entity} label="Top Changed Entity" sub="past 7 days" color="var(--navy)" />
            </>
          )}
      </div>

      {/* Filters */}
      <div style={{ ...CARD, padding: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" placeholder="Search summary / entity…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} style={{ minWidth: 200, flex: 1 }} />
        <select className="input" value={action} onChange={e => { setAction(e.target.value); setPage(1); }}>
          <option value="">All actions</option>
          {actions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="input" value={entityType} onChange={e => { setEntityType(e.target.value); setPage(1); }}>
          <option value="">All entities</option>
          {entityTypes.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <input className="input" placeholder="Username" value={username} onChange={e => { setUsername(e.target.value); setPage(1); }} style={{ width: 130 }} />
        <input className="input" type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} title="From" />
        <input className="input" type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} title="To" />
        {hasFilters && <button className="btn" onClick={resetFilters}>Clear</button>}
      </div>

      {/* Timeline */}
      <div style={CARD}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={TITLE}>Activity Timeline</div>
          <span style={MUTED}>{total} entries</span>
        </div>
        {loading ? <TableSkeleton rows={8} cols={4} /> : entries.length === 0 ? (
          <EmptyState
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}
            title="No audit entries"
            message={hasFilters ? 'No changes match these filters.' : 'Changes will appear here as soon as anyone modifies DNS, DHCP, IPAM or settings.'}
          />
        ) : (
          <div>
            {entries.map(e => {
              const open = expanded === e.id;
              return (
                <div key={e.id} style={{ borderBottom: '1px solid var(--border-light)' }}>
                  <div
                    className="clickable"
                    onClick={() => setExpanded(open ? null : e.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', cursor: 'pointer' }}
                  >
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: e.result === 'success' ? 'var(--navy)' : 'var(--red)', color: '#fff', fontWeight: 700, fontSize: 13,
                    }}>{avatarInitial(e.username)}</div>
                    <div style={{ width: 92, flexShrink: 0 }}><ActionBadge action={e.action} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.change_summary || `${e.action} ${e.entity_type}`}
                      </div>
                      <div style={{ ...MUTED, marginTop: 1 }}>
                        <strong style={{ color: 'var(--text-secondary)' }}>{e.username}</strong>
                        {e.entity_type && <> · {e.entity_type}</>}
                        {e.result !== 'success' && <span style={{ color: 'var(--red)', fontWeight: 600 }}> · {e.result}</span>}
                      </div>
                    </div>
                    <div style={{ ...MUTED, whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                      {new Date(e.timestamp).toLocaleString()}
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}><polyline points="6 9 12 15 18 9"/></svg>
                  </div>
                  {open && (
                    <div style={{ padding: '4px 18px 18px 64px', background: 'var(--bg-primary)' }}>
                      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
                        <div><span style={MUTED}>IP Address</span><div style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>{e.ip_address || '—'}</div></div>
                        <div><span style={MUTED}>Role</span><div style={{ fontSize: 12 }}>{e.user_role || '—'}</div></div>
                        <div><span style={MUTED}>Duration</span><div style={{ fontSize: 12 }}>{e.duration_ms != null ? `${e.duration_ms} ms` : '—'}</div></div>
                        <div><span style={MUTED}>Entity ID</span><div style={{ fontSize: 12 }}>{e.entity_id || '—'}</div></div>
                        <div style={{ maxWidth: 360 }}><span style={MUTED}>User Agent</span><div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.user_agent || '—'}</div></div>
                      </div>
                      {e.error_message && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>Error: {e.error_message}</div>}
                      {(e.old_value != null || e.new_value != null) && (
                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                          <JsonBlock label="Before" value={e.old_value} />
                          <JsonBlock label="After" value={e.new_value} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* Pagination */}
        {!loading && total > 50 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: 14 }}>
            {page > 1 && <button className="btn" onClick={() => setPage(p => p - 1)}>← Prev</button>}
            <span style={{ ...MUTED, padding: '6px 0' }}>Page {page} of {Math.max(1, Math.ceil(total / 50))}</span>
            {page < Math.ceil(total / 50) && <button className="btn" onClick={() => setPage(p => p + 1)}>Next →</button>}
          </div>
        )}
      </div>
    </div>
  );
}
