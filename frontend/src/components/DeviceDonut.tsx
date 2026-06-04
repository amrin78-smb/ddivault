'use client';

import { useState, useEffect, useCallback } from 'react';
import { EmptyState, CardSkeleton } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface Lease {
  device_type?: string | null;
}

type Category = 'Mobile' | 'Workstation' | 'Network' | 'Printer' | 'VoIP' | 'Unknown';

interface Slice {
  category: Category;
  count: number;
  pct: number;
  color: string;
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

const CATEGORY_ORDER: Category[] = ['Mobile', 'Workstation', 'Network', 'Printer', 'VoIP', 'Unknown'];

const CATEGORY_COLOR: Record<Category, string> = {
  Mobile: 'var(--blue)',
  Workstation: 'var(--purple)',
  Network: 'var(--green)',
  Printer: 'var(--orange)',
  VoIP: 'var(--primary)',
  Unknown: 'var(--text-muted)',
};

function classify(raw: string | null | undefined): Category {
  const t = (raw || '').toLowerCase().trim();
  if (!t) return 'Unknown';
  if (/(phone|mobile|tablet|ipad|iphone|android|cell)/.test(t)) return 'Mobile';
  if (/(workstation|desktop|laptop|pc|computer|mac|windows|client)/.test(t)) return 'Workstation';
  if (/(switch|router|ap|access.?point|firewall|gateway|network|wifi|wireless)/.test(t)) return 'Network';
  if (/(print|mfp|copier|scanner)/.test(t)) return 'Printer';
  if (/(voip|phone|sip|voice)/.test(t)) return 'VoIP';
  return 'Unknown';
}

// Build an SVG donut arc path (stroke-dasharray approach on a circle).
const RADIUS = 60;
const STROKE = 22;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════
export default function DeviceDonut() {
  const [slices, setSlices] = useState<Slice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api('/leases?limit=1000');
      const leases: Lease[] = Array.isArray(d?.data) ? d.data : [];
      const counts: Record<Category, number> = {
        Mobile: 0, Workstation: 0, Network: 0, Printer: 0, VoIP: 0, Unknown: 0,
      };
      for (const l of leases) counts[classify(l.device_type)] += 1;
      const t = leases.length;
      setTotal(t);
      const built: Slice[] = CATEGORY_ORDER
        .map(c => ({
          category: c,
          count: counts[c],
          pct: t > 0 ? (counts[c] / t) * 100 : 0,
          color: CATEGORY_COLOR[c],
        }))
        .filter(s => s.count > 0);
      setSlices(built);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load leases');
      setSlices([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Compute cumulative offsets for donut segments
  let offset = 0;
  const segments = slices.map(s => {
    const len = (s.pct / 100) * CIRCUMFERENCE;
    const seg = { ...s, dash: len, gap: CIRCUMFERENCE - len, dashOffset: -offset };
    offset += len;
    return seg;
  });

  return (
    <div style={CARD}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>Device Type Distribution</div>
      </div>

      {loading ? (
        <div style={{ padding: 18 }}>
          <CardSkeleton count={1} height={160} />
        </div>
      ) : error ? (
        <EmptyState icon="⚠" title="Unable to load devices" message={error} />
      ) : total === 0 ? (
        <EmptyState icon="📡" title="No leases found" message="No DHCP leases available to categorize." />
      ) : (
        <div style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          {/* Donut SVG */}
          <div style={{ position: 'relative', width: 160, height: 160, flexShrink: 0 }}>
            <svg width={160} height={160} viewBox="0 0 160 160" role="img" aria-label="Device type distribution donut chart">
              <g transform="rotate(-90 80 80)">
                <circle cx={80} cy={80} r={RADIUS} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
                {segments.map(seg => (
                  <circle
                    key={seg.category}
                    cx={80}
                    cy={80}
                    r={RADIUS}
                    fill="none"
                    stroke={seg.color}
                    strokeWidth={STROKE}
                    strokeDasharray={`${seg.dash} ${seg.gap}`}
                    strokeDashoffset={seg.dashOffset}
                  />
                ))}
              </g>
            </svg>
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
            }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)' }}>{total.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>devices</div>
            </div>
          </div>

          {/* Legend */}
          <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {slices.map(s => (
              <div key={s.category} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1 }}>{s.category}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{s.count.toLocaleString()}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 48, textAlign: 'right' }}>{s.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
