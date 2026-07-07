'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { PageHeader, EmptyState, TableSkeleton } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { TrendChart } from './TrendChart';
import { DateRangePicker } from './DateRangePicker';
import { ReportDrillDrawer } from './ReportDrillDrawer';
import { ReportScheduleModal } from './ReportScheduleModal';
import { ReportsManagePanel } from './ReportsManagePanel';
import { rangeToParams, rangeToDurableParams } from './reportTypes';
import type { ChartSpec, DrillMeta, RangeValue, SavedRow, ScheduleRow } from './reportTypes';

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
interface ReportData { title: string; columns: Column[]; rows: Record<string, unknown>[]; summary?: Summary[]; charts?: ChartSpec[]; drill?: DrillMeta }
interface Site { id: number; name: string }
interface Server { id: number; hostname: string }

// icon factory
const I = (p: React.ReactNode) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;

interface ReportDef {
  key: string; title: string; desc: string; icon: React.ReactNode; color: string;
  filters: ('site' | 'server')[];
}
const REPORTS: ReportDef[] = [
  { key: 'subnet-utilization', title: 'Subnet Utilization', desc: 'Per-subnet usage, exhaustion forecast and site breakdown.', color: 'var(--blue)', filters: ['site'], icon: I(<><line x1="4" y1="20" x2="4" y2="10"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="14"/><line x1="22" y1="20" x2="2" y2="20"/></>) },
  { key: 'ip-inventory', title: 'IP Address Inventory', desc: 'Every assigned IP with hostname, MAC, lease status and stale flags.', color: 'var(--teal)', filters: ['site'], icon: I(<><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></>) },
  { key: 'dhcp-health', title: 'DHCP Scope Health', desc: 'Current vs peak utilization, trend and days-to-exhaustion per scope.', color: 'var(--primary)', filters: ['server'], icon: I(<><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></>) },
  { key: 'dns-zones', title: 'DNS Zone Report', desc: 'Record counts by type, SOA serials and stale-record analysis.', color: 'var(--navy)', filters: ['server'], icon: I(<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></>) },
  { key: 'network-changes', title: 'Network Change Report', desc: 'Who changed what and when — built for change-management reviews.', color: 'var(--purple)', filters: [], icon: I(<><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></>) },
  { key: 'rogue-devices', title: 'Security / Rogue Devices', desc: 'Unknown live devices with no DHCP lease — first/last seen.', color: 'var(--red)', filters: ['site'], icon: I(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></>) },
  { key: 'dhcp-utilization-trend', title: 'DHCP Utilization Trend', desc: 'Utilization over time across scopes with peak tracking.', color: 'var(--primary)', filters: ['server'], icon: I(<><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></>) },
  { key: 'ipam-growth-trend', title: 'IPAM Growth Trend', desc: 'IP consumption growth across the estate over time.', color: 'var(--teal)', filters: [], icon: I(<><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></>) },
  { key: 'dns-query-trend', title: 'DNS Query Trend', desc: 'Query volume, NXDOMAIN rate and response time over time.', color: 'var(--navy)', filters: ['server'], icon: I(<><path d="M3 3v18h18"/><polyline points="7 14 11 10 14 13 19 7"/></>) },
  { key: 'alert-anomaly-trend', title: 'Alerts & Anomalies Trend', desc: 'Alert and anomaly volume per day with MTTR.', color: 'var(--purple)', filters: ['site'], icon: I(<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>) },
  { key: 'site-health-trend', title: 'Site Health Trend', desc: 'Per-site health score trend over time.', color: 'var(--blue)', filters: ['site'], icon: I(<><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></>) },
];

export default function ReportsTab() {
  const { toast } = useToast();
  const [sites, setSites] = useState<Site[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [active, setActive] = useState<ReportDef | null>(null);
  const [preview, setPreview] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);

  // shared filter state
  const [siteId, setSiteId] = useState('');
  const [serverId, setServerId] = useState('');
  const [range, setRange] = useState<RangeValue>({ preset: '30d' });
  const [retentionDays, setRetentionDays] = useState(90);

  // drill-down state
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillEntity, setDrillEntity] = useState<string | null>(null);
  const [drillId, setDrillId] = useState<string | number | null>(null);

  // manage panel + schedule modal (server-side history / saved views)
  const [refreshKey, setRefreshKey] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleInitial, setScheduleInitial] = useState<ScheduleRow | null>(null);

  // preview table controls (Phase 5): pagination, column chooser, sort
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [colMenuOpen, setColMenuOpen] = useState(false);

  // compliance pack selection
  const [packSel, setPackSel] = useState<Set<string>>(new Set());

  useEffect(() => {
    api('/sites').then(d => setSites(d.data || [])).catch(() => {});
    api('/servers').then(d => setServers(d.data || [])).catch(() => {});
    // Best-effort: read retention_days from app settings (defaults to 90).
    api('/settings').then(d => {
      try {
        let rows: unknown = d;
        if (d && typeof d === 'object' && Array.isArray((d as { data?: unknown }).data)) {
          rows = (d as { data: unknown[] }).data;
        }
        let val: unknown;
        if (Array.isArray(rows)) {
          const hit = (rows as Array<Record<string, unknown>>).find(r => r.key === 'retention_days');
          val = hit?.value;
        } else if (rows && typeof rows === 'object') {
          val = (rows as Record<string, unknown>).retention_days;
        }
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) setRetentionDays(n);
      } catch { /* fall back to default 90 */ }
    }).catch(() => {});
  }, []);

  // Reset preview-table controls whenever a new preview loads.
  useEffect(() => {
    setPage(1);
    setSortKey(null);
    setHiddenCols(new Set());
    setColMenuOpen(false);
  }, [preview]);

  const buildParams = useCallback((def: ReportDef) => {
    const p = new URLSearchParams();
    // Every report now accepts a universal date range.
    for (const [k, v] of Object.entries(rangeToParams(range))) p.set(k, v);
    if (def.filters.includes('site') && siteId) p.set('site_id', siteId);
    if (def.filters.includes('server') && serverId) p.set('server_id', serverId);
    return p;
  }, [siteId, serverId, range]);

  // Download a report file (PDF/CSV) via an AUTHENTICATED fetch. window.open() can't
  // be used: it is a plain browser navigation that carries none of the x-ddi-actor-*
  // auth headers the global fetch patch (AuditActor) injects, so the reports API
  // rejects it with 401 "Authentication required". fetch → blob → anchor keeps the
  // request authenticated and still triggers a file download.
  const downloadReport = useCallback(async (key: string, query: string, fmt: string, title: string) => {
    try {
      const res = await fetch(`/api/reports/${key}?${query}`);
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* non-JSON error body */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      let filename = `${key}-${new Date().toISOString().slice(0, 10)}.${fmt}`;
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
      toast(`${title} (${fmt.toUpperCase()}) download failed: ${(e as Error).message || 'error'}`, 'error');
    }
  }, [toast]);

  // mode is passed EXPLICITLY (not read from state): relying on a `format` state var
  // meant a prior PDF/CSV click left it stale so the next "View" downloaded a file
  // instead of previewing.
  const generate = useCallback(async (def: ReportDef, mode: 'view' | 'csv' | 'pdf' = 'view') => {
    setActive(def);
    const params = buildParams(def);
    if (mode === 'view') {
      setLoading(true);
      setPreview(null);
      try {
        const data = await api(`/reports/${def.key}?${params.toString()}`);
        setPreview(data);
      } catch (e) {
        toast((e as Error).message || 'Report failed', 'error');
      }
      setLoading(false);
    } else {
      params.set('format', mode);
      downloadReport(def.key, params.toString(), mode, def.title);
    }
  }, [buildParams, toast, downloadReport]);

  // Durable params for PERSISTED contexts (save-view / schedule): rolling presets are
  // stored as range_preset so a recurring report re-resolves the window each run,
  // instead of freezing today's absolute from/to. Mirrors buildParams for site/server.
  const buildDurableParams = useCallback((def: ReportDef) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(rangeToDurableParams(range))) p.set(k, v);
    if (def.filters.includes('site') && siteId) p.set('site_id', siteId);
    if (def.filters.includes('server') && serverId) p.set('server_id', serverId);
    return p;
  }, [siteId, serverId, range]);

  const downloadActive = (fmt: 'csv' | 'pdf') => {
    if (!active) return;
    const params = buildParams(active);
    params.set('format', fmt);
    downloadReport(active.key, params.toString(), fmt, active.title);
  };

  // Load a saved view: switch to its report and fetch the preview from its stored params.
  const handleLoadSaved = useCallback(async (row: SavedRow) => {
    const def = REPORTS.find(r => r.key === row.report_type);
    if (!def) return;
    setActive(def);
    const strParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.params)) strParams[k] = String(v);
    const qs = new URLSearchParams(strParams).toString();
    setLoading(true);
    setPreview(null);
    try {
      const data = await api(`/reports/${def.key}?${qs}`);
      setPreview(data);
    } catch (e) {
      toast((e as Error).message || 'Report failed', 'error');
    }
    setLoading(false);
  }, [toast]);

  const handleOpenSchedule = useCallback((row: ScheduleRow | null) => {
    setScheduleInitial(row);
    setScheduleOpen(true);
  }, []);

  const togglePack = (key: string) => {
    setPackSel(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const generatePack = () => {
    const selected = Array.from(packSel);
    if (selected.length === 0) return;
    const packParams = new URLSearchParams(rangeToParams(range));
    if (siteId) packParams.set('site_id', siteId);
    if (serverId) packParams.set('server_id', serverId);
    const qs = 'types=' + encodeURIComponent(selected.join(',')) + '&' + packParams.toString();
    downloadReport('pack', qs, 'pdf', 'Compliance Pack');
  };

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const toggleCol = (key: string) => {
    setHiddenCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        // Guard: never hide the last visible column.
        if (preview && preview.columns.length - next.size <= 1) return prev;
        next.add(key);
      }
      return next;
    });
  };

  const showSite = active?.filters.includes('site');
  const showServer = active?.filters.includes('server');

  const reportsList = REPORTS.map(r => ({ key: r.key, title: r.title }));
  // Persisted contexts use durable params (rolling range_preset, not frozen from/to).
  const currentContext = active
    ? { report_type: active.key, title: active.title, params: Object.fromEntries(buildDurableParams(active)) }
    : null;
  // Memoized so a ReportsTab re-render while the create-schedule modal is open doesn't
  // hand it a fresh `defaults` object and wipe the user's in-progress form.
  const scheduleDefaults = useMemo(
    () => (scheduleInitial
      ? null
      : (active ? { report_type: active.key, params: Object.fromEntries(buildDurableParams(active)), name: active.title + ' report' } : null)),
    [scheduleInitial, active, buildDurableParams],
  );

  // Derived preview-table data (sorting / column filtering / pagination).
  const sortedRows = (() => {
    if (!preview) return [] as Record<string, unknown>[];
    const rows = preview.rows.slice();
    if (sortKey) {
      const k = sortKey;
      rows.sort((a, b) => {
        const as = String(a[k] ?? '').trim();
        const bs = String(b[k] ?? '').trim();
        // Only treat as numeric when the WHOLE cell is a number — parseFloat would
        // accept "192.168.1.5" as 192.168 (mis-sorting IPs/CIDRs/dates by prefix).
        const an = as !== '' && !isNaN(Number(as)) ? Number(as) : NaN;
        const bn = bs !== '' && !isNaN(Number(bs)) ? Number(bs) : NaN;
        let cmp: number;
        if (Number.isFinite(an) && Number.isFinite(bn)) cmp = an - bn;
        else cmp = as.localeCompare(bs, undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return rows;
  })();
  const visibleCols = preview ? preview.columns.filter(c => !hiddenCols.has(c.key)) : [];
  const total = sortedRows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const pagedRows = sortedRows.slice((clampedPage - 1) * pageSize, (clampedPage - 1) * pageSize + pageSize);
  const firstRow = total === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const lastRow = Math.min(total, clampedPage * pageSize);

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
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => generate(r, 'view')}>View</button>
              <button className="btn" onClick={() => { setActive(r); const p = buildParams(r); p.set('format', 'pdf'); downloadReport(r.key, p.toString(), 'pdf', r.title); }}>PDF</button>
              <button className="btn" onClick={() => { setActive(r); const p = buildParams(r); p.set('format', 'csv'); downloadReport(r.key, p.toString(), 'csv', r.title); }}>CSV</button>
            </div>
          </div>
        ))}
      </div>

      {/* Compliance Pack */}
      <div style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <div style={TITLE}>Compliance Pack</div>
          <div style={MUTED}>Bundle multiple reports into a single PDF using the current date range and filters.</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {REPORTS.map(r => (
            <label key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', background: packSel.has(r.key) ? 'var(--surface-subtle)' : 'var(--bg-card)' }}>
              <input type="checkbox" checked={packSel.has(r.key)} onChange={() => togglePack(r.key)} />
              {r.title}
            </label>
          ))}
        </div>
        <div>
          <button className="btn btn-primary" disabled={packSel.size === 0} onClick={generatePack}>Generate Pack (PDF)</button>
        </div>
      </div>

      {/* Filters for the active report */}
      {active && (
        <div style={{ ...CARD, padding: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...TITLE, fontSize: 'var(--text-base)' }}>{active.title} filters:</span>
          <DateRangePicker value={range} onChange={setRange} maxDays={retentionDays} />
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
          <button className="btn btn-primary" onClick={() => generate(active, 'view')}>Apply &amp; View</button>
        </div>
      )}

      {/* Preview panel */}
      {(loading || preview) && (
        <div style={CARD}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={TITLE}>{preview?.title || active?.title || 'Report preview'}</div>
            {preview && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ ...MUTED, padding: '6px 0' }}>{preview.rows.length} rows</span>
                {preview.rows.length > 0 && (
                  <div style={{ position: 'relative' }}>
                    <button className="btn" onClick={() => setColMenuOpen(o => !o)}>Columns ▾</button>
                    {colMenuOpen && (
                      <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-sm)', padding: 8, minWidth: 200, maxHeight: 320, overflow: 'auto' }}>
                        {preview.columns.map(c => (
                          <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', cursor: 'pointer', borderRadius: 6 }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-subtle)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                            <input type="checkbox" checked={!hiddenCols.has(c.key)} onChange={() => toggleCol(c.key)} />
                            {c.label}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
                  <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: s.color || 'var(--text-primary)', lineHeight: 1 }}>{s.value}</div>
                  <div style={{ ...MUTED, marginTop: 4 }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* trend charts */}
          {preview?.charts && preview.charts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 18px', borderBottom: '1px solid var(--border-light)' }}>
              {preview.charts.map((c, i) => <TrendChart key={i} chart={c} />)}
            </div>
          )}

          {loading ? <TableSkeleton rows={8} cols={6} /> : preview && preview.rows.length === 0 ? (
            <EmptyState title="No data" message="No records matched the selected filters." />
          ) : preview && (
            <>
              <div style={{ maxHeight: 520, overflow: 'auto' }}>
                <table className="data-table">
                  <thead><tr>{visibleCols.map(c => (
                    <th key={c.key} onClick={() => handleSort(c.key)} title="Sort" style={{ textAlign: (c.align as 'left' | 'right' | 'center') || 'left', cursor: 'pointer' }}>
                      {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}</tr></thead>
                  <tbody>
                    {pagedRows.map((row, ri) => (
                      <tr
                        key={ri}
                        style={preview.drill ? { cursor: 'pointer' } : undefined}
                        title={preview.drill ? 'Click for detail' : undefined}
                        onClick={preview.drill ? () => {
                          const idv = row[preview.drill!.idKey];
                          if (idv != null) {
                            setDrillEntity(preview.drill!.entity);
                            setDrillId(idv as string | number);
                            setDrillOpen(true);
                          }
                        } : undefined}
                      >
                        {visibleCols.map(c => (
                          <td key={c.key} style={{ textAlign: (c.align as 'left' | 'right' | 'center') || 'left', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                            {String(row[c.key] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* pagination footer */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 18px', borderTop: '1px solid var(--border-light)', flexWrap: 'wrap' }}>
                <span style={MUTED}>Showing {firstRow}–{lastRow} of {total}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="btn" disabled={clampedPage <= 1} onClick={() => setPage(Math.max(1, clampedPage - 1))}>Prev</button>
                  <span style={{ ...MUTED, minWidth: 90, textAlign: 'center' }}>Page {clampedPage} of {pageCount}</span>
                  <button className="btn" disabled={clampedPage >= pageCount} onClick={() => setPage(Math.min(pageCount, clampedPage + 1))}>Next</button>
                  <select className="input" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}>
                    <option value={25}>25 / page</option>
                    <option value={50}>50 / page</option>
                    <option value={100}>100 / page</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Saved views · run history · schedules */}
      <ReportsManagePanel reports={reportsList} currentContext={currentContext} refreshKey={refreshKey} onLoadSaved={handleLoadSaved} onOpenSchedule={handleOpenSchedule} />

      <ReportDrillDrawer open={drillOpen} entity={drillEntity} id={drillId} onClose={() => setDrillOpen(false)} />

      <ReportScheduleModal
        open={scheduleOpen}
        initial={scheduleInitial}
        reports={reportsList}
        defaults={scheduleDefaults}
        onClose={() => setScheduleOpen(false)}
        onSaved={() => { setRefreshKey(k => k + 1); }}
      />
    </div>
  );
}
