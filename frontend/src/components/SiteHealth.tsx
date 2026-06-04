'use client';

import { useState, useEffect, useCallback } from 'react';
import { EmptyState, CardSkeleton } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface SiteHealthRow {
  site_id: number | string;
  site_name: string;
  overall_score: number | null;
  dhcp_score: number | null;
  ipam_score: number | null;
  dns_score: number | null;
  security_score: number | null;
  details: unknown;
  calculated_at: string | null;
}

// ════════════════════════════════════════════════════════════
// API helper
// ════════════════════════════════════════════════════════════
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════
const CARD: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', overflow: 'hidden',
};

function num(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function scoreColor(score: number | null): string {
  if (score == null) return 'var(--text-muted)';
  if (score >= 90) return 'var(--green)';
  if (score >= 70) return 'var(--orange)';
  return 'var(--red)';
}

function band(score: number | null): 'green' | 'amber' | 'red' {
  const s = score ?? 0;
  if (s >= 90) return 'green';
  if (s >= 70) return 'amber';
  return 'red';
}

// ── Component score mini-bar (module scope) ──────────────────
function ScoreBar({ label, value }: { label: string; value: number | null }) {
  const v = num(value);
  const color = scoreColor(v);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 64, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, Math.max(0, v ?? 0))}%`, height: '100%', background: color }} />
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color, width: 30, textAlign: 'right' }}>{v != null ? Math.round(v) : '—'}</div>
    </div>
  );
}

// ── Site tile (module scope) ─────────────────────────────────
function SiteTile({ site, expanded, onToggle }: {
  site: SiteHealthRow; expanded: boolean; onToggle: () => void;
}) {
  const overall = num(site.overall_score);
  const color = scoreColor(overall);
  return (
    <div
      onClick={onToggle}
      style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)', padding: 10, cursor: 'pointer',
        transition: 'border-color 0.12s',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = color)}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {site.site_name || `Site ${site.site_id}`}
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color, lineHeight: 1, flexShrink: 0 }}>
          {overall != null ? Math.round(overall) : '—'}
        </div>
      </div>
      <div style={{ marginTop: 8, height: 5, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, Math.max(0, overall ?? 0))}%`, height: '100%', background: color }} />
      </div>
      {expanded && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ScoreBar label="DHCP" value={site.dhcp_score} />
          <ScoreBar label="IPAM" value={site.ipam_score} />
          <ScoreBar label="DNS" value={site.dns_score} />
          <ScoreBar label="Security" value={site.security_score} />
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════
export default function SiteHealth() {
  const [rows, setRows] = useState<SiteHealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api('/site-health');
      setRows(Array.isArray(d?.data) ? d.data : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load site health');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) =>
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const counts = rows.reduce(
    (acc, r) => { acc[band(num(r.overall_score))] += 1; return acc; },
    { green: 0, amber: 0, red: 0 } as Record<'green' | 'amber' | 'red', number>,
  );

  return (
    <div style={CARD}>
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>Site Health</div>
        {!loading && !error && rows.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--green)', fontWeight: 600 }}>{counts.green} healthy</span>
            {' · '}
            <span style={{ color: 'var(--orange)', fontWeight: 600 }}>{counts.amber} warning</span>
            {' · '}
            <span style={{ color: 'var(--red)', fontWeight: 600 }}>{counts.red} critical</span>
          </div>
        )}
      </div>

      <div style={{ padding: '16px 20px' }}>
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            <CardSkeleton count={4} height={64} />
          </div>
        ) : error ? (
          <EmptyState icon="⚠" title="Unable to load site health" message={error} />
        ) : rows.length === 0 ? (
          <EmptyState icon="🏢" title="No site health data yet" message="Scores compute every 15 minutes." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {rows.map(site => {
              const id = String(site.site_id);
              return (
                <SiteTile key={id} site={site} expanded={expanded.has(id)} onToggle={() => toggle(id)} />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
