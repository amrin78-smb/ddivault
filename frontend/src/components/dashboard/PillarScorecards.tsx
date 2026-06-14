'use client';

import { useEffect, useState, useCallback } from 'react';
import { Skeleton } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// PillarScorecards — four compact domain scorecards (DHCP / DNS /
// IPAM / Security). Each shows a 0–100 score (authoritative from the
// backend healthScorer), a trend sparkline, and 2–3 real sub-metrics.
// Cards are clickable → navigate to the relevant tab.
// ════════════════════════════════════════════════════════════

interface PillarScorecardsProps {
  timeRange?: '24h' | '7d' | '30d';
  refreshNonce?: number;
  onNavigate?: (tab: string) => void;
}

// ── API helper (resilient — caller wraps in allSettled) ───────
async function api(path: string): Promise<any> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Score → colour ────────────────────────────────────────────
function scoreColor(n: number | null): string {
  if (n == null) return 'var(--text-muted)';
  if (n >= 90) return 'var(--green)';
  if (n >= 70) return 'var(--yellow)';
  return 'var(--red)';
}

// ── Tiny inline SVG sparkline ─────────────────────────────────
function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length < 2) return null;
  const W = 100, H = 24, PAD = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = PAD + i * step;
    const y = PAD + (H - PAD * 2) * (1 - (v - min) / span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={H}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ── Aggregated fetched state ──────────────────────────────────
interface PillarData {
  pillars: any;       // /api/dashboard/pillars → data
  stats: any;         // /api/dashboard/stats
  dnsHealth: any;     // /api/dns/health
  ipDist: any;        // /api/dashboard/ip-distribution → data
  anomalies: any;     // /api/anomalies/summary → data
}

export default function PillarScorecards(props: PillarScorecardsProps) {
  const { refreshNonce, onNavigate } = props;
  const [data, setData] = useState<PillarData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api('/dashboard/pillars'),
      api('/dashboard/stats'),
      api('/dns/health'),
      api('/dashboard/ip-distribution'),
      api('/anomalies/summary'),
    ]);
    const val = (i: number, fallback: any) =>
      results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<any>).value : fallback;

    setData({
      pillars: val(0, {}).data ?? {},
      stats: val(1, {}) ?? {},
      dnsHealth: val(2, {}) ?? {},
      ipDist: val(3, {}).data ?? {},
      anomalies: val(4, {}).data ?? {},
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshNonce]);

  if (loading && !data) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            style={{
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderLeft: '4px solid var(--border)', borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-sm)', padding: '12px 16px', minHeight: 120,
            }}
          >
            <Skeleton height={12} width="50%" />
            <div style={{ height: 10 }} />
            <Skeleton height={26} width={60} />
            <div style={{ height: 10 }} />
            <Skeleton height={24} width="100%" />
            <div style={{ height: 10 }} />
            <Skeleton height={10} width="80%" />
            <div style={{ height: 6 }} />
            <Skeleton height={10} width="65%" />
          </div>
        ))}
      </div>
    );
  }

  const d = data!;
  const p = d.pillars || {};
  const stats = d.stats || {};
  const dns = d.dnsHealth || {};
  const ipDist = d.ipDist || {};
  const anoms = d.anomalies || {};

  // ── Derived sub-metrics ─────────────────────────────────────
  const scopes = stats.scopes || {};
  const ips = stats.ips || {};
  const util =
    ips.total && ips.total > 0 ? Math.round((100 * (ips.in_use || 0)) / ips.total) : 0;
  const topAnomaly =
    Array.isArray(anoms.byType) && anoms.byType.length > 0
      ? anoms.byType[0].anomaly_type
      : null;

  type Metric = { label: string; value: React.ReactNode };

  const cards: {
    key: string;
    name: string;
    tab: string;
    score: number | null;
    trend: number[];
    metrics: Metric[];
  }[] = [
    {
      key: 'dhcp',
      name: 'DHCP',
      tab: 'scopes',
      score: p.dhcp?.score ?? null,
      trend: p.dhcp?.trend ?? [],
      metrics: [
        { label: 'Critical', value: `${scopes.critical ?? 0} · Warning ${scopes.warning ?? 0}` },
        { label: 'Active leases', value: stats.active_leases ?? 0 },
      ],
    },
    {
      key: 'dns',
      name: 'DNS',
      tab: 'dns',
      score: p.dns?.score ?? null,
      trend: p.dns?.trend ?? [],
      metrics: [
        { label: 'Online', value: `${dns.servers_online ?? 0}/${dns.servers_total ?? 0}` },
        { label: 'In sync', value: dns.zones_in_sync ?? 0 },
        { label: 'Forwarders down', value: dns.forwarders_down ?? 0 },
      ],
    },
    {
      key: 'ipam',
      name: 'IPAM',
      tab: 'ipam',
      score: p.ipam?.score ?? null,
      trend: p.ipam?.trend ?? [],
      metrics: [
        { label: 'Utilization', value: `${util}%` },
        { label: 'Unknown', value: ipDist.unknown ?? 0 },
      ],
    },
    {
      key: 'security',
      name: 'Security',
      tab: 'intelligence',
      score: p.security?.score ?? null,
      trend: p.security?.trend ?? [],
      metrics: [
        { label: 'Today', value: anoms.today ?? 0 },
        { label: 'This week', value: anoms.week ?? 0 },
        ...(topAnomaly ? [{ label: 'Top', value: topAnomaly }] : []),
      ],
    },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12 }}>
      {cards.map((c) => {
        const color = scoreColor(c.score);
        return (
          <div
            key={c.key}
            role="button"
            tabIndex={0}
            onClick={() => onNavigate?.(c.tab)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate?.(c.tab); }
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = 'var(--shadow-md, 0 6px 16px rgba(0,0,0,0.12))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
            }}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderLeft: `4px solid ${color}`,
              borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-sm)',
              padding: '12px 16px',
              maxHeight: 150,
              cursor: 'pointer',
              transition: 'transform 0.12s ease, box-shadow 0.12s ease',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{c.name}</span>
              <span style={{ fontSize: 16, color: 'var(--text-muted)', lineHeight: 1 }}>›</span>
            </div>

            {/* Score */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              {c.score == null ? (
                <>
                  <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-muted)' }}>—</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>score pending</span>
                </>
              ) : (
                <span style={{ fontSize: 24, fontWeight: 800, color }}>{c.score}</span>
              )}
            </div>

            {/* Sparkline */}
            <div style={{ height: 24 }}>
              <Sparkline data={c.trend} color={color} />
            </div>

            {/* Sub-metrics */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {c.metrics.map((m, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11, display: 'flex', gap: 6, justifyContent: 'space-between',
                    whiteSpace: 'nowrap', overflow: 'hidden',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)' }}>{m.label}</span>
                  <span
                    style={{
                      color: 'var(--text-primary)', fontWeight: 600,
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}
                  >
                    {m.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
