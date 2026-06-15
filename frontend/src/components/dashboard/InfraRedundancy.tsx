'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Skeleton, EmptyState } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Infrastructure & Redundancy dashboard card.
// Server health with trend sparklines + HA/failover status.
// Resilient: every fetch is allSettled, every field access guarded.
// ════════════════════════════════════════════════════════════

// ── Props ─────────────────────────────────────────────────────
interface InfraRedundancyProps {
  timeRange?: '24h' | '7d' | '30d';
  refreshNonce?: number;
  onNavigate?: (tab: string) => void;
}

// ── API helper ────────────────────────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ── Health score → colour ─────────────────────────────────────
function healthColor(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(Number(n))) return 'var(--text-muted)';
  const v = Number(n);
  if (v >= 90) return 'var(--green)';
  if (v >= 70) return 'var(--yellow)';
  return 'var(--red)';
}

// ── Tiny inline SVG sparkline ─────────────────────────────────
function Sparkline({ values, color, height = 22, width = 200 }: {
  values: number[]; color: string; height?: number; width?: number;
}) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const nums = values.map((v) => (typeof v === 'number' && !isNaN(v) ? v : 0));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const pad = 2;
  const innerH = height - pad * 2;
  const step = width / (nums.length - 1);
  const points = nums
    .map((v, i) => {
      const x = i * step;
      const y = pad + innerH - ((v - min) / range) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
      style={{ display: 'block', marginTop: 8 }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Map time range → hours ────────────────────────────────────
function rangeToHours(r?: string): number {
  if (r === '7d') return 168;
  if (r === '30d') return 720;
  return 24;
}

// ── Defensively read a failover pair into a normalized shape ──
interface NormalPair { name: string; state: string; inSync: boolean; }
function normalizePairs(raw: any): NormalPair[] {
  const list: any[] = Array.isArray(raw?.data) ? raw.data
    : Array.isArray(raw) ? raw : [];
  return list.map((p: any) => {
    if (!p || typeof p !== 'object') return null;
    // pair name — try several likely fields
    const a = p.primary_hostname ?? p.primary ?? p.server_a ?? p.serverA ?? p.partner_a ?? p.name ?? p.pair_name ?? null;
    const b = p.secondary_hostname ?? p.secondary ?? p.server_b ?? p.serverB ?? p.partner_b ?? p.partner ?? null;
    const name = a && b ? `${a} ↔ ${b}` : (p.pair_name ?? p.name ?? a ?? b ?? 'Failover pair');
    // state field — try several likely fields
    const rawState = p.sync_state ?? p.state ?? p.status ?? p.failover_state ?? p.mode ?? null;
    const state = rawState != null ? String(rawState) : 'unknown';
    // determine "in sync"
    let inSync: boolean;
    if (typeof p.in_sync === 'boolean') inSync = p.in_sync;
    else if (typeof p.is_in_sync === 'boolean') inSync = p.is_in_sync;
    else {
      const s = state.toLowerCase();
      inSync = /normal|sync|ok|healthy|up|active|balancing/.test(s)
        && !/out.?of.?sync|degrad|fail|error|down|unsync|partner.?down|communication/.test(s);
    }
    return { name: String(name), state, inSync };
  }).filter(Boolean) as NormalPair[];
}

export default function InfraRedundancy({ timeRange = '24h', refreshNonce = 0, onNavigate }: InfraRedundancyProps) {
  const [servers, setServers] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [pairs, setPairs] = useState<NormalPair[]>([]);
  const [failoverAvailable, setFailoverAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const firstLoad = useRef(true);
  const loadedOk = useRef(false);   // a health fetch has succeeded at least once

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (firstLoad.current) setLoading(true);
    const hours = rangeToHours(timeRange);

    Promise.allSettled([
      api('/infrastructure/health'),
      api(`/infrastructure/health-history?hours=${hours}`),
      api('/infrastructure/failover'),
    ]).then((results) => {
      if (cancelled) return;
      const [healthR, histR, foR] = results;

      // health — only overwrite on success. A transient failure must NOT clear
      // servers (that flips the card to a sticky "No servers" until next refresh).
      let healthOk = false;
      if (healthR.status === 'fulfilled') {
        const d = healthR.value?.data;
        setServers(Array.isArray(d) ? d : []);
        healthOk = true;
        loadedOk.current = true;
      }

      // history — only overwrite on success
      if (histR.status === 'fulfilled') {
        const d = histR.value?.data;
        setHistory(Array.isArray(d) ? d : []);
      }

      // failover (defensive) — only overwrite on success
      if (foR.status === 'fulfilled') {
        try {
          const np = normalizePairs(foR.value);
          setPairs(np);
          setFailoverAvailable(true);
        } catch {
          setPairs([]);
          setFailoverAvailable(false);
        }
      }

      // Drop the loading skeleton only once health has loaded at least once.
      // If the very first load failed, keep the skeleton and retry shortly
      // instead of showing a misleading "No servers".
      if (loadedOk.current) {
        setLoading(false);
        firstLoad.current = false;
      } else if (!healthOk) {
        retryTimer = setTimeout(() => { if (!cancelled) setRetry((r) => r + 1); }, 3000);
      }
    });

    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [timeRange, refreshNonce, retry]);

  // index history by server_id for quick merge
  const histById = useMemo(() => {
    const m = new Map<any, any>();
    for (const h of history) {
      if (h && h.server_id !== undefined && h.server_id !== null) m.set(h.server_id, h);
    }
    return m;
  }, [history]);

  const inSyncCount = pairs.filter((p) => p.inSync).length;
  const degraded = pairs.filter((p) => !p.inSync);

  // ── Card chrome ─────────────────────────────────────────────
  const card: React.CSSProperties = {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', overflow: 'hidden',
  };

  const header = (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px', borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
        Infrastructure &amp; Redundancy
      </span>
      <button
        onClick={() => onNavigate?.('infra')}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--primary)', fontSize: 12, fontWeight: 600, padding: 0,
        }}
      >
        Details →
      </button>
    </div>
  );

  // ── Loading (first load only) ───────────────────────────────
  if (loading && firstLoad.current) {
    return (
      <div style={card}>
        {header}
        <div style={{ padding: 12 }}>
          <Skeleton height={14} width="40%" />
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px,1fr))',
            gap: 12, marginTop: 12,
          }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 10, padding: 12,
              }}>
                <Skeleton height={16} width="60%" />
                <div style={{ height: 8 }} />
                <Skeleton height={12} width="40%" />
                <div style={{ height: 10 }} />
                <Skeleton height={22} width="100%" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Empty: no servers ───────────────────────────────────────
  if (!servers.length) {
    return (
      <div style={card}>
        {header}
        <EmptyState title="No servers" message="Add a server in Known Servers." />
      </div>
    );
  }

  return (
    <div style={card}>
      {header}

      {/* ── Part 1 — redundancy strip ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-primary)',
      }}>
        {failoverAvailable && pairs.length > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: degraded.length === 0 ? 'var(--green)' : 'var(--red)',
              }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                Failover: {inSyncCount}/{pairs.length} pairs in sync
              </span>
            </div>
            {degraded.map((p, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, paddingLeft: 16,
              }}>
                <span style={{
                  fontSize: 11, color: 'var(--text-secondary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{p.name}</span>
                <span className="badge badge-red" style={{ flexShrink: 0 }}>{p.state}</span>
              </div>
            ))}
          </>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No failover pairs configured.
          </span>
        )}
      </div>

      {/* ── Part 2 — server cards grid ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px,1fr))',
        gap: 12, padding: 12,
      }}>
        {servers.map((s: any, idx: number) => {
          const id = s?.id;
          const h = id !== undefined && id !== null ? histById.get(id) : undefined;
          const score = s?.health_score ?? null;
          const color = healthColor(score);
          const points: number[] = Array.isArray(h?.points)
            ? h.points.map((p: any) => Number(p?.score)).filter((n: number) => !isNaN(n))
            : [];
          const winrm = s?.winrm_test_ok;
          const uptime = h?.uptime_pct;
          const avgQuery = h?.avg_query_ms;
          const queryMs = s?.query_ms;

          return (
            <div
              key={id ?? idx}
              onClick={() => onNavigate?.('infra')}
              style={{
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderLeft: `4px solid ${color}`, borderRadius: 10, padding: 12,
                cursor: 'pointer',
              }}
            >
              {/* top row */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{s?.hostname ?? '—'}</div>
                  <div style={{
                    fontSize: 11, color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono, monospace)', marginTop: 2,
                  }}>{s?.ip ?? '—'}</div>
                </div>
                <div style={{
                  fontSize: 22, fontWeight: 800, color, lineHeight: 1, flexShrink: 0,
                }}>
                  {score === null || score === undefined ? '—' : score}
                </div>
              </div>

              {/* badges row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <span className="badge badge-gray">
                  {String(s?.role ?? 'unknown').toUpperCase()}
                </span>
                <span className={`badge ${winrm === false ? 'badge-red' : winrm ? 'badge-green' : 'badge-gray'}`}>
                  WinRM
                </span>
              </div>

              {/* health trend sparkline */}
              <Sparkline values={points} color={color} height={22} />

              {/* metrics line */}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                Uptime {uptime ?? '—'}% · {avgQuery ?? queryMs ?? '—'}ms · {s?.scope_count ?? 0} scopes · {s?.zone_count ?? 0} zones
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
