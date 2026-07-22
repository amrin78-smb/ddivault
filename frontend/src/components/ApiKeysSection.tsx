'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';
import { useEscape } from '@/components/ui';
import { INPUT_SM, INPUT_MD } from '@/lib/settingsFormStyles';

const MUTED: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)' };

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

interface ApiKey {
  id: number; key_masked: string; key_prefix: string; name: string; description: string | null;
  created_by: string | null; created_at: string; last_used_at: string | null; expires_at: string | null;
  is_active: boolean; permissions: { read?: boolean; write?: boolean; admin?: boolean }; allowed_ips: string[] | null; request_count: string;
}

// ── Create modal (module scope — never nested) ────────────────
interface CreateModalProps { onClose: () => void; onCreated: (fullKey: string) => void }
function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [allowedIps, setAllowedIps] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);
  useEscape(onClose);

  const submit = async () => {
    if (!name.trim()) { toast('Name is required', 'error'); return; }
    setSaving(true);
    try {
      const res = await api('/api-keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), description: description.trim() || null,
          permissions: { read, write, admin }, allowed_ips: allowedIps.trim() || null,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      onCreated(res.key);
    } catch (e) {
      toast((e as Error).message || 'Failed to create key', 'error');
      setSaving(false);
    }
  };

  const labelStyle: React.CSSProperties = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: 24, width: 480, maxWidth: '92%', maxHeight: '90vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, marginBottom: 16 }}>Generate New API Key</div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Name *</label>
          <input className="input" style={{ width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ansible automation" autoFocus />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Description</label>
          <input className="input" style={{ width: '100%' }} value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this key used for?" />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Permissions</label>
          <div style={{ display: 'flex', gap: 16 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-base)' }}><input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)} /> Read</label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-base)' }}><input type="checkbox" checked={write} onChange={e => setWrite(e.target.checked)} /> Write</label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-base)' }}><input type="checkbox" checked={admin} onChange={e => setAdmin(e.target.checked)} /> Admin</label>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>IP Allowlist <span style={MUTED}>(comma-separated, optional)</span></label>
          <input className="input" style={INPUT_MD} value={allowedIps} onChange={e => setAllowedIps(e.target.value)} placeholder="e.g. 10.0.0.5, 10.0.0.6" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Expires <span style={MUTED}>(optional)</span></label>
          <input className="input" type="date" style={INPUT_SM} value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Generating…' : 'Generate Key'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Reveal-once modal ─────────────────────────────────────────
function RevealModal({ fullKey, onClose }: { fullKey: string; onClose: () => void }) {
  const { toast } = useToast();
  useEscape(onClose);
  const copy = () => { navigator.clipboard.writeText(fullKey).then(() => toast('Copied to clipboard', 'success')).catch(() => toast('Copy failed', 'error')); };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: 24, width: 520, maxWidth: '92%' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, marginBottom: 8 }}>API Key Created</div>
        <div style={{ fontSize: 'var(--text-base)', color: 'var(--red)', fontWeight: 600, marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Save this key now — it will never be shown again.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" readOnly value={fullKey} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }} onFocus={e => e.target.select()} />
          <button className="btn btn-primary" onClick={copy}>Copy</button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function PermBadges({ p }: { p: ApiKey['permissions'] }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {p.read && <span className="badge badge-blue">read</span>}
      {p.write && <span className="badge badge-yellow">write</span>}
      {p.admin && <span className="badge badge-red">admin</span>}
    </div>
  );
}

export function ApiKeysSection() {
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [revealKey, setRevealKey] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api('/api-keys').then(d => setKeys(d.data || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke API key "${k.name}"? Any integration using it will immediately stop working.`)) return;
    try {
      await api(`/api-keys/${k.id}`, { method: 'DELETE' });
      toast('Key revoked', 'success');
      load();
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)', gridColumn: '1 / -1' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 'var(--text-md)', fontWeight: 700 }}>API Keys</div>
          <div style={{ ...MUTED, marginTop: 2 }}>Programmatic access to the DDIVault REST API (<code style={{ fontFamily: 'var(--font-mono)' }}>/api/v1</code>). Keys are shown once at creation.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>Generate New API Key</button>
      </div>

      {loading ? (
        <div style={{ padding: 20, ...MUTED }}>Loading keys…</div>
      ) : keys.length === 0 ? (
        <div style={{ padding: '36px 20px', textAlign: 'center', ...MUTED }}>
          No API keys yet. Generate one to integrate DDIVault with your automation tools.
        </div>
      ) : (
        <table className="data-table">
          <thead><tr><th>Name</th><th>Key</th><th>Permissions</th><th>Requests</th><th>Last Used</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{k.name}</div>
                  {k.description && <div style={MUTED}>{k.description}</div>}
                </td>
                <td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{k.key_masked}</td>
                <td><PermBadges p={k.permissions || {}} /></td>
                <td className="mono">{k.request_count || 0}</td>
                <td style={{ ...MUTED }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
                <td><span className={`badge ${k.is_active ? 'badge-green' : 'badge-gray'}`}>{k.is_active ? 'active' : 'revoked'}</span></td>
                <td>{k.is_active && <button style={{ fontSize: 'var(--text-xs)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => revoke(k)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreated={(full) => { setShowCreate(false); setRevealKey(full); load(); }} />}
      {revealKey && <RevealModal fullKey={revealKey} onClose={() => setRevealKey(null)} />}
    </div>
  );
}
