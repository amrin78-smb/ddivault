'use client';

import { useMemo, useState } from 'react';

// Left-rail report catalog: a search box + a grouped, single-column list of reports.
// Replaces the old big card grid. Purely presentational — selection state lives in the
// parent (ReportsTab) via `activeKey`/`onSelect`. Module-level component (never defined
// inside ReportsTab's body) so it doesn't remount on every parent render.

export interface CatalogReport {
  key: string;
  short: string;      // rail label (concise)
  title: string;      // full report title (for search)
  desc: string;       // description (for search)
  color: string;      // brand/category dot color (a design token, e.g. var(--blue))
  category: string;
}

// Fixed group order for the rail.
const GROUP_ORDER = ['Inventory', 'DHCP', 'DNS', 'Security & change', 'Trends'];

const MUTED: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)' };

export function ReportsCatalog({ reports, activeKey, onSelect }: {
  reports: CatalogReport[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (r: CatalogReport) =>
      !q ||
      r.short.toLowerCase().includes(q) ||
      r.title.toLowerCase().includes(q) ||
      r.desc.toLowerCase().includes(q) ||
      r.category.toLowerCase().includes(q);
    return GROUP_ORDER
      .map(cat => ({ cat, items: reports.filter(r => r.category === cat && match(r)) }))
      .filter(g => g.items.length > 0);
  }, [reports, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <input
        className="input"
        placeholder="Search reports…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        aria-label="Search reports"
        style={{ width: '100%', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 2 }}>
        {groups.length === 0 ? (
          <div style={{ ...MUTED, padding: '8px 4px' }}>No reports match “{query}”.</div>
        ) : groups.map(g => (
          <div key={g.cat}>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '0 8px 6px' }}>
              {g.cat}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {g.items.map(r => {
                const isActive = r.key === activeKey;
                const baseBg = isActive ? 'var(--primary-light)' : 'transparent';
                return (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => onSelect(r.key)}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--surface-subtle)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = baseBg; }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                      padding: '8px 10px', cursor: 'pointer',
                      background: baseBg,
                      border: 'none',
                      borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                      borderRadius: 'var(--radius-sm, 8px)',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontSize: 'var(--text-base)',
                      fontWeight: isActive ? 600 : 500,
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.short}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
