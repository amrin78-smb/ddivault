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
// NO NextAuth session — kept identical to the `enforceLicense` exemption list
// in api/server.js (health/stats/license-status/update-available always
// respond, even fully unlicensed, e.g. NocVault hub tiles polling this app
// pre-login). /api/v1/* is handled separately below: it authenticates itself
// with an API key (Authorization/X-API-Key header), so external integrations
// never carry a NextAuth session cookie at all.
const PUBLIC_API = /^\/api\/(health|stats|license-status|system\/update-available|system\/last-update-status)$/;

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
    // All page routes → auth guard, except the SSO handshake page itself.
    '/((?!api|sso|_next/static|_next/image|favicon.ico).*)',
  ],
};
