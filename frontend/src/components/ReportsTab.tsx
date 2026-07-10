'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PageHeader, EmptyState, TableSkeleton } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { TrendChart } from './TrendChart';
import { DateRangePicker } from './DateRangePicker';
import { ReportDrillDrawer } from './ReportDrillDrawer';
import { ReportScheduleModal } from './ReportScheduleModal';
import { ReportsManagePanel } from './ReportsManagePanel';
import { ReportsCatalog } from './ReportsCatalog';
import { rangeToParams, rangeToDurableParams, isCustomRangeInverted } from './reportTypes';
import type { ChartSpec, DrillMeta, RangeValue, SavedRow, ScheduleRow } from './reportTypes';

const CARD: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)' };
const TITLE: React.CSSProperties = { fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)' };

// Fixed-window presets and the days they span (ascending) — used to clamp the active
// preset to what retention actually allows (falls back to the widest allowed window).
const PRESET_DAY_MAP: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
const PRESET_ORDER_ASC: Array<'24h' | '7d' | '30d' | '90d'> = ['24h', '7d', '30d', '90d'];

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
// Minimal scope shape for the DHCP Scope Health scope filter. `id` is dhcp_scopes.id
// (the numeric value the dhcp-health `scope_ids` contract + drill row `_id` expect).
interface ScopeOption { id: number; scope_id: string; name: string; server_id: number }

// icon factory
const I = (p: React.ReactNode) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;

interface ReportDef {
  key: string; title: string; desc: string; icon: React.ReactNode; color: string;
  filters: ('site' | 'server')[];
  // Catalog grouping (left rail): `category` places the report in a group; `short` is the
  // concise rail label. Neither affects report generation — display metadata only.
  category: string; short: string;
}
const REPORTS: ReportDef[] = [
  { key: 'subnet-utilization', title: 'Subnet Utilization', short: 'Subnet Utilization', category: 'Inventory', desc: 'Per-subnet usage, exhaustion forecast and site breakdown.', color: 'var(--blue)', filters: ['site'], icon: I(<><line x1="4" y1="20" x2="4" y2="10"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="14"/><line x1="22" y1="20" x2="2" y2="20"/></>) },
  { key: 'ip-inventory', title: 'IP Address Inventory', short: 'IP Address Inventory', category: 'Inventory', desc: 'Every assigned IP with hostname, MAC, lease status and stale flags.', color: 'var(--teal)', filters: ['site'], icon: I(<><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></>) },
  { key: 'dhcp-health', title: 'DHCP Scope Health', short: 'DHCP Scope Health', category: 'DHCP', desc: 'Current vs peak utilization, trend and days-to-exhaustion per scope.', color: 'var(--primary)', filters: ['server'], icon: I(<><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></>) },
  { key: 'dns-zones', title: 'DNS Zone Report', short: 'DNS Zone Report', category: 'DNS', desc: 'Record counts by type, SOA serials and stale-record analysis.', color: 'var(--navy)', filters: ['server'], icon: I(<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></>) },
  { key: 'network-changes', title: 'Network Change Report', short: 'Network Change', category: 'Security & change', desc: 'Who changed what and when — built for change-management reviews.', color: 'var(--purple)', filters: [], icon: I(<><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></>) },
  { key: 'rogue-devices', title: 'Security / Rogue Devices', short: 'Rogue Devices', category: 'Security & change', desc: 'Unknown live devices with no DHCP lease — first/last seen.', color: 'var(--red)', filters: ['site'], icon: I(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></>) },
  { key: 'dhcp-utilization-trend', title: 'DHCP Utilization Trend', short: 'DHCP Utilization Trend', category: 'DHCP', desc: 'Utilization over time across scopes with peak tracking.', color: 'var(--primary)', filters: ['server'], icon: I(<><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></>) },
  { key: 'ipam-growth-trend', title: 'IPAM Growth Trend', short: 'IPAM Growth', category: 'Trends', desc: 'IP consumption growth across the estate over time.', color: 'var(--teal)', filters: [], icon: I(<><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></>) },
  { key: 'dns-query-trend', title: 'DNS Query Trend', short: 'DNS Query Trend', category: 'DNS', desc: 'Query volume, NXDOMAIN rate and response time over time.', color: 'var(--navy)', filters: ['server'], icon: I(<><path d="M3 3v18h18"/><polyline points="7 14 11 10 14 13 19 7"/></>) },
  { key: 'alert-anomaly-trend', title: 'Alerts & Anomalies Trend', short: 'Alerts & Anomalies', category: 'Trends', desc: 'Alert and anomaly volume per day with MTTR.', color: 'var(--purple)', filters: ['site'], icon: I(<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>) },
  { key: 'site-health-trend', title: 'Site Health Trend', short: 'Site Health', category: 'Trends', desc: 'Per-site health score trend over time.', color: 'var(--blue)', filters: ['site'], icon: I(<><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></>) },
];

type WorkspaceTab = 'view' | 'saved' | 'scheduled' | 'pack';

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

  // Sequence guard for the preview loaders: a slow earlier request must not overwrite a
  // newer one. Every generate()/handleLoadSaved() bumps this and only commits if it is
  // still the latest call by the time its fetch resolves. Mirrors ReportsManagePanel.
  const previewSeq = useRef(0);

  // drill-down state
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillEntity, setDrillEntity] = useState<string | null>(null);
  const [drillId, setDrillId] = useState<string | number | null>(null);

  // manage panel + schedule modal (server-side history / saved views)
  const [refreshKey, setRefreshKey] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleInitial, setScheduleInitial] = useState<ScheduleRow | null>(null);

  // Right-workspace active tab (View | Saved views | Scheduled | Report pack).
  const [tab, setTab] = useState<WorkspaceTab>('view');
  // Badge counts for the Saved views / Scheduled tabs. Fetched here (lightweight) for the
  // tab labels; ReportsManagePanel fetches its own copy for the panels. Re-read on mount,
  // when a schedule save bumps refreshKey, and on tab switches so the badges stay current.
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [schedCount, setSchedCount] = useState<number | null>(null);

  // preview table controls (Phase 5): pagination, column chooser, sort
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [colMenuOpen, setColMenuOpen] = useState(false);

  // compliance pack selection
  const [packSel, setPackSel] = useState<Set<string>>(new Set());

  // DHCP Scope Health — per-scope filter (dhcp-health only). Scope options load lazily
  // from /api/scopes the first time that report is opened. Selection is a Set of numeric
  // dhcp_scopes.id (the `scope_ids` contract value). Empty = all scopes.
  const [scopeOptions, setScopeOptions] = useState<ScopeOption[]>([]);
  const scopesLoadedRef = useRef(false);
  // One-shot guard: when handleLoadSaved rehydrates a saved view's scope selection, its
  // programmatic setActive would otherwise trigger the [active, serverId] reset effect and
  // wipe the just-restored selection. Armed only when setActive will actually change the
  // reference (so the effect is guaranteed to run and consume it — never left stale).
  const skipNextScopeReset = useRef(false);
  const [scopeSel, setScopeSel] = useState<Set<number>>(new Set());
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [scopeSearch, setScopeSearch] = useState('');

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

  // Clamp the active date preset to what retention allows. When retentionDays loads (or
  // changes) and the current preset's window exceeds it, fall back to the WIDEST allowed
  // fixed preset (e.g. 30d→7d→24h). Custom / as-of ranges are exempt. This keeps the
  // picker from showing a disabled preset as active and stops "Apply & View" emitting a
  // window wider than retention.
  useEffect(() => {
    setRange(prev => {
      const days = PRESET_DAY_MAP[prev.preset];
      if (days == null || days <= retentionDays) return prev; // custom/asof or already fits
      const allowed = PRESET_ORDER_ASC.filter(p => PRESET_DAY_MAP[p] <= retentionDays);
      const best = allowed.length ? allowed[allowed.length - 1] : '24h';
      if (best === prev.preset) return prev;
      return { ...prev, preset: best };
    });
  }, [retentionDays]);

  // Reset preview-table controls whenever a new preview loads.
  useEffect(() => {
    setPage(1);
    setSortKey(null);
    setHiddenCols(new Set());
    setColMenuOpen(false);
  }, [preview]);

  // Lazily load scope options the first time the DHCP Scope Health report is opened.
  useEffect(() => {
    if (active?.key !== 'dhcp-health' || scopesLoadedRef.current) return;
    scopesLoadedRef.current = true;
    api('/scopes')
      .then(d => setScopeOptions(((d.data || []) as ScopeOption[]).map(s => ({
        id: Number(s.id), scope_id: s.scope_id, name: s.name, server_id: Number(s.server_id),
      }))))
      .catch(() => { scopesLoadedRef.current = false; });
  }, [active]);

  // Drop stale scope selection when the report changes or the server filter narrows the
  // candidate scopes (previously-picked scopes may no longer belong to the chosen server).
  useEffect(() => {
    // Skip exactly one reset right after a programmatic saved-view load (handleLoadSaved
    // rehydrates scopeSel and arms this flag); otherwise the just-restored subset would be
    // wiped and a follow-up Apply/PDF/CSV would silently export ALL scopes.
    if (skipNextScopeReset.current) {
      skipNextScopeReset.current = false;
      return;
    }
    setScopeSel(new Set());
    setScopeMenuOpen(false);
    setScopeSearch('');
  }, [active, serverId]);

  // Tab badge counts (best-effort). Refreshed on mount, on refreshKey bumps, and on tab
  // switches so the Saved views / Scheduled counters track create/delete done in the panel.
  useEffect(() => {
    api('/reports/saved').then(d => setSavedCount(((d?.data as unknown[]) || []).length)).catch(() => {});
    api('/reports/schedules').then(d => setSchedCount(((d?.data as unknown[]) || []).length)).catch(() => {});
  }, [refreshKey, tab]);

  const buildParams = useCallback((def: ReportDef) => {
    const p = new URLSearchParams();
    // Every report now accepts a universal date range.
    for (const [k, v] of Object.entries(rangeToParams(range))) p.set(k, v);
    if (def.filters.includes('site') && siteId) p.set('site_id', siteId);
    if (def.filters.includes('server') && serverId) p.set('server_id', serverId);
    // DHCP Scope Health: narrow to selected scopes (empty = all scopes → omit).
    if (def.key === 'dhcp-health' && scopeSel.size > 0) p.set('scope_ids', Array.from(scopeSel).join(','));
    return p;
  }, [siteId, serverId, range, scopeSel]);

  // Download a report file (PDF/CSV) via fetch rather than window.open(). Identity
  // (x-ddi-actor-*) is now stamped server-side by middleware.ts from the verified
  // NextAuth session cookie, which a plain browser navigation would carry too — so
  // this is no longer about auth. fetch → blob → anchor is still needed to read the
  // filename off Content-Disposition and to surface a JSON error body (instead of
  // navigating the whole tab to an error page) before triggering the download.
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
    // Block a degenerate custom window before it is emitted (F4).
    if (isCustomRangeInverted(range)) {
      toast('Start date must be on or before end date.', 'error');
      return;
    }
    setActive(def);
    const params = buildParams(def);
    if (mode === 'view') {
      // Out-of-order guard (F1): capture this call's sequence; only the newest call may
      // commit its result so a slow earlier fetch can't overwrite a newer report.
      const seq = ++previewSeq.current;
      setLoading(true);
      setPreview(null);
      try {
        const data = await api(`/reports/${def.key}?${params.toString()}`);
        if (seq !== previewSeq.current) return; // superseded by a newer request
        setPreview(data);
      } catch (e) {
        if (seq !== previewSeq.current) return;
        toast((e as Error).message || 'Report failed', 'error');
      }
      if (seq === previewSeq.current) setLoading(false);
    } else {
      params.set('format', mode);
      downloadReport(def.key, params.toString(), mode, def.title);
    }
  }, [buildParams, toast, downloadReport, range]);

  // Durable params for PERSISTED contexts (save-view / schedule): rolling presets are
  // stored as range_preset so a recurring report re-resolves the window each run,
  // instead of freezing today's absolute from/to. Mirrors buildParams for site/server.
  const buildDurableParams = useCallback((def: ReportDef) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(rangeToDurableParams(range))) p.set(k, v);
    if (def.filters.includes('site') && siteId) p.set('site_id', siteId);
    if (def.filters.includes('server') && serverId) p.set('server_id', serverId);
    if (def.key === 'dhcp-health' && scopeSel.size > 0) p.set('scope_ids', Array.from(scopeSel).join(','));
    return p;
  }, [siteId, serverId, range, scopeSel]);

  const downloadActive = (fmt: 'csv' | 'pdf') => {
    if (!active) return;
    const params = buildParams(active);
    params.set('format', fmt);
    downloadReport(active.key, params.toString(), fmt, active.title);
  };

  // Select a report from the catalog rail: surface the View tab and generate its preview
  // (mirrors the old card "View" action so a click immediately shows data).
  const handleSelectReport = useCallback((key: string) => {
    const def = REPORTS.find(r => r.key === key);
    if (!def) return;
    setTab('view');
    generate(def, 'view');
  }, [generate]);

  // Load a saved view: switch to its report and fetch the preview from its stored params.
  const handleLoadSaved = useCallback(async (row: SavedRow) => {
    const def = REPORTS.find(r => r.key === row.report_type);
    if (!def) return;
    // Arm the one-shot skip only when this setActive will change the `active` reference —
    // exactly the case where the reset effect would run and clobber the scope selection we
    // rehydrate below. When the same report is already active the effect never re-runs, so
    // no skip is needed (and the flag is not left stale to swallow a later genuine reset).
    if (def !== active) skipNextScopeReset.current = true;
    setActive(def);
    setTab('view'); // surface the loaded view in the workspace
    // Rehydrate the scopes multi-select from the saved scope_ids so a follow-up
    // Apply re-scopes to the same scopes instead of silently broadening to ALL.
    // scope_ids persists as a comma-joined string (see generate()); empty/absent → none.
    const rawScopeIds = (row.params as Record<string, unknown>)?.scope_ids;
    const scopeIds = (Array.isArray(rawScopeIds) ? rawScopeIds.join(',') : String(rawScopeIds ?? ''))
      .split(',')
      .map(v => parseInt(String(v).trim(), 10))
      .filter(n => Number.isFinite(n));
    setScopeSel(new Set(scopeIds));
    const strParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.params)) strParams[k] = String(v);
    const qs = new URLSearchParams(strParams).toString();
    // Out-of-order guard (F1): shares previewSeq with generate() so whichever loader fires
    // last wins and header/preview can't desync.
    const seq = ++previewSeq.current;
    setLoading(true);
    setPreview(null);
    try {
      const data = await api(`/reports/${def.key}?${qs}`);
      if (seq !== previewSeq.current) return;
      setPreview(data);
    } catch (e) {
      if (seq !== previewSeq.current) return;
      toast((e as Error).message || 'Report failed', 'error');
    }
    if (seq === previewSeq.current) setLoading(false);
  }, [toast, active]);

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

  const toggleScope = (id: number) => {
    setScopeSel(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
        if (preview && (preview.columns?.length ?? 0) - next.size <= 1) return prev;
        next.add(key);
      }
      return next;
    });
  };

  const showSite = active?.filters.includes('site');
  const showServer = active?.filters.includes('server');
  // Scope filter is exclusive to the DHCP Scope Health report. When a server is chosen,
  // only offer that server's scopes; otherwise all. Search narrows the visible menu list.
  const showScopeFilter = active?.key === 'dhcp-health';
  const scopeOptsForServer = serverId ? scopeOptions.filter(s => s.server_id === Number(serverId)) : scopeOptions;
  const menuScopes = scopeSearch.trim()
    ? scopeOptsForServer.filter(s => {
        const q = scopeSearch.trim().toLowerCase();
        return (s.scope_id || '').toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q);
      })
    : scopeOptsForServer;

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
    const rows = (preview.rows ?? []).slice();
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
  const visibleCols = preview ? (preview.columns ?? []).filter(c => !hiddenCols.has(c.key)) : [];
  const total = sortedRows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(Math.max(1, page), pageCount);
  const pagedRows = sortedRows.slice((clampedPage - 1) * pageSize, (clampedPage - 1) * pageSize + pageSize);
  const firstRow = total === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const lastRow = Math.min(total, clampedPage * pageSize);

  const WORKSPACE_TABS: { key: WorkspaceTab; label: string; count?: number | null }[] = [
    { key: 'view', label: 'View' },
    { key: 'saved', label: 'Saved views', count: savedCount },
    { key: 'scheduled', label: 'Scheduled', count: schedCount },
    { key: 'pack', label: 'Report pack' },
  ];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title="Reports" subtitle="Generate professional, exportable reports for capacity planning, compliance and security reviews." />

      {/* LOCKED two-pane layout: catalog rail (own scroll) + workspace (tab strip + content). */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', height: 'calc(100vh - 210px)', minHeight: 460 }}>

        {/* ── LEFT RAIL — grouped report catalog ── */}
        <div style={{ ...CARD, width: 264, flexShrink: 0, padding: 12, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <ReportsCatalog
            reports={REPORTS.map(r => ({ key: r.key, short: r.short, title: r.title, desc: r.desc, color: r.color, category: r.category }))}
            activeKey={active?.key ?? null}
            onSelect={handleSelectReport}
          />
        </div>

        {/* ── RIGHT WORKSPACE ── */}
        <div style={{ ...CARD, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>

          {/* Tab strip */}
          <div style={{ display: 'flex', gap: 4, padding: '0 16px', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
            {WORKSPACE_TABS.map(t => {
              const on = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  style={{
                    padding: '12px 14px', background: 'transparent', border: 'none',
                    borderBottom: on ? '2px solid var(--primary)' : '2px solid transparent',
                    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontSize: 'var(--text-base)', fontWeight: on ? 600 : 500, cursor: 'pointer', marginBottom: -1,
                  }}
                >
                  {t.label}{t.count != null ? ` (${t.count})` : ''}
                </button>
              );
            })}
          </div>

          {/* Tab content (independently scrolls) */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>

            {/* ── VIEW ── */}
            {tab === 'view' && (!active ? (
              <div style={{ padding: 48 }}>
                <EmptyState title="Select a report" message="Choose a report from the catalog on the left to configure and preview it." />
              </div>
            ) : (
              <>
                {/* Report header */}
                <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ ...TITLE, fontSize: 'var(--text-lg)' }}>{active.title}</div>
                    <div style={{ ...MUTED, marginTop: 4, maxWidth: 620 }}>{active.desc}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button className="btn btn-primary" onClick={() => generate(active, 'view')}>View</button>
                    <button className="btn" onClick={() => downloadActive('pdf')}>PDF</button>
                    <button className="btn" onClick={() => downloadActive('csv')}>CSV</button>
                  </div>
                </div>

                {/* Sticky filter bar — opaque bg + z-index so scrolled rows never bleed through. */}
                <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg-card)', borderBottom: '1px solid var(--border-light)', padding: '12px 18px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
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
                  {showScopeFilter && (
                    <div style={{ position: 'relative' }}>
                      <button className="btn" onClick={() => setScopeMenuOpen(o => !o)}>
                        {scopeSel.size === 0 ? 'All scopes' : `${scopeSel.size} scope${scopeSel.size > 1 ? 's' : ''} selected`} ▾
                      </button>
                      {scopeMenuOpen && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 20, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-sm)', padding: 8, minWidth: 280, maxHeight: 360, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <input
                            className="input"
                            placeholder="Search scopes…"
                            value={scopeSearch}
                            onChange={e => setScopeSearch(e.target.value)}
                            style={{ width: '100%' }}
                          />
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                            <button
                              className="btn"
                              style={{ flex: 1 }}
                              disabled={menuScopes.length === 0}
                              onClick={() => setScopeSel(prev => { const n = new Set(prev); menuScopes.forEach(s => n.add(s.id)); return n; })}
                            >All</button>
                            <button
                              className="btn"
                              style={{ flex: 1 }}
                              disabled={scopeSel.size === 0}
                              onClick={() => setScopeSel(new Set())}
                            >Clear</button>
                          </div>
                          <div style={{ overflow: 'auto', maxHeight: 240 }}>
                            {menuScopes.length === 0 ? (
                              <div style={{ ...MUTED, padding: '8px' }}>No scopes{scopeOptions.length === 0 ? ' loaded' : ' match'}.</div>
                            ) : menuScopes.map(s => (
                              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', cursor: 'pointer', borderRadius: 6 }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-subtle)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                                <input type="checkbox" checked={scopeSel.has(s.id)} onChange={() => toggleScope(s.id)} />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {s.scope_id}{s.name ? ` — ${s.name}` : ''}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <button className="btn btn-primary" onClick={() => generate(active, 'view')}>Apply</button>
                </div>

                {/* Preview */}
                {(loading || preview) ? (
                  <div>
                    {preview && (
                      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ ...TITLE, fontSize: 'var(--text-base)' }}>{preview.title || active.title || 'Report preview'}</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={MUTED}>{preview.rows?.length ?? 0} rows</span>
                          {(preview.rows?.length ?? 0) > 0 && (
                            <div style={{ position: 'relative' }}>
                              <button className="btn" onClick={() => setColMenuOpen(o => !o)}>Columns ▾</button>
                              {colMenuOpen && (
                                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-sm)', padding: 8, minWidth: 200, maxHeight: 320, overflow: 'auto' }}>
                                  {(preview.columns ?? []).map(c => (
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
                        </div>
                      </div>
                    )}

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

                    {loading ? <TableSkeleton rows={8} cols={6} /> : preview && (preview.rows?.length ?? 0) === 0 ? (
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
                ) : (
                  <div style={{ padding: 48 }}>
                    <EmptyState title="Ready to run" message="Adjust the filters above and choose Apply to generate this report." />
                  </div>
                )}
              </>
            ))}

            {/* ── SAVED VIEWS / SCHEDULED ── single ReportsManagePanel instance (it renders
                both Saved Views and Scheduled Reports, plus run history); kept mounted while
                on either tab so switching between them does not refetch. ── */}
            {(tab === 'saved' || tab === 'scheduled') && (
              <div style={{ padding: 18 }}>
                <ReportsManagePanel reports={reportsList} currentContext={currentContext} refreshKey={refreshKey} onLoadSaved={handleLoadSaved} onOpenSchedule={handleOpenSchedule} />
              </div>
            )}

            {/* ── REPORT PACK ── */}
            {tab === 'pack' && (
              <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ ...TITLE, fontSize: 'var(--text-lg)' }}>Report Pack</div>
                  <div style={{ ...MUTED, marginTop: 4 }}>Bundle multiple reports into a single PDF using the selected date range and filters.</div>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <DateRangePicker value={range} onChange={setRange} maxDays={retentionDays} />
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
            )}
          </div>
        </div>
      </div>

      <ReportDrillDrawer open={drillOpen} entity={drillEntity} id={drillId} range={range} onClose={() => setDrillOpen(false)} />

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
