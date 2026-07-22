'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
import { PageHeader, EmptyState, TableSkeleton, Spinner, useRefreshKey, useEscape } from '@/components/ui';
import { INPUT, LABEL, INPUT_MD } from '@/lib/settingsFormStyles';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface Recipient {
  id: number;
  name: string;
  email: string;
  site_id: number | null;
  role_filter: string;        // '' | 'critical' | 'warning' | 'info'
  is_active: boolean;
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
// Shared style tokens
// ════════════════════════════════════════════════════════════
const TD: React.CSSProperties = { padding: '9px 14px', fontSize: 'var(--text-base)', color: 'var(--text-primary)' };

// Severity mapping (role_filter value → friendly label)
const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: '',         label: 'All' },
  { value: 'critical', label: 'Critical only' },
  { value: 'warning',  label: 'Warning+Critical' },
  { value: 'info',     label: 'Info' },
];

function severityLabel(roleFilter: string): string {
  return SEVERITY_OPTIONS.find(o => o.value === (roleFilter || ''))?.label || 'All';
}

function siteLabel(siteId: number | null, sites: Site[]): string {
  if (siteId == null) return 'All Sites';
  return sites.find(s => s.id === siteId)?.name || `Site #${siteId}`;
}

// ════════════════════════════════════════════════════════════
// Recipient Modal — MODULE SCOPE (never nested)
// ════════════════════════════════════════════════════════════
function RecipientModal({ sites, onClose, onDone }: {
  sites: Site[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  useEscape(onClose);

  const [form, setForm] = useState({
    name: '',
    email: '',
    site_id: '',        // '' = All Sites
    role_filter: '',    // '' = All
    is_active: true,
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.email.trim()) { toast('Email is required', 'error'); return; }
    setSaving(true);
    try {
      await api('/alert-recipients', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          email: form.email.trim(),
          site_id: form.site_id ? Number(form.site_id) : null,
          role_filter: form.role_filter,
          is_active: form.is_active,
        }),
      });
      toast('Recipient added', 'success');
      onDone();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
        width: 520, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto', padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>Add Recipient</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={LABEL}>Name</label>
            <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} style={{ ...INPUT, width: '100%' }} placeholder="Network Team" />
          </div>
          <div>
            <label style={LABEL}>Email *</label>
            <input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} style={{ ...INPUT, width: '100%' }} placeholder="team@company.com" />
          </div>
          <div>
            <label style={LABEL}>Site</label>
            <select value={form.site_id} onChange={e => setForm(p => ({ ...p, site_id: e.target.value }))} style={INPUT_MD}>
              <option value="">All Sites</option>
              {sites.map(s => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}{s.code ? ` (${s.code})` : ''}{s.city ? ` · ${s.city}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={LABEL}>Severity</label>
            <select value={form.role_filter} onChange={e => setForm(p => ({ ...p, role_filter: e.target.value }))} style={INPUT_MD}>
              {SEVERITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={form.is_active} onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))} />
              Active
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving} style={{ opacity: saving ? 0.7 : 1 }}>
            {saving ? <><Spinner size={13} color="#fff" /> Saving…</> : 'Add Recipient'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN — Alert Recipients
// ════════════════════════════════════════════════════════════
export default function AlertRecipients() {
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [r, s] = await Promise.allSettled([api('/alert-recipients'), api('/sites')]);
    if (r.status === 'fulfilled') setRecipients(r.value.data || []);
    else toast(r.reason?.message || 'Failed to load recipients', 'error');
    if (s.status === 'fulfilled') setSites(s.value.data || []);
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useRefreshKey(load);

  const toggleActive = async (r: Recipient) => {
    try {
      await api(`/alert-recipients/${r.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !r.is_active }),
      });
      toast(`${r.email} ${!r.is_active ? 'enabled' : 'disabled'}`, 'success');
      load();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const del = async (r: Recipient) => {
    if (!confirm(`Remove recipient ${r.email}?`)) return;
    try {
      await api(`/alert-recipients/${r.id}`, { method: 'DELETE' });
      toast('Recipient removed', 'info');
      load();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader
        title="Alert Recipients"
        subtitle="People who receive email notifications when alerts fire"
      >
        {canWrite && <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Recipient</button>}
      </PageHeader>

      <ReadOnlyBanner />

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        {loading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : recipients.length === 0 ? (
          <EmptyState
            icon="📧"
            title="No recipients configured"
            message="Add a recipient so alerts can be delivered by email."
            actionLabel={canWrite ? '+ Add Recipient' : undefined}
            onAction={canWrite ? () => setShowAdd(true) : undefined}
          />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Sites</th>
                <th>Severity</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map(r => (
                <tr key={r.id}>
                  <td style={TD}>{r.name || '—'}</td>
                  <td style={TD}>{r.email}</td>
                  <td style={TD}>
                    <span className={`badge ${r.site_id == null ? 'badge-blue' : 'badge-purple'}`}>{siteLabel(r.site_id, sites)}</span>
                  </td>
                  <td style={TD}>{severityLabel(r.role_filter)}</td>
                  <td style={TD}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: canWrite ? 'pointer' : 'default' }}>
                      <input type="checkbox" checked={r.is_active} disabled={!canWrite} onChange={() => toggleActive(r)} />
                      <span style={{ fontSize: 'var(--text-xs)', color: r.is_active ? 'var(--green)' : 'var(--text-muted)', fontWeight: 600 }}>
                        {r.is_active ? 'Active' : 'Disabled'}
                      </span>
                    </label>
                  </td>
                  <td style={TD}>
                    {canWrite ? (
                      <button onClick={() => del(r)} style={{ fontSize: 'var(--text-xs)', color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
                        Delete
                      </button>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <RecipientModal sites={sites} onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); load(); }} />
      )}
    </div>
  );
}
