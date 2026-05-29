'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';
import IPAMImport from '@/components/IPAMImport';

// ── Types ─────────────────────────────────────────────────────
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
  ip_count: number;
  dhcp_count: number;
  unknown_count: number;
  reserved_count: number;
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

// ── Shared styles ─────────────────────────────────────────────
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow-sm)',
};

const BTN: React.CSSProperties = {
  padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--bg-card)', color: 'var(--text-primary)',
  cursor: 'pointer', fontSize: 12, fontWeight: 500,
};

const BTN_RED: React.CSSProperties = {
  ...BTN, background: '#C8102E', color: '#fff', border: 'none',
};

const INPUT: React.CSSProperties = {
  width: '100%', padding: '6px 10px', border: '1px solid var(--border)',
  borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13,
};

// ── Helpers ───────────────────────────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function pctColor(pct: number) {
  if (pct >= 90) return '#dc2626';
  if (pct >= 70) return '#ca8a04';
  return '#16a34a';
}

function statusColor(status: string): string {
  const m: Record<string, string> = {
    dhcp: '#2563eb', available: '#16a34a', reserved: '#7c3aed',
    unknown: '#ea580c', offline: '#6b7280',
  };
  return m[status] || '#6b7280';
}

function statusBadge(status: string): string {
  const m: Record<string, string> = {
    dhcp: 'badge-blue', available: 'badge-green', reserved: 'badge-gray',
    unknown: 'badge-orange', offline: 'badge-gray',
  };
  return `badge ${m[status] || 'badge-gray'}`;
}

function totalHosts(prefix: number) {
  return Math.max(0, Math.pow(2, 32 - prefix) - 2);
}

// ── Utilization bar ───────────────────────────────────────────
function UtilBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, minWidth: 60 }}>
        <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: pctColor(pct), borderRadius: 3, transition: 'width 0.4s' }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: pctColor(pct), minWidth: 38 }}>{pct.toFixed(1)}%</span>
    </div>
  );
}

// ── Modal wrapper ─────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ ...CARD, width: 520, maxHeight: '85vh', overflow: 'auto', padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Form field helper ─────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// SUB-VIEW: IP Address Table for a subnet
// ════════════════════════════════════════════════════════════
function IPAddressTable({ subnet, onClose }: { subnet: Subnet; onClose: () => void }) {
  const [addresses, setAddresses] = useState<IPAddress[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState('');
  const [statusFilter, setStatus] = useState('');
  const [scanning, setScanning]   = useState(false);
  const [reserveModal, setReserveModal] = useState<string | null>(null);
  const [reserveForm, setReserveForm]   = useState({ description: '', owner: '' });
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api(`/ipam/subnets/${subnet.id}/addresses${statusFilter ? `?status=${statusFilter}` : ''}`);
      setAddresses(d.data || []);
    } finally { setLoading(false); }
  }, [subnet.id, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Poll scan status while scanning
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
  }, [scanning]);

  const startScan = async () => {
    setScanning(true);
    toast(`Scanning ${subnet.network}/${subnet.prefix_length}...`, 'info');
    await api(`/ipam/subnets/${subnet.id}/scan`, { method: 'POST' });
  };

  const reserveIP = async () => {
    if (!reserveModal) return;
    await api(`/ipam/subnets/${subnet.id}/addresses/${reserveModal}/reserve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...reserveForm, reserved_by: 'admin' }),
    });
    toast(`${reserveModal} reserved`, 'success');
    setReserveModal(null);
    load();
  };

  const releaseIP = async (ip: string) => {
    if (!confirm(`Release reservation for ${ip}?`)) return;
    await api(`/ipam/subnets/${subnet.id}/addresses/${ip}/release`, { method: 'POST' });
    toast(`${ip} released`, 'info');
    load();
  };

  const filtered = addresses.filter(a => {
    const q = filter.toLowerCase();
    return !q || a.ip_address?.includes(q) || a.hostname?.toLowerCase().includes(q) || a.mac_address?.toLowerCase().includes(q);
  });

  // Status summary counts
  const counts = addresses.reduce((acc, a) => { acc[a.status] = (acc[a.status] || 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)', zIndex: 200, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ background: '#1a2744', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 6, color: '#fff', padding: '4px 10px', cursor: 'pointer', fontSize: 13 }}>← Back</button>
        <div>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>{subnet.name || `${subnet.network}/${subnet.prefix_length}`}</div>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontFamily: 'monospace' }}>{subnet.network}/{subnet.prefix_length} · {subnet.gateway ? `GW: ${subnet.gateway}` : 'No gateway'}</div>
        </div>
        <div style={{ flex: 1 }} />
        {/* Status pills */}
        {Object.entries(counts).map(([s, n]) => (
          <div key={s} style={{ padding: '3px 10px', borderRadius: 12, background: statusColor(s) + '22', border: `1px solid ${statusColor(s)}44`, fontSize: 11, color: statusColor(s), fontWeight: 600 }}>
            {n} {s}
          </div>
        ))}
        <button
          onClick={async () => {
            const d = await api('/ipam/subnets/' + subnet.id + '/next-ip').catch(() => null);
            if (d?.available) {
              toast('Next available IP: ' + d.ip, 'success');
            } else {
              toast('Subnet is full', 'error');
            }
          }}
          style={{ ...BTN, fontSize: 12, background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe' }}
        >
          Next Available IP
        </button>
        <button
          onClick={startScan}
          disabled={scanning}
          style={{ ...BTN_RED, opacity: scanning ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {scanning ? '⟳ Scanning...' : '⟳ Scan Now'}
        </button>
      </div>

      {/* Filters */}
      <div style={{ padding: '12px 20px', display: 'flex', gap: 10, background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <input
          placeholder="Search IP, hostname, MAC..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ ...INPUT, width: 280 }}
        />
        <select value={statusFilter} onChange={e => setStatus(e.target.value)}
          style={{ ...INPUT, width: 150 }}>
          <option value="">All statuses</option>
          <option value="available">Available</option>
          <option value="dhcp">DHCP</option>
          <option value="reserved">Reserved</option>
          <option value="unknown">Unknown</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
          {filtered.length} / {addresses.length} IPs
          {subnet.last_scanned && ` · Last scanned: ${new Date(subnet.last_scanned).toLocaleString()}`}
        </span>
      </div>

      {/* IP Table */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 20px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading...</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
            <thead>
              <tr>
                <th style={TH}>IP Address</th>
                <th style={TH}>Status</th>
                <th style={TH}>Hostname</th>
                <th style={TH}>MAC Address</th>
                <th style={TH}>Ping (ms)</th>
                <th style={TH}>Last Seen</th>
                <th style={TH}>Description / Owner</th>
                <th style={TH}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                  {addresses.length === 0 ? 'No data yet — click Scan Now to discover hosts' : 'No results'}
                </td></tr>
              )}
              {filtered.map(addr => (
                <tr key={addr.ip_address} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{addr.ip_address}</td>
                  <td style={TD}>
                    <span className={statusBadge(addr.status)} style={{ background: statusColor(addr.status) + '22', color: statusColor(addr.status), border: `1px solid ${statusColor(addr.status)}44` }}>
                      {addr.status}
                    </span>
                  </td>
                  <td style={TD}>{addr.hostname || '—'}</td>
                  <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{addr.mac_address || '—'}</td>
                  <td style={TD}>{addr.ping_ms != null ? `${addr.ping_ms}ms` : '—'}</td>
                  <td style={{ ...TD, fontSize: 11 }}>{addr.last_seen ? new Date(addr.last_seen).toLocaleString() : '—'}</td>
                  <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>
                    {addr.description || ''}{addr.owner ? ` (${addr.owner})` : ''}
                    {addr.is_reserved && addr.reserved_by ? <span style={{ color: '#7c3aed', marginLeft: 4 }}>· {addr.reserved_by}</span> : ''}
                  </td>
                  <td style={TD}>
                    {addr.is_reserved ? (
                      <button onClick={() => releaseIP(addr.ip_address)} style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Release</button>
                    ) : addr.status === 'available' || addr.status === 'unknown' ? (
                      <button onClick={() => { setReserveModal(addr.ip_address); setReserveForm({ description: '', owner: '' }); }}
                        style={{ fontSize: 11, color: '#7c3aed', background: 'none', border: 'none', cursor: 'pointer' }}>Reserve</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reserve modal */}
      {reserveModal && (
        <Modal title={`Reserve ${reserveModal}`} onClose={() => setReserveModal(null)}>
          <Field label="Purpose / Description">
            <input value={reserveForm.description} onChange={e => setReserveForm(p => ({ ...p, description: e.target.value }))} style={INPUT} placeholder="e.g. Printer, Server, Gateway" />
          </Field>
          <Field label="Owner">
            <input value={reserveForm.owner} onChange={e => setReserveForm(p => ({ ...p, owner: e.target.value }))} style={INPUT} placeholder="e.g. IT Team, John Smith" />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => setReserveModal(null)} style={BTN}>Cancel</button>
            <button onClick={reserveIP} style={BTN_RED}>Reserve IP</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const TH: React.CSSProperties = {
  background: '#f9fafb', color: '#6b7280', fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.05em', padding: '10px 12px',
  borderBottom: '1px solid var(--border)', textAlign: 'left', whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = { padding: '9px 12px', fontSize: 13, color: 'var(--text-primary)' };

// ════════════════════════════════════════════════════════════
// MAIN IPAM TAB
// ════════════════════════════════════════════════════════════
export default function IPAMTab() {
  const [supernets, setSupernets]   = useState<Supernet[]>([]);
  const [subnets, setSubnets]       = useState<Subnet[]>([]);
  const [vlans, setVlans]           = useState<Vlan[]>([]);
  const [sites, setSites]           = useState<{id:number;name:string;code:string;city:string}[]>([]);
  const [expanded, setExpanded]     = useState<Set<number>>(new Set());
  const [selectedSubnet, setSelectedSubnet] = useState<Subnet | null>(null);
  const [view, setView]             = useState<'tree' | 'flat' | 'vlans'>('tree');
  const [showImport, setShowImport]           = useState(false);
  const [nextIpResult, setNextIpResult]       = useState<Record<number,string>>({});
  const [nextSubnetResult, setNextSubnetResult] = useState<Record<number,string>>({});
  const [conflicts, setConflicts]             = useState<any[]>([]);
  const [showAddSupernet, setShowAddSupernet] = useState(false);
  const [showAddSubnet, setShowAddSubnet]     = useState(false);
  const [showAddVlan, setShowAddVlan]         = useState(false);
  const [subnetSupernet, setSubnetSupernet]   = useState<number | null>(null);

  const [supernetForm, setSupernetForm] = useState({ network: '', prefix_length: '8', name: '', description: '', site: '' });
  const [subnetForm, setSubnetForm]     = useState({ network: '', prefix_length: '24', name: '', description: '', gateway: '', vlan_id: '', site: '', owner: '', location: '', notes: '' });
  const [vlanForm, setVlanForm]         = useState({ vlan_id: '', name: '', description: '', site: '' });

  const { toast } = useToast();

  // ── Global scan progress ──────────────────────────────────
  const [scanStatus, setScanStatus] = useState<any>(null);

  useEffect(() => {
    const checkScan = async () => {
      const d = await api('/ipam/scan-status').catch(() => null);
      if (d) setScanStatus(d);
    };
    checkScan();
    const t = setInterval(checkScan, 3000);
    return () => clearInterval(t);
  }, []);

  const checkConflicts = async () => {
    const d = await api('/ipam/conflicts').catch(() => null);
    if (d) setConflicts(d.data || []);
  };

  const loadAll = async () => {
    const [sn, sub, vl, si] = await Promise.allSettled([
      api('/ipam/supernets'),
      api('/ipam/subnets'),
      api('/ipam/vlans'),
      api('/sites'),
    ]);
    if (sn.status  === 'fulfilled') setSupernets(sn.value.data  || []);
    if (sub.status === 'fulfilled') setSubnets(sub.value.data   || []);
    if (vl.status  === 'fulfilled') setVlans(vl.value.data      || []);
    if (si.status  === 'fulfilled') setSites(si.value.data      || []);
    checkConflicts();
  };

  useEffect(() => { loadAll(); }, []);

  // Reload subnets when scan completes
  const prevActiveScan = useState<number | null>(null);
  useEffect(() => {
    if (scanStatus?.active_scans === 0 && prevActiveScan[0] !== null && prevActiveScan[0] > 0) {
      loadAll();
    }
    if (scanStatus) prevActiveScan[1](scanStatus.active_scans);
  }, [scanStatus?.active_scans]);

  const toggleExpanded = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const addSupernet = async () => {
    try {
      await api('/ipam/supernets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(supernetForm) });
      toast('Supernet added', 'success');
      setShowAddSupernet(false);
      setSupernetForm({ network: '', prefix_length: '8', name: '', description: '', site: '' });
      loadAll();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const addSubnet = async () => {
    try {
      await api('/ipam/subnets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...subnetForm, supernet_id: subnetSupernet }) });
      toast('Subnet added', 'success');
      setShowAddSubnet(false);
      setSubnetForm({ network: '', prefix_length: '24', name: '', description: '', gateway: '', vlan_id: '', site: '', owner: '', location: '', notes: '' });
      loadAll();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const addVlan = async () => {
    try {
      await api('/ipam/vlans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vlanForm) });
      toast('VLAN added', 'success');
      setShowAddVlan(false);
      setVlanForm({ vlan_id: '', name: '', description: '', site: '' });
      loadAll();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const deleteSupernet = async (id: number) => {
    if (!confirm('Delete supernet? Subnets will be unlinked but not deleted.')) return;
    await api(`/ipam/supernets/${id}`, { method: 'DELETE' });
    toast('Supernet deleted', 'info');
    loadAll();
  };

  const deleteSubnet = async (id: number) => {
    if (!confirm('Delete subnet? All IP address data will be removed.')) return;
    await api(`/ipam/subnets/${id}`, { method: 'DELETE' });
    toast('Subnet deleted', 'info');
    loadAll();
  };

  const scanSubnet = async (subnet: Subnet) => {
    toast(`Scanning ${subnet.network}/${subnet.prefix_length}...`, 'info');
    await api(`/ipam/subnets/${subnet.id}/scan`, { method: 'POST' });
    toast('Scan started — refresh in a moment', 'success');
    setTimeout(loadAll, 10000);
  };

  const scanAll = async () => {
    toast('Full IPAM scan started', 'info');
    await api('/ipam/scan-all', { method: 'POST' });
  };

  // Subnets not linked to any supernet
  const orphanSubnets = subnets.filter(s => !s.supernet_id);

  // If viewing a specific subnet's IPs
  if (selectedSubnet) {
    return <IPAddressTable subnet={selectedSubnet} onClose={() => { setSelectedSubnet(null); loadAll(); }} />;
  }

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>IPAM — IP Address Management</h2>
        <div style={{ flex: 1 }} />
        {/* View toggle */}
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {(['tree','flat','vlans'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
              background: view === v ? '#1a2744' : 'var(--bg-card)',
              color: view === v ? '#fff' : 'var(--text-secondary)',
            }}>
              {v === 'tree' ? '🌲 Tree' : v === 'flat' ? '📋 All Subnets' : '🏷 VLANs'}
            </button>
          ))}
        </div>
        <button onClick={() => setShowImport(true)} style={BTN}>⬆ Import CSV</button>
        <button onClick={() => setShowAddSupernet(true)} style={BTN}>+ Supernet</button>
        <button onClick={() => { setSubnetSupernet(null); setShowAddSubnet(true); }} style={BTN}>+ Subnet</button>
        <button onClick={scanAll} style={BTN_RED}>⟳ Scan All</button>
      </div>

      {/* Summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        {[
          { label: 'Supernets',  value: supernets.length,                        color: '#1a2744' },
          { label: 'Subnets',    value: subnets.length,                           color: '#2563eb' },
          { label: 'Total IPs',  value: subnets.reduce((a,s) => a + (s.total_hosts||0), 0), color: '#7c3aed' },
          { label: 'Unknown',    value: subnets.reduce((a,s) => a + (s.unknown_hosts||0), 0),
            color: subnets.reduce((a,s) => a + (s.unknown_hosts||0), 0) > 0 ? '#ea580c' : '#16a34a' },
        ].map((t,i) => (
          <div key={i} style={{ ...CARD, padding: 16 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: t.color }}>{t.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{t.label}</div>
          </div>
        ))}
      </div>

      {/* ── Scan Progress Panel ── */}
      {scanStatus && scanStatus.active_scans > 0 && (
        <div style={{ ...CARD, padding: 16, borderLeft: '4px solid #C8102E', background: '#fff8f8' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#C8102E', animation: 'pulse 1s infinite' }} />
            <div style={{ fontWeight: 700, fontSize: 13, color: '#C8102E' }}>
              Scanning {scanStatus.active_scans} subnet{scanStatus.active_scans > 1 ? 's' : ''}...
            </div>
          </div>
          {scanStatus.subnets?.filter((s: any) => s.scan_status === 'scanning').map((s: any) => {
            const total = s.total_hosts || 1;
            const scanned = (s.used_hosts || 0) + (s.free_hosts || 0) + (s.unknown_hosts || 0);
            const pct = Math.min(100, Math.round((scanned / total) * 100));
            return (
              <div key={s.id} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 600 }}>{s.network}/{s.prefix_length}{s.name ? ` — ${s.name}` : ''}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{scanned} / {total} hosts · {pct}%</span>
                </div>
                <div style={{ height: 6, background: '#fee2e2', borderRadius: 3 }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: '#C8102E', borderRadius: 3, transition: 'width 0.5s' }} />
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span style={{ color: '#2563eb' }}>● {s.used_hosts || 0} DHCP</span>
                  <span style={{ color: '#16a34a' }}>● {s.free_hosts || 0} free</span>
                  <span style={{ color: '#ea580c' }}>● {s.unknown_hosts || 0} unknown</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recently completed scan results */}
      {scanStatus && scanStatus.active_scans === 0 && scanStatus.subnets?.some((s: any) => s.scan_status === 'done') && (
        <div style={{ ...CARD, padding: '10px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>Last Scan Results</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {scanStatus.subnets?.filter((s: any) => s.scan_status === 'done' && s.last_scanned).map((s: any) => {
              const total = s.total_hosts || 0;
              const pct   = total > 0 ? Math.round((s.used_hosts / total) * 100) : 0;
              return (
                <div key={s.id} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 11 }}>
                  <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{s.network}/{s.prefix_length}</div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                    {s.used_hosts}/{total} used · {s.unknown_hosts > 0 ? <span style={{ color: '#ea580c' }}>⚠ {s.unknown_hosts} unknown</span> : <span style={{ color: '#16a34a' }}>✓ clean</span>}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {new Date(s.last_scanned).toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── TREE VIEW ── */}
      {view === 'tree' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {supernets.length === 0 && orphanSubnets.length === 0 && (
            <div style={{ ...CARD, padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              No networks configured yet.<br />
              <span style={{ fontSize: 12 }}>Add a Supernet (e.g. 10.0.0.0/8) then add Subnets under it.</span>
            </div>
          )}

          {supernets.map(sn => {
            const children = subnets.filter(s => s.supernet_id === sn.id);
            const isOpen   = expanded.has(sn.id);
            const totalUsed = children.reduce((a, s) => a + (s.used_hosts || 0), 0);
            const totalAll  = children.reduce((a, s) => a + (s.total_hosts || 0), 0);

            return (
              <div key={sn.id} style={{ ...CARD, overflow: 'hidden' }}>
                {/* Supernet row */}
                <div
                  onClick={() => toggleExpanded(sn.id)}
                  style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', borderBottom: isOpen ? '1px solid var(--border)' : 'none' }}
                >
                  <span style={{ fontSize: 14, color: 'var(--text-muted)', transition: 'transform 0.2s', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#1a2744', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                      {sn.name || `${sn.network}/${sn.prefix_length}`}
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)', marginLeft: 10 }}>{sn.network}/{sn.prefix_length}</span>
                    </div>
                    {sn.site && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sn.site}</div>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{children.length} subnets</div>
                  {totalAll > 0 && (
                    <div style={{ width: 200 }}>
                      <UtilBar used={totalUsed} total={totalAll} />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={e => { e.stopPropagation(); setSubnetSupernet(sn.id); setShowAddSubnet(true); }}
                      style={{ ...BTN, fontSize: 11, padding: '3px 8px' }}>+ Subnet</button>
                    <select
                      id={'pfx-' + sn.id}
                      defaultValue="24"
                      onClick={e => e.stopPropagation()}
                      style={{ fontSize: 11, padding: '3px 6px', border: '1px solid #bfdbfe', borderRadius: 6, background: '#eff6ff', color: '#2563eb', cursor: 'pointer' }}
                    >
                      {[24,25,26,27,28,29,30].map(p => <option key={p} value={p}>/{p}</option>)}
                    </select>
                    <button onClick={async e => {
                      e.stopPropagation();
                      const sel = document.getElementById('pfx-' + sn.id) as HTMLSelectElement;
                      const prefix = sel?.value || '24';
                      const d = await api('/ipam/supernets/' + sn.id + '/next-subnet?prefix=' + prefix).catch(() => null);
                      setNextSubnetResult(p => ({ ...p, [sn.id]: d?.available ? d.subnet : 'None available' }));
                    }} style={{ ...BTN, fontSize: 11, padding: '3px 8px', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe' }}>
                      Next Free
                    </button>
                    {nextSubnetResult[sn.id] && (
                      <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#2563eb', fontWeight: 600 }}>
                        {nextSubnetResult[sn.id]}
                      </span>
                    )}
                    <button onClick={e => { e.stopPropagation(); deleteSupernet(sn.id); }}
                      style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                  </div>
                </div>

                {/* Subnet rows */}
                {isOpen && children.map(sub => (
                  <SubnetRow key={sub.id} subnet={sub} onView={() => setSelectedSubnet(sub)} onScan={() => scanSubnet(sub)} onDelete={() => deleteSubnet(sub.id)} />
                ))}
                {isOpen && children.length === 0 && (
                  <div style={{ padding: '16px 48px', color: 'var(--text-muted)', fontSize: 13 }}>
                    No subnets yet — click + Subnet to add one
                  </div>
                )}
              </div>
            );
          })}

          {/* Orphan subnets (no supernet) */}
          {orphanSubnets.length > 0 && (
            <div style={CARD}>
              <div style={{ padding: '12px 16px', fontWeight: 600, fontSize: 13, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                Unassigned Subnets
              </div>
              {orphanSubnets.map(sub => (
                <SubnetRow key={sub.id} subnet={sub} onView={() => setSelectedSubnet(sub)} onScan={() => scanSubnet(sub)} onDelete={() => deleteSubnet(sub.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── FLAT VIEW ── */}
      {view === 'flat' && (
        <div style={CARD}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH}>Network</th>
                <th style={TH}>Name</th>
                <th style={TH}>Supernet</th>
                <th style={TH}>Gateway</th>
                <th style={TH}>VLAN</th>
                <th style={TH}>Site</th>
                <th style={TH}>Used / Total</th>
                <th style={TH}>Utilization</th>
                <th style={TH}>Unknown</th>
                <th style={TH}>Scan</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {subnets.length === 0 && <tr><td colSpan={11} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No subnets configured</td></tr>}
              {subnets.map(sub => (
                <tr key={sub.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => setSelectedSubnet(sub)}>
                  <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{sub.network}/{sub.prefix_length}</td>
                  <td style={TD}>{sub.name || '—'}</td>
                  <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>{sub.supernet_name || '—'}</td>
                  <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11 }}>{sub.gateway || '—'}</td>
                  <td style={TD}>{sub.vlan_id || '—'}</td>
                  <td style={TD}>{sub.site || '—'}</td>
                  <td style={TD}>{sub.used_hosts} / {sub.total_hosts || totalHosts(sub.prefix_length)}</td>
                  <td style={{ ...TD, minWidth: 150 }}><UtilBar used={sub.used_hosts} total={sub.total_hosts || totalHosts(sub.prefix_length)} /></td>
                  <td style={TD}>{sub.unknown_hosts > 0 ? <span style={{ color: '#ea580c', fontWeight: 600 }}>{sub.unknown_hosts}</span> : <span style={{ color: '#16a34a' }}>0</span>}</td>
                  <td style={TD}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {sub.scan_status === 'scanning' ? '⟳ Scanning...' :
                       sub.scan_status === 'done' && sub.last_scanned ? new Date(sub.last_scanned).toLocaleDateString() :
                       sub.scan_status === 'error' ? '⚠ Error' : 'Never'}
                    </span>
                  </td>
                  <td style={TD} onClick={e => e.stopPropagation()}>
                    <button onClick={() => scanSubnet(sub)} style={{ fontSize: 11, color: '#C8102E', background: 'none', border: 'none', cursor: 'pointer' }}>Scan</button>
                    <button onClick={() => deleteSubnet(sub.id)} style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 8 }}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── VLAN VIEW ── */}
      {view === 'vlans' && (
        <div style={CARD}>
          <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600 }}>VLAN Registry</div>
            <button onClick={() => setShowAddVlan(true)} style={BTN_RED}>+ Add VLAN</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={TH}>VLAN ID</th><th style={TH}>Name</th><th style={TH}>Description</th><th style={TH}>Site</th>
              <th style={TH}>Subnets</th><th style={TH}></th>
            </tr></thead>
            <tbody>
              {vlans.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No VLANs configured</td></tr>}
              {vlans.map(v => (
                <tr key={v.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...TD, fontWeight: 700, fontFamily: 'monospace' }}>VLAN {v.vlan_id}</td>
                  <td style={TD}>{v.name || '—'}</td>
                  <td style={{ ...TD, color: 'var(--text-muted)' }}>{v.description || '—'}</td>
                  <td style={TD}>{v.site || '—'}</td>
                  <td style={TD}>{subnets.filter(s => s.vlan_id === v.vlan_id).length}</td>
                  <td style={TD}>
                    <button onClick={() => api(`/ipam/vlans/${v.id}`, { method: 'DELETE' }).then(loadAll)}
                      style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── MODALS ── */}

      {showImport && <IPAMImport onDone={() => { setShowImport(false); loadAll(); }} />}
      {showAddSupernet && (
        <Modal title="Add Supernet" onClose={() => setShowAddSupernet(false)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { k: 'network', l: 'Network (e.g. 10.0.0.0)', full: true },
              { k: 'prefix_length', l: 'Prefix Length (e.g. 8)' },
              { k: 'name', l: 'Name' },
              { k: 'description', l: 'Description', full: true },
            ].map(f => (
              <div key={f.k} style={f.full ? { gridColumn: '1/-1' } : {}}>
                <Field label={f.l}>
                  <input value={(supernetForm as any)[f.k]} onChange={e => setSupernetForm(p => ({ ...p, [f.k]: e.target.value }))} style={INPUT} />
                </Field>
              </div>
            ))}
            <div style={{ gridColumn: '1/-1' }}>
              <Field label="Site (from NetVault)">
                <select value={supernetForm.site} onChange={e => setSupernetForm(p => ({ ...p, site: e.target.value }))} style={INPUT}>
                  <option value="">— No site —</option>
                  {sites.map(s => <option key={s.id} value={s.name}>{s.name}{s.code ? ` (${s.code})` : ''}{s.city ? ` · ${s.city}` : ''}</option>)}
                </select>
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setShowAddSupernet(false)} style={BTN}>Cancel</button>
            <button onClick={addSupernet} style={BTN_RED}>Add Supernet</button>
          </div>
        </Modal>
      )}

      {showAddSubnet && (
        <Modal title="Add Subnet" onClose={() => setShowAddSubnet(false)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { k: 'network', l: 'Network (e.g. 192.168.1.0)', full: true },
              { k: 'prefix_length', l: 'Prefix (e.g. 24)' },
              { k: 'name', l: 'Name' },
              { k: 'gateway', l: 'Gateway IP' },
              { k: 'vlan_id', l: 'VLAN ID' },
              { k: 'owner', l: 'Owner' },
              { k: 'location', l: 'Location' },
              { k: 'description', l: 'Description', full: true },
              { k: 'notes', l: 'Notes', full: true },
            ].map(f => (
              <div key={f.k} style={f.full ? { gridColumn: '1/-1' } : {}}>
                <Field label={f.l}>
                  <input value={(subnetForm as any)[f.k]} onChange={e => setSubnetForm(p => ({ ...p, [f.k]: e.target.value }))} style={INPUT} />
                </Field>
              </div>
            ))}
            <div style={{ gridColumn: '1/-1' }}>
              <Field label="Site (from NetVault)">
                <select value={subnetForm.site} onChange={e => setSubnetForm(p => ({ ...p, site: e.target.value }))} style={INPUT}>
                  <option value="">— No site —</option>
                  {sites.map(s => <option key={s.id} value={s.name}>{s.name}{s.code ? ` (${s.code})` : ''}{s.city ? ` · ${s.city}` : ''}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <Field label="Supernet (optional)">
                <select value={subnetSupernet || ''} onChange={e => setSubnetSupernet(e.target.value ? parseInt(e.target.value) : null)} style={INPUT}>
                  <option value="">None</option>
                  {supernets.map(sn => <option key={sn.id} value={sn.id}>{sn.name || `${sn.network}/${sn.prefix_length}`}</option>)}
                </select>
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setShowAddSubnet(false)} style={BTN}>Cancel</button>
            <button onClick={addSubnet} style={BTN_RED}>Add Subnet</button>
          </div>
        </Modal>
      )}

      {showAddVlan && (
        <Modal title="Add VLAN" onClose={() => setShowAddVlan(false)}>
          {[
            { k: 'vlan_id', l: 'VLAN ID (number)' },
            { k: 'name', l: 'Name' },
            { k: 'site', l: 'Site' },
            { k: 'description', l: 'Description' },
          ].map(f => (
            <Field key={f.k} label={f.l}>
              <input value={(vlanForm as any)[f.k]} onChange={e => setVlanForm(p => ({ ...p, [f.k]: e.target.value }))} style={INPUT} />
            </Field>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setShowAddVlan(false)} style={BTN}>Cancel</button>
            <button onClick={addVlan} style={BTN_RED}>Add VLAN</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Subnet row component ──────────────────────────────────────
function SubnetRow({ subnet, onView, onScan, onDelete }: { subnet: Subnet; onView: () => void; onScan: () => void; onDelete: () => void }) {
  const total   = subnet.total_hosts || Math.max(0, Math.pow(2, 32 - subnet.prefix_length) - 2);
  const used    = subnet.used_hosts  || 0;
  const unknown = subnet.unknown_hosts || 0;

  return (
    <div
      onClick={onView}
      style={{ padding: '10px 16px 10px 40px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', borderBottom: '1px solid var(--border)', transition: 'background 0.15s' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-primary)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#2563eb', flexShrink: 0 }} />
      <div style={{ minWidth: 160 }}>
        <div style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>{subnet.network}/{subnet.prefix_length}</div>
        {subnet.name && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{subnet.name}</div>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 80 }}>{subnet.gateway ? `GW: ${subnet.gateway}` : ''}</div>
      {subnet.vlan_id && <div style={{ fontSize: 11 }}><span className="badge badge-blue">VLAN {subnet.vlan_id}</span></div>}
      <div style={{ flex: 1 }}><UtilBar used={used} total={total} /></div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 80, textAlign: 'right' }}>{used}/{total} used</div>
      {unknown > 0 && <div style={{ fontSize: 11, fontWeight: 600, color: '#ea580c', minWidth: 60 }}>⚠ {unknown} unknown</div>}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 70 }}>
        {subnet.scan_status === 'scanning' ? '⟳ Scanning' :
         subnet.scan_status === 'done' && subnet.last_scanned ? `✓ ${new Date(subnet.last_scanned).toLocaleDateString()}` :
         subnet.scan_status === 'error' ? '⚠ Error' : 'Not scanned'}
      </div>
      <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
        <button onClick={onScan} style={{ fontSize: 11, color: '#C8102E', background: 'none', border: 'none', cursor: 'pointer' }}>Scan</button>
        <button onClick={onDelete} style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Del</button>
      </div>
    </div>
  );
}
