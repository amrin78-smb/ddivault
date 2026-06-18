'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from '@/components/Header';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
import { useRBAC } from '@/components/RBACContext';
import { useLicense, LicenseDisabledScreen, LicenseBanner } from '@/components/LicenseGuard';
import UpdateNotifier from '@/components/UpdateNotifier';
import IPAMTab    from '@/components/IPAMTab';
import DHCPTab    from '@/components/DHCPTab';
import DNSTab     from '@/components/DNSTab';
import ServersTab from '@/components/ServersTab';
import AuditTab   from '@/components/AuditTab';
import ReportsTab from '@/components/ReportsTab';
import InfraHealthTab from '@/components/InfraHealthTab';
import SmtpSettings from '@/components/SmtpSettings';
import AlertRecipients from '@/components/AlertRecipients';
import AlertRules from '@/components/AlertRules';
import CapacityForecast from '@/components/CapacityForecast';
import SiteHealth from '@/components/SiteHealth';
import SecurityOverview from '@/components/SecurityOverview';
import DeviceDonut from '@/components/DeviceDonut';
import CommandBar from '@/components/dashboard/CommandBar';
import PriorityActionCenter from '@/components/dashboard/PriorityActionCenter';
import PillarScorecards from '@/components/dashboard/PillarScorecards';
import InfraRedundancy from '@/components/dashboard/InfraRedundancy';
import DnsAnalyticsCard from '@/components/dashboard/DnsAnalyticsCard';
import ActivityFeed from '@/components/dashboard/ActivityFeed';
import { ApiKeysSection } from '@/components/ApiKeysSection';
import {
  PageHeader, EmptyState, UtilBar, Trend, TableSkeleton, Skeleton, pctColor,
} from '@/components/ui';

// ── Types ─────────────────────────────────────────────────────
interface Scope {
  id: number;
  scope_id: string;
  name: string;
  start_range: string;
  end_range: string;
  total_ips: number;
  in_use: number;
  free: number;
  reserved: number;
  percent_used: number;
  state: string;
  server_hostname: string;
  server_ip: string;
  last_updated: string;
}

interface DhcpEvent {
  id: number;
  event_id: number;
  event_type: string;
  ip_address: string;
  hostname: string;
  mac_address: string;
  description: string;
  event_time: string;
}

interface AlertEvent {
  id: number;
  message: string;
  severity: string;
  scope_id: string;
  acknowledged: boolean;
  fired_at: string;
  rule_name: string;
  explanation?: string | null;
  occurrence_count?: number;
  first_fired_at?: string;
  server_hostname?: string;
  resolved_at?: string | null;
  resolved_reason?: string | null;
}

interface ScopeHistory {
  scope_id: string;
  name: string;
  history: { percent_used: number; in_use: number; recorded_at: string }[];
}

type Tab = 'dashboard' | 'scopes' | 'ipam' | 'dns' | 'events' | 'servers' | 'infra' | 'reports' | 'audit' | 'settings';

// ── Shared styles ─────────────────────────────────────────────
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow-sm)',
};
const TITLE: React.CSSProperties = { fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)' };

// ── Section header (compact, uppercase) ───────────────────────
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 12, marginTop: 4 }}>
      {children}
    </div>
  );
}

// ── API helper ────────────────────────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Event type badge ──────────────────────────────────────────
const EVENT_BADGE: Record<string, string> = {
  Assign: 'badge-green', Renew: 'badge-blue', Release: 'badge-gray',
  ScopeFull: 'badge-red', ScopeWarning: 'badge-yellow', Conflict: 'badge-red',
  NACK: 'badge-orange', RogueDHCP: 'badge-red', Expired: 'badge-gray',
};
function EventTypeBadge({ type }: { type: string }) {
  return <span className={`badge ${EVENT_BADGE[type] || 'badge-gray'}`}>{type || '—'}</span>;
}

// ── Sparkline (inline SVG, 7-day trend, hover tooltip) ─────────
function Sparkline({ data, color, width = 220, height = 44 }: {
  data: { percent_used: number; recorded_at?: string }[]; color: string; width?: number; height?: number;
}) {
  const [hi, setHi] = useState<number | null>(null);
  if (data.length < 2) return <div style={{ height, ...MUTED, display: 'flex', alignItems: 'center' }}>Not enough history</div>;
  const max = Math.max(100, ...data.map(d => d.percent_used));
  const pts = data.map((d, i) => ({
    x: (i / (data.length - 1)) * width,
    y: height - (d.percent_used / max) * height,
  }));
  const ptsStr = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `0,${height} ${ptsStr} ${width},${height}`;
  const lastX = width, lastY = height - (data[data.length - 1].percent_used / max) * height;
  const gid = `spark-${color.replace(/[^a-z0-9]/gi, '')}`;

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    setHi(Math.min(data.length - 1, Math.max(0, Math.round(rx * (data.length - 1)))));
  };
  const fmtDate = (s?: string) => {
    if (!s) return '';
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const hp = hi != null ? data[hi] : null;

  return (
    <div style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      <svg width={width} height={height} style={{ display: 'block', width: '100%' }} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gid})`} />
        <polyline points={ptsStr} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={lastX} cy={lastY} r="2.5" fill={color} />
        {hi != null && (
          <>
            <line x1={pts[hi].x} y1={0} x2={pts[hi].x} y2={height} stroke={color} strokeWidth="1" strokeDasharray="2 2" opacity="0.5" vectorEffect="non-scaling-stroke" />
            <circle cx={pts[hi].x} cy={pts[hi].y} r="2.6" fill="#fff" stroke={color} strokeWidth="1.5" />
          </>
        )}
      </svg>
      {hp && (
        <div style={{
          position: 'absolute', left: `${(hi! / (data.length - 1)) * 100}%`, top: -2,
          transform: 'translate(-50%, -100%)', background: 'var(--navy)', color: '#fff',
          padding: '2px 7px', borderRadius: 6, fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap',
          pointerEvents: 'none', boxShadow: 'var(--shadow-md)', zIndex: 5,
        }}>
          {fmtDate(hp.recorded_at)}{hp.recorded_at ? ' · ' : ''}{Number(hp.percent_used).toFixed(1)}%
        </div>
      )}
    </div>
  );
}

// ── Donut chart (IP status distribution, clickable segments) ───
function Donut({ data, dim = 110, onSegmentClick }: { data: { label: string; value: number; color: string }[]; dim?: number; onSegmentClick?: (label: string) => void }) {
  const [hi, setHi] = useState<number | null>(null);
  const total = data.reduce((a, b) => a + b.value, 0);
  if (total === 0) return <div style={{ ...MUTED, padding: 20, textAlign: 'center' }}>No address data yet</div>;
  const R = 52, SW = 18, C = 2 * Math.PI * R;
  const segs = data.filter(d => d.value > 0);
  let offset = 0;
  const clickable = !!onSegmentClick;
  const tip = hi != null ? segs[hi] : null;
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 20 }}>
      <svg width={dim} height={dim} viewBox="0 0 140 140" style={{ flexShrink: 0 }}>
        <g transform="rotate(-90 70 70)">
          {segs.map((d, i) => {
            const frac = d.value / total;
            const dash = frac * C;
            const active = hi === i;
            const seg = (
              <circle key={i} cx="70" cy="70" r={R} fill="none" stroke={d.color}
                strokeWidth={active ? SW + 4 : SW} strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset}
                opacity={hi == null || active ? 1 : 0.5}
                style={{ cursor: clickable ? 'pointer' : 'default', transition: 'stroke-width 0.12s, opacity 0.12s' }}
                onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}
                onClick={() => onSegmentClick?.(d.label)} />
            );
            offset += dash;
            return seg;
          })}
        </g>
        <text x="70" y="66" textAnchor="middle" fontSize="var(--text-xl)" fontWeight="800" fill="var(--text-primary)">{total}</text>
        <text x="70" y="84" textAnchor="middle" fontSize="var(--text-xs)" fill="var(--text-muted)">addresses</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.map(d => {
          const idx = segs.findIndex(s => s.label === d.label);
          return (
            <div key={d.label}
              onMouseEnter={() => idx >= 0 && setHi(idx)} onMouseLeave={() => setHi(null)}
              onClick={() => clickable && onSegmentClick?.(d.label)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', cursor: clickable ? 'pointer' : 'default', borderRadius: 6, padding: '1px 4px', background: hi != null && segs[hi]?.label === d.label ? 'var(--bg-primary)' : 'transparent' }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, flexShrink: 0 }} />
              <span style={{ color: 'var(--text-secondary)', minWidth: 76 }}>{d.label}</span>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{d.value}</span>
            </div>
          );
        })}
      </div>
      {tip && (
        <div style={{
          position: 'absolute', left: dim / 2, top: dim / 2, transform: 'translate(-50%, -50%)',
          background: 'var(--navy)', color: '#fff', padding: '5px 9px', borderRadius: 8, fontSize: 'var(--text-xs)',
          whiteSpace: 'nowrap', textAlign: 'center', pointerEvents: 'none', boxShadow: 'var(--shadow-md)', zIndex: 5,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', fontWeight: 700 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: tip.color }} />{tip.label}
          </div>
          <div style={{ opacity: 0.85, marginTop: 1 }}>{tip.value} addresses · {((tip.value / total) * 100).toFixed(1)}%</div>
        </div>
      )}
    </div>
  );
}

// ── Simple line chart (lease trend, hover tooltip + indicator) ─
function LineChart({ points, color = 'var(--blue)', height = 120, labels }: { points: number[]; color?: string; height?: number; labels?: string[] }) {
  const [hi, setHi] = useState<number | null>(null);
  if (points.length < 2) return <div style={{ ...MUTED, height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Not enough history yet</div>;
  const W = 480, H = height, pad = 8;
  const max = Math.max(1, ...points), min = Math.min(...points);
  const span = Math.max(1, max - min);
  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (W - pad * 2));
  const ys = points.map(p => pad + (1 - (p - min) / span) * (H - pad * 2));
  const xy = points.map((_, i) => `${xs[i].toFixed(1)},${ys[i].toFixed(1)}`);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    setHi(Math.min(points.length - 1, Math.max(0, Math.round(rx * (points.length - 1)))));
  };
  const fmtLabel = (s?: string) => {
    if (!s) return '';
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <polygon points={`${pad},${H - pad} ${xy.join(' ')} ${W - pad},${H - pad}`} fill={color} opacity="0.08" />
        <polyline points={xy.join(' ')} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {hi != null && (
          <>
            <line x1={xs[hi]} y1={pad} x2={xs[hi]} y2={H - pad} stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.6" vectorEffect="non-scaling-stroke" />
            <circle cx={xs[hi]} cy={ys[hi]} r="3.5" fill="#fff" stroke={color} strokeWidth="2" />
          </>
        )}
      </svg>
      {hi != null && (
        <div style={{
          position: 'absolute', left: `${(hi / (points.length - 1)) * 100}%`, top: 2,
          transform: 'translate(-50%, 0)', background: 'var(--navy)', color: '#fff',
          padding: '3px 8px', borderRadius: 6, fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap',
          pointerEvents: 'none', boxShadow: 'var(--shadow-md)', zIndex: 5,
        }}>
          {labels?.[hi] ? `${fmtLabel(labels[hi])} · ` : ''}{points[hi].toLocaleString()} leases
        </div>
      )}
    </div>
  );
}

// ── Scopes-requiring-attention row (hover detail tooltip) ──────
function AttentionRow({ s, onClick }: { s: any; onClick: () => void }) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <tr className="clickable" onClick={onClick}
      onMouseMove={e => setTip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTip(null)}>
      <td style={{ padding: '6px 10px' }}>
        <div style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{s.scope_id}</div>
        <div style={{ ...MUTED, marginTop: 1 }}>{s.name || s.server_hostname || '—'}</div>
        {tip && (
          <div style={{
            position: 'fixed', left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 230), top: tip.y + 14,
            width: 210, background: 'var(--navy)', color: '#fff', padding: '8px 10px', borderRadius: 8,
            fontSize: 'var(--text-xs)', lineHeight: 1.5, pointerEvents: 'none', boxShadow: 'var(--shadow-md)', zIndex: 100,
          }}>
            <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{s.scope_id}</div>
            <div style={{ opacity: 0.85 }}>{s.name || s.server_hostname || '—'}</div>
            <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between' }}><span style={{ opacity: 0.75 }}>Utilization</span><span style={{ fontWeight: 700 }}>{Number(s.pct).toFixed(1)}%</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ opacity: 0.75 }}>In use / total</span><span>{s.in_use} / {s.total_ips}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ opacity: 0.75 }}>Free</span><span>{s.free}</span></div>
            {s.server_hostname && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ opacity: 0.75 }}>Server</span><span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.server_hostname}</span></div>}
            <div style={{ opacity: 0.7, marginTop: 4 }}>Click to open in DHCP →</div>
          </div>
        )}
      </td>
      <td className="mono" style={{ padding: '6px 10px', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
        {s.in_use} / {s.total_ips}
        {s.free < 10 && <span style={{ color: 'var(--red)', fontWeight: 700 }}> · {s.free} left</span>}
      </td>
      <td style={{ padding: '6px 10px' }}><UtilBar pct={s.pct} /></td>
    </tr>
  );
}

// ── DNS Health card (compact, clickable → DNS tab) ─────────────
interface DnsHealth {
  zones_total: number;
  servers_total: number;
  servers_online: number;
  zones_in_sync: number;
  zones_out_of_sync: number;
  replication_issues: number;
}
function DnsHealthCard({ data, onClick }: { data?: DnsHealth; onClick: () => void }) {
  const syncDenom = data ? data.zones_in_sync + data.zones_out_of_sync : 0;
  const issues = data?.replication_issues ?? 0;
  const issueColor = issues > 0 ? 'var(--red)' : 'var(--green)';
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--text-sm)' };
  return (
    <div onClick={onClick} className="clickable"
      style={{ ...CARD, cursor: 'pointer', transition: 'box-shadow 0.15s, transform 0.15s' }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={TITLE}>DNS Health</div>
        <span style={{ ...MUTED, color: 'var(--primary)', fontWeight: 600 }}>Open DNS →</span>
      </div>
      <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={rowStyle}>
          <span style={{ color: 'var(--text-secondary)' }}>Servers Online</span>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
            {data ? `${data.servers_online} / ${data.servers_total}` : '—'}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={{ color: 'var(--text-secondary)' }}>Zones In Sync</span>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
            {data ? `${data.zones_in_sync} / ${syncDenom}` : '—'}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={{ color: 'var(--text-secondary)' }}>Replication Issues</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: data ? issueColor : 'var(--text-muted)' }}>
            {data && issues > 0 && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--red)', boxShadow: '0 0 0 3px rgba(200,16,46,0.18)' }} />}
            {data ? issues : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}

// Dashboard success banner shown once after a self-update completes (?updated=true).
function UpdatedNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('updated') === 'true') {
      setShow(true);
      window.history.replaceState({}, '', window.location.pathname);
      const t = setTimeout(() => setShow(false), 5000);
      return () => clearTimeout(t);
    }
  }, []);
  if (!show) return null;
  return (
    <div onClick={() => setShow(false)} style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
      borderRadius: 8, fontSize: 'var(--text-md)', fontWeight: 600, cursor: 'pointer',
      color: '#166534', background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)',
    }}>
      <span aria-hidden>✓</span>
      <span style={{ flex: 1 }}>DDIVault updated successfully</span>
      <span aria-hidden style={{ opacity: 0.6 }}>×</span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: DASHBOARD — operations center
// ════════════════════════════════════════════════════════════
function DashboardTab({ onNavigate, onFocusScope }: { onNavigate: (tab: Tab, opts?: { anomalyType?: string }) => void; onFocusScope: (scopeId: string) => void }) {
  const [stats, setStats]   = useState<any>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeHistory, setScopeHistory] = useState<ScopeHistory[]>([]);
  const [ipDist, setIpDist] = useState<Record<string, number> | null>(null);
  const [leaseTrend, setLeaseTrend] = useState<{ day: string; leases: number }[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Operations Center controls ──────────────────────────────
  // Global time range drives every trend on the page; refreshNonce fans a refresh
  // out to all self-fetching child widgets; paused stops the 30s auto-refresh.
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d'>('7d');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [paused, setPaused] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const range = timeRange === '24h' ? { days: 1, hours: 24 } : timeRange === '30d' ? { days: 30, hours: 720 } : { days: 7, hours: 168 };

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api('/dashboard/stats'),
      api('/scopes'),
      api(`/scopes/history/all?hours=${range.hours}`),
      api('/dashboard/ip-distribution'),
      api(`/dashboard/lease-trend?days=${range.days}`),
    ]);
    const [s, sc, hist, dist, lt] = results;
    if (s.status  === 'fulfilled') setStats(s.value);
    if (sc.status === 'fulfilled') setScopes(sc.value.data || []);
    if (hist.status === 'fulfilled') setScopeHistory(hist.value.data || []);
    if (dist.status === 'fulfilled') setIpDist(dist.value.data || null);
    if (lt.status === 'fulfilled') setLeaseTrend((lt.value.data || []).map((d: any) => ({ day: d.day, leases: parseInt(d.leases) || 0 })));
    setLoading(false);
    setLastUpdated(Date.now());
  }, [range.hours, range.days]);

  // Reload inline data on time-range change and on every refresh tick (manual or
  // auto). Skeletons only show on the very first load — refreshes swap silently.
  useEffect(() => { load(); }, [load, refreshNonce]);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setRefreshNonce(n => n + 1), 30000);
    return () => clearInterval(t);
  }, [paused]);

  const navStr = useCallback((t: string, opts?: { anomalyType?: string }) => onNavigate(t as Tab, opts), [onNavigate]);

  // Trends derived from real history (start vs end of window)
  const trends = useMemo(() => {
    let critNow = 0, critThen = 0, warnNow = 0, warnThen = 0, usedNow = 0, usedThen = 0;
    for (const sh of scopeHistory) {
      const h = sh.history || [];
      if (!h.length) continue;
      const first = h[0], last = h[h.length - 1];
      if (last.percent_used >= 90) critNow++;
      if (first.percent_used >= 90) critThen++;
      if (last.percent_used >= 80 && last.percent_used < 90) warnNow++;
      if (first.percent_used >= 80 && first.percent_used < 90) warnThen++;
      usedNow += last.in_use || 0; usedThen += first.in_use || 0;
    }
    return { crit: critNow - critThen, warn: warnNow - warnThen, used: usedNow - usedThen };
  }, [scopeHistory]);

  const attention = useMemo(
    () => scopes
      .map(s => ({ ...s, pct: parseFloat(String(s.percent_used)) }))
      .filter(s => s.pct >= 80)
      .sort((a, b) => b.pct - a.pct),
    [scopes],
  );

  const topByUtil = useMemo(() => {
    const latest = (sh: ScopeHistory) => sh.history?.[sh.history.length - 1]?.percent_used ?? 0;
    return [...scopeHistory].filter(sh => (sh.history?.length ?? 0) >= 2).sort((a, b) => latest(b) - latest(a)).slice(0, 6);
  }, [scopeHistory]);

  const kpis = stats ? [
    { label: 'Managed IPs',     value: stats.ips?.total ?? 0,       sub: 'across all scopes',         color: 'var(--navy)',  textColor: 'var(--text-primary)', delta: 0,            invert: false, onClick: () => onNavigate('ipam') },
    { label: 'Active Leases',   value: stats.active_leases ?? 0,    sub: 'live DHCP clients',         color: 'var(--blue)',  delta: trends.used,  invert: true,  onClick: () => onNavigate('scopes') },
    { label: 'DNS Zones',       value: stats.dns_zones ?? 0,        sub: 'forward & reverse',         color: 'var(--teal)',  delta: 0,            invert: false, onClick: () => onNavigate('dns') },
    { label: 'Critical Scopes', value: stats.scopes?.critical ?? 0, sub: '≥ 90% utilization',         color: (stats.scopes?.critical ?? 0) > 0 ? 'var(--red)' : 'var(--green)',    delta: trends.crit, invert: false, onClick: () => onNavigate('scopes') },
    { label: 'Unknown Devices', value: ipDist?.unknown ?? 0,        sub: 'rogue / unmanaged',         color: (ipDist?.unknown ?? 0) > 0 ? 'var(--yellow)' : 'var(--green)', delta: 0, invert: false, onClick: () => onNavigate('ipam') },
    { label: 'Open Alerts',     value: stats.unacked_alerts ?? 0,   sub: 'unacknowledged',            color: (stats.unacked_alerts ?? 0) > 0 ? 'var(--red)' : 'var(--green)',  delta: 0, invert: false, onClick: () => onNavigate('events') },
  ] : [];

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <UpdatedNotice />
      <PageHeader title="Operations Center" subtitle="Live DDI health, triage, and trends. Auto-refreshes every 30s." />

      {/* Command bar — posture, collector heartbeat, time range, live/refresh */}
      <CommandBar
        timeRange={timeRange}
        onTimeRange={setTimeRange}
        lastUpdated={lastUpdated}
        onRefresh={() => setRefreshNonce(n => n + 1)}
        paused={paused}
        onTogglePause={() => setPaused(p => !p)}
        refreshNonce={refreshNonce}
        onNavigate={navStr}
      />

      {/* KPI strip (6 across, compact) — the brief at-a-glance overview, on top */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0,1fr))', gap: 12 }}>
        {loading && !stats
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="kpi-card" style={{ borderLeftColor: 'var(--border)', padding: '12px 16px' }}>
                <Skeleton height={22} width="45%" /><div style={{ height: 6 }} /><Skeleton height={12} width="75%" />
              </div>
            ))
          : kpis.map((k, i) => (
              <div key={i} className="kpi-card" onClick={k.onClick}
                style={{ borderLeftColor: k.color, padding: '12px 16px', cursor: 'pointer', transition: 'transform 0.15s, box-shadow 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = ''; }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: (k as { textColor?: string }).textColor || k.color, lineHeight: 1, letterSpacing: '-0.5px' }}>{k.value}</div>
                  <Trend delta={k.delta} invert={k.invert} />
                </div>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)', marginTop: 6 }}>{k.label}</div>
                <div style={{ ...MUTED, marginTop: 2 }}>{k.sub}</div>
              </div>
            ))}
      </div>

      {/* Four pillar scorecards — DHCP / DNS / IPAM / Security */}
      <PillarScorecards timeRange={timeRange} refreshNonce={refreshNonce} onNavigate={navStr} />

      {/* Priority Action Center — collapsible triage queue, demoted below the overview */}
      <PriorityActionCenter refreshNonce={refreshNonce} onNavigate={navStr} onFocusScope={onFocusScope} />

      {/* Infrastructure & redundancy — server health trend + HA/failover */}
      <InfraRedundancy timeRange={timeRange} refreshNonce={refreshNonce} onNavigate={navStr} />

      {/* Capacity & trends */}
      <div>
        <SectionHeader>Capacity &amp; Trends</SectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 16 }}>
          <div style={CARD}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={TITLE}>Scopes Requiring Attention</div>
              <span style={MUTED}>{attention.length} over 80%</span>
            </div>
            {loading ? <TableSkeleton rows={5} cols={3} /> : attention.length === 0 ? (
              <EmptyState
                icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>}
                title="All scopes healthy"
                message="No DHCP scope is above 80% utilization."
              />
            ) : (
              <div>
                <table className="data-table">
                  <thead><tr><th>Scope</th><th>Used / Total</th><th style={{ minWidth: 150 }}>Utilization</th></tr></thead>
                  <tbody>
                    {attention.slice(0, 3).map(s => (
                      <AttentionRow key={s.id} s={s} onClick={() => onFocusScope(s.scope_id)} />
                    ))}
                  </tbody>
                </table>
                {attention.length > 3 && (
                  <div style={{ padding: '8px 10px', textAlign: 'center', borderTop: '1px solid var(--border-light)' }}>
                    <button onClick={() => onNavigate('scopes')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>+{attention.length - 3} more · View all →</button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={CARD}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={TITLE}>Active Lease Trend</div>
              <span style={MUTED}>last {timeRange}</span>
            </div>
            <div style={{ padding: '12px 16px' }}>
              {loading ? <Skeleton height={140} /> : <LineChart points={leaseTrend.map(d => d.leases)} labels={leaseTrend.map(d => d.day)} height={140} />}
            </div>
          </div>
        </div>
      </div>

      {/* Capacity forecast (full width) */}
      <CapacityForecast onViewAll={() => onNavigate('scopes')} onRowClick={(id) => onFocusScope(id)} />

      {/* Utilization trends — top 6 scopes by utilization */}
      <div style={CARD}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={TITLE}>Utilization Trends</div>
          <span style={MUTED}>Top 6 scopes · last {timeRange}</span>
        </div>
        <div style={{ padding: '12px 16px' }}>
          {loading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={56} />)}
            </div>
          ) : topByUtil.length === 0 ? (
            <EmptyState title="No trend data yet" message="Utilization history accumulates as scopes are polled over time." />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              {topByUtil.map(sh => {
                const latest = sh.history[sh.history.length - 1].percent_used;
                const first = sh.history[0].percent_used;
                const color = pctColor(latest);
                return (
                  <div key={sh.scope_id} onClick={() => onFocusScope(sh.scope_id)}
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 10, padding: 10, cursor: 'pointer', transition: 'box-shadow 0.15s, transform 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.boxShadow = `0 0 0 2px ${color}55, var(--shadow-md)`; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                    onMouseLeave={e => { e.currentTarget.style.boxShadow = ''; e.currentTarget.style.transform = 'none'; }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>{sh.scope_id}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 'var(--text-base)', fontWeight: 700, color }}>{latest.toFixed(1)}%</span>
                        <Trend delta={latest - first} invert={false} />
                      </div>
                    </div>
                    <Sparkline data={sh.history} color={color} />
                    <div style={{ ...MUTED, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sh.name || sh.scope_id}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* DNS, IPAM & Security */}
      <div>
        <SectionHeader>DNS, IPAM &amp; Security</SectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16 }}>
          <DnsAnalyticsCard refreshNonce={refreshNonce} onNavigate={navStr} />
          <SecurityOverview />
          <SiteHealth onSiteClick={() => onNavigate('infra')} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: 16, marginTop: 12 }}>
          <div style={CARD}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)' }}><div style={TITLE}>IP Address Distribution</div></div>
            <div style={{ padding: '12px 16px' }}>
              {loading ? <Skeleton height={110} /> : (
                <Donut dim={110}
                  onSegmentClick={(label) => onNavigate(label === 'DHCP' ? 'scopes' : 'ipam')}
                  data={[
                  { label: 'Available', value: ipDist?.available ?? 0, color: 'var(--green)' },
                  { label: 'DHCP', value: ipDist?.dhcp ?? 0, color: 'var(--blue)' },
                  { label: 'Reserved', value: ipDist?.reserved ?? 0, color: 'var(--teal)' },
                  { label: 'Unknown', value: ipDist?.unknown ?? 0, color: 'var(--yellow)' },
                  { label: 'Offline', value: ipDist?.offline ?? 0, color: 'var(--text-muted)' },
                ]} />
              )}
            </div>
          </div>
          <DeviceDonut />
        </div>
      </div>

      {/* Unified activity feed — DHCP events / config changes / fired alerts */}
      <ActivityFeed refreshNonce={refreshNonce} onNavigate={navStr} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: EVENTS & ALERTS
// ════════════════════════════════════════════════════════════

// Alert table body — shared by the open (active) and acknowledged (muted) tables.
function AlertRows({ alerts, muted, onAck }: { alerts: AlertEvent[]; muted?: boolean; onAck?: (id: number) => void }) {
  if (alerts.length === 0) {
    return <tr><td colSpan={6} style={{ textAlign: 'center', padding: 28, ...MUTED }}>No alerts</td></tr>;
  }
  const rowStyle: React.CSSProperties = muted ? { color: 'var(--text-muted)' } : {};
  return (
    <>
      {alerts.map(a => (
        <tr key={a.id} style={rowStyle}>
          <td><span className={`badge ${muted ? 'badge-gray' : a.severity === 'critical' ? 'badge-red' : a.severity === 'info' ? 'badge-blue' : 'badge-yellow'}`}>{a.severity}</span></td>
          <td>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>{a.message}</span>
              {a.occurrence_count && a.occurrence_count > 1 ? (
                <span className="badge badge-gray" style={{ fontSize: 'var(--text-xs)' }}>fired {a.occurrence_count}×</span>
              ) : null}
            </div>
            {a.explanation && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>{a.explanation}</div>
            )}
          </td>
          <td className="mono" style={{ fontSize: 'var(--text-xs)' }}>{a.scope_id || '—'}</td>
          <td style={{ fontSize: 'var(--text-xs)' }}>{new Date(a.fired_at).toLocaleString()}</td>
          <td><span className={`badge ${a.resolved_at ? 'badge-green' : a.acknowledged ? 'badge-gray' : 'badge-red'}`}>{a.resolved_at ? 'Resolved' : a.acknowledged ? 'ACK' : 'Open'}</span></td>
          <td>
            {muted
              ? <span style={{ fontSize: 'var(--text-xs)', ...MUTED }}>✓ acked</span>
              : (!a.acknowledged && onAck && <button onClick={() => onAck(a.id)} style={{ fontSize: 'var(--text-xs)', color: 'var(--blue)', background: 'none', border: 'none', cursor: 'pointer' }}>Ack</button>)}
          </td>
        </tr>
      ))}
    </>
  );
}

function EventsTab() {
  const [events, setEvents]   = useState<DhcpEvent[]>([]);
  const [alerts, setAlerts]   = useState<AlertEvent[]>([]);
  const [evTotal, setEvTotal] = useState(0);
  const [alTotal, setAlTotal] = useState(0);
  const [page, setPage]       = useState(1);
  const [hours, setHours]     = useState(24);
  const [typeFilter, setTypeFilter] = useState('');
  const [view, setView]       = useState<'alerts' | 'events'>('alerts');
  const [alertFilter, setAlertFilter] = useState<'all' | 'open' | 'acked' | 'resolved'>('open');
  const [ackedOpen, setAckedOpen] = useState(false);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: '50', hours: String(hours) });
    if (typeFilter) params.set('type', typeFilter);
    api(`/events?${params}`).then(d => { setEvents(d.data || []); setEvTotal(d.total || 0); }).catch(() => {});
    api('/alerts?limit=200').then(d => { setAlerts(d.data || []); setAlTotal(d.total || 0); }).catch(() => {});
  }, [page, hours, typeFilter]);

  const reloadAlerts = () => api('/alerts?limit=200').then(d => { setAlerts(d.data || []); setAlTotal(d.total || 0); }).catch(() => {});

  const ack = async (id: number) => {
    await api(`/alerts/${id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin' }) });
    toast('Alert acknowledged', 'success');
    reloadAlerts();
  };
  const ackAll = async () => {
    await api('/alerts/acknowledge-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin' }) });
    toast('All alerts acknowledged', 'success');
    reloadAlerts();
  };

  const openAlerts     = useMemo(() => alerts.filter(a => !a.acknowledged && !a.resolved_at), [alerts]);
  const ackedAlerts    = useMemo(() => alerts.filter(a =>  a.acknowledged), [alerts]);
  const resolvedAlerts = useMemo(() => alerts.filter(a => !a.acknowledged &&  a.resolved_at), [alerts]);

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader title="Events & Alerts" subtitle="Fired alerts and the raw DHCP event log from your servers" />
      <div className="sub-tab-bar">
        <div className="segmented">
          <button className={view === 'alerts' ? 'active' : ''} onClick={() => setView('alerts')}>Alerts ({alTotal})</button>
          <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>DHCP Events ({evTotal})</button>
        </div>
      </div>

      {view === 'alerts' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Filter pills */}
          <div className="segmented">
            <button className={alertFilter === 'open' ? 'active' : ''} onClick={() => setAlertFilter('open')}>Open ({openAlerts.length})</button>
            <button className={alertFilter === 'acked' ? 'active' : ''} onClick={() => setAlertFilter('acked')}>Acknowledged ({ackedAlerts.length})</button>
            <button className={alertFilter === 'resolved' ? 'active' : ''} onClick={() => setAlertFilter('resolved')}>Resolved ({resolvedAlerts.length})</button>
            <button className={alertFilter === 'all' ? 'active' : ''} onClick={() => setAlertFilter('all')}>All</button>
          </div>

          {/* Open alerts — always on top, full table */}
          {(alertFilter === 'open' || alertFilter === 'all') && (
            <div style={CARD}>
              <div style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-light)' }}>
                <div style={TITLE}>Alert History</div>
                {openAlerts.length > 0 && <button className="btn btn-primary" onClick={ackAll}>Acknowledge All</button>}
              </div>
              <table className="data-table">
                <thead><tr><th>Severity</th><th>Message</th><th>Scope</th><th>Fired</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  <AlertRows alerts={openAlerts} onAck={ack} />
                </tbody>
              </table>
            </div>
          )}

          {/* Acknowledged alerts — collapsible, muted */}
          {(alertFilter === 'acked' || alertFilter === 'all') && ackedAlerts.length > 0 && (
            <div style={CARD}>
              <div
                onClick={() => setAckedOpen(o => !o)}
                style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', borderBottom: (ackedOpen || alertFilter === 'acked') ? '1px solid var(--border-light)' : 'none' }}
              >
                <div style={{ ...TITLE, color: 'var(--text-muted)' }}>✓ Acknowledged ({ackedAlerts.length} alert{ackedAlerts.length === 1 ? '' : 's'})</div>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: (ackedOpen || alertFilter === 'acked') ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>
              {(ackedOpen || alertFilter === 'acked') && (
                <table className="data-table">
                  <thead><tr><th>Severity</th><th>Message</th><th>Scope</th><th>Fired</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>
                    <AlertRows alerts={ackedAlerts} muted />
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Auto-resolved alerts — collapsible, muted */}
          {(alertFilter === 'resolved' || alertFilter === 'all') && resolvedAlerts.length > 0 && (
            <div style={CARD}>
              <div
                onClick={() => setResolvedOpen(o => !o)}
                style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', borderBottom: (resolvedOpen || alertFilter === 'resolved') ? '1px solid var(--border-light)' : 'none' }}
              >
                <div style={{ ...TITLE, color: 'var(--text-muted)' }}>✓ Auto-resolved ({resolvedAlerts.length} alert{resolvedAlerts.length === 1 ? '' : 's'})</div>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: (resolvedOpen || alertFilter === 'resolved') ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>
              {(resolvedOpen || alertFilter === 'resolved') && (
                <table className="data-table">
                  <thead><tr><th>Severity</th><th>Message</th><th>Scope</th><th>Fired</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>
                    <AlertRows alerts={resolvedAlerts} muted />
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {view === 'events' && (
        <div style={CARD}>
          <div style={{ padding: '12px 18px', display: 'flex', gap: 10, alignItems: 'center', borderBottom: '1px solid var(--border-light)' }}>
            <div style={TITLE}>DHCP Event Log</div>
            <div style={{ flex: 1 }} />
            <select className="input" value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(1); }}>
              <option value="">All types</option>
              {['Assign','Renew','Release','Conflict','ScopeFull','ScopeWarning','NACK','RogueDHCP'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="input" value={hours} onChange={e => { setHours(parseInt(e.target.value)); setPage(1); }}>
              {[1,6,24,48,168].map(h => <option key={h} value={h}>Last {h}h</option>)}
            </select>
          </div>
          <table className="data-table">
            <thead><tr><th>Time</th><th>Type</th><th>IP</th><th>Hostname</th><th>MAC</th><th>Description</th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 28, ...MUTED }}>No events</td></tr>}
              {events.map(e => (
                <tr key={e.id}>
                  <td style={{ fontSize: 'var(--text-xs)' }}>{e.event_time ? new Date(e.event_time).toLocaleString() : '—'}</td>
                  <td><EventTypeBadge type={e.event_type} /></td>
                  <td className="mono">{e.ip_address || '—'}</td>
                  <td>{e.hostname || '—'}</td>
                  <td className="mono" style={{ fontSize: 'var(--text-xs)' }}>{e.mac_address || '—'}</td>
                  <td style={{ fontSize: 'var(--text-xs)', ...MUTED, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: 12 }}>
            {page > 1 && <button className="btn" onClick={() => setPage(p => p - 1)}>← Prev</button>}
            <span style={{ ...MUTED, padding: '6px 0' }}>Page {page} · {evTotal} events</span>
            {events.length === 50 && <button className="btn" onClick={() => setPage(p => p + 1)}>Next →</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// SYSTEM UPDATES (Check for Updates)
// ════════════════════════════════════════════════════════════
type UpdateStatus = {
  current_version?: string;
  latest_version?: string;
  current_commit?: string;
  latest_commit?: string;
  current_hash?: string;
  latest_hash?: string;
  up_to_date?: boolean;
  update_available?: boolean;
  release_notes?: string[];
  release_date?: string;
  error?: string;
};

const UPDATE_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
// Format an ISO date "2026-06-09" → "June 9, 2026" (no timezone shifting).
function fmtReleaseDate(d?: string): string {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return `${UPDATE_MONTHS[m - 1]} ${day}, ${y}`;
}
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — covers slow npm install + Next.js build before services are back
// After the API is confirmed stably back up, wait this long before reloading so
// the Next.js frontend (which starts AFTER the API) has time to finish booting —
// otherwise the reload lands on "page cannot be reached" for 20-30 seconds.
const RELOAD_COUNTDOWN_SECONDS = 15;

function UpdateConfirmModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: 24, width: 460, maxWidth: '92%' }} onMouseDown={e => e.stopPropagation()}>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, marginBottom: 8 }}>Start Update?</div>
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
          Services will restart and you&apos;ll lose connection for 30&ndash;60 seconds. The page reloads automatically when the update completes.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm}>Start Update</button>
        </div>
      </div>
    </div>
  );
}

// Full-screen overlay shown during an update; polls /api/health for recovery.
// State machine: 'starting' → 'down' → 'back_up'. A healthy response only counts
// as recovery once the API has actually been seen down first, so we never declare
// "complete" against the still-running pre-restart service.
function UpdatingOverlay() {
  const [phase, setPhase] = useState<'starting' | 'down' | 'back_up' | 'timeout'>('starting');
  const [countdown, setCountdown] = useState(RELOAD_COUNTDOWN_SECONDS);
  const wentDown = useRef(false);
  const consecutiveUp = useRef(0);

  // Navigate to the dashboard with a success banner. Used by both the countdown
  // and the "Reload Now" button (which skips the remaining countdown).
  const reloadToDashboard = () => { window.location.href = '/?updated=true'; };

  useEffect(() => {
    let active = true;
    const startedAt = Date.now();
    let pollId: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => { if (pollId !== null) { clearInterval(pollId); pollId = null; } };

    const tick = async () => {
      if (!active) return;
      if (Date.now() - startedAt > UPDATE_TIMEOUT_MS) {
        stopPolling();
        if (active) setPhase('timeout');
        return;
      }
      // Per-poll timeout via AbortController so a hung connection during the
      // restart still resolves as "down" within the polling cadence. Kept under
      // the 2s poll interval so probes don't pile up.
      const ctrl = new AbortController();
      const abortId = setTimeout(() => ctrl.abort(), 1800);
      let ok = false;
      try {
        const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
        ok = res.ok; // non-200 counts as down
      } catch {
        ok = false;
      } finally {
        clearTimeout(abortId);
      }
      if (!active) return;
      if (!ok) {
        // API is down (restarting). Reset the consecutive-success counter: during
        // startup the API can answer one probe then drop again, so any failure
        // restarts the stability window.
        consecutiveUp.current = 0;
        wentDown.current = true;
        setPhase('down');
        return;
      }
      // Healthy response. Only a recovery if we previously saw it go down.
      if (wentDown.current) {
        // Require 3 consecutive healthy probes (≈6s at the 2s cadence) before
        // declaring the API stably back up. A single success after going down
        // isn't enough — services may respond once then briefly drop again
        // mid-startup, which would trigger a premature reload.
        consecutiveUp.current += 1;
        if (consecutiveUp.current >= 3) {
          setPhase('back_up');
          stopPolling();
          // The reload itself is driven by the countdown effect below — the API
          // is up, but Next.js needs a little longer before it can serve pages.
        }
      }
      // else: still the pre-restart API — keep waiting for it to go down.
    };

    pollId = setInterval(tick, 2000);
    tick();

    return () => {
      active = false;
      stopPolling();
    };
  }, []);

  // Once the API is confirmed stably back up, count down (15…14…13…) before
  // reloading so the Next.js frontend has time to finish starting after the API.
  useEffect(() => {
    if (phase !== 'back_up') return;
    if (countdown <= 0) { reloadToDashboard(); return; }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [phase, countdown]);

  let statusLine = 'Starting update…';
  if (phase === 'down') statusLine = 'Services restarting…';
  else if (phase === 'back_up') statusLine = `✓ Services are back online. Reloading in ${countdown} second${countdown === 1 ? '' : 's'}…`;
  else if (phase === 'timeout') statusLine = 'Update is taking longer than expected. Try refreshing the page manually.';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(15,23,42,0.78)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: 28, maxWidth: 440, width: '100%', textAlign: 'center' }}>
        {phase !== 'back_up' && phase !== 'timeout' && (
          <div style={{ fontSize: 44, lineHeight: 1, display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</div>
        )}
        {phase === 'back_up' && <div style={{ fontSize: 44, lineHeight: 1 }}>✓</div>}
        {phase === 'timeout' && <div style={{ fontSize: 44, lineHeight: 1 }}>⚠</div>}
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, marginTop: 14 }}>Updating DDIVault…</div>
        <p style={{ ...MUTED, marginTop: 6 }}>Pulling latest code and restarting services. Do not close this window.</p>
        <p style={{ fontWeight: 600, margin: '14px 0' }}>{statusLine}</p>
        {phase === 'back_up' && (
          <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, margin: '4px 0 10px', color: 'var(--primary)' }}>
            {countdown}
          </div>
        )}
        {phase !== 'back_up' && (
          <p style={{ ...MUTED, fontSize: 'var(--text-sm)' }}>(This usually takes 1-3 minutes)</p>
        )}
        <button
          className="btn btn-primary"
          style={{ marginTop: 10 }}
          onClick={phase === 'back_up' ? reloadToDashboard : () => window.location.reload()}
        >
          Reload Now
        </button>
      </div>
    </div>
  );
}

function SystemUpdates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  const [licenseBlocked, setLicenseBlocked] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setCheckErr(null);
    try {
      const s = await api('/system/update-status');
      setStatus(s);
    } catch (e: any) {
      setCheckErr(e?.message || 'Could not check for updates');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { check(); }, [check]);

  const startUpdate = useCallback(async () => {
    setConfirming(false);
    setUpdateErr(null);
    setLicenseBlocked(null);
    try {
      // The API returns { started: true } BEFORE services stop (the installer
      // waits 5s first), so a clean response is expected on success. Only show
      // the overlay once the server confirms the task was scheduled — otherwise
      // the overlay would hang forever on a failure such as SERVER_IP not being
      // configured (HTTP 400), a service account that cannot create a SYSTEM
      // task (HTTP 500), or a read-only license (HTTP 402).
      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const r = await res.json().catch(() => ({}));
      // 402 Payment Required → license expired/unverifiable, updates disabled.
      if (res.status === 402) {
        setLicenseBlocked(r?.error || 'License expired — updates disabled. Please renew your NocVault license.');
        return;
      }
      if (!res.ok) {
        setUpdateErr(r?.error || `HTTP ${res.status}`);
        return;
      }
      if (r && r.started) {
        setUpdating(true);
      } else {
        setUpdateErr((r && r.error) || 'Update did not start. Check the API logs.');
      }
    } catch (e: any) {
      setUpdateErr(e?.message || 'Failed to start update.');
    }
  }, []);

  const hubUrl = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

  const hasError = !!(status?.error) || !!checkErr;
  const errText = status?.error || checkErr;
  const upToDate = !hasError && !!status?.up_to_date;
  const updatesAvailable = !hasError && !!status?.update_available;

  return (
    <>
      {checking ? (
        <div style={MUTED}>Checking for updates…</div>
      ) : hasError ? (
        <div>
          <div style={{ color: 'var(--red)', fontWeight: 600, marginBottom: 10 }}>{errText}</div>
          <button className="btn" onClick={check}>Re-check</button>
        </div>
      ) : upToDate ? (
        <div>
          <div style={{ color: 'var(--green)', fontWeight: 600 }}>✓ DDIVault is up to date</div>
          <div style={{ ...MUTED, margin: '6px 0 12px' }}>Current version: <code>{status?.current_version}</code></div>
          <button className="btn" onClick={check}>Re-check</button>
        </div>
      ) : updatesAvailable ? (
        <div>
          <div style={{ fontWeight: 700, fontSize: 'var(--text-md)' }}>
            {status?.current_version === status?.latest_version
              ? <>🔄 Patches available since v{status?.current_version}</>
              : <>🔄 Update available: v{status?.current_version} → v{status?.latest_version}</>}
          </div>
          {(status?.current_commit || status?.latest_commit) && (
            <div style={{ ...MUTED, fontSize: 'var(--text-base)', margin: '6px 0 0' }}>
              Current: v{status?.current_version}
              {status?.current_commit && <> (<code>{status.current_commit}</code>)</>}
              {'  →  '}
              Latest: v{status?.latest_version}
              {status?.latest_commit && <> (<code>{status.latest_commit}</code>)</>}
            </div>
          )}
          {!!status?.release_notes?.length && (
            <div style={{ margin: '12px 0' }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                What&apos;s new in v{status?.latest_version}
              </div>
              <ul style={{
                margin: 0, padding: 0, listStyle: 'none',
                border: '1px solid var(--border)', borderRadius: 8,
                background: 'var(--bg-primary)',
                fontSize: 'var(--text-base)', lineHeight: 1.5,
              }}>
                {status.release_notes.map((note, i) => (
                  <li key={i} style={{ display: 'flex', gap: 8, padding: '6px 14px', color: 'var(--text-primary)' }}>
                    <span style={{ color: 'var(--primary)', flexShrink: 0 }}>&bull;</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {status?.release_date && (
            <div style={{ ...MUTED, fontSize: 'var(--text-base)', margin: '6px 0' }}>
              Released: {fmtReleaseDate(status.release_date)}
            </div>
          )}
          <div style={{ color: 'var(--yellow)', fontWeight: 600, fontSize: 'var(--text-base)', margin: '12px 0' }}>
            ⚠ Services will restart during the update — you may lose connection for 30&ndash;60 seconds.
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={() => setConfirming(true)}>Update Now</button>
            <button className="btn" onClick={check}>Re-check</button>
          </div>
          {licenseBlocked && (
            <div style={{ color: 'var(--red)', fontWeight: 600, fontSize: 'var(--text-base)', marginTop: 12 }}>
              ⚠ License expired — updates disabled. Renew your license to receive updates.{' '}
              <a href={`${hubUrl}/settings/license`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', textDecoration: 'underline' }}>
                Manage License →
              </a>
            </div>
          )}
          {updateErr && <div style={{ color: 'var(--red)', fontWeight: 600, fontSize: 'var(--text-base)', marginTop: 12 }}>⚠ {updateErr}</div>}
        </div>
      ) : (
        <button className="btn" onClick={check}>Check for Updates</button>
      )}

      {confirming && <UpdateConfirmModal onCancel={() => setConfirming(false)} onConfirm={startUpdate} />}
      {updating && <UpdatingOverlay />}
    </>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: SETTINGS
// ════════════════════════════════════════════════════════════
function SettingField({ label, value, settingKey, placeholder, helpText, type, onSave }: {
  label: string; value: string; settingKey: string; placeholder?: string; helpText?: string; type?: string;
  onSave: (key: string, value: string) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        className="input" style={{ width: '100%' }} type={type} defaultValue={value} placeholder={placeholder}
        onBlur={e => { if (e.target.value !== value) onSave(settingKey, e.target.value); }}
      />
      {helpText && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>{helpText}</div>}
    </div>
  );
}

// ── Settings sub-tab pill (mirrors the DNS tab pill style) ─────
function SettingsPill({ label, active, onClick, badge }: { label: string; active: boolean; onClick: () => void; badge?: boolean }) {
  return (
    <button onClick={onClick} className={active ? 'settings-tab active' : 'settings-tab'}>
      {label}
      {badge && (
        <span title="Update available" style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: '#dc2626', marginLeft: 6, verticalAlign: 'middle',
        }} />
      )}
    </button>
  );
}

// ── NocVault hub integration card — Integrations tab ──────────
function IntegrationsHubCard({ titleStyle }: { titleStyle: React.CSSProperties }) {
  const hub = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
  return (
    <div style={{ ...CARD, padding: 20 }}>
      <div style={titleStyle}>NocVault Hub</div>
      <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
        <div>DDIVault authenticates through the NocVault hub (SSO) and shares its sites directory.</div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={MUTED}>Hub URL</span>
          <code style={{ fontSize: 'var(--text-sm)' }}>{hub}</code>
        </div>
        <div style={{ marginTop: 12 }}>
          <a href={`${hub}/launcher`} style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: 'var(--text-base)', fontWeight: 600 }}>Open NocVault Hub →</a>
        </div>
      </div>
    </div>
  );
}

// ── About card — About tab (NocVault suite standard) ──────────
function AboutCard({ titleStyle }: { titleStyle: React.CSSProperties }) {
  const [ver, setVer] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setVer(d.version || null); })
      .catch(() => {});
  }, []);
  const v = ver || '1.0.0';
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 16, fontSize: 'var(--text-base)', padding: '7px 0', borderBottom: '1px solid var(--border-light)' };
  const ABOUT_ROWS: [string, React.ReactNode][] = [
    ['Product', 'DDIVault — DNS, DHCP & IPAM'],
    ['Family', 'NocVault Network Intelligence Suite'],
    ['Version', <code key="v">v{v}</code>],
    ['App Port', '3006'],
    ['API Port', '3007 (internal)'],
    ['Collector', 'Background polling service'],
    ['Database', 'PostgreSQL 16'],
    ['Runtime', 'Node.js 20 · Next.js 14'],
  ];
  return (
    <div style={{ ...CARD, padding: 20 }}>
      <div style={titleStyle}>About</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {ABOUT_ROWS.map(([label, value], i) => (
          <div key={label} style={i === ABOUT_ROWS.length - 1 ? { ...row, borderBottom: 'none' } : row}>
            <span style={{ ...MUTED, width: 160, flexShrink: 0 }}>{label}</span>
            <span style={{ color: 'var(--text-primary)' }}>{value}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, lineHeight: 1.7, fontSize: 'var(--text-base)' }}>
        <div style={{ fontWeight: 700 }}>DDIVault v{v}</div>
        <div style={MUTED}>Part of the NocVault Network Intelligence Suite</div>
        <div style={MUTED}>© 2026 NocVault</div>
      </div>
    </div>
  );
}

type SettingsSubTab = 'general' | 'notifications' | 'integrations' | 'updates' | 'about';

function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [subTab, setSubTab] = useState<SettingsSubTab>('general');
  const [updateAvail, setUpdateAvail] = useState(false);
  const { toast } = useToast();

  useEffect(() => { api('/settings').then(d => setSettings(d.data || {})).catch(() => {}); }, []);

  // Red dot on the Updates tab when an update is available (matches the banner).
  useEffect(() => {
    fetch('/api/system/update-available')
      .then(r => r.json())
      .then(d => setUpdateAvail(!!d.available))
      .catch(() => {});
  }, []);

  // Deep-link from the update-notifier banner: /?settingsTab=updates.
  useEffect(() => {
    const st = new URLSearchParams(window.location.search).get('settingsTab');
    if (st && ['general', 'notifications', 'integrations', 'updates', 'about'].includes(st)) {
      setSubTab(st as SettingsSubTab);
    }
  }, []);

  const save = useCallback(async (key: string, value: string) => {
    await api('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
    setSettings(prev => ({ ...prev, [key]: value }));
    toast('Saved', 'success');
  }, [toast]);

  const sectionTitle: React.CSSProperties = { fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 14 };
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 };

  const TABS: { id: SettingsSubTab; label: string; subtitle: string }[] = [
    { id: 'general',       label: 'General',      subtitle: 'IPAM scan and data retention' },
    { id: 'notifications', label: 'Email Alerts', subtitle: 'Email delivery, alert recipients, and alert rules' },
    { id: 'integrations',  label: 'Integrations', subtitle: 'NocVault hub connection and REST API keys' },
    { id: 'updates',       label: 'Updates',      subtitle: 'Software version and update management' },
    { id: 'about',         label: 'About',        subtitle: 'Application and system information' },
  ];
  const activeSubtitle = TABS.find(t => t.id === subTab)?.subtitle || '';

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', boxSizing: 'border-box' }}>
      <PageHeader title="Settings" subtitle={activeSubtitle} />

      {/* Sub-tab underline bar (NocVault suite standard) */}
      <div className="settings-tabs">
        {TABS.map(t => (
          <SettingsPill key={t.id} label={t.label} active={subTab === t.id} onClick={() => setSubTab(t.id)} badge={t.id === 'updates' && updateAvail} />
        ))}
      </div>

      {/* Independently-scrolling content region */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {subTab === 'general' && (
          <div style={grid}>
            <div style={{ ...CARD, padding: 20 }}>
              <div style={sectionTitle}>IPAM Scan Settings</div>
              <SettingField label="DNS Server for Scans" value={settings.scan_dns_server || ''} settingKey="scan_dns_server" placeholder="e.g. 192.168.1.10 (leave blank for system default)" helpText="Used for PTR / reverse DNS lookups during IPAM subnet scans." onSave={save} />
              <SettingField label="Scope Warning Threshold (%)" value={settings.scope_warning_pct || '80'} settingKey="scope_warning_pct" type="number" onSave={save} />
              <SettingField label="Scope Critical Threshold (%)" value={settings.scope_critical_pct || '90'} settingKey="scope_critical_pct" type="number" onSave={save} />
            </div>
            <div style={{ ...CARD, padding: 20 }}>
              <div style={sectionTitle}>Data Retention</div>
              <SettingField label="Retention Period (days)" value={settings.retention_days || ''} settingKey="retention_days" placeholder="90" helpText="DHCP events and scan history older than this are cleaned up automatically." onSave={save} />
            </div>
          </div>
        )}

        {subTab === 'notifications' && (
          <>
            <div style={{ ...CARD, padding: 20 }}>
              <div style={sectionTitle}>Email / SMTP</div>
              <SmtpSettings />
            </div>
            <div style={{ ...CARD, padding: 20 }}>
              <div style={sectionTitle}>Alert Recipients</div>
              <AlertRecipients />
            </div>
            <div style={{ ...CARD, padding: 20 }}>
              <div style={sectionTitle}>Alert Rules</div>
              <AlertRules />
            </div>
          </>
        )}

        {subTab === 'integrations' && (
          <>
            <IntegrationsHubCard titleStyle={sectionTitle} />
            {/* API key management (REST API v1) */}
            <ApiKeysSection />
          </>
        )}

        {subTab === 'updates' && (
          <div style={{ ...CARD, padding: 20 }}>
            <div style={sectionTitle}>Software Updates</div>
            <SystemUpdates />
          </div>
        )}

        {subTab === 'about' && (
          <AboutCard titleStyle={sectionTitle} />
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// SIDEBAR + APP SHELL
// ════════════════════════════════════════════════════════════
const ICONS: Record<string, React.ReactNode> = {
  dashboard: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  scopes:    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  ipam:      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  dns:       <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
  events:    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  servers:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  settings:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  infra:     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  reports:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  audit:     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
};

// Suite-standard per-route nav-icon chip colors: [text/glyph color, chip background].
// Only the ACTIVE item is colored; inactive chips are neutral faint-white.
const ROUTE_CHIP: Record<string, { color: string; bg: string }> = {
  dashboard: { color: '#f87171', bg: 'rgba(248,113,113,0.22)' },
  scopes:    { color: '#60a5fa', bg: 'rgba(96,165,250,0.20)' },
  ipam:      { color: '#fbbf24', bg: 'rgba(251,191,36,0.20)' },
  dns:       { color: '#34d399', bg: 'rgba(52,211,153,0.20)' },
  events:    { color: '#a78bfa', bg: 'rgba(167,139,250,0.20)' },
  servers:   { color: '#22d3ee', bg: 'rgba(34,211,238,0.20)' },
  infra:     { color: '#38bdf8', bg: 'rgba(56,189,248,0.20)' },
  reports:   { color: '#f472b6', bg: 'rgba(244,114,182,0.20)' },
  audit:     { color: '#fb923c', bg: 'rgba(251,146,60,0.20)' },
  settings:  { color: '#9ca3af', bg: 'rgba(156,163,175,0.20)' },
};

const SIDEBAR_ITEMS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'scopes',    label: 'DHCP' },
  { id: 'ipam',      label: 'IPAM' },
  { id: 'dns',       label: 'DNS' },
  { id: 'events',    label: 'Events & Alerts' },
  { id: 'servers',   label: 'Known Servers' },
  { id: 'infra',     label: 'Infrastructure' },
  { id: 'reports',   label: 'Reports' },
  { id: 'audit',     label: 'Audit Log' },
  { id: 'settings',  label: 'Settings' },
];

export default function DDIVaultApp() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [collectorOnline, setCollectorOnline] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [focusScope, setFocusScope] = useState<string | null>(null);
  const { canManageSystem, isViewer, isSiteAdmin } = useRBAC();
  const { state: licenseState, loading: licenseLoading } = useLicense();

  // Settings is super_admin only; Audit Log is hidden from viewers and site_admins.
  const visibleItems = useMemo(() => SIDEBAR_ITEMS.filter(item => {
    if (item.id === 'settings') return canManageSystem;
    if (item.id === 'audit')    return !isViewer && !isSiteAdmin;
    return true;
  }), [canManageSystem, isViewer, isSiteAdmin]);

  // If the active tab is no longer permitted, fall back to the dashboard.
  useEffect(() => {
    if (!visibleItems.some(i => i.id === tab)) setTab('dashboard');
  }, [visibleItems, tab]);

  useEffect(() => {
    const check = () => fetch('/api/health').then(async r => {
      setCollectorOnline(r.ok);
      if (r.ok) { try { const j = await r.json(); setAppVersion(j.version || null); } catch { /* ignore */ } }
    }).catch(() => setCollectorOnline(false));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  // Deep-link from the update-notifier banner: /?tab=settings opens that tab.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t) setTab(t as Tab);
  }, []);

  // Global keyboard shortcut: "R" refreshes the current tab (broadcast event)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (typing) return;
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        window.dispatchEvent(new Event('ddivault:refresh'));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Persist sidebar collapse state (suite parity)
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('ddivault-sidebar-collapsed') === 'true'); } catch {}
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(c => {
      const next = !c;
      try { localStorage.setItem('ddivault-sidebar-collapsed', String(next)); } catch {}
      return next;
    });
  }, []);

  const navigate = useCallback((t: Tab) => {
    setTab(t);
  }, []);
  const focusScopeNav = useCallback((scopeId: string) => { setFocusScope(scopeId); setTab('scopes'); }, []);

  const sidebarWidth = collapsed ? 64 : 240;

  if (!licenseLoading && licenseState.disabled) {
    return <LicenseDisabledScreen />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header collectorOnline={collectorOnline} onNavigate={navigate} />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Sidebar */}
        <nav style={{
          width: sidebarWidth, background: '#1a2744', display: 'flex', flexDirection: 'column',
          flexShrink: 0, overflowY: 'auto', overflowX: 'hidden', paddingTop: 8, paddingBottom: 12,
          transition: 'width 0.18s ease',
        }}>
          {!collapsed && (
            <div style={{ padding: '12px 20px 8px', fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase' }}>
              Navigation
            </div>
          )}
          {collapsed && <div style={{ height: 12 }} />}

          {visibleItems.map(item => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                title={collapsed ? item.label : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  padding: collapsed ? '11px 0' : '11px 20px',
                  margin: '1px 10px', background: active ? 'rgba(200,16,46,0.15)' : 'transparent',
                  border: 'none', borderRadius: 10,
                  color: active ? '#fff' : 'rgba(255,255,255,0.5)', cursor: 'pointer',
                  fontSize: 'var(--text-md)', fontWeight: active ? 600 : 400, textAlign: 'left',
                  width: 'calc(100% - 20px)', transition: 'all 0.15s', position: 'relative',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; } }}
              >
                {active && <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: 3, height: 20, background: 'var(--primary)', borderRadius: '0 3px 3px 0' }} />}
                <span style={{
                  width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
                  background: active ? (ROUTE_CHIP[item.id]?.bg || 'rgba(255,255,255,0.07)') : 'rgba(255,255,255,0.07)',
                  color: active ? (ROUTE_CHIP[item.id]?.color || 'rgba(255,255,255,0.45)') : 'rgba(255,255,255,0.45)',
                }}>{ICONS[item.id]}</span>
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}

          <div style={{ flex: 1 }} />

          {/* Collapse toggle */}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, justifyContent: collapsed ? 'center' : 'flex-start',
              margin: '4px 10px', padding: collapsed ? '10px 0' : '10px 20px', width: 'calc(100% - 20px)',
              background: 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer',
              color: 'rgba(255,255,255,0.4)', fontSize: 'var(--text-sm)', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}>
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            {!collapsed && <span>Collapse</span>}
          </button>

          {!collapsed && <div style={{ padding: '6px 20px', fontSize: 'var(--text-xs)', color: 'rgba(255,255,255,0.2)' }}>DDIVault{appVersion ? ` v${appVersion}` : ''}</div>}
        </nav>

        {/* Content area — banners render here (content-width) instead of in the
            root layout above the top bar, matching the rest of the NocVault suite. */}
        <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}>
          <LicenseBanner />
          <UpdateNotifier />
          <ErrorBoundary name={tab}>
            {tab === 'dashboard' && <DashboardTab onNavigate={navigate} onFocusScope={focusScopeNav} />}
            {tab === 'scopes'    && <DHCPTab focusScope={focusScope} />}
            {tab === 'ipam'      && <IPAMTab />}
            {tab === 'dns'       && <DNSTab onNavigate={navigate} />}
            {tab === 'events'    && <EventsTab />}
            {tab === 'servers'   && <ServersTab />}
            {tab === 'infra'     && <InfraHealthTab />}
            {tab === 'reports'   && <ReportsTab />}
            {tab === 'audit'     && !isViewer && !isSiteAdmin && <AuditTab />}
            {tab === 'settings'  && canManageSystem && <SettingsTab />}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
