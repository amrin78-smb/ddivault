'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
import { PageHeader, Spinner, useRefreshKey } from '@/components/ui';
import { INPUT, LABEL, INPUT_SM, FORM_ROW, FIELD_GROW, FIELD_FIXED } from '@/lib/settingsFormStyles';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from_email: string;
  from_name: string;
  enabled: boolean;
  password_set?: boolean;
}

interface TestResult {
  ok: boolean;
  error?: string | null;
}

// Where the transport actually comes from. 'hub' means the NetVault hub holds
// one SMTP server for the whole suite and this app sends through it; the fields
// below then stay as the fallback used if the hub transport is switched off.
type SmtpSource = 'hub' | 'local';

// Password-free summary of the hub transport, for display only.
interface HubSummary {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from_email: string;
  from_name: string;
  allow_self_signed: boolean;
}

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
const SECTION_HEADER: React.CSSProperties = {
  fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12,
};

const PASSWORD_PLACEHOLDER = '********';

// Calm informational note — tokenized so it flips with the theme.
const NOTE: React.CSSProperties = {
  background: 'var(--tint-info)',
  color: 'var(--tint-info-fg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '12px 14px',
  fontSize: 'var(--text-base)',
  lineHeight: 1.55,
  marginBottom: 18,
};

// Small "Fallback" marker beside a section header whose fields are no longer
// the active transport.
const TAG: React.CSSProperties = {
  marginLeft: 8,
  padding: '2px 7px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-subtle)',
  color: 'var(--text-muted)',
  fontSize: 'var(--text-xs)',
  fontWeight: 600,
  letterSpacing: 0,
  textTransform: 'none',
};

const EMPTY: SmtpConfig = {
  host: '', port: 587, secure: false, username: '', password: '',
  from_email: '', from_name: '', enabled: false, password_set: false,
};

// ════════════════════════════════════════════════════════════
// MAIN — SMTP Settings
// ════════════════════════════════════════════════════════════
export default function SmtpSettings() {
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  const [form, setForm] = useState<SmtpConfig>(EMPTY);
  const [passwordSet, setPasswordSet] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [source, setSource] = useState<SmtpSource>('local');
  const [hub, setHub] = useState<HubSummary | null>(null);

  const set = <K extends keyof SmtpConfig>(k: K, v: SmtpConfig[K]) =>
    setForm(p => ({ ...p, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api('/smtp');
      const data: SmtpConfig | null = d.data || null;
      setSource(d.source === 'hub' ? 'hub' : 'local');
      setHub(d.hub || null);
      if (data) {
        const hasPassword = !!data.password_set || !!data.password;
        setForm({
          host: data.host || '',
          port: data.port != null ? Number(data.port) : 587,
          secure: !!data.secure,
          username: data.username || '',
          password: hasPassword ? PASSWORD_PLACEHOLDER : '',
          from_email: data.from_email || '',
          from_name: data.from_name || '',
          enabled: !!data.enabled,
        });
        setPasswordSet(hasPassword);
      } else {
        setForm(EMPTY);
        setPasswordSet(false);
      }
      setPasswordTouched(false);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useRefreshKey(load);

  const save = async () => {
    if (!form.host.trim()) { toast('SMTP host is required', 'error'); return; }
    setSaving(true);
    try {
      // Only send a new password if the user typed one. Otherwise send the
      // placeholder so the backend keeps the existing stored password.
      const password = passwordTouched ? form.password : (passwordSet ? PASSWORD_PLACEHOLDER : '');
      await api('/smtp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: form.host,
          port: Number(form.port) || 0,
          secure: form.secure,
          username: form.username,
          password,
          from_email: form.from_email,
          from_name: form.from_name,
          enabled: form.enabled,
        }),
      });
      toast('SMTP settings saved', 'success');
      load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!testTo.trim()) { toast('Enter a recipient email for the test', 'error'); return; }
    setTesting(true);
    try {
      const d: TestResult = await api('/smtp/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      if (d.ok) toast(`Test email sent to ${testTo.trim()}`, 'success');
      else toast(`Test failed: ${d.error || 'Unknown error'}`, 'error');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const busy = saving || testing;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader
        title="SMTP / Email"
        subtitle={source === 'hub'
          ? 'Outbound mail is sent through the NetVault suite mail server'
          : 'Outbound mail server used to deliver alert notifications'}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-sm)', fontWeight: 600 }}>
          <span style={{
            width: 10, height: 10, borderRadius: '50%',
            background: form.enabled ? 'var(--green)' : '#94a3b8',
            boxShadow: form.enabled ? '0 0 7px var(--green)' : 'none',
          }} />
          <span style={{ color: form.enabled ? 'var(--green)' : 'var(--text-muted)' }}>
            {form.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </span>
      </PageHeader>

      <ReadOnlyBanner />

      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)', padding: 22, maxWidth: 720,
      }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>
            <Spinner /> Loading SMTP settings…
          </div>
        ) : (
          <>
            {source === 'hub' && (
              <div style={NOTE}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Mail server managed centrally</div>
                Alerts and scheduled reports are delivered through the suite mail server configured
                in NetVault{hub?.host ? <> (<span style={{ fontFamily: 'var(--font-mono)' }}>{hub.host}:{hub.port}</span>)</> : null}.
                The server and authentication fields below are kept as the fallback and are used
                again if the central mail server is switched off. The sender identity and the
                delivery switch stay with DDIVault.
              </div>
            )}

            <div style={SECTION_HEADER}>
              Server{source === 'hub' && <span style={TAG}>Fallback</span>}
            </div>
            <div style={{ ...FORM_ROW, gap: 12, marginBottom: 16 }}>
              <div style={FIELD_GROW}>
                <label style={LABEL}>SMTP Host *</label>
                <input value={form.host} onChange={e => set('host', e.target.value)}
                  style={{ ...INPUT, width: '100%' }} placeholder="smtp.office365.com" disabled={!canWrite} />
              </div>
              <div style={FIELD_FIXED}>
                <label style={LABEL}>Port</label>
                <input type="number" value={form.port}
                  onChange={e => set('port', e.target.value === '' ? 0 : Number(e.target.value))}
                  style={INPUT_SM} placeholder="587" disabled={!canWrite} />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: canWrite ? 'pointer' : 'default', fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
                <input type="checkbox" checked={form.secure} onChange={e => set('secure', e.target.checked)} disabled={!canWrite} />
                Use TLS / SSL (secure connection)
              </label>
            </div>

            <div style={SECTION_HEADER}>
              Authentication{source === 'hub' && <span style={TAG}>Fallback</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <label style={LABEL}>Username</label>
                <input value={form.username} onChange={e => set('username', e.target.value)}
                  style={{ ...INPUT, width: '100%' }} placeholder="alerts@company.com" disabled={!canWrite} />
              </div>
              <div>
                <label style={LABEL}>Password {passwordSet && !passwordTouched ? '(leave unchanged to keep current)' : ''}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={form.password}
                    onChange={e => { setPasswordTouched(true); set('password', e.target.value); }}
                    onFocus={() => {
                      if (passwordSet && !passwordTouched) { setPasswordTouched(true); set('password', ''); }
                    }}
                    style={{ ...INPUT, width: '100%', paddingRight: 56 }}
                    placeholder={passwordSet ? PASSWORD_PLACEHOLDER : 'Enter password'}
                    disabled={!canWrite}
                  />
                  <button type="button" onClick={() => setShowPass(p => !p)}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--blue)' }}>
                    {showPass ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            </div>

            <div style={SECTION_HEADER}>Sender Identity</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <label style={LABEL}>From Email</label>
                <input value={form.from_email} onChange={e => set('from_email', e.target.value)}
                  style={{ ...INPUT, width: '100%' }} placeholder="ddivault@company.com" disabled={!canWrite} />
              </div>
              <div>
                <label style={LABEL}>From Name</label>
                <input value={form.from_name} onChange={e => set('from_name', e.target.value)}
                  style={{ ...INPUT, width: '100%' }} placeholder="DDIVault Alerts" disabled={!canWrite} />
              </div>
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: canWrite ? 'pointer' : 'default', fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
                <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} disabled={!canWrite} />
                Enable email alert delivery
              </label>
              {source === 'hub' && (
                <div style={{ marginTop: 6, marginLeft: 24, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  This switch still controls whether DDIVault sends mail at all, central mail server or not.
                </div>
              )}
            </div>

            {canWrite && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4, borderTop: '1px solid var(--border-light)', marginBottom: 18 }}>
                <button className="btn btn-primary" onClick={save} disabled={busy} style={{ opacity: busy ? 0.7 : 1, marginTop: 14 }}>
                  {saving ? <><Spinner size={13} color="#fff" /> Saving…</> : 'Save Settings'}
                </button>
              </div>
            )}

            {/* Send test email */}
            <div style={SECTION_HEADER}>Send Test Email</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label style={LABEL}>Recipient</label>
                <input type="email" value={testTo} onChange={e => setTestTo(e.target.value)}
                  style={{ ...INPUT, width: '100%' }} placeholder="you@company.com" disabled={!canWrite} />
              </div>
              <button className="btn btn-navy" onClick={sendTest} disabled={busy || !canWrite} style={{ opacity: (busy || !canWrite) ? 0.7 : 1 }}>
                {testing ? <><Spinner size={13} color="#fff" /> Sending…</> : 'Send Test Email'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
