import { NextRequest, NextResponse } from 'next/server';

//
// frontend/src/app/api/sso/route.ts — the SSO token-verification proxy. The
// browser POSTs `{token}` here (same origin, so no CORS), and this handler asks
// the NocVault hub whether that token is real.
//
// ⛔ THE HUB FETCH TARGET IS CONFIGURATION, NEVER THE REQUEST.
//
// This route is deliberately OUTSIDE middleware.ts's matcher
// (`'/api/((?!auth(?:/|$)|sso$).+)'` excludes `/api/sso` exactly), because the
// SSO handshake has to work before a session exists. So it answers ANY caller
// who can reach port 3006, with no session at all.
//
// It used to build the target with `resolveOrigin(req, 3000, …)`, i.e. from the
// caller's own `Host`/`X-Forwarded-Host`. `resolveOrigin` is CORRECT for a
// browser redirect — that is the whole reason it exists (see
// `@/lib/signInRedirect`) — and wrong here: it checks the hostname for SHAPE
// only, and `HOSTNAME_RE` accepts dotted IPv4, so an unauthenticated caller
// could name any host they liked and have this process POST to it on port 3000
// and hand the reply (or the connection error) straight back. ⛔ The fix is to
// pin the SINK, not to "make resolveOrigin safe" — tightening the shared helper
// would break the browser links it exists for. SpanVault closed this exact bug
// class first (its `pickHubFetchOrigin`, spanvault/.ai-codex/gotchas.md), and
// this repo's Express half already settled on pure configuration for the same
// kind of sink (`configuredHubOrigin()` in `api/server.js`, for
// `/api/hub/settings`).
//
// Pinning it is also what the deployed topology REQUIRES, not just what is
// safer: `NOCVAULT_HUB_URL` is the hub's SERVER-SIDE loopback on a TLS install
// (netvault 1.60.1), because a server-to-server hub call through the public TLS
// front door dies with `ERR_TLS_CERT_ALTNAME_INVALID` — a real certificate
// names the site, not the IP.
//
// ⛔ Keep this chain byte-identical to `frontend/src/lib/auth.ts`'s `HUB_URL`.
// That module POSTs the SAME hub endpoint (`/api/auth/sso-verify`) for step 2 of
// this very handshake, and the two halves must agree about where the hub is.
//
const HUB_URL = process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

//
// ⛔ WHAT THIS ROUTE MAY TELL AN ANONYMOUS CALLER IS ITS OWN DEFECT, SEPARATE
// FROM THE TARGET. It used to return `sso-verify failed: ${res.status} ${text}`
// — the hub's status AND body — and, from the catch, a raw `err.message`, which
// carries connection-level detail (`ECONNREFUSED`, `ENOTFOUND`, TLS errors)
// useful for probing what exists. Detail goes to `console.error`; the client
// gets a fixed string.
//
// The success body is narrowed to the one field the legitimate caller uses:
// `frontend/src/app/sso/page.tsx` reads `data.email` and nothing else (it then
// calls `signIn('credentials', { email, token })`, and `auth.ts` re-derives
// name/role/apps from the token itself). Returning the hub's verify payload
// verbatim handed out more than any caller needed.
//
const GENERIC_VERIFY_FAILED = 'SSO verification failed';
const GENERIC_UNAVAILABLE   = 'SSO verification unavailable';

export async function POST(req: NextRequest) {
  let token: unknown;
  try {
    ({ token } = await req.json());
  } catch {
    // A malformed body is the caller's own fault and says nothing about us.
    return NextResponse.json({ error: 'No token provided' }, { status: 400 });
  }
  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'No token provided' }, { status: 400 });
  }

  try {
    const res = await fetch(`${HUB_URL}/api/auth/sso-verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[SSO Proxy] sso-verify failed: ${res.status} ${text}`);
      return NextResponse.json({ error: GENERIC_VERIFY_FAILED }, { status: 401 });
    }

    const data = await res.json();
    if (!data || typeof data.email !== 'string' || data.email === '') {
      console.error('[SSO Proxy] sso-verify returned no email:', JSON.stringify(data));
      return NextResponse.json({ error: GENERIC_VERIFY_FAILED }, { status: 401 });
    }

    return NextResponse.json({ email: data.email });

  } catch (err: any) {
    console.error('[SSO Proxy] Error:', err?.message);
    return NextResponse.json({ error: GENERIC_UNAVAILABLE }, { status: 500 });
  }
}
