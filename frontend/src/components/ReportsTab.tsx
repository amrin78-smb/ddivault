'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader, EmptyState, TableSkeleton } from '@/components/ui';
import { useToast } from '@/components/Toast';

const CARD: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)' };
const TITLE: React.CSSProperties = { fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)' };

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

interface Column { key: string; label: string; align?: string }
interface Summary { label: string; value: string | number; color?: string }
interface ReportData { title: string; columns: Column[]; rows: Record<string, unknown>[]; summary?: Summary[] }
interface Site { id: number; name: string }
interface Server { id: number; hostname: string }
interface RecentReport { key: string; title: string; format: string; at: string; params: string }

// icon factory
const I = (p: React.ReactNode) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;

interface ReportDef {
  key: string; title: string; desc: string; icon: React.ReactNode; color: string;
  filters: ('site' | 'server' | 'dates' | 'days')[];
}
const REPORTS: ReportDef[] = [
  { key: 'subnet-utilization', title: 'Subnet Utilization', desc: 'Per-subnet usage, exhaustion forecast and site breakdown.', color: 'var(--blue)', filters: ['site'], icon: I(<><line x1="4" y1="20" x2="4" y2="10"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="14"/><line x1="22" y1="20" x2="2" y2="20"/></>) },
  { key: 'ip-inventory', title: 'IP Address Inventory', desc: 'Every assigned IP with hostname, MAC, lease status and stale flags.', color: 'var(--teal)', filters: ['site'], icon: I(<><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></>) },
  { key: 'dhcp-health', title: 'DHCP Scope Health', desc: 'Current vs peak utilization, trend and days-to-exhaustion per scope.', color: 'var(--primary)', filters: ['server'], icon: I(<><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></>) },
  { key: 'dns-zones', title: 'DNS Zone Report', desc: 'Record counts by type, SOA serials and stale-record analysis.', color: 'var(--navy)', filters: ['server'], icon: I(<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></>) },
  { key: 'network-changes', title: 'Network Change Report', desc: 'Who changed what and when — built for change-management reviews.', color: 'var(--purple)', filters: ['dates'], icon: I(<><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></>) },
  { key: 'rogue-devices', title: 'Security / Rogue Devices', desc: 'Unknown live devices with no DHCP lease — first/last seen.', color: 'var(--red)', filters: ['site', 'days'], icon: I(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></>) },
];

export default function ReportsTab() {
  const { toast } = useToast();
  const [sites, setSites] = useState<Site[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [active, setActive] = useState<ReportDef | null>(null);
  const [preview, setPreview] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<RecentReport[]>([]);

  // shared filter state
  const [siteId, setSiteId] = useState('');
  const [serverId, setServerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [days, setDays] = useState('30');
  const [format, setFormat] = useState<'view' | 'csv' | 'pdf'>('view');

  useEffect(() => {
    api('/sites').then(d => setSites(d.data || [])).catch(() => {});
    api('/servers').then(d => setServers(d.data || [])).catch(() => {});
  }, []);

  const buildParams = useCallback((def: ReportDef) => {
    const p = new URLSearchParams();
    if (def.filters.includes('site') && siteId) p.set('site_id', siteId);
    if (def.filters.includes('server') && serverId) p.set('server_id', serverId);
    if (def.filters.includes('dates') && from) p.set('from', new Date(from).toISOString());
    if (def.filters.includes('dates') && to) p.set('to', new Date(to).toISOString());
    if (def.filters.includes('days') && days) p.set('days', days);
    return p;
  }, [siteId, serverId, from, to, days]);

  const logRecent = (def: ReportDef, fmt: string, params: string) => {
    setRecent(prev => [{ key: def.key, title: def.title, format: fmt, at: new Date().toLocaleString(), params }, ...prev].slice(0, 10));
  };

  const generate = useCallback(async (def: ReportDef) => {
    setActive(def);
    const params = buildParams(def);
    if (format === 'view') {
      setLoading(true);
      setPreview(null);
      try {
        const data = await api(`/reports/${def.key}?${params.toString()}`);
        setPreview(data);
        logRecent(def, 'view', params.toString());
      } catch (e) {
        toast((e as Error).message || 'Report failed', 'error');
      }
      setLoading(false);
    } else {
      params.set('format', format);
      window.open(`/api/reports/${def.key}?${params.toString()}`, '_blank');
      logRecent(def, format, params.toString());
      toast(`Generating ${def.title} (${format.toUpperCase()})…`, 'success');
    }
  }, [buildParams, format, toast]);

  const downloadActive = (fmt: 'csv' | 'pdf') => {
    if (!active) return;
    const params = buildParams(active);
    params.set('format', fmt);
    window.open(`/api/reports/${active.key}?${params.toString()}`, '_blank');
    logRecent(active, fmt, params.toString());
  };

  const showSite = active?.filters.includes('site');
  const showServer = active?.filters.includes('server');
  const showDates = active?.filters.includes('dates');
  const showDays = active?.filters.includes('days');

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader title="Reports" subtitle="Generate professional, exportable reports for capacity planning, compliance and security reviews." />

      {/* Report cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {REPORTS.map(r => (
          <div key={r.key} style={{ ...CARD, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, border: active?.key === r.key ? '1px solid var(--primary)' : '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)', border: '1px solid var(--border)', color: r.color, flexShrink: 0 }}>{r.icon}</div>
              <div style={{ minWidth: 0 }}>
                <div style={TITLE}>{r.title}</div>
                <div style={{ ...MUTED, marginTop: 2 }}>{r.filters.length ? `Filters: ${r.filters.join(', ')}` : 'No filters'}</div>
              </div>
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5, minHeight: 38 }}>{r.desc}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => { setFormat('view'); generate(r); }}>View</button>
              <button className="btn" onClick={() => { setActive(r); setFormat('pdf'); const p = buildParams(r); p.set('format', 'pdf'); window.open(`/api/reports/${r.key}?${p.toString()}`, '_blank'); logRecent(r, 'pdf', p.toString()); }}>PDF</button>
              <button className="btn" onClick={() => { setActive(r); setFormat('csv'); const p = buildParams(r); p.set('format', 'csv'); window.open(`/api/reports/${r.key}?${p.toString()}`, '_blank'); logRecent(r, 'csv', p.toString()); }}>CSV</button>
            </div>
          </div>
        ))}
      </div>

      {/* Filters for the active report */}
      {active && (active.filters.length > 0) && (
        <div style={{ ...CARD, padding: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...TITLE, fontSize: 'var(--text-base)' }}>{active.title} filters:</span>
          {showSite && (
            <select className="input" value={siteId} onChange={e => setSiteId(e.target.value)}>
              <option value="">All sites</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {showServer && (
            <select className="input" value={serverId} onChange={e => setServerId(e.target.value)}>
              <option value="">All servers</option>
              {servers.map(s => <option key={s.id} value={s.id}>{s.hostname}</option>)}
            </select>
          )}
          {showDates && <><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} title="From" /><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} title="To" /></>}
          {showDays && (
            <select className="input" value={days} onChange={e => setDays(e.target.value)}>
              {['7', '30', '90'].map(d => <option key={d} value={d}>Last {d} days</option>)}
            </select>
          )}
          <button className="btn btn-primary" onClick={() => { setFormat('view'); generate(active); }}>Apply &amp; View</button>
        </div>
      )}

      {/* Preview panel */}
      {(loading || preview) && (
        <div style={CARD}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={TITLE}>{preview?.title || active?.title || 'Report preview'}</div>
            {preview && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ ...MUTED, padding: '6px 0' }}>{preview.rows.length} rows</span>
                <button className="btn" onClick={() => downloadActive('csv')}>Download CSV</button>
                <button className="btn btn-primary" onClick={() => downloadActive('pdf')}>Download PDF</button>
              </div>
            )}
          </div>

          {/* summary chips */}
          {preview?.summary && preview.summary.length > 0 && (
            <div style={{ display: 'flex', gap: 12, padding: '14px 18px', flexWrap: 'wrap', borderBottom: '1px solid var(--border-light)' }}>
              {preview.summary.map((s, i) => (
                <div key={i} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 16px', minWidth: 120 }}>
                  <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: s.color || 'var(--navy)', lineHeight: 1 }}>{s.value}</div>
                  <div style={{ ...MUTED, marginTop: 4 }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {loading ? <TableSkeleton rows={8} cols={6} /> : preview && preview.rows.length === 0 ? (
            <EmptyState title="No data" message="No records matched the selected filters." />
          ) : preview && (
            <div style={{ maxHeight: 520, overflow: 'auto' }}>
              <table className="data-table">
                <thead><tr>{preview.columns.map(c => <th key={c.key} style={{ textAlign: (c.align as 'left' | 'right' | 'center') || 'left' }}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {preview.rows.map((row, ri) => (
                    <tr key={ri}>
                      {preview.columns.map(c => (
                        <td key={c.key} style={{ textAlign: (c.align as 'left' | 'right' | 'center') || 'left', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                          {String(row[c.key] ?? '—')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Two-column footer: recent + scheduled */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 14 }}>
        <div style={CARD}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)' }}><div style={TITLE}>Recent Reports</div></div>
          {recent.length === 0 ? (
            <EmptyState title="No reports generated yet" message="Generate a report above and it will be listed here for quick re-download." />
          ) : (
            <table className="data-table">
              <thead><tr><th>Report</th><th>Format</th><th>Generated</th><th></th></tr></thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{r.title}</td>
                    <td><span className="badge badge-gray">{r.format.toUpperCase()}</span></td>
                    <td style={{ ...MUTED }}>{r.at}</td>
                    <td>
                      {r.format !== 'view' && (
                        <button style={{ fontSize: 'var(--text-xs)', color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer' }}
                          onClick={() => window.open(`/api/reports/${r.key}?${r.params}`, '_blank')}>Download again</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={CARD}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)' }}><div style={TITLE}>Scheduled Reports</div></div>
          <div style={{ padding: 28, textAlign: 'center' }}>
            <div style={{ display: 'inline-flex', padding: 12, borderRadius: 12, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-muted)', marginBottom: 12 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>Coming soon</div>
            <div style={{ ...MUTED, marginTop: 6, maxWidth: 280, marginLeft: 'auto', marginRight: 'auto' }}>
              Schedule any report to be generated and emailed on a recurring basis — daily, weekly or monthly.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
