'use strict';

/**
 * suiteSmtp.js — decide which SMTP transport this app sends through.
 *
 * Phase 2 of the suite SMTP centralization (see
 * `../../net-vault/docs/nocvault-smtp-centralization-plan.md`, §3 and §5).
 *
 * The NetVault hub owns ONE SMTP transport for the whole suite in
 * `netvault.smtp_config`. When that row exists, is `enabled` and has a host,
 * DDIVault sends through it. Otherwise DDIVault keeps using its OWN
 * `smtp_config` table exactly as it always has.
 *
 * ── How the hub config is read ──────────────────────────────────────────────
 * NOT over HTTP. Every satellite already holds a `netvault` pool (SSO + site
 * data), and the hub's password column is AES-256-GCM in the exact format
 * `collector/credStore.js` has always written — `ivHex:authTagHex:cipherHex`,
 * key = `sha256(NEXTAUTH_SECRET)` — and `NEXTAUTH_SECRET` is the same value in
 * all four apps because it is the SSO signing secret. So the read is a plain
 * cross-DB SELECT plus the decrypt helper this repo already ships. No new env
 * var, no new grant, no new crypto. (That also means this encryption defends
 * against a DB dump and the readonly diagnostic roles, NOT against a sibling
 * app — do not reason about it as app isolation.)
 *
 * ⛔ This pool is this module's OWN. `api/emailer.js` is required by BOTH
 * `api/server.js` (API process) and `collector/reportScheduler.js` (Collector
 * process), so it cannot reach for the API's `netvaultDb` pool — the collector
 * does not have one.
 *
 * ⛔ EVERY hub-side failure FAILS SOFT: fall back to the local `smtp_config`
 * row and warn exactly once. The conditions, all of which are realistic in the
 * field, are:
 *   - `NEXTAUTH_SECRET` (or `DDI_CRED_SECRET`) missing  -> cannot decrypt
 *   - Postgres `42P01 undefined_table`                  -> hub not yet updated
 *   - any other query / connection error                -> hub DB unreachable
 *   - the stored password does not decrypt              -> key or value changed
 * A hub that has not shipped its own Phase 1 yet is the NORMAL state during a
 * staged rollout, not an error, and a satellite must never degrade because of
 * it. `collector/credStore.js` deliberately THROWS at module load without the
 * secret — that is correct for this repo and stays — so this module requires it
 * lazily, behind a guard, and never adds a new reason for the collector to die.
 */

const { Pool } = require('pg');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches the cache this replaced

// { result, ts } — the whole resolution (local row + hub row + the choice).
let _cache = null;

// ⛔ ONE RESOLUTION AT A TIME, SHARED BY EVERY CONCURRENT CALLER.
//
// The TTL above bounds how OFTEN the hub is asked; it does nothing about how
// many callers ask AT ONCE, because it is only written once an answer exists.
// Every alert email, digest and scheduled report comes through here, and a
// burst of alerts lands in one tick — so a cold cache meant N simultaneous
// cross-DB lookups against a small pool with a short connect timeout. The ones
// that timed out each resolved to "the hub has no mail server", and the last to
// finish wrote that into the cache, holding this app on its local row for the
// next five minutes. The burst produced the fallback.
//
// Callers that arrive while a resolution is open await the SAME promise, and a
// rejection is not cached at all. `_generation` lets a save win a race with a
// resolution already in the air: invalidateSuiteSmtpCache() bumps it, and the
// stale resolution is handed to its waiters but may not become the cached one.
let _inflight = null;
let _generation = 0;

// ---------------------------------------------------------------------------
// Warn-once
// ---------------------------------------------------------------------------
// A fallback is a steady state, not an incident: the resolve path runs on every
// alert, digest and scheduled report, so an unconditional warn would flood the
// service log forever. One line per distinct cause, per process lifetime.
const _warned = new Set();
function warnOnce(key, detail) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(
    '[SuiteSMTP] ' + detail +
    ' — using this app\'s own smtp_config instead of the NetVault hub transport.'
  );
}

// ---------------------------------------------------------------------------
// credStore (lazy, guarded)
// ---------------------------------------------------------------------------
// undefined = not resolved yet, null = unavailable (soft fallback), else module.
let _cred;
function credStore() {
  if (_cred !== undefined) return _cred;
  if (!process.env.NEXTAUTH_SECRET && !process.env.DDI_CRED_SECRET) {
    // Guard BEFORE the require: credStore.js throws at module load without a
    // secret, by design. Requiring it here unguarded would turn a missing env
    // var into a dead collector.
    _cred = null;
    warnOnce('secret', 'NEXTAUTH_SECRET is not set, so the hub SMTP password cannot be decrypted');
    return _cred;
  }
  try {
    _cred = require('../collector/credStore');
  } catch (e) {
    _cred = null;
    warnOnce('credstore', 'the credential store could not be loaded (' + (e && e.message) + ')');
  }
  return _cred;
}

// ---------------------------------------------------------------------------
// Hub pool
// ---------------------------------------------------------------------------
// Same connection shape as api/middleware/rbac.js and collector/healthScorer.js
// (the `netvault` role, which owns the hub DB and can therefore read
// smtp_config — no grant change). Created lazily so merely requiring this
// module opens no sockets. Short timeouts: a slow hub DB must delay an alert
// email by seconds, never stall the send.
let _pool = null;
function hubPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    host:     process.env.NETVAULT_DB_HOST || 'localhost',
    port:     parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
    database: process.env.NETVAULT_DB_NAME || 'netvault',
    user:     process.env.NETVAULT_DB_USER || 'netvault',
    password: process.env.NETVAULT_DB_PASS || '',
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  // An idle-client error is emitted on the Pool; with no listener Node treats
  // it as an unhandled 'error' event and the process dies. The collector must
  // never die because the hub DB blipped.
  _pool.on('error', (err) => {
    warnOnce('pool', 'the NetVault hub connection pool reported an error (' + (err && err.message) + ')');
  });
  return _pool;
}

// ---------------------------------------------------------------------------
// Hub read — NEVER throws. Returns a usable config or null.
// ---------------------------------------------------------------------------
async function readHubConfig() {
  let r;
  try {
    r = await hubPool().query(
      `SELECT host, port, secure, username, password,
              from_email, from_name, enabled, allow_self_signed
         FROM smtp_config
        ORDER BY id
        LIMIT 1`
    );
  } catch (e) {
    if (e && e.code === '42P01') {
      // undefined_table — the hub has not been updated to the release that
      // owns suite SMTP. Expected during a staged rollout.
      warnOnce('no-table', 'the NetVault hub has no smtp_config table yet (hub not updated)');
    } else {
      // Keyed on the error code so a later, DIFFERENT cause (a revoked grant
      // after a transient connection failure, say) still gets its own line.
      warnOnce(
        'query:' + ((e && e.code) || 'unknown'),
        'the NetVault hub SMTP config could not be read (' + (e && e.message) + ')'
      );
    }
    return null;
  }

  // No row at all = the hub simply has no suite SMTP configured. That is the
  // default state on every install and is NOT worth a warning.
  if (!r || !r.rows || !r.rows.length) return null;

  const row = r.rows[0];
  // Precedence rule (plan §3): the hub wins only when it is switched on AND
  // actually points somewhere.
  if (!row.enabled) return null;
  const host = String(row.host == null ? '' : row.host).trim();
  if (!host) return null;

  let password = '';
  if (row.password) {
    const cs = credStore();
    if (!cs) return null; // already warned
    let plain = '';
    try {
      plain = cs.decrypt(row.password);
    } catch (e) {
      plain = '';
    }
    // credStore.decrypt swallows its own failure and returns '' — so an empty
    // result from a non-empty stored value IS the failure signal.
    if (!plain) {
      warnOnce('decrypt', 'the NetVault hub SMTP password could not be decrypted');
      return null;
    }
    password = plain;
  }

  return {
    host,
    port: Number(row.port) || 587,
    secure: !!row.secure,
    username: row.username || '',
    password,
    from_email: row.from_email || '',
    from_name: row.from_name || '',
    enabled: true,
    allow_self_signed: !!row.allow_self_signed,
  };
}

// ---------------------------------------------------------------------------
// Local read — the behaviour api/emailer.js's getSmtpConfig has always had.
// ---------------------------------------------------------------------------
// Deliberately NOT wrapped: a failure to read THIS app's own database is a real
// fault and has always propagated to the caller. Only the HUB half fails soft.
async function readLocalConfig(db) {
  const result = await db.query('SELECT * FROM smtp_config ORDER BY id LIMIT 1');
  if (!result || !result.rows || result.rows.length === 0) return null;

  const row = result.rows[0];

  let password = '';
  if (row.password) {
    const cs = credStore();
    if (cs) {
      try {
        password = cs.decrypt(row.password);
      } catch (e) {
        password = '';
      }
    }
  }

  return {
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password,
    from_email: row.from_email,
    from_name: row.from_name,
    enabled: row.enabled,
    source: 'local',
    // TLS verification for the LOCAL transport (Phase 5). Normalized to a real
    // boolean here so buildTransport's strict `=== true` test is the only rule
    // it needs — which also means a database that has not had the
    // scripts/schema.sql migration applied yet (column absent -> undefined)
    // reads as FALSE, i.e. verify. That is the safe direction and matches the
    // column's own default.
    allow_self_signed: row.allow_self_signed === true,
  };
}

// ---------------------------------------------------------------------------
// resolveSmtp
// ---------------------------------------------------------------------------
/**
 * @param {import('pg').Pool} db  this app's own pool
 * @returns {Promise<{source:'hub'|'local', cfg:object|null, hub?:object}>}
 *
 * `cfg` keeps exactly the shape `api/emailer.js`'s getSmtpConfig has always
 * returned — `host, port, secure, username, password, from_email, from_name,
 * enabled` — so no call site changes shape. Two additional fields ride along
 * for `buildTransport`, which only ever receives `cfg`:
 *   `source`            'hub' | 'local'
 *   `allow_self_signed` governs TLS verification. Present on BOTH paths since
 *                       Phase 5 — the hub's column for a hub transport, this
 *                       app's own column for a local one — and always a real
 *                       boolean.
 *
 * `hub` (present only when source === 'hub') is a password-free summary for the
 * Settings UI.
 */
async function resolveSmtp(db) {
  if (_cache && (Date.now() - _cache.ts) < CACHE_TTL_MS) return _cache.result;
  if (_inflight) return _inflight;

  const gen = _generation;
  const p = computeResolution(db)
    .then((result) => {
      if (gen === _generation) _cache = { result, ts: Date.now() };
      return result;
    })
    .finally(() => { if (_inflight === p) _inflight = null; });
  _inflight = p;
  return p;
}

async function computeResolution(db) {
  const local = await readLocalConfig(db);
  const hub = await readHubConfig(); // never throws

  let result;
  if (hub) {
    result = {
      source: 'hub',
      cfg: {
        // Transport — the hub owns these.
        host: hub.host,
        port: hub.port,
        secure: hub.secure,
        username: hub.username,
        password: hub.password,
        // ── FROM IDENTITY STAYS LOCAL ──────────────────────────────────────
        // Plan §3: centralize the transport, keep the sender identity per app.
        // "DDIVault Alerts" vs "LogVault Alerts" in a recipient's inbox is a
        // feature. The hub's From is used ONLY when this app has no row of its
        // own at all — otherwise mail from a fresh install would have no
        // sender address and would be rejected outright.
        from_email: (local && local.from_email) || hub.from_email,
        from_name: (local && local.from_name) || hub.from_name,
        // ── DELIVERY REMAINS THIS APP'S OWN SWITCH ─────────────────────────
        // `enabled` here answers "does DDIVault send mail", not "does a
        // transport exist". An admin who deliberately turned DDIVault's alert
        // email OFF must not start receiving it again merely because the hub
        // gained an SMTP server.
        //
        // ⛔ NO LOCAL ROW MEANS OFF, NOT ON. This used to fall back to the
        // hub's own `enabled` flag on the reasoning that an install with no row
        // has expressed no preference to respect. But the Settings page draws
        // its switch from `EMPTY_SENDER` (`enabled: false`) in exactly that
        // state — so a fresh install whose hub had a mail server showed the
        // admin a panel reading "Disabled" while this resolver told every sender
        // to go ahead. A control that says off while mail is being sent is worse
        // than either answer on its own, and between the two it is the UI that
        // is right: nobody has switched DDIVault's email on yet. Ticking the box
        // writes the row, and from then on the row decides.
        enabled: local ? !!local.enabled : false,
        source: 'hub',
        allow_self_signed: hub.allow_self_signed,
      },
      hub: {
        host: hub.host,
        port: hub.port,
        secure: hub.secure,
        username: hub.username,
        from_email: hub.from_email,
        from_name: hub.from_name,
        allow_self_signed: hub.allow_self_signed,
      },
    };
  } else {
    result = { source: 'local', cfg: local };
  }

  return result;
}

/**
 * Clear the cached resolution. `POST /api/smtp` calls this (through
 * `emailer.invalidateSmtpCache`) after a save, so an admin sees the effect of
 * an edit immediately rather than up to 5 minutes later.
 */
function invalidateSuiteSmtpCache() {
  _cache = null;
  // Bumping the generation is what stops a resolution already in flight from
  // writing its pre-save answer over the one the next caller will compute.
  _inflight = null;
  _generation += 1;
}

/** Close the hub pool on shutdown. No-op if it was never created. */
async function closeSuiteSmtpPool() {
  if (!_pool) return;
  const p = _pool;
  _pool = null;
  try {
    await p.end();
  } catch (e) {
    /* shutdown must never throw */
  }
}

module.exports = {
  resolveSmtp,
  invalidateSuiteSmtpCache,
  closeSuiteSmtpPool,
};
