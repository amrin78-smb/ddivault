import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { resolveOrigin } from '@/lib/publicUrl';

// Legacy fallback chain (server-side env var, no NEXT_PUBLIC_ needed in
// middleware) — used only when the incoming request doesn't carry a usable
// Host. The hub origin is otherwise derived per-request via resolveOrigin()
// below so a customer accessing the suite via a local-DNS hostname instead of
// the install-time IP still gets working hub redirects.
const HUB_URL_FALLBACK = process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
const BACKEND   = 'http://127.0.0.1:3007';

// Explicit, narrow allow-list of Express-backed API routes that must work with
// NO NextAuth session (health/stats/license-status/update-available always
// respond, even fully unlicensed, e.g. NocVault hub tiles polling this app
// pre-login). /api/v1/* is handled separately below: it authenticates itself
// with an API key (Authorization/X-API-Key header), so external integrations
// never carry a NextAuth session cookie at all.
//
// ⛔ This is NOT the same list as `enforceLicense`'s exemptions in
// api/server.js, and must not be re-synced with it on the assumption that it
// should be. `/api/system/update-available` is public (it returns two version
// strings). `/api/system/last-update-status` was here too and should never have
// been: api/server.js spreads the whole status file into the response — stage,
// error code, the updater's RAW error text, the rollback flag, commit hashes —
// to anyone who can reach the port. SpanVault's middleware refuses that exact
// route for that exact reason. It is now admin-gated in Express instead, and it
// MUST stay out of this list: a request let through here gets no x-ddi-actor*
// headers stamped, so its RBAC guard would 401 even a super_admin. It remains
// exempt from the LICENCE gate in server.js, which is a separate question.
const PUBLIC_API = /^\/api\/(health|stats|license-status|system\/update-available)$/;

// One-click "acknowledge alert" email link (api/emailer.js builds it as
// APP_URL + '/api/alerts/:id/acknowledge?token=' + ackToken(id)). It must work
// for a logged-out recipient clicking from their inbox, so it can't go through
// the session gate below — but it's already protected server-side by an HMAC
// token (api/server.js GET handler → emailer.verifyAckToken), NOT a session.
// Scoped tightly to GET + a `token` query param so we don't accidentally also
// expose POST /api/alerts/:id/acknowledge (the session-gated admin-ack route,
// which reuses the same path but relies on this middleware's session check —
// it has no HMAC guard of its own).
const ACK_LINK_API = /^\/api\/alerts\/[^/]+\/acknowledge$/;

// The session-cookie names DDIVault can actually be carrying. Verified against
// the installed next-auth (4.24.14), not assumed:
//
//   * `authOptions` (frontend/src/lib/auth.ts) declares NEITHER a `cookies`
//     block NOR `useSecureCookies` — only providers/callbacks/pages/session/
//     secret — so next-auth's DEFAULTS are what gets written, and the defaults
//     are the only thing that ever carries a prefix:
//     `defaultCookies(useSecureCookies)` builds
//     `` `${useSecureCookies ? '__Secure-' : ''}next-auth.session-token` ``
//     (next-auth/core/lib/cookie.js). ⛔ The prefix is a property of the DEFAULT
//     NAME, not of the `secure` FLAG: an override of
//     `cookies.sessionToken.name` is written verbatim and `getToken` reads it
//     verbatim, so `secure: true` alone would never add the prefix. LogVault
//     overrides the name (`nexvault.session-token`) and therefore never has a
//     `__Secure-` form at all; DDIVault, on the defaults, genuinely can have
//     either. If DDIVault ever adds a `cookies` block — an obvious future
//     "simplification" — this list must follow it, and the prefixed entry then
//     becomes dead weight rather than wrong.
//   * BOTH forms are listed on purpose. The whole premise of this check is that
//     the name WRITTEN and the name EXPECTED have diverged, and next-auth
//     decides them in two DIFFERENT places from two different inputs: the write
//     side uses `authOptions.useSecureCookies ?? url.base.startsWith('https://')`
//     (core/init.js), the read side `process.env.NEXTAUTH_URL?.startsWith('https://')
//     ?? !!process.env.VERCEL` (jwt/index.js). Narrowing to "the one the config
//     should be writing" would trust exactly the derivation that is broken.
const SESSION_COOKIE_NAMES = ['next-auth.session-token', '__Secure-next-auth.session-token'];

/**
 * Is there a session cookie on this request AT ALL — readable or not?
 *
 * ⛔ THIS IS NOT AN AUTHENTICATION CHECK and must never be used as one. It
 * answers one narrow question: did the browser present something that LOOKS like
 * our session, so that `getToken()` returning null might mean "cannot read it"
 * rather than "there isn't one". The signed-token check stays the only authority
 * on identity.
 *
 * ⛔ PREFIX-MATCHED, AND A BARE `cookies.has(name)` IS NOT ENOUGH. next-auth
 * splits a session cookie whose value exceeds 3933 bytes
 * (`ALLOWED_COOKIE_SIZE 4096 - ESTIMATED_EMPTY_COOKIE_SIZE 163`) across
 * `<name>.0`, `<name>.1`, … (`#chunk()` in next-auth/core/lib/cookie.js) and
 * `SessionStore` reassembles them by this same `startsWith` rule — so
 * `getToken()` reads a chunked session transparently while an exact-name check
 * cannot see one at all. A chunked-AND-unreadable session would then fall
 * straight back into the loop this guard exists to prevent, and a large `apps`
 * claim is exactly what pushes our JWT past 4096 bytes. Reachable, not
 * theoretical. ⛔ Do not "tidy" this back to an equality check.
 */
function hasSessionCookie(req: NextRequest): boolean {
  for (const c of req.cookies.getAll()) {
    for (const base of SESSION_COOKIE_NAMES) {
      if (c.name === base || c.name.startsWith(base + '.')) return true;
    }
  }
  return false;
}

// Per-user app-access gate (NocVault suite). `apps` is the list of app slugs the
// user is allowed, carried from the SSO token into DDIVault's session JWT
// (lib/auth.ts). Fail OPEN: no/empty claim = default-all, so older tokens minted
// before this feature never lock anyone out. netvault (the hub) is always allowed.
function appAllowed(apps: unknown, slug: string): boolean {
  if (slug === 'netvault') return true;
  if (!Array.isArray(apps) || apps.length === 0) return true;
  return apps.includes(slug);
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  // NetVault (the hub) always runs on port 3000.
  const hubUrl = resolveOrigin(req, 3000, HUB_URL_FALLBACK);

  // Proxy /api/* to the Express API ourselves — verifying identity here
  // instead of leaving it to a dumb config-level rewrite. The matcher below
  // already excludes /api/auth/* (NextAuth's own routes) and /api/sso (this
  // app's own SSO handshake route handler — a native Next.js route, not part
  // of the Express API), so every path reaching this branch is Express-bound.
  if (pathname.startsWith('/api/')) {
    const target = new URL(`${BACKEND}${pathname}${search}`);

    // A client can send anything it wants for x-ddi-actor*; those values are
    // ALWAYS discarded here and, for authenticated routes, replaced with the
    // identity from the signed NextAuth JWT below. Never merge/append
    // client-supplied values — a forged x-ddi-actor-role header must never
    // reach the API.
    const headers = new Headers(req.headers);
    headers.delete('x-ddi-actor');
    headers.delete('x-ddi-actor-role');
    headers.delete('x-ddi-actor-id');

    // Public, no-session routes and the API-key-authenticated /api/v1/*
    // surface proxy straight through with the forged headers stripped (but
    // none stamped — these routes don't rely on x-ddi-actor* for identity).
    const isAckLink =
      req.method === 'GET' &&
      ACK_LINK_API.test(pathname) &&
      req.nextUrl.searchParams.has('token');
    if (PUBLIC_API.test(pathname) || pathname.startsWith('/api/v1/') || isAckLink) {
      return NextResponse.rewrite(target, { request: { headers } });
    }

    // Every other /api/* route requires a verified session. The API's RBAC
    // middleware (api/middleware/rbac.js) trusts these headers verbatim, so
    // they must only ever be set from a cryptographically verified token —
    // this is what makes it impossible to self-grant super_admin with a bare
    // curl request the way the old client-stamped-header model allowed.
    // ⛔ This `getToken()` conflates "no cookie" with "unreadable cookie" exactly
    // like the page gate below, but it needs NO loop guard: the answer is a
    // terminal JSON 401 that sends the caller nowhere, so an unreadable session
    // surfaces as a failed fetch rather than a redirect storm. Keep it that way
    // — if this branch is ever changed to REDIRECT, it inherits the page gate's
    // problem and needs `hasSessionCookie()` too.
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Per-user app-access enforcement (same gate as the page-route branch
    // below): a valid session whose allowed-apps claim omits ddivault must
    // not reach the API either — page-nav-only enforcement left this proxy
    // as a bypass for a denied-but-authenticated user hitting /api/* directly.
    if (!appAllowed((token as { apps?: unknown }).apps, 'ddivault')) {
      return NextResponse.json({ error: 'forbidden', reason: 'app_access_denied' }, { status: 403 });
    }

    headers.set('x-ddi-actor', (token.name as string) || (token.email as string) || 'user');
    headers.set('x-ddi-actor-role', (token.role as string) || 'viewer');
    headers.set('x-ddi-actor-id', token.id != null ? String(token.id) : '');

    return NextResponse.rewrite(target, { request: { headers } });
  }

  // Auth guard for all page routes (matcher below already excludes /sso, the
  // pre-login SSO handshake page).
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    // ⛔ THE callbackUrl IS ONLY SAFE WHEN "NO SESSION" IS CERTAIN, AND
    // `getToken()` CANNOT TELL US THAT. It returns null both for a browser that
    // has never signed in AND for a session cookie that is present but
    // UNREADABLE — and the second case is a realistic misconfiguration, not a
    // curiosity: it is called as `getToken({ req, secret })` with next-auth's
    // defaults, and v4 derives `secureCookie` (hence the cookie NAME it looks
    // for) from whether `NEXTAUTH_URL` starts with `https://`
    // (next-auth/jwt/index.js). So an `http://` NEXTAUTH_URL on an HTTPS
    // deployment — which is what the suite installer writes at install time —
    // makes every valid session unreadable, and so does a rotated
    // `NEXTAUTH_SECRET`.
    //
    // With the callbackUrl attached, that state is an INFINITE LOOP and there is
    // no hop counter anywhere to stop it: hub mints a token -> /sso sets the
    // cookie -> / -> this gate still cannot read it -> hub -> forever, ending at
    // the browser's own ERR_TOO_MANY_REDIRECTS. Without it, the hub's login page
    // falls back to `/launcher` (it honours only a hub-relative callbackUrl),
    // so the user stops on a working page and the misconfiguration is VISIBLE
    // instead of being a redirect storm.
    //
    // So: carry the SSO re-entry callbackUrl only when the browser presented no
    // session cookie at all — the one case where null unambiguously means "not
    // signed in". A cookie we cannot read is a server-side problem and must not
    // be answered with another round trip.
    if (hasSessionCookie(req)) {
      return NextResponse.redirect(`${hubUrl}/login`);
    }
    return NextResponse.redirect(`${hubUrl}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault`);
  }

  // Per-user app-access enforcement: a valid session whose allowed-apps claim
  // omits ddivault is bounced to the hub launcher with a denied banner. The
  // launcher lives on the hub origin, so this never loops inside DDIVault.
  if (!appAllowed((token as { apps?: unknown }).apps, 'ddivault')) {
    return NextResponse.redirect(`${hubUrl}/launcher?denied=ddivault`);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // /api/* → verified proxy to Express, except NextAuth's own routes and
    // this app's own SSO handshake route (native Next.js route handlers).
    '/api/((?!auth(?:/|$)|sso$).+)',
    // All page routes → auth guard, except the SSO handshake page itself and
    // /auth/signin (app/auth/signin/route.ts — the request-aware bounce to the
    // hub's login page that `pages.signIn` points at). ⛔ /auth/signin MUST stay
    // excluded: it is only ever reached WITHOUT a session, so gating it here
    // would mean the gate answers every sign-in attempt and the route's own
    // per-request hub redirect never runs.
    '/((?!api|sso|auth/signin|_next/static|_next/image|favicon.ico).*)',
  ],
};
