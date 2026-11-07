'use strict';

/**
 * clientIp.test.js — the X-Forwarded-For spoofing bypass.
 *
 * PRE-FIX BEHAVIOUR being pinned down here: `clientIp` lived twice, in
 * api/middleware/apiAuth.js and api/middleware/audit.js, and both read
 *
 *     String(req.headers['x-forwarded-for']).split(',')[0].trim()
 *
 * i.e. the hop the CALLER supplied. Every test below that sends a forged
 * leftmost entry FAILS against that implementation: it returns the forged value
 * where these assert the real one. (Checked by hand against the old two-line
 * body — e.g. `'203.0.113.9, 198.51.100.7'` returned `'203.0.113.9'`, which is
 * exactly the value an IP-restricted API key would have declared for itself.)
 */

const test = require('node:test');
const assert = require('node:assert');

const { clientIp, clientIpForAuthorization, isLoopback, normalizeIp, trustedHops, DEFAULT_TRUSTED_HOPS } = require('../api/clientIp');

/** Minimal request stand-in. */
function req(headers, remoteAddress) {
  return { headers: headers || {}, socket: { remoteAddress } };
}

test('DEFAULT: x-forwarded-for cannot influence the answer at all', () => {
  // ⛔ THIS REPLACES THREE TESTS THAT ENCODED A FALSE PREMISE. They asserted a
  // trusted proxy APPENDS the address it accepted, so the rightmost hop was the
  // real client. Measured against the real Next 14.2.35 middleware rewrite,
  // that is not what happens: Next forwards x-forwarded-for UNTOUCHED when the
  // caller supplies one and only sets it when absent. So every entry in the
  // header is attacker-chosen, the rightmost included, and the old default of
  // one trusted hop made the whole module a no-op against the bypass.
  //
  // The worst of the three was literally named "a single-hop header is the
  // client" and asserted that `X-Forwarded-For: 10.1.1.1` resolves to
  // 10.1.1.1 — i.e. it asserted the forgery.
  for (const forged of [
    '10.1.1.1',                                  // the single-entry forgery
    '10.1.1.1, 203.0.113.55',                    // forged-then-real
    '10.1.1.1, 10.1.1.1, 10.1.1.1',              // many forged hops
    '203.0.113.55, 10.1.1.1',                    // forged last
  ]) {
    assert.strictEqual(
      clientIp(req({ 'x-forwarded-for': forged }, '127.0.0.1'), {}),
      '127.0.0.1',
      `header "${forged}" must be ignored`
    );
  }
});

test('an array-form header is also ignored by default', () => {
  assert.strictEqual(
    clientIp(req({ 'x-forwarded-for': ['10.1.1.1', '10.2.2.2'] }, '127.0.0.1'), {}),
    '127.0.0.1'
  );
});

test('IPv4-mapped IPv6 from the socket is reduced to what an admin would type', () => {
  assert.strictEqual(clientIp(req({}, '::ffff:203.0.113.55'), {}), '203.0.113.55');
});

test('an appending proxy can still be opted into explicitly', () => {
  // The only configuration in which a header entry is trustworthy. Counted
  // from the right, so a prepended forgery is ignored.
  const env = { DDI_TRUSTED_PROXY_HOPS: '1' };
  assert.strictEqual(
    clientIp(req({ 'x-forwarded-for': '10.1.1.1, 203.0.113.55' }, '127.0.0.1'), env),
    '203.0.113.55'
  );
});



test('no x-forwarded-for at all: the socket peer', () => {
  assert.strictEqual(clientIp(req({}, '203.0.113.1'), {}), '203.0.113.1');
});


test('DDI_TRUSTED_PROXY_HOPS=0 ignores the header entirely', () => {
  const ip = clientIp(
    req({ 'x-forwarded-for': '10.1.1.1, 203.0.113.55' }, '127.0.0.1'),
    { DDI_TRUSTED_PROXY_HOPS: '0' },
  );
  assert.strictEqual(ip, '127.0.0.1');
});

test('DDI_TRUSTED_PROXY_HOPS=2 counts two trusted hops from the right', () => {
  // client -> extra reverse proxy -> frontend -> us. XFF reads
  // `<forged>, <client>, <reverse proxy>`; two appending proxies means the
  // client sits two from the right.
  const ip = clientIp(
    req({ 'x-forwarded-for': '10.1.1.1, 203.0.113.55, 192.168.6.50' }, '127.0.0.1'),
    { DDI_TRUSTED_PROXY_HOPS: '2' },
  );
  assert.strictEqual(ip, '203.0.113.55');
});

test('fails closed when the header has fewer hops than the trusted chain', () => {
  // Declared 2 trusted hops but only one entry arrived → this did not come
  // through the chain we were told to expect, so the header is discarded.
  const ip = clientIp(
    req({ 'x-forwarded-for': '10.1.1.1' }, '127.0.0.1'),
    { DDI_TRUSTED_PROXY_HOPS: '2' },
  );
  assert.strictEqual(ip, '127.0.0.1');
});

test('an empty / junk-only header falls back to the socket peer', () => {
  assert.strictEqual(clientIp(req({ 'x-forwarded-for': '' }, '127.0.0.1'), {}), '127.0.0.1');
  assert.strictEqual(clientIp(req({ 'x-forwarded-for': ' , , ' }, '127.0.0.1'), {}), '127.0.0.1');
});

test('nothing knowable at all returns null, so an allow-list cannot match', () => {
  assert.strictEqual(clientIp({ headers: {} }, {}), null);
  assert.strictEqual(clientIp({ headers: {}, socket: {} }, {}), null);
});


test('normalizeIp strips ports and brackets but leaves a bare IPv6 alone', () => {
  assert.strictEqual(normalizeIp(' 203.0.113.9 '), '203.0.113.9');
  assert.strictEqual(normalizeIp('203.0.113.9:51234'), '203.0.113.9');
  assert.strictEqual(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.strictEqual(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.strictEqual(normalizeIp(''), null);
  assert.strictEqual(normalizeIp(null), null);
  assert.strictEqual(normalizeIp(undefined), null);
});

test('trustedHops: default 0, and junk/negative values do not silently enable trust', () => {
  assert.strictEqual(DEFAULT_TRUSTED_HOPS, 0);
  assert.strictEqual(trustedHops({}), 0);
  assert.strictEqual(trustedHops({ DDI_TRUSTED_PROXY_HOPS: '' }), 0);
  assert.strictEqual(trustedHops({ DDI_TRUSTED_PROXY_HOPS: 'abc' }), 0);
  assert.strictEqual(trustedHops({ DDI_TRUSTED_PROXY_HOPS: '-3' }), 0);
  assert.strictEqual(trustedHops({ DDI_TRUSTED_PROXY_HOPS: '2' }), 2);
});

test('clientIpForAuthorization reports the loopback proxy as NOT trustworthy', () => {
  // The normal deployed case: behind the frontend proxy, with the header
  // ignored, the peer is the proxy. That is "we do not know who this is", and
  // it must never be compared against an allow-list as though it were 127.0.0.1
  // -- an allow-list containing 127.0.0.1 would then match every caller.
  const a = clientIpForAuthorization(req({ 'x-forwarded-for': '10.1.1.1' }, '127.0.0.1'), {});
  assert.strictEqual(a.trustworthy, false);
  const b = clientIpForAuthorization(req({}, '::1'), {});
  assert.strictEqual(b.trustworthy, false);
  // A real peer, reached directly, IS usable.
  const c = clientIpForAuthorization(req({}, '203.0.113.55'), {});
  assert.deepStrictEqual([c.ip, c.trustworthy], ['203.0.113.55', true]);
  // And so is an explicitly trusted appending proxy.
  const d = clientIpForAuthorization(
    req({ 'x-forwarded-for': '10.1.1.1, 203.0.113.55' }, '127.0.0.1'),
    { DDI_TRUSTED_PROXY_HOPS: '1' });
  assert.deepStrictEqual([d.ip, d.trustworthy], ['203.0.113.55', true]);
  assert.strictEqual(isLoopback('127.0.0.9'), true);
  assert.strictEqual(isLoopback('203.0.113.55'), false);
});

// ── Both real call sites, end to end ─────────────────────────────────────────
// Neither of these middlewares needs express, a server or a database — only a
// `db.query` stub — so the bypass is testable where it actually mattered rather
// than only on the helper.

const { apiAuth } = require('../api/middleware/apiAuth');
const { auditContext } = require('../api/middleware/audit');

function fakeRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

/** A db stub that answers the api_keys lookup with `key` and swallows the rest. */
function keyDb(key) {
  return {
    query: async (sql) => {
      if (/FROM api_keys/.test(sql)) return { rows: key ? [key] : [] };
      return { rows: [] };
    },
  };
}

const RESTRICTED_KEY = {
  id: 1,
  name: 'test',
  is_active: true,
  expires_at: null,
  // 32 random url-safe chars after the prefix — only the hash matters, and the
  // stub answers any hash.
  allowed_ips: ['10.1.1.1'],
  permissions: { read: true },
};

async function runApiAuth(headers, remoteAddress, allowedIps) {
  const key = allowedIps
    ? Object.assign({}, RESTRICTED_KEY, { allowed_ips: allowedIps })
    : RESTRICTED_KEY;
  const mw = apiAuth(keyDb(key), 'read');
  const req = {
    headers: Object.assign({ 'x-api-key': 'ddiv_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, headers),
    socket: { remoteAddress },
  };
  const res = fakeRes();
  let passed = false;
  await mw(req, res, () => { passed = true; });
  return { passed, res };
}

test('apiAuth: a forged X-Forwarded-For no longer satisfies allowed_ips', async () => {
  // The finding verbatim: a holder of a key restricted to 10.1.1.1, calling
  // from elsewhere and declaring itself to be at 10.1.1.1. Every forgery shape
  // must be refused -- including the single-entry one, which is the shape the
  // frontend proxy forwards untouched.
  for (const forged of ['10.1.1.1', '10.1.1.1, 203.0.113.55', '203.0.113.55, 10.1.1.1']) {
    const { passed, res } = await runApiAuth({ 'x-forwarded-for': forged }, '127.0.0.1');
    assert.strictEqual(passed, false, `"${forged}" must NOT authenticate`);
    assert.strictEqual(res.statusCode, 403);
    // Behind the proxy the address is not knowable, so the refusal says so
    // rather than blaming an address it cannot see.
    assert.strictEqual(res.body.error.code, 'IP_NOT_VERIFIABLE');
  }
});

test('apiAuth: an IP-restricted key is refused outright behind the proxy', async () => {
  // Fail closed, and do NOT compare the loopback peer: an allow-list that
  // happened to contain 127.0.0.1 would otherwise match every caller.
  const { passed, res } = await runApiAuth({}, '127.0.0.1');
  assert.strictEqual(passed, false);
  assert.strictEqual(res.body.error.code, 'IP_NOT_VERIFIABLE');
  const loopbackAllowed = await runApiAuth({}, '127.0.0.1', ['127.0.0.1']);
  assert.strictEqual(loopbackAllowed.passed, false, 'allow-listing 127.0.0.1 must NOT allow everyone');
});

test('apiAuth: a genuine call from an allowed address still passes', async () => {
  // Only reachable where the address really is knowable: either the API is
  // called directly, or a genuinely appending proxy is declared.
  const direct = await runApiAuth({}, '10.1.1.1');
  assert.strictEqual(direct.passed, true,
    `direct call expected to pass, got ${direct.res.statusCode} ${JSON.stringify(direct.res.body)}`);

  process.env.DDI_TRUSTED_PROXY_HOPS = '1';
  try {
    const viaProxy = await runApiAuth({ 'x-forwarded-for': '203.0.113.9, 10.1.1.1' }, '127.0.0.1');
    assert.strictEqual(viaProxy.passed, true,
      `declared appending proxy expected to pass, got ${viaProxy.res.statusCode}`);
  } finally {
    delete process.env.DDI_TRUSTED_PROXY_HOPS;
  }
});

test('apiAuth: an unresolvable address fails the allow-list closed', async () => {
  const mw = apiAuth(keyDb(RESTRICTED_KEY), 'read');
  const req = { headers: { 'x-api-key': 'ddiv_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } };
  const res = fakeRes();
  let passed = false;
  await mw(req, res, () => { passed = true; });
  assert.strictEqual(passed, false);
  assert.strictEqual(res.statusCode, 403);
});

test('audit: the recorded source IP is never the caller-declared one', async () => {
  const writes = [];
  const db = {
    query: async (sql, params) => { writes.push({ sql, params }); return { rows: [{ id: 7 }] }; },
  };
  const req = {
    headers: { 'x-forwarded-for': '10.1.1.1, 203.0.113.55', 'x-ddi-actor': 'alice' },
    socket: { remoteAddress: '127.0.0.1' },
    method: 'GET',
    path: '/api/leases',
  };
  auditContext(db)(req, { on: () => {} }, () => {});
  await req.audit({ action: 'create', entity_type: 'dns_zone', entity_name: 'z' });

  assert.strictEqual(writes.length, 1);
  // writeAudit's bind order: ...(9) change_summary, (10) ip_address, (11) user_agent...
  const ip = writes[0].params[10];
  // ⛔ The honest value. Behind the frontend proxy this is the proxy's own
  // address, which is truthful and un-forgeable -- an audit trail of
  // caller-chosen IPs is worse than one that records the hop it can actually
  // see. Capturing the browser's address properly needs the proxy to derive
  // and stamp a header after deleting any inbound copy (the pattern it already
  // uses for x-ddi-actor*); that is a separate change.
  assert.strictEqual(ip, '127.0.0.1');
  assert.notStrictEqual(ip, '10.1.1.1', 'an audit trail of forged IPs is worse than none');
  assert.notStrictEqual(ip, '203.0.113.55', 'the rightmost hop is caller-chosen too');
});
