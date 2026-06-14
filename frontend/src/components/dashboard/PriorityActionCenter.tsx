'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { EmptyState, TableSkeleton } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Priority Action Center — the centerpiece of the operations
// center. Merges every "needs attention" signal across DHCP /
// DNS / IPAM / Security / Infra into one ranked triage queue.
// ════════════════════════════════════════════════════════════

interface Props {
  refreshNonce?: number;
  onNavigate?: (tab: string, opts?: { anomalyType?: string }) => void;
  onFocusScope?: (scopeId: string) => void;
}

type Severity = 'critical' | 'warning' | 'info';
type Source = 'Capacity' | 'DHCP' | 'DNS' | 'Security' | 'Infra';

interface ActionItem {
  key: string;
  severity: Severity;
  source: Source;
  title: string;
  detail?: string;
  ts?: string;
  onClick?: () => void;
}

// ── API helper (mirrors DNSTab.tsx) ───────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ── Relative time helper ──────────────────────────────────────
function relTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
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

// ── Severity helpers ──────────────────────────────────────────
const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };
function sevColor(s: Severity): string {
  return s === 'critical' ? 'var(--red)' : s === 'warning' ? 'var(--yellow)' : 'var(--text-muted)';
}
function normSev(s: any): Severity {
  return s === 'critical' ? 'critical' : s === 'warning' ? 'warning' : 'info';
}

const arr = (v: any): any[] => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : []);
const num = (v: any): number => { const n = Number(v); return isNaN(n) ? 0 : n; };

const PAC_COLLAPSE_KEY = 'ddi-pac-collapsed';

export default function PriorityActionCenter({ refreshNonce, onNavigate, onFocusScope }: Props) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const firstLoad = useRef(true);

  // ── Collapse state ────────────────────────────────────────────
  // Tracks whether the user has explicitly toggled (key exists in storage).
  const hasUserPref = useRef(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(PAC_COLLAPSE_KEY);
      hasUserPref.current = stored !== null;
      if (stored !== null) return stored === '1';
    }
    return true; // default collapsed
  });

  const load = useCallback(async () => {
    if (firstLoad.current) setLoading(true);

    const [forecasts, alerts, anomalies, dns, failover, scopes] = await Promise.allSettled([
      api('/forecasts/scopes').catch(() => null),
      api('/alerts?limit=50').catch(() => null),
      api('/anomalies?acknowledged=false&limit=200').catch(() => null),
      api('/dns/health').catch(() => null),
      api('/infrastructure/failover').catch(() => null),
      api('/scopes').catch(() => null),
    ]);

    const val = (r: PromiseSettledResult<any>) => (r.status === 'fulfilled' ? r.value : null);
    const fForecasts = val(forecasts);
    const fAlerts = val(alerts);
    const fAnomalies = val(anomalies);
    const fDns = val(dns);
    const fFailover = val(failover);
    const fScopes = val(scopes);

    const out: ActionItem[] = [];
    const capacityScopes = new Set<string>();

    // ── Capacity (forecasts) ──────────────────────────────────
    for (const f of arr(fForecasts)) {
      if (!f) continue;
      const status = f.status;
      const cidr = f.scope_cidr || f.scope_name || '';
      if (!cidr) continue;
      const days = f.days_to_full;
      if (status === 'critical' || status === 'warning') {
        if (days == null || isNaN(Number(days))) continue;
        capacityScopes.add(String(cidr));
        out.push({
          key: `cap:${cidr}`,
          severity: status === 'critical' ? 'critical' : 'warning',
          source: 'Capacity',
          title: `${cidr} exhausts in ${days}d`,
          detail: f.percent_used != null ? `${num(f.percent_used).toFixed(0)}% used` : undefined,
          onClick: () => onFocusScope?.(String(cidr)),
        });
      }
    }

    // ── DHCP scopes at >=90% utilization ──────────────────────
    for (const s of arr(fScopes)) {
      if (!s) continue;
      const pct = num(s.percent_used);
      const scopeId = s.scope_id != null ? String(s.scope_id) : '';
      if (pct >= 90 && scopeId) {
        if (capacityScopes.has(scopeId)) continue; // dedupe vs capacity item
        out.push({
          key: `dhcp-util:${scopeId}`,
          severity: 'critical',
          source: 'DHCP',
          title: `${scopeId} at ${pct.toFixed(0)}% utilization`,
          detail: s.name || undefined,
          onClick: () => onFocusScope?.(scopeId),
        });
      }
    }

    // ── Open DHCP alerts ──────────────────────────────────────
    for (const a of arr(fAlerts)) {
      if (!a || a.acknowledged || a.resolved_at) continue;
      out.push({
        key: `alert:${a.id}`,
        severity: normSev(a.severity),
        source: 'DHCP',
        title: a.message || 'DHCP alert',
        ts: a.fired_at,
        onClick: () => onNavigate?.('events'),
      });
    }

    // ── Unacknowledged anomalies ──────────────────────────────
    for (const a of arr(fAnomalies)) {
      if (!a || a.acknowledged || a.resolved_at) continue;
      out.push({
        key: `anomaly:${a.id}`,
        severity: normSev(a.severity),
        source: 'Security',
        title: a.description || a.anomaly_type || 'Anomaly detected',
        ts: a.detected_at,
        onClick: () => onNavigate?.('intelligence', { anomalyType: a.anomaly_type }),
      });
    }

    // ── DNS health ────────────────────────────────────────────
    if (fDns && typeof fDns === 'object') {
      const repl = num(fDns.replication_issues);
      const fwdDown = num(fDns.forwarders_down);
      const stale = num(fDns.stale_records);
      const outOfSync = num(fDns.zones_out_of_sync);
      const scav = num(fDns.scavenging_disabled_zones);
      const dnsClick = () => onNavigate?.('dns');
      if (repl > 0) {
        out.push({ key: 'dns:repl', severity: 'warning', source: 'DNS', title: `${repl} zones out of sync`, onClick: dnsClick });
      } else if (outOfSync > 0) {
        out.push({ key: 'dns:sync', severity: 'warning', source: 'DNS', title: `${outOfSync} zones out of sync`, onClick: dnsClick });
      }
      if (fwdDown > 0) {
        out.push({ key: 'dns:fwd', severity: 'warning', source: 'DNS', title: `${fwdDown} forwarder(s) down`, onClick: dnsClick });
      }
      if (stale > 0) {
        out.push({ key: 'dns:stale', severity: 'info', source: 'DNS', title: `${stale} stale DNS records`, onClick: dnsClick });
      }
      if (scav > 0) {
        out.push({ key: 'dns:scav', severity: 'info', source: 'DNS', title: `${scav} zones without scavenging`, onClick: dnsClick });
      }
    }

    // ── Infrastructure / failover (shape unknown — defensive) ──
    for (const p of arr(fFailover)) {
      if (!p || typeof p !== 'object') continue;
      // Determine if the pair is healthy / in-sync. If we cannot tell, skip silently.
      const stateRaw = String(p.state ?? p.sync_status ?? p.status ?? '').toLowerCase();
      const inSyncFlag = p.in_sync ?? p.is_in_sync ?? p.healthy ?? p.is_healthy;

      let degraded = false;
      let lagOnly = false;
      if (inSyncFlag === false) {
        degraded = true;
      } else if (stateRaw) {
        const healthy = /(in.?sync|normal|healthy|ok|active|balancing.*work|up)/.test(stateRaw);
        const bad = /(out.?of.?sync|degraded|down|error|critical|partner.?down|communication.?interrupted|recover)/.test(stateRaw);
        const lag = /(lag|behind|delay)/.test(stateRaw);
        if (bad) degraded = true;
        else if (lag) { degraded = true; lagOnly = true; }
        else if (!healthy) continue; // unknown state — skip silently
      } else if (inSyncFlag !== false && inSyncFlag !== true) {
        continue; // nothing actionable / undeterminable
      }
      if (!degraded) continue;

      const label =
        p.name ||
        (p.primary_server && p.secondary_server ? `${p.primary_server} ↔ ${p.secondary_server}` : null) ||
        (p.server_a && p.server_b ? `${p.server_a} ↔ ${p.server_b}` : null) ||
        p.pair_name ||
        'Failover pair';
      const id = p.id ?? p.pair_id ?? label;
      out.push({
        key: `infra:${id}`,
        severity: lagOnly ? 'warning' : 'critical',
        source: 'Infra',
        title: lagOnly ? `${label} replication lag` : `${label} not in sync`,
        detail: stateRaw || undefined,
        onClick: () => onNavigate?.('infra'),
      });
    }

    // ── Sort: severity desc, then ts (recent first; no-ts last) ─
    out.sort((a, b) => {
      const sd = SEV_RANK[b.severity] - SEV_RANK[a.severity];
      if (sd !== 0) return sd;
      const at = a.ts ? new Date(a.ts).getTime() : NaN;
      const bt = b.ts ? new Date(b.ts).getTime() : NaN;
      const aHas = !isNaN(at), bHas = !isNaN(bt);
      if (aHas && bHas) return bt - at;
      if (aHas) return -1;
      if (bHas) return 1;
      return 0;
    });

    // The Action Center is the "meaningful triage" view — drop info-tier (low
    // signal) items; they remain visible in the Intelligence / DNS consoles.
    setItems(out.filter((it) => it.severity !== 'info'));
    setLoading(false);
    firstLoad.current = false;
  }, [onNavigate, onFocusScope]);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refreshNonce]);

  const counts = items.reduce(
    (acc, it) => { acc[it.severity]++; return acc; },
    { critical: 0, warning: 0, info: 0 } as Record<Severity, number>
  );

  // ── Auto-expand on criticals (only if user hasn't chosen) ─────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (hasUserPref.current) return; // never override an explicit choice
    setCollapsed(counts.critical === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, counts.critical]);

  // ── Header toggle (records explicit user preference) ──────────
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      hasUserPref.current = true;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(PAC_COLLAPSE_KEY, next ? '1' : '0');
      }
      return next;
    });
  }, []);

  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', overflow: 'hidden',
    }}>
      {/* Header (toggles collapse) */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            toggleCollapsed();
          }
        }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '11px 14px',
          borderBottom: collapsed ? 'none' : '1px solid var(--border)',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{
            fontSize: 11, color: 'var(--text-muted)', flexShrink: 0,
            display: 'inline-block', transition: 'transform 0.15s',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          }}>▾</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            Priority Action Center
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          <span style={{ color: counts.critical > 0 ? 'var(--red)' : 'var(--text-muted)', fontWeight: counts.critical > 0 ? 700 : 400 }}>
            {counts.critical} critical
          </span>
          {' · '}{counts.warning} warning
          {collapsed && (
            <span style={{ marginLeft: 8, color: 'var(--text-muted)', opacity: 0.6 }}>expand</span>
          )}
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        loading ? (
          <TableSkeleton rows={6} cols={3} />
        ) : items.length === 0 ? (
          <EmptyState icon="✓" title="No action items" message="All systems clear — nothing needs attention." />
        ) : (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {items.map((it) => (
              <Row key={it.key} item={it} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ── Single triage row (module scope — never nested) ───────────
function Row({ item }: { item: ActionItem }) {
  const [hover, setHover] = useState(false);
  const clickable = !!item.onClick;
  const age = relTime(item.ts);
  return (
    <div
      onClick={item.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', borderBottom: '1px solid var(--border-light)',
        cursor: clickable ? 'pointer' : 'default',
        background: hover && clickable ? 'var(--bg-primary)' : 'transparent',
        transition: 'background 0.12s',
      }}
    >
      {/* severity dot */}
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: sevColor(item.severity),
      }} />

      {/* source tag chip */}
      <span style={{
        fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-primary)',
        border: '1px solid var(--border)', borderRadius: 4, padding: '1px 7px',
        flexShrink: 0, fontWeight: 600,
      }}>{item.source}</span>

      {/* title + detail */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden' }}>
        <span style={{
          fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1,
        }}>{item.title}</span>
        {item.detail && (
          <span style={{
            fontSize: 11, color: 'var(--text-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 2,
          }}>{item.detail}</span>
        )}
      </div>

      {/* age + chevron */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {age && <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{age}</span>}
        {clickable && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>›</span>}
      </div>
    </div>
  );
}
