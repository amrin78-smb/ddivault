'use client';

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
import IPAMImport from '@/components/IPAMImport';
import {
  PageHeader, EmptyState, TableSkeleton, Breadcrumb,
  UtilBar, Spinner, useRefreshKey, useEscape,
} from '@/components/ui';
import { IpamKpiTiles } from '@/components/ipam/IpamKpiTiles';
import { IpamDonut } from '@/components/ipam/IpamDonut';
import { IpamTrendChart, TrendPoint } from '@/components/ipam/IpamTrendChart';
import { IpamTopSubnets, TopSubnet } from '@/components/ipam/IpamTopSubnets';

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
  site_id?: number | null;
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
  site_id?: number | null;
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
  is_sensitive?: boolean;
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
  device_type?: string;
  device_vendor?: string;
  risk_level?: string;
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
  color: 'var(--text-primary)', fontSize: 'var(--text-base)', fontFamily: 'inherit', outline: 'none',
};

const TD: React.CSSProperties = { padding: '9px 14px', fontSize: 'var(--text-base)', color: 'var(--text-primary)' };
const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)' };

function fmtDate(d?: string) { return d ? new Date(d).toLocaleString() : '—'; }
function fmtDay(d?: string)  { return d ? new Date(d).toLocaleDateString() : '—'; }

function scanLabel(status: string, last_scanned?: string) {
  if (status === 'scanning') return '⟳ Scanning';
  if (status === 'done' && last_scanned) return `✓ ${fmtDay(last_scanned)}`;
  if (status === 'error') return '⚠ Error';
  return 'Not scanned';
}

const cleanNetwork = (network: string) => (network || '').replace(/\/\d+$/, '');

const DEVICE_ICONS: Record<string, string> = {
  mobile: '📱', workstation: '💻', network: '🔌', printer: '🖨️', voip: '📞', unknown: '❓',
};
const deviceIcon = (t?: string) => DEVICE_ICONS[t || 'unknown'] || '';

function scanEta(progressPct: number, elapsedSeconds: number): string {
  if (!progressPct || progressPct <= 0 || progressPct >= 100) return '';
  const total = elapsedSeconds / (progressPct / 100);
  const remaining = Math.max(0, Math.round(total - elapsedSeconds));
  return `~${remaining}s remaining`;
}

function ScanProgressBar({ job }: { job: any }) {
  const total = job.total_hosts || 0;
  const scanned = job.hosts_scanned || 0;
  const pct = job.progress_pct != null ? Number(job.progress_pct) : (total ? Math.round((scanned / total) * 100) : 0);
  const eta = scanEta(pct, job.elapsed_seconds || 0);
  return (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-light)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>🔍 Scanning {cleanNetwork(job.network)}/{job.prefix_length}{job.name ? ` — ${job.name}` : ''}</span>
        <span style={{ color: 'var(--text-muted)' }}>{pct}%</span>
      </div>
      <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: 'var(--primary)',
          transition: 'width 0.4s ease', animation: 'pulse 1.5s ease-in-out infinite',
        }} />
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 5, ...MONO }}>
        {scanned}/{total} hosts · {job.hosts_up || 0} alive · {job.elapsed_seconds || 0}s elapsed{eta ? ` · ${eta}` : ''}
      </div>
    </div>
  );
}

const siteName = (siteId: number | null | undefined, sites: Site[], fallback?: string): string => {
  if (siteId != null) {
    const s = sites.find(x => x.id === siteId);
    if (s) return s.name;
  }
  return fallback || '';
};

// IP <-> integer + usable host range for a network/prefix
function ipToInt(ip: string): number {
  const p = (ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return 0;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function ipRange(network: string, prefix: number): string {
  const base = ipToInt(cleanNetwork(network));
  if (!base && cleanNetwork(network) !== '0.0.0.0') return '—';
  const size = Math.pow(2, 32 - prefix);
  if (prefix >= 31) return `${intToIp(base)} – ${intToIp(base + size - 1)}`;
  return `${intToIp(base + 1)} – ${intToIp(base + size - 2)}`;
}

// Utilization → health status badge
function utilStatus(pct: number): { label: string; badge: string } {
  if (pct >= 90) return { label: 'Critical', badge: 'badge-red' };
  if (pct >= 80) return { label: 'Warning',  badge: 'badge-orange' };
  return { label: 'Healthy', badge: 'badge-green' };
}

// Relative "time ago" for Last Scanned
function relTime(d?: string): string {
  if (!d) return 'Never';
  const t = new Date(d).getTime();
  if (isNaN(t)) return 'Never';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24); if (days < 30) return `${days}d ago`;
  return fmtDay(d);
}

// ════════════════════════════════════════════════════════════
// Row actions ··· dropdown menu (module scope)
// ════════════════════════════════════════════════════════════
interface MenuItem { label: string; onClick: () => void; danger?: boolean }
function RowMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title="Actions"
        style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          cursor: 'pointer', fontSize: 'var(--text-lg)', lineHeight: 1, padding: '2px 8px', color: 'var(--text-muted)',
        }}
      >⋯</button>
      {open && (
        <>
          <div onClick={e => { e.stopPropagation(); setOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
          <div style={{
            position: 'absolute', right: 0, top: '100%', marginTop: 4, minWidth: 168, zIndex: 51,
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
          }}>
            {items.map((it, i) => (
              <button
                key={i}
                onClick={e => { e.stopPropagation(); setOpen(false); it.onClick(); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
                  fontSize: 'var(--text-sm)', background: 'none', border: 'none', cursor: 'pointer',
                  color: it.danger ? 'var(--red)' : 'var(--text-primary)',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-primary)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              >{it.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Field / Modal helpers (module scope)
// ════════════════════════════════════════════════════════════
function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div style={{ marginBottom: 10, ...(full ? { gridColumn: '1/-1' } : {}) }}>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>{label}</label>
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

function SiteIdSelect({ value, onChange, sites }: { value: string; onChange: (v: string) => void; sites: Site[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={INPUT}>
      <option value="">— No site —</option>
      {sites.map(s => (
        <option key={s.id} value={String(s.id)}>
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
            <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
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
  const [form, setForm] = useState({ network: '', prefix_length: '8', name: '', description: '', site_id: '' });
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.network.trim()) { toast('Network is required', 'error'); return; }
    setBusy(true);
    try {
      await api('/ipam/supernets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, site_id: form.site_id || null }),
      });
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
        <Field label="Site (from NetVault)" full><SiteIdSelect value={form.site_id} onChange={v => set('site_id', v)} sites={sites} /></Field>
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
    gateway: '', vlan_id: '', site_id: '', owner: '', location: '', notes: '',
  });
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.network.trim()) { toast('Network is required', 'error'); return; }
    setBusy(true);
    try {
      await api('/ipam/subnets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, site_id: form.site_id || null, supernet_id: supernetId }),
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
        <Field label="Site (from NetVault)" full><SiteIdSelect value={form.site_id} onChange={v => set('site_id', v)} sites={sites} /></Field>
        <Field label="Supernet (optional)" full>
          <select value={supernetId ?? ''} onChange={e => setSupernetId(e.target.value ? parseInt(e.target.value) : null)} style={INPUT}>
            <option value="">— Unassigned —</option>
            {supernets.map(sn => <option key={sn.id} value={sn.id}>{sn.name || `${cleanNetwork(sn.network)}/${sn.prefix_length}`} ({cleanNetwork(sn.network)}/{sn.prefix_length})</option>)}
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

function EditSupernetModal({ supernet, sites, onClose, onSaved }: {
  supernet: Supernet; sites: Site[]; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: supernet.name || '',
    description: supernet.description || '',
    site_id: supernet.site_id != null ? String(supernet.site_id) : '',
  });
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      await api(`/ipam/supernets/${supernet.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, description: form.description, site_id: form.site_id || null }),
      });
      toast('Supernet updated', 'success');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message || 'Update failed', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title={`Edit ${cleanNetwork(supernet.network)}/${supernet.prefix_length}`} subtitle="Update supernet details and site assignment" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Name"><input value={form.name} onChange={e => set('name', e.target.value)} style={INPUT} /></Field>
        <Field label="Description" full><input value={form.description} onChange={e => set('description', e.target.value)} style={INPUT} /></Field>
        <Field label="Site (from NetVault)" full><SiteIdSelect value={form.site_id} onChange={v => set('site_id', v)} sites={sites} /></Field>
      </div>
      <ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Save Changes" busy={busy} />
    </ModalShell>
  );
}

function EditSubnetModal({ subnet, sites, onClose, onSaved }: {
  subnet: Subnet; sites: Site[]; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: subnet.name || '',
    description: subnet.description || '',
    gateway: subnet.gateway || '',
    vlan_id: subnet.vlan_id ? String(subnet.vlan_id) : '',
    site_id: subnet.site_id != null ? String(subnet.site_id) : '',
    is_sensitive: subnet.is_sensitive ?? false,
  });
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      await api(`/ipam/subnets/${subnet.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name, description: form.description,
          site_id: form.site_id || null, gateway: form.gateway || null,
          vlan_id: form.vlan_id || null, is_sensitive: form.is_sensitive,
        }),
      });
      toast('Subnet updated', 'success');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message || 'Update failed', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title={`Edit ${cleanNetwork(subnet.network)}/${subnet.prefix_length}`} subtitle="Update subnet details and site assignment" width={620} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Name"><input value={form.name} onChange={e => set('name', e.target.value)} style={INPUT} /></Field>
        <Field label="Gateway IP"><input value={form.gateway} onChange={e => set('gateway', e.target.value)} style={INPUT} placeholder="192.168.1.1" /></Field>
        <Field label="VLAN ID"><input value={form.vlan_id} onChange={e => set('vlan_id', e.target.value)} style={INPUT} /></Field>
        <Field label="Description" full><input value={form.description} onChange={e => set('description', e.target.value)} style={INPUT} /></Field>
        <Field label="Site (from NetVault)" full><SiteIdSelect value={form.site_id} onChange={v => set('site_id', v)} sites={sites} /></Field>
        <Field label="Security" full>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
            <input
              type="checkbox"
              checked={form.is_sensitive}
              onChange={e => setForm(p => ({ ...p, is_sensitive: e.target.checked }))}
              style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--primary)' }}
            />
            🔒 Mark as Sensitive (extra monitoring — alerts on any new device)
          </label>
        </Field>
      </div>
      <ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Save Changes" busy={busy} />
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
// Subnet detail (full-screen overlay) — module scope
// ════════════════════════════════════════════════════════════
function SubnetDetail({ subnet, sites, onClose }: { subnet: Subnet; sites: Site[]; onClose: () => void }) {
  const [addresses, setAddresses] = useState<IPAddress[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState('');
  const [statusFilter, setStatus] = useState('');
  const [scanning, setScanning]   = useState(false);
  const [reserveIp, setReserveIp] = useState<string | null>(null);
  const [visible, setVisible]     = useState(false);
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  // Slide-in on mount; slide-out then close on dismiss
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const requestClose = useCallback(() => {
    setVisible(false);
    setTimeout(() => onClose(), 250);
  }, [onClose]);

  // ESC closes the panel (with slide-out animation)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

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
    toast(`Scanning ${cleanNetwork(subnet.network)}/${subnet.prefix_length}...`, 'info');
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
    ? `${cleanNetwork(subnet.supernet_network)}/${subnet.supernet_prefix}`
    : 'Unassigned';

  return (
    <>
      {/* Dimmed backdrop — click to close */}
      <div
        onClick={requestClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
          opacity: visible ? 1 : 0, transition: 'opacity 0.25s ease',
        }}
      />

      {/* Slide-over panel */}
      <div
        className="ipam-slideover"
        style={{
          position: 'fixed', top: 0, right: 0, height: '100vh', maxWidth: 1100,
          background: 'var(--bg-card)', zIndex: 1001, boxShadow: '-8px 0 24px rgba(0,0,0,0.15)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          transform: visible ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.25s ease',
        }}
      >
      {/* Header */}
      <div style={{ background: 'var(--navy)', padding: '12px 24px', flexShrink: 0 }}>
        <div style={{ marginBottom: 8 }}>
          <Breadcrumb light items={[
            { label: 'IPAM', onClick: requestClose },
            { label: supLabel },
            { label: `${cleanNetwork(subnet.network)}/${subnet.prefix_length}` },
          ]} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 'var(--text-lg)' }}>
              {subnet.name || `${cleanNetwork(subnet.network)}/${subnet.prefix_length}`}
            </div>
            <div style={{ ...MONO, color: 'rgba(255,255,255,0.5)', fontSize: 'var(--text-xs)' }}>
              {cleanNetwork(subnet.network)}/{subnet.prefix_length} · {subnet.gateway ? `GW ${subnet.gateway}` : 'No gateway'}
              {siteName(subnet.site_id, sites, subnet.site) ? ` · ${siteName(subnet.site_id, sites, subnet.site)}` : ''}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {Object.entries(counts).map(([s, n]) => (
            <div key={s} style={{
              padding: '3px 10px', borderRadius: 12, fontSize: 'var(--text-xs)', fontWeight: 600,
              background: STATUS_TINT[s] || 'rgba(255,255,255,0.08)',
              border: `1px solid ${STATUS_COLOR[s] || 'var(--text-muted)'}55`,
              color: '#fff',
            }}>
              <span style={{ color: STATUS_COLOR[s] || '#fff', filter: 'brightness(1.6)' }}>●</span> {n} {s}
            </div>
          ))}
          <button className="btn" onClick={nextIp} style={{ fontSize: 'var(--text-sm)' }}>Next Available IP</button>
          {canWrite && (
            <button className="btn btn-primary" onClick={startScan} disabled={scanning} style={{ opacity: scanning ? 0.7 : 1 }}>
              {scanning ? <><Spinner color="#fff" /> Scanning…</> : '⟳ Scan Now'}
            </button>
          )}
          <button className="btn" onClick={requestClose}>Close</button>
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
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          {filtered.length} / {addresses.length} IPs
          {subnet.last_scanned ? ` · Last scanned ${fmtDate(subnet.last_scanned)}` : ''}
        </span>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px' }}>
        {loading ? (
          <div style={{ marginTop: 12 }}><TableSkeleton rows={10} cols={9} /></div>
        ) : addresses.length === 0 ? (
          <EmptyState
            icon="🛰"
            title="No addresses yet"
            message="Run a scan to discover live hosts, DHCP leases and free addresses in this subnet."
            actionLabel={canWrite ? 'Scan Now' : undefined}
            onAction={canWrite ? startScan : undefined}
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon="🔍" title="No results" message="No addresses match your search or filter." />
        ) : (
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>IP Address</th>
                <th>Status</th>
                <th>Device</th>
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
                  <td style={{ ...TD, fontSize: 'var(--text-sm)' }}>
                    {addr.device_type || addr.device_vendor
                      ? <span>{deviceIcon(addr.device_type)} <span style={{ color: 'var(--text-muted)' }}>{addr.device_vendor || addr.device_type || ''}</span></span>
                      : '—'}
                  </td>
                  <td style={TD}>{addr.hostname || '—'}</td>
                  <td style={{ ...TD, ...MONO, fontSize: 'var(--text-xs)' }}>{addr.mac_address || '—'}</td>
                  <td style={{ ...TD, fontSize: 'var(--text-xs)' }}>{fmtDate(addr.last_seen)}</td>
                  <td style={TD}>{addr.ping_ms != null ? `${addr.ping_ms}` : '—'}</td>
                  <td style={{ ...TD, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {addr.description || ''}{addr.owner ? ` (${addr.owner})` : ''}
                    {addr.is_reserved && addr.reserved_by ? <span style={{ color: 'var(--purple)', marginLeft: 4 }}>· {addr.reserved_by}</span> : ''}
                  </td>
                  <td style={TD}>
                    {!canWrite ? '—'
                      : addr.is_reserved ? (
                      <button onClick={() => release(addr.ip_address)} style={{ fontSize: 'var(--text-xs)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Release</button>
                    ) : (addr.status === 'available' || addr.status === 'unknown') ? (
                      <button onClick={() => setReserveIp(addr.ip_address)} style={{ fontSize: 'var(--text-xs)', color: 'var(--purple)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Reserve</button>
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
    </>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════
type View = 'tree' | 'flat' | 'vlans';
type SortKey = 'network' | 'name' | 'used' | 'unknown' | 'util';

export default function IPAMTab() {
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

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
  const [editSupernet, setEditSupernet]   = useState<Supernet | null>(null);
  const [editSubnet, setEditSubnet]       = useState<Subnet | null>(null);

  const [nextSubnetResult, setNextSubnetResult] = useState<Record<number, string>>({});
  const [prefixSel, setPrefixSel] = useState<Record<number, number>>({});

  const [scanStatus, setScanStatus] = useState<any>(null);
  const [prevActive, setPrevActive] = useState<number | null>(null);
  const [syncing, setSyncing]       = useState(false);

  // Utilization history (trend chart)
  const [history, setHistory]             = useState<TrendPoint[]>([]);
  const [historyLoading, setHistoryLoad]  = useState(true);
  const [granularity, setGranularity]     = useState<'daily' | 'weekly'>('daily');

  // Filter bar
  const [search, setSearch]               = useState('');
  const [supernetFilter, setSupernetFilter] = useState<string>('all');   // 'all' | supernet id | 'unassigned'
  const [statusFilter, setStatusFilter]   = useState<'all' | 'healthy' | 'warning' | 'critical'>('all');

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

  // ── Utilization history ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setHistoryLoad(true);
    const days = granularity === 'weekly' ? 56 : 7;
    api(`/ipam/utilization-history?days=${days}`)
      .then(d => { if (!cancelled) setHistory(d.data || []); })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoad(false); });
    return () => { cancelled = true; };
  }, [granularity]);

  // ── Global scan poll ──────────────────────────────────────
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const check = async () => {
      const d = await api('/ipam/scan-status').catch(() => null);
      if (cancelled) return;
      let active = false;
      if (d) {
        setScanStatus(d);
        active = (d.active_scans ?? 0) > 0 || (d.jobs?.length ?? 0) > 0;
      }
      t = setTimeout(check, active ? 2000 : 6000);
    };
    check();
    return () => { cancelled = true; clearTimeout(t); };
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
      toast(`Scan started for ${cleanNetwork(s.network)}/${s.prefix_length}`, 'success');
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const scanAll = async () => {
    try { await api('/ipam/scan-all', { method: 'POST' }); toast('Full IPAM scan started', 'info'); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  const nextIpForSubnet = async (s: Subnet) => {
    const d = await api(`/ipam/subnets/${s.id}/next-ip`).catch(() => null);
    if (d?.available) toast(`Next available IP in ${cleanNetwork(s.network)}/${s.prefix_length}: ${d.ip}`, 'success');
    else toast('Subnet is full', 'error');
  };

  const syncFromDhcp = async () => {
    setSyncing(true);
    try {
      const d = await api('/ipam/sync-from-dhcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      }) as { created: number; updated: number; supernetsCreated: number; addressesSynced?: number };
      const addrPart = d.addressesSynced ? `, ${d.addressesSynced} addresses` : '';
      toast(`IPAM sync complete — ${d.created} created, ${d.updated} updated, ${d.supernetsCreated} supernet(s)${addrPart}`, 'success');
      loadAll();
    } catch (e: any) { toast(e.message || 'Sync failed', 'error'); }
    finally { setSyncing(false); }
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
  const usedIPs    = useMemo(() => subnets.reduce((a, s) => a + (s.used_hosts || 0), 0), [subnets]);
  const freeIPs    = useMemo(() => subnets.reduce((a, s) => a + (s.free_hosts || 0), 0), [subnets]);
  const totalUnknown = useMemo(() => subnets.reduce((a, s) => a + (s.unknown_hosts || 0), 0), [subnets]);

  const topSubnets: TopSubnet[] = useMemo(() =>
    subnets
      .map(s => {
        const total = s.total_hosts || totalHosts(s.prefix_length);
        return { id: s.id, label: `${cleanNetwork(s.network)}/${s.prefix_length}`, pct: utilPct(s.used_hosts || 0, total), used: s.used_hosts || 0, total };
      })
      .filter(s => s.total > 0)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5),
    [subnets]);

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="IPAM"
        subtitle="Hierarchical IP address management — supernets, subnets, and live address utilization"
      >
        <div className="segmented">
          <button className={view === 'tree' ? 'active' : ''} onClick={() => setView('tree')}>Tree</button>
          <button className={view === 'flat' ? 'active' : ''} onClick={() => setView('flat')}>All Subnets</button>
          <button
            disabled
            title="Coming Soon"
            style={{ opacity: 0.45, cursor: 'not-allowed' }}
          >VLANs</button>
        </div>
        {canWrite && <button className="btn" onClick={() => setShowImport(true)}>Import CSV</button>}
        {canWrite && (
          <button className="btn" onClick={syncFromDhcp} disabled={syncing} style={{ opacity: syncing ? 0.7 : 1 }}>
            {syncing ? <><Spinner /> Syncing…</> : 'Sync from DHCP'}
          </button>
        )}
        {canWrite && <button className="btn" onClick={() => setAddSupernet(true)}>+ Supernet</button>}
        {canWrite && <button className="btn" onClick={() => openAddSubnet(null)}>+ Subnet</button>}
        {canWrite && <button className="btn btn-primary" onClick={scanAll}>⟳ Scan All</button>}
      </PageHeader>

      <ReadOnlyBanner />

      {/* ── CONFLICT BANNER ── */}
      {conflicts.length > 0 && (
        <div style={{
          background: 'rgba(220,38,38,0.08)', borderLeft: '4px solid var(--red)',
          border: '1px solid rgba(220,38,38,0.3)', borderRadius: 'var(--radius)', padding: '14px 18px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 'var(--text-lg)' }}>⚠</span>
            <div style={{ fontWeight: 700, fontSize: 'var(--text-base)', color: 'var(--red)' }}>
              {conflicts.length} overlapping subnet{conflicts.length > 1 ? 's' : ''} detected
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {conflicts.map((c, i) => (
              <div key={i} style={{
                ...MONO, fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--red)',
                background: 'var(--bg-card)', border: '1px solid rgba(220,38,38,0.3)',
                borderRadius: 'var(--radius-sm)', padding: '5px 10px',
              }}>
                {cleanNetwork(c.network_a)}/{c.prefix_a} ⇄ {cleanNetwork(c.network_b)}/{c.prefix_b}
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
      <IpamKpiTiles
        supernetCount={supernets.length}
        subnetCount={subnets.length}
        totalIps={totalIPs}
        usedIps={usedIPs}
        freeIps={freeIPs}
        unknownHosts={totalUnknown}
        loading={loading}
      />

      {/* ── Middle row: donut · trend · top subnets ── */}
      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: '35fr 35fr 30fr', gap: 12, height: 220, minHeight: 0 }}>
          <IpamDonut used={usedIPs} free={freeIPs} total={totalIPs} />
          <IpamTrendChart data={history} granularity={granularity} onGranularityChange={setGranularity} loading={historyLoading} />
          <IpamTopSubnets subnets={topSubnets} onViewAll={() => setView('flat')} />
        </div>
      )}

      {/* ── Filter bar ── */}
      {!loading && view === 'tree' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '10px 14px',
        }}>
          <input
            placeholder="Search supernets or subnets…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...INPUT, width: 280 }}
          />
          <select value={supernetFilter} onChange={e => setSupernetFilter(e.target.value)} style={{ ...INPUT, width: 200 }}>
            <option value="all">All Supernets</option>
            {supernets.map(sn => (
              <option key={sn.id} value={String(sn.id)}>{sn.name || `${cleanNetwork(sn.network)}/${sn.prefix_length}`}</option>
            ))}
            {orphanSubnets.length > 0 && <option value="unassigned">Unassigned</option>}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} style={{ ...INPUT, width: 160 }}>
            <option value="all">All Status</option>
            <option value="healthy">Healthy</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {supernets.length} supernet{supernets.length === 1 ? '' : 's'} · {subnets.length} subnet{subnets.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* ── Active scan progress ── */}
      {scanStatus?.jobs?.length > 0 && (
        <div style={{
          background: 'var(--primary-light)', border: '1px solid var(--border)',
          borderLeft: '4px solid var(--primary)', borderRadius: 'var(--radius)', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 14px 10px' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--primary)', animation: 'pulse 1s infinite' }} />
            <div style={{ fontWeight: 700, fontSize: 'var(--text-base)', color: 'var(--primary)' }}>
              Scanning {scanStatus.jobs.length} subnet{scanStatus.jobs.length > 1 ? 's' : ''}…
            </div>
          </div>
          {scanStatus.jobs.map((job: any) => (
            <ScanProgressBar key={job.subnet_id} job={job} />
          ))}
        </div>
      )}

      {/* ── Recently completed scan results ── */}
      {scanStatus && !(scanStatus.jobs?.length > 0) && scanStatus.subnets?.some((s: any) => s.scan_status === 'done' && s.last_scanned) && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 16px' }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Last Scan Results</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {scanStatus.subnets?.filter((s: any) => s.scan_status === 'done' && s.last_scanned).map((s: any) => (
              <div key={s.id} style={{ padding: '6px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', fontSize: 'var(--text-xs)' }}>
                <div style={{ ...MONO, fontWeight: 600 }}>{cleanNetwork(s.network)}/{s.prefix_length}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                  {s.used_hosts}/{s.total_hosts || 0} used · {s.unknown_hosts > 0
                    ? <span style={{ color: 'var(--orange)' }}>⚠ {s.unknown_hosts} unknown</span>
                    : <span style={{ color: 'var(--green)' }}>✓ clean</span>}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{fmtDate(s.last_scanned)}</div>
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
          supernets={supernets} subnets={subnets} orphanSubnets={orphanSubnets} sites={sites}
          expanded={expanded} onToggle={toggleExpanded}
          onViewSubnet={setSelectedSubnet} onScanSubnet={scanSubnet} onDeleteSubnet={deleteSubnet}
          onAddSubnet={openAddSubnet} onDeleteSupernet={deleteSupernet}
          onEditSupernet={setEditSupernet} onEditSubnet={setEditSubnet}
          onNextIp={nextIpForSubnet}
          prefixSel={prefixSel} setPrefixSel={setPrefixSel}
          nextSubnetResult={nextSubnetResult} onFindNextSubnet={findNextSubnet}
          search={search} supernetFilter={supernetFilter} statusFilter={statusFilter}
        />
      ) : view === 'flat' ? (
        <FlatView subnets={subnets} sites={sites} onView={setSelectedSubnet} onScan={scanSubnet} onDelete={deleteSubnet} onEdit={setEditSubnet} />
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
      {editSupernet && <EditSupernetModal supernet={editSupernet} sites={sites} onClose={() => setEditSupernet(null)} onSaved={loadAll} />}
      {editSubnet && <EditSubnetModal subnet={editSubnet} sites={sites} onClose={() => setEditSubnet(null)} onSaved={loadAll} />}

      {/* ── Subnet detail slide-over ── */}
      {selectedSubnet && (
        <SubnetDetail
          key={selectedSubnet.id}
          subnet={selectedSubnet}
          sites={sites}
          onClose={() => { setSelectedSubnet(null); loadAll(); }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TREE VIEW (module scope)
// ════════════════════════════════════════════════════════════
function TreeView({
  supernets, subnets, orphanSubnets, sites, expanded, onToggle,
  onViewSubnet, onScanSubnet, onDeleteSubnet, onAddSubnet, onDeleteSupernet,
  onEditSupernet, onEditSubnet, onNextIp,
  prefixSel, setPrefixSel, nextSubnetResult, onFindNextSubnet,
  search, supernetFilter, statusFilter,
}: {
  supernets: Supernet[]; subnets: Subnet[]; orphanSubnets: Subnet[]; sites: Site[];
  expanded: Set<number>; onToggle: (id: number) => void;
  onViewSubnet: (s: Subnet) => void; onScanSubnet: (s: Subnet) => void; onDeleteSubnet: (id: number) => void;
  onAddSubnet: (supernetId: number | null) => void; onDeleteSupernet: (id: number) => void;
  onEditSupernet: (sn: Supernet) => void; onEditSubnet: (s: Subnet) => void; onNextIp: (s: Subnet) => void;
  prefixSel: Record<number, number>; setPrefixSel: (f: (p: Record<number, number>) => Record<number, number>) => void;
  nextSubnetResult: Record<number, string>; onFindNextSubnet: (sn: Supernet) => void;
  search: string; supernetFilter: string; statusFilter: 'all' | 'healthy' | 'warning' | 'critical';
}) {
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;
  const CARD: React.CSSProperties = {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)', overflow: 'visible',
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

  const q = search.trim().toLowerCase();
  const filterActive = q !== '' || statusFilter !== 'all';

  const subnetBand = (s: Subnet) => {
    const pct = utilPct(s.used_hosts || 0, s.total_hosts || totalHosts(s.prefix_length));
    return pct >= 90 ? 'critical' : pct >= 80 ? 'warning' : 'healthy';
  };
  const matchSubnet = (s: Subnet) => {
    if (statusFilter !== 'all' && subnetBand(s) !== statusFilter) return false;
    if (q) {
      const hay = `${cleanNetwork(s.network)}/${s.prefix_length} ${s.name || ''} ${siteName(s.site_id, sites, s.site) || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
  const matchSupernetText = (sn: Supernet) => {
    if (!q) return true;
    const hay = `${cleanNetwork(sn.network)}/${sn.prefix_length} ${sn.name || ''} ${siteName(sn.site_id, sites, sn.site) || ''}`.toLowerCase();
    return hay.includes(q);
  };

  const visibleSupernets = supernets.filter(sn => {
    if (supernetFilter === 'unassigned') return false;
    if (supernetFilter !== 'all' && String(sn.id) !== supernetFilter) return false;
    return true;
  });
  const showUnassigned = (supernetFilter === 'all' || supernetFilter === 'unassigned') && orphanSubnets.length > 0;
  const filteredOrphans = orphanSubnets.filter(matchSubnet);

  // ── Subnet <tr> ──
  const subnetRow = (sub: Subnet) => {
    const total = sub.total_hosts || totalHosts(sub.prefix_length);
    const used  = sub.used_hosts || 0;
    const st    = utilStatus(utilPct(used, total));
    const menu: MenuItem[] = [{ label: 'Next Available IP', onClick: () => onNextIp(sub) }];
    if (canWrite) {
      menu.unshift({ label: 'Scan', onClick: () => onScanSubnet(sub) });
      menu.push({ label: 'Edit', onClick: () => onEditSubnet(sub) });
      menu.push({ label: 'Delete', onClick: () => onDeleteSubnet(sub.id), danger: true });
    }
    return (
      <tr key={`sub-${sub.id}`} className="clickable" onClick={() => onViewSubnet(sub)}>
        <td style={{ ...TD, paddingLeft: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', flexShrink: 0 }} />
            <div>
              <div style={{ ...MONO, fontSize: 'var(--text-base)', fontWeight: 600 }}>
                {sub.is_sensitive && <span title="Sensitive subnet" style={{ marginRight: 5 }}>🔒</span>}
                {cleanNetwork(sub.network)}/{sub.prefix_length}
              </div>
              {sub.name && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{sub.name}</div>}
            </div>
          </div>
        </td>
        <td style={TD}><span className="badge badge-gray">Subnet</span></td>
        <td style={{ ...TD, color: 'var(--text-muted)' }}>—</td>
        <td style={{ ...TD, ...MONO, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{ipRange(sub.network, sub.prefix_length)}</td>
        <td style={{ ...TD, minWidth: 150 }}><UtilBar pct={utilPct(used, total)} /></td>
        <td style={{ ...TD, ...MONO, whiteSpace: 'nowrap' }}>{used.toLocaleString()} / {total.toLocaleString()}</td>
        <td style={TD}>
          <span className={`badge ${st.badge}`}>{st.label}</span>
          {sub.unknown_hosts > 0 && <span className="badge badge-orange" style={{ marginLeft: 6 }}>⚠ {sub.unknown_hosts}</span>}
        </td>
        <td style={{ ...TD, fontSize: 'var(--text-xs)', color: sub.scan_status === 'error' ? 'var(--red)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {sub.scan_status === 'error' ? '⚠ Error' : relTime(sub.last_scanned)}
        </td>
        <td style={{ ...TD, textAlign: 'right' }} onClick={e => e.stopPropagation()}>
          <RowMenu items={menu} />
        </td>
      </tr>
    );
  };

  return (
    <div style={CARD}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Network</th>
            <th>Type</th>
            <th>Subnets</th>
            <th>IP Range</th>
            <th>Utilization</th>
            <th>Used / Total</th>
            <th>Status</th>
            <th>Last Scanned</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visibleSupernets.map(sn => {
            const children      = subnets.filter(s => s.supernet_id === sn.id);
            const matchedKids    = filterActive ? children.filter(matchSubnet) : children;
            if (filterActive && !matchSupernetText(sn) && matchedKids.length === 0) return null;
            const isOpen        = expanded.has(sn.id) || (filterActive && matchedKids.length > 0);
            const totalUsed     = children.reduce((a, s) => a + (s.used_hosts || 0), 0);
            const totalAll      = children.reduce((a, s) => a + (s.total_hosts || 0), 0);
            const prefix        = prefixSel[sn.id] || 24;
            const snSite        = siteName(sn.site_id, sites, sn.site);
            const snMenu: MenuItem[] = [];
            if (canWrite) {
              snMenu.push({ label: '+ Subnet', onClick: () => onAddSubnet(sn.id) });
              snMenu.push({ label: 'Edit Supernet', onClick: () => onEditSupernet(sn) });
              snMenu.push({ label: 'Delete Supernet', onClick: () => onDeleteSupernet(sn.id), danger: true });
            }

            return (
              <Fragment key={`sn-${sn.id}`}>
                <tr className="clickable" onClick={() => onToggle(sn.id)} style={{ background: 'var(--bg-primary)' }}>
                  <td style={TD}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', display: 'inline-block', width: 12, transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--navy)', flexShrink: 0 }} />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
                          {sn.name || `${cleanNetwork(sn.network)}/${sn.prefix_length}`}
                          <span style={{ ...MONO, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginLeft: 9, fontWeight: 400 }}>{cleanNetwork(sn.network)}/{sn.prefix_length}</span>
                        </div>
                        {snSite && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>📍 {snSite}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={TD}><span className="badge badge-blue">Supernet</span></td>
                  <td style={{ ...TD, ...MONO }}>{children.length}</td>
                  <td style={{ ...TD, ...MONO, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{ipRange(sn.network, sn.prefix_length)}</td>
                  <td style={{ ...TD, minWidth: 150 }}>{totalAll > 0 ? <UtilBar pct={utilPct(totalUsed, totalAll)} /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ ...TD, ...MONO, whiteSpace: 'nowrap' }}>{totalUsed.toLocaleString()} / {totalAll.toLocaleString()}</td>
                  <td style={{ ...TD, color: 'var(--text-muted)' }}>—</td>
                  <td style={{ ...TD, color: 'var(--text-muted)' }}>—</td>
                  <td style={{ ...TD, textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
                      <select
                        value={prefix}
                        onChange={e => setPrefixSel(p => ({ ...p, [sn.id]: parseInt(e.target.value) }))}
                        title="Prefix for next free subnet"
                        style={{ fontSize: 'var(--text-xs)', padding: '3px 5px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }}
                      >
                        {PREFIX_OPTIONS.map(p => <option key={p} value={p}>/{p}</option>)}
                      </select>
                      <button className="btn" style={{ fontSize: 'var(--text-xs)', padding: '3px 8px' }} onClick={() => onFindNextSubnet(sn)}>Next Free</button>
                      {nextSubnetResult[sn.id] && (
                        <span style={{ ...MONO, fontSize: 'var(--text-xs)', color: 'var(--blue)', fontWeight: 600 }}>{nextSubnetResult[sn.id]}</span>
                      )}
                      {snMenu.length > 0 && <RowMenu items={snMenu} />}
                    </div>
                  </td>
                </tr>
                {isOpen && matchedKids.map(sub => subnetRow(sub))}
                {isOpen && matchedKids.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ ...TD, paddingLeft: 40, color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>
                      {filterActive ? 'No matching subnets' : 'No subnets yet — use the ··· menu to add one'}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}

          {/* Unassigned subnets */}
          {showUnassigned && (!filterActive || filteredOrphans.length > 0) && (
            <>
              <tr style={{ background: 'var(--bg-primary)' }}>
                <td colSpan={9} style={{ ...TD, fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-muted)', display: 'inline-block' }} />
                    Unassigned Subnets ({filterActive ? filteredOrphans.length : orphanSubnets.length})
                  </span>
                </td>
              </tr>
              {(filterActive ? filteredOrphans : orphanSubnets).map(sub => subnetRow(sub))}
            </>
          )}
        </tbody>
      </table>
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

function FlatView({ subnets, sites, onView, onScan, onDelete, onEdit }: {
  subnets: Subnet[]; sites: Site[]; onView: (s: Subnet) => void; onScan: (s: Subnet) => void; onDelete: (id: number) => void; onEdit: (s: Subnet) => void;
}) {
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;
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
                  <td style={{ ...TD, ...MONO, fontWeight: 600 }}>
                    {sub.is_sensitive && <span title="Sensitive subnet" style={{ marginRight: 5 }}>🔒</span>}
                    {cleanNetwork(sub.network)}/{sub.prefix_length}
                  </td>
                  <td style={TD}>{sub.name || '—'}</td>
                  <td style={{ ...TD, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{sub.supernet_name || (sub.supernet_network ? `${cleanNetwork(sub.supernet_network)}/${sub.supernet_prefix}` : '—')}</td>
                  <td style={{ ...TD, ...MONO, fontSize: 'var(--text-xs)' }}>{sub.gateway || '—'}</td>
                  <td style={TD}>{sub.vlan_id ? <span className="badge badge-blue">{sub.vlan_id}</span> : '—'}</td>
                  <td style={TD}>{siteName(sub.site_id, sites, sub.site) || '—'}</td>
                  <td style={{ ...TD, ...MONO }}>{sub.used_hosts || 0} / {total}</td>
                  <td style={{ ...TD, minWidth: 150 }}><UtilBar pct={utilPct(sub.used_hosts || 0, total)} /></td>
                  <td style={TD}>{sub.unknown_hosts > 0
                    ? <span className="badge badge-orange">{sub.unknown_hosts}</span>
                    : <span style={{ color: 'var(--green)' }}>0</span>}</td>
                  <td style={{ ...TD, fontSize: 'var(--text-xs)', color: sub.scan_status === 'error' ? 'var(--red)' : 'var(--text-muted)' }}>
                    {scanLabel(sub.scan_status, sub.last_scanned)}
                  </td>
                  <td style={TD} onClick={e => e.stopPropagation()}>
                    {canWrite && <>
                      <button onClick={() => onScan(sub)} style={{ fontSize: 'var(--text-xs)', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Scan</button>
                      <button onClick={() => onEdit(sub)} style={{ fontSize: 'var(--text-xs)', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, marginLeft: 8 }}>Edit</button>
                      <button onClick={() => onDelete(sub.id)} style={{ fontSize: 'var(--text-xs)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 8 }}>Del</button>
                    </>}
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
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 600 }}>VLAN Registry</div>
        {canWrite && <button className="btn btn-primary" onClick={onAdd}>+ Add VLAN</button>}
      </div>
      {vlans.length === 0 ? (
        <EmptyState icon="🏷" title="No VLANs configured" message="Add a VLAN to track it across your subnets." actionLabel={canWrite ? 'Add VLAN' : undefined} onAction={canWrite ? onAdd : undefined} />
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
                  {canWrite && <button onClick={() => onDelete(v.id)} style={{ fontSize: 'var(--text-xs)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
