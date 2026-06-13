'use client';

import { pctColor, Skeleton } from '@/components/ui';

export interface IpamKpiTilesProps {
  supernetCount: number;
  subnetCount: number;
  totalIps: number;
  usedIps: number;
  freeIps: number;
  unknownHosts: number;
  loading?: boolean;
}

interface TileConfig {
  label: string;
  value: number;
  color: string;
  pct?: number;
}

export function IpamKpiTiles({
  supernetCount,
  subnetCount,
  totalIps,
  usedIps,
  freeIps,
  unknownHosts,
  loading = false,
}: IpamKpiTilesProps) {
  const usedPct = totalIps > 0 ? (usedIps / totalIps) * 100 : 0;
  const freePct = totalIps > 0 ? (freeIps / totalIps) * 100 : 0;

  const tiles: TileConfig[] = [
    { label: 'Supernets', value: supernetCount, color: 'var(--navy)' },
    { label: 'Subnets', value: subnetCount, color: 'var(--blue)' },
    { label: 'Total IP Addresses', value: totalIps, color: 'var(--purple)' },
    { label: 'Used IPs', value: usedIps, color: pctColor(usedPct), pct: usedPct },
    { label: 'Free IPs', value: freeIps, color: 'var(--green)', pct: freePct },
    {
      label: 'Unknown Hosts',
      value: unknownHosts,
      color: unknownHosts > 0 ? 'var(--orange)' : 'var(--green)',
    },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
      {tiles.map((tile) => (
        <div key={tile.label} className="kpi-card" style={{ borderLeftColor: tile.color }}>
          {loading ? (
            <Skeleton height={28} width={60} />
          ) : (
            <div style={{ fontSize: 26, fontWeight: 700, color: tile.color }}>
              {tile.value.toLocaleString()}
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{tile.label}</div>
          {!loading && tile.pct !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
              <div
                style={{
                  flex: 1,
                  height: 5,
                  background: 'var(--border)',
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, tile.pct)}%`,
                    height: '100%',
                    background: tile.color,
                    borderRadius: 3,
                  }}
                />
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: tile.color }}>
                {tile.pct.toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
