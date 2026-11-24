'use strict';

/**
 * authSignInRedirect.test.js — the sign-in redirect must follow the REQUEST,
 * never the env var.
 *
 * PRE-FIX BEHAVIOUR being pinned here, measured on production:
 *
 *   GET /api/auth/signin  ->  302
 *   Location: http://127.0.0.1:13000/login?callbackUrl=https%3A%2F%2F<host>%3A3006
 *
 * `frontend/src/lib/auth.ts` built `pages: { signIn: `${HUB_URL}/login` }`, and
 * NextAuth v4 evaluates `pages` ONCE at module load — so the redirect could
 * never follow the request the way middleware.ts's resolveOrigin() does. HUB_URL
 * is the hub's SERVER-SIDE loopback on purpose (the sso-verify fetch must not go
 * through the public TLS front door), so a browser was being sent to a loopback
 * port on its own machine.
 *
 * `pages.signIn` is now the local relative path `/auth/signin`, and
 * `frontend/src/app/auth/signin/route.ts` does the cross-origin hop per request.
 * Every assertion below fails against the old module-load constant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// The route is frontend TypeScript importing `next/server` and `@/lib/publicUrl`;
// these hooks make both resolvable under bare node. See tests/helpers/.
register(pathToFileURL(path.join(__dirname, 'helpers', 'frontendModuleHooks.mjs')));

const ROUTE = path.join(__dirname, '..', 'frontend', 'src', 'app', 'auth', 'signin', 'route.ts');

// The loopback value production really had. If any assertion below sees this
// host in a redirect, the fix has regressed.
const ENV_LOOPBACK = 'http://127.0.0.1:13000';
process.env.NOCVAULT_HUB_URL = ENV_LOOPBACK;
process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL = ENV_LOOPBACK;

// The hub's SSO re-entry path — the only callbackUrl this route ever sends.
const HUB_CALLBACK = '/api/sso/ddivault';

let route;
async function loadRoute() {
  if (!route) route = await import(pathToFileURL(ROUTE).href);
  return route;
}

/**
 * A NextRequest stand-in. The route reads only `headers.get(...)` and
 * `nextUrl` (searchParams / origin / protocol — a real URL supplies all three,
 * so this is the genuine parsing behaviour).
 */
function req(url, headers) {
  const lower = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (k) => (lower.has(String(k).toLowerCase()) ? lower.get(String(k).toLowerCase()) : null) },
    nextUrl: new URL(url),
  };
}

async function locationOf(request) {
  const { GET } = await loadRoute();
  const res = await GET(request);
  assert.equal(res.status, 307, 'sign-in bounce must be a 307');
  return res.headers.get('location');
}

// ── the bug itself ──────────────────────────────────────────────────────────

test('a public forwarded host is redirected to THAT host on :3000, not to the env var', async () => {
  const loc = await locationOf(
    req('https://ddi.example.com:3006/auth/signin', {
      host: 'ddi.example.com:3006',
      'x-forwarded-host': 'ddi.example.com:3006',
      'x-forwarded-proto': 'https',
    })
  );
  const u = new URL(loc);
  assert.equal(u.origin, 'https://ddi.example.com:3000');
  assert.equal(u.pathname, '/login');
  assert.ok(!loc.includes('127.0.0.1'), `env-var loopback leaked into ${loc}`);
});

test('a plain Host header (no proxy headers) is honoured too', async () => {
  const loc = await locationOf(req('http://ddi.example.com:3006/auth/signin', { host: 'ddi.example.com:3006' }));
  assert.equal(new URL(loc).origin, 'http://ddi.example.com:3000');
});

test('no usable Host falls back to the env chain — never worse than before', async () => {
  // resolveOrigin()'s documented contract: the legacy env var is the LAST
  // resort, used only when the request carries no usable host.
  const loc = await locationOf(req('http://127.0.0.1:3006/auth/signin', { host: '' }));
  assert.equal(new URL(loc).origin, ENV_LOOPBACK);
});

// ── the callbackUrl contract ────────────────────────────────────────────────

test('the callbackUrl is exactly the hub SSO re-entry path', async () => {
  // ⛔ A CONSTANT, not derived from the request. The hub's login page honours a
  // callbackUrl only when it is hub-relative (`startsWith('/')`, not `//`,
  // `/sso` or `/login`) and otherwise falls back to `/launcher`, so a sanitised
  // absolute DDIVault URL would be work the hub throws away — and the user
  // would stop off at the launcher instead of landing back in DDIVault. This is
  // what middleware.ts's page gate already sends.
  const loc = await locationOf(
    req('https://ddi.example.com:3006/auth/signin', {
      host: 'ddi.example.com:3006',
      'x-forwarded-proto': 'https',
    })
  );
  assert.equal(new URL(loc).searchParams.get('callbackUrl'), HUB_CALLBACK);
  assert.equal(
    loc,
    'https://ddi.example.com:3000/login?callbackUrl=' + encodeURIComponent(HUB_CALLBACK)
  );
});

test('a client-supplied callbackUrl is IGNORED — a foreign host cannot appear at all', async () => {
  // ⛔ TRUE BY CONSTRUCTION, WHICH IS THE POINT. Nothing in the route parses the
  // incoming value, so there is no sanitiser to get wrong and no open-redirect
  // surface to reason about: the hub callbackUrl is a constant. These are the
  // shapes that would have mattered if the value were carried forward.
  for (const hostile of [
    'https://evil.example.net/steal?a=1',
    '//evil.example.net/x',
    'http://user:pw@evil.example.net/',
    'javascript:alert(1)',
    '/api/sso/ddivault@evil.example.net',
  ]) {
    const loc = await locationOf(
      req('https://ddi.example.com:3006/auth/signin?callbackUrl=' + encodeURIComponent(hostile), {
        host: 'ddi.example.com:3006',
        'x-forwarded-proto': 'https',
      })
    );
    assert.ok(!loc.includes('evil.example.net'), `foreign host survived into ${loc}`);
    assert.ok(!loc.toLowerCase().includes('javascript'), `scheme survived into ${loc}`);
    assert.equal(new URL(loc).searchParams.get('callbackUrl'), HUB_CALLBACK);
  }
});

test('an extra query parameter on the request cannot add a second callbackUrl', async () => {
  const loc = await locationOf(
    req('https://ddi.example.com:3006/auth/signin?callbackUrl=%2Fa&callbackUrl=%2Fb&error=CredentialsSignin', {
      host: 'ddi.example.com:3006',
      'x-forwarded-proto': 'https',
    })
  );
  assert.deepEqual(new URL(loc).searchParams.getAll('callbackUrl'), [HUB_CALLBACK]);
  assert.equal(new URL(loc).searchParams.has('error'), false, 'only the login hop is passed on');
});

// ── the two wiring facts the route depends on ───────────────────────────────

test('pages.signIn stays LOCAL and RELATIVE (a hub URL there is the original bug)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'lib', 'auth.ts'), 'utf8');
  const m = src.match(/pages:\s*\{[\s\S]*?signIn:\s*(['"`])([^'"`]*)\1/);
  assert.ok(m, 'pages.signIn not found in frontend/src/lib/auth.ts');
  assert.equal(m[2], '/auth/signin');
  assert.ok(!m[2].includes('HUB_URL') && !/^https?:/.test(m[2]), 'pages.signIn must not be an absolute/hub URL');
});

test('middleware.ts does NOT gate /auth/signin (a gated route would never run)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'middleware.ts'), 'utf8');
  // The page-route matcher is the one with the (?!...) exclusion list.
  const m = src.match(/'(\/\(\(\?![^']+\)\.\*\))'/);
  assert.ok(m, 'page matcher not found in middleware.ts');
  const matcher = new RegExp('^' + m[1] + '$');
  assert.equal(matcher.test('/auth/signin'), false, 'the sign-in bounce is gated — it would loop');
  // ...while real pages stay gated.
  assert.equal(matcher.test('/'), true);
  assert.equal(matcher.test('/settings'), true);
});
