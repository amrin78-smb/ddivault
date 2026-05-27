'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';

interface Server {
  id: number;
  hostname: string;
  ip_address: string;
  role: string;
  description: string;
  is_active: boolean;
  last_polled: string;
  poll_status: string;
  poll_error: string;
  auth_mode: string;
  ps_username: string;
  winrm_port: number;
  winrm_https: boolean;
  winrm_test_ok: boolean | null;
  winrm_tested_at: string;
  notes: string;
  site_id: number | null;
  site_name: string | null;
}

const CARD: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
};
const BTN: React.CSSProperties = {
  padding: '6px 14px', border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12,
};
const BTN_RED: React.CSSProperties = { ...BTN, background: '#C8102E', color: '#fff', border: 'none' };
const INPUT: React.CSSProperties = {
  width: '100%', padding: '6px 10px', border: '1px solid var(--border)',
  borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13,
};
const LABEL: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 };

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

const AUTH_MODE_INFO: Record<string, { label: string; desc: string; color: string }> = {
  kerberos:   { label: 'Kerberos (Domain SSO)',    desc: 'Uses the Windows identity of the DDIVault service. No credentials stored. Requires DDIVault server and target to be in the same AD domain.', color: '#16a34a' },
  credential: { label: 'Stored Credentials',       desc: 'Username and password stored encrypted in the database. Required for workgroup servers, cross-domain, or when Kerberos is not available.', color: '#2563eb' },
  local:      { label: 'Local (Same Machine)',      desc: 'Runs PowerShell directly on this server. Use only if the DHCP/DNS server IS the same machine as NexVault (192.168.6.111).', color: '#7c3aed' },
};

// ── Server Form Modal ─────────────────────────────────────────
function ServerModal({ server, sites, onClose, onDone }: {
  server?: Server | null;
  sites: {id:number;name:string;code:string;city:string}[];
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!server;
  const [form, setForm] = useState({
    hostname:    server?.hostname    || '',
    ip_address:  server?.ip_address  || '',
    role:        server?.role        || 'both',
    description: server?.description || '',
    auth_mode:   server?.auth_mode   || 'kerberos',
    ps_username: server?.ps_username || '',
    ps_password: '',
    winrm_port:  String(server?.winrm_port || 5985),
    winrm_https: server?.winrm_https || false,
    notes:       server?.notes       || '',
    site_id:     server?.site_id ? String(server.site_id) : '',
  });
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const { toast } = useToast();

  const save = async () => {
    if (!form.hostname && !form.ip_address) { toast('Hostname or IP required', 'error'); return; }
    if (form.auth_mode === 'credential' && !form.ps_username) { toast('Username required for credential mode', 'error'); return; }
    setLoading(true);
    try {
      if (isEdit) {
        await api(`/servers/${server!.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        toast('Server updated', 'success');
      } else {
        await api('/servers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        toast('Server added', 'success');
      }
      onDone();
    } catch (e: any) { toast(e.message, 'error'); }
    finally { setLoading(false); }
  };

  const modeInfo = AUTH_MODE_INFO[form.auth_mode];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ ...CARD, padding: 24, width: 560, maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isEdit ? 'Edit Server' : 'Add Server to Monitor'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)' }}>×</button>
        </div>

        {/* Basic info */}
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          Server Details
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          <div>
            <label style={LABEL}>Hostname or FQDN</label>
            <input value={form.hostname} onChange={e => setForm(p => ({ ...p, hostname: e.target.value }))}
              style={INPUT} placeholder="AD-SERVER-01 or ad.company.local" />
          </div>
          <div>
            <label style={LABEL}>IP Address *</label>
            <input value={form.ip_address} onChange={e => setForm(p => ({ ...p, ip_address: e.target.value }))}
              style={INPUT} placeholder="192.168.x.x" />
          </div>
          <div>
            <label style={LABEL}>Role</label>
            <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))} style={INPUT}>
              <option value="both">DHCP + DNS</option>
              <option value="dhcp">DHCP only</option>
              <option value="dns">DNS only</option>
            </select>
          </div>
          <div>
            <label style={LABEL}>Site (from NetVault)</label>
            <select value={form.site_id} onChange={e => setForm(p => ({ ...p, site_id: e.target.value }))} style={INPUT}>
              <option value="">— No site assigned —</option>
              {sites.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.code ? ` (${s.code})` : ''}{s.city ? ` · ${s.city}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={LABEL}>Description</label>
            <input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              style={INPUT} placeholder="Primary AD / DHCP server" />
          </div>
        </div>

        {/* Auth section */}
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          PowerShell / WinRM Authentication
        </div>

        {/* Auth mode selector — card style */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {Object.entries(AUTH_MODE_INFO).map(([mode, info]) => (
            <div key={mode}
              onClick={() => setForm(p => ({ ...p, auth_mode: mode }))}
              style={{
                padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                border: `2px solid ${form.auth_mode === mode ? info.color : 'var(--border)'}`,
                background: form.auth_mode === mode ? info.color + '11' : 'var(--bg-primary)',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <div style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${info.color}`,
                  background: form.auth_mode === mode ? info.color : 'transparent', flexShrink: 0 }} />
                <div style={{ fontWeight: 600, fontSize: 13, color: form.auth_mode === mode ? info.color : 'var(--text-primary)' }}>
                  {info.label}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 22 }}>{info.desc}</div>
            </div>
          ))}
        </div>

        {/* Credential fields — only for credential mode */}
        {form.auth_mode === 'credential' && (
          <div style={{ ...CARD, padding: 14, marginBottom: 14, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#1d4ed8', marginBottom: 10 }}>Stored Credentials</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={LABEL}>Username</label>
                <input value={form.ps_username} onChange={e => setForm(p => ({ ...p, ps_username: e.target.value }))}
                  style={INPUT} placeholder="DOMAIN\svc-ddivault or admin" />
              </div>
              <div>
                <label style={LABEL}>Password {isEdit ? '(leave blank to keep current)' : '*'}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={form.ps_password}
                    onChange={e => setForm(p => ({ ...p, ps_password: e.target.value }))}
                    style={{ ...INPUT, paddingRight: 60 }}
                    placeholder={isEdit ? '••••••••' : 'Enter password'}
                  />
                  <button onClick={() => setShowPass(p => !p)}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>
                    {showPass ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#2563eb', marginTop: 8 }}>
              🔒 Password is encrypted with AES-256-GCM before storage. Never stored in plaintext.
            </div>
          </div>
        )}

        {/* WinRM settings */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
          <div>
            <label style={LABEL}>WinRM Port</label>
            <select value={form.winrm_port} onChange={e => setForm(p => ({ ...p, winrm_port: e.target.value }))} style={INPUT}>
              <option value="5985">5985 — HTTP (default)</option>
              <option value="5986">5986 — HTTPS</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={form.winrm_https} onChange={e => setForm(p => ({ ...p, winrm_https: e.target.checked }))} />
              Use HTTPS / SSL
            </label>
          </div>
          <div>
            <label style={LABEL}>Notes</label>
            <input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} style={INPUT} placeholder="Optional" />
          </div>
        </div>

        {/* WinRM setup guide */}
        <details style={{ marginBottom: 16 }}>
          <summary style={{ fontSize: 12, color: '#2563eb', cursor: 'pointer', fontWeight: 500 }}>
            ▶ WinRM setup commands (run on the target server as Administrator)
          </summary>
          <pre style={{ fontSize: 11, background: '#1e293b', color: '#e2e8f0', padding: 12, borderRadius: 6, marginTop: 8, overflow: 'auto', lineHeight: 1.6 }}>
{`# On the DHCP/DNS server:
Enable-PSRemoting -Force
Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value "192.168.6.111" -Force
Set-NetFirewallRule -Name "WINRM-HTTP-In-TCP-PUBLIC" -Enabled True

# Test from NexVault server (192.168.6.111):
Test-WSMan -ComputerName ${form.ip_address || '<SERVER-IP>'}
Invoke-Command -ComputerName ${form.ip_address || '<SERVER-IP>'} -ScriptBlock { hostname }`}
          </pre>
        </details>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={BTN}>Cancel</button>
          <button onClick={save} disabled={loading} style={{ ...BTN_RED, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Server'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN KNOWN SERVERS TAB
// ════════════════════════════════════════════════════════════
export default function ServersTab() {
  const [servers, setServers]     = useState<Server[]>([]);
  const [sites, setSites]         = useState<{id:number;name:string;code:string;city:string}[]>([]);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [showAdd, setShowAdd]     = useState(false);
  const [testing, setTesting]     = useState<Record<number, boolean>>({});
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; latency_ms: number | null; error: string | null }>>({});
  const { toast } = useToast();

  const load = useCallback(async () => {
    const [d, s] = await Promise.allSettled([
      api('/servers'),
      api('/sites'),
    ]);
    if (d.status === 'fulfilled') setServers(d.value.data || []);
    if (s.status === 'fulfilled') setSites(s.value.data || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const del = async (id: number) => {
    if (!confirm('Remove this server? DHCP/DNS data collected from it will be preserved.')) return;
    await api(`/servers/${id}`, { method: 'DELETE' });
    toast('Server removed', 'info');
    load();
  };

  const testConnection = async (server: Server) => {
    setTesting(p => ({ ...p, [server.id]: true }));
    toast(`Testing connection to ${server.hostname || server.ip_address}...`, 'info');
    try {
      const d = await api(`/servers/${server.id}/test-connection`, { method: 'POST' });
      setTestResults(p => ({ ...p, [server.id]: d }));
      if (d.ok) {
        toast(`✓ Connected to ${server.ip_address} via ${d.auth_mode} (${d.latency_ms}ms)`, 'success');
      } else {
        toast(`✗ Failed: ${d.error}`, 'error');
      }
      load(); // refresh winrm_test_ok
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setTesting(p => ({ ...p, [server.id]: false }));
    }
  };

  const authBadgeColor = (mode: string) => {
    const m: Record<string, string> = { kerberos: '#16a34a', credential: '#2563eb', local: '#7c3aed' };
    return m[mode] || '#6b7280';
  };

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>Known Servers</h2>
        <button onClick={() => setShowAdd(true)} style={BTN_RED}>+ Add Server</button>
      </div>

      {/* Auth method legend */}
      <div style={{ ...CARD, padding: '10px 16px', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, alignSelf: 'center' }}>AUTH METHODS:</div>
        {Object.entries(AUTH_MODE_INFO).map(([mode, info]) => (
          <div key={mode} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: info.color }} />
            <span style={{ color: info.color, fontWeight: 600 }}>{mode}</span>
            <span style={{ color: 'var(--text-muted)' }}>— {info.label}</span>
          </div>
        ))}
      </div>

      {/* Server cards */}
      {servers.length === 0 ? (
        <div style={{ ...CARD, padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          No servers configured yet.<br />
          <span style={{ fontSize: 12 }}>Click + Add Server to begin monitoring your DHCP/DNS infrastructure.</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {servers.map(s => {
            const testResult = testResults[s.id];
            const isTesting  = testing[s.id];
            const color      = authBadgeColor(s.auth_mode);

            return (
              <div key={s.id} style={{ ...CARD, padding: '14px 18px', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                {/* Status dot */}
                <div style={{ paddingTop: 4 }}>
                  <div style={{
                    width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                    background: s.winrm_test_ok === true ? '#16a34a' : s.winrm_test_ok === false ? '#dc2626' : '#94a3b8',
                    boxShadow: s.winrm_test_ok === true ? '0 0 6px #16a34a' : 'none',
                  }} title={s.winrm_test_ok === true ? 'WinRM OK' : s.winrm_test_ok === false ? 'WinRM failed' : 'Not tested'} />
                </div>

                {/* Main info */}
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{s.hostname || s.ip_address}</div>
                    <code style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-primary)', padding: '1px 6px', borderRadius: 4 }}>
                      {s.ip_address}
                    </code>
                    <span className={`badge ${s.role === 'both' ? 'badge-blue' : 'badge-gray'}`}>{s.role}</span>
                    <span className={`badge ${s.is_active ? 'badge-green' : 'badge-gray'}`}>{s.is_active ? 'Active' : 'Disabled'}</span>
                  </div>

                  {/* Auth info row */}
                  <div style={{ display: 'flex', gap: 12, fontSize: 11, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
                      <span style={{ color, fontWeight: 600 }}>{AUTH_MODE_INFO[s.auth_mode]?.label || s.auth_mode}</span>
                    </div>
                    {s.auth_mode === 'credential' && s.ps_username && (
                      <span style={{ color: 'var(--text-muted)' }}>👤 {s.ps_username}</span>
                    )}
                    <span style={{ color: 'var(--text-muted)' }}>
                      WinRM: {s.winrm_port || 5985}{s.winrm_https ? ' (HTTPS)' : ' (HTTP)'}
                    </span>
                    {s.description && <span style={{ color: 'var(--text-muted)' }}>· {s.description}</span>}
                    {s.site_name && <span style={{ color: 'var(--text-muted)' }}>· 📍 {s.site_name}</span>}
                  </div>

                  {/* Poll status */}
                  {s.poll_error && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#dc2626', background: '#fee2e2', padding: '4px 8px', borderRadius: 4 }}>
                      ⚠ {s.poll_error}
                    </div>
                  )}

                  {/* Test result */}
                  {testResult && (
                    <div style={{ marginTop: 6, fontSize: 11, padding: '4px 8px', borderRadius: 4,
                      background: testResult.ok ? '#dcfce7' : '#fee2e2',
                      color: testResult.ok ? '#15803d' : '#b91c1c' }}>
                      {testResult.ok
                        ? `✓ WinRM connected successfully (${testResult.latency_ms}ms)`
                        : `✗ Connection failed: ${testResult.error}`}
                    </div>
                  )}

                  {/* Last polled */}
                  <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                    {s.last_polled ? `Last polled: ${new Date(s.last_polled).toLocaleString()}` : 'Never polled'}
                    {s.winrm_tested_at ? ` · Last tested: ${new Date(s.winrm_tested_at).toLocaleString()}` : ''}
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexDirection: 'column', alignItems: 'flex-end' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => testConnection(s)}
                      disabled={isTesting}
                      style={{ ...BTN, fontSize: 11, background: isTesting ? 'var(--bg-primary)' : 'var(--bg-card)' }}
                    >
                      {isTesting ? '⟳ Testing...' : '⚡ Test Connection'}
                    </button>
                    <button onClick={() => setEditServer(s)} style={{ ...BTN, fontSize: 11 }}>Edit</button>
                    <button onClick={() => del(s.id)} style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Remove</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showAdd    && <ServerModal sites={sites} onClose={() => setShowAdd(false)}    onDone={() => { setShowAdd(false);    load(); }} />}
      {editServer && <ServerModal sites={sites} server={editServer} onClose={() => setEditServer(null)} onDone={() => { setEditServer(null); load(); }} />}
    </div>
  );
}
