'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader, EmptyState, Skeleton, useRefreshKey } from '@/components/ui';

const CARD: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)' };
const TITLE: React.CSSProperties = { fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)' };

async function api(path: string) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface ServerHealth {
  id: number; hostname: string; ip: string; role: string; poll_status: string;
  last_polled: string | null; health_score: number | null; health_checked_at: string | null;
  query_ms: number | null; winrm_test_ok: boolean | null;
  scope_count: string; lease_count: string; zone_count: string; record_count: string;
}
interface FailoverPair {
  id: number; relationship_name: string; mode: string; state: string;
  primary_name: string | null; secondary_name: string | null; mclt: number | null; split_ratio: number | null; last_checked: string;
}

function scoreColor(s: number | null) {
  if (s == null) return 'var(--text-muted)';
  if (s >= 90) return 'var(--green)';
  if (s >= 70) return 'var(--yellow)';
  return 'var(--red)';
}

// ── Circular health gauge ─────────────────────────────────────
function Gauge({ score }: { score: number | null }) {
  const r = 30, c = 2 * Math.PI * r;
  const v = score == null ? 0 : Math.max(0, Math.min(100, score));
  const color = scoreColor(score);
  return (
    <svg width="74" height="74" viewBox="0 0 74 74">
      <circle cx="37" cy="37" r={r} fill="none" stroke="var(--border)" strokeWidth="7" />
      <circle cx="37" cy="37" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c - (v / 100) * c} transform="rotate(-90 37 37)" />
      <text x="37" y="40" textAnchor="middle" fontSize="var(--text-lg)" fontWeight="800" fill={color}>{score == null ? '—' : score}</text>
      <text x="37" y="52" textAnchor="middle" fontSize="var(--text-xs)" fill="var(--text-muted)">/ 100</text>
    </svg>
  );
}

const FAILOVER_BADGE: Record<string, string> = {
  normal: 'badge-green', 'communication-interrupted': 'badge-yellow', 'partner-down': 'badge-red', recover: 'badge-blue',
};

export default function InfraHealthTab() {
  const [servers, setServers] = useState<ServerHealth[]>([]);
  const [overall, setOverall] = useState<string>('healthy');
  const [worst, setWorst] = useState<number | null>(null);
  const [pairs, setPairs] = useState<FailoverPair[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [h, f] = await Promise.all([api('/infrastructure/health'), api('/infrastructure/failover')]);
      setServers(h.data || []); setOverall(h.overall || 'healthy'); setWorst(h.worst_score);
      setPairs(f.data || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  useRefreshKey(load);

  const stripColor = overall === 'critical' ? 'var(--red)' : overall === 'warning' ? 'var(--yellow)' : 'var(--green)';
  const stripText = overall === 'critical' ? 'Critical issues detected' : overall === 'warning' ? 'Warnings present' : 'All systems healthy';

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader title="Infrastructure Health" subtitle="Live health score, WinRM reachability, DHCP failover and DNS replication across every monitored server." />

      {/* Status strip */}
      <div style={{ borderRadius: 'var(--radius)', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14, background: stripColor, color: '#fff', boxShadow: 'var(--shadow-sm)' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', boxShadow: '0 0 0 4px rgba(255,255,255,0.3)' }} />
        <span style={{ fontWeight: 700, fontSize: 'var(--text-md)' }}>{stripText}</span>
        <span style={{ opacity: 0.9, fontSize: 'var(--text-base)' }}>{servers.length} server{servers.length === 1 ? '' : 's'} monitored{worst != null && ` · lowest score ${worst}/100`}</span>
      </div>

      {/* Server health cards */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {Array.from({ length: 3 }).map((_, i) => <div key={i} style={{ ...CARD, padding: 18 }}><Skeleton height={74} width={74} radius={37} /><div style={{ height: 10 }} /><Skeleton height={14} width="60%" /></div>)}
        </div>
      ) : servers.length === 0 ? (
        <div style={CARD}><EmptyState title="No active servers" message="Add a DHCP/DNS server in the Known Servers tab to begin health monitoring." /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 14 }}>
          {servers.map(s => (
            <div key={s.id} style={{ ...CARD, padding: 18, display: 'flex', flexDirection: 'column', gap: 14, borderLeft: `4px solid ${scoreColor(s.health_score)}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <Gauge score={s.health_score} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.hostname}</div>
                  <div style={{ ...MUTED, fontFamily: 'var(--font-mono)' }}>{s.ip}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    <span className="badge badge-gray">{s.role.toUpperCase()}</span>
                    <span className={`badge ${s.winrm_test_ok === false ? 'badge-red' : s.winrm_test_ok ? 'badge-green' : 'badge-gray'}`}>
                      WinRM {s.winrm_test_ok === false ? 'down' : s.winrm_test_ok ? 'ok' : 'unknown'}
                    </span>
                  </div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {[
                  { l: 'Scopes', v: s.scope_count },
                  { l: 'Leases', v: s.lease_count },
                  { l: 'Zones', v: s.zone_count },
                  { l: 'DNS Records', v: s.record_count },
                ].map(m => (
                  <div key={m.l} style={{ background: 'var(--bg-primary)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)' }}>{m.v}</div>
                    <div style={MUTED}>{m.l}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', ...MUTED, borderTop: '1px solid var(--border-light)', paddingTop: 10 }}>
                <span>Query: {s.query_ms != null ? `${s.query_ms} ms` : '—'}</span>
                <span>Checked: {s.health_checked_at ? new Date(s.health_checked_at).toLocaleTimeString() : '—'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Failover relationships */}
      <div style={CARD}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={TITLE}>DHCP Failover Relationships</div>
          <span style={MUTED}>{pairs.length} configured</span>
        </div>
        {pairs.length === 0 ? (
          <EmptyState title="No failover relationships" message="Failover pairs are discovered automatically from your DHCP servers every 5 minutes." />
        ) : (
          <table className="data-table">
            <thead><tr><th>Relationship</th><th>Primary</th><th>Secondary</th><th>Mode</th><th>State</th><th>MCLT</th><th>Last Checked</th></tr></thead>
            <tbody>
              {pairs.map(p => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.relationship_name}</td>
                  <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{p.primary_name || '—'}</td>
                  <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{p.secondary_name || '—'}</td>
                  <td><span className="badge badge-gray">{p.mode || '—'}</span></td>
                  <td><span className={`badge ${FAILOVER_BADGE[p.state] || 'badge-gray'}`}>{p.state || 'unknown'}</span></td>
                  <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{p.mclt != null ? `${p.mclt}s` : '—'}</td>
                  <td style={{ ...MUTED }}>{p.last_checked ? new Date(p.last_checked).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
