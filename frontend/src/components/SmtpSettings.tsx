'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/Toast';
import { useRBAC, ReadOnlyBanner } from '@/components/RBACContext';
import { useLicense } from '@/components/LicenseGuard';
import { PageHeader, Spinner, useRefreshKey } from '@/components/ui';
import { INPUT, LABEL } from '@/lib/settingsFormStyles';
import { getHubUrl } from '@/lib/hubUrl';

// ════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════
/**
 * What this page may still EDIT. Since 1.35.0 the mail server itself — host,
 * port, TLS, username, password and the certificate-checking escape hatch —
 * is owned by the NetVault hub and has no editable control here. The sender
 * identity and the delivery switch stay per-app (plan §3): "DDIVault Alerts"
 * vs "LogVault Alerts" in a recipient's inbox is a feature, and an admin who
 * switched DDIVault's alert mail off must keep that decision.
 */
interface SenderConfig {
  from_email: string;
  from_name: string;
  enabled: boolean;
}

/**
 * This app's OWN smtp_config row, read-only. It is no longer writable from this
 * page, but `api/suiteSmtp.js` still READS it as the fallback transport when
 * the hub has none — so it must stay visible. A row that is silently used to
 * send mail while nothing in the UI mentions it is exactly the state 1.35.0
 * exists to end.
 */
interface LegacyTransport {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  allow_self_signed: boolean;
}

interface TestResult {
  ok: boolean;
  error?: string | null;
}

// Where the transport actually comes from, as `GET /api/smtp` reports it.
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

/**
 * The three states this page can be in, derived from `source` + the local row:
 *   'hub'    — the NetVault hub owns a switched-on transport; that is what sends.
 *   'legacy' — no hub transport, but this app still has a usable row of its own
 *              (non-empty host), which is what sends.
 *   'none'   — nothing anywhere. Mail cannot be delivered and this page cannot
 *              fix it; the hub is the only place a mail server is configured.
 */
type TransportState = 'hub' | 'legacy' | 'none';

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

// Calm informational panel — tokenized so it flips with the theme.
const NOTE: React.CSSProperties = {
  background: 'var(--tint-info)',
  color: 'var(--tint-info-fg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '14px 16px',
  fontSize: 'var(--text-base)',
  lineHeight: 1.55,
};

// Same panel on the warn tint — used where the effective transport is a state
// an administrator should act on (a legacy local row, or nothing at all).
const NOTE_WARN: React.CSSProperties = { ...NOTE, background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)' };

const NOTE_TITLE: React.CSSProperties = {
  fontWeight: 700, marginBottom: 6, fontSize: 'var(--text-md)',
};

// Read-only fact grid inside a transport panel: label on the left, value right.
const FACTS: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  columnGap: 14,
  rowGap: 6,
  margin: '12px 0',
  fontSize: 'var(--text-base)',
};

const FACT_LABEL: React.CSSProperties = {
  color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap',
};

const FACT_VALUE: React.CSSProperties = {
  color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all',
};

const HUB_LINK: React.CSSProperties = {
  color: 'var(--blue)', fontWeight: 600, textDecoration: 'none',
};

const SUBNOTE: React.CSSProperties = {
  marginTop: 6, marginLeft: 24, fontSize: 'var(--text-sm)',
  color: 'var(--text-muted)', maxWidth: 560,
};

const EMPTY_SENDER: SenderConfig = { from_email: '', from_name: '', enabled: false };

// ════════════════════════════════════════════════════════════
// Read-only fact row
// ════════════════════════════════════════════════════════════
// Declared at module scope on purpose — a component defined inside another
// component is remounted on every parent render.
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div style={FACT_LABEL}>{label}</div>
      <div style={FACT_VALUE}>{children}</div>
    </>
  );
}

// Certificate-checking wording, shared by both configured states so they cannot
// drift apart. `allowSelfSigned === true` is the ONE rule buildTransport applies.
function certText(allowSelfSigned: boolean): string {
  return allowSelfSigned
    ? 'Not enforced — any certificate is accepted, including an expired or impersonated one'
    : 'Enforced';
}

// ════════════════════════════════════════════════════════════
// Effective transport — read-only statement of what actually sends
// ════════════════════════════════════════════════════════════
function EffectiveTransport({ state, hub, legacy }: {
  state: TransportState;
  hub: HubSummary | null;
  legacy: LegacyTransport | null;
}) {
  // Never a hardcoded host: the hub is wherever this browser reached DDIVault,
  // on the hub's own port (frontend/src/lib/hubUrl.ts).
  const hubLink = `${getHubUrl()}/settings?tab=notifications`;
  const link = (
    <a href={hubLink} target="_blank" rel="noopener noreferrer" style={HUB_LINK}>
      NetVault → Settings → Notifications
    </a>
  );

  if (state === 'hub' && hub) {
    return (
      <div style={NOTE}>
        <div style={NOTE_TITLE}>Mail server managed centrally in NetVault</div>
        Alerts, digests and scheduled reports are delivered through the mail server configured
        once for the whole NocVault suite.
        <div style={FACTS}>
          <Fact label="Server">{hub.host}:{hub.port}</Fact>
          <Fact label="Connection">{hub.secure ? 'TLS / SSL' : 'STARTTLS or plain'}</Fact>
          <Fact label="Username">{hub.username || '(none — unauthenticated)'}</Fact>
          <Fact label="Certificate checking">{certText(hub.allow_self_signed)}</Fact>
        </div>
        The mail server is changed in {link}, not here. DDIVault keeps its own sender
        identity and its own delivery switch, below.
      </div>
    );
  }

  if (state === 'legacy' && legacy) {
    return (
      <div style={NOTE_WARN}>
        <div style={NOTE_TITLE}>Sending through a mail server stored in DDIVault</div>
        NetVault has no suite mail server switched on, so DDIVault is falling back to the
        server saved in its own settings by an earlier release.
        <div style={FACTS}>
          <Fact label="Server">{legacy.host}:{legacy.port}</Fact>
          <Fact label="Connection">{legacy.secure ? 'TLS / SSL' : 'STARTTLS or plain'}</Fact>
          <Fact label="Username">{legacy.username || '(none — unauthenticated)'}</Fact>
          <Fact label="Certificate checking">{certText(legacy.allow_self_signed)}</Fact>
        </div>
        These values are <strong>no longer editable here</strong> — a mail server is now
        configured for the whole suite in {link}. This one keeps working until one is set
        up there, which then takes over.
      </div>
    );
  }

  return (
    <div style={NOTE_WARN}>
      <div style={NOTE_TITLE}>No mail server configured</div>
      NetVault has no suite mail server switched on, and DDIVault has none of its own. Until
      one is configured, alerts, digests and scheduled reports <strong>will not be
      delivered</strong> and Send Test Email will fail.
      <div style={{ marginTop: 10 }}>
        The mail server for the whole NocVault suite is set up in {link}. DDIVault cannot be
        pointed at a mail server from this page.
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN — SMTP Settings
// ════════════════════════════════════════════════════════════
export default function SmtpSettings() {
  const { toast } = useToast();
  const { canWrite: rbacCanWrite } = useRBAC();
  const { state: licenseState } = useLicense();
  const canWrite = rbacCanWrite && licenseState.canWrite;

  const [form, setForm] = useState<SenderConfig>(EMPTY_SENDER);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [source, setSource] = useState<SmtpSource>('local');
  const [hub, setHub] = useState<HubSummary | null>(null);
  const [legacy, setLegacy] = useState<LegacyTransport | null>(null);

  const set = <K extends keyof SenderConfig>(k: K, v: SenderConfig[K]) =>
    setForm(p => ({ ...p, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api('/smtp');
      const data = d.data || null;
      setSource(d.source === 'hub' ? 'hub' : 'local');
      setHub(d.hub || null);
      if (data) {
        setForm({
          from_email: data.from_email || '',
          from_name: data.from_name || '',
          enabled: !!data.enabled,
        });
        // A row with an empty host is not a usable fallback — treat it as none.
        const host = String(data.host || '').trim();
        setLegacy(host ? {
          host,
          port: data.port != null ? Number(data.port) : 587,
          secure: !!data.secure,
          username: data.username || '',
          allow_self_signed: data.allow_self_signed === true,
        } : null);
      } else {
        setForm(EMPTY_SENDER);
        setLegacy(null);
      }
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useRefreshKey(load);

  // The hub's answer wins whenever the backend resolved to it; otherwise a
  // non-empty local host is the live fallback, and nothing at all is 'none'.
  const transport: TransportState =
    source === 'hub' && hub ? 'hub' : legacy ? 'legacy' : 'none';

  const save = async () => {
    if (!form.from_email.trim()) { toast('From Email is required', 'error'); return; }
    setSaving(true);
    try {
      // Sender identity + delivery switch ONLY. The transport fields are the
      // hub's and are not sent — POST /api/smtp no longer accepts them, and
      // this app's own stored host/port/username/password are left untouched
      // so the fallback keeps working.
      await api('/smtp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_email: form.from_email,
          from_name: form.from_name,
          enabled: form.enabled,
        }),
      });
      toast('Email settings saved', 'success');
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

  const subtitle =
    transport === 'hub' ? 'Outbound mail is sent through the NetVault suite mail server'
    : transport === 'legacy' ? 'Outbound mail is sent through the server stored in DDIVault'
    : 'No outbound mail server is configured';

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader title="SMTP / Email" subtitle={subtitle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-sm)', fontWeight: 600 }}>
          <span style={{
            width: 10, height: 10, borderRadius: '50%',
            background: form.enabled ? 'var(--green)' : 'var(--text-muted)',
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
            <Spinner /> Loading email settings…
          </div>
        ) : (
          <>
            <div style={SECTION_HEADER}>Mail Server</div>
            <div style={{ marginBottom: 20 }}>
              <EffectiveTransport state={transport} hub={hub} legacy={legacy} />
            </div>

            <div style={SECTION_HEADER}>Sender Identity</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <label style={LABEL}>From Email *</label>
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
              <div style={SUBNOTE}>
                This switch decides whether DDIVault sends mail at all, whichever mail server
                is in force above.
              </div>
            </div>

            {canWrite && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4, borderTop: '1px solid var(--border-light)', marginBottom: 18 }}>
                <button className="btn btn-primary" onClick={save} disabled={busy} style={{ opacity: busy ? 0.7 : 1, marginTop: 14 }}>
                  {saving ? <><Spinner size={13} color="#fff" /> Saving…</> : 'Save Settings'}
                </button>
              </div>
            )}

            {/* Send test email — always available, and always against whichever
                transport the server actually resolved. */}
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
