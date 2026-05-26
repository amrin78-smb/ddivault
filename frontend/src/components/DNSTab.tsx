'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

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

const RECORD_COLORS: Record<string, string> = {
  A: '#2563eb', AAAA: '#7c3aed', CNAME: '#16a34a', MX: '#ca8a04',
  PTR: '#0891b2', TXT: '#ea580c', NS: '#6b7280', SRV: '#C8102E',
};

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ── Add Record Modal ──────────────────────────────────────────
function AddRecordModal({ zone, servers, onClose, onDone }: {
  zone: DnsZone; servers: DnsServer[]; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = useState({
    record_type: 'A', hostname: '', record_data: '', ttl: '3600', preference: '10',
  });
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const save = async () => {
    if (!form.hostname || !form.record_data) { toast('Hostname and record data required', 'error'); return; }
    setLoading(true);
    try {
      await api('/dns/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id: zone.server_id,
          zone_name: zone.zone_name,
          ...form,
        }),
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ ...CARD, padding: 24, width: 480 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Add DNS Record</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Zone: <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{zone.zone_name}</span>
              {' · '}Server: {servers.find(s => s.id === zone.server_id)?.hostname || zone.server_id}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ background: '#fef9c3', border: '1px solid #fde047', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 14, color: '#a16207' }}>
          ⚡ Runs PowerShell on the DNS server via WinRM. Requires DNS Server role and admin rights.
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Record Type</label>
          <select value={form.record_type} onChange={e => setForm(p => ({ ...p, record_type: e.target.value }))} style={INPUT}>
            {['A','AAAA','CNAME','MX','PTR','TXT','NS'].map(t => (
              <option key={t} value={t}>{t} — {
                t === 'A' ? 'IPv4 Address' : t === 'AAAA' ? 'IPv6 Address' :
                t === 'CNAME' ? 'Alias' : t === 'MX' ? 'Mail Exchange' :
                t === 'PTR' ? 'Reverse Lookup' : t === 'TXT' ? 'Text Record' : 'Name Server'
              }</option>
            ))}
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

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>TTL (seconds)</label>
          <select value={form.ttl} onChange={e => setForm(p => ({ ...p, ttl: e.target.value }))} style={INPUT}>
            <option value="300">300 — 5 minutes</option>
            <option value="3600">3600 — 1 hour</option>
            <option value="86400">86400 — 1 day</option>
            <option value="604800">604800 — 1 week</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={BTN}>Cancel</button>
          <button onClick={save} disabled={loading} style={{ ...BTN_RED, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Adding...' : '✓ Add Record on DNS Server'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Add Zone Modal ────────────────────────────────────────────
function AddZoneModal({ servers, onClose, onDone }: { servers: DnsServer[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ server_id: servers[0]?.id || '', zone_name: '', zone_type: 'Primary', replication_scope: 'Domain' });
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ ...CARD, padding: 24, width: 440 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Create DNS Zone</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)' }}>×</button>
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
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>AD Replication Scope</label>
            <select value={form.replication_scope} onChange={e => setForm(p => ({ ...p, replication_scope: e.target.value }))} style={INPUT}>
              <option value="Domain">Domain — all DCs in domain</option>
              <option value="Forest">Forest — all DCs in forest</option>
              <option value="Legacy">Legacy — all DNS servers in domain</option>
            </select>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={BTN}>Cancel</button>
          <button onClick={save} disabled={loading} style={{ ...BTN_RED, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Creating...' : '✓ Create Zone'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN DNS TAB
// ════════════════════════════════════════════════════════════
export default function DNSTab() {
  const [servers, setServers]     = useState<DnsServer[]>([]);
  const [zones, setZones]         = useState<DnsZone[]>([]);
  const [records, setRecords]     = useState<DnsRecord[]>([]);
  const [breakdown, setBreakdown] = useState<any[]>([]);
  const [selectedServer, setSelectedServer] = useState<number | null>(null);
  const [selectedZone, setSelectedZone]     = useState<DnsZone | null>(null);
  const [recordSearch, setRecordSearch]     = useState('');
  const [typeFilter, setTypeFilter]         = useState('');
  const [recordPage, setRecordPage]         = useState(1);
  const [recordTotal, setRecordTotal]       = useState(0);
  const [showAddZone, setShowAddZone]       = useState(false);
  const [showAddRecord, setShowAddRecord]   = useState(false);
  const [view, setView]                     = useState<'zones' | 'records' | 'overview'>('overview');
  const RECORD_LIMIT = 100;

  const { toast } = useToast();

  const loadServers = useCallback(async () => {
    const d = await api('/dns/servers').catch(() => null);
    if (d) {
      setServers(d.data || []);
      if (d.data?.length > 0 && !selectedServer) setSelectedServer(d.data[0].id);
    }
  }, []);

  const loadZones = useCallback(async () => {
    const d = await api('/dns/zones').catch(() => null);
    if (d) setZones(d.data || []);
  }, []);

  const loadBreakdown = useCallback(async () => {
    const d = await api('/dns/record-type-breakdown').catch(() => null);
    if (d) setBreakdown(d.data || []);
  }, []);

  const loadRecords = useCallback(async (page = 1) => {
    const params = new URLSearchParams({ page: String(page), limit: String(RECORD_LIMIT) });
    if (recordSearch) params.set('search', recordSearch);
    if (typeFilter)   params.set('type', typeFilter);
    if (selectedZone) params.set('zone_id', String(selectedZone.id));
    const d = await api(`/dns/records?${params}`).catch(() => null);
    if (d) { setRecords(d.data || []); setRecordTotal(d.total || 0); }
  }, [recordSearch, typeFilter, selectedZone]);

  useEffect(() => { loadServers(); loadZones(); loadBreakdown(); }, []);
  useEffect(() => { if (view === 'records') loadRecords(); }, [view, recordSearch, typeFilter, selectedZone]);

  const deleteRecord = async (record: DnsRecord) => {
    if (!confirm(`Delete ${record.record_type} record: ${record.hostname} → ${record.record_data}?`)) return;
    const zone = zones.find(z => z.id === record.zone_id);
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
      loadRecords();
      loadBreakdown();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const deleteZone = async (zone: DnsZone) => {
    if (!confirm(`Delete zone ${zone.zone_name}? This removes it from the DNS server!`)) return;
    try {
      await api(`/dns/zones/${zone.id}`, { method: 'DELETE' });
      toast(`Zone ${zone.zone_name} deleted`, 'success');
      loadZones();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  // Filter zones by selected server
  const filteredZones = selectedServer
    ? zones.filter(z => z.server_id === selectedServer)
    : zones;

  const forwardZones = filteredZones.filter(z => !z.is_reverse);
  const reverseZones = filteredZones.filter(z => z.is_reverse);
  const totalRecords = zones.reduce((a, z) => a + (z.record_count || 0), 0);

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>DNS Management</h2>
        <div style={{ flex: 1 }} />
        {/* Server selector */}
        {servers.length > 1 && (
          <select value={selectedServer || ''} onChange={e => setSelectedServer(parseInt(e.target.value))}
            style={{ ...INPUT, width: 220 }}>
            <option value="">All DNS Servers</option>
            {servers.map(s => (
              <option key={s.id} value={s.id}>
                {s.hostname} ({s.ip_address}) · {s.poll_status === 'ok' ? '✓' : '⚠'}
              </option>
            ))}
          </select>
        )}
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {(['overview','zones','records'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
              background: view === v ? '#1a2744' : 'var(--bg-card)',
              color: view === v ? '#fff' : 'var(--text-secondary)',
              textTransform: 'capitalize',
            }}>{v}</button>
          ))}
        </div>
        <button onClick={() => setShowAddZone(true)} style={BTN}>+ Zone</button>
        <button onClick={() => setShowAddRecord(true)} disabled={!selectedZone} style={{ ...BTN_RED, opacity: selectedZone ? 1 : 0.5 }}>
          + Record
        </button>
      </div>

      {/* Server status pills */}
      {servers.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {servers.map(s => (
            <div key={s.id}
              onClick={() => setSelectedServer(s.id === selectedServer ? null : s.id)}
              style={{
                padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 500,
                border: `2px solid ${selectedServer === s.id ? '#C8102E' : 'var(--border)'}`,
                background: selectedServer === s.id ? '#fff8f8' : 'var(--bg-card)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.poll_status === 'ok' ? '#16a34a' : '#dc2626' }} />
              <span style={{ fontWeight: 700 }}>{s.hostname}</span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11 }}>{s.ip_address}</span>
              <span className={`badge ${s.role === 'both' ? 'badge-blue' : 'badge-gray'}`} style={{ fontSize: 9 }}>{s.role}</span>
            </div>
          ))}
          {servers.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              No DNS servers found — add a server with role "DNS" or "DHCP + DNS" in Known Servers tab
            </div>
          )}
        </div>
      )}

      {/* ── OVERVIEW ── */}
      {view === 'overview' && (
        <>
          {/* KPI tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            {[
              { l: 'DNS Servers',    v: servers.length,    c: '#1a2744' },
              { l: 'Total Zones',    v: filteredZones.length, c: '#2563eb' },
              { l: 'Forward Zones',  v: forwardZones.length,  c: '#16a34a' },
              { l: 'Total Records',  v: totalRecords,      c: '#7c3aed' },
            ].map((t, i) => (
              <div key={i} style={{ ...CARD, padding: '14px 16px' }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: t.c }}>{t.v}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{t.l}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            {/* Zone list */}
            <div style={CARD}>
              <div style={{ padding: '12px 16px', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between' }}>
                <span>DNS Zones ({filteredZones.length})</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click zone to browse records</span>
              </div>
              <div style={{ maxHeight: 360, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={TH}>Zone Name</th><th style={TH}>Type</th>
                    <th style={TH}>Records</th><th style={TH}>Kind</th><th style={TH}>Server</th>
                  </tr></thead>
                  <tbody>
                    {filteredZones.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No zones — sync from a DNS server first</td></tr>}
                    {filteredZones.map(z => (
                      <tr key={z.id}
                        onClick={() => { setSelectedZone(z); setView('records'); }}
                        style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-primary)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td style={{ ...TD, fontWeight: 600 }}>{z.zone_name}</td>
                        <td style={TD}><span className="badge badge-blue" style={{ fontSize: 10 }}>{z.zone_type}</span></td>
                        <td style={TD}>{z.record_count || 0}</td>
                        <td style={TD}><span className={`badge ${z.is_reverse ? 'badge-orange' : 'badge-green'}`} style={{ fontSize: 10 }}>{z.is_reverse ? 'Reverse' : 'Forward'}</span></td>
                        <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>{z.server_hostname || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Record type breakdown chart */}
            <div style={{ ...CARD, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Record Types</div>
              {breakdown.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 20 }}>No records synced yet</div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={breakdown} dataKey="count" nameKey="record_type" cx="50%" cy="50%" outerRadius={75} innerRadius={40}>
                        {breakdown.map((b, i) => (
                          <Cell key={i} fill={RECORD_COLORS[b.record_type] || '#6b7280'} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: any, n: any) => [v, n]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {breakdown.map((b, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: RECORD_COLORS[b.record_type] || '#6b7280' }} />
                        <span style={{ color: 'var(--text-muted)' }}>{b.record_type}</span>
                        <span style={{ fontWeight: 600 }}>{b.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── ZONES VIEW ── */}
      {view === 'zones' && (
        <div style={CARD}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={TH}>Zone Name</th><th style={TH}>Server</th><th style={TH}>Type</th>
              <th style={TH}>Records</th><th style={TH}>AD Integrated</th><th style={TH}>Kind</th>
              <th style={TH}>Last Updated</th><th style={TH}></th>
            </tr></thead>
            <tbody>
              {filteredZones.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No zones</td></tr>}
              {filteredZones.map(z => (
                <tr key={z.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...TD, fontWeight: 600, cursor: 'pointer', color: '#2563eb' }}
                    onClick={() => { setSelectedZone(z); setView('records'); }}>
                    {z.zone_name}
                  </td>
                  <td style={{ ...TD, fontSize: 11 }}>{z.server_hostname || '—'}</td>
                  <td style={TD}><span className="badge badge-blue" style={{ fontSize: 10 }}>{z.zone_type}</span></td>
                  <td style={TD}>{z.record_count || 0}</td>
                  <td style={TD}><span className={`badge ${z.is_ds_integrated ? 'badge-green' : 'badge-gray'}`} style={{ fontSize: 10 }}>{z.is_ds_integrated ? 'Yes' : 'No'}</span></td>
                  <td style={TD}><span className={`badge ${z.is_reverse ? 'badge-orange' : 'badge-gray'}`} style={{ fontSize: 10 }}>{z.is_reverse ? 'Reverse' : 'Forward'}</span></td>
                  <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>{z.last_updated ? new Date(z.last_updated).toLocaleDateString() : '—'}</td>
                  <td style={TD}>
                    <button onClick={() => { setSelectedZone(z); setView('records'); }}
                      style={{ fontSize: 11, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', marginRight: 8 }}>Records</button>
                    <button onClick={() => deleteZone(z)}
                      style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── RECORDS VIEW ── */}
      {view === 'records' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Zone selector breadcrumb */}
          <div style={{ ...CARD, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Zone:</span>
            <select value={selectedZone?.id || ''} onChange={e => {
              const z = zones.find(z => z.id === parseInt(e.target.value));
              setSelectedZone(z || null);
            }} style={{ ...INPUT, width: 280 }}>
              <option value="">— All zones —</option>
              {filteredZones.map(z => <option key={z.id} value={z.id}>{z.zone_name} ({z.zone_type})</option>)}
            </select>
            {selectedZone && (
              <button onClick={() => setShowAddRecord(true)} style={BTN_RED}>+ Add Record</button>
            )}
            <div style={{ flex: 1 }} />
            <input placeholder="Search hostname or IP..." value={recordSearch}
              onChange={e => { setRecordSearch(e.target.value); setRecordPage(1); }}
              style={{ ...INPUT, width: 220 }} />
            <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setRecordPage(1); }}
              style={{ ...INPUT, width: 120 }}>
              <option value="">All types</option>
              {['A','AAAA','CNAME','MX','PTR','TXT','NS','SRV'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{recordTotal} records</span>
          </div>

          <div style={CARD}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={TH}>Hostname</th><th style={TH}>Type</th><th style={TH}>Data</th>
                <th style={TH}>TTL</th><th style={TH}>Zone</th><th style={TH}></th>
              </tr></thead>
              <tbody>
                {records.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                    {selectedZone ? 'No records — click + Add Record' : 'Select a zone to browse records'}
                  </td></tr>
                )}
                {records.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{r.hostname}</td>
                    <td style={TD}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: 4,
                        background: (RECORD_COLORS[r.record_type] || '#6b7280') + '22',
                        color: RECORD_COLORS[r.record_type] || '#6b7280',
                        fontSize: 11, fontWeight: 700,
                      }}>{r.record_type}</span>
                    </td>
                    <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.record_data}</td>
                    <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>{r.ttl}s</td>
                    <td style={{ ...TD, fontSize: 11, color: 'var(--text-muted)' }}>{r.zone_name}</td>
                    <td style={TD}>
                      <button onClick={() => deleteRecord(r)}
                        style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {recordTotal > RECORD_LIMIT && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: 12 }}>
                {recordPage > 1 && <button onClick={() => { setRecordPage(p => p-1); loadRecords(recordPage-1); }} style={BTN}>← Prev</button>}
                <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>Page {recordPage}</span>
                {records.length === RECORD_LIMIT && <button onClick={() => { setRecordPage(p => p+1); loadRecords(recordPage+1); }} style={BTN}>Next →</button>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      {showAddZone && <AddZoneModal servers={servers} onClose={() => setShowAddZone(false)} onDone={() => { setShowAddZone(false); loadZones(); }} />}
      {showAddRecord && selectedZone && (
        <AddRecordModal zone={selectedZone} servers={servers} onClose={() => setShowAddRecord(false)}
          onDone={() => { setShowAddRecord(false); loadRecords(); loadBreakdown(); }} />
      )}
    </div>
  );
}
