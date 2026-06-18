'use client';

import { pctColor } from '@/components/ui';

export interface TopSubnet {
  id: number;
  label: string;
  pct: number;
  used: number;
  total: number;
}

export interface IpamTopSubnetsProps {
  subnets: TopSubnet[];
  onViewAll: () => void;
}

export function IpamTopSubnets({ subnets, onViewAll }: IpamTopSubnetsProps) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 'var(--text-base)', fontWeight: 700 }}>Top Subnets by Utilization</div>
        <button
          onClick={onViewAll}
          style={{ fontSize: 'var(--text-sm)', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
        >
          View all →
        </button>
      </div>

      {subnets.length === 0 ? (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: 24, textAlign: 'center' }}>
          No subnet utilization data yet.
        </div>
      ) : (
        subnets.map((s, i) => (
          <div
            key={s.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 0',
              borderBottom: i === subnets.length - 1 ? 'none' : '1px solid var(--border-light)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-sm)',
                fontWeight: 600,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 120,
              }}
            >
              {s.label}
            </div>
            <div style={{ flex: 1, height: 7, background: 'var(--border)', borderRadius: 4, overflow: 'hidden', minWidth: 70 }}>
              <div style={{ width: `${Math.min(100, s.pct)}%`, height: '100%', background: pctColor(s.pct), borderRadius: 4 }} />
            </div>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: pctColor(s.pct), minWidth: 46, textAlign: 'right' }}>
              {s.pct.toFixed(1)}%
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'right' }}>
              {s.used.toLocaleString()}/{s.total.toLocaleString()}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
