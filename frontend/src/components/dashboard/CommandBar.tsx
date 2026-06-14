'use client';

import { useState, useEffect, useCallback } from 'react';

// ── Props ─────────────────────────────────────────────────────
interface CommandBarProps {
  timeRange: '24h' | '7d' | '30d';
  onTimeRange: (r: '24h' | '7d' | '30d') => void;
  lastUpdated: number | null;            // epoch ms of last dashboard refresh
  onRefresh: () => void;                  // manual refresh
  paused: boolean;
  onTogglePause: () => void;
  refreshNonce?: number;                  // re-fetch when this changes
  onNavigate?: (tab: string) => void;
}

// ── API helper (resilient — returns null on failure) ──────────
async function apiSafe(path: string): Promise<any | null> {
  try {
    const res = await fetch(`/api${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Relative time helper ──────────────────────────────────────
function relTime(secs: number | null): string {
  if (secs == null || isNaN(secs)) return 'never';
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ── Posture → colour + label ──────────────────────────────────
function postureStyle(overall?: string): { color: string; label: string } {
  if (overall === 'critical') return { color: 'var(--red)', label: 'Critical issues detected' };
  if (overall === 'warning') return { color: 'var(--yellow)', label: 'Warnings present' };
  return { color: 'var(--green)', label: 'All systems healthy' };
}

// ── Collector status → colour + label ─────────────────────────
function collectorStyle(status?: string): { color: string; label: string } {
  if (status === 'active') return { color: 'var(--green)', label: 'Collector active' };
  if (status === 'stale') return { color: 'var(--yellow)', label: 'Collector stale' };
  return { color: 'var(--red)', label: 'Collector down' };
}

const TIME_RANGES: Array<'24h' | '7d' | '30d'> = ['24h', '7d', '30d'];

// ════════════════════════════════════════════════════════════
// CommandBar — sticky triage glance + global controls
// ════════════════════════════════════════════════════════════
export default function CommandBar({
  timeRange, onTimeRange, lastUpdated, onRefresh,
  paused, onTogglePause, refreshNonce, onNavigate,
}: CommandBarProps) {
  const [infra, setInfra] = useState<any | null>(null);
  const [collector, setCollector] = useState<any | null>(null);
  const [, setTick] = useState(0); // forces a re-render every second for "Updated Ns ago"

  // ── Self-fetch (resilient, parallel) ────────────────────────
  const load = useCallback(async () => {
    const [healthRes, collectorRes] = await Promise.allSettled([
      apiSafe('/infrastructure/health'),
      apiSafe('/dashboard/collector-status'),
    ]);
    setInfra(healthRes.status === 'fulfilled' ? healthRes.value : null);
    setCollector(collectorRes.status === 'fulfilled' ? collectorRes.value : null);
  }, []);

  useEffect(() => { load(); }, [load, refreshNonce]);

  // ── Live "Updated Ns ago" ticker ────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Derived display values ──────────────────────────────────
  const overall: string | undefined = infra?.overall;
  const serversMonitored: number = Array.isArray(infra?.data) ? infra.data.length : 0;
  const worstScore: number | null = infra?.worst_score ?? null;
  const posture = postureStyle(overall);

  const cstat = collector?.data || {};
  const collectorState = collectorStyle(cstat.status);
  const secondsSince: number | null = cstat.seconds_since ?? null;

  const updatedAgo = lastUpdated != null
    ? `${Math.max(0, Math.round((Date.now() - lastUpdated) / 1000))}s ago`
    : '—';

  // ── Inline style constants ──────────────────────────────────
  const labelCss: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)' };
  const ctrlCss: React.CSSProperties = { fontSize: 12 };
  const dot = (color: string): React.CSSProperties => ({
    display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
    background: color, flexShrink: 0,
  });

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 20,
      background: 'var(--bg-primary)', padding: '8px 0',
    }}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
        padding: '10px 16px', display: 'flex', alignItems: 'center',
        gap: 14, flexWrap: 'wrap',
      }}>
        {/* LEFT — posture pill */}
        <button
          onClick={() => onNavigate?.('infra')}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'transparent', border: 'none', padding: 0,
            cursor: onNavigate ? 'pointer' : 'default', textAlign: 'left',
          }}
          title="View infrastructure health"
        >
          <span style={dot(posture.color)} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            {posture.label}
          </span>
          <span style={labelCss}>
            {serversMonitored} server{serversMonitored === 1 ? '' : 's'} monitored
            {worstScore != null ? ` · lowest health ${worstScore}/100` : ''}
          </span>
        </button>

        {/* MIDDLE — collector heartbeat chip */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          padding: '4px 10px', borderRadius: 999,
          background: collectorState.color + '18', fontSize: 12,
          color: 'var(--text-primary)', fontWeight: 600,
        }}>
          <span style={dot(collectorState.color)} />
          {collectorState.label}
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
            · last poll {relTime(secondsSince)}
          </span>
        </span>

        {/* spacer */}
        <div style={{ flex: 1 }} />

        {/* RIGHT — controls */}
        {/* Time-range segmented control */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          padding: 2,
        }}>
          {TIME_RANGES.map((r) => {
            const active = r === timeRange;
            return (
              <button
                key={r}
                onClick={() => onTimeRange(r)}
                style={{
                  fontSize: 11, fontWeight: 600, padding: '4px 10px',
                  borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  border: active ? '1px solid var(--primary)' : '1px solid transparent',
                  background: active ? 'var(--primary-light)' : 'transparent',
                  color: active ? 'var(--primary)' : 'var(--text-muted)',
                }}
              >
                {r}
              </button>
            );
          })}
        </div>

        {/* Updated Ns ago */}
        <span style={labelCss}>Updated {updatedAgo}</span>

        {/* Pause / Live toggle */}
        <button
          className="btn"
          onClick={onTogglePause}
          style={{ ...ctrlCss, padding: '4px 10px' }}
          title={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        >
          {paused ? '▶ Live' : '⏸ Pause'}
        </button>

        {/* Manual refresh */}
        <button
          className="btn"
          onClick={onRefresh}
          style={{ ...ctrlCss, padding: '4px 10px' }}
          title="Refresh now"
        >
          ↻
        </button>
      </div>
    </div>
  );
}
