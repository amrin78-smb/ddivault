'use strict';

/**
 * middlewareSessionRedirect.test.js — the page gate's no-session redirect must
 * carry the SSO re-entry `callbackUrl` ONLY when the browser presented no
 * session cookie at all.
 *
 * THE BUG BEING PINNED (pre-existing, not introduced by the sign-in work):
 *
 *   const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
 *   if (!token) {
 *     return NextResponse.redirect(`${hubUrl}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault`);
 *   }
 *
 * `getToken()` returns null for TWO different reasons and the caller cannot tell
 * them apart: no session cookie, or a session cookie it cannot READ. The second
 * is a realistic misconfiguration — next-auth v4 derives `secureCookie`, and
 * therefore the cookie NAME it looks for, from whether `NEXTAUTH_URL` starts
 * with `https://` (next-auth/jwt/index.js), and the suite installer writes an
 * `http://` value; a rotated `NEXTAUTH_SECRET` does it too.
 *
 * In that state the callbackUrl loops forever with no hop counter anywhere: hub
 * mints a token -> /sso sets the cookie -> / -> the gate still cannot read it ->
 * hub -> ERR_TOO_MANY_REDIRECTS. With NO callbackUrl the hub's login page falls
 * back to /launcher, so the misconfiguration stops somewhere visible.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

register(pathToFileURL(path.join(__dirname, 'helpers', 'middlewareModuleHooks.mjs')));

const MIDDLEWARE = path.join(__dirname, '..', 'frontend', 'src', 'middleware.ts');

// Set before the module loads — middleware.ts reads the env chain at module load.
process.env.NOCVAULT_HUB_URL = 'http://hub.example.com:3000';
process.env.NEXTAUTH_SECRET = 'test-secret-not-a-real-one';

const HUB = 'http://ddi.example.com:3000';   // request-derived, port 3000
const SSO_CALLBACK = '/api/sso/ddivault';

let mod;
let jwt;
async function load() {
  if (!mod) {
    jwt = await import(pathToFileURL(path.join(__dirname, 'helpers', 'next-auth-jwt-stub.mjs')).href);
    mod = await import(pathToFileURL(MIDDLEWARE).href);
  }
  return mod;
}

/**
 * A NextRequest stand-in. middleware.ts reads `nextUrl`, `headers`, `method` and
 * `cookies.getAll()` — the last is the only thing this test really varies.
 */
function req(url, cookieNames, headers) {
  const lower = new Map(Object.entries(headers || { host: 'ddi.example.com:3006' })
    .map(([k, v]) => [String(k).toLowerCase(), v]));
  return {
    method: 'GET',
    nextUrl: new URL(url),
    headers: {
      get: (k) => (lower.has(String(k).toLowerCase()) ? lower.get(String(k).toLowerCase()) : null),
      // NextResponse.rewrite copies req.headers; the api branch needs it iterable.
      entries: () => lower.entries(),
      [Symbol.iterator]: () => lower.entries(),
    },
    cookies: { getAll: () => (cookieNames || []).map((name) => ({ name, value: 'opaque' })) },
  };
}

/** Drive the page gate with `getToken()` forced to `token`. */
async function pageGate(request, token) {
  const { middleware } = await load();
  jwt.setToken(token);
  const res = await middleware(request);
  return { status: res.status, location: res.headers.get('location') };
}

// ── no cookie: "not signed in" is CERTAIN, so carry the callbackUrl ─────────

test('no cookies at all -> the SSO re-entry callbackUrl IS attached', async () => {
  const { location } = await pageGate(req('http://ddi.example.com:3006/', []), null);
  const u = new URL(location);
  assert.equal(u.origin + u.pathname, `${HUB}/login`);
  assert.equal(u.searchParams.get('callbackUrl'), SSO_CALLBACK);
});

test('unrelated cookies do not count as a session', async () => {
  // ⛔ next-auth sets several cookies of its own. Only the SESSION token means
  // "this browser believes it is signed in"; csrf/callback-url do not, and
  // treating them as a session would drop the callbackUrl for genuinely
  // sessionless users and cost them a stop at the launcher on every sign-in.
  const { location } = await pageGate(
    req('http://ddi.example.com:3006/', [
      'next-auth.csrf-token',
      'next-auth.callback-url',
      'ddivault-sidebar-collapsed',
    ]),
    null
  );
  assert.equal(new URL(location).searchParams.get('callbackUrl'), SSO_CALLBACK);
});

// ── cookie present but unreadable: the loop case ────────────────────────────

const PRESENT_SESSION_COOKIES = [
  ['the bare default name',               ['next-auth.session-token']],
  ['the __Secure- prefixed default name', ['__Secure-next-auth.session-token']],
  ['a chunked bare cookie',               ['next-auth.session-token.0', 'next-auth.session-token.1']],
  ['a chunked __Secure- cookie',          ['__Secure-next-auth.session-token.0']],
  ['a session cookie among others',       ['next-auth.csrf-token', '__Secure-next-auth.session-token', 'theme']],
];

for (const [label, cookies] of PRESENT_SESSION_COOKIES) {
  test(`an UNREADABLE session cookie (${label}) -> NO callbackUrl`, async () => {
    // getToken() -> null WITH a cookie on the request: the wrong-cookie-name /
    // rotated-secret state. Attaching a callbackUrl here is the redirect storm.
    const { location } = await pageGate(req('http://ddi.example.com:3006/settings', cookies), null);
    const u = new URL(location);
    assert.equal(u.origin + u.pathname, `${HUB}/login`);
    assert.equal(u.search, '', `callbackUrl attached to a looping redirect: ${location}`);
    assert.ok(!location.includes('callbackUrl'), `callbackUrl attached: ${location}`);
    assert.ok(!location.includes('sso'), `SSO re-entry path attached: ${location}`);
  });
}

test('a REALISTICALLY chunked session is seen — a bare has(name) check would miss it', async () => {
  // ⛔ THE CASE AN EXACT-NAME CHECK GETS WRONG. next-auth splits a session
  // cookie whose value exceeds 3933 bytes (ALLOWED_COOKIE_SIZE 4096 -
  // ESTIMATED_EMPTY_COOKIE_SIZE 163) into `<name>.0`, `<name>.1`, … and never
  // writes the base name at all, while getToken() reassembles them
  // transparently. So `cookies.has('next-auth.session-token')` is FALSE for a
  // session that genuinely exists — and a chunked-and-unreadable session would
  // fall straight back into the loop. A large `apps` claim is what pushes ours
  // over.
  const CHUNK_SIZE = 4096 - 163;
  const chunks = Math.ceil((CHUNK_SIZE * 2 + 100) / CHUNK_SIZE); // a 3-chunk session
  const cookies = Array.from({ length: chunks }, (_, i) => `next-auth.session-token.${i}`);
  assert.equal(chunks, 3, 'the fixture must really be multi-chunk');
  assert.ok(!cookies.includes('next-auth.session-token'), 'chunking does not write the base name');

  const { location } = await pageGate(req('http://ddi.example.com:3006/', cookies), null);
  assert.equal(new URL(location).search, '', `a chunked session was treated as no session: ${location}`);
});

// ── the rest of the gate is unchanged ──────────────────────────────────────

test('a readable session still passes through', async () => {
  const { status, location } = await pageGate(
    req('http://ddi.example.com:3006/', ['next-auth.session-token']),
    { email: 'user@example.com', role: 'admin' }
  );
  assert.equal(status, 200);
  assert.equal(location, null, 'an authenticated page request must not redirect');
});

test('a denied app-access claim still goes to the hub launcher', async () => {
  const { location } = await pageGate(
    req('http://ddi.example.com:3006/', ['next-auth.session-token']),
    { email: 'user@example.com', apps: ['netvault', 'logvault'] }
  );
  assert.equal(location, `${HUB}/launcher?denied=ddivault`);
});

// ── the /api/* branch needs no guard, and this says why ────────────────────

test('the /api/* branch answers a flat 401 — it cannot loop, with or without a cookie', async () => {
  for (const cookies of [[], ['next-auth.session-token'], ['__Secure-next-auth.session-token.0']]) {
    const { middleware } = await load();
    jwt.setToken(null);
    const res = await middleware(req('http://ddi.example.com:3006/api/scopes', cookies));
    assert.equal(res.status, 401, 'an unreadable session on /api/* must stay a terminal 401');
    assert.equal(res.headers.get('location'), null, 'the API branch must never redirect');
    assert.deepEqual(await res.json(), { error: 'Unauthorized' });
  }
});
