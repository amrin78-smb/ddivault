'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/components/Toast';
import {
  PageHeader, EmptyState, CardSkeleton, Spinner, useRefreshKey, useEscape,
} from '@/components/ui';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface Agent {
  id: number;
  hub_agent_id: string;
  name: string | null;
  hostname: string | null;
  status: string | null;
  version: string | null;
  last_seen_at: string | null;
  created_at: string;
  server_count: number;
}

interface Server {
  id: number;
  hostname: string;
  ip_address: string;
  role: string;
  is_active: boolean;
  site_id: number | null;
  site_name?: string | null;
  agent_hub_id: string | null;
}

interface Site { id: number; name: string; code: string; city: string }

// ════════════════════════════════════════════════════════════
// API helper
// ════════════════════════════════════════════════════════════
async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════
function isOnline(a: Agent): boolean {
  if ((a.status || '').toLowerCase() === 'offline') return false;
  if ((a.status || '').toLowerCase() === 'online') return true;
  // Fall back to last-seen freshness (< 3 min) when status is unset.
  if (!a.last_seen_at) return false;
  return Date.now() - new Date(a.last_seen_at).getTime() < 3 * 60 * 1000;
}

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const SECTION_HEADER: React.CSSProperties = {
  fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
};

// ════════════════════════════════════════════════════════════
// Assign-servers editor modal — MODULE SCOPE (never nested)
// ════════════════════════════════════════════════════════════
function AssignModal({ agent, servers, agentNames, canWrite, onClose, onDone }: {
  agent: Agent;
  servers: Server[];
  agentNames: Record<string, string>;
  canWrite: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  useEscape(onClose);
  const [saving, setSaving] = useState(false);

  // Selection state: server id -> assigned-to-this-agent?
  const [sel, setSel] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    for (const s of servers) init[s.id] = s.agent_hub_id === agent.hub_agent_id;
    return init;
  });

  const toggle = (id: number) => { if (canWrite) setSel(p => ({ ...p, [id]: !p[id] })); };

  // Group servers by site for a scannable multi-select.
  const groups = useMemo(() => {
    const by: Record<string, Server[]> = {};
    for (const s of servers) {
      const key = s.site_name || (s.site_id ? `Site ${s.site_id}` : 'No site');
      (by[key] = by[key] || []).push(s);
    }
    return Object.entries(by).sort((a, b) => a[0].localeCompare(b[0]));
  }, [servers]);

  const changes = useMemo(() => {
    const assign: number[] = [];
    const unassign: number[] = [];
    for (const s of servers) {
      const now = !!sel[s.id];
      const was = s.agent_hub_id === agent.hub_agent_id;
      if (now && !was) assign.push(s.id);
      if (!now && was) unassign.push(s.id);
    }
    return { assign, unassign };
  }, [sel, servers, agent.hub_agent_id]);

  const dirty = changes.assign.length > 0 || changes.unassign.length > 0;

  const save = async () => {
    if (!dirty) { onClose(); return; }
    setSaving(true);
    try {
      const r = await api(`/ddi-agents/${encodeURIComponent(agent.hub_agent_id)}/servers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assign: changes.assign, unassign: changes.unassign }),
      });
      const pushed = r.reconfigured && r.reconfigured[agent.hub_agent_id];
      toast(
        `Saved · +${r.assigned} / -${r.unassigned} server(s)` +
        (pushed ? ' · config pushed to agent' : ' · agent offline, will sync on reconnect'),
        pushed ? 'success' : 'info',
      );
      onDone();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
          padding: 24, width: 620, maxWidth: '94vw', maxHeight: '92vh', overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>
            Assign servers to {agent.name || agent.hostname || agent.hub_agent_id}
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', lineHeight: 1, color: 'var(--text-muted)' }}>
            ×
          </button>
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 18 }}>
          Checked servers are collected by this agent. Unchecked servers stay on central polling
          (or their current agent). Reassigning a server from another agent moves it automatically.
        </div>

        {servers.length === 0 ? (
          <EmptyState icon="🖥️" title="No servers" message="Add DHCP/DNS servers under Known Servers first." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 18 }}>
            {groups.map(([site, list]) => (
              <div key={site}>
                <div style={SECTION_HEADER}>{site}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {list.map(s => {
                    const checked = !!sel[s.id];
                    const owner = s.agent_hub_id;
                    const ownedElsewhere = owner && owner !== agent.hub_agent_id;
                    return (
                      <label key={s.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, cursor: canWrite ? 'pointer' : 'default',
                          padding: '9px 12px', borderRadius: 'var(--radius-sm)',
                          border: `1px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
                          background: checked ? 'var(--primary-light)' : 'var(--bg-primary)',
                          transition: 'all 0.12s',
                        }}
                      >
                        <input type="checkbox" checked={checked} disabled={!canWrite} onChange={() => toggle(s.id)} />
                        <span style={{ fontWeight: 600, fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
                          {s.hostname || s.ip_address}
                        </span>
                        <code className="mono" style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-xs)' }}>{s.ip_address}</code>
                        <span className={`badge ${s.role === 'both' ? 'badge-blue' : 'badge-gray'}`}>{s.role}</span>
                        {!s.is_active && <span className="badge badge-gray">disabled</span>}
                        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)' }}>
                          {ownedElsewhere
                            ? <span style={{ color: 'var(--tint-warn-fg)' }}>on {agentNames[owner!] || owner}</span>
                            : owner
                              ? <span style={{ color: 'var(--green)' }}>this agent</span>
                              : <span style={{ color: 'var(--text-muted)' }}>central</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: dirty ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            {!canWrite ? 'Read-only access' : dirty ? `+${changes.assign.length} / -${changes.unassign.length} pending` : 'No changes'}
          </span>
          <button className="btn" onClick={onClose}>{canWrite ? 'Cancel' : 'Close'}</button>
          {canWrite && (
            <button className="btn btn-primary" onClick={save} disabled={saving || !dirty} style={{ opacity: saving || !dirty ? 0.6 : 1 }}>
              {saving ? <><Spinner size={13} color="#fff" /> Saving…</> : 'Save assignment'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Agent card — MODULE SCOPE (never nested)
// ════════════════════════════════════════════════════════════
function AgentCard({ a, canWrite, onManage }: {
  a: Agent;
  canWrite: boolean;
  onManage: (a: Agent) => void;
}) {
  const online = isOnline(a);
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
      padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{
          width: 11, height: 11, borderRadius: '50%', flexShrink: 0,
          background: online ? 'var(--green)' : '#94a3b8',
          boxShadow: online ? '0 0 7px var(--green)' : 'none',
        }} title={online ? 'Online' : 'Offline'} />
        <div style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>{a.name || a.hostname || a.hub_agent_id}</div>
        <span className={`badge ${online ? 'badge-green' : 'badge-gray'}`}>{online ? 'Online' : 'Offline'}</span>
        {a.version && <span className="badge badge-blue">v{a.version}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
        {a.hostname && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 78 }}>Hostname</span>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{a.hostname}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: 'var(--text-muted)', minWidth: 78 }}>Hub agent</span>
          <code className="mono" style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-xs)' }}>{a.hub_agent_id}</code>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: 'var(--text-muted)', minWidth: 78 }}>Servers</span>
          <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{a.server_count} assigned</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: 'var(--text-muted)', minWidth: 78 }}>Last seen</span>
          <span style={{ color: 'var(--text-secondary)' }}>{relTime(a.last_seen_at)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto', paddingTop: 4, borderTop: '1px solid var(--border-light)' }}>
        {canWrite ? (
          <button className="btn btn-navy" onClick={() => onManage(a)} style={{ fontSize: 'var(--text-sm)' }}>
            Manage servers
          </button>
        ) : (
          <button className="btn" onClick={() => onManage(a)} style={{ fontSize: 'var(--text-sm)' }}>
            View servers
          </button>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN — Remote Agents tab
// ════════════════════════════════════════════════════════════
export default function AgentsTab() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [manage, setManage] = useState<Agent | null>(null);
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  const load = useCallback(async () => {
    const [ag, sv] = await Promise.allSettled([api('/ddi-agents'), api('/servers')]);
    if (ag.status === 'fulfilled') setAgents(ag.value.data || []);
    if (sv.status === 'fulfilled') setServers(sv.value.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useRefreshKey(load);

  const agentNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of agents) m[a.hub_agent_id] = a.name || a.hostname || a.hub_agent_id;
    return m;
  }, [agents]);

  const total = agents.length;
  const online = agents.filter(isOnline).length;
  const onAgents = servers.filter(s => s.agent_hub_id).length;
  const central = servers.filter(s => !s.agent_hub_id).length;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="Remote Agents"
        subtitle="Assign DHCP/DNS servers to a remote collector agent, or leave them on central polling"
      />

      <ReadOnlyBanner />

      {/* Enrollment note — lifecycle lives in the hub, not here */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9,
        padding: '10px 14px', borderRadius: 'var(--radius)',
        background: 'var(--tint-info)', color: 'var(--tint-info-fg)',
        border: '1px solid var(--tint-info)', fontSize: 'var(--text-sm)',
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        Agents are enrolled and revoked from the NocVault hub. An agent appears here automatically
        once it connects — this page only controls which servers each agent collects.
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        <div className="kpi-card" style={{ borderLeftColor: 'var(--navy)' }}>
          <div className="stat-value" style={{ fontSize: 'var(--text-2xl)' }}>{total}</div>
          <div className="stat-label">Agents</div>
        </div>
        <div className="kpi-card" style={{ borderLeftColor: 'var(--green)' }}>
          <div className="stat-value" style={{ fontSize: 'var(--text-2xl)', color: 'var(--green)' }}>{online}</div>
          <div className="stat-label">Online</div>
        </div>
        <div className="kpi-card" style={{ borderLeftColor: 'var(--blue)' }}>
          <div className="stat-value" style={{ fontSize: 'var(--text-2xl)', color: 'var(--blue)' }}>{onAgents}</div>
          <div className="stat-label">Servers on Agents</div>
        </div>
        <div className="kpi-card" style={{ borderLeftColor: '#94a3b8' }}>
          <div className="stat-value" style={{ fontSize: 'var(--text-2xl)', color: 'var(--text-muted)' }}>{central}</div>
          <div className="stat-label">Central Polling</div>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
          <CardSkeleton count={3} height={120} />
        </div>
      ) : agents.length === 0 ? (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <EmptyState
            icon="🛰️"
            title="No agents connected"
            message="Enroll a DDIVault agent from the NocVault hub and point it at this app. It will appear here automatically once it connects."
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
          {agents.map(a => (
            <AgentCard key={a.hub_agent_id} a={a} canWrite={canWrite} onManage={setManage} />
          ))}
        </div>
      )}

      {manage && (
        <AssignModal
          agent={manage}
          servers={servers}
          agentNames={agentNames}
          canWrite={canWrite}
          onClose={() => setManage(null)}
          onDone={() => { setManage(null); load(); }}
        />
      )}
    </div>
  );
}
