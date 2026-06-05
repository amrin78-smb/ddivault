'use client';

import { useState, useEffect, useCallback } from 'react';
import { EmptyState, CardSkeleton } from '@/components/ui';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface Lease {
  device_type?: string | null;
}

interface SlideOverLease {
  ip_address?: string | null;
  hostname?: string | null;
  mac_address?: string | null;
  device_vendor?: string | null;
  scope_id?: string | null;
  server_hostname?: string | null;
  last_seen?: string | null;
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

const CATEGORY_DEVICE_TYPE: Record<Category, string> = {
  Mobile: 'mobile',
  Workstation: 'workstation',
  Network: 'network',
  Printer: 'printer',
  VoIP: 'voip',
  Unknown: 'unknown',
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
// Slide-over panel (module-scoped)
// ════════════════════════════════════════════════════════════
interface DeviceSlideOverProps {
  category: string;
  deviceType: string;
  count: number;
  onClose: () => void;
}

function DeviceSlideOver({ category, deviceType, count, onClose }: DeviceSlideOverProps) {
  const [visible, setVisible] = useState(false);
  const [leases, setLeases] = useState<SlideOverLease[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 250);
  }, [onClose]);

  // Animate in
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Fetch on mount + when search changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setListLoading(true);
      setListError(null);
      try {
        let path = `/leases?device_type=${encodeURIComponent(deviceType)}&limit=100`;
        if (search.trim()) path += `&search=${encodeURIComponent(search.trim())}`;
        const d = await api(path);
        if (cancelled) return;
        setLeases(Array.isArray(d?.data) ? d.data : []);
      } catch (e: unknown) {
        if (cancelled) return;
        setListError(e instanceof Error ? e.message : 'Failed to load devices');
        setLeases([]);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deviceType, search]);

  const TH: React.CSSProperties = {
    textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600,
    color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
    background: 'var(--bg-card)', whiteSpace: 'nowrap',
  };
  const TD: React.CSSProperties = {
    padding: '8px 12px', fontSize: 13, color: 'var(--text-primary)',
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  };
  const MONO: React.CSSProperties = { fontFamily: 'monospace', fontSize: 12.5 };

  return (
    <>
      <div
        onClick={close}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
          opacity: visible ? 1 : 0, transition: 'opacity 0.25s ease',
        }}
      />
      <div
        className="ipam-slideover"
        style={{
          position: 'fixed', top: 0, right: 0, height: '100vh', width: '70%', maxWidth: 1000,
          background: 'var(--bg-card)', zIndex: 1001, boxShadow: '-8px 0 24px rgba(0,0,0,0.15)',
          display: 'flex', flexDirection: 'column',
          transform: `translateX(${visible ? 0 : 100}%)`, transition: 'transform 0.25s ease',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', flexShrink: 0 }}>
            {category} Devices ({count.toLocaleString()})
          </div>
          <input
            className="input"
            placeholder="Search IP, hostname, MAC, vendor…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 120 }}
          />
          <button
            onClick={close}
            aria-label="Close"
            style={{
              background: 'transparent', border: '1px solid var(--border)', borderRadius: 8,
              width: 32, height: 32, cursor: 'pointer', fontSize: 16, lineHeight: 1,
              color: 'var(--text-muted)', flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {listLoading ? (
            <div style={{ padding: '16px 20px' }}>
              <CardSkeleton count={1} height={200} />
            </div>
          ) : listError ? (
            <EmptyState icon="⚠" title="Unable to load devices" message={listError} />
          ) : leases.length === 0 ? (
            <EmptyState icon="📡" title="No devices found" message={`No ${category.toLowerCase()} devices matched.`} />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>IP Address</th>
                  <th style={TH}>Hostname</th>
                  <th style={TH}>MAC</th>
                  <th style={TH}>Vendor</th>
                  <th style={TH}>Scope</th>
                  <th style={TH}>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {leases.map((l, i) => (
                  <tr key={`${l.ip_address || ''}-${l.mac_address || ''}-${i}`}>
                    <td style={{ ...TD, ...MONO }}>{l.ip_address || '—'}</td>
                    <td style={TD}>{l.hostname || '—'}</td>
                    <td style={{ ...TD, ...MONO }}>{l.mac_address || '—'}</td>
                    <td style={TD}>{l.device_vendor || '—'}</td>
                    <td style={TD}>{l.scope_id || '—'}</td>
                    <td style={TD}>{l.last_seen ? new Date(l.last_seen).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════
export default function DeviceDonut() {
  const [slices, setSlices] = useState<Slice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openCat, setOpenCat] = useState<{ category: string; deviceType: string; count: number } | null>(null);
  const [hovered, setHovered] = useState<Category | null>(null);

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
    <>
    <div style={CARD}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
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
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {slices.map(s => (
            <div
              key={s.category}
              onClick={() => setOpenCat({ category: s.category, deviceType: CATEGORY_DEVICE_TYPE[s.category], count: s.count })}
              onMouseEnter={() => setHovered(s.category)}
              onMouseLeave={() => setHovered(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                padding: '4px 0', borderRadius: 6,
                background: hovered === s.category ? 'var(--bg-primary)' : 'transparent',
              }}
            >
              <span style={{ fontSize: 11, color: 'var(--text-primary)', width: 84, flexShrink: 0 }}>{s.category}</span>
              <div style={{ flex: 1, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  width: `${maxPct > 0 ? (s.pct / maxPct) * 100 : 0}%`,
                  height: '100%', background: s.color, borderRadius: 4,
                }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', width: 48, textAlign: 'right', flexShrink: 0 }}>{s.count.toLocaleString()}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 46, textAlign: 'right', flexShrink: 0 }}>{s.pct.toFixed(1)}%</span>
              <span style={{ fontSize: 15, color: 'var(--text-muted)', width: 12, textAlign: 'center', flexShrink: 0, lineHeight: 1 }}>›</span>
            </div>
          ))}
        </div>
      )}
    </div>
    {openCat && (
      <DeviceSlideOver
        category={openCat.category}
        deviceType={openCat.deviceType}
        count={openCat.count}
        onClose={() => setOpenCat(null)}
      />
    )}
    </>
  );
}
