'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/components/Toast';
import IPAMImport from '@/components/IPAMImport';
import {
  PageHeader, EmptyState, Skeleton, TableSkeleton, Breadcrumb,
  UtilBar, Spinner, pctColor, useRefreshKey, useEscape,
} from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface Supernet {
  id: number;
  network: string;
  prefix_length: number;
  name: string;
  description: string;
  site: string;
  subnet_count: number;
  total_hosts: number;
  used_hosts: number;
  free_hosts: number;
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
  supernet_id: number;
  supernet_name: string;
  supernet_network: string;
  supernet_prefix: number;
  location: string;
  notes: string;
  scan_status: string;
  last_scanned: string;
  total_hosts: number;
  used_hosts: number;
  free_hosts: number;
  unknown_hosts: number;
}

interface IPAddress {
  id: number;
  ip_address: string;
  status: string;
  hostname: string;
  mac_address: string;
  description: string;
  owner: string;
  last_seen: string;
  last_ping: string;
  ping_ms: number;
  is_reserved: boolean;
  reserved_by: string;
  lease_expiry: string;
}

interface Vlan {
  id: number;
  vlan_id: number;
  name: string;
  description: string;
  site: string;
}

interface Site { id: number; name: string; code: string; city: string }

interface Conflict {
  id_a: number; network_a: string; prefix_a: number; name_a: string; site_a: string;
  id_b: number; network_b: string; prefix_b: number; name_b: string; site_b: string;
}

// ════════════════════════════════════════════════════════════
// API helper
// ════════════════════════════════════════════════════════════
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ════════════════════════════════════════════════════════════
// Helpers / shared styles
// ════════════════════════════════════════════════════════════
const PREFIX_OPTIONS = [24, 25, 26, 27, 28, 29, 30];

function totalHosts(prefix: number) {
  return Math.max(0, Math.pow(2, 32 - prefix) - 2);
}

function utilPct(used: number, total: number) {
  return total > 0 ? (used / total) * 100 : 0;
}

// Per-status colour + badge + subtle row tint
const STATUS_COLOR: Record<string, string> = {
  available: 'var(--green)',
  dhcp:      'var(--blue)',
  reserved:  'var(--red)',
  unknown:   'var(--orange)',
  offline:   'var(--text-muted)',
};
const STATUS_BADGE: Record<string, string> = {
  available: 'badge-green',
  dhcp:      'badge-blue',
  reserved:  'badge-red',
  unknown:   'badge-orange',
  offline:   'badge-gray',
};
const STATUS_TINT: Record<string, string> = {
  available: 'rgba(22,163,74,0.06)',
  dhcp:      'rgba(37,99,235,0.06)',
  reserved:  'rgba(220,38,38,0.06)',
  unknown:   'rgba(234,88,12,0.07)',
  offline:   'transparent',
};

const INPUT: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)',
  color: 'var(--text-primary)', fontSize: 13.5, fontFamily: 'inherit', outline: 'none',
};

const TD: React.CSSProperties = { padding: '9px 14px', fontSize: 13, color: 'var(--text-primary)' };
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

function fmtDate(d?: string) { return d ? new Date(d).toLocaleString() : '—'; }
function fmtDay(d?: string)  { return d ? new Date(d).toLocaleDateString() : '—'; }

function scanLabel(status: string, last_scanned?: string) {
  if (status === 'scanning') return '⟳ Scanning';
  if (status === 'done' && last_scanned) return `✓ ${fmtDay(last_scanned)}`;
  if (status === 'error') return '⚠ Error';
  return 'Not scanned';
}

// ════════════════════════════════════════════════════════════
// Field / Modal helpers (module scope)
// ════════════════════════════════════════════════════════════
function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div style={{ marginBottom: 10, ...(full ? { gridColumn: '1/-1' } : {}) }}>
      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>{label}</label>
      {children}
    </div>
  );
}

function SiteSelect({ value, onChange, sites }: { value: string; onChange: (v: string) => void; sites: Site[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={INPUT}>
      <option value="">— No site —</option>
      {sites.map(s => (
        <option key={s.id} value={s.name}>
          {s.name}{s.code ? ` (${s.code})` : ''}{s.city ? ` · ${s.city}` : ''}
        </option>
      ))}
    </select>
  );
}

function ModalShell({ title, subtitle, width = 540, onClose, children }: {
  title: string; subtitle?: string; width?: number; onClose: () => void; children: React.ReactNode;
}) {
  useEscape(onClose);
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
        width, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto', padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({ onCancel, onConfirm, confirmLabel, busy }: {
  onCancel: () => void; onConfirm: () => void; confirmLabel: string; busy?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
      <button className="btn" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary" onClick={onConfirm} disabled={busy} style={{ opacity: busy ? 0.7 : 1 }}>
        {busy ? <Spinner color="#fff" /> : null}{confirmLabel}
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MODALS (module scope)
// ════════════════════════════════════════════════════════════
function AddSupernetModal({ sites, onClose, onSaved }: {
  sites: Site[]; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ network: '', prefix_length: '8', name: '', description: '', site: '' });
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.network.trim()) { toast('Network is required', 'error'); return; }
    setBusy(true);
    try {
      await api('/ipam/supernets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      toast('Supernet added', 'success');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title="Add Supernet" subtitle="Top-level network block (e.g. 10.0.0.0/8)" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Network" full><input value={form.network} onChange={e => set('network', e.target.value)} style={INPUT} placeholder="10.0.0.0" /></Field>
        <Field label="Prefix Length"><input value={form.prefix_length} onChange={e => set('prefix_length', e.target.value)} style={INPUT} placeholder="8" /></Field>
        <Field label="Name"><input value={form.name} onChange={e => set('name', e.target.value)} style={INPUT} placeholder="Corp Backbone" /></Field>
        <Field label="Description" full><input value={form.description} onChange={e => set('description', e.target.value)} style={INPUT} /></Field>
        <Field label="Site (from NetVault)" full><SiteSelect value={form.site} onChange={v => set('site', v)} sites={sites} /></Field>
      </div>
      <ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Add Supernet" busy={busy} />
    </ModalShell>
  );
}

function AddSubnetModal({ sites, supernets, defaultSupernetId, defaultNetwork, onClose, onSaved }: {
  sites: Site[]; supernets: Supernet[]; defaultSupernetId: number | null; defaultNetwork?: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [supernetId, setSupernetId] = useState<number | null>(defaultSupernetId);
  const [form, setForm] = useState({
    network: defaultNetwork || '', prefix_length: '24', name: '', description: '',
    gateway: '', vlan_id: '', site: '', owner: '', location: '', notes: '',
  });
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.network.trim()) { toast('Network is required', 'error'); return; }
    setBusy(true);
    try {
      await api('/ipam/subnets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, supernet_id: supernetId }),
      });
      toast('Subnet added', 'success');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title="Add Subnet" subtitle="Individual subnet within a supernet" width={620} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Network" full><input value={form.network} onChange={e => set('network', e.target.value)} style={INPUT} placeholder="192.168.1.0" /></Field>
        <Field label="Prefix Length"><input value={form.prefix_length} onChange={e => set('prefix_length', e.target.value)} style={INPUT} placeholder="24" /></Field>
        <Field label="Name"><input value={form.name} onChange={e => set('name', e.target.value)} style={INPUT} placeholder="Office LAN" /></Field>
        <Field label="Gateway IP"><input value={form.gateway} onChange={e => set('gateway', e.target.value)} style={INPUT} placeholder="192.168.1.1" /></Field>
        <Field label="VLAN ID"><input value={form.vlan_id} onChange={e => set('vlan_id', e.target.value)} style={INPUT} /></Field>
        <Field label="Owner"><input value={form.owner} onChange={e => set('owner', e.target.value)} style={INPUT} /></Field>
        <Field label="Location"><input value={form.location} onChange={e => set('location', e.target.value)} style={INPUT} /></Field>
        <Field label="Description" full><input value={form.description} onChange={e => set('description', e.target.value)} style={INPUT} /></Field>
        <Field label="Notes" full><input value={form.notes} onChange={e => set('notes', e.target.value)} style={INPUT} /></Field>
        <Field label="Site (from NetVault)" full><SiteSelect value={form.site} onChange={v => set('site', v)} sites={sites} /></Field>
        <Field label="Supernet (optional)" full>
          <select value={supernetId ?? ''} onChange={e => setSupernetId(e.target.value ? parseInt(e.target.value) : null)} style={INPUT}>
            <option value="">— Unassigned —</option>
            {supernets.map(sn => <option key={sn.id} value={sn.id}>{sn.name || `${sn.network}/${sn.prefix_length}`} ({sn.network}/{sn.prefix_length})</option>)}
          </select>
        </Field>
      </div>
      <ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Add Subnet" busy={busy} />
    </ModalShell>
  );
}

function AddVlanModal({ sites, onClose, onSaved }: { sites: Site[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ vlan_id: '', name: '', description: '', site: '' });
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.vlan_id.trim()) { toast('VLAN ID is required', 'error'); return; }
    setBusy(true);
    try {
      await api('/ipam/vlans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      toast('VLAN added', 'success');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title="Add VLAN" subtitle="Register a VLAN in the IPAM directory" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="VLAN ID"><input value={form.vlan_id} onChange={e => set('vlan_id', e.target.value)} style={INPUT} placeholder="100" /></Field>
        <Field label="Name"><input value={form.name} onChange={e => set('name', e.target.value)} style={INPUT} placeholder="Servers" /></Field>
        <Field label="Description" full><input value={form.description} onChange={e => set('description', e.target.value)} style={INPUT} /></Field>
        <Field label="Site (from NetVault)" full><SiteSelect value={form.site} onChange={v => set('site', v)} sites={sites} /></Field>
      </div>
      <ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Add VLAN" busy={busy} />
    </ModalShell>
  );
}

function ReserveModal({ ip, onClose, onConfirm }: {
  ip: string; onClose: () => void; onConfirm: (description: string, owner: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ description: '', owner: '' });
  const submit = async () => {
    setBusy(true);
    try { await onConfirm(form.description, form.owner); }
    finally { setBusy(false); }
  };
  return (
    <ModalShell title={`Reserve ${ip}`} subtitle="Mark this address as statically reserved" onClose={onClose}>
      <Field label="Purpose / Description">
        <input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} style={INPUT} placeholder="e.g. Printer, Server, Gateway" autoFocus />
      </Field>
      <Field label="Owner">
        <input value={form.owner} onChange={e => setForm(p => ({ ...p, owner: e.target.value }))} style={INPUT} placeholder="e.g. IT Team, John Smith" />
      </Field>
      <ModalFooter onCancel={onClose} onConfirm={submit} confirmLabel="Reserve IP" busy={busy} />
    </ModalShell>
  );
}

// ════════════════════════════════════════════════════════════
// Tree subnet row (module scope)
// ════════════════════════════════════════════════════════════
function SubnetRow({ subnet, onView, onScan, onDelete }: {
  subnet: Subnet; onView: () => void; onScan: () => void; onDelete: () => void;
}) {
  const total   = subnet.total_hosts || totalHosts(subnet.prefix_length);
  const used    = subnet.used_hosts || 0;
  const unknown = subnet.unknown_hosts || 0;

  return (
    <div
      onClick={onView}
      style={{
        padding: '10px 16px 10px 44px', display: 'flex', alignItems: 'center', gap: 12,
        cursor: 'pointer', borderBottom: '1px solid var(--border-light)', transition: 'background 0.12s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-primary)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', flexShrink: 0 }} />
      <div style={{ minWidth: 170 }}>
        <div style={{ ...MONO, fontSize: 13, fontWeight: 600 }}>{subnet.network}/{subnet.prefix_length}</div>
        {subnet.name && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{subnet.name}</div>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 110 }}>{subnet.site || ''}</div>
      {subnet.vlan_id ? <span className="badge badge-blue">VLAN {subnet.vlan_id}</span> : null}
      <div style={{ flex: 1, minWidth: 120 }}><UtilBar pct={utilPct(used, total)} /></div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 92, textAlign: 'right', ...MONO }}>{used}/{total}</div>
      {unknown > 0 && <span className="badge badge-orange" style={{ minWidth: 70, justifyContent: 'center' }}>⚠ {unknown}</span>}
      <div style={{ fontSize: 11, color: subnet.scan_status === 'error' ? 'var(--red)' : 'var(--text-muted)', minWidth: 96 }}>
        {scanLabel(subnet.scan_status, subnet.last_scanned)}
      </div>
      <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
        <button onClick={onScan} style={{ fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Scan</button>
        <button onClick={onDelete} style={{ fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Del</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Subnet detail (full-screen overlay) — module scope
// ════════════════════════════════════════════════════════════
function SubnetDetail({ subnet, onClose }: { subnet: Subnet; onClose: () => void }) {
  const [addresses, setAddresses] = useState<IPAddress[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState('');
  const [statusFilter, setStatus] = useState('');
  const [scanning, setScanning]   = useState(false);
  const [reserveIp, setReserveIp] = useState<string | null>(null);
  const { toast } = useToast();
  useEscape(onClose);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api(`/ipam/subnets/${subnet.id}/addresses${statusFilter ? `?status=${statusFilter}` : ''}`);
      setAddresses(d.data || []);
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setLoading(false); }
  }, [subnet.id, statusFilter, toast]);

  useEffect(() => { load(); }, [load]);

  // Poll scan-status while scanning
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(async () => {
      const d = await api(`/ipam/subnets/${subnet.id}/scan-status`).catch(() => null);
      if (d && !d.scanning) {
        setScanning(false);
        toast('Scan complete', 'success');
        load();
      }
    }, 3000);
    return () => clearInterval(t);
  }, [scanning, subnet.id, toast, load]);

  const startScan = async () => {
    setScanning(true);
    toast(`Scanning ${subnet.network}/${subnet.prefix_length}...`, 'info');
    try { await api(`/ipam/subnets/${subnet.id}/scan`, { method: 'POST' }); }
    catch (e: any) { toast(e.message, 'error'); setScanning(false); }
  };

  const nextIp = async () => {
    const d = await api(`/ipam/subnets/${subnet.id}/next-ip`).catch(() => null);
    if (d?.available) toast(`Next available IP: ${d.ip}`, 'success');
    else toast('Subnet is full', 'error');
  };

  const doReserve = async (description: string, owner: string) => {
    if (!reserveIp) return;
    try {
      await api(`/ipam/subnets/${subnet.id}/addresses/${reserveIp}/reserve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, owner, reserved_by: 'admin' }),
      });
      toast(`${reserveIp} reserved`, 'success');
      setReserveIp(null);
      load();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const release = async (ip: string) => {
    if (!confirm(`Release reservation for ${ip}?`)) return;
    try {
      await api(`/ipam/subnets/${subnet.id}/addresses/${ip}/release`, { method: 'POST' });
      toast(`${ip} released`, 'info');
      load();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const counts = useMemo(() => addresses.reduce((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1; return acc;
  }, {} as Record<string, number>), [addresses]);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    return addresses.filter(a => !q ||
      a.ip_address?.includes(q) ||
      a.hostname?.toLowerCase().includes(q) ||
      a.mac_address?.toLowerCase().includes(q));
  }, [addresses, filter]);

  const supLabel = subnet.supernet_network
    ? `${subnet.supernet_network}/${subnet.supernet_prefix}`
    : 'Unassigned';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)', zIndex: 200, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ background: 'var(--navy)', padding: '12px 24px', flexShrink: 0 }}>
        <div style={{ marginBottom: 8 }}>
          <Breadcrumb items={[
            { label: 'IPAM', onClick: onClose },
            { label: supLabel },
            { label: `${subnet.network}/${subnet.prefix_length}` },
          ]} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>
              {subnet.name || `${subnet.network}/${subnet.prefix_length}`}
            </div>
            <div style={{ ...MONO, color: 'rgba(255,255,255,0.55)', fontSize: 11 }}>
              {subnet.network}/{subnet.prefix_length} · {subnet.gateway ? `GW ${subnet.gateway}` : 'No gateway'}
              {subnet.site ? ` · ${subnet.site}` : ''}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {Object.entries(counts).map(([s, n]) => (
            <div key={s} style={{
              padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
              background: STATUS_TINT[s] || 'rgba(255,255,255,0.08)',
              border: `1px solid ${STATUS_COLOR[s] || 'var(--text-muted)'}55`,
              color: '#fff',
            }}>
              <span style={{ color: STATUS_COLOR[s] || '#fff', filter: 'brightness(1.6)' }}>●</span> {n} {s}
            </div>
          ))}
          <button className="btn" onClick={nextIp} style={{ fontSize: 12 }}>Next Available IP</button>
          <button className="btn btn-primary" onClick={startScan} disabled={scanning} style={{ opacity: scanning ? 0.7 : 1 }}>
            {scanning ? <><Spinner color="#fff" /> Scanning…</> : '⟳ Scan Now'}
          </button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ padding: '12px 24px', display: 'flex', gap: 10, alignItems: 'center', background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <input className="input" placeholder="Search IP, hostname, MAC…" value={filter} onChange={e => setFilter(e.target.value)} style={{ ...INPUT, width: 300 }} />
        <select value={statusFilter} onChange={e => setStatus(e.target.value)} style={{ ...INPUT, width: 160 }}>
          <option value="">All statuses</option>
          <option value="available">Available</option>
          <option value="dhcp">DHCP</option>
          <option value="reserved">Reserved</option>
          <option value="unknown">Unknown</option>
          <option value="offline">Offline</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {filtered.length} / {addresses.length} IPs
          {subnet.last_scanned ? ` · Last scanned ${fmtDate(subnet.last_scanned)}` : ''}
        </span>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px' }}>
        {loading ? (
          <div style={{ marginTop: 12 }}><TableSkeleton rows={10} cols={7} /></div>
        ) : addresses.length === 0 ? (
          <EmptyState
            icon="🛰"
            title="No addresses yet"
            message="Run a scan to discover live hosts, DHCP leases and free addresses in this subnet."
            actionLabel="Scan Now"
            onAction={startScan}
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon="🔍" title="No results" message="No addresses match your search or filter." />
        ) : (
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>IP Address</th>
                <th>Status</th>
                <th>Hostname</th>
                <th>MAC</th>
                <th>Last Seen</th>
                <th>Ping (ms)</th>
                <th>Description / Owner</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(addr => (
                <tr key={addr.ip_address} style={{ background: STATUS_TINT[addr.status] || 'transparent' }}>
                  <td style={{ ...TD, ...MONO, fontWeight: 600 }}>{addr.ip_address}</td>
                  <td style={TD}><span className={`badge ${STATUS_BADGE[addr.status] || 'badge-gray'}`}>{addr.status}</span></td>
                  <td style={TD}>{addr.hostname || '—'}</td>
                  <td style={{ ...TD, ...MONO, fontSize: 11 }}>{addr.mac_address || '—'}</td>
                  <td style={{ ...TD, fontSize: 11 }}>{fmtDate(addr.last_seen)}</td>
                  <td style={TD}>{addr.ping_ms != null ? `${addr.ping_ms}` : '—'}</td>
                  <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>
                    {addr.description || ''}{addr.owner ? ` (${addr.owner})` : ''}
                    {addr.is_reserved && addr.reserved_by ? <span style={{ color: 'var(--purple)', marginLeft: 4 }}>· {addr.reserved_by}</span> : ''}
                  </td>
                  <td style={TD}>
                    {addr.is_reserved ? (
                      <button onClick={() => release(addr.ip_address)} style={{ fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Release</button>
                    ) : (addr.status === 'available' || addr.status === 'unknown') ? (
                      <button onClick={() => setReserveIp(addr.ip_address)} style={{ fontSize: 11, color: 'var(--purple)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Reserve</button>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {reserveIp && <ReserveModal ip={reserveIp} onClose={() => setReserveIp(null)} onConfirm={doReserve} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════
type View = 'tree' | 'flat' | 'vlans';
type SortKey = 'network' | 'name' | 'used' | 'unknown' | 'util';

export default function IPAMTab() {
  const { toast } = useToast();

  const [supernets, setSupernets] = useState<Supernet[]>([]);
  const [subnets, setSubnets]     = useState<Subnet[]>([]);
  const [vlans, setVlans]         = useState<Vlan[]>([]);
  const [sites, setSites]         = useState<Site[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading]     = useState(true);

  const [view, setView]           = useState<View>('tree');
  const [expanded, setExpanded]   = useState<Set<number>>(new Set());
  const [selectedSubnet, setSelectedSubnet] = useState<Subnet | null>(null);

  const [showImport, setShowImport]       = useState(false);
  const [showAddSupernet, setAddSupernet] = useState(false);
  const [showAddVlan, setAddVlan]         = useState(false);
  const [addSubnetFor, setAddSubnetFor]   = useState<number | null>(null);  // supernet id (null = unassigned/any)
  const [showAddSubnet, setShowAddSubnet] = useState(false);

  const [nextSubnetResult, setNextSubnetResult] = useState<Record<number, string>>({});
  const [prefixSel, setPrefixSel] = useState<Record<number, number>>({});

  const [scanStatus, setScanStatus] = useState<any>(null);
  const [prevActive, setPrevActive] = useState<number | null>(null);

  // ── Load ──────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    const [sn, sub, vl, si, cf] = await Promise.allSettled([
      api('/ipam/supernets'),
      api('/ipam/subnets'),
      api('/ipam/vlans'),
      api('/sites'),
      api('/ipam/conflicts'),
    ]);
    if (sn.status  === 'fulfilled') setSupernets(sn.value.data || []);
    if (sub.status === 'fulfilled') setSubnets(sub.value.data || []);
    if (vl.status  === 'fulfilled') setVlans(vl.value.data || []);
    if (si.status  === 'fulfilled') setSites(si.value.data || []);
    if (cf.status  === 'fulfilled') setConflicts(cf.value.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useRefreshKey(loadAll);

  // ── Global scan poll ──────────────────────────────────────
  useEffect(() => {
    const check = async () => {
      const d = await api('/ipam/scan-status').catch(() => null);
      if (d) setScanStatus(d);
    };
    check();
    const t = setInterval(check, 3000);
    return () => clearInterval(t);
  }, []);

  // Reload when scans finish
  useEffect(() => {
    if (!scanStatus) return;
    const active = scanStatus.active_scans ?? 0;
    if (prevActive !== null && prevActive > 0 && active === 0) loadAll();
    setPrevActive(active);
  }, [scanStatus, prevActive, loadAll]);

  // ── Mutations ─────────────────────────────────────────────
  const deleteSupernet = async (id: number) => {
    if (!confirm('Delete supernet? Subnets will be unlinked but not deleted.')) return;
    try { await api(`/ipam/supernets/${id}`, { method: 'DELETE' }); toast('Supernet deleted', 'info'); loadAll(); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  const deleteSubnet = async (id: number) => {
    if (!confirm('Delete subnet? All IP address data will be removed.')) return;
    try { await api(`/ipam/subnets/${id}`, { method: 'DELETE' }); toast('Subnet deleted', 'info'); loadAll(); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  const deleteVlan = async (id: number) => {
    if (!confirm('Delete this VLAN?')) return;
    try { await api(`/ipam/vlans/${id}`, { method: 'DELETE' }); toast('VLAN deleted', 'info'); loadAll(); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  const scanSubnet = async (s: Subnet) => {
    try {
      await api(`/ipam/subnets/${s.id}/scan`, { method: 'POST' });
      toast(`Scan started for ${s.network}/${s.prefix_length}`, 'success');
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const scanAll = async () => {
    try { await api('/ipam/scan-all', { method: 'POST' }); toast('Full IPAM scan started', 'info'); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  const findNextSubnet = async (sn: Supernet) => {
    const prefix = prefixSel[sn.id] || 24;
    const d = await api(`/ipam/supernets/${sn.id}/next-subnet?prefix=${prefix}`).catch(() => null);
    setNextSubnetResult(p => ({ ...p, [sn.id]: d?.available ? `${d.subnet}/${prefix}` : 'None available' }));
    if (d?.available) toast(`Next free /${prefix}: ${d.subnet}`, 'success');
    else toast('No free subnet available', 'error');
  };

  const toggleExpanded = (id: number) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const openAddSubnet = (supernetId: number | null) => { setAddSubnetFor(supernetId); setShowAddSubnet(true); };

  // ── Derived ───────────────────────────────────────────────
  const orphanSubnets = useMemo(() => subnets.filter(s => !s.supernet_id), [subnets]);
  const totalIPs   = useMemo(() => subnets.reduce((a, s) => a + (s.total_hosts || 0), 0), [subnets]);
  const totalUnknown = useMemo(() => subnets.reduce((a, s) => a + (s.unknown_hosts || 0), 0), [subnets]);

  // ── Subnet detail overlay ─────────────────────────────────
  if (selectedSubnet) {
    return <SubnetDetail subnet={selectedSubnet} onClose={() => { setSelectedSubnet(null); loadAll(); }} />;
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="IPAM"
        subtitle="Hierarchical IP address management — supernets, subnets, and live address utilization"
      >
        <div className="segmented">
          {(['tree', 'flat', 'vlans'] as View[]).map(v => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {v === 'tree' ? 'Tree' : v === 'flat' ? 'All Subnets' : 'VLANs'}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => setShowImport(true)}>Import CSV</button>
        <button className="btn" onClick={() => setAddSupernet(true)}>+ Supernet</button>
        <button className="btn" onClick={() => openAddSubnet(null)}>+ Subnet</button>
        <button className="btn btn-primary" onClick={scanAll}>⟳ Scan All</button>
      </PageHeader>

      {/* ── CONFLICT BANNER ── */}
      {conflicts.length > 0 && (
        <div style={{
          background: 'rgba(220,38,38,0.08)', borderLeft: '4px solid var(--red)',
          border: '1px solid rgba(220,38,38,0.3)', borderRadius: 'var(--radius)', padding: '14px 18px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 16 }}>⚠</span>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--red)' }}>
              {conflicts.length} overlapping subnet{conflicts.length > 1 ? 's' : ''} detected
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {conflicts.map((c, i) => (
              <div key={i} style={{
                ...MONO, fontSize: 12, fontWeight: 600, color: 'var(--red)',
                background: 'var(--bg-card)', border: '1px solid rgba(220,38,38,0.3)',
                borderRadius: 'var(--radius-sm)', padding: '5px 10px',
              }}>
                {c.network_a}/{c.prefix_a} ⇄ {c.network_b}/{c.prefix_b}
                {(c.site_a || c.site_b) && (
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6, fontFamily: 'inherit' }}>
                    ({c.site_a || '—'} / {c.site_b || '—'})
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── KPI tiles ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        {[
          { label: 'Supernets',     value: supernets.length, color: 'var(--navy)' },
          { label: 'Subnets',       value: subnets.length,   color: 'var(--blue)' },
          { label: 'Total IPs',     value: totalIPs,         color: 'var(--purple)' },
          { label: 'Unknown Hosts', value: totalUnknown,     color: totalUnknown > 0 ? 'var(--orange)' : 'var(--green)' },
        ].map((t, i) => (
          <div key={i} className="kpi-card" style={{ borderLeftColor: t.color }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: t.color }}>
              {loading ? <Skeleton height={28} width={60} /> : t.value.toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{t.label}</div>
          </div>
        ))}
      </div>

      {/* ── Active scan progress ── */}
      {scanStatus && scanStatus.active_scans > 0 && (
        <div style={{
          background: 'var(--primary-light)', border: '1px solid var(--border)',
          borderLeft: '4px solid var(--primary)', borderRadius: 'var(--radius)', padding: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--primary)', animation: 'pulse 1s infinite' }} />
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--primary)' }}>
              Scanning {scanStatus.active_scans} subnet{scanStatus.active_scans > 1 ? 's' : ''}…
            </div>
          </div>
          {scanStatus.subnets?.filter((s: any) => s.scan_status === 'scanning').map((s: any) => {
            const total = s.total_hosts || 1;
            const scanned = (s.used_hosts || 0) + (s.free_hosts || 0) + (s.unknown_hosts || 0);
            const pct = Math.min(100, Math.round((scanned / total) * 100));
            return (
              <div key={s.id} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ ...MONO, fontSize: 12, fontWeight: 600 }}>{s.network}/{s.prefix_length}{s.name ? ` — ${s.name}` : ''}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{scanned} / {total} hosts · {pct}%</span>
                </div>
                <div className="util-track"><div className="util-fill" style={{ width: `${pct}%`, background: 'var(--primary)' }} /></div>
                <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11 }}>
                  <span style={{ color: 'var(--blue)' }}>● {s.used_hosts || 0} DHCP</span>
                  <span style={{ color: 'var(--green)' }}>● {s.free_hosts || 0} free</span>
                  <span style={{ color: 'var(--orange)' }}>● {s.unknown_hosts || 0} unknown</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Recently completed scan results ── */}
      {scanStatus && scanStatus.active_scans === 0 && scanStatus.subnets?.some((s: any) => s.scan_status === 'done' && s.last_scanned) && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Last Scan Results</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {scanStatus.subnets?.filter((s: any) => s.scan_status === 'done' && s.last_scanned).map((s: any) => (
              <div key={s.id} style={{ padding: '6px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', fontSize: 11 }}>
                <div style={{ ...MONO, fontWeight: 600 }}>{s.network}/{s.prefix_length}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                  {s.used_hosts}/{s.total_hosts || 0} used · {s.unknown_hosts > 0
                    ? <span style={{ color: 'var(--orange)' }}>⚠ {s.unknown_hosts} unknown</span>
                    : <span style={{ color: 'var(--green)' }}>✓ clean</span>}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{fmtDate(s.last_scanned)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Body ── */}
      {loading ? (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <TableSkeleton rows={8} cols={6} />
        </div>
      ) : view === 'tree' ? (
        <TreeView
          supernets={supernets} subnets={subnets} orphanSubnets={orphanSubnets}
          expanded={expanded} onToggle={toggleExpanded}
          onViewSubnet={setSelectedSubnet} onScanSubnet={scanSubnet} onDeleteSubnet={deleteSubnet}
          onAddSubnet={openAddSubnet} onDeleteSupernet={deleteSupernet}
          prefixSel={prefixSel} setPrefixSel={setPrefixSel}
          nextSubnetResult={nextSubnetResult} onFindNextSubnet={findNextSubnet}
        />
      ) : view === 'flat' ? (
        <FlatView subnets={subnets} onView={setSelectedSubnet} onScan={scanSubnet} onDelete={deleteSubnet} />
      ) : (
        <VlanView vlans={vlans} subnets={subnets} onAdd={() => setAddVlan(true)} onDelete={deleteVlan} />
      )}

      {/* ── MODALS ── */}
      {showImport && <IPAMImport onDone={() => { setShowImport(false); loadAll(); }} />}
      {showAddSupernet && <AddSupernetModal sites={sites} onClose={() => setAddSupernet(false)} onSaved={loadAll} />}
      {showAddSubnet && (
        <AddSubnetModal
          sites={sites} supernets={supernets} defaultSupernetId={addSubnetFor}
          onClose={() => setShowAddSubnet(false)} onSaved={loadAll}
        />
      )}
      {showAddVlan && <AddVlanModal sites={sites} onClose={() => setAddVlan(false)} onSaved={loadAll} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TREE VIEW (module scope)
// ════════════════════════════════════════════════════════════
function TreeView({
  supernets, subnets, orphanSubnets, expanded, onToggle,
  onViewSubnet, onScanSubnet, onDeleteSubnet, onAddSubnet, onDeleteSupernet,
  prefixSel, setPrefixSel, nextSubnetResult, onFindNextSubnet,
}: {
  supernets: Supernet[]; subnets: Subnet[]; orphanSubnets: Subnet[];
  expanded: Set<number>; onToggle: (id: number) => void;
  onViewSubnet: (s: Subnet) => void; onScanSubnet: (s: Subnet) => void; onDeleteSubnet: (id: number) => void;
  onAddSubnet: (supernetId: number | null) => void; onDeleteSupernet: (id: number) => void;
  prefixSel: Record<number, number>; setPrefixSel: (f: (p: Record<number, number>) => Record<number, number>) => void;
  nextSubnetResult: Record<number, string>; onFindNextSubnet: (sn: Supernet) => void;
}) {
  const CARD: React.CSSProperties = {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
  };

  if (supernets.length === 0 && orphanSubnets.length === 0) {
    return (
      <div style={CARD}>
        <EmptyState
          icon="🗂"
          title="No networks configured yet"
          message="Add a Supernet (e.g. 10.0.0.0/8) then add Subnets under it to begin managing your IP space."
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {supernets.map(sn => {
        const children  = subnets.filter(s => s.supernet_id === sn.id);
        const isOpen    = expanded.has(sn.id);
        const totalUsed = children.reduce((a, s) => a + (s.used_hosts || 0), 0);
        const totalAll  = children.reduce((a, s) => a + (s.total_hosts || 0), 0);
        const prefix    = prefixSel[sn.id] || 24;

        return (
          <div key={sn.id} style={CARD}>
            {/* Supernet header */}
            <div
              onClick={() => onToggle(sn.id)}
              style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', borderBottom: isOpen ? '1px solid var(--border)' : 'none' }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-muted)', display: 'inline-block', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--navy)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                  {sn.name || `${sn.network}/${sn.prefix_length}`}
                  <span style={{ ...MONO, fontSize: 12, color: 'var(--text-muted)', marginLeft: 10, fontWeight: 400 }}>{sn.network}/{sn.prefix_length}</span>
                </div>
                {sn.site && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sn.site}</div>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 80 }}>{children.length} subnets</div>
              {totalAll > 0 && <div style={{ width: 200 }}><UtilBar pct={utilPct(totalUsed, totalAll)} /></div>}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                <button className="btn" style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => onAddSubnet(sn.id)}>+ Subnet</button>
                <select
                  value={prefix}
                  onChange={e => setPrefixSel(p => ({ ...p, [sn.id]: parseInt(e.target.value) }))}
                  style={{ fontSize: 11, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }}
                >
                  {PREFIX_OPTIONS.map(p => <option key={p} value={p}>/{p}</option>)}
                </select>
                <button className="btn" style={{ fontSize: 11, padding: '4px 9px' }} onClick={() => onFindNextSubnet(sn)}>Next Free</button>
                {nextSubnetResult[sn.id] && (
                  <span style={{ ...MONO, fontSize: 11, color: 'var(--blue)', fontWeight: 600 }}>{nextSubnetResult[sn.id]}</span>
                )}
                <button onClick={() => onDeleteSupernet(sn.id)} style={{ fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
              </div>
            </div>

            {/* Children */}
            {isOpen && children.map(sub => (
              <SubnetRow key={sub.id} subnet={sub} onView={() => onViewSubnet(sub)} onScan={() => onScanSubnet(sub)} onDelete={() => onDeleteSubnet(sub.id)} />
            ))}
            {isOpen && children.length === 0 && (
              <div style={{ padding: '16px 48px', color: 'var(--text-muted)', fontSize: 13 }}>
                No subnets yet — click + Subnet to add one
              </div>
            )}
          </div>
        );
      })}

      {/* Unassigned */}
      {orphanSubnets.length > 0 && (
        <div style={CARD}>
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-muted)' }} />
            Unassigned Subnets <span style={{ fontWeight: 400 }}>({orphanSubnets.length})</span>
          </div>
          {orphanSubnets.map(sub => (
            <SubnetRow key={sub.id} subnet={sub} onView={() => onViewSubnet(sub)} onScan={() => onScanSubnet(sub)} onDelete={() => onDeleteSubnet(sub.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// FLAT VIEW (sortable) — module scope
// ════════════════════════════════════════════════════════════
function ipToNum(ip: string): number {
  const p = (ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return 0;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function FlatView({ subnets, onView, onScan, onDelete }: {
  subnets: Subnet[]; onView: (s: Subnet) => void; onScan: (s: Subnet) => void; onDelete: (id: number) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('network');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };

  const sorted = useMemo(() => {
    const arr = [...subnets];
    arr.sort((a, b) => {
      let va: number | string, vb: number | string;
      switch (sortKey) {
        case 'name':    va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'used':    va = a.used_hosts || 0; vb = b.used_hosts || 0; break;
        case 'unknown': va = a.unknown_hosts || 0; vb = b.unknown_hosts || 0; break;
        case 'util':
          va = utilPct(a.used_hosts || 0, a.total_hosts || totalHosts(a.prefix_length));
          vb = utilPct(b.used_hosts || 0, b.total_hosts || totalHosts(b.prefix_length));
          break;
        default:        va = ipToNum(a.network); vb = ipToNum(b.network); break;
      }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [subnets, sortKey, sortDir]);

  const arrow = (k: SortKey) => sortKey === k ? <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span> : null;
  const SH = (k: SortKey, label: string) => (
    <th className="th-sortable" onClick={() => toggleSort(k)}>{label}{arrow(k)}</th>
  );

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      {subnets.length === 0 ? (
        <EmptyState icon="📋" title="No subnets configured" message="Add subnets in the Tree view or import them from CSV." />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              {SH('network', 'Network')}
              {SH('name', 'Name')}
              <th>Supernet</th>
              <th>Gateway</th>
              <th>VLAN</th>
              <th>Site</th>
              {SH('used', 'Used / Total')}
              {SH('util', 'Utilization')}
              {SH('unknown', 'Unknown')}
              <th>Scan</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(sub => {
              const total = sub.total_hosts || totalHosts(sub.prefix_length);
              return (
                <tr key={sub.id} className="clickable" onClick={() => onView(sub)}>
                  <td style={{ ...TD, ...MONO, fontWeight: 600 }}>{sub.network}/{sub.prefix_length}</td>
                  <td style={TD}>{sub.name || '—'}</td>
                  <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>{sub.supernet_name || (sub.supernet_network ? `${sub.supernet_network}/${sub.supernet_prefix}` : '—')}</td>
                  <td style={{ ...TD, ...MONO, fontSize: 11 }}>{sub.gateway || '—'}</td>
                  <td style={TD}>{sub.vlan_id ? <span className="badge badge-blue">{sub.vlan_id}</span> : '—'}</td>
                  <td style={TD}>{sub.site || '—'}</td>
                  <td style={{ ...TD, ...MONO }}>{sub.used_hosts || 0} / {total}</td>
                  <td style={{ ...TD, minWidth: 150 }}><UtilBar pct={utilPct(sub.used_hosts || 0, total)} /></td>
                  <td style={TD}>{sub.unknown_hosts > 0
                    ? <span className="badge badge-orange">{sub.unknown_hosts}</span>
                    : <span style={{ color: 'var(--green)' }}>0</span>}</td>
                  <td style={{ ...TD, fontSize: 11, color: sub.scan_status === 'error' ? 'var(--red)' : 'var(--text-muted)' }}>
                    {scanLabel(sub.scan_status, sub.last_scanned)}
                  </td>
                  <td style={TD} onClick={e => e.stopPropagation()}>
                    <button onClick={() => onScan(sub)} style={{ fontSize: 11, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Scan</button>
                    <button onClick={() => onDelete(sub.id)} style={{ fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 8 }}>Del</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// VLAN VIEW (module scope)
// ════════════════════════════════════════════════════════════
function VlanView({ vlans, subnets, onAdd, onDelete }: {
  vlans: Vlan[]; subnets: Subnet[]; onAdd: () => void; onDelete: (id: number) => void;
}) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 600 }}>VLAN Registry</div>
        <button className="btn btn-primary" onClick={onAdd}>+ Add VLAN</button>
      </div>
      {vlans.length === 0 ? (
        <EmptyState icon="🏷" title="No VLANs configured" message="Add a VLAN to track it across your subnets." actionLabel="Add VLAN" onAction={onAdd} />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>VLAN ID</th><th>Name</th><th>Description</th><th>Site</th><th>Subnets</th><th></th>
            </tr>
          </thead>
          <tbody>
            {vlans.map(v => (
              <tr key={v.id}>
                <td style={{ ...TD, ...MONO, fontWeight: 700 }}>VLAN {v.vlan_id}</td>
                <td style={TD}>{v.name || '—'}</td>
                <td style={{ ...TD, color: 'var(--text-muted)' }}>{v.description || '—'}</td>
                <td style={TD}>{v.site || '—'}</td>
                <td style={TD}>{subnets.filter(s => s.vlan_id === v.vlan_id).length}</td>
                <td style={TD}>
                  <button onClick={() => onDelete(v.id)} style={{ fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
