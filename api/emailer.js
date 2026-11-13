// DDIVault on-premises SMTP email engine.
// No external API calls — only the configured SMTP server is used.

const nodemailer = require('nodemailer');
const crypto = require('crypto');
const suiteSmtp = require('./suiteSmtp');

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.DDI_APP_URL ||
  ('http://localhost:' + (process.env.DDI_APP_PORT || '3006'));

// NEXTAUTH_SECRET signs the alert-acknowledgment HMAC tokens (see ackToken/
// verifyAckToken below) used by the one legitimate unauthenticated-by-design
// endpoint in this app (GET /api/alerts/:id/acknowledge). There is no safe
// fallback for a security-relevant secret — fail loud and immediate at
// startup rather than silently signing tokens with a guessable literal.
if (!process.env.NEXTAUTH_SECRET) {
  throw new Error(
    'NEXTAUTH_SECRET is not set. It is required to sign alert-acknowledgment ' +
    'email tokens (api/emailer.js). Refusing to start with a weak fallback secret.'
  );
}
const SECRET = process.env.NEXTAUTH_SECRET;

// ---------------------------------------------------------------------------
// SMTP config
// ---------------------------------------------------------------------------

/**
 * The single resolution point for every sender below (sendAlert, sendDigest,
 * sendReport, sendTestEmail).
 *
 * Since 1.34.0 the config may come from the NetVault hub's suite-wide
 * `smtp_config` instead of this app's own row — see `api/suiteSmtp.js`, which
 * owns the choice, the 5-minute cache and the fail-soft fallback. The RETURNED
 * SHAPE IS UNCHANGED (`host, port, secure, username, password, from_email,
 * from_name, enabled`), so no call site had to change; `source` and
 * `allow_self_signed` ride along for buildTransport. Since 1.35.0
 * `allow_self_signed` is carried on BOTH paths — the hub's column when the
 * transport is hub-managed, this app's own column when it is local — and is
 * always a real boolean by the time buildTransport sees it.
 */
async function getSmtpConfig(db) {
  const resolved = await suiteSmtp.resolveSmtp(db);
  return resolved.cfg;
}

function invalidateSmtpCache() {
  // The cache now lives in suiteSmtp (one cache covering BOTH the hub row and
  // the local row). POST /api/smtp calls this after a save — if you ever add a
  // second cache here, clear it from this function too.
  suiteSmtp.invalidateSuiteSmtpCache();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function buildTransport(cfg) {
  const opts = {
    host: cfg.host,
    port: cfg.port,
    secure: !!cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
  };

  // ── TLS certificate verification ──────────────────────────────────
  // ONE rule for BOTH transports: verify, unless this config explicitly says
  // not to. `allow_self_signed` is the hub's column when the transport is
  // hub-managed (Phase 2, 1.34.0) and this app's own smtp_config column when it
  // is local (Phase 5).
  //
  // The local path used to set `rejectUnauthorized: false` UNCONDITIONALLY —
  // DDIVault silently accepted ANY certificate, forever, with nothing in the UI
  // saying so, while the hub, LogVault and SpanVault all verified. Phase 2 left
  // that alone on a continuity argument: breaking an existing customer's
  // self-signed relay mid-upgrade would be a silent "alerts stopped arriving".
  //
  // ⛔ That argument was RETIRED on EVIDENCE, not waved away — do not read this
  // as a migration someone skipped. Measured on production 2026-11-13:
  // `alert_email_log` held zero rows for all time (DDIVault has never sent a
  // single email), `smtp_config.enabled` was false, there were no active
  // `alert_recipients`, and the other satellites' mail was off too. There was
  // no working configuration anywhere to preserve, so the exemption was
  // removed outright instead of being migrated around. If that ever stops being
  // true, changing this default again needs a backfill, not a flag day.
  //
  // ⛔ `=== true`, never a truthy test. The value arrives from a database
  // column that may be NULL (a row written before the column existed) or, on
  // the hub path, from a JSON-ish value where the strings 'false' and '0' are
  // both truthy — a loose test would let any of those silently DISABLE
  // certificate verification. `suiteSmtp` normalizes on both paths; this is the
  // second half of the same belt, at the one place that actually decides.
  //
  // Since 1.35.0 nothing in DDIVault can SET this: `POST /api/smtp` no longer
  // accepts the field and the Settings page no longer offers the control, so a
  // local row's value is whatever it already held (FALSE on every install —
  // the column shipped `DEFAULT FALSE` with no backfill). The only way to turn
  // certificate checking off is now the hub's own tickbox, which arrives here
  // on the hub path. Do NOT re-add a local writer without re-reading the
  // measurement in the paragraph above.
  if (cfg.allow_self_signed === true) opts.tls = { rejectUnauthorized: false };

  return nodemailer.createTransport(opts);
}

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------
/**
 * A nodemailer error message routinely embeds the SMTP host, the port, the
 * configured username and the server's verbatim auth rejection. None of that
 * may travel back to an HTTP caller. Return only the machine code (`code` for
 * transport errors, `responseCode` for SMTP replies) and keep the detail in
 * the service log, where an operator can read it.
 *
 * Mirrors `mailErrorSummary` in spanvault's `api/rbacScope.js` and the hub's
 * `lib/mailer.ts`. LogVault and SpanVault had both already fixed this class;
 * DDIVault was the surviving instance.
 */
function mailErrorSummary(err) {
  const code = err && (err.code || err.responseCode);
  return code
    ? 'Email delivery failed (' + String(code).slice(0, 40) + ') — see the API log for detail.'
    : 'Email delivery failed — see the API log for detail.';
}

// ---------------------------------------------------------------------------
// Acknowledge tokens
// ---------------------------------------------------------------------------

function ackToken(alertId) {
  return crypto
    .createHmac('sha256', SECRET)
    .update('ack:' + alertId)
    .digest('hex')
    .slice(0, 32);
}

function verifyAckToken(alertId, token) {
  const expected = Buffer.from(ackToken(alertId));
  const provided = Buffer.from(String(token || ''));
  // Lengths must match before timingSafeEqual — it throws on a length
  // mismatch rather than returning false, so guard first.
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function esc(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function severityColor(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical') return '#C8102E';
  if (s === 'warning' || s === 'warn') return '#f59e0b';
  return '#3b82f6'; // info / default
}

function headerBar() {
  return (
    '<div style="background:#1a2744;padding:20px 24px;">' +
    '<span style="font-family:Inter,Arial,sans-serif;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">DDIVault</span>' +
    '<div style="height:3px;width:48px;background:#C8102E;margin-top:8px;border-radius:2px;"></div>' +
    '</div>'
  );
}

function footerBar() {
  return (
    '<div style="padding:16px 24px;border-top:1px solid #e2e8f0;background:#f4f6f9;">' +
    '<span style="font-family:Inter,Arial,sans-serif;font-size:12px;color:#64748b;">' +
    'DDIVault Alert System &middot; Manage alerts at ' +
    '<a href="' + esc(APP_URL) + '" style="color:#C8102E;text-decoration:none;">' + esc(APP_URL) + '</a>' +
    '</span>' +
    '</div>'
  );
}

function detailRow(label, value) {
  return (
    '<tr>' +
    '<td style="padding:8px 12px;font-family:Inter,Arial,sans-serif;font-size:13px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0;white-space:nowrap;vertical-align:top;">' +
    esc(label) +
    '</td>' +
    '<td style="padding:8px 12px;font-family:Inter,Arial,sans-serif;font-size:13px;color:#1a2744;border-bottom:1px solid #e2e8f0;">' +
    esc(value) +
    '</td>' +
    '</tr>'
  );
}

function renderAlertHtml(alert) {
  const sev = String(alert.severity || 'info');
  const color = severityColor(sev);
  const badge =
    '<span style="display:inline-block;padding:4px 12px;border-radius:12px;background:' +
    color +
    ';color:#ffffff;font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">' +
    esc(sev) +
    '</span>';

  const viewUrl = APP_URL + '/';
  const ackUrl =
    APP_URL + '/api/alerts/' + alert.id + '/acknowledge?token=' + ackToken(alert.id);

  return (
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">' +
    headerBar() +
    '<div style="padding:24px;">' +
    '<div style="margin-bottom:16px;">' + badge + '</div>' +
    '<h2 style="margin:0 0 16px 0;font-family:Inter,Arial,sans-serif;font-size:18px;color:#1a2744;font-weight:700;">' +
    esc(alert.message) +
    '</h2>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">' +
    detailRow('Message', alert.message) +
    detailRow('Severity', sev) +
    detailRow('Scope / Entity', alert.scope_id) +
    detailRow('Server', alert.server_id) +
    detailRow('Fired At', alert.fired_at) +
    '</table>' +
    '<table style="border-collapse:collapse;"><tr>' +
    '<td style="padding-right:12px;">' +
    '<a href="' + esc(viewUrl) + '" style="display:inline-block;padding:10px 20px;background:#C8102E;color:#ffffff;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">View in DDIVault</a>' +
    '</td>' +
    '<td>' +
    '<a href="' + esc(ackUrl) + '" style="display:inline-block;padding:10px 20px;background:#ffffff;color:#1a2744;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;border:1px solid #e2e8f0;border-radius:8px;">Acknowledge</a>' +
    '</td>' +
    '</tr></table>' +
    '</div>' +
    footerBar() +
    '</div>'
  );
}

function renderDigestHtml(alerts) {
  let rows = '';
  for (const a of alerts) {
    const sev = String(a.severity || 'info');
    const color = severityColor(sev);
    rows +=
      '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;">' +
      '<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:' + color + ';color:#ffffff;font-family:Inter,Arial,sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;">' +
      esc(sev) +
      '</span></td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:Inter,Arial,sans-serif;font-size:13px;color:#1a2744;">' +
      esc(a.message) +
      '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:Inter,Arial,sans-serif;font-size:13px;color:#64748b;white-space:nowrap;">' +
      esc(a.fired_at) +
      '</td>' +
      '</tr>';
  }

  return (
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">' +
    headerBar() +
    '<div style="padding:24px;">' +
    '<h2 style="margin:0 0 16px 0;font-family:Inter,Arial,sans-serif;font-size:18px;color:#1a2744;font-weight:700;">' +
    'Alert digest — ' + alerts.length + ' alert(s)' +
    '</h2>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">' +
    '<tr>' +
    '<th style="padding:8px 12px;text-align:left;font-family:Inter,Arial,sans-serif;font-size:12px;color:#64748b;border-bottom:2px solid #e2e8f0;">Severity</th>' +
    '<th style="padding:8px 12px;text-align:left;font-family:Inter,Arial,sans-serif;font-size:12px;color:#64748b;border-bottom:2px solid #e2e8f0;">Message</th>' +
    '<th style="padding:8px 12px;text-align:left;font-family:Inter,Arial,sans-serif;font-size:12px;color:#64748b;border-bottom:2px solid #e2e8f0;">Time</th>' +
    '</tr>' +
    rows +
    '</table>' +
    '<a href="' + esc(APP_URL + '/') + '" style="display:inline-block;padding:10px 20px;background:#C8102E;color:#ffffff;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">View in DDIVault</a>' +
    '</div>' +
    footerBar() +
    '</div>'
  );
}

function fromHeader(cfg) {
  const name = cfg.from_name || 'DDIVault';
  return '"' + name + '" <' + cfg.from_email + '>';
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

async function sendTestEmail(db, toEmail) {
  try {
    const cfg = await getSmtpConfig(db);
    // Since 1.35.0 a row can exist with NO transport in it: the Settings page no
    // longer offers the server fields (the NetVault hub owns them), so the first
    // save on a fresh install writes sender identity against an empty `host`.
    // Dialling '' would surface as a bare DNS/socket code; say the useful thing
    // instead, and point at the ONE place a mail server can now be configured.
    if (!cfg || !String(cfg.host || '').trim()) {
      return {
        ok: false,
        error: 'No mail server is configured. Set up the suite mail server in NetVault (Settings → Notifications).',
      };
    }
    // For a test, allow sending even if not enabled.
    const transport = buildTransport(cfg);
    const html =
      '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">' +
      headerBar() +
      '<div style="padding:24px;font-family:Inter,Arial,sans-serif;font-size:14px;color:#1a2744;">' +
      '<p style="margin:0 0 8px 0;font-weight:700;">SMTP test successful</p>' +
      '<p style="margin:0;color:#64748b;">Your DDIVault SMTP configuration is working correctly.</p>' +
      '</div>' +
      footerBar() +
      '</div>';

    await transport.sendMail({
      from: fromHeader(cfg),
      to: toEmail,
      subject: 'DDIVault SMTP test',
      html,
    });

    return { ok: true };
  } catch (err) {
    // Server-side gets the full detail; the caller gets only a code.
    console.error('[Emailer] SMTP test send failed:', err && err.message);
    return { ok: false, error: mailErrorSummary(err) };
  }
}

// Branded HTML body for a scheduled report email. `meta` rows are [label, value].
function renderReportHtml(reportTitle, intro, meta) {
  const rows = (meta || []).map(([k, v]) => detailRow(k, v)).join('');
  return (
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">' +
    headerBar() +
    '<div style="padding:24px;font-family:Inter,Arial,sans-serif;font-size:14px;color:#1a2744;">' +
    '<p style="margin:0 0 8px 0;font-weight:700;font-size:16px;">' + esc(reportTitle) + '</p>' +
    '<p style="margin:0 0 16px 0;color:#64748b;">' + esc(intro || 'Your scheduled DDIVault report is attached.') + '</p>' +
    (rows ? '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>' : '') +
    '</div>' +
    footerBar() +
    '</div>'
  );
}

// Send a scheduled report email with an attachment (PDF or CSV). Safe to call from
// the collector process — getSmtpConfig resolves the hub's suite transport or this
// app's own row (api/suiteSmtp.js) and decrypts via credStore (NEXTAUTH_SECRET).
// Returns { ok, error?, skipped? }. `error` here is the RAW message on purpose:
// its only consumer is report_email_log.error_msg, a server-side audit row. Do not
// forward it to an HTTP response without mailErrorSummary().
async function sendReport(db, toEmail, subject, html, attachments) {
  try {
    const cfg = await getSmtpConfig(db);
    if (!cfg || !cfg.enabled) {
      return { ok: false, skipped: true, error: 'SMTP not enabled' };
    }
    const transport = buildTransport(cfg);
    await transport.sendMail({
      from: fromHeader(cfg),
      to: toEmail,
      subject,
      html,
      attachments: attachments || [],   // [{ filename, content: <Buffer> }]
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendAlert(db, alert, recipients) {
  recipients = recipients || [];

  const cfg = await getSmtpConfig(db);
  if (!cfg || !cfg.enabled) {
    return { sent: 0, skipped: recipients.length };
  }

  const transport = buildTransport(cfg);
  const html = renderAlertHtml(alert);
  const severity = String(alert.severity || 'info').toUpperCase();
  const msg = String(alert.message || '');
  const subject = '[DDIVault ' + severity + '] ' + msg.slice(0, 120);

  let sent = 0;
  let failed = 0;

  for (const r of recipients) {
    // Success-gated logging: attempt the send first, and only log status='sent'
    // AFTER sendMail() resolves. If it throws, log status='failed' so the alert
    // is NOT treated as delivered and remains eligible for the next digest/retry.
    let status;
    let errorMsg = null;
    try {
      await transport.sendMail({
        from: fromHeader(cfg),
        to: r.name ? '"' + r.name + '" <' + r.email + '>' : r.email,
        subject,
        html,
      });
      status = 'sent';
      sent++;
    } catch (err) {
      status = 'failed';
      errorMsg = err.message;
      failed++;
    }

    try {
      await db.query(
        'INSERT INTO alert_email_log (alert_id, recipient, subject, status, error_msg) VALUES ($1, $2, $3, $4, $5)',
        [alert.id, r.email, subject, status, errorMsg]
      );
    } catch (e) {
      // Never throw from logging — a logging failure must not mask a successful
      // send. A successful send that fails to log will be re-included next cycle
      // (the dedup query keys off a status='sent' row), causing at most a
      // duplicate notification rather than a lost one.
    }
  }

  return { sent, failed };
}

// Log every alert in a digest with a single status, atomically when possible.
// Uses a BEGIN/COMMIT/ROLLBACK transaction on a dedicated pool client so the
// digest's log rows are all-or-nothing. Falls back to per-row inserts on the
// shared handle if the handle is not a pool (no .connect()). Never throws.
async function logDigest(db, alerts, recipient, subject, status, errorMsg) {
  const rows =
    alerts.length > 0
      ? alerts.map((a) => [a.id || null, recipient.email, subject, status, errorMsg])
      : [[null, recipient.email, subject, status, errorMsg]];

  const sql =
    'INSERT INTO alert_email_log (alert_id, recipient, subject, status, error_msg) VALUES ($1, $2, $3, $4, $5)';

  // Preferred: atomic transaction on a checked-out client.
  if (db && typeof db.connect === 'function') {
    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      for (const params of rows) {
        await client.query(sql, params);
      }
      await client.query('COMMIT');
      return;
    } catch (e) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (e2) {
          // ignore rollback failure
        }
      }
      // Logging failure must never mask the send result. Swallow.
    } finally {
      if (client) {
        try {
          client.release();
        } catch (e3) {
          // ignore
        }
      }
    }
    return;
  }

  // Fallback: best-effort per-row inserts on the shared handle.
  for (const params of rows) {
    try {
      await db.query(sql, params);
    } catch (e) {
      // ignore logging errors
    }
  }
}

async function sendDigest(db, alerts, recipient) {
  alerts = alerts || [];

  const cfg = await getSmtpConfig(db);
  if (!cfg || !cfg.enabled) {
    return { ok: false, error: 'SMTP not enabled' };
  }

  const transport = buildTransport(cfg);
  const html = renderDigestHtml(alerts);
  const subject = '[DDIVault] Alert digest — ' + alerts.length + ' alert(s)';

  // Success-gated logging: attempt delivery FIRST. Only write status='sent'
  // rows AFTER sendMail() resolves. If sendMail throws, write status='failed'
  // (never 'sent') so these alerts are NOT considered delivered and remain
  // eligible for the next hourly digest. The dedup query in sendHourlyDigest
  // keys off the presence of a status='sent' row per alert_id, so a failed
  // send leaves the alert pickable next cycle, and a later success then logs
  // 'sent' once — preventing both lost alerts and double-sends.
  try {
    await transport.sendMail({
      from: fromHeader(cfg),
      to: recipient.name ? '"' + recipient.name + '" <' + recipient.email + '>' : recipient.email,
      subject,
      html,
    });
  } catch (err) {
    // Send failed — log as 'failed' (not 'sent') so alerts stay eligible.
    await logDigest(db, alerts, recipient, subject, 'failed', err.message);
    return { ok: false, error: err.message };
  }

  // Send succeeded — now log as 'sent'. A logging failure here is swallowed
  // inside logDigest and cannot turn a successful send into a reported failure.
  await logDigest(db, alerts, recipient, subject, 'sent', null);
  return { ok: true };
}

module.exports = {
  getSmtpConfig,
  invalidateSmtpCache,
  sendTestEmail,
  sendAlert,
  sendDigest,
  sendReport,
  renderReportHtml,
  mailErrorSummary,
  ackToken,
  verifyAckToken,
};
