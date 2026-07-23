'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { severityBadgeClass } from '@/components/palette';

// ════════════════════════════════════════════════════════════
// ActivityFeed — a single tabbed "what just happened" dashboard
// card replacing 3 separate cards: DHCP events (activity), config
// changes (audit), and fired alerts. All data fetched once on
// mount / refreshNonce; switching tabs does NOT refetch.
// ════════════════════════════════════════════════════════════

// ── API helper (mirrors DNSTab) ───────────────────────────────
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

type FeedTab = 'activity' | 'changes' | 'alerts';

interface Props {
  refreshNonce?: number;
  onNavigate?: (tab: string) => void;
}

// ── Truncation helper ─────────────────────────────────────────
function truncate(s: any, n = 40): string {
  const str = s == null ? '' : String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}

// ── DHCP event-type badge ─────────────────────────────────────
const EVENT_BADGE: Record<string, string> = {
  assign: 'badge-green',
  renew: 'badge-blue',
  release: 'badge-gray',
  conflict: 'badge-red',
  nack: 'badge-red',
  roguedhcp: 'badge-red',
  scopefull: 'badge-yellow',
  scopewarning: 'badge-yellow',
};
function EventTypeBadge({ type }: { type?: string }) {
  const key = (type || '').toLowerCase().replace(/[^a-z]/g, '');
  const cls = EVENT_BADGE[key] || 'badge-gray';
  return <span className={`badge ${cls}`}>{type || '—'}</span>;
}

// ── Audit action badge ────────────────────────────────────────
function ActionBadge({ action }: { action?: string }) {
  const a = (action || '').toLowerCase();
  const cls = a === 'create' ? 'badge-green'
    : a === 'delete' ? 'badge-red'
    : a === 'modify' ? 'badge-yellow'
    : 'badge-gray';
  return <span className={`badge ${cls}`}>{(action || '—').toUpperCase()}</span>;
}

// ── Segmented control button ──────────────────────────────────
function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 11px', fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer',
        borderRadius: 'var(--radius-sm)', fontFamily: 'inherit', lineHeight: 1.6,
        border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
        background: active ? 'var(--primary-light)' : 'var(--bg-card)',
        color: active ? 'var(--primary)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  );
}

const CARD: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', overflow: 'hidden',
};

export default function ActivityFeed(props: Props) {
  const { refreshNonce, onNavigate } = props;
  const [tab, setTab] = useState<FeedTab>('activity');
  const [events, setEvents] = useState<any[]>([]);
  const [changes, setChanges] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    if (firstLoad.current) setLoading(true);
    const [ev, au, al] = await Promise.allSettled([
      api('/dashboard/recent-events?limit=20'),
      api('/audit?limit=15'),
      api('/alerts?limit=15'),
    ]);
    if (ev.status === 'fulfilled') setEvents(ev.value?.data || []);
    if (au.status === 'fulfilled') setChanges(au.value?.data || []);
    if (al.status === 'fulfilled') setAlerts(al.value?.data || []);
    firstLoad.current = false;
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshNonce]);

  const viewAll = () => {
    if (!onNavigate) return;
    onNavigate(tab === 'changes' ? 'audit' : 'events');
  };

  return (
    <div style={CARD}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '12px 14px', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)' }}>Recent Activity</div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <SegButton active={tab === 'activity'} onClick={() => setTab('activity')}>Activity</SegButton>
          <SegButton active={tab === 'changes'} onClick={() => setTab('changes')}>Changes</SegButton>
          <SegButton active={tab === 'alerts'} onClick={() => setTab('alerts')}>Alerts</SegButton>
        </div>
        <button
          onClick={viewAll}
          style={{
            fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--primary)', cursor: 'pointer',
            background: 'none', border: 'none', padding: 0, fontFamily: 'inherit',
          }}
        >
          View all →
        </button>
      </div>

      {/* Body */}
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {loading ? (
          <TableSkeleton rows={6} cols={4} />
        ) : tab === 'activity' ? (
          events.length === 0 ? (
            <EmptyState title="No recent activity" message="DHCP lease events will appear here as they happen." />
          ) : (
            <table className="data-table" style={{ fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr><th>Type</th><th>IP</th><th>Hostname</th><th>Time</th></tr>
              </thead>
              <tbody>
                {events.map((e: any) => (
                  <tr key={e.id}>
                    <td><EventTypeBadge type={e.event_type} /></td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{e.ip_address || '—'}</td>
                    <td title={e.hostname || ''}>{truncate(e.hostname, 28)}</td>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtDateTime(e.event_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : tab === 'changes' ? (
          changes.length === 0 ? (
            <EmptyState title="No recent changes" message="Configuration changes and edits will be logged here." />
          ) : (
            <table className="data-table" style={{ fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr><th>Action</th><th>Summary</th><th>User</th><th>Time</th></tr>
              </thead>
              <tbody>
                {changes.map((c: any) => {
                  const summary = c.change_summary || `${c.action || ''} ${c.entity_type || ''}`.trim();
                  return (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onNavigate?.('audit')}>
                      <td><ActionBadge action={c.action} /></td>
                      <td title={summary}>{truncate(summary, 44)}</td>
                      <td title={c.username || ''}>{truncate(c.username, 18)}</td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtTime(c.timestamp)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : (
          alerts.length === 0 ? (
            <EmptyState title="No active alerts" message="Fired alerts will show up here when thresholds are crossed." />
          ) : (
            <table className="data-table" style={{ fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr><th>Severity</th><th>Message</th><th>Fired</th></tr>
              </thead>
              <tbody>
                {alerts.map((a: any) => (
                  <tr key={a.id}>
                    <td>
                      <span className={`badge ${severityBadgeClass(a.severity || 'warning')}`}>
                        {(a.severity || 'warning').toUpperCase()}
                      </span>
                    </td>
                    <td title={a.message || ''}>
                      {truncate(a.message, 48)}
                      {a.acknowledged && (
                        <span style={{
                          marginLeft: 6, fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)',
                          border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px',
                          verticalAlign: 'middle',
                        }}>ACK</span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtDateTime(a.fired_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}
