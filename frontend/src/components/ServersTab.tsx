'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';
import {
  PageHeader, EmptyState, CardSkeleton, Spinner, useRefreshKey, useEscape,
} from '@/components/ui';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
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
  // DNS platform (1.37.0). 'windows' for every pre-existing server.
  dns_platform?: string;
  dns_host?: string | null;
  dns_port?: number | null;
  tsig_key_name?: string | null;
  tsig_algorithm?: string | null;
  dns_stats_url?: string | null;
  dns_api_url?: string | null;
  dns_api_server_id?: string | null;
  dns_last_error?: string | null;
  dns_capabilities?: Record<string, string> | null;
  // The secrets themselves never leave the server; these say whether one exists.
  has_tsig_secret?: boolean;
  has_dns_api_key?: boolean;
}

// What each platform means, and what it needs configured.
const DNS_PLATFORM_INFO: Record<string, { label: string; color: string; desc: string }> = {
  windows: {
    label: 'Windows DNS',
    color: 'var(--blue)',
    desc: 'Collected over WinRM with the DNS Server PowerShell module. Supports scavenging, aging and AD-integrated zones.',
  },
  bind: {
    label: 'BIND 9',
    color: 'var(--green)',
    desc: 'Zones and records over AXFR with a TSIG key; zone list and query statistics from the statistics-channel. No shell access needed.',
  },
  powerdns: {
    label: 'PowerDNS',
    color: 'var(--purple)',
    desc: 'Zones, records and statistics over the Authoritative REST API using an API key. No zone transfer required.',
  },
};

interface Site { id: number; name: string; code: string; city: string }

interface TestResult { ok: boolean; latency_ms: number | null; error: string | null; auth_mode?: string }

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
const INPUT: React.CSSProperties = {
  width: '100%', padding: '8px 11px', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', background: 'var(--bg-primary)',
  color: 'var(--text-primary)', fontSize: 'var(--text-base)', fontFamily: 'inherit', outline: 'none',
};
const LABEL: React.CSSProperties = {
  fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4, fontWeight: 500,
};
const SECTION_HEADER: React.CSSProperties = {
  fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
};

const AUTH_MODE_INFO: Record<string, { label: string; desc: string; color: string }> = {
  kerberos:   { label: 'Kerberos (Domain SSO)',   desc: 'Uses the Windows identity of the DDIVault service. No credentials stored. Requires DDIVault server and target to be in the same AD domain.', color: 'var(--green)' },
  credential: { label: 'Stored Credentials',      desc: 'Username and password stored encrypted in the database. Required for workgroup servers, cross-domain, or when Kerberos is not available.', color: 'var(--blue)' },
  local:      { label: 'Local (Same Machine)',    desc: 'Runs PowerShell directly on this server. Use only if the DHCP/DNS server IS the same machine as this NocVault server.', color: 'var(--purple)' },
};

function authColor(mode: string): string {
  return AUTH_MODE_INFO[mode]?.color || 'var(--text-muted)';
}

function dotColor(ok: boolean | null): string {
  return ok === true ? 'var(--green)' : ok === false ? 'var(--red)' : '#94a3b8';
}

// ════════════════════════════════════════════════════════════
// Server Form Modal — MODULE SCOPE (never nested)
// ════════════════════════════════════════════════════════════
function ServerModal({ server, sites, onClose, onDone }: {
  server?: Server | null;
  sites: Site[];
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!server;
  const { toast } = useToast();
  useEscape(onClose);

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
    dns_platform: server?.dns_platform || 'windows',
    dns_host:     server?.dns_host     || '',
    dns_port:     String(server?.dns_port || 53),
    tsig_key_name:  server?.tsig_key_name  || '',
    tsig_algorithm: server?.tsig_algorithm || 'hmac-sha256',
    // Secrets start blank and are only sent when actually typed. The API reads
    // an empty value as "unchanged" (see api/serverFields.js), so saving any
    // other field cannot wipe a stored key.
    tsig_secret:  '',
    dns_stats_url: server?.dns_stats_url || '',
    dns_api_url:   server?.dns_api_url   || '',
    dns_api_key:   '',
    dns_api_server_id: server?.dns_api_server_id || 'localhost',
  });
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
          padding: 24, width: 580, maxWidth: '94vw', maxHeight: '92vh', overflow: 'auto',
        }}
      >
        {/* Modal header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>
            {isEdit ? 'Edit Server' : 'Add Server to Monitor'}
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xl)', lineHeight: 1, color: 'var(--text-muted)' }}>
            ×
          </button>
        </div>

        {/* Server details */}
        <div style={SECTION_HEADER}>Server Details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
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
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Description</label>
            <input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              style={INPUT} placeholder="Primary AD / DHCP server" />
          </div>
        </div>

        {/* DNS platform */}
        <div style={SECTION_HEADER}>DNS Platform</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {Object.entries(DNS_PLATFORM_INFO).map(([plat, info]) => {
            const selected = form.dns_platform === plat;
            return (
              <div key={plat}
                onClick={() => setForm(p => ({ ...p, dns_platform: plat }))}
                style={{
                  padding: '11px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  border: `2px solid ${selected ? info.color : 'var(--border)'}`,
                  background: selected ? `color-mix(in srgb, ${info.color} 8%, var(--bg-card))` : 'var(--bg-primary)',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
                  <div style={{
                    width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${info.color}`,
                    background: selected ? info.color : 'transparent',
                    boxShadow: selected ? `inset 0 0 0 2px var(--bg-card)` : 'none',
                  }} />
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-base)', color: selected ? info.color : 'var(--text-primary)' }}>
                    {info.label}
                  </div>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', paddingLeft: 24, lineHeight: 1.5 }}>{info.desc}</div>
              </div>
            );
          })}
        </div>

        {/* Linux / third-party DNS settings */}
        {form.dns_platform !== 'windows' && (
          <div style={{
            padding: 14, marginBottom: 16, borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in srgb, var(--green) 7%, var(--bg-card))',
            border: '1px solid color-mix(in srgb, var(--green) 30%, var(--bg-card))',
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={LABEL}>DNS host / IP {form.ip_address ? '(blank = use the server IP above)' : ''}</label>
                <input value={form.dns_host} onChange={e => setForm(p => ({ ...p, dns_host: e.target.value }))}
                  style={INPUT} placeholder={form.ip_address || '10.0.0.53'} />
              </div>
              <div>
                <label style={LABEL}>DNS port</label>
                <input value={form.dns_port} onChange={e => setForm(p => ({ ...p, dns_port: e.target.value }))}
                  style={INPUT} placeholder="53" />
              </div>
            </div>

            {form.dns_platform === 'bind' && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={LABEL}>TSIG key name</label>
                    <input value={form.tsig_key_name} onChange={e => setForm(p => ({ ...p, tsig_key_name: e.target.value }))}
                      style={INPUT} placeholder="ddivault" />
                  </div>
                  <div>
                    <label style={LABEL}>TSIG algorithm</label>
                    <select value={form.tsig_algorithm} onChange={e => setForm(p => ({ ...p, tsig_algorithm: e.target.value }))} style={INPUT}>
                      <option value="hmac-sha256">hmac-sha256</option>
                      <option value="hmac-sha512">hmac-sha512</option>
                      <option value="hmac-sha384">hmac-sha384</option>
                      <option value="hmac-sha224">hmac-sha224</option>
                      <option value="hmac-sha1">hmac-sha1</option>
                    </select>
                  </div>
                  <div>
                    <label style={LABEL}>TSIG secret {server?.has_tsig_secret ? '(leave blank to keep current)' : ''}</label>
                    <input type="password" value={form.tsig_secret}
                      onChange={e => setForm(p => ({ ...p, tsig_secret: e.target.value }))}
                      style={INPUT} placeholder={server?.has_tsig_secret ? '••••••••' : 'base64 secret'} />
                  </div>
                </div>
                <div>
                  <label style={LABEL}>Statistics-channel URL</label>
                  <input value={form.dns_stats_url} onChange={e => setForm(p => ({ ...p, dns_stats_url: e.target.value }))}
                    style={INPUT} placeholder="http://10.0.0.53:8653" />
                </div>
                <details style={{ marginTop: 10 }}>
                  <summary style={{ fontSize: 'var(--text-sm)', color: 'var(--green)', cursor: 'pointer', fontWeight: 600 }}>
                    ▶ named.conf settings this needs
                  </summary>
                  <pre style={{ fontSize: 'var(--text-xs)', background: 'var(--navy)', color: '#e2e8f0', padding: 12, borderRadius: 'var(--radius-sm)', marginTop: 8, overflow: 'auto', lineHeight: 1.6 }}>
{`// Statistics channel — needed to list zones and read query stats
statistics-channels { inet 0.0.0.0 port 8653 allow { <NOCVAULT-IP>; }; };

key "${form.tsig_key_name || 'ddivault'}" {
    algorithm ${form.tsig_algorithm};
    secret "<the base64 secret you entered above>";
};

// Per zone you want DDIVault to read:
zone "example.com" {
    // ...
    allow-transfer { key "${form.tsig_key_name || 'ddivault'}"; };
};`}
                  </pre>
                </details>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--green)', marginTop: 8 }}>
                  🔒 The TSIG secret is encrypted with AES-256-GCM before storage. DDIVault only ever reads — it never writes to your DNS.
                </div>
              </>
            )}

            {form.dns_platform === 'powerdns' && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={LABEL}>API URL</label>
                    <input value={form.dns_api_url} onChange={e => setForm(p => ({ ...p, dns_api_url: e.target.value }))}
                      style={INPUT} placeholder="http://10.0.0.53:8081" />
                  </div>
                  <div>
                    <label style={LABEL}>API key {server?.has_dns_api_key ? '(leave blank to keep)' : ''}</label>
                    <input type="password" value={form.dns_api_key}
                      onChange={e => setForm(p => ({ ...p, dns_api_key: e.target.value }))}
                      style={INPUT} placeholder={server?.has_dns_api_key ? '••••••••' : 'X-API-Key'} />
                  </div>
                  <div>
                    <label style={LABEL}>Server ID</label>
                    <input value={form.dns_api_server_id} onChange={e => setForm(p => ({ ...p, dns_api_server_id: e.target.value }))}
                      style={INPUT} placeholder="localhost" />
                  </div>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--green)', marginTop: 8 }}>
                  🔒 The API key is encrypted with AES-256-GCM before storage. Enable the API with
                  {' '}<code>api=yes</code>, <code>api-key=...</code> and <code>webserver=yes</code> in pdns.conf.
                </div>
              </>
            )}

            <div style={{ marginTop: 10 }}>
              <label style={LABEL}>Notes</label>
              <input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} style={INPUT} placeholder="Optional" />
            </div>
          </div>
        )}

        {/* PowerShell/WinRM only applies to Windows DNS — hidden entirely for the
            others rather than shown greyed out, because there is nothing a BIND
            operator could usefully put in these fields. */}
        {form.dns_platform === 'windows' && (<>
        {/* Auth section */}
        <div style={SECTION_HEADER}>PowerShell / WinRM Authentication</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {Object.entries(AUTH_MODE_INFO).map(([mode, info]) => {
            const selected = form.auth_mode === mode;
            return (
              <div key={mode}
                onClick={() => setForm(p => ({ ...p, auth_mode: mode }))}
                style={{
                  padding: '11px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  border: `2px solid ${selected ? info.color : 'var(--border)'}`,
                  background: selected ? `color-mix(in srgb, ${info.color} 8%, var(--bg-card))` : 'var(--bg-primary)',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
                  <div style={{
                    width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${info.color}`,
                    background: selected ? info.color : 'transparent',
                    boxShadow: selected ? `inset 0 0 0 2px var(--bg-card)` : 'none',
                  }} />
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-base)', color: selected ? info.color : 'var(--text-primary)' }}>
                    {info.label}
                  </div>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', paddingLeft: 24, lineHeight: 1.5 }}>{info.desc}</div>
              </div>
            );
          })}
        </div>

        {/* Credential fields */}
        {form.auth_mode === 'credential' && (
          <div style={{
            padding: 14, marginBottom: 16, borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in srgb, var(--blue) 7%, var(--bg-card))',
            border: '1px solid color-mix(in srgb, var(--blue) 30%, var(--bg-card))',
          }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--blue)', marginBottom: 10 }}>Stored Credentials</div>
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
                    style={{ ...INPUT, paddingRight: 56 }}
                    placeholder={isEdit ? '••••••••' : 'Enter password'}
                  />
                  <button type="button" onClick={() => setShowPass(p => !p)}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--blue)' }}>
                    {showPass ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--blue)', marginTop: 8 }}>
              🔒 Password is encrypted with AES-256-GCM before storage. Never stored in plaintext.
            </div>
          </div>
        )}

        {/* WinRM settings */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 18, alignItems: 'end' }}>
          <div>
            <label style={LABEL}>WinRM Port</label>
            <select value={form.winrm_port} onChange={e => setForm(p => ({ ...p, winrm_port: e.target.value }))} style={INPUT}>
              <option value="5985">5985 — HTTP (default)</option>
              <option value="5986">5986 — HTTPS</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', paddingBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
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
        <details style={{ marginBottom: 18 }}>
          <summary style={{ fontSize: 'var(--text-sm)', color: 'var(--blue)', cursor: 'pointer', fontWeight: 600 }}>
            ▶ WinRM setup commands (run on the target server as Administrator)
          </summary>
          <pre style={{ fontSize: 'var(--text-xs)', background: 'var(--navy)', color: '#e2e8f0', padding: 12, borderRadius: 'var(--radius-sm)', marginTop: 8, overflow: 'auto', lineHeight: 1.6 }}>
{`# On the DHCP/DNS server:
Enable-PSRemoting -Force
Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value "<NOCVAULT-SERVER-IP>" -Force
Set-NetFirewallRule -Name "WINRM-HTTP-In-TCP-PUBLIC" -Enabled True

# Test from the NocVault server:
Test-WSMan -ComputerName ${form.ip_address || '<SERVER-IP>'}
Invoke-Command -ComputerName ${form.ip_address || '<SERVER-IP>'} -ScriptBlock { hostname }`}
          </pre>
        </details>
        </>)}

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={loading} style={{ opacity: loading ? 0.7 : 1 }}>
            {loading ? <><Spinner size={13} color="#fff" /> Saving…</> : isEdit ? 'Save Changes' : 'Add Server'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Server Card — MODULE SCOPE (never nested)
// ════════════════════════════════════════════════════════════
function ServerCard({ s, testing, testResult, onTest, onEdit, onDelete }: {
  s: Server;
  testing: boolean;
  testResult?: TestResult;
  onTest: (s: Server) => void;
  onEdit: (s: Server) => void;
  onDelete: (id: number) => void;
}) {
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;
  const aColor = authColor(s.auth_mode);
  const ok = s.winrm_test_ok;

  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
      padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{
          width: 11, height: 11, borderRadius: '50%', flexShrink: 0,
          background: dotColor(ok),
          boxShadow: ok === true ? `0 0 7px ${dotColor(ok)}` : 'none',
        }} title={ok === true ? 'WinRM OK' : ok === false ? 'WinRM failed' : 'Not tested'} />
        <div style={{ fontWeight: 700, fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>{s.hostname || s.ip_address}</div>
        <code className="mono" style={{ color: 'var(--text-secondary)', background: 'var(--bg-primary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
          {s.ip_address}
        </code>
        <span className={`badge ${s.role === 'both' ? 'badge-blue' : 'badge-gray'}`}>{s.role}</span>
        <span className={`badge ${s.is_active ? 'badge-green' : 'badge-gray'}`}>{s.is_active ? 'Active' : 'Disabled'}</span>
        {s.site_name && <span className="badge badge-purple">📍 {s.site_name}</span>}
      </div>

      {/* Info grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: 'var(--text-muted)', minWidth: 78 }}>Auth mode</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: aColor, display: 'inline-block' }} />
            <span style={{ color: aColor, fontWeight: 600 }}>{AUTH_MODE_INFO[s.auth_mode]?.label || s.auth_mode}</span>
          </span>
        </div>
        {s.auth_mode === 'credential' && s.ps_username && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 78 }}>Username</span>
            <span style={{ color: 'var(--text-secondary)' }}>👤 {s.ps_username}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: 'var(--text-muted)', minWidth: 78 }}>WinRM</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            Port {s.winrm_port || 5985} · {s.winrm_https ? 'HTTPS' : 'HTTP'}
          </span>
        </div>
        {s.description && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 78 }}>Description</span>
            <span style={{ color: 'var(--text-secondary)' }}>{s.description}</span>
          </div>
        )}
      </div>

      {/* Poll error */}
      {s.poll_error && (
        <div style={{
          fontSize: 'var(--text-xs)', color: 'var(--red)',
          background: 'color-mix(in srgb, var(--red) 9%, var(--bg-card))',
          border: '1px solid color-mix(in srgb, var(--red) 25%, var(--bg-card))',
          padding: '7px 10px', borderRadius: 'var(--radius-sm)',
        }}>
          ⚠ {s.poll_error}
        </div>
      )}

      {/* Test result (inline) */}
      {testResult && (
        <div style={{
          fontSize: 'var(--text-xs)', padding: '7px 10px', borderRadius: 'var(--radius-sm)',
          background: testResult.ok
            ? 'color-mix(in srgb, var(--green) 12%, var(--bg-card))'
            : 'color-mix(in srgb, var(--red) 10%, var(--bg-card))',
          color: testResult.ok ? 'var(--green)' : 'var(--red)',
          fontWeight: 600,
        }}>
          {testResult.ok
            ? `✓ WinRM connected successfully${testResult.latency_ms != null ? ` (${testResult.latency_ms}ms)` : ''}`
            : `✗ Connection failed: ${testResult.error}`}
        </div>
      )}

      {/* Timestamps */}
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        {s.last_polled ? `Last polled: ${new Date(s.last_polled).toLocaleString()}` : 'Never polled'}
        {s.winrm_tested_at ? ` · Last tested: ${new Date(s.winrm_tested_at).toLocaleString()}` : ''}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto', paddingTop: 4, borderTop: '1px solid var(--border-light)' }}>
        <button
          className="btn btn-navy"
          onClick={() => onTest(s)}
          disabled={testing}
          style={{ fontSize: 'var(--text-sm)', opacity: testing ? 0.8 : 1 }}
        >
          {testing ? <><Spinner size={13} color="#fff" /> Testing…</> : <>⚡ Test Connection</>}
        </button>
        {canWrite && (
          <button className="btn" onClick={() => onEdit(s)} style={{ fontSize: 'var(--text-sm)' }}>Edit</button>
        )}
        {canWrite && (
          <button
            className="btn"
            onClick={() => onDelete(s.id)}
            style={{ fontSize: 'var(--text-sm)', color: 'var(--red)', marginLeft: 'auto' }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN — Known Servers Tab
// ════════════════════════════════════════════════════════════
export default function ServersTab() {
  const [servers, setServers] = useState<Server[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [testing, setTesting] = useState<Record<number, boolean>>({});
  const [testResults, setTestResults] = useState<Record<number, TestResult>>({});
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  const load = useCallback(async () => {
    const [d, s] = await Promise.allSettled([api('/servers'), api('/sites')]);
    if (d.status === 'fulfilled') setServers(d.value.data || []);
    if (s.status === 'fulfilled') setSites(s.value.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useRefreshKey(load);

  const del = async (id: number) => {
    if (!confirm('Remove this server? DHCP/DNS data collected from it will be preserved.')) return;
    try {
      await api(`/servers/${id}`, { method: 'DELETE' });
      toast('Server removed', 'info');
      load();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const testConnection = async (server: Server) => {
    setTesting(p => ({ ...p, [server.id]: true }));
    toast(`Testing connection to ${server.hostname || server.ip_address}…`, 'info');
    try {
      const d: TestResult = await api(`/servers/${server.id}/test-connection`, { method: 'POST' });
      setTestResults(p => ({ ...p, [server.id]: d }));
      if (d.ok) {
        toast(`✓ Connected to ${server.ip_address} via ${d.auth_mode}${d.latency_ms != null ? ` (${d.latency_ms}ms)` : ''}`, 'success');
      } else {
        toast(`✗ Failed: ${d.error}`, 'error');
      }
      load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setTesting(p => ({ ...p, [server.id]: false }));
    }
  };

  const total = servers.length;
  const okCount = servers.filter(s => s.winrm_test_ok === true).length;
  const failCount = servers.filter(s => s.winrm_test_ok === false).length;
  const untestedCount = servers.filter(s => s.winrm_test_ok == null).length;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="Known Servers"
        subtitle="DHCP and DNS servers monitored via WinRM / PowerShell remoting"
      >
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Server</button>
        )}
      </PageHeader>

      <ReadOnlyBanner />

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        <div className="kpi-card" style={{ borderLeftColor: 'var(--navy)' }}>
          <div className="stat-value" style={{ fontSize: 'var(--text-2xl)' }}>{total}</div>
          <div className="stat-label">Total Servers</div>
        </div>
        <div className="kpi-card" style={{ borderLeftColor: 'var(--green)' }}>
          <div className="stat-value" style={{ fontSize: 'var(--text-2xl)', color: 'var(--green)' }}>{okCount}</div>
          <div className="stat-label">WinRM OK</div>
        </div>
        <div className="kpi-card" style={{ borderLeftColor: 'var(--red)' }}>
          <div className="stat-value" style={{ fontSize: 'var(--text-2xl)', color: 'var(--red)' }}>{failCount}</div>
          <div className="stat-label">WinRM Failed</div>
        </div>
        <div className="kpi-card" style={{ borderLeftColor: '#94a3b8' }}>
          <div className="stat-value" style={{ fontSize: 'var(--text-2xl)', color: 'var(--text-muted)' }}>{untestedCount}</div>
          <div className="stat-label">Not Tested</div>
        </div>
      </div>

      {/* Auth legend */}
      <div style={{
        display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center',
        padding: '8px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
      }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Auth methods</span>
        {Object.entries(AUTH_MODE_INFO).map(([mode, info]) => (
          <span key={mode} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: info.color }} />
            <span style={{ color: info.color, fontWeight: 600 }}>{mode}</span>
            <span style={{ color: 'var(--text-muted)' }}>— {info.label}</span>
          </span>
        ))}
      </div>

      {/* Body */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
          <CardSkeleton count={4} height={120} />
        </div>
      ) : servers.length === 0 ? (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <EmptyState
            icon="🖥️"
            title="No servers configured"
            message="Add your first DHCP/DNS server to start monitoring."
            actionLabel={canWrite ? '+ Add Server' : undefined}
            onAction={canWrite ? () => setShowAdd(true) : undefined}
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
          {servers.map(s => (
            <ServerCard
              key={s.id}
              s={s}
              testing={!!testing[s.id]}
              testResult={testResults[s.id]}
              onTest={testConnection}
              onEdit={setEditServer}
              onDelete={del}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {showAdd && (
        <ServerModal sites={sites} onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); load(); }} />
      )}
      {editServer && (
        <ServerModal sites={sites} server={editServer} onClose={() => setEditServer(null)} onDone={() => { setEditServer(null); load(); }} />
      )}
    </div>
  );
}
