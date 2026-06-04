'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
import {
  PageHeader, EmptyState, TableSkeleton, Skeleton,
  useRefreshKey, useEscape,
} from '@/components/ui';

// ── Types ─────────────────────────────────────────────────────
interface DnsServer {
  id: number;
  hostname: string;
  ip_address: string;
  role: string;
  poll_status: string;
  last_polled: string;
}

interface DnsZone {
  id: number;
  server_id: number;
  zone_name: string;
  zone_type: string;
  is_reverse: boolean;
  is_ds_integrated: boolean;
  record_count: number;
  last_updated: string;
  server_hostname: string;
}

interface DnsRecord {
  id: number;
  zone_id: number;
  hostname: string;
  record_type: string;
  record_data: string;
  ttl: number;
  zone_name: string;
}

// ── Record type colours ───────────────────────────────────────
const RECORD_COLORS: Record<string, string> = {
  A: '#2563eb', AAAA: '#7c3aed', CNAME: '#16a34a', MX: '#ca8a04',
  PTR: '#0891b2', TXT: '#ea580c', NS: '#6b7280', SRV: '#C8102E',
};

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'PTR', 'TXT', 'NS', 'SRV'];
const ADD_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'PTR', 'TXT', 'NS'];
const RECORD_LIMIT = 100;

// ── API helper ────────────────────────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ── Relative / short time helper ──────────────────────────────
function shortTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Shared inline styles ──────────────────────────────────────
const INPUT: React.CSSProperties = {
  width: '100%', padding: '7px 11px', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)',
  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
};

const TYPE_LABELS: Record<string, string> = {
  A: 'IPv4 Address', AAAA: 'IPv6 Address', CNAME: 'Alias', MX: 'Mail Exchange',
  PTR: 'Reverse Lookup', TXT: 'Text Record', NS: 'Name Server',
};

const PS_WARNING: React.CSSProperties = {
  background: '#fef9c3', border: '1px solid #fde047', borderRadius: 'var(--radius-sm)',
  padding: '8px 12px', fontSize: 12, marginBottom: 14, color: '#a16207',
};

// ════════════════════════════════════════════════════════════
// Record type badge (module scope)
// ════════════════════════════════════════════════════════════
function TypeBadge({ type, small }: { type: string; small?: boolean }) {
  const color = RECORD_COLORS[type] || '#6b7280';
  return (
    <span style={{
      display: 'inline-block', padding: small ? '1px 6px' : '2px 8px', borderRadius: 4,
      background: color + '22', color, fontSize: small ? 10 : 11, fontWeight: 700,
      letterSpacing: '0.02em',
    }}>{type}</span>
  );
}

// ════════════════════════════════════════════════════════════
// Add Record Modal (module scope)
// ════════════════════════════════════════════════════════════
function AddRecordModal({ zone, servers, onClose, onDone }: {
  zone: DnsZone; servers: DnsServer[]; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = useState({
    record_type: 'A', hostname: '', record_data: '', ttl: '3600', preference: '10',
  });
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  useEscape(onClose);

  const save = async () => {
    if (!form.hostname || !form.record_data) { toast('Hostname and record data required', 'error'); return; }
    setLoading(true);
    try {
      await api('/dns/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: zone.server_id, zone_name: zone.zone_name, ...form }),
      });
      toast(`${form.record_type} record added: ${form.hostname}`, 'success');
      onDone();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  const placeholders: Record<string, string> = {
    A: '192.168.1.100', AAAA: '2001:db8::1', CNAME: 'server.domain.com.',
    MX: 'mail.domain.com.', PTR: 'hostname.domain.com.', TXT: 'v=spf1 include:domain.com ~all',
    NS: 'ns1.domain.com.',
  };

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 24, width: 480, maxWidth: '94vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>Add DNS Record</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Zone: <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{zone.zone_name}</span>
              {' · '}Server: {servers.find(s => s.id === zone.server_id)?.hostname || zone.server_id}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={PS_WARNING}>
          ⚡ Runs PowerShell on the DNS server via WinRM. Requires DNS Server role and admin rights.
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Record Type</label>
          <select value={form.record_type} onChange={e => setForm(p => ({ ...p, record_type: e.target.value }))} style={INPUT}>
            {ADD_RECORD_TYPES.map(t => <option key={t} value={t}>{t} — {TYPE_LABELS[t]}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
            Hostname {form.record_type !== 'PTR' ? '(e.g. "server1" or "@" for root)' : '(e.g. "100" for .100)'}
          </label>
          <input value={form.hostname} placeholder={form.record_type === 'PTR' ? '100' : 'hostname'}
            onChange={e => setForm(p => ({ ...p, hostname: e.target.value }))} style={INPUT} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
            {form.record_type === 'A' ? 'IPv4 Address' : form.record_type === 'MX' ? 'Mail Server' : 'Record Data'}
          </label>
          <input value={form.record_data} placeholder={placeholders[form.record_type] || ''}
            onChange={e => setForm(p => ({ ...p, record_data: e.target.value }))} style={INPUT} />
        </div>

        {form.record_type === 'MX' && (
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Priority</label>
            <input value={form.preference} type="number" onChange={e => setForm(p => ({ ...p, preference: e.target.value }))} style={INPUT} />
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>TTL (seconds)</label>
          <select value={form.ttl} onChange={e => setForm(p => ({ ...p, ttl: e.target.value }))} style={INPUT}>
            <option value="300">300 — 5 minutes</option>
            <option value="3600">3600 — 1 hour</option>
            <option value="86400">86400 — 1 day</option>
            <option value="604800">604800 — 1 week</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="btn">Cancel</button>
          <button onClick={save} disabled={loading} className="btn btn-primary" style={{ opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Adding…' : '✓ Add Record on DNS Server'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Add Zone Modal (module scope)
// ════════════════════════════════════════════════════════════
function AddZoneModal({ servers, onClose, onDone }: {
  servers: DnsServer[]; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = useState<{ server_id: number | ''; zone_name: string; zone_type: string; replication_scope: string }>({
    server_id: servers[0]?.id ?? '', zone_name: '', zone_type: 'Primary', replication_scope: 'Domain',
  });
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  useEscape(onClose);

  const save = async () => {
    if (!form.zone_name || !form.server_id) { toast('Server and zone name required', 'error'); return; }
    setLoading(true);
    try {
      await api('/dns/zones', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      toast(`Zone ${form.zone_name} created`, 'success');
      onDone();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 24, width: 440, maxWidth: '94vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>Create DNS Zone</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={PS_WARNING}>
          ⚡ Runs PowerShell on the DNS server via WinRM. Requires DNS Server role and admin rights.
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>DNS Server</label>
          <select value={form.server_id} onChange={e => setForm(p => ({ ...p, server_id: parseInt(e.target.value) }))} style={INPUT}>
            {servers.map(s => <option key={s.id} value={s.id}>{s.hostname} ({s.ip_address})</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Zone Name (e.g. company.local)</label>
          <input value={form.zone_name} onChange={e => setForm(p => ({ ...p, zone_name: e.target.value }))} style={INPUT} placeholder="company.local" />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Zone Type</label>
          <select value={form.zone_type} onChange={e => setForm(p => ({ ...p, zone_type: e.target.value }))} style={INPUT}>
            <option value="Primary">Primary — authoritative zone</option>
            <option value="Secondary">Secondary — read-only replica</option>
          </select>
        </div>
        {form.zone_type === 'Primary' && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>AD Replication Scope</label>
            <select value={form.replication_scope} onChange={e => setForm(p => ({ ...p, replication_scope: e.target.value }))} style={INPUT}>
              <option value="Domain">Domain — all DCs in domain</option>
              <option value="Forest">Forest — all DCs in forest</option>
              <option value="Legacy">Legacy — all DNS servers in domain</option>
            </select>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="btn">Cancel</button>
          <button onClick={save} disabled={loading} className="btn btn-primary" style={{ opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Creating…' : '✓ Create Zone'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Server selector pill (module scope)
// ════════════════════════════════════════════════════════════
function ServerPill({ server, active, onClick }: {
  server: DnsServer; active: boolean; onClick: () => void;
}) {
  const online = server.poll_status === 'ok';
  return (
    <button onClick={onClick} style={{
      padding: '7px 14px', borderRadius: 22, cursor: 'pointer', fontSize: 12,
      border: `2px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
      background: active ? 'var(--primary-light)' : 'var(--bg-card)',
      display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'inherit',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: online ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
      <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{server.hostname}</span>
      <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11 }}>{server.ip_address}</span>
      <span className={`badge ${server.role === 'both' ? 'badge-blue' : 'badge-gray'}`} style={{ fontSize: 9 }}>{server.role}</span>
    </button>
  );
}

// ════════════════════════════════════════════════════════════
// Zone list row (module scope)
// ════════════════════════════════════════════════════════════
function ZoneRow({ zone, selected, onSelect, onDelete }: {
  zone: DnsZone; selected: boolean; onSelect: () => void; onDelete: () => void;
}) {
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;
  return (
    <div
      onClick={onSelect}
      style={{
        padding: '9px 12px 9px 13px', cursor: 'pointer',
        borderLeft: `3px solid ${selected ? 'var(--primary)' : 'transparent'}`,
        background: selected ? 'var(--primary-light)' : 'transparent',
        borderBottom: '1px solid var(--border-light)',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-primary)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {zone.zone_name}
        </span>
        <span className="badge badge-blue" style={{ fontSize: 9 }}>{zone.zone_type}</span>
        {canWrite && (
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            title="Delete zone"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0, lineHeight: 1 }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >×</button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{zone.record_count || 0} {zone.record_count === 1 ? 'record' : 'records'}</span>
        <span style={{ color: 'var(--border)' }}>·</span>
        <span>{shortTime(zone.last_updated)}</span>
        {zone.is_ds_integrated && <span className="badge badge-green" style={{ fontSize: 8 }}>AD</span>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN DNS TAB
// ════════════════════════════════════════════════════════════
export default function DNSTab() {
  const [servers, setServers]       = useState<DnsServer[]>([]);
  const [zones, setZones]           = useState<DnsZone[]>([]);
  const [records, setRecords]       = useState<DnsRecord[]>([]);
  const [breakdown, setBreakdown]   = useState<{ record_type: string; count: number }[]>([]);
  const [selectedServer, setSelectedServer] = useState<number | null>(null);
  const [selectedZone, setSelectedZone]     = useState<DnsZone | null>(null);
  const [zoneFilter, setZoneFilter]   = useState('');
  const [recordSearch, setRecordSearch] = useState('');
  const [typeFilter, setTypeFilter]   = useState('');
  const [recordPage, setRecordPage]   = useState(1);
  const [recordTotal, setRecordTotal] = useState(0);
  const [showAddZone, setShowAddZone] = useState(false);
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [loadingZones, setLoadingZones]   = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(false);

  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  // global search is active when the toolbar search box has text
  const globalSearch = recordSearch.trim().length > 0;

  const loadServers = useCallback(async () => {
    const d = await api('/dns/servers').catch(() => null);
    if (d) setServers(d.data || []);
  }, []);

  const loadZones = useCallback(async () => {
    setLoadingZones(true);
    const d = await api('/dns/zones').catch(() => null);
    if (d) setZones(d.data || []);
    setLoadingZones(false);
  }, []);

  const loadBreakdown = useCallback(async () => {
    const d = await api('/dns/record-type-breakdown').catch(() => null);
    if (d) setBreakdown(d.data || []);
  }, []);

  const loadRecords = useCallback(async (page = 1) => {
    const search = recordSearch.trim();
    // Need either a search term (global) or a selected zone (scoped)
    if (!search && !selectedZone) { setRecords([]); setRecordTotal(0); return; }
    setLoadingRecords(true);
    const params = new URLSearchParams({ page: String(page), limit: String(RECORD_LIMIT) });
    if (search) params.set('search', search);
    if (typeFilter) params.set('type', typeFilter);
    if (!search && selectedZone) params.set('zone_id', String(selectedZone.id));
    const d = await api(`/dns/records?${params}`).catch(() => null);
    if (d) { setRecords(d.data || []); setRecordTotal(d.total || 0); }
    else { setRecords([]); setRecordTotal(0); }
    setLoadingRecords(false);
  }, [recordSearch, typeFilter, selectedZone]);

  useEffect(() => { loadServers(); loadZones(); loadBreakdown(); }, [loadServers, loadZones, loadBreakdown]);

  // reload records whenever search / type / selected zone changes; reset to page 1
  useEffect(() => { setRecordPage(1); loadRecords(1); }, [recordSearch, typeFilter, selectedZone, loadRecords]);

  useRefreshKey(() => { loadServers(); loadZones(); loadBreakdown(); });

  const deleteRecord = async (record: DnsRecord) => {
    if (!confirm(`Delete ${record.record_type} record: ${record.hostname} → ${record.record_data}?`)) return;
    const zone = zones.find(z => z.id === record.zone_id) || selectedZone;
    if (!zone) { toast('Zone not found', 'error'); return; }
    try {
      await api('/dns/records', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id: zone.server_id, zone_name: zone.zone_name,
          hostname: record.hostname, record_type: record.record_type, record_data: record.record_data,
        }),
      });
      toast('Record deleted', 'success');
      loadRecords(recordPage);
      loadBreakdown();
      loadZones();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const deleteZone = async (zone: DnsZone) => {
    if (!confirm(`Delete zone ${zone.zone_name}? This removes it from the DNS server!`)) return;
    try {
      await api(`/dns/zones/${zone.id}`, { method: 'DELETE' });
      toast(`Zone ${zone.zone_name} deleted`, 'success');
      if (selectedZone?.id === zone.id) setSelectedZone(null);
      loadZones();
      loadBreakdown();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  // ── Derived data ────────────────────────────────────────────
  const serverFilteredZones = useMemo(
    () => selectedServer ? zones.filter(z => z.server_id === selectedServer) : zones,
    [zones, selectedServer],
  );

  const listZones = useMemo(() => {
    const f = zoneFilter.trim().toLowerCase();
    return f ? serverFilteredZones.filter(z => z.zone_name.toLowerCase().includes(f)) : serverFilteredZones;
  }, [serverFilteredZones, zoneFilter]);

  const forwardZones = listZones.filter(z => !z.is_reverse);
  const reverseZones = listZones.filter(z => z.is_reverse);

  const totalRecords = useMemo(() => serverFilteredZones.reduce((a, z) => a + (z.record_count || 0), 0), [serverFilteredZones]);
  const fwdCount = serverFilteredZones.filter(z => !z.is_reverse).length;

  // Keep selected zone consistent with server filter
  useEffect(() => {
    if (selectedServer && selectedZone && selectedZone.server_id !== selectedServer) {
      setSelectedZone(null);
    }
  }, [selectedServer, selectedZone]);

  const totalPages = Math.max(1, Math.ceil(recordTotal / RECORD_LIMIT));

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Page header ── */}
      <PageHeader title="DNS" subtitle="Manage forward and reverse zones and their records across your DNS servers">
        {canWrite && (
          <button onClick={() => setShowAddZone(true)} className="btn" disabled={servers.length === 0}
            style={{ opacity: servers.length === 0 ? 0.5 : 1 }}>+ Zone</button>
        )}
        {canWrite && (
          <button onClick={() => setShowAddRecord(true)} disabled={!selectedZone} className="btn btn-primary"
            style={{ opacity: selectedZone ? 1 : 0.5 }}>+ Record</button>
        )}
        <button onClick={() => { loadServers(); loadZones(); loadBreakdown(); if (selectedZone || globalSearch) loadRecords(recordPage); toast('Refreshed', 'info'); }}
          className="btn" title="Refresh">↻</button>
      </PageHeader>

      <ReadOnlyBanner />

      {/* ── Server selector pills ── */}
      {servers.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => setSelectedServer(null)} style={{
            padding: '7px 14px', borderRadius: 22, cursor: 'pointer', fontSize: 12, fontWeight: 600,
            border: `2px solid ${selectedServer === null ? 'var(--primary)' : 'var(--border)'}`,
            background: selectedServer === null ? 'var(--primary-light)' : 'var(--bg-card)',
            color: 'var(--text-primary)', fontFamily: 'inherit',
          }}>All Servers</button>
          {servers.map(s => (
            <ServerPill key={s.id} server={s} active={selectedServer === s.id}
              onClick={() => setSelectedServer(s.id === selectedServer ? null : s.id)} />
          ))}
        </div>
      )}

      {/* ── KPI tiles ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        {[
          { l: 'DNS Servers',   v: servers.length,             c: 'var(--navy)' },
          { l: 'Total Zones',   v: serverFilteredZones.length, c: 'var(--blue)' },
          { l: 'Forward Zones', v: fwdCount,                   c: 'var(--green)' },
          { l: 'Total Records', v: totalRecords,               c: 'var(--purple)' },
        ].map((t, i) => (
          <div key={i} className="kpi-card" style={{ borderLeftColor: t.c }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: t.c, letterSpacing: '-0.5px' }}>{t.v}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{t.l}</div>
          </div>
        ))}
      </div>

      {/* ── Empty state when no zones at all ── */}
      {!loadingZones && zones.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No DNS zones"
            message="Add a server with the DNS role in Known Servers, or create a zone."
            actionLabel={canWrite && servers.length > 0 ? '+ Create Zone' : undefined}
            onAction={canWrite && servers.length > 0 ? () => setShowAddZone(true) : undefined}
          />
        </div>
      ) : (
        /* ── Master–detail split ── */
        <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', minHeight: 520 }}>

          {/* LEFT — zone list */}
          <div className="card" style={{ flex: '0 0 32%', minWidth: 300, maxWidth: 420, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
              <input
                placeholder="Filter zones…"
                value={zoneFilter}
                onChange={e => setZoneFilter(e.target.value)}
                style={INPUT}
              />
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              {loadingZones ? (
                <div style={{ padding: 8 }}>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} style={{ padding: '10px 12px' }}>
                      <Skeleton height={13} width="70%" />
                      <div style={{ height: 6 }} />
                      <Skeleton height={10} width="40%" />
                    </div>
                  ))}
                </div>
              ) : listZones.length === 0 ? (
                <EmptyState title="No matching zones" message={zoneFilter ? 'Try a different filter.' : 'No zones for this server.'} />
              ) : (
                <>
                  <ZoneSection title="Forward Zones" zones={forwardZones} selectedZone={selectedZone}
                    onSelect={setSelectedZone} onDelete={deleteZone} />
                  <ZoneSection title="Reverse Zones" zones={reverseZones} selectedZone={selectedZone}
                    onSelect={setSelectedZone} onDelete={deleteZone} />
                </>
              )}
            </div>
            {/* Record-type legend */}
            {breakdown.length > 0 && (
              <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {breakdown.map((b, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: RECORD_COLORS[b.record_type] || '#6b7280' }} />
                    <span style={{ color: 'var(--text-muted)' }}>{b.record_type}</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{b.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* RIGHT — records */}
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
            {/* Toolbar */}
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <input
                placeholder="Search records across all zones…"
                value={recordSearch}
                onChange={e => setRecordSearch(e.target.value)}
                style={{ ...INPUT, flex: 1, minWidth: 200 }}
              />
              <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ ...INPUT, width: 130 }}>
                <option value="">All types</option>
                {RECORD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {canWrite && (
                <button onClick={() => setShowAddRecord(true)} disabled={!selectedZone} className="btn btn-primary"
                  style={{ opacity: selectedZone ? 1 : 0.5, whiteSpace: 'nowrap' }}>+ Add Record</button>
              )}
              <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {recordTotal.toLocaleString()} {recordTotal === 1 ? 'record' : 'records'}
              </span>
            </div>

            {/* Context line */}
            <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-light)', fontSize: 12, color: 'var(--text-muted)' }}>
              {globalSearch
                ? <span>Searching all zones for “<span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{recordSearch}</span>”</span>
                : selectedZone
                  ? <span>Zone <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)', fontWeight: 600 }}>{selectedZone.zone_name}</span>{' · '}{selectedZone.server_hostname || '—'}</span>
                  : <span>Select a zone from the list, or search above.</span>}
            </div>

            {/* Records table / states */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              {loadingRecords ? (
                <TableSkeleton rows={10} cols={6} />
              ) : !globalSearch && !selectedZone ? (
                <EmptyState title="Select a zone" message="Choose a zone from the list to view its records." />
              ) : records.length === 0 ? (
                <EmptyState
                  title="No records found"
                  message={globalSearch ? 'No records match your search.' : 'This zone has no records yet — add one with + Add Record.'}
                />
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Hostname</th>
                      <th>Type</th>
                      <th>Data</th>
                      <th>TTL</th>
                      <th>Zone</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r, i) => (
                      <tr key={r.id ?? i}>
                        <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.hostname}</td>
                        <td><TypeBadge type={r.record_type} /></td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.record_data}>{r.record_data}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.ttl}s</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.zone_name}</td>
                        <td style={{ textAlign: 'right' }}>
                          {canWrite && (
                            <button onClick={() => deleteRecord(r)}
                              style={{ fontSize: 12, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination */}
            {recordTotal > RECORD_LIMIT && !loadingRecords && records.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, padding: 12, borderTop: '1px solid var(--border)' }}>
                <button className="btn" disabled={recordPage <= 1}
                  style={{ opacity: recordPage <= 1 ? 0.5 : 1 }}
                  onClick={() => { const p = recordPage - 1; setRecordPage(p); loadRecords(p); }}>← Prev</button>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Page {recordPage} of {totalPages}</span>
                <button className="btn" disabled={recordPage >= totalPages}
                  style={{ opacity: recordPage >= totalPages ? 0.5 : 1 }}
                  onClick={() => { const p = recordPage + 1; setRecordPage(p); loadRecords(p); }}>Next →</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {showAddZone && (
        <AddZoneModal servers={servers}
          onClose={() => setShowAddZone(false)}
          onDone={() => { setShowAddZone(false); loadZones(); loadBreakdown(); }} />
      )}
      {showAddRecord && selectedZone && (
        <AddRecordModal zone={selectedZone} servers={servers}
          onClose={() => setShowAddRecord(false)}
          onDone={() => { setShowAddRecord(false); loadRecords(recordPage); loadBreakdown(); loadZones(); }} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Zone section (labelled group in left panel) — module scope
// ════════════════════════════════════════════════════════════
function ZoneSection({ title, zones, selectedZone, onSelect, onDelete }: {
  title: string;
  zones: DnsZone[];
  selectedZone: DnsZone | null;
  onSelect: (z: DnsZone) => void;
  onDelete: (z: DnsZone) => void;
}) {
  if (zones.length === 0) return null;
  return (
    <div>
      <div style={{
        padding: '7px 13px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--text-muted)', background: 'var(--bg-primary)',
        position: 'sticky', top: 0, zIndex: 1, borderBottom: '1px solid var(--border-light)',
      }}>
        {title} <span style={{ color: 'var(--border)' }}>·</span> {zones.length}
      </div>
      {zones.map(z => (
        <ZoneRow key={z.id} zone={z} selected={selectedZone?.id === z.id}
          onSelect={() => onSelect(z)} onDelete={() => onDelete(z)} />
      ))}
    </div>
  );
}
