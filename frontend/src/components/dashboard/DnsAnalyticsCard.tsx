'use client';

import { useState, useEffect, useCallback } from 'react';
import { Skeleton, EmptyState } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// DnsAnalyticsCard — surfaces DNS query analytics on the
// operations dashboard. Compact, dark-mode safe, resilient fetch.
// ════════════════════════════════════════════════════════════

// ── Types (loose) ─────────────────────────────────────────────
interface QueryStatPoint {
  queries_per_sec?: number;
  response_time_ms?: number;
  nxdomain_count?: number;
  total_queries?: number;
  successful?: number;
  failed?: number;
  [k: string]: any;
}
interface QueryStat {
  server_id: number;
  hostname: string;
  latest: QueryStatPoint | null;
  history: QueryStatPoint[];
}
interface DnsHealth {
  servers_total?: number;
  servers_online?: number;
  zones_in_sync?: number;
  forwarders_down?: number;
  stale_records?: number;
  [k: string]: any;
}

// ── API helper (mirrors DNSTab) ───────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ── compactNum (mirrors DNSTab) ───────────────────────────────
function compactNum(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// ── Local Sparkline (full width, height 32) ───────────────────
function Sparkline({ points, color = 'var(--blue)', height = 32 }: { points: number[]; color?: string; height?: number }) {
  if (points.length < 2) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>insufficient data</span>;
  const W = 100, H = height, pad = 2;
  const max = Math.max(...points), min = Math.min(...points);
  const span = max - min || 1;
  const d = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (W - pad * 2);
    const y = H - pad - ((p - min) / span) * (H - pad * 2);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"
        vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ── Mini inline stat ──────────────────────────────────────────
function MiniStat({ label, value, color }: { label: string; value: React.ReactNode; color: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color, letterSpacing: '-0.5px', lineHeight: 1.15 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{label}</div>
    </div>
  );
}

export default function DnsAnalyticsCard(props: { refreshNonce?: number; onNavigate?: (tab: string) => void }) {
  const { refreshNonce, onNavigate } = props;
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<QueryStat[]>([]);
  const [health, setHealth] = useState<DnsHealth | null>(null);

  const load = useCallback(async () => {
    const [statsRes, healthRes] = await Promise.allSettled([
      api('/dns/query-stats'),
      api('/dns/health'),
    ]);
    if (statsRes.status === 'fulfilled') {
      const data = statsRes.value?.data;
      setStats(Array.isArray(data) ? data : []);
    } else {
      setStats([]);
    }
    if (healthRes.status === 'fulfilled') {
      setHealth(healthRes.value && typeof healthRes.value === 'object' ? healthRes.value : null);
    } else {
      setHealth(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshNonce]);

  // ── Compute from latest across servers ──────────────────────
  const withLatest = stats.filter((s) => s && s.latest);
  const hasData = withLatest.length > 0;

  let totalQueries = 0, totalSuccessful = 0, respSum = 0, respCount = 0;
  for (const s of withLatest) {
    const l = s.latest!;
    const tq = Number(l.total_queries) || 0;
    const failed = Number(l.failed) || 0;
    const succ = l.successful != null ? Number(l.successful) : (tq - failed);
    totalQueries += tq;
    totalSuccessful += succ;
    if (l.response_time_ms != null && !isNaN(Number(l.response_time_ms))) {
      respSum += Number(l.response_time_ms);
      respCount++;
    }
  }
  const successRate: number | null = totalQueries > 0 ? (totalSuccessful / totalQueries) * 100 : null;
  const avgResp: number | null = respCount > 0 ? respSum / respCount : null;

  // ── Combined query-rate series (sum across servers per index) ─
  const withHistory = stats.filter((s) => s && Array.isArray(s.history) && s.history.length > 0);
  let series: number[] = [];
  if (withHistory.length > 0) {
    const minLen = Math.min(...withHistory.map((s) => s.history.length));
    if (minLen >= 2) {
      series = Array.from({ length: minLen }, (_, i) =>
        withHistory.reduce((sum, s) => sum + (Number(s.history[i]?.queries_per_sec) || 0), 0)
      );
    } else {
      // fallback: first server with usable history
      const first = withHistory.find((s) => s.history.length >= 2);
      if (first) series = first.history.map((p) => Number(p?.queries_per_sec) || 0);
    }
  }

  const serversTotal = Number(health?.servers_total) || 0;
  const serversOnline = Number(health?.servers_online) || 0;
  const forwardersDown = Number(health?.forwarders_down) || 0;
  const staleRecords = Number(health?.stale_records) || 0;
  const hasServers = serversTotal > 0;

  const successColor = successRate == null ? 'var(--text-muted)' : successRate >= 99 ? 'var(--green)' : 'var(--yellow)';

  // ── Card shell ──────────────────────────────────────────────
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', maxHeight: 210,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>DNS Query Analytics</span>
        <button
          onClick={() => onNavigate?.('dns')}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 12, fontWeight: 600, color: 'var(--primary)', fontFamily: 'inherit',
          }}
        >
          DNS Insights →
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '12px 16px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {loading ? (
          <div>
            <div style={{ display: 'flex', gap: 16 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ flex: 1 }}>
                  <Skeleton height={20} width="60%" />
                  <div style={{ height: 6 }} />
                  <Skeleton height={11} width="80%" />
                </div>
              ))}
            </div>
            <div style={{ height: 14 }} />
            <Skeleton height={32} width="100%" />
            <div style={{ height: 10 }} />
            <Skeleton height={11} width="70%" />
          </div>
        ) : (!hasData && !hasServers) ? (
          <EmptyState
            title="No DNS data"
            message="DNS query stats appear once the collector polls DNS servers."
          />
        ) : (
          <>
            {/* KPI row */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <MiniStat
                label="Success Rate"
                value={successRate == null ? '—' : `${successRate.toFixed(2)}%`}
                color={successColor}
              />
              <MiniStat
                label="Queries 24h"
                value={hasData ? compactNum(totalQueries) : '—'}
                color="var(--blue)"
              />
              <MiniStat
                label="Avg Response"
                value={avgResp != null ? `${avgResp.toFixed(0)}ms` : '—'}
                color="var(--text-primary)"
              />
            </div>

            {/* Sparkline */}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Query rate · 24h</div>
              {series.length >= 2 ? (
                <Sparkline points={series} color="var(--blue)" height={32} />
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', height: 32, display: 'flex', alignItems: 'center' }}>
                  Query stats collecting…
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
              {serversOnline}/{serversTotal} servers online · {forwardersDown} forwarders down · {staleRecords} stale records
            </div>
          </>
        )}
      </div>
    </div>
  );
}
