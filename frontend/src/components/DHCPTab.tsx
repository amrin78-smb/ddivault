'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
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
  subnet_mask?: string;
  description?: string;
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
  device_type?: string;
  device_vendor?: string;
  device_os?: string;
  risk_level?: string;
  is_mac_randomized?: boolean;
}

interface ScopeForecast {
  scope_id: number;
  scope_cidr?: string;
  days_to_full?: number | null;
  days_to_80pct?: number | null;
  status?: 'ok' | 'stable' | 'insufficient_data';
}

interface ServerOption {
  id: number;
  hostname: string;
  ip_address: string;
  role: string;
}

interface ScopeOption {
  OptionId: number;
  Name: string;
  Value: any;
}

interface Exclusion {
  StartRange: any;
  EndRange: any;
}

type View = 'scopes' | 'leases' | 'reservations';

// ── API helper ────────────────────────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ── IPv4 validation ───────────────────────────────────────────
const isIp = (s: string): boolean =>
  /^(\d{1,3}\.){3}\d{1,3}$/.test(s.trim()) && s.trim().split('.').every(o => +o >= 0 && +o <= 255);

// ── Subnet mask presets ───────────────────────────────────────
const MASK_PRESETS: { label: string; value: string }[] = [
  { label: '/24 — 255.255.255.0',   value: '255.255.255.0' },
  { label: '/23 — 255.255.254.0',   value: '255.255.254.0' },
  { label: '/22 — 255.255.252.0',   value: '255.255.252.0' },
  { label: '/25 — 255.255.255.128', value: '255.255.255.128' },
  { label: '/26 — 255.255.255.192', value: '255.255.255.192' },
  { label: '/27 — 255.255.255.224', value: '255.255.255.224' },
  { label: '/28 — 255.255.255.240', value: '255.255.255.240' },
];

// ── Lease duration presets (PowerShell timespan strings) ───────
const LEASE_PRESETS: { label: string; value: string }[] = [
  { label: '1 day',   value: '1.00:00:00' },
  { label: '4 days',  value: '4.00:00:00' },
  { label: '8 days',  value: '8.00:00:00' },
  { label: '30 days', value: '30.00:00:00' },
];

// Normalize an option Value (array or scalar) into a comma-joined string of values
function optionValueToString(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => String(x)).join(', ');
  return String(v);
}

const formatDuration = (val: any) => {
  if (!val) return '—';
  if (typeof val === 'object') {
    const d = val.Days || 0, h = val.Hours || 0;
    if (d > 0) return `${d} day${d !== 1 ? 's' : ''}`;
    if (h > 0) return `${h} hour${h !== 1 ? 's' : ''}`;
    return JSON.stringify(val);
  }
  return String(val);
};

// Normalize an exclusion range endpoint (IP string or IPAddress-like object)
function ipFromRange(v: any): string {
  if (v == null) return '';
  if (typeof v === 'object') return v.IPAddressToString || v.IPAddress || '';
  return String(v);
}

// ── Helpers ───────────────────────────────────────────────────
function pctNum(v: number | string): number {
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

// A scope with no dynamic pool (total_ips 0, or collector-marked state='empty')
// is "empty" — not "Full". The total_ips check covers rows not yet re-polled.
function isEmptyScope(s: Scope): boolean {
  return (s.total_ips ?? 0) === 0 || String(s.state || '').toLowerCase() === 'empty';
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

// ── Device type → icon ────────────────────────────────────────
const DEVICE_ICONS: Record<string, string> = {
  mobile: '📱', workstation: '💻', network: '🔌', printer: '🖨️', voip: '📞', unknown: '❓',
};
const deviceIcon = (t?: string) => DEVICE_ICONS[t || 'unknown'] || '❓';

// ── Forecast color coding (days to full) ──────────────────────
function forecastColor(days?: number | null): string {
  if (days == null) return 'var(--green)';
  if (days < 14) return 'var(--red)';
  if (days <= 30) return 'var(--yellow)';
  return 'var(--green)';
}

// ── Shared inline styles (design-system aligned) ──────────────
const INPUT: React.CSSProperties = {
  padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 'var(--text-base)', outline: 'none',
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
            <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>Reserve IP Address</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>
              Scope <span className="mono">{scope.scope_id}</span>{scope.name ? ` · ${scope.name}` : ''}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', lineHeight: 1, color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{
          background: 'var(--primary-light)', border: '1px solid #fde047',
          borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 'var(--text-sm)', marginBottom: 16, color: 'var(--yellow)',
        }}>
          This runs <span className="mono">Add-DhcpServerv4Reservation</span> on your Windows DHCP server via PowerShell remoting.
        </div>

        {fields.map(f => (
          <div key={f.k} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>{f.l}</label>
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
// CreateScopeModal (module scope)
// ════════════════════════════════════════════════════════════
function CreateScopeModal({ servers, onClose, onDone }: {
  servers: ServerOption[]; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = useState({
    server_id:   servers[0]?.id ?? ('' as number | ''),
    name:        '',
    startRange:  '',
    endRange:    '',
    subnetMask:  MASK_PRESETS[0].value,
    description: '',
    leasePreset: LEASE_PRESETS[2].value, // 8 days default, or 'custom'
    leaseCustom: '',
    state:       'Active' as 'Active' | 'InActive',
    dnsServers:  '',
    gateway:     '',
    domainName:  '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useToast();
  useEscape(onClose);

  const set = (k: keyof typeof form, v: any) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    setError('');
    if (!form.server_id) { setError('Select a DHCP server'); return; }
    if (!form.name.trim()) { setError('Scope name is required'); return; }
    if (!isIp(form.startRange)) { setError('Start range must be a valid IPv4 address'); return; }
    if (!isIp(form.endRange)) { setError('End range must be a valid IPv4 address'); return; }
    if (form.gateway.trim() && !isIp(form.gateway)) { setError('Default gateway must be a valid IPv4 address'); return; }
    const dnsList = form.dnsServers.split(',').map(s => s.trim()).filter(Boolean);
    if (dnsList.some(d => !isIp(d))) { setError('Each DNS server must be a valid IPv4 address'); return; }
    const leaseDuration = form.leasePreset === 'custom' ? form.leaseCustom.trim() : form.leasePreset;
    if (form.leasePreset === 'custom' && !leaseDuration) { setError('Enter a custom lease duration (d.hh:mm:ss)'); return; }

    setLoading(true);
    try {
      await api('/scopes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id:    form.server_id,
          name:         form.name.trim(),
          startRange:   form.startRange.trim(),
          endRange:     form.endRange.trim(),
          subnetMask:   form.subnetMask,
          description:  form.description.trim(),
          leaseDuration,
          state:        form.state,
          dnsServers:   form.dnsServers.trim(),
          gateway:      form.gateway.trim(),
          domainName:   form.domainName.trim(),
        }),
      });
      toast('Scope created successfully', 'success');
      onDone();
    } catch (e: any) {
      setError(e.message || 'Failed to create scope');
      toast(e.message || 'Failed to create scope', 'error');
    } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 24, width: 520,
        maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>Create DHCP Scope</div>
          <button onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', lineHeight: 1, color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{
          background: 'var(--primary-light)', border: '1px solid #fde047',
          borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 'var(--text-sm)', marginBottom: 16, color: 'var(--yellow)',
        }}>
          This runs <span className="mono">Add-DhcpServerv4Scope</span> on your Windows DHCP server via PowerShell remoting.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>DHCP Server *</label>
          <select value={form.server_id} onChange={e => set('server_id', e.target.value ? Number(e.target.value) : '')} style={{ ...INPUT, width: '100%' }}>
            <option value="">Select server…</option>
            {servers.map(s => <option key={s.id} value={s.id}>{s.hostname}{s.ip_address ? ` (${s.ip_address})` : ''}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Scope Name *</label>
          <input value={form.name} placeholder="Office LAN" onChange={e => set('name', e.target.value)} style={{ ...INPUT, width: '100%' }} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Start Range *</label>
            <input value={form.startRange} placeholder="172.24.4.10" onChange={e => set('startRange', e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>End Range *</label>
            <input value={form.endRange} placeholder="172.24.4.250" onChange={e => set('endRange', e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Subnet Mask *</label>
          <select value={form.subnetMask} onChange={e => set('subnetMask', e.target.value)} style={{ ...INPUT, width: '100%' }}>
            {MASK_PRESETS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Description</label>
          <input value={form.description} placeholder="Optional" onChange={e => set('description', e.target.value)} style={{ ...INPUT, width: '100%' }} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Lease Duration</label>
            <select value={form.leasePreset} onChange={e => set('leasePreset', e.target.value)} style={{ ...INPUT, width: '100%' }}>
              {LEASE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              <option value="custom">Custom…</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>State</label>
            <select value={form.state} onChange={e => set('state', e.target.value as 'Active' | 'InActive')} style={{ ...INPUT, width: '100%' }}>
              <option value="Active">Active</option>
              <option value="InActive">Inactive</option>
            </select>
          </div>
        </div>

        {form.leasePreset === 'custom' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Custom Lease (d.hh:mm:ss)</label>
            <input value={form.leaseCustom} placeholder="14.00:00:00" onChange={e => set('leaseCustom', e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>DNS Servers (comma-separated IPs)</label>
          <input value={form.dnsServers} placeholder="8.8.8.8, 8.8.4.4" onChange={e => set('dnsServers', e.target.value)} style={{ ...INPUT, width: '100%' }} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Default Gateway</label>
            <input value={form.gateway} placeholder="172.24.4.1" onChange={e => set('gateway', e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Domain Name</label>
            <input value={form.domainName} placeholder="corp.local" onChange={e => set('domainName', e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
        </div>

        {error && (
          <div style={{ background: 'var(--tint-danger)', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 'var(--text-sm)', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={loading} style={{ opacity: loading ? 0.7 : 1 }}>
            {loading ? <><Spinner size={12} color="#fff" /> Creating…</> : 'Create Scope'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// EditScopeModal (module scope)
// ════════════════════════════════════════════════════════════
function EditScopeModal({ scope, onClose, onDone }: {
  scope: Scope; onClose: () => void; onDone: () => void;
}) {
  const presetMatch = LEASE_PRESETS.find(p => p.value === scope.lease_duration);
  const [form, setForm] = useState({
    name:        scope.name || '',
    description: '',
    leasePreset: presetMatch ? presetMatch.value : 'custom',
    leaseCustom: presetMatch ? '' : (scope.lease_duration || ''),
    state:       (scope.state === 'Active' ? 'Active' : 'InActive') as 'Active' | 'InActive',
    dnsServers:  '',
    gateway:     '',
    domainName:  '',
  });
  const [loading, setLoading] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [error, setError] = useState('');
  const [exclusions, setExclusions] = useState<{ start: string; end: string }[]>([]);
  const [exclStart, setExclStart] = useState('');
  const [exclEnd, setExclEnd] = useState('');
  const [exclBusy, setExclBusy] = useState(false);
  // original option values for change detection
  const [orig, setOrig] = useState({ dnsServers: '', gateway: '', domainName: '' });
  const { toast } = useToast();
  useEscape(onClose);

  const set = (k: keyof typeof form, v: any) => setForm(p => ({ ...p, [k]: v }));

  const loadOptions = useCallback(async () => {
    try {
      const d = await api(`/scopes/${encodeURIComponent(scope.scope_id)}/options?server_id=${scope.server_id}`);
      const opts: ScopeOption[] = d.data || [];
      const dns = opts.find(o => o.OptionId === 6);
      const gw  = opts.find(o => o.OptionId === 3);
      const dom = opts.find(o => o.OptionId === 15);
      const dnsStr = dns ? optionValueToString(dns.Value) : '';
      const gwStr  = gw  ? optionValueToString(gw.Value)  : '';
      const domStr = dom ? optionValueToString(dom.Value) : '';
      setForm(p => ({ ...p, dnsServers: dnsStr, gateway: gwStr, domainName: domStr }));
      setOrig({ dnsServers: dnsStr, gateway: gwStr, domainName: domStr });
    } catch (e: any) {
      toast(e.message || 'Failed to load scope options', 'error');
    } finally { setOptionsLoading(false); }
  }, [scope.scope_id, scope.server_id, toast]);

  const loadExclusions = useCallback(async () => {
    try {
      const d = await api(`/scopes/${encodeURIComponent(scope.scope_id)}/exclusions?server_id=${scope.server_id}`);
      const list: Exclusion[] = d.data || [];
      setExclusions(list.map(x => ({ start: ipFromRange(x.StartRange), end: ipFromRange(x.EndRange) })));
    } catch (e: any) {
      toast(e.message || 'Failed to load exclusions', 'error');
    }
  }, [scope.scope_id, scope.server_id, toast]);

  useEffect(() => { loadOptions(); loadExclusions(); }, [loadOptions, loadExclusions]);

  const addExclusion = async () => {
    if (!isIp(exclStart) || !isIp(exclEnd)) { toast('Start and end must be valid IPv4 addresses', 'error'); return; }
    setExclBusy(true);
    try {
      await api(`/scopes/${encodeURIComponent(scope.scope_id)}/exclusions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startRange: exclStart.trim(), endRange: exclEnd.trim(), server_id: scope.server_id }),
      });
      toast('Exclusion range added', 'success');
      setExclStart(''); setExclEnd('');
      await loadExclusions();
    } catch (e: any) {
      toast(e.message || 'Failed to add exclusion', 'error');
    } finally { setExclBusy(false); }
  };

  const save = async () => {
    setError('');
    if (!form.name.trim()) { setError('Scope name is required'); return; }
    if (form.gateway.trim() && !isIp(form.gateway)) { setError('Default gateway must be a valid IPv4 address'); return; }
    const dnsList = form.dnsServers.split(',').map(s => s.trim()).filter(Boolean);
    if (dnsList.some(d => !isIp(d))) { setError('Each DNS server must be a valid IPv4 address'); return; }
    const leaseDuration = form.leasePreset === 'custom' ? form.leaseCustom.trim() : form.leasePreset;
    if (form.leasePreset === 'custom' && !leaseDuration) { setError('Enter a custom lease duration (d.hh:mm:ss)'); return; }

    setLoading(true);
    try {
      await api(`/scopes/${encodeURIComponent(scope.scope_id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id:   scope.server_id,
          name:        form.name.trim(),
          description: form.description.trim(),
          leaseDuration,
          state:       form.state,
        }),
      });

      // Push changed options
      const postOption = async (optionId: number, values: string[]) =>
        api(`/scopes/${encodeURIComponent(scope.scope_id)}/options`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ optionId, values, server_id: scope.server_id }),
        });

      if (form.dnsServers.trim() !== orig.dnsServers.trim()) {
        await postOption(6, dnsList);
      }
      if (form.gateway.trim() !== orig.gateway.trim()) {
        await postOption(3, form.gateway.trim() ? [form.gateway.trim()] : []);
      }
      if (form.domainName.trim() !== orig.domainName.trim()) {
        await postOption(15, form.domainName.trim() ? [form.domainName.trim()] : []);
      }

      toast('Scope updated', 'success');
      onDone();
    } catch (e: any) {
      setError(e.message || 'Failed to update scope');
      toast(e.message || 'Failed to update scope', 'error');
    } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 24, width: 520,
        maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>Edit Scope</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>
              <span className="mono">{scope.scope_id}</span> · {scope.server_hostname || scope.server_ip}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', lineHeight: 1, color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Scope Name *</label>
          <input value={form.name} onChange={e => set('name', e.target.value)} style={{ ...INPUT, width: '100%' }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Description</label>
          <input value={form.description} placeholder="Optional" onChange={e => set('description', e.target.value)} style={{ ...INPUT, width: '100%' }} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Lease Duration</label>
            <select value={form.leasePreset} onChange={e => set('leasePreset', e.target.value)} style={{ ...INPUT, width: '100%' }}>
              {LEASE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              <option value="custom">Custom…</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>State</label>
            <select value={form.state} onChange={e => set('state', e.target.value as 'Active' | 'InActive')} style={{ ...INPUT, width: '100%' }}>
              <option value="Active">Active</option>
              <option value="InActive">Inactive</option>
            </select>
          </div>
        </div>

        {form.leasePreset === 'custom' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Custom Lease (d.hh:mm:ss)</label>
            <input value={form.leaseCustom} placeholder="14.00:00:00" onChange={e => set('leaseCustom', e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>
            DNS Servers (comma-separated IPs) {optionsLoading && <span style={{ fontWeight: 400 }}>· loading…</span>}
          </label>
          <input value={form.dnsServers} placeholder="8.8.8.8, 8.8.4.4" onChange={e => set('dnsServers', e.target.value)} style={{ ...INPUT, width: '100%' }} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Default Gateway</label>
            <input value={form.gateway} placeholder="172.24.4.1" onChange={e => set('gateway', e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>Domain Name</label>
            <input value={form.domainName} placeholder="corp.local" onChange={e => set('domainName', e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
        </div>

        {/* Exclusion ranges */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--text-base)', color: 'var(--text-primary)', marginBottom: 8 }}>Exclusion Ranges</div>
          {exclusions.length === 0 ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 8 }}>No exclusion ranges.</div>
          ) : (
            <div style={{ marginBottom: 8 }}>
              {exclusions.map((x, i) => (
                <div key={i} className="mono" style={{ fontSize: 'var(--text-sm)', padding: '4px 0', color: 'var(--text-primary)' }}>
                  {x.start} – {x.end}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Start IP</label>
              <input value={exclStart} placeholder="172.24.4.1" onChange={e => setExclStart(e.target.value)} style={{ ...INPUT, width: '100%' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>End IP</label>
              <input value={exclEnd} placeholder="172.24.4.9" onChange={e => setExclEnd(e.target.value)} style={{ ...INPUT, width: '100%' }} />
            </div>
            <button className="btn" onClick={addExclusion} disabled={exclBusy} style={{ opacity: exclBusy ? 0.7 : 1 }}>
              {exclBusy ? <Spinner size={12} /> : 'Add Range'}
            </button>
          </div>
        </div>

        {error && (
          <div style={{ background: 'var(--tint-danger)', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 'var(--text-sm)', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={loading} style={{ opacity: loading ? 0.7 : 1 }}>
            {loading ? <><Spinner size={12} color="#fff" /> Saving…</> : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// ScopeDetail (module scope) — read-only options + exclusions for expanded row
// ════════════════════════════════════════════════════════════
function ScopeDetail({ scope }: { scope: Scope }) {
  const [options, setOptions] = useState<{ dns: string; gateway: string; domain: string } | null>(null);
  const [exclusions, setExclusions] = useState<{ start: string; end: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [o, ex] = await Promise.all([
          api(`/scopes/${encodeURIComponent(scope.scope_id)}/options?server_id=${scope.server_id}`).catch(() => ({ data: [] })),
          api(`/scopes/${encodeURIComponent(scope.scope_id)}/exclusions?server_id=${scope.server_id}`).catch(() => ({ data: [] })),
        ]);
        if (cancelled) return;
        const opts: ScopeOption[] = o.data || [];
        setOptions({
          dns:     optionValueToString(opts.find(x => x.OptionId === 6)?.Value),
          gateway: optionValueToString(opts.find(x => x.OptionId === 3)?.Value),
          domain:  optionValueToString(opts.find(x => x.OptionId === 15)?.Value),
        });
        const list: Exclusion[] = ex.data || [];
        setExclusions(list.map(x => ({ start: ipFromRange(x.StartRange), end: ipFromRange(x.EndRange) })));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scope.scope_id, scope.server_id]);

  const cell: React.CSSProperties = { fontSize: 'var(--text-sm)' };
  const lbl: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 2 };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12 }} onClick={e => e.stopPropagation()}>
      <div style={{ fontWeight: 600, fontSize: 'var(--text-base)', color: 'var(--text-primary)', marginBottom: 10 }}>
        Scope Configuration {loading && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· loading…</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
        <div>
          <div style={lbl}>DNS Servers</div>
          <div className="mono" style={cell}>{options?.dns || '—'}</div>
        </div>
        <div>
          <div style={lbl}>Default Gateway</div>
          <div className="mono" style={cell}>{options?.gateway || '—'}</div>
        </div>
        <div>
          <div style={lbl}>Domain Name</div>
          <div style={cell}>{options?.domain || '—'}</div>
        </div>
        <div>
          <div style={lbl}>Lease Duration</div>
          <div className="mono" style={cell}>{formatDuration(scope.lease_duration)}</div>
        </div>
        <div>
          <div style={lbl}>Subnet Mask</div>
          <div className="mono" style={cell}>{scope.subnet_mask || '—'}</div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={lbl}>Exclusion Ranges</div>
          {exclusions.length === 0 ? (
            <div style={cell}>—</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {exclusions.map((x, i) => <span key={i} className="mono" style={cell}>{x.start} – {x.end}</span>)}
            </div>
          )}
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
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();

  // Download leases CSV via an AUTHENTICATED fetch. /api/leases/export now requires
  // a signed-in identity (requireAuth), which is carried by the x-ddi-actor-* headers
  // the global fetch patch injects — a plain <a>/window.open navigation sends none of
  // them and would 401. fetch → blob → anchor keeps the request authenticated.
  const downloadLeases = useCallback(async () => {
    try {
      const res = await fetch('/api/leases/export');
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      let filename = `leases-${new Date().toISOString().slice(0, 10)}.csv`;
      const cd = res.headers.get('content-disposition');
      const m = cd && /filename\*?=(?:UTF-8'')?"?([^"';]+)"?/i.exec(cd);
      if (m) { try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; } }
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      toast(`Leases export failed: ${(e as Error).message || 'error'}`, 'error');
    }
  }, [toast]);
  const canWrite = rbacCanWrite && licenseState.canWrite;

  // Scopes state
  const [scopes, setScopes]       = useState<Scope[]>([]);
  const [scopesLoading, setScopesLoading] = useState(true);
  const [view, setView]           = useState<View>('scopes');
  const [forecasts, setForecasts] = useState<Map<number, ScopeForecast>>(new Map());

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

  // Scope lifecycle: create / edit modals + DHCP-capable servers
  const [showCreateScope, setShowCreateScope] = useState(false);
  const [editScope, setEditScope] = useState<Scope | null>(null);
  const [dhcpServers, setDhcpServers] = useState<ServerOption[]>([]);
  const [busyScope, setBusyScope] = useState<string | null>(null); // scope_id currently mutating

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

  // ── Load capacity forecasts (Scopes view) ───────────────────
  const loadForecasts = useCallback(async () => {
    try {
      const d = await api('/forecasts/scopes');
      const map = new Map<number, ScopeForecast>();
      (d.data || []).forEach((f: ScopeForecast) => {
        if (f.scope_id != null) map.set(f.scope_id, f);
      });
      setForecasts(map);
    } catch {
      // non-fatal; column will simply show '—'
    }
  }, []);

  useEffect(() => {
    if (view === 'scopes') loadForecasts();
  }, [view, loadForecasts]);

  // ── Load DHCP-capable servers (for Create Scope) ────────────
  const loadDhcpServers = useCallback(async () => {
    try {
      const d = await api('/servers');
      const list: ServerOption[] = (d.data || []).filter((s: ServerOption) => s.role === 'dhcp' || s.role === 'both');
      setDhcpServers(list);
    } catch {
      // non-fatal; create modal will simply have no preselected server
    }
  }, []);

  useEffect(() => { loadDhcpServers(); }, [loadDhcpServers]);

  // ── Toggle scope state (Active <-> InActive) ────────────────
  const toggleScopeState = useCallback(async (scope: Scope) => {
    const next = scope.state === 'Active' ? 'InActive' : 'Active';
    if (!window.confirm(`Set scope ${scope.scope_id} to ${next === 'Active' ? 'Active' : 'Inactive'}?`)) return;
    setBusyScope(scope.scope_id);
    try {
      const d = await api(`/scopes/${encodeURIComponent(scope.scope_id)}/state`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: next, server_id: scope.server_id }),
      });
      const applied = d.state || next;
      setScopes(prev => prev.map(s =>
        (s.scope_id === scope.scope_id && s.server_id === scope.server_id) ? { ...s, state: applied } : s
      ));
      toast(`Scope ${scope.scope_id} is now ${applied}`, 'success');
    } catch (e: any) {
      toast(e.message || 'Failed to change scope state', 'error');
    } finally { setBusyScope(null); }
  }, [toast]);

  // ── Delete scope ────────────────────────────────────────────
  const deleteScope = useCallback(async (scope: Scope) => {
    if (!window.confirm(`Delete scope ${scope.scope_id}? This will remove all lease data. This cannot be undone.`)) return;
    setBusyScope(scope.scope_id);
    try {
      await api(`/scopes/${encodeURIComponent(scope.scope_id)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: scope.server_id }),
      });
      setScopes(prev => prev.filter(s => !(s.scope_id === scope.scope_id && s.server_id === scope.server_id)));
      toast('Scope deleted', 'success');
    } catch (e: any) {
      toast(e.message || 'Failed to delete scope', 'error');
    } finally { setBusyScope(null); }
  }, [toast]);

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
      if (p >= 90 && !isEmptyScope(s)) critical++;
      else if (p >= 80 && !isEmptyScope(s)) warning++;
      totalIPs += s.total_ips || 0;
      usedIPs += s.in_use || 0;
    });
    return { total, warning, critical, totalIPs, available: totalIPs - usedIPs };
  }, [scopes]);

  const kpis = [
    { label: 'Total Scopes',   value: stats.total,      color: 'var(--navy)', textColor: 'var(--text-primary)' },
    { label: 'Warning 80–90%', value: stats.warning,    color: 'var(--yellow)' },
    { label: 'Critical ≥90%',  value: stats.critical,   color: 'var(--red)' },
    { label: 'Total IPs',      value: stats.totalIPs,   color: 'var(--blue)' },
    { label: 'Available IPs',  value: stats.available,  color: 'var(--green)' },
  ];

  // ── Render ──────────────────────────────────────────────────
  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Header */}
      <PageHeader title="DHCP" subtitle="Scope utilization, leases, and reservations across your DHCP servers">
        <button className="btn" onClick={loadScopes} title="Refresh (R)">⟳ Refresh</button>
      </PageHeader>
      <div className="sub-tab-bar">
        <div className="segmented" role="tablist">
          {(['scopes', 'leases', 'reservations'] as View[]).map(v => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)} style={{ textTransform: 'capitalize' }}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <ReadOnlyBanner />

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        {kpis.map((k, i) => (
          <div key={i} className="kpi-card" style={{ borderLeftColor: k.color }}>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1, letterSpacing: '-0.5px', color: (k as { textColor?: string }).textColor || k.color }}>
              {k.value.toLocaleString()}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 6, fontWeight: 500 }}>{k.label}</div>
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
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {filteredScopes.length} of {scopes.length} scopes · auto-refresh 30s
            </span>
            {canWrite && (
              <button className="btn btn-primary" onClick={() => setShowCreateScope(true)}>+ New Scope</button>
            )}
          </div>

          {/* Dense scope table */}
          <div className="card" style={{ overflow: 'hidden' }}>
            {scopesLoading ? (
              <TableSkeleton rows={8} cols={11} />
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
                      <th>Forecast</th>
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
                          forecast={forecasts.get(sc.id)}
                          isExpanded={isExp}
                          lowFree={lowFree}
                          busy={busyScope === sc.scope_id}
                          onToggle={() => toggleScope(sc)}
                          onReserve={() => setReserveTarget({ scope: sc })}
                          onEdit={() => setEditScope(sc)}
                          onToggleState={() => toggleScopeState(sc)}
                          onDelete={() => deleteScope(sc)}
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
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{leaseTotal.toLocaleString()} total</span>
            <button type="button" onClick={downloadLeases} className="btn">⬇ Export CSV</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>IP Address</th><th>Hostname</th><th>Device</th><th>MAC Address</th>
                  <th>Scope</th><th>State</th><th>Expires</th><th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allLeasesLoading && (
                  <tr><td colSpan={8} style={{ padding: 0 }}><TableSkeleton rows={6} cols={8} /></td></tr>
                )}
                {!allLeasesLoading && allLeases.length === 0 && (
                  <tr><td colSpan={8}><EmptyState icon="◇" title="No leases found" message="Try a different search or state filter." /></td></tr>
                )}
                {!allLeasesLoading && allLeases.map(l => {
                  const scope = scopes.find(s => s.scope_id === l.scope_id);
                  const canReserve = l.address_state !== 'Reservation' && !!l.mac_address && !!scope;
                  return (
                    <tr key={l.id}>
                      <td className="mono" style={{ fontWeight: 600 }}>{l.ip_address}</td>
                      <td>{l.hostname || '—'}</td>
                      <td style={{ fontSize: 'var(--text-base)' }}>
                        <span title={l.device_type || 'unknown'}>{deviceIcon(l.device_type)}</span>{' '}
                        {l.device_vendor || '—'}
                        {l.device_os && (
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{l.device_os}</div>
                        )}
                      </td>
                      <td className="mono">{l.mac_address || '—'}</td>
                      <td className="mono">{l.scope_id || '—'}</td>
                      <td><span className={`badge ${stateBadge(l.address_state)}`}>{l.address_state}</span></td>
                      <td style={{ fontSize: 'var(--text-sm)' }}>{fmtDate(l.lease_expiry)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {canWrite && canReserve && (
                          <button onClick={() => setReserveTarget({ scope: scope!, lease: l })}
                            style={{ fontSize: 'var(--text-sm)', color: 'var(--purple)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
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
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
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
            <div style={{ fontWeight: 600, fontSize: 'var(--text-md)' }}>DHCP Reservations</div>
            <div style={{ flex: 1 }} />
            <input
              placeholder="Search IP, hostname, MAC…"
              value={reservationSearch}
              onChange={e => { setReservationSearch(e.target.value); loadReservations(e.target.value); }}
              style={{ ...INPUT, width: 280 }}
            />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{reservations.length.toLocaleString()} reservations</span>
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
                      <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{scope?.server_hostname || scope?.server_ip || '—'}</td>
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

      {/* Create scope modal */}
      {showCreateScope && (
        <CreateScopeModal
          servers={dhcpServers}
          onClose={() => setShowCreateScope(false)}
          onDone={() => { setShowCreateScope(false); loadScopes(); }}
        />
      )}

      {/* Edit scope modal */}
      {editScope && (
        <EditScopeModal
          scope={editScope}
          onClose={() => setEditScope(null)}
          onDone={() => { setEditScope(null); loadScopes(); }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// ScopeRow (module scope) — table row + inline accordion panel
// ════════════════════════════════════════════════════════════
function ScopeRow({
  scope, pct, forecast, isExpanded, lowFree, busy, onToggle, onReserve, onEdit, onToggleState, onDelete,
  leases, leasesLoading, leaseSearch, onLeaseSearch, onReserveLease,
}: {
  scope: Scope;
  pct: number;
  forecast?: ScopeForecast;
  isExpanded: boolean;
  lowFree: boolean;
  busy: boolean;
  onToggle: () => void;
  onReserve: () => void;
  onEdit: () => void;
  onToggleState: () => void;
  onDelete: () => void;
  leases: Lease[];
  leasesLoading: boolean;
  leaseSearch: string;
  onLeaseSearch: (v: string) => void;
  onReserveLease: (l: Lease) => void;
}) {
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;
  const stateActive = scope.state === 'Active';
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
        <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{scope.server_hostname || scope.server_ip || '—'}</td>
        <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{scope.start_range} – {scope.end_range}</td>
        <td style={{ textAlign: 'right' }}>{(scope.total_ips ?? 0).toLocaleString()}</td>
        <td style={{ textAlign: 'right' }}>{(scope.in_use ?? 0).toLocaleString()}</td>
        <td style={{ textAlign: 'right', color: lowFree ? 'var(--red)' : undefined, fontWeight: lowFree ? 700 : 400 }}>
          {(scope.free ?? 0).toLocaleString()}
        </td>
        <td><UtilBar pct={pct} /></td>
        <td style={{
          fontSize: 'var(--text-sm)', fontWeight: 600, whiteSpace: 'nowrap',
          color: isEmptyScope(scope) || !forecast || forecast.status === 'insufficient_data'
            ? 'var(--text-secondary)'
            : forecast.status === 'stable'
              ? 'var(--green)'
              : forecastColor(forecast.days_to_full),
        }}>
          {isEmptyScope(scope)
            ? '—'
            : !forecast || forecast.status === 'insufficient_data'
              ? '—'
              : forecast.status === 'stable'
                ? 'Stable'
                : (forecast.days_to_full == null ? 'Healthy' : `${forecast.days_to_full}d to full`)}
        </td>
        <td>
          {isEmptyScope(scope) ? (
            <span className={`badge ${stateBadge('Disabled')}`}>Empty</span>
          ) : (scope.free ?? 0) <= 0 ? (
            <span className={`badge ${stateBadge('Full')}`}>Full</span>
          ) : canWrite ? (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleState(); }}
              disabled={busy}
              title={stateActive ? 'Click to disable' : 'Click to enable'}
              className={`badge ${stateActive ? 'badge-green' : 'badge-gray'}`}
              style={{ cursor: busy ? 'default' : 'pointer', border: 'none', opacity: busy ? 0.6 : 1 }}
            >
              {busy ? <Spinner size={10} /> : scope.state}
            </button>
          ) : (
            <span className={`badge ${stateBadge(scope.state)}`}>{scope.state}</span>
          )}
        </td>
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          {canWrite && (
            <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
              <button
                onClick={(e) => { e.stopPropagation(); onReserve(); }}
                style={{ fontSize: 'var(--text-sm)', color: 'var(--purple)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
              >
                Reserve
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                style={{ fontSize: 'var(--text-sm)', color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
              >
                Edit
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                disabled={busy}
                style={{ fontSize: 'var(--text-sm)', color: 'var(--red)', background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer', fontWeight: 600, opacity: busy ? 0.6 : 1 }}
              >
                Delete
              </button>
            </span>
          )}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={11} style={{ padding: 0, background: 'var(--bg-primary)' }}>
            <div style={{ padding: 16 }}>
              <ScopeDetail scope={scope} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                <input
                  placeholder="Filter leases by IP, hostname, MAC…"
                  value={leaseSearch}
                  onChange={e => onLeaseSearch(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  style={{ ...INPUT, width: 280 }}
                />
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
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
                          <td style={{ fontSize: 'var(--text-sm)' }}>{fmtDate(l.lease_expiry)}</td>
                          <td style={{ textAlign: 'right' }}>
                            {canWrite && canReserve && (
                              <button onClick={(e) => { e.stopPropagation(); onReserveLease(l); }}
                                style={{ fontSize: 'var(--text-sm)', color: 'var(--purple)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
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
