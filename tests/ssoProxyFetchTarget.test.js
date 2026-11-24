'use strict';

/**
 * ssoProxyFetchTarget.test.js — `POST /api/sso` must fetch the CONFIGURED hub,
 * never a host named by the caller, and must not reflect the hub's answer back.
 *
 * WHY THIS ROUTE AND NOT ANOTHER: middleware.ts's matcher
 * `'/api/((?!auth(?:/|$)|sso$).+)'` excludes `/api/sso` exactly, so this handler
 * runs with NO SESSION for anyone who can reach port 3006 (asserted below, so
 * the premise cannot rot silently).
 *
 * PRE-FIX BEHAVIOUR being pinned here:
 *
 *   const hubUrl = resolveOrigin(req, 3000, HUB_URL_FALLBACK);
 *   await fetch(`${hubUrl}/api/auth/sso-verify`, ...)
 *
 * `resolveOrigin` derives its host from `x-forwarded-host`/`host` and validates
 * SHAPE only (`HOSTNAME_RE` accepts dotted IPv4) — so the caller chose the
 * target, and all three exits handed the result back: the success branch
 * returned the hub's body verbatim, the `!res.ok` branch returned
 * `sso-verify failed: ${status} ${text}`, and the catch returned `err.message`.
 *
 * `resolveOrigin` itself is CORRECT for the browser redirects it exists for and
 * is deliberately untouched — the fix is in the fetch SINK. See
 * .ai-codex/gotchas.md and spanvault's `pickHubFetchOrigin`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// The route is frontend TypeScript importing `next/server`; this hook makes it
// resolvable under bare node. See tests/helpers/.
register(pathToFileURL(path.join(__dirname, 'helpers', 'frontendModuleHooks.mjs')));

const ROUTE_PATH = path.join(__dirname, '..', 'frontend', 'src', 'app', 'api', 'sso', 'route.ts');

// The ONLY origin this process may ever POST sso-verify to. Set before the
// module is imported — the route reads the env chain once, at module load, the
// same way `frontend/src/lib/auth.ts` does.
const CONFIGURED_HUB = 'http://hub.example.com:3000';
process.env.NOCVAULT_HUB_URL = CONFIGURED_HUB;
process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL = CONFIGURED_HUB;

let route;
async function loadRoute() {
  if (!route) route = await import(pathToFileURL(ROUTE_PATH).href);
  return route;
}

/**
 * A NextRequest stand-in. The route reads `headers.get(...)` and `json()`; the
 * pre-fix version additionally read `nextUrl` (via resolveOrigin), so all three
 * are supplied — a pre-fix route loaded here works, and still fails.
 */
function req(url, headers, body) {
  const lower = new Map(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  return {
    headers: { get: (k) => (lower.has(String(k).toLowerCase()) ? lower.get(String(k).toLowerCase()) : null) },
    nextUrl: new URL(url),
    json: async () => body,
  };
}

/** Run the handler with `fetch` captured. `reply` is a Response or a thrown Error. */
async function callRoute(request, reply) {
  const { POST } = await loadRoute();
  const calls = [];
  const logs  = [];
  const realFetch = global.fetch;
  const realError = console.error;
  global.fetch = async (url, init) => {
    calls.push(String(url));
    if (reply instanceof Error) throw reply;
    return reply;
  };
  console.error = (...args) => logs.push(args.map((a) => String(a)).join(' '));
  try {
    const res = await POST(request);
    const text = await res.text();
    return { calls, logs, status: res.status, text };
  } finally {
    global.fetch = realFetch;
    console.error = realError;
  }
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// Header sets a hostile caller could send. Every one is a valid HOSTNAME_RE
// match, which is all the pre-fix code checked.
const HOSTILE_HEADERS = [
  { label: 'x-forwarded-host naming an internal name',
    headers: { host: 'ddi.example.com:3006', 'x-forwarded-host': 'attacker.example.net', 'x-forwarded-proto': 'http' } },
  { label: 'x-forwarded-host naming a dotted IPv4 (HOSTNAME_RE accepts it)',
    headers: { host: 'ddi.example.com:3006', 'x-forwarded-host': '10.0.0.7', 'x-forwarded-proto': 'http' } },
  { label: 'a bare hostile Host with no proxy headers at all',
    headers: { host: 'attacker.example.net:3006' } },
  { label: 'a hostile host forced to https',
    headers: { host: 'attacker.example.net', 'x-forwarded-proto': 'https' } },
  { label: 'a port-stripped hostile host (resolveOrigin splits on ":")',
    headers: { 'x-forwarded-host': 'attacker.example.net:9999' } },
];

// ── the SSRF: the caller must not be able to choose the fetch target ─────────

for (const { label, headers } of HOSTILE_HEADERS) {
  test(`fetch target ignores ${label}`, async () => {
    const { calls } = await callRoute(
      req('http://ddi.example.com:3006/api/sso', headers, { token: 'tok' }),
      ok({ email: 'user@example.com' })
    );
    assert.equal(calls.length, 1, 'exactly one hub call');
    assert.equal(calls[0], `${CONFIGURED_HUB}/api/auth/sso-verify`);
    assert.equal(new URL(calls[0]).origin, CONFIGURED_HUB,
      `caller-supplied host reached the fetch: ${calls[0]}`);
    assert.ok(!calls[0].includes('attacker.example.net'), `hostile host in ${calls[0]}`);
    assert.ok(!calls[0].includes('10.0.0.7'), `hostile host in ${calls[0]}`);
  });
}

test('no usable Host does not change the target either', async () => {
  const { calls } = await callRoute(
    req('http://127.0.0.1:3006/api/sso', { host: '' }, { token: 'tok' }),
    ok({ email: 'user@example.com' })
  );
  assert.equal(calls[0], `${CONFIGURED_HUB}/api/auth/sso-verify`);
});

test('the route does not import resolveOrigin at all', () => {
  // The pinned target is a property of the file, not of one code path through
  // it: a reintroduced `resolveOrigin` import is the bug coming back.
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/resolveOrigin/.test(code), 'resolveOrigin is back in app/api/sso/route.ts');
  assert.ok(!/publicUrl/.test(code), '@/lib/publicUrl is back in app/api/sso/route.ts');
  assert.ok(/NOCVAULT_HUB_URL/.test(code), 'the hub target must come from configuration');
});

// ── the reflection: an anonymous caller learns nothing about upstream ───────

test('an upstream failure returns neither the hub status text nor its body', async () => {
  const upstreamBody = 'token expired at 2026-11-24T00:00:00Z for internal-host-7';
  const { status, text, logs } = await callRoute(
    req('http://ddi.example.com:3006/api/sso', { host: 'ddi.example.com:3006' }, { token: 'tok' }),
    new Response(upstreamBody, { status: 418 })
  );
  assert.equal(status, 401, 'a failed verify is a flat 401');
  assert.ok(!text.includes(upstreamBody), `upstream body reflected: ${text}`);
  assert.ok(!text.includes('internal-host-7'), `upstream body reflected: ${text}`);
  assert.ok(!text.includes('418'), `upstream status reflected: ${text}`);
  assert.ok(!/sso-verify failed/.test(text), `upstream status line reflected: ${text}`);
  assert.deepEqual(JSON.parse(text), { error: 'SSO verification failed' });
  // ...and the detail is not lost, it is logged server-side.
  assert.ok(logs.join('\n').includes(upstreamBody), 'the detail must still reach console.error');
  assert.ok(logs.join('\n').includes('418'), 'the status must still reach console.error');
});

test('a connection-level error is not reflected (that is the port-probe oracle)', async () => {
  const err = new Error('connect ECONNREFUSED 10.0.0.7:3000');
  const { status, text, logs } = await callRoute(
    req('http://ddi.example.com:3006/api/sso', { host: 'ddi.example.com:3006' }, { token: 'tok' }),
    err
  );
  assert.equal(status, 500);
  assert.ok(!text.includes('ECONNREFUSED'), `error message reflected: ${text}`);
  assert.ok(!text.includes('10.0.0.7'), `error message reflected: ${text}`);
  assert.deepEqual(JSON.parse(text), { error: 'SSO verification unavailable' });
  assert.ok(logs.join('\n').includes('ECONNREFUSED'), 'the detail must still reach console.error');
});

test('the success body carries only what app/sso/page.tsx reads', async () => {
  // page.tsx uses `data.email` and nothing else; name/role/apps are re-derived
  // from the token by auth.ts's authorize(). Returning the hub's verify payload
  // verbatim handed an anonymous caller more than it needed.
  const { status, text } = await callRoute(
    req('http://ddi.example.com:3006/api/sso', { host: 'ddi.example.com:3006' }, { token: 'tok' }),
    ok({
      email:        'user@example.com',
      userId:       42,
      name:         'A User',
      role:         'super_admin',
      apps:         ['netvault', 'ddivault'],
      hubBuild:     'internal-build-1234',
    })
  );
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(text), { email: 'user@example.com' }, 'only `email` leaves this route');
  assert.ok(!text.includes('internal-build-1234'));
  assert.ok(!text.includes('super_admin'));
});

test('a verify reply with no email is a 401, not a 200 with an empty body', async () => {
  const { status, text } = await callRoute(
    req('http://ddi.example.com:3006/api/sso', { host: 'ddi.example.com:3006' }, { token: 'tok' }),
    ok({ ok: true })
  );
  assert.equal(status, 401);
  assert.deepEqual(JSON.parse(text), { error: 'SSO verification failed' });
});

test('a missing token is rejected before any hub call', async () => {
  const { calls, status } = await callRoute(
    req('http://ddi.example.com:3006/api/sso', { host: 'ddi.example.com:3006' }, {}),
    ok({ email: 'user@example.com' })
  );
  assert.equal(status, 400);
  assert.equal(calls.length, 0, 'no token must mean no outbound request');
});

// ── the premise: this route really is sessionless ───────────────────────────

test('middleware.ts does NOT gate /api/sso (which is why the target must be pinned)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'middleware.ts'), 'utf8');
  const m = src.match(/'(\/api\/\(\(\?![^']+\)\.\+\))'/);
  assert.ok(m, 'the /api/* matcher was not found in middleware.ts');
  const matcher = new RegExp('^' + m[1] + '$');
  assert.equal(matcher.test('/api/sso'), false, 'premise changed: /api/sso is now session-gated');
  // ...while ordinary API routes stay gated.
  assert.equal(matcher.test('/api/scopes'), true);
});
