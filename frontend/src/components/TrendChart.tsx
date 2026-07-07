'use client';

import { ChartSpec, SERIES_COLORS, yfmt } from './reportTypes';

// Fixed internal coordinate space; the svg scales responsively via viewBox.
const VW = 800;
const M = { top: 8, right: 16, bottom: 24, left: 44 };

export function TrendChart({ chart, height }: { chart: ChartSpec; height?: number }): JSX.Element {
  const h = height ?? 200;
  const plotW = VW - M.left - M.right;
  const plotH = h - M.top - M.bottom;

  const series = chart.series || [];
  const x = chart.x || [];
  const yFmt = chart.yFormat;

  // Collect all non-null points to compute the y-domain.
  const allVals: number[] = [];
  for (const s of series) {
    for (const p of s.points || []) {
      if (p !== null && p !== undefined && Number.isFinite(p)) allVals.push(p);
    }
  }

  const isEmpty = allVals.length === 0 || x.length === 0;

  // y-domain: floor at 0 for number/percent; pad the top ~10%.
  let yMin = 0;
  let yMax = 1;
  if (allVals.length > 0) {
    const rawMin = Math.min(...allVals);
    const rawMax = Math.max(...allVals);
    yMin = rawMin < 0 ? rawMin : 0;
    yMax = rawMax <= yMin ? yMin + 1 : rawMax + (rawMax - yMin) * 0.1;
  }
  const yRange = yMax - yMin || 1;

  // Scales.
  const xCount = x.length;
  const xAt = (i: number): number => {
    if (xCount <= 1) return M.left + plotW / 2;
    return M.left + (i / (xCount - 1)) * plotW;
  };
  const yAt = (v: number): number => M.top + plotH - ((v - yMin) / yRange) * plotH;
  const baselineY = yAt(Math.max(0, yMin));

  const titleStyle: React.CSSProperties = {
    fontSize: 'var(--text-md)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 6,
  };

  if (isEmpty) {
    return (
      <div style={{ width: '100%' }}>
        {chart.title && <div style={titleStyle}>{chart.title}</div>}
        <div
          style={{
            height: h,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-sm)',
          }}
        >
          No data in range
        </div>
      </div>
    );
  }

  // Gridline levels: min, mid, max.
  const levels = [yMin, yMin + yRange / 2, yMax];

  // x label indices: first, middle, last.
  const xIdx = Array.from(new Set(xCount <= 1 ? [0] : [0, Math.floor((xCount - 1) / 2), xCount - 1]));

  const colorFor = (s: { color?: string }, i: number): string => s.color || SERIES_COLORS[i % SERIES_COLORS.length];

  // Build a line path that breaks at null points (multiple segments).
  const linePath = (points: (number | null)[]): string => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      if (p === null || p === undefined || isNaN(p)) {
        pen = false;
        return;
      }
      const cmd = pen ? 'L' : 'M';
      d += `${cmd}${xAt(i).toFixed(2)} ${yAt(p).toFixed(2)} `;
      pen = true;
    });
    return d.trim();
  };

  // Area fill path: for each contiguous non-null run, draw the top line then close to baseline.
  const areaPath = (points: (number | null)[]): string => {
    let d = '';
    let run: number[] = [];
    const flush = () => {
      if (run.length === 0) return;
      let seg = `M${xAt(run[0]).toFixed(2)} ${baselineY.toFixed(2)} `;
      for (const i of run) seg += `L${xAt(i).toFixed(2)} ${yAt(points[i] as number).toFixed(2)} `;
      seg += `L${xAt(run[run.length - 1]).toFixed(2)} ${baselineY.toFixed(2)} Z `;
      d += seg;
      run = [];
    };
    points.forEach((p, i) => {
      if (p === null || p === undefined || isNaN(p)) flush();
      else run.push(i);
    });
    flush();
    return d.trim();
  };

  // Bar geometry: grouped bars per x slot.
  const slotW = xCount > 0 ? plotW / xCount : plotW;
  const groupW = slotW * 0.7;
  const barCount = Math.max(1, series.length);
  const barW = groupW / barCount;

  return (
    <div style={{ width: '100%' }}>
      {chart.title && <div style={titleStyle}>{chart.title}</div>}

      {/* Legend */}
      {series.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 6 }}>
          {series.map((s, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: colorFor(s, i), display: 'inline-block' }} />
              {s.label}
            </span>
          ))}
        </div>
      )}

      <svg viewBox={`0 0 ${VW} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label={chart.title}>
        {/* Gridlines + y labels */}
        {levels.map((lv, i) => {
          const yy = yAt(lv);
          return (
            <g key={i}>
              <line x1={M.left} y1={yy} x2={VW - M.right} y2={yy} stroke="var(--border)" strokeWidth={1} />
              <text x={M.left - 6} y={yy + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                {yfmt(lv, yFmt)}
              </text>
            </g>
          );
        })}

        {/* x labels */}
        {xIdx.map((i, k) => (
          <text
            key={k}
            x={xAt(i)}
            y={h - 6}
            textAnchor={k === 0 ? 'start' : k === xIdx.length - 1 ? 'end' : 'middle'}
            fontSize={10}
            fill="var(--text-muted)"
          >
            {x[i]}
          </text>
        ))}

        {/* Series */}
        {chart.type === 'bar'
          ? series.map((s, si) => {
              const col = colorFor(s, si);
              return (
                <g key={si}>
                  {(s.points || []).map((p, i) => {
                    if (p === null || p === undefined || isNaN(p)) return null;
                    const slotCenter = xCount <= 1 ? M.left + plotW / 2 : M.left + (i + 0.5) * slotW;
                    const gx = slotCenter - groupW / 2 + si * barW;
                    const top = yAt(p);
                    const bh = Math.max(0, baselineY - top);
                    return <rect key={i} x={gx} y={top} width={Math.max(1, barW - 1)} height={bh} fill={col} />;
                  })}
                </g>
              );
            })
          : series.map((s, si) => {
              const col = colorFor(s, si);
              return (
                <g key={si}>
                  {chart.type === 'area' && <path d={areaPath(s.points || [])} fill={col} opacity={0.12} stroke="none" />}
                  <path d={linePath(s.points || [])} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
      </svg>
    </div>
  );
}
