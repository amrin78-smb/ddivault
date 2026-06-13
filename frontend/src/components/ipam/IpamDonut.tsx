'use client';

import { pctColor } from '@/components/ui';

export interface IpamDonutProps {
  used: number;
  free: number;
  total: number;
}

export function IpamDonut({ used, free, total }: IpamDonutProps) {
  const usedPct = total > 0 ? (used / total) * 100 : 0;
  const freePct = Math.max(0, 100 - usedPct);
  const usedColor = pctColor(usedPct);

  const r = 70;
  const circumference = 2 * Math.PI * r;
  const usedDash = (usedPct / 100) * circumference;

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
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>
        IP Address Utilization
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, flex: 1 }}>
        <div style={{ position: 'relative', width: 160, height: 160, flexShrink: 0 }}>
          <svg viewBox="0 0 180 180" width={160} height={160}>
            <g transform="rotate(-90 90 90)">
              <circle
                cx={90}
                cy={90}
                r={r}
                fill="none"
                stroke="var(--green)"
                strokeWidth={18}
                strokeLinecap="round"
              />
              <circle
                cx={90}
                cy={90}
                r={r}
                fill="none"
                stroke={usedColor}
                strokeWidth={18}
                strokeLinecap="round"
                strokeDasharray={`${usedDash} ${circumference}`}
              />
            </g>
          </svg>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
              {usedPct.toFixed(1)}%
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Utilized</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 150 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, gap: 16 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: usedColor }} />
              Used ({used.toLocaleString()})
            </span>
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{usedPct.toFixed(1)}%</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, gap: 16 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--green)' }} />
              Free ({free.toLocaleString()})
            </span>
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{freePct.toFixed(1)}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
