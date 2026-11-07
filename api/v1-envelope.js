'use strict';

/**
 * v1-envelope.js — the response envelope for the public API (`/api/v1/*`).
 *
 * Extracted out of `api/v1.js` so the error path is unit-testable without
 * express or a database (`tests/v1Envelope.test.js`).
 *
 * ⛔ `internalError` exists because every `catch` in v1.js used to do
 * `fail(res, 500, 'INTERNAL_ERROR', e.message)` — about twenty call sites. A
 * Postgres error message carries table, column and constraint names, so that
 * handed an API-key holder a map of the schema one malformed request at a time.
 * `api/reports.js` already says this in so many words ("do NOT return
 * err.message to the client (it can carry raw Postgres text)") and
 * `api/server.js`'s own handler is already generic. v1 never got the same
 * treatment. The detail goes to the server log; the client gets a fixed string.
 */

const crypto = require('crypto');

/** The single message every v1 500 returns. Deliberately says nothing. */
const GENERIC_500 = 'An internal error occurred. Check the server log for details.';

function reqId() {
  return 'req_' + crypto.randomBytes(8).toString('hex');
}

function ok(res, data, meta) {
  res.json({
    success: true,
    data,
    meta: meta || null,
    timestamp: new Date().toISOString(),
    request_id: res.req.requestId,
  });
}

function fail(res, status, code, message, details) {
  res.status(status).json({
    success: false,
    error: { code, message, details: details || {} },
    timestamp: new Date().toISOString(),
    request_id: res.req.requestId,
  });
}

function pageMeta(total, page, limit) {
  return { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

/**
 * Log the real error, answer with a fixed, information-free 500.
 *
 * @param res    express response
 * @param scope  a short label for the log line (e.g. 'leases')
 * @param err    the caught error — logged, NEVER returned
 */
function internalError(res, scope, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  console.error(`[v1] ${scope} error:`, detail);
  return fail(res, 500, 'INTERNAL_ERROR', GENERIC_500);
}

module.exports = { reqId, ok, fail, pageMeta, internalError, GENERIC_500 };
