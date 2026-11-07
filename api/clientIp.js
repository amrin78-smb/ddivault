'use strict';

/**
 * clientIp.js — resolve the caller's real IP for an API that sits BEHIND a proxy.
 *
 * ⛔ WHY THIS IS NOT `String(x-forwarded-for).split(',')[0]`.
 *
 * `x-forwarded-for` is built by APPENDING: each proxy appends the address it
 * received the request from. So for `client -> p1 -> ... -> pN -> us`, a
 * correctly-built header reads `client, p1, …, pN-1` — and the LEFTMOST entry is
 * the client only if the client sent no header of its own. It can:
 *
 *     X-Forwarded-For: 10.0.0.5            (a value the caller simply made up)
 *
 * arrives as `10.0.0.5, <the caller's real address>`, and reading index 0 hands
 * back the forged value. That is exactly how the `api_keys.allowed_ips`
 * restriction was bypassable (`api/middleware/apiAuth.js`) and how audit-log
 * source IPs were forgeable (`api/middleware/audit.js`): a holder of an
 * IP-restricted key just declared itself to be at an allowed address.
 *
 * The only non-forgeable entries are the ones the TRUSTED proxies appended, so
 * the client address is counted from the RIGHT, not the left:
 *
 *     hops[hops.length - TRUSTED_HOPS]
 *
 * With one trusted proxy that is the last hop. Anything the caller prepended
 * sits to the left of it and is ignored.
 *
 * ── Why the default is 0, i.e. the header is IGNORED ─────────────────────────
 * ⛔ MEASURED, NOT ASSUMED. An earlier version of this file defaulted to 1 hop
 * on the stated premise that "Next.js proxies the external rewrite with xfwd
 * enabled, so it appends the socket address it saw". **That is false**, and it
 * made this whole module a no-op against the attack it exists to stop.
 *
 * Tested end to end against the real `frontend/src/middleware.ts` rewrite
 * (Next 14.2.35, `NextResponse.rewrite(target, { request: { headers } })`),
 * reading what Express actually received:
 *
 *   client sends `X-Forwarded-For: 10.0.0.5`   → Express sees `10.0.0.5`
 *   client sends `10.0.0.5, 10.0.0.6`          → Express sees both, verbatim
 *   client sends nothing                       → Express sees `::ffff:127.0.0.1`
 *
 * So Next SETS the header when it is absent and forwards it UNTOUCHED when it is
 * present. It never appends. There is therefore **no trustworthy hop in the
 * header at all**: with 1 trusted hop, a single-entry forgery makes
 * `hops[length - 1]` the forged entry itself.
 *
 * And the socket peer cannot substitute for it, because this API binds loopback
 * and the only thing that reaches it is the frontend proxy — every caller
 * presents as 127.0.0.1.
 *
 * The honest conclusion: **as deployed, the real client address is not knowable
 * here.** The default is therefore 0 — ignore the header entirely, so nothing a
 * caller sends can influence an authorization decision — and anything that
 * needs a real client address must treat it as INDETERMINATE rather than
 * compare 127.0.0.1 as though it were the caller. See
 * `clientIpForAuthorization` below and its single caller in
 * `api/middleware/apiAuth.js`.
 *
 * Making `api_keys.allowed_ips` genuinely enforceable requires the frontend
 * proxy to DERIVE the peer address and stamp it into a header of its own, after
 * deleting any inbound copy — exactly the pattern `middleware.ts` already uses
 * for `x-ddi-actor*`. That is a deliberate change with installer parity, not a
 * one-line default flip, and it is not done here.
 *
 * `DDI_TRUSTED_PROXY_HOPS` opts in for a deployment that really does sit behind
 * an appending reverse proxy:
 *   0  → (default) ignore `x-forwarded-for`; use the socket peer.
 *   N>0 → N trusted, APPENDING proxies in front. Only set this if you have
 *        verified they append; getting it wrong re-opens the bypass.
 *
 * Fail closed: when the header carries FEWER hops than the configured trusted
 * chain, the request did not traverse the chain we were told to expect, so the
 * header is discarded and the socket peer is used.
 *
 * No dependencies on purpose — this is security-relevant logic and it is unit
 * tested in `tests/clientIp.test.js` without a DB, an HTTP server or express.
 */

/** Default trusted-hop count: NONE. See the header — Next does not append. */
const DEFAULT_TRUSTED_HOPS = 0;

/**
 * Canonical string form of an address: no surrounding whitespace, no `[...]`
 * brackets, no `:port` suffix on an IPv4 address, and IPv4-mapped IPv6
 * (`::ffff:10.0.0.5`) reduced to its IPv4 form so it compares equal to what an
 * admin typed into `allowed_ips`.
 */
function normalizeIp(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return null;

  // `[2001:db8::1]:443` → `2001:db8::1`
  if (s[0] === '[') {
    const close = s.indexOf(']');
    if (close > 0) s = s.slice(1, close);
  } else {
    // Exactly ONE colon, with dots → `10.0.0.5:51234`. A bare IPv6 address has
    // several colons and no dots, so it is left alone; and the colon must
    // actually be present (`indexOf === lastIndexOf` is also true at -1, which
    // once truncated the final character off every plain IPv4 address).
    const colon = s.indexOf(':');
    if (colon !== -1 && colon === s.lastIndexOf(':') && s.indexOf('.') !== -1) {
      s = s.slice(0, colon);
    }
  }

  // ::ffff:10.0.0.5  /  ::FFFF:10.0.0.5
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(s);
  if (mapped) s = mapped[1];

  s = s.trim();
  return s || null;
}

/** Parsed `DDI_TRUSTED_PROXY_HOPS`, or the default when unset/unusable. */
function trustedHops(env) {
  const raw = (env && env.DDI_TRUSTED_PROXY_HOPS) != null
    ? String(env.DDI_TRUSTED_PROXY_HOPS).trim()
    : '';
  if (raw === '') return DEFAULT_TRUSTED_HOPS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_TRUSTED_HOPS;
  return n;
}

/** The address the socket itself was opened from. */
function socketIp(req) {
  const raw = (req && req.socket && req.socket.remoteAddress) || (req && req.ip) || null;
  return normalizeIp(raw);
}

/**
 * Resolve the caller's IP.
 *
 * @param req   anything with `.headers` and (optionally) `.socket.remoteAddress`
 * @param env   injectable so the trusted-hop count is testable without mutating
 *              process.env — this feeds an authorization decision, and a test
 *              that has to set process.env leaks into every other test.
 * @returns a normalized address string, or null when nothing is knowable.
 */
function clientIp(req, env) {
  const peer = socketIp(req);
  const hopCount = trustedHops(env || process.env);

  // 0 trusted hops → the header cannot influence the answer at all.
  if (hopCount === 0) return peer;

  const headers = (req && req.headers) || {};
  const fwd = headers['x-forwarded-for'];
  if (!fwd) return peer;

  const hops = (Array.isArray(fwd) ? fwd.join(',') : String(fwd))
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);

  // Fewer hops than the trusted chain should have produced → not our chain.
  if (hops.length < hopCount) return peer;

  return hops[hops.length - hopCount] || peer;
}

/** Is this a loopback address, i.e. "the proxy in front of us", not a caller? */
function isLoopback(ip) {
  if (!ip) return false;
  return ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/**
 * The caller's address for an AUTHORIZATION decision, with an explicit
 * trustworthiness flag.
 *
 * ⛔ `trustworthy: false` means "we do not know who this is" and MUST be
 * treated as a failure by any caller enforcing an address restriction — never
 * as "the caller is 127.0.0.1". Comparing the loopback address against
 * `allowed_ips` would silently turn an allow-list containing 127.0.0.1 into
 * "allow everyone", and an allow-list without it into an error message that
 * blames the wrong address.
 */
function clientIpForAuthorization(req, env) {
  const hops = trustedHops(env || process.env);
  const ip = clientIp(req, env);
  // With no trusted hops we are reading the socket peer. Behind the frontend
  // proxy that is the proxy itself, which tells us nothing about the caller.
  if (hops === 0 && isLoopback(ip)) return { ip, trustworthy: false };
  if (!ip) return { ip: null, trustworthy: false };
  return { ip, trustworthy: true };
}

module.exports = {
  clientIp,
  clientIpForAuthorization,
  isLoopback,
  normalizeIp,
  trustedHops,
  DEFAULT_TRUSTED_HOPS,
};
