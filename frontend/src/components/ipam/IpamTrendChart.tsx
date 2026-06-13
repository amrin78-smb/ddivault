'use client';

import { useMemo } from 'react';

export interface TrendPoint {
  recorded_at: string;
  total_ips: number;
  used_ips: number;
  free_ips: number;
  utilization_pct: number;
}

export interface IpamTrendChartProps {
  data: TrendPoint[];
  granularity: 'daily' | 'weekly';
  onGranularityChange: (g: 'daily' | 'weekly') => void;
  loading?: boolean;
}

interface Bucket {
  label: string;
  value: number;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow-sm)',
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
};

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });

export function IpamTrendChart({ data, granularity, onGranularityChange, loading }: IpamTrendChartProps) {
  const buckets = useMemo<Bucket[]>(() => {
    if (!data.length) return [];
    const sorted = [...data].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );
    const lastByKey = new Map<string, TrendPoint>();
    for (const p of sorted) {
      const t = new Date(p.recorded_at).getTime();
      const key =
        granularity === 'daily'
          ? p.recorded_at.slice(0, 10)
          : String(Math.floor(t / 86400000 / 7));
      lastByKey.set(key, p); // sorted asc, so last write wins = latest snapshot
    }
    return Array.from(lastByKey.values())
      .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())
      .map((p) => ({ label: fmtDate(p.recorded_at), value: p.used_ips }));
  }, [data, granularity]);

  const toggle = (
    <div className="segmented">
      <button className={granularity === 'daily' ? 'active' : ''} onClick={() => onGranularityChange('daily')}>
        Daily
      </button>
      <button className={granularity === 'weekly' ? 'active' : ''} onClick={() => onGranularityChange('weekly')}>
        Weekly
      </button>
    </div>
  );

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>Utilization Over Time</div>
      {toggle}
    </div>
  );

  if (loading) {
    return (
      <div style={cardStyle}>
        {header}
        <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Loading…
        </div>
      </div>
    );
  }

  if (buckets.length < 2) {
    return (
      <div style={cardStyle}>
        {header}
        <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '0 24px' }}>
          Not enough history yet — utilization is recorded hourly.
        </div>
      </div>
    );
  }

  // Chart geometry
  const W = 600;
  const H = 220;
  const padL = 48;
  const padR = 16;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const values = buckets.map((b) => b.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const max = rawMax + Math.max(1, Math.round((rawMax - rawMin || rawMax || 1) * 0.1));
  const min = Math.max(0, rawMin - Math.round((rawMax - rawMin) * 0.05));
  const span = max - min || 1;

  const x = (i: number): number =>
    padL + (buckets.length === 1 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);
  const y = (v: number): number => padT + plotH - ((v - min) / span) * plotH;

  const gridLines = 4;
  const gridYs = Array.from({ length: gridLines }, (_, i) => {
    const v = min + (span * i) / (gridLines - 1);
    return { v: Math.round(v), y: y(v) };
  });

  const linePath = buckets.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(b.value)}`).join(' ');
  const areaPath = `${linePath} L${x(buckets.length - 1)},${padT + plotH} L${x(0)},${padT + plotH} Z`;

  const labelStep = Math.max(1, Math.ceil(buckets.length / 8));

  return (
    <div style={cardStyle}>
      {header}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" role="img">
        {gridYs.map((g, i) => (
          <g key={i}>
            <line x1={padL} y1={g.y} x2={W - padR} y2={g.y} stroke="var(--border-light)" strokeWidth={1} />
            <text x={padL - 8} y={g.y + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">
              {g.v}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="var(--primary)" fillOpacity={0.08} stroke="none" />
        <path d={linePath} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {buckets.map((b, i) => (
          <circle key={i} cx={x(i)} cy={y(b.value)} r={2.5} fill="var(--primary)" />
        ))}

        {buckets.map((b, i) =>
          i % labelStep === 0 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
              {b.label}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}
