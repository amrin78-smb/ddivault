'use strict';

/**
 * apiAuth.js — API key authentication for the public REST API (/api/v1/*)
 *
 * Keys are shown to the user exactly once at creation. Only the SHA-256 hash
 * is stored (same never-plaintext principle as credStore.js).
 *
 * Key format:  ddiv_live_<32 url-safe chars>
 * Prefix kept for display:  ddiv_live_<first 6 of random>
 *
 * Auth header (either):
 *   Authorization: Bearer ddiv_live_xxx
 *   X-API-Key: ddiv_live_xxx
 *
 * Rate limit: 1000 requests / hour / key (in-memory sliding window).
 */

const crypto = require('crypto');
// ⛔ The IP allow-list below is only as trustworthy as this function. It used to
// read `x-forwarded-for`'s FIRST entry — the hop the CALLER supplies — so a
// holder of an IP-restricted key could send `X-Forwarded-For: <allowed-ip>` and
// the restriction evaporated. See api/clientIp.js for why the client address is
// counted from the right instead.
const { clientIpForAuthorization } = require('../clientIp');

const KEY_PREFIX = 'ddiv_live_';
const RATE_LIMIT = 1000;          // requests
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// in-memory rate counters: keyHash -> { count, windowStart }
const rateBuckets = new Map();

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/** Generate a brand-new API key. Returns the plaintext (once) + stored fields. */
function generateKey() {
  // 24 random bytes -> 32 url-safe base64 chars (no padding/symbols)
  const random = crypto.randomBytes(24).toString('base64')
    .replace(/\+/g, 'x').replace(/\//g, 'y').replace(/=/g, '').slice(0, 32);
  const key = KEY_PREFIX + random;
  return {
    key,
    key_prefix: KEY_PREFIX + random.slice(0, 6),
    key_hash: sha256(key),
  };
}

/** Masked display form, e.g. ddiv_live_a8f3k2**** */
function maskedDisplay(prefix) {
  return `${prefix}****`;
}

function rateCheck(keyHash) {
  const now = Date.now();
  let b = rateBuckets.get(keyHash);
  if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    rateBuckets.set(keyHash, b);
  }
  b.count += 1;
  return {
    ok: b.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - b.count),
    reset: b.windowStart + RATE_WINDOW_MS,
    limit: RATE_LIMIT,
  };
}

function extractKey(req) {
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = req.headers['x-api-key'];
  if (x) return String(x).trim();
  return null;
}

/**
 * Express middleware factory enforcing an API key with a required permission
 * ('read' | 'write' | 'admin'). Attaches req.apiKey on success.
 */
function apiAuth(db, requiredPerm) {
  return async function (req, res, next) {
    const sendErr = (status, code, message) => res.status(status).json({
      success: false,
      error: { code, message, details: {} },
      timestamp: new Date().toISOString(),
      request_id: req.requestId || null,
    });

    const raw = extractKey(req);
    if (!raw) return sendErr(401, 'MISSING_API_KEY', 'No API key provided. Send it as "Authorization: Bearer <key>" or "X-API-Key: <key>".');
    if (!raw.startsWith(KEY_PREFIX)) return sendErr(401, 'INVALID_API_KEY', 'API key format is invalid.');

    try {
      const hash = sha256(raw);
      const result = await db.query('SELECT * FROM api_keys WHERE key_hash = $1 LIMIT 1', [hash]);
      const key = result.rows[0];
      if (!key) return sendErr(401, 'INVALID_API_KEY', 'API key not recognized.');
      if (!key.is_active) return sendErr(401, 'KEY_REVOKED', 'This API key has been revoked.');
      if (key.expires_at && new Date(key.expires_at) < new Date()) return sendErr(401, 'KEY_EXPIRED', 'This API key has expired.');

      // IP allow-list. FAILS CLOSED, including when the caller's address is not
      // knowable at all.
      //
      // ⛔ "Not knowable" is the NORMAL case as currently deployed, and it must
      // not be mistaken for "the caller is 127.0.0.1". This API binds loopback
      // and the only thing that reaches it is the Next frontend proxy, which
      // forwards `x-forwarded-for` untouched rather than appending to it
      // (measured — see api/clientIp.js). So neither the header nor the socket
      // peer identifies the caller: the header is whatever the caller chose,
      // and the peer is always the proxy.
      //
      // Allowing the request would reinstate the bypass this check exists for.
      // Comparing the loopback address instead would be worse than useless: an
      // allow-list that happens to contain 127.0.0.1 would match EVERY caller.
      // So an IP-restricted key is refused with an error that says why, and the
      // operator has two real options — drop the restriction, or configure a
      // genuinely appending reverse proxy and set DDI_TRUSTED_PROXY_HOPS.
      if (Array.isArray(key.allowed_ips) && key.allowed_ips.length) {
        const { ip, trustworthy } = clientIpForAuthorization(req);
        if (!trustworthy) {
          console.warn(
            `[apiAuth] key "${key.name}" has an allowed_ips restriction, but the caller's address ` +
            `cannot be determined behind the frontend proxy (saw ${ip || 'nothing'}). Refusing. ` +
            `Set DDI_TRUSTED_PROXY_HOPS only if a reverse proxy in front genuinely APPENDS to x-forwarded-for.`
          );
          return sendErr(
            403,
            'IP_NOT_VERIFIABLE',
            'This key is restricted by IP address, but the caller\'s address cannot be verified on this deployment. Remove the IP restriction or configure a trusted forwarding proxy.'
          );
        }
        if (!key.allowed_ips.includes(ip)) {
          return sendErr(403, 'IP_NOT_ALLOWED', `Requests from ${ip} are not permitted for this key.`);
        }
      }

      // Permission check
      const perms = key.permissions || {};
      if (requiredPerm && !perms[requiredPerm] && !perms.admin) {
        return sendErr(403, 'INSUFFICIENT_PERMISSIONS', `This key lacks "${requiredPerm}" permission.`);
      }

      // Rate limit
      const rl = rateCheck(hash);
      res.set('X-RateLimit-Limit', String(rl.limit));
      res.set('X-RateLimit-Remaining', String(rl.remaining));
      res.set('X-RateLimit-Reset', String(Math.floor(rl.reset / 1000)));
      if (!rl.ok) return sendErr(429, 'RATE_LIMITED', `Rate limit of ${RATE_LIMIT} requests/hour exceeded.`);

      // Touch usage (fire-and-forget)
      db.query('UPDATE api_keys SET last_used_at = NOW(), request_count = request_count + 1 WHERE id = $1', [key.id]).catch(() => {});

      req.apiKey = key;
      next();
    } catch (err) {
      console.error('[apiAuth] error:', err.message);
      return sendErr(500, 'INTERNAL_ERROR', 'Internal authentication error.');
    }
  };
}

module.exports = { apiAuth, generateKey, sha256, maskedDisplay, KEY_PREFIX };
