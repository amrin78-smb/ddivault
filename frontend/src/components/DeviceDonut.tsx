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

  const maxPct = slices.reduce((m, s) => Math.max(m, s.pct), 0);

  return (
    <div style={CARD}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>Device Type Distribution</div>
        {!loading && !error && total > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{total.toLocaleString()} devices</div>
        )}
      </div>

      {loading ? (
        <div style={{ padding: '16px 20px' }}>
          <CardSkeleton count={1} height={160} />
        </div>
      ) : error ? (
        <EmptyState icon="⚠" title="Unable to load devices" message={error} />
      ) : total === 0 ? (
        <EmptyState icon="📡" title="No leases found" message="No DHCP leases available to categorize." />
      ) : (
        <div style={{ padding: '16px 20px', maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {slices.map(s => (
            <div key={s.category} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-primary)', width: 84, flexShrink: 0 }}>{s.category}</span>
              <div style={{ flex: 1, height: 12, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  width: `${maxPct > 0 ? (s.pct / maxPct) * 100 : 0}%`,
                  height: '100%', background: s.color, borderRadius: 4,
                }} />
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', width: 48, textAlign: 'right', flexShrink: 0 }}>{s.count.toLocaleString()}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', width: 46, textAlign: 'right', flexShrink: 0 }}>{s.pct.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
