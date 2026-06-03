'use strict';

/**
 * audit.js — Audit trail middleware for DDIVault
 *
 * Captures WHO did WHAT, WHEN, from WHERE, with before/after state.
 *
 * Usage:
 *   const { auditContext } = require('./middleware/audit');
 *   app.use(auditContext(db));            // mount once, after express.json()
 *   // then inside any mutating route:
 *   await req.audit({ action: 'create', entity_type: 'dns_zone', entity_name: zone, new_value: {...} });
 *
 * Actor identity is read from headers injected by the Next.js frontend
 * (x-ddi-actor / x-ddi-actor-role / x-ddi-actor-id). Falls back to 'system'.
 *
 * Audit writes NEVER throw — a failed audit must not break the operation.
 */

const ACTIONS = Object.freeze({
  CREATE: 'create',
  MODIFY: 'modify',
  DELETE: 'delete',
  SCAN: 'scan',
  IMPORT: 'import',
  EXPORT: 'export',
  TEST: 'test',
  LOGIN: 'login',
  LOGOUT: 'logout',
  RESERVE: 'reserve',
  RELEASE: 'release',
  ACKNOWLEDGE: 'acknowledge',
});

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || null;
}

/** Build a one-line human summary when the route didn't supply one. */
function buildSummary(entry) {
  if (entry.change_summary) return entry.change_summary;
  const who = entry.entity_name || entry.entity_id || entry.entity_type;
  const act = String(entry.action || '').toUpperCase();
  return `${act} ${entry.entity_type}${who ? ` "${who}"` : ''}`;
}

/**
 * Low-level insert. Resolves to the inserted id, or null on failure.
 * Swallows all errors (logs them) so it can never break a request.
 */
async function writeAudit(db, entry) {
  try {
    const row = await db.query(
      `INSERT INTO audit_log
         (username, user_id, user_role, action, entity_type, entity_id, entity_name,
          old_value, new_value, change_summary, ip_address, user_agent, session_id,
          result, error_message, duration_ms, site_id, server_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        entry.username || 'system',
        entry.user_id != null ? parseInt(entry.user_id) || null : null,
        entry.user_role || null,
        entry.action,
        entry.entity_type,
        entry.entity_id != null ? String(entry.entity_id) : null,
        entry.entity_name || null,
        entry.old_value != null ? JSON.stringify(entry.old_value) : null,
        entry.new_value != null ? JSON.stringify(entry.new_value) : null,
        buildSummary(entry),
        entry.ip_address || null,
        entry.user_agent || null,
        entry.session_id || null,
        entry.result || 'success',
        entry.error_message || null,
        entry.duration_ms != null ? parseInt(entry.duration_ms) || null : null,
        entry.site_id != null ? parseInt(entry.site_id) || null : null,
        entry.server_id != null ? parseInt(entry.server_id) || null : null,
      ],
    );
    return row.rows[0].id;
  } catch (err) {
    console.error('[Audit] write failed (non-fatal):', err.message);
    return null;
  }
}

// Paths that must never be auto-audited (read-only, self-auditing, or noisy).
const AUTO_SKIP = [/^\/api\/v1\//, /^\/api\/audit/, /^\/api\/health/];

/** Derive (entity_type, action) for the automatic fallback from method + path. */
function deriveFromPath(method, path) {
  const seg = path.replace(/^\/api\//, '').split('?')[0].split('/');
  let entity = seg[0] || 'resource';
  if (entity === 'ipam') entity = seg[1] || 'ipam';
  if (entity === 'dns') entity = `dns_${seg[1] || 'record'}`;
  if (entity === 'dhcp') entity = `dhcp_${seg[1] || 'object'}`;
  const action = method === 'POST' ? 'create' : method === 'PUT' ? 'modify' : method === 'DELETE' ? 'delete' : 'modify';
  return { entity: entity.replace(/s$/, ''), action };
}

/**
 * Express middleware factory. Attaches actor context + req.audit() to every
 * request, AND registers an automatic fallback so any mutating endpoint that
 * does not call req.audit() explicitly is still recorded on success.
 */
function auditContext(db) {
  return function (req, res, next) {
    const startedAt = Date.now();
    req._auditActor = {
      username: req.headers['x-ddi-actor'] || 'system',
      user_id: req.headers['x-ddi-actor-id'] || null,
      user_role: req.headers['x-ddi-actor-role'] || null,
      ip_address: clientIp(req),
      user_agent: req.headers['user-agent'] || null,
      session_id: req.headers['x-ddi-session'] || null,
    };
    req._auditedExplicitly = false;

    /**
     * Record an audit entry. Actor, IP, user-agent and duration are filled
     * in automatically; the route only supplies the change details.
     */
    req.audit = function (entry) {
      req._auditedExplicitly = true;
      return writeAudit(db, {
        ...req._auditActor,
        duration_ms: Date.now() - startedAt,
        ...entry,
      });
    };

    // Automatic fallback — guarantees coverage of mutating endpoints.
    const isMutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (isMutating && !AUTO_SKIP.some(re => re.test(req.path))) {
      res.on('finish', () => {
        if (req._auditedExplicitly) return;
        if (res.statusCode >= 400) {
          const { entity, action } = deriveFromPath(req.method, req.path);
          writeAudit(db, {
            ...req._auditActor, action, entity_type: entity,
            duration_ms: Date.now() - startedAt, result: 'failure',
            error_message: `HTTP ${res.statusCode}`,
          });
          return;
        }
        const { entity, action } = deriveFromPath(req.method, req.path);
        writeAudit(db, {
          ...req._auditActor, action, entity_type: entity,
          duration_ms: Date.now() - startedAt, result: 'success',
        });
      });
    }

    next();
  };
}

module.exports = { auditContext, writeAudit, ACTIONS };
