'use client';

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
import {
  PageHeader, EmptyState, TableSkeleton, Skeleton, Spinner,
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
  health_score?: number | null;
  winrm_test_ok?: boolean | null;
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
  // extended (optional) fields
  soa_serial?: number | string | null;
  record_count_a?: number | null;
  record_count_ptr?: number | null;
  record_count_cname?: number | null;
  record_count_mx?: number | null;
  scavenging_enabled?: boolean | null;
}

interface DnsRecord {
  id: number;
  zone_id: number;
  hostname: string;
  record_type: string;
  record_data: string;
  ttl: number;
  zone_name: string;
  // optional extended fields (may be absent)
  last_updated?: string | null;
  last_seen?: string | null;
}

// ── New intelligence/health shapes ────────────────────────────
interface DnsHealth {
  zones_total: number;
  servers_total: number;
  servers_online: number;
  zones_in_sync: number;
  zones_out_of_sync: number;
  replication_issues: number;
  forwarders_total: number;
  forwarders_down: number;
  stale_records: number;
  scavenging_disabled_zones: number;
}

interface TopologyServer {
  id: number;
  hostname: string;
  ip: string;
  role: string;
  health_score: number;
  query_ms: number;
  poll_status: string;
  winrm_test_ok?: boolean | null;
  is_dns_primary: boolean;
  dns_forwarders: string[] | null;
  is_pdc_emulator: boolean;
  domain: string;
  replication_type: string;
  zone_count: number;
  record_count: number;
}

interface ZoneSyncSerial {
  soa_serial: number | string | null;
  lag_seconds: number | null;
  checked_at: string | null;
  is_in_sync: boolean;
}
interface ZoneSync {
  zone_name: string;
  max_serial: number | string | null;
  in_sync: boolean;
  serials: Record<string, ZoneSyncSerial>;
}

interface Forwarder {
  id: number;
  server_id: number;
  hostname: string;
  server_ip: string;
  forwarder_ip: string;
  is_reachable: boolean | null;
  response_time_ms: number | null;
  last_checked: string | null;
}

interface StaleRecord {
  id: number;
  zone_id: number;
  zone_name: string;
  hostname: string;
  record_type: string;
  record_data: string;
  last_updated: string | null;
  days_stale: number;
}

interface QueryStatPoint {
  recorded_at: string;
  queries_per_sec: number;
  response_time_ms: number;
  nxdomain_count: number;
  total_queries: number;
  successful?: number;
  failed: number;
}

// ── DNS anomaly (security intelligence) ───────────────────────
interface DnsAnomaly {
  id: number;
  anomaly_type: string;
  severity: string;
  description: string | null;
  acknowledged: boolean;
  detected_at: string;
}
interface QueryStat {
  server_id: number;
  hostname: string;
  latest: QueryStatPoint | null;
  history: QueryStatPoint[];
}

interface ScavengingRow {
  id: number;
  zone_name: string;
  server_id: number;
  hostname: string;
  scavenging_enabled: boolean | null;
  aging_enabled: boolean | null;
  last_scavenged: string | null;
  is_reverse: boolean;
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
function shortTime(iso?: string | null): string {
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

// ── Health score → colour ─────────────────────────────────────
function scoreColor(n: number): string {
  if (n >= 90) return 'var(--green)';
  if (n >= 70) return 'var(--yellow)';
  return 'var(--red)';
}

// ── DNS server online status ──────────────────────────────────
// ONLINE if health ≥ 70, DEGRADED if 50–69, OFFLINE if < 50 or the WinRM test
// failed. Deliberately independent of poll_status (whether the DNS monitor has
// successfully polled yet) — a healthy, reachable server must not read OFFLINE.
type DnsServerStatus = 'online' | 'degraded' | 'offline';
function dnsServerStatus(healthScore?: number | null, winrmOk?: boolean | null): DnsServerStatus {
  if (winrmOk === false) return 'offline';
  const h = healthScore ?? 0;
  if (h < 50) return 'offline';
  if (h < 70) return 'degraded';
  return 'online';
}
function dnsStatusColor(s: DnsServerStatus): string {
  return s === 'online' ? 'var(--green)' : s === 'degraded' ? 'var(--yellow)' : 'var(--red)';
}

// ── Shared inline styles ──────────────────────────────────────
const INPUT: React.CSSProperties = {
  width: '100%', padding: '7px 11px', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)',
  color: 'var(--text-primary)', fontSize: 'var(--text-base)', fontFamily: 'inherit', outline: 'none',
};

const CARD: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', overflow: 'hidden',
};

const TYPE_LABELS: Record<string, string> = {
  A: 'IPv4 Address', AAAA: 'IPv6 Address', CNAME: 'Alias', MX: 'Mail Exchange',
  PTR: 'Reverse Lookup', TXT: 'Text Record', NS: 'Name Server',
};

const PS_WARNING: React.CSSProperties = {
  background: '#fef9c3', border: '1px solid #fde047', borderRadius: 'var(--radius-sm)',
  padding: '8px 12px', fontSize: 'var(--text-sm)', marginBottom: 14, color: '#a16207',
};

// ════════════════════════════════════════════════════════════
// Record type badge (module scope)
// ════════════════════════════════════════════════════════════
function TypeBadge({ type, small }: { type: string; small?: boolean }) {
  const color = RECORD_COLORS[type] || '#6b7280';
  return (
    <span style={{
      display: 'inline-block', padding: small ? '1px 6px' : '2px 8px', borderRadius: 4,
      background: color + '22', color, fontSize: small ? 'var(--text-xs)' : 'var(--text-xs)', fontWeight: 700,
      letterSpacing: '0.02em',
    }}>{type}</span>
  );
}

// ════════════════════════════════════════════════════════════
// Record Modal — add or edit a DNS record (module scope)
// DNS has no native update operation, so an edit is implemented as
// delete-the-old-record then create-the-new-one (see save()).
// ════════════════════════════════════════════════════════════
function RecordModal({ zone, servers, editRecord, onClose, onDone }: {
  zone: DnsZone; servers: DnsServer[]; editRecord?: DnsRecord | null; onClose: () => void; onDone: () => void;
}) {
  const isEdit = !!editRecord;

  // When editing an MX record, its record_data may be stored as "10 mail.domain.com" —
  // split the leading preference out so it lands in its own field.
  const initialForm = () => {
    if (editRecord) {
      let data = editRecord.record_data || '';
      let preference = '10';
      if ((editRecord.record_type || '').toUpperCase() === 'MX') {
        const m = data.match(/^\s*(\d+)\s+(.+)$/);
        if (m) { preference = m[1]; data = m[2]; }
      }
      return {
        record_type: editRecord.record_type || 'A',
        hostname: editRecord.hostname || '',
        record_data: data,
        ttl: String(editRecord.ttl || 3600),
        preference,
      };
    }
    return { record_type: 'A', hostname: '', record_data: '', ttl: '3600', preference: '10' };
  };

  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  useEscape(onClose);

  const save = async () => {
    if (!form.hostname || !form.record_data) { toast('Hostname and record data required', 'error'); return; }
    setLoading(true);
    try {
      // DNS has no update — when editing, delete the original record first, then recreate it.
      if (isEdit && editRecord) {
        await api('/dns/records', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            server_id: zone.server_id, zone_name: zone.zone_name,
            hostname: editRecord.hostname, record_type: editRecord.record_type, record_data: editRecord.record_data,
          }),
        });
      }
      await api('/dns/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: zone.server_id, zone_name: zone.zone_name, ...form }),
      });
      toast(`${form.record_type} record ${isEdit ? 'updated' : 'added'}: ${form.hostname}`, 'success');
      onDone();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  const placeholders: Record<string, string> = {
    A: '192.168.1.100', AAAA: '2001:db8::1', CNAME: 'server.domain.com.',
    MX: 'mail.domain.com.', PTR: 'hostname.domain.com.', TXT: 'v=spf1 include:domain.com ~all',
    NS: 'ns1.domain.com.',
  };

  // Always include the record's current type in the dropdown, even if it's a type
  // (SRV, AAAA, …) not normally offered for new records.
  const typeOptions = ADD_RECORD_TYPES.includes(form.record_type)
    ? ADD_RECORD_TYPES
    : [form.record_type, ...ADD_RECORD_TYPES];

  // Standard TTL choices; include the record's own TTL if it's non-standard.
  const STD_TTLS = ['300', '3600', '86400', '604800'];
  const ttlOptions = STD_TTLS.includes(form.ttl) ? STD_TTLS : [form.ttl, ...STD_TTLS];
  const ttlLabel = (v: string) => ({
    '300': '300 — 5 minutes', '3600': '3600 — 1 hour', '86400': '86400 — 1 day', '604800': '604800 — 1 week',
  } as Record<string, string>)[v] || `${v} — custom`;

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 24, width: 480, maxWidth: '94vw' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>{isEdit ? 'Edit DNS Record' : 'Add DNS Record'}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
              Zone: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{zone.zone_name}</span>
              {' · '}Server: {servers.find(s => s.id === zone.server_id)?.hostname || zone.server_id}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={PS_WARNING}>
          ⚡ Runs PowerShell on the DNS server via WinRM. Requires DNS Server role and admin rights.
          {isEdit && ' Editing recreates the record (delete + add) — DNS has no in-place update.'}
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Record Type</label>
          <select value={form.record_type} onChange={e => setForm(p => ({ ...p, record_type: e.target.value }))} style={INPUT}>
            {typeOptions.map(t => <option key={t} value={t}>{t}{TYPE_LABELS[t] ? ` — ${TYPE_LABELS[t]}` : ''}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
            Hostname {form.record_type !== 'PTR' ? '(e.g. "server1" or "@" for root)' : '(e.g. "100" for .100)'}
          </label>
          <input value={form.hostname} placeholder={form.record_type === 'PTR' ? '100' : 'hostname'}
            onChange={e => setForm(p => ({ ...p, hostname: e.target.value }))} style={INPUT} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
            {form.record_type === 'A' ? 'IPv4 Address' : form.record_type === 'MX' ? 'Mail Server' : 'Record Data'}
          </label>
          <input value={form.record_data} placeholder={placeholders[form.record_type] || ''}
            onChange={e => setForm(p => ({ ...p, record_data: e.target.value }))} style={INPUT} />
        </div>

        {form.record_type === 'MX' && (
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Priority</label>
            <input value={form.preference} type="number" onChange={e => setForm(p => ({ ...p, preference: e.target.value }))} style={INPUT} />
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>TTL (seconds)</label>
          <select value={form.ttl} onChange={e => setForm(p => ({ ...p, ttl: e.target.value }))} style={INPUT}>
            {ttlOptions.map(v => <option key={v} value={v}>{ttlLabel(v)}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="btn">Cancel</button>
          <button onClick={save} disabled={loading} className="btn btn-primary" style={{ opacity: loading ? 0.7 : 1 }}>
            {loading ? (isEdit ? 'Saving…' : 'Adding…') : (isEdit ? '✓ Save Changes on DNS Server' : '✓ Add Record on DNS Server')}
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
  const [form, setForm] = useState<{ server_id: number | ''; zone_name: string; zone_type: string; replication_scope: string; forwarder_ips: string }>({
    server_id: servers[0]?.id ?? '', zone_name: '', zone_type: 'Primary', replication_scope: 'Domain', forwarder_ips: '',
  });
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  useEscape(onClose);

  const save = async () => {
    if (!form.zone_name || !form.server_id) { toast('Server and zone name required', 'error'); return; }
    if (form.zone_type === 'Forwarder' && !form.forwarder_ips.trim()) { toast('Forwarder IP(s) required for a forwarder zone', 'error'); return; }
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
          <div style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>Create DNS Zone</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={PS_WARNING}>
          ⚡ Runs PowerShell on the DNS server via WinRM. Requires DNS Server role and admin rights.
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>DNS Server</label>
          <select value={form.server_id} onChange={e => setForm(p => ({ ...p, server_id: parseInt(e.target.value) }))} style={INPUT}>
            {servers.map(s => <option key={s.id} value={s.id}>{s.hostname} ({s.ip_address})</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Zone Name (e.g. company.local)</label>
          <input value={form.zone_name} onChange={e => setForm(p => ({ ...p, zone_name: e.target.value }))} style={INPUT} placeholder="company.local" />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Zone Type</label>
          <select value={form.zone_type} onChange={e => setForm(p => ({ ...p, zone_type: e.target.value }))} style={INPUT}>
            <option value="Primary">Primary — authoritative zone</option>
            <option value="Secondary">Secondary — read-only replica</option>
            <option value="Forwarder">Forwarder — conditional forwarder</option>
          </select>
        </div>
        {form.zone_type === 'Primary' && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>AD Replication Scope</label>
            <select value={form.replication_scope} onChange={e => setForm(p => ({ ...p, replication_scope: e.target.value }))} style={INPUT}>
              <option value="Domain">Domain — all DCs in domain</option>
              <option value="Forest">Forest — all DCs in forest</option>
              <option value="Legacy">Legacy — all DNS servers in domain</option>
            </select>
          </div>
        )}
        {form.zone_type === 'Forwarder' && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Forward to (DNS server IPs)</label>
            <input value={form.forwarder_ips} onChange={e => setForm(p => ({ ...p, forwarder_ips: e.target.value }))} style={INPUT} placeholder="8.8.8.8, 8.8.4.4" />
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
  const status = dnsServerStatus(server.health_score, server.winrm_test_ok);
  return (
    <button onClick={onClick} style={{
      padding: '7px 14px', borderRadius: 22, cursor: 'pointer', fontSize: 'var(--text-sm)',
      border: `2px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
      background: active ? 'var(--primary-light)' : 'var(--bg-card)',
      display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'inherit',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dnsStatusColor(status), flexShrink: 0 }} />
      <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{server.hostname}</span>
      <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{server.ip_address}</span>
      <span className={`badge ${server.role === 'both' ? 'badge-blue' : 'badge-gray'}`} style={{ fontSize: 'var(--text-xs)' }}>{server.role}</span>
    </button>
  );
}

// ════════════════════════════════════════════════════════════
// Sub-tab bar button (module scope)
// ════════════════════════════════════════════════════════════
function SubTabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`tab-pill ${active ? 'active' : ''}`}>{label}</button>
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
  const count = zone.record_count || 0;
  return (
    <div
      onClick={onSelect}
      style={{
        padding: '6px 12px 6px 13px', cursor: 'pointer',
        borderLeft: `3px solid ${selected ? 'var(--primary)' : 'transparent'}`,
        background: selected ? 'var(--primary-light)' : 'transparent',
        borderBottom: '1px solid var(--border-light)',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-primary)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Prominent record-count badge — green when records exist, gray when empty */}
        <span
          className={`badge ${count > 0 ? 'badge-green' : 'badge-gray'}`}
          style={{ fontSize: 'var(--text-xs)', fontWeight: 700, minWidth: 22, textAlign: 'center', flexShrink: 0 }}
          title={`${count} ${count === 1 ? 'record' : 'records'}`}
        >{count}</span>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {zone.zone_name}
        </span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>{shortTime(zone.last_updated)}</span>
        {zone.is_ds_integrated && <span className="badge badge-green" style={{ fontSize: 'var(--text-xs)', flexShrink: 0 }}>AD</span>}
        {canWrite && (
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            title="Delete zone"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--text-md)', padding: 0, lineHeight: 1, flexShrink: 0 }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          >×</button>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Zone section (labelled group in left panel) — module scope
// ════════════════════════════════════════════════════════════
function ZoneSection({ title, zones, selectedZone, onSelect, onDelete, collapsed, onToggle }: {
  title: string;
  zones: DnsZone[];
  selectedZone: DnsZone | null;
  onSelect: (z: DnsZone) => void;
  onDelete: (z: DnsZone) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  if (zones.length === 0) return null;
  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          padding: '7px 13px', fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.06em', color: 'var(--text-muted)', background: 'var(--bg-primary)',
          position: 'sticky', top: 0, zIndex: 1, borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{ display: 'inline-block', transition: 'transform 0.12s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', fontSize: 'var(--text-xs)' }}>▼</span>
        {title} <span style={{ color: 'var(--border)' }}>·</span> {zones.length}
      </div>
      {!collapsed && zones.map(z => (
        <ZoneRow key={z.id} zone={z} selected={selectedZone?.id === z.id}
          onSelect={() => onSelect(z)} onDelete={() => onDelete(z)} />
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Section card header (module scope)
// ════════════════════════════════════════════════════════════
function SectionHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>{title}</div>
      {right}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// KPI tile (module scope)
// ════════════════════════════════════════════════════════════
function KpiTile({ label, value, sub, color, textColor, alert }: {
  label: string; value: React.ReactNode; sub?: string; color: string; textColor?: string; alert?: boolean;
}) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: alert ? 'var(--red)' : color }}>
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: alert ? 'var(--red)' : (textColor || color), letterSpacing: '-0.5px' }}>{value}</div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3 }}>{label}</div>
      {sub && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Health score gauge (small) — module scope
// ════════════════════════════════════════════════════════════
function ScoreGauge({ score }: { score: number }) {
  const s = Math.max(0, Math.min(100, score || 0));
  const r = 18, c = 2 * Math.PI * r, off = c - (s / 100) * c;
  const col = scoreColor(s);
  return (
    <svg width={48} height={48} viewBox="0 0 48 48">
      <circle cx={24} cy={24} r={r} fill="none" stroke="var(--border)" strokeWidth={5} />
      <circle cx={24} cy={24} r={r} fill="none" stroke={col} strokeWidth={5}
        strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
        transform="rotate(-90 24 24)" />
      <text x={24} y={28} textAnchor="middle" fontSize="var(--text-base)" fontWeight={800} fill={col}>{s}</text>
    </svg>
  );
}

// ════════════════════════════════════════════════════════════
// Forwarder status pill (module scope)
// ════════════════════════════════════════════════════════════
function ForwarderPill({ ip, status }: { ip: string; status: 'up' | 'down' | 'unknown' }) {
  const col = status === 'up' ? 'var(--green)' : status === 'down' ? 'var(--red)' : 'var(--text-muted)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 10,
      background: col + '18', color: col, fontSize: 'var(--text-xs)', fontWeight: 600, fontFamily: 'var(--font-mono)',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: col }} />
      {ip}
    </span>
  );
}

// ════════════════════════════════════════════════════════════
// Server topology / health card (module scope)
// ════════════════════════════════════════════════════════════
function ServerHealthCard({ srv, zones, fwdStatus, expanded, onToggle }: {
  srv: TopologyServer;
  zones: DnsZone[];
  fwdStatus: (ip: string) => 'up' | 'down' | 'unknown';
  expanded: boolean;
  onToggle: () => void;
}) {
  const myZones = zones.filter(z => z.server_id === srv.id);
  return (
    <div id={`dns-srv-${srv.id}`} style={{ ...CARD, cursor: 'pointer' }} onClick={onToggle}>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <ScoreGauge score={srv.health_score} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>{srv.hostname}</span>
            {srv.is_pdc_emulator && <span title="PDC Emulator" style={{ fontSize: 'var(--text-base)' }}>👑</span>}
            <span className={`badge ${srv.is_dns_primary ? 'badge-blue' : 'badge-gray'}`} style={{ fontSize: 'var(--text-xs)' }}>
              {srv.is_dns_primary ? 'PRIMARY' : 'SECONDARY'}
            </span>
            {(() => {
              const st = dnsServerStatus(srv.health_score, srv.winrm_test_ok);
              if (st === 'online') return null;
              return <span className="badge badge-gray" style={{ fontSize: 'var(--text-xs)', color: dnsStatusColor(st) }}>{st === 'degraded' ? 'DEGRADED' : 'OFFLINE'}</span>;
            })()}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{srv.ip}</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
            <span><strong style={{ color: scoreColor(srv.health_score) }}>{srv.health_score}</strong> health</span>
            <span><strong style={{ color: 'var(--text-primary)' }}>{srv.query_ms ?? 0}ms</strong> query</span>
            <span><strong style={{ color: 'var(--text-primary)' }}>{srv.zone_count ?? myZones.length}</strong> zones</span>
            <span><strong style={{ color: 'var(--text-primary)' }}>{(srv.record_count ?? 0).toLocaleString()}</strong> records</span>
          </div>
        </div>
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>›</span>
      </div>

      {srv.dns_forwarders && srv.dns_forwarders.length > 0 && (
        <div style={{ padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', alignSelf: 'center' }}>Forwarders:</span>
          {srv.dns_forwarders.map((ip, i) => <ForwarderPill key={i} ip={ip} status={fwdStatus(ip)} />)}
        </div>
      )}

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px', maxHeight: 240, overflow: 'auto' }} onClick={e => e.stopPropagation()}>
          {myZones.length === 0 ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '8px 0' }}>No zones hosted on this server.</div>
          ) : myZones.map(z => (
            <div key={z.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{z.zone_name}</span>
              <span style={{ color: 'var(--text-muted)' }}>{z.record_count || 0} rec</span>
              {z.soa_serial != null && <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>SOA {z.soa_serial}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Topology SVG diagram (module scope)
// ════════════════════════════════════════════════════════════
function TopologyDiagram({ servers, onSelect }: {
  servers: TopologyServer[]; onSelect: (id: number) => void;
}) {
  const primaries = servers.filter(s => s.is_dns_primary || s.is_pdc_emulator);
  const primary = primaries[0] || servers[0];
  const secondaries = servers.filter(s => s !== primary);

  const W = Math.max(640, secondaries.length * 200 + 80);
  const nodeW = 168, nodeH = 70;
  const primaryX = W / 2 - nodeW / 2, primaryY = 24;
  const secY = 200;
  const gap = secondaries.length > 0 ? (W - 80) / secondaries.length : 0;

  const node = (s: TopologyServer, x: number, y: number, crown: boolean) => {
    const col = scoreColor(s.health_score);
    return (
      <g key={s.id} style={{ cursor: 'pointer' }} onClick={() => onSelect(s.id)}>
        <title>{`${s.hostname} (${s.ip})\nHealth ${s.health_score} · ${s.query_ms ?? 0}ms · ${s.zone_count} zones · ${(s.record_count ?? 0).toLocaleString()} records\n${s.domain || ''} · ${s.replication_type || ''}`}</title>
        <rect x={x} y={y} width={nodeW} height={nodeH} rx={10} fill={col + '14'} stroke={col} strokeWidth={2} />
        <text x={x + 12} y={y + 20} fontSize="var(--text-sm)" fontWeight={700} fill="var(--text-primary)">
          {crown ? '👑 ' : ''}{s.hostname.length > 16 ? s.hostname.slice(0, 15) + '…' : s.hostname}
        </text>
        <text x={x + 12} y={y + 37} fontSize="var(--text-xs)" fill="var(--text-muted)" fontFamily="var(--font-mono)">{s.ip}</text>
        <text x={x + 12} y={y + 55} fontSize="var(--text-xs)" fill={col} fontWeight={700}>{s.health_score} health</text>
        <text x={x + nodeW - 12} y={y + 55} fontSize="var(--text-xs)" fill="var(--text-muted)" textAnchor="end">{s.zone_count} zones</text>
      </g>
    );
  };

  return (
    <div style={{ overflowX: 'auto', padding: 12 }}>
      <svg width={W} height={300} viewBox={`0 0 ${W} 300`}>
        {/* replication lines */}
        {secondaries.map((s, i) => {
          const sx = 40 + gap * i + (gap / 2);
          return (
            <line key={`l-${s.id}`} x1={primaryX + nodeW / 2} y1={primaryY + nodeH}
              x2={sx} y2={secY} stroke="var(--border)" strokeWidth={2} markerEnd="url(#arrow)" />
          );
        })}
        <defs>
          <marker id="arrow" markerWidth={8} markerHeight={8} refX={6} refY={3} orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--text-muted)" />
          </marker>
        </defs>
        {primary && node(primary, primaryX, primaryY, true)}
        {secondaries.map((s, i) => node(s, 40 + gap * i + (gap / 2) - nodeW / 2, secY, false))}
      </svg>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// PANEL 1 — Health Overview
// ════════════════════════════════════════════════════════════
function HealthOverviewPanel() {
  const [health, setHealth] = useState<DnsHealth | null>(null);
  const [topology, setTopology] = useState<TopologyServer[]>([]);
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [forwarders, setForwarders] = useState<Forwarder[]>([]);
  const [sync, setSync] = useState<{ servers: { id: number; hostname: string }[]; zones: ZoneSync[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'cards' | 'topology'>('cards');
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [h, t, z, f, sy] = await Promise.all([
      api('/dns/health').catch(() => null),
      api('/dns/topology').catch(() => null),
      api('/dns/zones').catch(() => null),
      api('/dns/forwarders').catch(() => null),
      api('/dns/zones/sync').catch(() => null),
    ]);
    setHealth(h || null);
    setTopology((t?.servers as TopologyServer[]) || []);
    setZones((z?.data as DnsZone[]) || []);
    setForwarders((f?.data as Forwarder[]) || []);
    setSync(sy || null);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useRefreshKey(() => { load(); });

  // forwarder reachability lookup by ip
  const fwdStatus = useCallback((ip: string): 'up' | 'down' | 'unknown' => {
    const f = forwarders.find(x => x.forwarder_ip === ip);
    if (!f || f.is_reachable == null) return 'unknown';
    return f.is_reachable ? 'up' : 'down';
  }, [forwarders]);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="kpi-card"><Skeleton height={24} width="50%" /><div style={{ height: 8 }} /><Skeleton height={12} width="70%" /></div>
          ))}
        </div>
        <div className="card"><TableSkeleton rows={6} cols={4} /></div>
      </div>
    );
  }

  const inSync = sync ? sync.zones.filter(z => z.in_sync).length : (health?.zones_in_sync ?? 0);
  const outSync = sync ? sync.zones.filter(z => !z.in_sync).length : (health?.zones_out_of_sync ?? 0);
  const syncServers = sync?.servers || [];

  const cellInfo = (z: ZoneSync, serverId: number): { serial: string; bg: string; title: string; muted: boolean } => {
    const cell = z.serials?.[String(serverId)];
    if (!cell || cell.soa_serial == null) {
      return { serial: '—', bg: 'transparent', title: 'Zone not hosted on this server', muted: true };
    }
    const maxN = Number(z.max_serial);
    const serN = Number(cell.soa_serial);
    const lag = (!isNaN(maxN) && !isNaN(serN)) ? maxN - serN : 0;
    let bg = 'var(--green)';
    if (cell.is_in_sync || lag <= 0) bg = 'var(--green)';
    else if (lag <= 2) bg = 'var(--yellow)';
    else bg = 'var(--red)';
    return {
      serial: String(cell.soa_serial),
      bg: bg + '22',
      title: `SOA ${cell.soa_serial} · lag ${lag} · checked ${shortTime(cell.checked_at)}`,
      muted: false,
    };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12 }}>
        <KpiTile label="Servers Online" color="var(--green)"
          value={`${health?.servers_online ?? 0}/${health?.servers_total ?? 0}`}
          alert={(health?.servers_total ?? 0) > 0 && (health?.servers_online ?? 0) < (health?.servers_total ?? 0)} />
        <KpiTile label="Zones In Sync" color="var(--blue)"
          value={`${inSync}/${inSync + outSync}`} />
        <KpiTile label="Replication Issues" color="var(--navy)" textColor="var(--text-primary)"
          value={health?.replication_issues ?? 0} alert={(health?.replication_issues ?? 0) > 0} />
        <KpiTile label="Stale Records" color="var(--orange)" value={(health?.stale_records ?? 0).toLocaleString()} />
        <KpiTile label="Forwarders Down" color="var(--teal)"
          value={`${health?.forwarders_down ?? 0}/${health?.forwarders_total ?? 0}`} alert={(health?.forwarders_down ?? 0) > 0} />
        <KpiTile label="Scavenging Disabled" color="var(--purple)" value={health?.scavenging_disabled_zones ?? 0} />
      </div>

      {/* View toggle + servers */}
      <div style={CARD}>
        <SectionHead title="DNS Servers"
          right={
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn" onClick={() => setView('cards')}
                style={{ background: view === 'cards' ? 'var(--primary-light)' : undefined, borderColor: view === 'cards' ? 'var(--primary)' : undefined }}>Cards</button>
              <button className="btn" onClick={() => setView('topology')}
                style={{ background: view === 'topology' ? 'var(--primary-light)' : undefined, borderColor: view === 'topology' ? 'var(--primary)' : undefined }}>Topology</button>
            </div>
          } />
        {topology.length === 0 ? (
          <EmptyState title="No DNS servers" message="Add a server with the DNS role in Known Servers." />
        ) : view === 'topology' ? (
          <TopologyDiagram servers={topology} onSelect={(id) => {
            setView('cards'); setExpanded(id);
            setTimeout(() => document.getElementById(`dns-srv-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
          }} />
        ) : (
          <div style={{ padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
            {topology.map(srv => (
              <ServerHealthCard key={srv.id} srv={srv} zones={zones} fwdStatus={fwdStatus}
                expanded={expanded === srv.id} onToggle={() => setExpanded(expanded === srv.id ? null : srv.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Zone Sync Matrix */}
      <div style={CARD}>
        <SectionHead title="Zone Sync Matrix"
          right={<span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{inSync} zones healthy, {outSync} out of sync</span>} />
        {!sync || sync.zones.length === 0 ? (
          <EmptyState title="No sync data" message="No multi-server zone replication data collected yet." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Zone</th>
                  {syncServers.map(s => <th key={s.id} style={{ textAlign: 'center' }}>{s.hostname}</th>)}
                </tr>
              </thead>
              <tbody>
                {sync.zones.map((z, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: z.in_sync ? 'var(--green)' : 'var(--red)' }} />
                        {z.zone_name}
                      </span>
                    </td>
                    {syncServers.map(s => {
                      const c = cellInfo(z, s.id);
                      return (
                        <td key={s.id} title={c.title} style={{
                          textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
                          background: c.bg, color: c.muted ? 'var(--text-muted)' : 'var(--text-primary)', fontWeight: 600,
                        }}>{c.serial}</td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// PANEL 2 — Zones & Records (existing functionality preserved)
// ════════════════════════════════════════════════════════════
function ZonesRecordsPanel() {
  const [servers, setServers]       = useState<DnsServer[]>([]);
  const [zones, setZones]           = useState<DnsZone[]>([]);
  const [records, setRecords]       = useState<DnsRecord[]>([]);
  const [breakdown, setBreakdown]   = useState<{ record_type: string; count: number }[]>([]);
  const [selectedServer, setSelectedServer] = useState<number | null>(null);
  const [selectedZone, setSelectedZone]     = useState<DnsZone | null>(null);
  const [zoneFilter, setZoneFilter]   = useState('');
  const [showForwarders, setShowForwarders] = useState(false);      // Fix 1 — hide forwarder zones by default
  const [zoneTypeFilter, setZoneTypeFilter] = useState<'all' | 'primary' | 'secondary' | 'forwarder'>('all'); // Fix 3
  const [zoneSort, setZoneSort]       = useState<'records' | 'name' | 'updated'>('records'); // Fix 5 — default records high→low
  const [fwdCollapsed, setFwdCollapsed] = useState(false);          // Fix 2 — collapsible sections
  const [revCollapsed, setRevCollapsed] = useState(true);           // reverse zones collapsed by default (rarely needed)
  const [recordSearch, setRecordSearch] = useState('');
  const [typeFilter, setTypeFilter]   = useState('');
  const [recordPage, setRecordPage]   = useState(1);
  const [recordTotal, setRecordTotal] = useState(0);
  const [showAddZone, setShowAddZone] = useState(false);
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [editRecord, setEditRecord]   = useState<DnsRecord | null>(null);
  const [selectedRecords, setSelectedRecords] = useState<Record<number, boolean>>({});
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [exporting, setExporting]     = useState(false);
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
    setSelectedRecords({});
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

  // resolve the owning zone for a record (records may span zones during a global search)
  const zoneForRecord = useCallback((record: DnsRecord): DnsZone | null => {
    return zones.find(z => z.id === record.zone_id) || (selectedZone && selectedZone.id === record.zone_id ? selectedZone : null) || selectedZone;
  }, [zones, selectedZone]);

  const selectedRecordRows = useMemo(() => records.filter(r => selectedRecords[r.id]), [records, selectedRecords]);

  const toggleSelectAll = () => {
    if (records.length > 0 && selectedRecordRows.length === records.length) {
      setSelectedRecords({});
    } else {
      const m: Record<number, boolean> = {};
      records.forEach(r => { m[r.id] = true; });
      setSelectedRecords(m);
    }
  };

  const bulkDelete = async () => {
    if (selectedRecordRows.length === 0) { toast('No records selected', 'error'); return; }
    if (!confirm(`Delete ${selectedRecordRows.length} selected record(s) from the DNS server(s)?`)) return;
    setBulkDeleting(true);
    let ok = 0, fail = 0;
    for (const r of selectedRecordRows) {
      const zone = zoneForRecord(r);
      if (!zone) { fail++; continue; }
      try {
        await api('/dns/records', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            server_id: zone.server_id, zone_name: zone.zone_name,
            hostname: r.hostname, record_type: r.record_type, record_data: r.record_data,
          }),
        });
        ok++;
      } catch { fail++; }
    }
    setBulkDeleting(false);
    setSelectedRecords({});
    toast(`Deleted ${ok} record(s)${fail ? `, ${fail} failed` : ''}`, fail ? 'info' : 'success');
    loadRecords(recordPage);
    loadBreakdown();
    loadZones();
  };

  // Export the selected zone as a standard DNS zone file (BIND-style).
  const exportZone = async (zone: DnsZone) => {
    setExporting(true);
    try {
      // Pull every record for the zone (paginate at the API's max page size).
      const all: DnsRecord[] = [];
      const LIMIT = 500;
      for (let page = 1; ; page++) {
        const params = new URLSearchParams({ page: String(page), limit: String(LIMIT), zone_id: String(zone.id) });
        const d = await api(`/dns/records?${params}`);
        const batch = (d.data as DnsRecord[]) || [];
        all.push(...batch);
        if (batch.length === 0 || all.length >= (d.total || 0)) break;
      }

      const lines: string[] = [
        `; Zone file for ${zone.zone_name}`,
        `; Exported from DDIVault — ${all.length} record${all.length === 1 ? '' : 's'}`,
        `$ORIGIN ${zone.zone_name}.`,
        `$TTL 3600`,
        '',
      ];
      for (const r of all) {
        const name = (r.hostname || '@').padEnd(28);
        const ttl  = String(r.ttl || 3600).padStart(7);
        const type = (r.record_type || '').padEnd(6);
        lines.push(`${name} ${ttl} IN ${type} ${r.record_data || ''}`.trimEnd());
      }
      const text = lines.join('\n') + '\n';

      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${zone.zone_name}.zone`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast(`Exported ${all.length} record(s) from ${zone.zone_name}`, 'success');
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setExporting(false); }
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

  const isForwarder = (z: DnsZone) => (z.zone_type || '').toLowerCase() === 'forwarder';

  // text + zone-type filter
  const filteredZones = useMemo(() => {
    const f = zoneFilter.trim().toLowerCase();
    return serverFilteredZones.filter(z => {
      if (f && !z.zone_name.toLowerCase().includes(f)) return false;
      if (zoneTypeFilter !== 'all' && (z.zone_type || '').toLowerCase() !== zoneTypeFilter) return false;
      return true;
    });
  }, [serverFilteredZones, zoneFilter, zoneTypeFilter]);

  // Total forwarder zones available in "all" view (drives whether the toggle shows at all).
  const forwarderCountAll = useMemo(
    () => (zoneTypeFilter === 'all' ? filteredZones.filter(isForwarder).length : 0),
    [filteredZones, zoneTypeFilter],
  );
  // Count currently hidden (for the "+ Show N forwarder zones" label).
  const hiddenForwarderCount = showForwarders ? 0 : forwarderCountAll;

  // Hide forwarder zones unless explicitly shown or filtered to (Fix 1).
  const visibleZones = useMemo(() => {
    if (zoneTypeFilter === 'forwarder' || showForwarders) return filteredZones;
    return filteredZones.filter(z => !isForwarder(z));
  }, [filteredZones, zoneTypeFilter, showForwarders]);

  // Sort (Fix 5)
  const sortZones = useCallback((arr: DnsZone[]) => {
    const out = [...arr];
    if (zoneSort === 'name') out.sort((a, b) => a.zone_name.localeCompare(b.zone_name));
    else if (zoneSort === 'updated') out.sort((a, b) => new Date(b.last_updated || 0).getTime() - new Date(a.last_updated || 0).getTime());
    else out.sort((a, b) => (b.record_count || 0) - (a.record_count || 0)); // records high→low (default)
    return out;
  }, [zoneSort]);

  const listZones = visibleZones;
  const forwardZones = useMemo(() => sortZones(visibleZones.filter(z => !z.is_reverse)), [visibleZones, sortZones]);
  const reverseZones = useMemo(() => sortZones(visibleZones.filter(z => z.is_reverse)), [visibleZones, sortZones]);

  const totalRecords = useMemo(() => serverFilteredZones.reduce((a, z) => a + (z.record_count || 0), 0), [serverFilteredZones]);
  const fwdCount = serverFilteredZones.filter(z => !z.is_reverse).length;

  // Keep selected zone consistent with server filter
  useEffect(() => {
    if (selectedServer && selectedZone && selectedZone.server_id !== selectedServer) {
      setSelectedZone(null);
    }
  }, [selectedServer, selectedZone]);

  const totalPages = Math.max(1, Math.ceil(recordTotal / RECORD_LIMIT));

  // detect whether timestamp columns are available in the current record set
  const hasTimestamps = records.some(r => r.last_updated || r.last_seen);
  const recordAgeDays = (r: DnsRecord): number | null => {
    const iso = r.last_updated || r.last_seen;
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* toolbar actions */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
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
      </div>

      {/* ── Server selector pills ── */}
      {servers.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => setSelectedServer(null)} style={{
            padding: '7px 14px', borderRadius: 22, cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600,
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
          { l: 'DNS Servers',   v: servers.length,             c: 'var(--navy)', tc: 'var(--text-primary)' },
          { l: 'Total Zones',   v: serverFilteredZones.length, c: 'var(--blue)' },
          { l: 'Forward Zones', v: fwdCount,                   c: 'var(--green)' },
          { l: 'Total Records', v: totalRecords,               c: 'var(--purple)' },
        ].map((t, i) => (
          <div key={i} className="kpi-card" style={{ borderLeftColor: t.c }}>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: (t as { tc?: string }).tc || t.c, letterSpacing: '-0.5px' }}>{t.v}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3 }}>{t.l}</div>
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
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                placeholder="Filter zones…"
                value={zoneFilter}
                onChange={e => setZoneFilter(e.target.value)}
                style={INPUT}
              />
              {/* Type filter pills (Fix 3) */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {([['all', 'All'], ['primary', 'Primary'], ['secondary', 'Secondary'], ['forwarder', 'Forwarder']] as const).map(([key, label]) => {
                  const active = zoneTypeFilter === key;
                  return (
                    <button key={key} onClick={() => setZoneTypeFilter(key)} style={{
                      padding: '3px 10px', borderRadius: 14, cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600,
                      border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                      background: active ? 'var(--primary-light)' : 'var(--bg-card)',
                      color: active ? 'var(--primary)' : 'var(--text-muted)', fontFamily: 'inherit',
                    }}>{label}</button>
                  );
                })}
              </div>
              {/* Sort dropdown (Fix 5) */}
              <select value={zoneSort} onChange={e => setZoneSort(e.target.value as typeof zoneSort)}
                style={{ ...INPUT, fontSize: 'var(--text-sm)', padding: '6px 8px' }}>
                <option value="records">Records (High–Low)</option>
                <option value="name">Name (A–Z)</option>
                <option value="updated">Last Updated</option>
              </select>
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
              ) : listZones.length === 0 && hiddenForwarderCount === 0 ? (
                <EmptyState title="No matching zones" message={zoneFilter ? 'Try a different filter.' : 'No zones for this server.'} />
              ) : (
                <>
                  <ZoneSection title="Forward Zones" zones={forwardZones} selectedZone={selectedZone}
                    onSelect={setSelectedZone} onDelete={deleteZone}
                    collapsed={fwdCollapsed} onToggle={() => setFwdCollapsed(c => !c)} />
                  <ZoneSection title="Reverse Zones" zones={reverseZones} selectedZone={selectedZone}
                    onSelect={setSelectedZone} onDelete={deleteZone}
                    collapsed={revCollapsed} onToggle={() => setRevCollapsed(c => !c)} />
                  {/* Show/hide forwarder zones toggle (Fix 1) */}
                  {forwarderCountAll > 0 && (
                    <button
                      onClick={() => setShowForwarders(s => !s)}
                      style={{
                        width: '100%', textAlign: 'left', padding: '9px 13px', cursor: 'pointer',
                        background: 'var(--bg-primary)', border: 'none', borderTop: '1px solid var(--border-light)',
                        color: 'var(--primary)', fontSize: 'var(--text-xs)', fontWeight: 600, fontFamily: 'inherit',
                      }}
                    >
                      {showForwarders
                        ? '− Hide forwarder zones'
                        : `+ Show ${hiddenForwarderCount} forwarder zone${hiddenForwarderCount === 1 ? '' : 's'}`}
                    </button>
                  )}
                </>
              )}
            </div>
            {/* Record-type legend */}
            {breakdown.length > 0 && (
              <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {breakdown.map((b, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-xs)' }}>
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
              {canWrite && selectedRecordRows.length > 0 && (
                <button onClick={bulkDelete} disabled={bulkDeleting} className="btn"
                  style={{ color: 'var(--red)', borderColor: 'var(--red)', whiteSpace: 'nowrap', opacity: bulkDeleting ? 0.6 : 1 }}>
                  {bulkDeleting ? <Spinner size={12} /> : `Delete selected (${selectedRecordRows.length})`}
                </button>
              )}
              <button onClick={() => selectedZone && exportZone(selectedZone)} disabled={!selectedZone || exporting} className="btn"
                title={selectedZone ? `Export ${selectedZone.zone_name} as a zone file` : 'Select a zone to export'}
                style={{ opacity: selectedZone && !exporting ? 1 : 0.5, whiteSpace: 'nowrap' }}>
                {exporting ? <Spinner size={12} /> : '↓ Export zone'}
              </button>
              {canWrite && (
                <button onClick={() => setShowAddRecord(true)} disabled={!selectedZone} className="btn btn-primary"
                  style={{ opacity: selectedZone ? 1 : 0.5, whiteSpace: 'nowrap' }}>+ Add Record</button>
              )}
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {recordTotal.toLocaleString()} {recordTotal === 1 ? 'record' : 'records'}
              </span>
            </div>

            {/* Context line */}
            <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-light)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {globalSearch
                ? <span>Searching all zones for “<span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{recordSearch}</span>”</span>
                : selectedZone
                  ? <span>Zone <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', fontWeight: 600 }}>{selectedZone.zone_name}</span>{' · '}{selectedZone.server_hostname || '—'}</span>
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
                      {canWrite && (
                        <th style={{ width: 30 }}>
                          <input type="checkbox" aria-label="Select all records"
                            checked={records.length > 0 && selectedRecordRows.length === records.length}
                            onChange={toggleSelectAll}
                            style={{ cursor: 'pointer' }} />
                        </th>
                      )}
                      <th>Hostname</th>
                      <th>Type</th>
                      <th>Data</th>
                      <th>TTL</th>
                      <th>Zone</th>
                      {hasTimestamps && <th>Last Updated</th>}
                      {hasTimestamps && <th>Age</th>}
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r, i) => {
                      const age = recordAgeDays(r);
                      const stale = age != null && age > 90;
                      const checked = !!selectedRecords[r.id];
                      return (
                        <tr key={r.id ?? i} style={
                          checked ? { background: 'var(--primary-light)' }
                          : stale ? { background: 'var(--yellow)' + '14' } : undefined
                        }>
                          {canWrite && (
                            <td>
                              <input type="checkbox" aria-label={`Select ${r.hostname}`}
                                checked={checked}
                                onChange={e => setSelectedRecords(p => ({ ...p, [r.id]: e.target.checked }))}
                                style={{ cursor: 'pointer' }} />
                            </td>
                          )}
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.hostname}</td>
                          <td><TypeBadge type={r.record_type} /></td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.record_data}>{r.record_data}</td>
                          <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{r.ttl}s</td>
                          <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{r.zone_name}</td>
                          {hasTimestamps && <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{shortTime(r.last_updated || r.last_seen)}</td>}
                          {hasTimestamps && <td style={{ fontSize: 'var(--text-sm)', color: stale ? 'var(--orange)' : 'var(--text-muted)', fontWeight: stale ? 700 : 400 }}>{age != null ? `${age}d` : '—'}</td>}
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {canWrite && (
                              <>
                                <button onClick={() => setEditRecord(r)}
                                  style={{ fontSize: 'var(--text-sm)', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', marginRight: 10 }}>Edit</button>
                                <button onClick={() => deleteRecord(r)}
                                  style={{ fontSize: 'var(--text-sm)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
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
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Page {recordPage} of {totalPages}</span>
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
        <RecordModal zone={selectedZone} servers={servers}
          onClose={() => setShowAddRecord(false)}
          onDone={() => { setShowAddRecord(false); loadRecords(recordPage); loadBreakdown(); loadZones(); }} />
      )}
      {editRecord && zoneForRecord(editRecord) && (
        <RecordModal zone={zoneForRecord(editRecord)!} servers={servers} editRecord={editRecord}
          onClose={() => setEditRecord(null)}
          onDone={() => { setEditRecord(null); loadRecords(recordPage); loadBreakdown(); loadZones(); }} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// DNS Management Console — full stale-records / forwarder / scavenging
// management, reachable from the Insights "Manage →" / "Clean up →" links.
// (Formerly the standalone Intelligence sub-tab; functionality preserved.)
// ════════════════════════════════════════════════════════════
function DnsManagementConsole({ onBack }: { onBack: () => void }) {
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  // shared zone→server lookup
  const [zones, setZones] = useState<DnsZone[]>([]);

  // stale records
  const [minDays, setMinDays] = useState(90);
  const [zoneNameFilter, setZoneNameFilter] = useState('');
  const [stale, setStale] = useState<StaleRecord[]>([]);
  const [staleLoading, setStaleLoading] = useState(true);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingDelete, setPendingDelete] = useState<StaleRecord[] | null>(null);
  const [cleaning, setCleaning] = useState(false);

  // forwarders
  const [forwarders, setForwarders] = useState<Forwarder[]>([]);
  const [fwdLoading, setFwdLoading] = useState(true);
  const [testing, setTesting] = useState<number | null>(null);

  // scavenging
  const [scav, setScav] = useState<ScavengingRow[]>([]);
  const [scavLoading, setScavLoading] = useState(true);
  const [enabling, setEnabling] = useState<number | null>(null);

  const loadZones = useCallback(async () => {
    const d = await api('/dns/zones').catch(() => null);
    setZones((d?.data as DnsZone[]) || []);
  }, []);

  const loadStale = useCallback(async () => {
    setStaleLoading(true);
    const params = new URLSearchParams({ min_days: String(minDays) });
    const d = await api(`/dns/stale-records?${params}`).catch(() => null);
    setStale((d?.data as StaleRecord[]) || []);
    setSelected({});
    setExpanded({});
    setStaleLoading(false);
  }, [minDays]);

  const loadForwarders = useCallback(async () => {
    setFwdLoading(true);
    const d = await api('/dns/forwarders').catch(() => null);
    setForwarders((d?.data as Forwarder[]) || []);
    setFwdLoading(false);
  }, []);

  const loadScav = useCallback(async () => {
    setScavLoading(true);
    const d = await api('/dns/scavenging').catch(() => null);
    setScav((d?.data as ScavengingRow[]) || []);
    setScavLoading(false);
  }, []);

  useEffect(() => { loadZones(); loadForwarders(); loadScav(); }, [loadZones, loadForwarders, loadScav]);
  useEffect(() => { loadStale(); }, [loadStale]);
  useRefreshKey(() => { loadZones(); loadStale(); loadForwarders(); loadScav(); });

  // per-record server lookup via zone_id (a stale record belongs to one server's zone copy)
  const zoneById = useMemo(() => {
    const m = new Map<number, DnsZone>();
    zones.forEach(z => m.set(z.id, z));
    return m;
  }, [zones]);
  const serverIdForRecord = useCallback((r: StaleRecord): number | null => {
    const z = zoneById.get(r.zone_id);
    if (z) return z.server_id;
    // fallback: any zone with the same name
    const byName = zones.find(z => z.zone_name === r.zone_name);
    return byName ? byName.server_id : null;
  }, [zoneById, zones]);
  const serverHostnameForRecord = useCallback((r: StaleRecord): string => {
    const z = zoneById.get(r.zone_id);
    return z?.server_hostname || (z ? `Server ${z.server_id}` : `Server ${r.zone_id}`);
  }, [zoneById]);

  // per-zone counts (aggregated by zone name) for the filter dropdown
  const zoneCounts = useMemo(() => {
    const m: Record<string, number> = {};
    stale.forEach(r => { m[r.zone_name] = (m[r.zone_name] || 0) + 1; });
    return m;
  }, [stale]);
  const zoneNamesSorted = useMemo(
    () => Object.keys(zoneCounts).sort((a, b) => zoneCounts[b] - zoneCounts[a] || a.localeCompare(b)),
    [zoneCounts]
  );

  // records visible under the current zone-name filter
  const visibleStale = useMemo(
    () => (zoneNameFilter ? stale.filter(r => r.zone_name === zoneNameFilter) : stale),
    [stale, zoneNameFilter]
  );
  const staleZoneNames = useMemo(() => Array.from(new Set(visibleStale.map(s => s.zone_name))), [visibleStale]);

  // collapse duplicate hostnames — one group per zone+hostname+type, across servers
  interface StaleGroup {
    key: string; zone_name: string; hostname: string; record_type: string;
    records: StaleRecord[]; maxDays: number; oldest: string | null;
  }
  const staleGroups = useMemo<StaleGroup[]>(() => {
    const m = new Map<string, StaleGroup>();
    for (const r of visibleStale) {
      const key = `${r.zone_name}||${r.hostname}||${r.record_type}`;
      let g = m.get(key);
      if (!g) { g = { key, zone_name: r.zone_name, hostname: r.hostname, record_type: r.record_type, records: [], maxDays: 0, oldest: null }; m.set(key, g); }
      g.records.push(r);
      if (r.days_stale > g.maxDays) g.maxDays = r.days_stale;
      if (r.last_updated && (!g.oldest || r.last_updated < g.oldest)) g.oldest = r.last_updated;
    }
    return Array.from(m.values()).sort((a, b) => b.maxDays - a.maxDays);
  }, [visibleStale]);

  const selectedRows = useMemo(() => visibleStale.filter(s => selected[s.id]), [visibleStale, selected]);
  const allSelected = visibleStale.length > 0 && visibleStale.every(r => selected[r.id]);
  const someSelected = visibleStale.some(r => selected[r.id]);

  const toggleSelectAll = (checked: boolean) => {
    setSelected(prev => {
      const next = { ...prev };
      visibleStale.forEach(r => { if (checked) next[r.id] = true; else delete next[r.id]; });
      return next;
    });
  };
  const toggleGroup = (g: StaleGroup, checked: boolean) => {
    setSelected(prev => {
      const next = { ...prev };
      g.records.forEach(r => { if (checked) next[r.id] = true; else delete next[r.id]; });
      return next;
    });
  };
  const toggleRecord = (id: number, checked: boolean) => {
    setSelected(prev => {
      const next = { ...prev };
      if (checked) next[id] = true; else delete next[id];
      return next;
    });
  };
  const groupAllSelected = (g: StaleGroup) => g.records.every(r => selected[r.id]);
  const groupSomeSelected = (g: StaleGroup) => g.records.some(r => selected[r.id]);

  // run cleanup for an explicit set of records (server resolved per-record)
  const runCleanup = async (rows: StaleRecord[]) => {
    const recs = rows
      .map(r => {
        const server_id = serverIdForRecord(r);
        return server_id == null ? null : {
          server_id, zone_name: r.zone_name, hostname: r.hostname,
          record_type: r.record_type, record_data: r.record_data,
        };
      })
      .filter((x): x is { server_id: number; zone_name: string; hostname: string; record_type: string; record_data: string } => x !== null);
    if (recs.length === 0) { toast('Could not resolve server for selected records', 'error'); return; }
    setCleaning(true);
    try {
      const d = await api('/dns/stale-records/cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: recs }),
      });
      toast(`Cleanup done — ${d.deleted ?? 0} deleted, ${d.failed ?? 0} failed`, (d.failed ?? 0) > 0 ? 'info' : 'success');
      loadStale();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setCleaning(false); }
  };

  // all delete paths funnel through the confirmation modal
  const requestDelete = (rows: StaleRecord[]) => {
    if (rows.length === 0) { toast('No records selected', 'error'); return; }
    setPendingDelete(rows);
  };
  const confirmDelete = async () => {
    const rows = pendingDelete || [];
    setPendingDelete(null);
    await runCleanup(rows);
  };

  const testForwarder = async (f: Forwarder) => {
    setTesting(f.id);
    try {
      const d = await api('/dns/forwarders/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: f.server_id, forwarder_ip: f.forwarder_ip }),
      });
      const r = d.result || {};
      toast(`${f.forwarder_ip}: ${r.Reachable ? `reachable (${r.ResponseMs ?? '?'}ms)` : 'unreachable'}`, r.Reachable ? 'success' : 'error');
      loadForwarders();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setTesting(null); }
  };

  const enableScav = async (row: ScavengingRow) => {
    setEnabling(row.id);
    try {
      await api('/dns/scavenging/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: row.server_id, zone_name: row.zone_name, enabled: true }),
      });
      toast(`Scavenging enabled on ${row.zone_name}`, 'success');
      loadScav();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setEnabling(null); }
  };

  const respColor = (ms: number | null, reachable: boolean | null): string => {
    if (reachable === false) return 'var(--red)';
    if (ms == null) return 'var(--text-muted)';
    if (ms < 50) return 'var(--green)';
    if (ms <= 200) return 'var(--yellow)';
    return 'var(--red)';
  };

  useEscape(() => { if (pendingDelete) setPendingDelete(null); });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Back to Insights */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack} className="btn" style={{ padding: '6px 12px', fontSize: 'var(--text-sm)' }}>← Back to Insights</button>
        <span style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)' }}>DNS Management Console</span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Stale records · forwarders · scavenging</span>
      </div>

      {/* Stale Records */}
      <div style={CARD}>
        <SectionHead title="Stale Records"
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Min days stale</label>
              <input type="number" value={minDays} min={1}
                onChange={e => setMinDays(Math.max(1, parseInt(e.target.value) || 1))}
                style={{ ...INPUT, width: 80 }} />
              <select value={zoneNameFilter} onChange={e => setZoneNameFilter(e.target.value)} style={{ ...INPUT, width: 260 }}>
                <option value="">All zones ({stale.length.toLocaleString()})</option>
                {zoneNamesSorted.map(zn => (
                  <option key={zn} value={zn}>{zn} ({zoneCounts[zn].toLocaleString()})</option>
                ))}
              </select>
              {canWrite && (
                <button className="btn btn-primary" disabled={cleaning || selectedRows.length === 0}
                  style={{ opacity: cleaning || selectedRows.length === 0 ? 0.5 : 1 }}
                  onClick={() => requestDelete(selectedRows)}>
                  {cleaning ? <Spinner size={12} color="#fff" /> : `Delete selected (${selectedRows.length})`}
                </button>
              )}
            </div>
          } />
        <div style={{ padding: '8px 16px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)' }}>
          {visibleStale.length.toLocaleString()} stale record{visibleStale.length === 1 ? '' : 's'} in {staleGroups.length.toLocaleString()} unique entr{staleGroups.length === 1 ? 'y' : 'ies'} across {staleZoneNames.length} zone{staleZoneNames.length === 1 ? '' : 's'}
        </div>
        {staleLoading ? <TableSkeleton rows={6} cols={8} /> : visibleStale.length === 0 ? (
          <EmptyState icon="✓" title="No stale records" message={`No records older than ${minDays} days${zoneNameFilter ? ` in ${zoneNameFilter}` : ''}.`} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <input type="checkbox" checked={allSelected}
                      ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                      onChange={e => toggleSelectAll(e.target.checked)}
                      title="Select all visible records" />
                  </th>
                  <th style={{ width: 24 }}></th>
                  <th>Zone</th>
                  <th>Hostname</th>
                  <th>Type</th>
                  <th>Last Updated</th>
                  <th>Days Stale</th>
                  {canWrite && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {staleGroups.map(g => {
                  const multi = g.records.length > 1;
                  const isOpen = !!expanded[g.key];
                  return (
                    <Fragment key={g.key}>
                      <tr>
                        <td>
                          <input type="checkbox" checked={groupAllSelected(g)}
                            ref={el => { if (el) el.indeterminate = !groupAllSelected(g) && groupSomeSelected(g); }}
                            onChange={e => toggleGroup(g, e.target.checked)} />
                        </td>
                        <td>
                          {multi && (
                            <button onClick={() => setExpanded(p => ({ ...p, [g.key]: !p[g.key] }))}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: 0, width: 18 }}
                              title={isOpen ? 'Collapse' : 'Expand'}>{isOpen ? '▾' : '▸'}</button>
                          )}
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{g.zone_name}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                          {g.hostname}
                          {multi && (
                            <span style={{ marginLeft: 8, fontFamily: 'inherit', fontSize: 'var(--text-xs)', fontWeight: 600,
                              color: 'var(--text-muted)', background: 'var(--bg-primary)', border: '1px solid var(--border)',
                              borderRadius: 10, padding: '1px 8px' }}>
                              × {g.records.length} server{g.records.length === 1 ? '' : 's'}
                            </span>
                          )}
                        </td>
                        <td><TypeBadge type={g.record_type} small /></td>
                        <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{multi ? '—' : shortTime(g.oldest)}</td>
                        <td style={{ fontWeight: 700, color: g.maxDays > 180 ? 'var(--red)' : 'var(--orange)' }}>{g.maxDays}d</td>
                        {canWrite && (
                          <td style={{ textAlign: 'right' }}>
                            <button onClick={() => requestDelete(g.records)}
                              style={{ fontSize: 'var(--text-sm)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>
                              {multi ? `Delete all (${g.records.length})` : 'Delete'}
                            </button>
                          </td>
                        )}
                      </tr>
                      {multi && isOpen && g.records.map(r => (
                        <tr key={r.id} style={{ background: 'var(--bg-primary)' }}>
                          <td>
                            <input type="checkbox" checked={!!selected[r.id]}
                              onChange={e => toggleRecord(r.id, e.target.checked)} />
                          </td>
                          <td></td>
                          <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', paddingLeft: 12 }}>
                            ↳ {serverHostnameForRecord(r)}
                          </td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{r.record_data || '—'}</td>
                          <td><TypeBadge type={r.record_type} small /></td>
                          <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{shortTime(r.last_updated)}</td>
                          <td style={{ fontWeight: 700, color: r.days_stale > 180 ? 'var(--red)' : 'var(--orange)' }}>{r.days_stale}d</td>
                          {canWrite && (
                            <td style={{ textAlign: 'right' }}>
                              <button onClick={() => requestDelete([r])}
                                style={{ fontSize: 'var(--text-sm)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Forwarder Health */}
      <div style={CARD}>
        <SectionHead title="Forwarder Health" />
        {fwdLoading ? <TableSkeleton rows={4} cols={5} /> : forwarders.length === 0 ? (
          <EmptyState title="No forwarders" message="No DNS forwarders configured on monitored servers." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Forwarder IP</th>
                  <th>Status</th>
                  <th>Response Time</th>
                  <th>Last Checked</th>
                  {canWrite && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {forwarders.map(f => (
                  <tr key={f.id}>
                    <td style={{ fontWeight: 600 }}>{f.hostname}</td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{f.forwarder_ip}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)',
                        color: f.is_reachable ? 'var(--green)' : f.is_reachable === false ? 'var(--red)' : 'var(--text-muted)' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%',
                          background: f.is_reachable ? 'var(--green)' : f.is_reachable === false ? 'var(--red)' : 'var(--text-muted)' }} />
                        {f.is_reachable ? 'Reachable' : f.is_reachable === false ? 'Unreachable' : 'Unknown'}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600, color: respColor(f.response_time_ms, f.is_reachable) }}>
                      {f.response_time_ms != null ? `${f.response_time_ms}ms` : '—'}
                    </td>
                    <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{shortTime(f.last_checked)}</td>
                    {canWrite && (
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn" disabled={testing === f.id} onClick={() => testForwarder(f)}
                          style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }}>
                          {testing === f.id ? <Spinner size={11} /> : 'Test'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Scavenging Status */}
      <div style={CARD}>
        <SectionHead title="Scavenging Status" />
        {scavLoading ? <TableSkeleton rows={4} cols={5} /> : scav.length === 0 ? (
          <EmptyState title="No zones" message="No zones available to report scavenging status." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Zone</th>
                  <th>Server</th>
                  <th>Scavenging</th>
                  <th>Aging</th>
                  <th>Last Scavenged</th>
                  {canWrite && <th style={{ textAlign: 'right' }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {scav.map(row => {
                  const off = !row.scavenging_enabled;
                  return (
                    <tr key={row.id} style={off ? { background: 'var(--yellow)' + '14' } : undefined}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{row.zone_name}</td>
                      <td>{row.hostname}</td>
                      <td><span className={`badge ${row.scavenging_enabled ? 'badge-green' : 'badge-gray'}`}>{row.scavenging_enabled ? 'Enabled' : 'Disabled'}</span></td>
                      <td><span className={`badge ${row.aging_enabled ? 'badge-green' : 'badge-gray'}`}>{row.aging_enabled ? 'Enabled' : 'Disabled'}</span></td>
                      <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{shortTime(row.last_scavenged)}</td>
                      {canWrite && (
                        <td style={{ textAlign: 'right' }}>
                          {off && (
                            <button className="btn" disabled={enabling === row.id} onClick={() => enableScav(row)}
                              style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }}>
                              {enabling === row.id ? <Spinner size={11} /> : 'Enable'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Bulk-delete confirmation */}
      {pendingDelete && (
        <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setPendingDelete(null); }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 24, width: 440, maxWidth: '94vw' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>⚠️ Delete stale records</div>
              <button onClick={() => setPendingDelete(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', color: 'var(--text-muted)' }}>×</button>
            </div>
            <div style={PS_WARNING}>
              ⚡ Removes the record(s) from the DNS server(s) via WinRM. Requires DNS Server role and admin rights.
            </div>
            <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)', lineHeight: 1.5, margin: '0 0 18px' }}>
              You are about to delete <strong>{pendingDelete.length.toLocaleString()}</strong> stale DNS record{pendingDelete.length === 1 ? '' : 's'}. This cannot be undone. Are you sure?
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setPendingDelete(null)} className="btn">Cancel</button>
              <button onClick={confirmDelete} disabled={cleaning} className="btn btn-primary" style={{ opacity: cleaning ? 0.7 : 1 }}>
                {cleaning ? <Spinner size={12} color="#fff" /> : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sparkline (module scope) ──────────────────────────────────
function Sparkline({ points, color = 'var(--blue)' }: { points: number[]; color?: string }) {
  if (points.length < 2) return <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>insufficient data</span>;
  const W = 160, H = 36, pad = 2;
  const max = Math.max(...points), min = Math.min(...points);
  const span = max - min || 1;
  const d = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (W - pad * 2);
    const y = H - pad - ((p - min) / span) * (H - pad * 2);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ════════════════════════════════════════════════════════════
// DNS Insights helpers (module scope)
// ════════════════════════════════════════════════════════════
const SEV_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };
const sevBadgeClass = (sev: string) => sev === 'critical' ? 'badge-red' : sev === 'warning' ? 'badge-yellow' : 'badge-gray';
const DNS_ANOMALY_LABELS: Record<string, string> = {
  dns_replication_lag: 'Replication Lag',
  dns_forwarder_down: 'Forwarder Down',
  dns_record_count_drop: 'Record Count Drop',
  dns_stale_records: 'Stale Records',
  dns_scavenging_disabled: 'Scavenging Disabled',
};

function compactNum(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Compact KPI tile — number 20px, label 11px, 70px tall
function InsightKpi({ label, value, color, textColor, alert }: { label: string; value: React.ReactNode; color: string; textColor?: string; alert?: boolean }) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: alert ? 'var(--red)' : color, padding: '12px 16px', minHeight: 70 }}>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: alert ? 'var(--red)' : (textColor || color), letterSpacing: '-0.5px', lineHeight: 1.15 }}>{value}</div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

// Small inline "action →" link used in card headers / rows
function CardLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: 'var(--text-xs)', fontWeight: 600, fontFamily: 'inherit', padding: 0, whiteSpace: 'nowrap' }}>{label}</button>
  );
}

// Compact card shell — header padding 12px 16px, title 13px. scroll caps body to ~5 rows.
function InsightCard({ title, right, children, scroll }: { title: string; right?: React.ReactNode; children: React.ReactNode; scroll?: boolean }) {
  return (
    <div style={{ ...CARD, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        {right}
      </div>
      <div style={{ flex: 1, minHeight: 0, ...(scroll ? { maxHeight: 196, overflowY: 'auto' as const } : {}) }}>{children}</div>
    </div>
  );
}

// Locked / not-yet-available card
function LockedCard({ icon, title, lines, linkLabel }: { icon: string; title: string; lines: string[]; linkLabel: string }) {
  return (
    <div style={{
      background: 'var(--bg-primary)', border: '1px dashed var(--border)', borderRadius: 'var(--radius)',
      opacity: 0.7, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', minHeight: 160, padding: 16, gap: 5,
    }}>
      <div style={{ fontSize: 'var(--text-xl)' }}>{icon}</div>
      <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
      {lines.map((l, i) => <div key={i} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.3 }}>{l}</div>)}
      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginTop: 4 }}>{linkLabel}</span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// PANEL — DNS Insights (replaces Intelligence + Analytics)
// ════════════════════════════════════════════════════════════
function InsightsPanel({ onNavigate, onGotoHealth }: { onNavigate?: (tab: 'events') => void; onGotoHealth: () => void }) {
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  const [view, setView] = useState<'dashboard' | 'manage'>('dashboard');

  const [topology, setTopology]   = useState<TopologyServer[]>([]);
  const [queryStats, setQueryStats] = useState<QueryStat[]>([]);
  const [health, setHealth]       = useState<DnsHealth | null>(null);
  const [forwarders, setForwarders] = useState<Forwarder[]>([]);
  const [breakdown, setBreakdown] = useState<{ record_type: string; count: number }[]>([]);
  const [scav, setScav]           = useState<ScavengingRow[]>([]);
  const [stale, setStale]         = useState<StaleRecord[]>([]);
  const [zones, setZones]         = useState<DnsZone[]>([]);
  const [anomalies, setAnomalies] = useState<DnsAnomaly[]>([]);
  const [loading, setLoading]     = useState(true);

  const [testing, setTesting]   = useState<number | null>(null);
  const [enabling, setEnabling] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [t, q, h, f, b, sc, st, z, an] = await Promise.all([
      api('/dns/topology').catch(() => null),
      api('/dns/query-stats').catch(() => null),
      api('/dns/health').catch(() => null),
      api('/dns/forwarders').catch(() => null),
      api('/dns/record-type-breakdown').catch(() => null),
      api('/dns/scavenging').catch(() => null),
      api('/dns/stale-records').catch(() => null),
      api('/dns/zones').catch(() => null),
      api('/anomalies?acknowledged=false&limit=1000').catch(() => null),
    ]);
    setTopology((t?.servers as TopologyServer[]) || []);
    setQueryStats((q?.data as QueryStat[]) || []);
    setHealth(h || null);
    setForwarders((f?.data as Forwarder[]) || []);
    setBreakdown((b?.data as { record_type: string; count: number }[]) || []);
    setScav((sc?.data as ScavengingRow[]) || []);
    setStale((st?.data as StaleRecord[]) || []);
    setZones((z?.data as DnsZone[]) || []);
    const allAn = (an?.data as DnsAnomaly[]) || [];
    setAnomalies(allAn.filter(a => (a.anomaly_type || '').startsWith('dns_')));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useRefreshKey(() => { load(); });

  // ── Inline write actions ────────────────────────────────────
  const testForwarder = async (f: Forwarder) => {
    setTesting(f.id);
    try {
      const d = await api('/dns/forwarders/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: f.server_id, forwarder_ip: f.forwarder_ip }),
      });
      const r = d.result || {};
      toast(`${f.forwarder_ip}: ${r.Reachable ? `reachable (${r.ResponseMs ?? '?'}ms)` : 'unreachable'}`, r.Reachable ? 'success' : 'error');
      load();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setTesting(null); }
  };

  const enableScav = async (row: ScavengingRow) => {
    setEnabling(row.id);
    try {
      await api('/dns/scavenging/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: row.server_id, zone_name: row.zone_name, enabled: true }),
      });
      toast(`Scavenging enabled on ${row.zone_name}`, 'success');
      load();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setEnabling(null); }
  };

  // ── Derived data ────────────────────────────────────────────
  const avgHealth = useMemo(() => {
    if (!topology.length) return null;
    return Math.round(topology.reduce((a, s) => a + (s.health_score || 0), 0) / topology.length);
  }, [topology]);

  const queryAgg = useMemo(() => {
    let total = 0, success = 0, hasData = false;
    for (const s of queryStats) {
      if (s.latest) {
        hasData = true;
        const tq = s.latest.total_queries || 0;
        total += tq;
        success += s.latest.successful ?? (tq - (s.latest.failed || 0));
      }
    }
    return { total, success, hasData, rate: total > 0 ? (success / total) * 100 : null };
  }, [queryStats]);

  const recordTotal = useMemo(() => breakdown.reduce((a, b) => a + (Number(b.count) || 0), 0), [breakdown]);
  const recordRows = useMemo(() => {
    const m = new Map(breakdown.map(b => [b.record_type, Number(b.count) || 0]));
    return RECORD_TYPES.map(tp => ({ type: tp, count: m.get(tp) || 0 })).filter(r => r.count > 0);
  }, [breakdown]);
  const maxRecord = recordRows.reduce((m, r) => Math.max(m, r.count), 0) || 1;

  const topZones = useMemo(() => [...zones].sort((a, b) => (b.record_count || 0) - (a.record_count || 0)).slice(0, 8), [zones]);
  const maxZoneCount = topZones.reduce((m, z) => Math.max(m, z.record_count || 0), 0) || 1;

  const staleByZone = useMemo(() => {
    const m = new Map<string, { zone: string; count: number; oldest: number }>();
    for (const r of stale) {
      let g = m.get(r.zone_name);
      if (!g) { g = { zone: r.zone_name, count: 0, oldest: 0 }; m.set(r.zone_name, g); }
      g.count++;
      if (r.days_stale > g.oldest) g.oldest = r.days_stale;
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count);
  }, [stale]);

  const anomalyByType = useMemo(() => {
    const m = new Map<string, { type: string; count: number; sev: string }>();
    for (const a of anomalies) {
      let g = m.get(a.anomaly_type);
      if (!g) { g = { type: a.anomaly_type, count: 0, sev: 'info' }; m.set(a.anomaly_type, g); }
      g.count++;
      if ((SEV_RANK[a.severity] || 0) > (SEV_RANK[g.sev] || 0)) g.sev = a.severity;
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count || (SEV_RANK[b.sev] || 0) - (SEV_RANK[a.sev] || 0));
  }, [anomalies]);

  const queryServers = useMemo(() => queryStats.filter(s => s.history && s.history.length > 0), [queryStats]);

  // ── Detail (management console) view ────────────────────────
  if (view === 'manage') return <DnsManagementConsole onBack={() => { setView('dashboard'); load(); }} />;

  // ── Loading skeleton ────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,minmax(0,1fr))', gap: 12 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="kpi-card"><Skeleton height={20} width="55%" /><div style={{ height: 8 }} /><Skeleton height={11} width="75%" /></div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }}>
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="card"><TableSkeleton rows={5} cols={3} /></div>)}
        </div>
      </div>
    );
  }

  const inSync = health?.zones_in_sync ?? 0;
  const syncTotal = (health?.zones_in_sync ?? 0) + (health?.zones_out_of_sync ?? 0);
  const staleTotal = stale.length;
  const scavDisabled = health?.scavenging_disabled_zones ?? 0;
  const replIssues = health?.replication_issues ?? 0;

  const cellSm: React.CSSProperties = { fontSize: 'var(--text-sm)' };
  const tableStyle: React.CSSProperties = { fontSize: 'var(--text-sm)' };

  // Hygiene metric row
  const hygiene = (icon: string, label: string, count: number, ok: boolean, action: { label: string; onClick: () => void }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border-light)' }}>
      <span style={{ fontSize: 'var(--text-lg)', width: 22, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 600 }}>{label}</div>
      </div>
      <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: ok ? 'var(--green)' : 'var(--orange)', letterSpacing: '-0.5px' }}>{count.toLocaleString()}</span>
      <span className={`badge ${ok ? 'badge-green' : 'badge-yellow'}`} style={{ flexShrink: 0 }}>{ok ? 'OK' : 'Review'}</span>
      <CardLink label={action.label} onClick={action.onClick} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ───────────────── Row 1 — KPI strip ───────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,minmax(0,1fr))', gap: 12 }}>
        <InsightKpi label="Avg Health" color={avgHealth != null ? scoreColor(avgHealth) : 'var(--text-muted)'}
          value={avgHealth != null ? avgHealth : '—'} />
        <InsightKpi label="Query Success Rate"
          color={queryAgg.rate == null ? 'var(--text-muted)' : queryAgg.rate >= 99 ? 'var(--green)' : 'var(--yellow)'}
          alert={queryAgg.rate != null && queryAgg.rate < 95}
          value={queryAgg.rate == null ? '—' : `${queryAgg.rate.toFixed(2)}%`} />
        <InsightKpi label="Total Queries 24h" color="var(--blue)"
          value={queryAgg.hasData ? compactNum(queryAgg.total) : '—'} />
        <InsightKpi label="Active Servers" color="var(--green)"
          value={`${health?.servers_online ?? 0}/${health?.servers_total ?? 0}`}
          alert={(health?.servers_total ?? 0) > 0 && (health?.servers_online ?? 0) < (health?.servers_total ?? 0)} />
        <InsightKpi label="Zones In Sync" color="var(--navy)" textColor="var(--text-primary)"
          value={`${inSync}/${syncTotal}`}
          alert={(health?.zones_out_of_sync ?? 0) > 0} />
        <InsightKpi label="Open Alerts" color={anomalies.length > 0 ? 'var(--red)' : 'var(--green)'}
          value={anomalies.length} alert={anomalies.length > 0} />
      </div>

      {/* ───────────────── Row 2 — 3 columns ───────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }}>

        {/* Forwarder Health */}
        <InsightCard title="Forwarder Health" scroll>
          {forwarders.length === 0 ? (
            <EmptyState title="No forwarders" message="No DNS forwarders on monitored servers." />
          ) : (
            <table className="data-table" style={tableStyle}>
              <thead>
                <tr><th>Server</th><th>Forwarder</th><th>Status</th><th>Resp</th>{canWrite && <th style={{ textAlign: 'right' }}></th>}</tr>
              </thead>
              <tbody>
                {forwarders.map(f => (
                  <tr key={f.id}>
                    <td style={{ ...cellSm, fontWeight: 600, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.hostname}>{f.hostname}</td>
                    <td style={{ ...cellSm, fontFamily: 'var(--font-mono)' }}>{f.forwarder_ip}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: f.is_reachable ? 'var(--green)' : f.is_reachable === false ? 'var(--red)' : 'var(--text-muted)' }} />
                      </span>
                    </td>
                    <td style={{ ...cellSm, fontWeight: 600, color: f.is_reachable === false ? 'var(--red)' : f.response_time_ms == null ? 'var(--text-muted)' : f.response_time_ms < 50 ? 'var(--green)' : f.response_time_ms <= 200 ? 'var(--yellow)' : 'var(--red)' }}>
                      {f.response_time_ms != null ? `${f.response_time_ms}ms` : '—'}
                    </td>
                    {canWrite && (
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn" disabled={testing === f.id} onClick={() => testForwarder(f)} style={{ padding: '3px 9px', fontSize: 'var(--text-xs)' }}>
                          {testing === f.id ? <Spinner size={10} /> : 'Test'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </InsightCard>

        {/* Record Type Distribution — horizontal bars */}
        <InsightCard title="Record Type Distribution">
          {recordRows.length === 0 ? (
            <EmptyState title="No records" message="No DNS records to chart." />
          ) : (
            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 7 }}>
              {recordRows.map(r => (
                <div key={r.type} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 44, fontSize: 'var(--text-xs)', fontWeight: 700, color: RECORD_COLORS[r.type] || '#6b7280', flexShrink: 0 }}>{r.type}</span>
                  <div style={{ flex: 1, height: 9, background: 'var(--border)', borderRadius: 5, overflow: 'hidden' }}>
                    <div style={{ width: `${(r.count / maxRecord) * 100}%`, height: '100%', background: RECORD_COLORS[r.type] || '#6b7280', borderRadius: 5 }} />
                  </div>
                  <span style={{ width: 54, textAlign: 'right', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>{r.count.toLocaleString()}</span>
                  <span style={{ width: 40, textAlign: 'right', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>{((r.count / recordTotal) * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          )}
        </InsightCard>

        {/* Security Intelligence */}
        <InsightCard title="Security Intelligence"
          right={<CardLink label="View all →" onClick={() => onNavigate?.('events')} />} scroll>
          {anomalyByType.length === 0 ? (
            <EmptyState icon="✓" title="No DNS anomalies" message="No unacknowledged DNS security anomalies." />
          ) : (
            <table className="data-table" style={tableStyle}>
              <thead><tr><th>Anomaly</th><th style={{ textAlign: 'center' }}>Count</th><th style={{ textAlign: 'right' }}>Severity</th></tr></thead>
              <tbody>
                {anomalyByType.slice(0, 8).map(a => (
                  <tr key={a.type}>
                    <td style={{ ...cellSm, fontWeight: 600 }}>{DNS_ANOMALY_LABELS[a.type] || a.type}</td>
                    <td style={{ ...cellSm, textAlign: 'center', fontWeight: 700 }}>{a.count}</td>
                    <td style={{ textAlign: 'right' }}><span className={`badge ${sevBadgeClass(a.sev)}`}>{a.sev}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </InsightCard>
      </div>

      {/* ───────────────── Row 3 — 3 columns ───────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }}>

        {/* DNS Hygiene */}
        <InsightCard title="DNS Hygiene">
          {hygiene('🧹', 'Stale Records', staleTotal, staleTotal === 0, { label: 'Clean up →', onClick: () => setView('manage') })}
          {hygiene('🗑️', 'Scavenging Disabled', scavDisabled, scavDisabled === 0, { label: 'Manage →', onClick: () => setView('manage') })}
          {hygiene('🔁', 'Replication Issues', replIssues, replIssues === 0, { label: 'View →', onClick: onGotoHealth })}
        </InsightCard>

        {/* Scavenging Status */}
        <InsightCard title="Scavenging Status" scroll>
          {scav.length === 0 ? (
            <EmptyState title="No zones" message="No zones to report scavenging status." />
          ) : (
            <table className="data-table" style={tableStyle}>
              <thead><tr><th>Zone</th><th>Scav</th><th>Aging</th>{canWrite && <th style={{ textAlign: 'right' }}></th>}</tr></thead>
              <tbody>
                {scav.map(row => {
                  const off = !row.scavenging_enabled;
                  return (
                    <tr key={row.id} style={off ? { background: 'var(--yellow)' + '14' } : undefined}>
                      <td style={{ ...cellSm, fontFamily: 'var(--font-mono)', fontWeight: 600, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.zone_name}>{row.zone_name}</td>
                      <td><span className={`badge ${row.scavenging_enabled ? 'badge-green' : 'badge-gray'}`}>{row.scavenging_enabled ? 'On' : 'Off'}</span></td>
                      <td><span className={`badge ${row.aging_enabled ? 'badge-green' : 'badge-gray'}`}>{row.aging_enabled ? 'On' : 'Off'}</span></td>
                      {canWrite && (
                        <td style={{ textAlign: 'right' }}>
                          {off && (
                            <button className="btn" disabled={enabling === row.id} onClick={() => enableScav(row)} style={{ padding: '3px 9px', fontSize: 'var(--text-xs)' }}>
                              {enabling === row.id ? <Spinner size={10} /> : 'Enable'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </InsightCard>

        {/* Query Rate (server-level) */}
        <InsightCard title="Query Rate"
          right={<span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>24h · server-level</span>} scroll>
          {queryServers.length === 0 ? (
            <EmptyState title="No query data" message="Query rate appears once the collector gathers DNS stats." />
          ) : (
            <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {queryServers.map(s => {
                const pts = s.history.map(h => h.queries_per_sec || 0);
                const latest = s.latest?.queries_per_sec ?? pts[pts.length - 1] ?? 0;
                return (
                  <div key={s.server_id} style={{ display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border-light)', paddingBottom: 7 }}>
                    <div style={{ width: 120, flexShrink: 0, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.hostname}>{s.hostname}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{latest.toFixed(1)} qps</div>
                    </div>
                    <Sparkline points={pts} color="var(--blue)" />
                  </div>
                );
              })}
            </div>
          )}
        </InsightCard>
      </div>

      {/* ───────────────── Row 4 — 2 cols + 2 locked ───────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12 }}>

        {/* Top Zones by Record Count */}
        <InsightCard title="Top Zones by Record Count" scroll>
          {topZones.length === 0 ? (
            <EmptyState title="No zones" message="No zones available." />
          ) : (
            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 7 }}>
              {topZones.map(z => (
                <div key={z.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 110, fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }} title={z.zone_name}>{z.zone_name}</span>
                  <div style={{ flex: 1, height: 9, background: 'var(--border)', borderRadius: 5, overflow: 'hidden' }}>
                    <div style={{ width: `${((z.record_count || 0) / maxZoneCount) * 100}%`, height: '100%', background: 'var(--blue)', borderRadius: 5 }} />
                  </div>
                  <span style={{ width: 48, textAlign: 'right', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>{(z.record_count || 0).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </InsightCard>

        {/* Stale Records Summary */}
        <InsightCard title="Stale Records Summary"
          right={<CardLink label="Clean up →" onClick={() => setView('manage')} />} scroll>
          {staleByZone.length === 0 ? (
            <EmptyState icon="✓" title="No stale records" message="No stale records detected." />
          ) : (
            <table className="data-table" style={tableStyle}>
              <thead><tr><th>Zone</th><th style={{ textAlign: 'center' }}>Stale</th><th style={{ textAlign: 'center' }}>Oldest</th><th style={{ textAlign: 'right' }}></th></tr></thead>
              <tbody>
                {staleByZone.map(g => (
                  <tr key={g.zone}>
                    <td style={{ ...cellSm, fontFamily: 'var(--font-mono)', fontWeight: 600, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.zone}>{g.zone}</td>
                    <td style={{ ...cellSm, textAlign: 'center', fontWeight: 700 }}>{g.count.toLocaleString()}</td>
                    <td style={{ ...cellSm, textAlign: 'center', fontWeight: 700, color: g.oldest > 180 ? 'var(--red)' : 'var(--orange)' }}>{g.oldest}d</td>
                    <td style={{ textAlign: 'right' }}><CardLink label="Clean up →" onClick={() => setView('manage')} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </InsightCard>

        {/* Locked — Top Queried Domains */}
        <LockedCard icon="🔒" title="Top Queried Domains"
          lines={['Requires Windows DNS', 'Analytical Event Log']} linkLabel="How to enable →" />

        {/* Locked — Zone Growth Trend */}
        <LockedCard icon="🔒" title="Zone Growth Trend"
          lines={['Historical snapshots', 'not yet collected']} linkLabel="Learn more →" />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN DNS TAB — thin shell with sub-tab routing
// ════════════════════════════════════════════════════════════
type DnsSubTab = 'health' | 'zones' | 'insights';

export default function DNSTab({ onNavigate }: { onNavigate?: (tab: 'events') => void } = {}) {
  const [tab, setTab] = useState<DnsSubTab>('health');

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader title="DNS" subtitle="DNS health, replication topology, zones, records, and hygiene intelligence" />
      <ReadOnlyBanner />

      {/* Sub-tab bar */}
      <div className="sub-tab-bar">
        <SubTabButton label="Health Overview" active={tab === 'health'} onClick={() => setTab('health')} />
        <SubTabButton label="Zones & Records" active={tab === 'zones'} onClick={() => setTab('zones')} />
        <SubTabButton label="DNS Insights" active={tab === 'insights'} onClick={() => setTab('insights')} />
      </div>

      {tab === 'health' && <HealthOverviewPanel />}
      {tab === 'zones' && <ZonesRecordsPanel />}
      {tab === 'insights' && <InsightsPanel onNavigate={onNavigate} onGotoHealth={() => setTab('health')} />}
    </div>
  );
}
