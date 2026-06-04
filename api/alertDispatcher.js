// alertDispatcher.js — DDIVault
// Routes alert_events to email recipients with cooldown + digest support.
// On-premises only. Depends on ./emailer (getSmtpConfig, sendAlert, sendDigest).

const emailer = require('./emailer');

/**
 * Decide whether a recipient should receive an alert based on severity.
 *
 * Severity filter rules (role_filter on alert_recipients):
 *   - null/'' = receive all severities
 *   - role_filter === alert.severity = exact match
 *   - role_filter === 'warning' && alert.severity === 'critical' = escalation
 *     (warning subscribers also get critical alerts)
 */
function severityMatches(roleFilter, alertSeverity) {
  if (roleFilter === null || roleFilter === undefined || roleFilter === '') return true;
  if (roleFilter === alertSeverity) return true;
  if (roleFilter === 'warning' && alertSeverity === 'critical') return true;
  return false;
}

/**
 * Decide whether a site-restricted recipient should receive an alert.
 *
 * Site filter rules:
 *   - recipient.site_id null = receive regardless of site
 *   - recipient.site_id set + alertSiteId known = keep only on match
 *   - recipient.site_id set + alertSiteId could NOT be derived =
 *     INCLUDE the recipient. Rationale: when the alert has no derivable
 *     site at all we prefer not to silently drop every site-restricted
 *     recipient, which would mean nobody gets notified. Better to
 *     over-notify than to lose an alert entirely.
 */
function siteMatches(recipientSiteId, alertSiteId, siteDerivable) {
  if (recipientSiteId === null || recipientSiteId === undefined) return true;
  if (!siteDerivable) return true; // no site could be derived — include to avoid dropping all
  return String(recipientSiteId) === String(alertSiteId);
}

/**
 * Best-effort lookup of the alert's site via its originating server.
 * Returns { siteId, derivable }.
 */
async function deriveAlertSite(db, alert) {
  if (!alert || alert.server_id === null || alert.server_id === undefined) {
    return { siteId: null, derivable: false };
  }
  try {
    const r = await db.query('SELECT site_id FROM ddi_servers WHERE id=$1', [alert.server_id]);
    if (r.rows.length === 0) return { siteId: null, derivable: false };
    return { siteId: r.rows[0].site_id, derivable: true };
  } catch (e) {
    console.error('[alertDispatcher] deriveAlertSite failed:', e.message);
    return { siteId: null, derivable: false };
  }
}

/**
 * dispatchAlert — route a single alert to recipients (respecting rule config,
 * cooldown, severity/site filters, and digest mode).
 */
async function dispatchAlert(db, alert, ruleType) {
  try {
    if (!alert) return { error: 'no alert provided' };

    // 1. Load rule config if a ruleType was supplied.
    let rule = null;
    if (ruleType) {
      const rc = await db.query('SELECT * FROM alert_rule_config WHERE rule_type=$1', [ruleType]);
      if (rc.rows.length > 0) {
        rule = rc.rows[0];
        if (rule.is_enabled === false) {
          return { skipped: true, reason: 'rule disabled' };
        }
      }
    }

    // 2. Cooldown — skip if a similar alert was already emailed within the window.
    if (rule && rule.cooldown_mins) {
      const cd = await db.query(
        `SELECT 1 FROM alert_email_log l JOIN alert_events e ON e.id = l.alert_id
         WHERE l.status='sent' AND l.sent_at > NOW() - ($1 || ' minutes')::interval
           AND e.severity=$2 AND COALESCE(e.scope_id,'')=COALESCE($3,'') LIMIT 1`,
        [String(rule.cooldown_mins), alert.severity, alert.scope_id]
      );
      if (cd.rows.length > 0) {
        return { skipped: true, reason: 'cooldown' };
      }
    }

    // 3. Recipients — load active, then filter in JS by severity + site.
    const rcpRes = await db.query(
      'SELECT email, name, role_filter, site_id FROM alert_recipients WHERE is_active=TRUE'
    );
    const { siteId: alertSiteId, derivable: siteDerivable } = await deriveAlertSite(db, alert);

    const recipients = rcpRes.rows.filter(
      (r) =>
        severityMatches(r.role_filter, alert.severity) &&
        siteMatches(r.site_id, alertSiteId, siteDerivable)
    );

    if (recipients.length === 0) {
      return { skipped: true, reason: 'no recipients' };
    }

    // 4. Digest mode — defer to the hourly digest job.
    if (rule && rule.digest_mode === true) {
      return { queued: true };
    }

    // Otherwise send immediately.
    const result = await emailer.sendAlert(db, alert, recipients);
    return result;
  } catch (e) {
    console.error('[alertDispatcher] dispatchAlert error:', e.message);
    return { error: e.message };
  }
}

/**
 * sendHourlyDigest — gather un-emailed alerts from the last 60 minutes and
 * send a per-recipient digest of the alerts matching their severity/site filters.
 */
async function sendHourlyDigest(db) {
  try {
    const alertsRes = await db.query(
      `SELECT e.* FROM alert_events e
       WHERE e.fired_at > NOW() - INTERVAL '60 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM alert_email_log l WHERE l.alert_id=e.id AND l.status='sent'
         )
       ORDER BY e.fired_at DESC`
    );

    const alerts = alertsRes.rows;
    if (alerts.length === 0) {
      return { sent: 0 };
    }

    // Active recipients.
    const rcpRes = await db.query(
      'SELECT email, name, role_filter, site_id FROM alert_recipients WHERE is_active=TRUE'
    );
    const recipients = rcpRes.rows;
    if (recipients.length === 0) {
      return { recipients: 0, alerts: 0 };
    }

    // Pre-derive each alert's site once (best-effort), cache by server_id.
    const siteCache = new Map();
    for (const a of alerts) {
      const key = a.server_id === null || a.server_id === undefined ? '__none__' : a.server_id;
      if (!siteCache.has(key)) {
        siteCache.set(key, await deriveAlertSite(db, a));
      }
    }

    let recipientsSent = 0;
    let alertsSent = 0;

    for (const r of recipients) {
      const matching = alerts.filter((a) => {
        const key = a.server_id === null || a.server_id === undefined ? '__none__' : a.server_id;
        const site = siteCache.get(key) || { siteId: null, derivable: false };
        return (
          severityMatches(r.role_filter, a.severity) &&
          siteMatches(r.site_id, site.siteId, site.derivable)
        );
      });

      if (matching.length === 0) continue;

      await emailer.sendDigest(db, matching, r);
      recipientsSent += 1;
      alertsSent += matching.length;
    }

    return { recipients: recipientsSent, alerts: alertsSent };
  } catch (e) {
    console.error('[alertDispatcher] sendHourlyDigest error:', e.message);
    return { error: e.message };
  }
}

module.exports = { dispatchAlert, sendHourlyDigest };
