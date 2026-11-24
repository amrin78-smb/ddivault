import type { NextRequest } from 'next/server';
import { resolveOrigin } from '@/lib/publicUrl';

//
// frontend/src/lib/signInRedirect.ts — where a sessionless browser should be
// sent to sign in, worked out PER REQUEST.
//
// ⛔ WHY THIS EXISTS: `authOptions.pages` IS EVALUATED ONCE, AT MODULE LOAD.
// `frontend/src/lib/auth.ts` used to set
//
//     pages: { signIn: `${HUB_URL}/login` }
//
// and NextAuth v4 reads `pages` from the object it was handed, so that string is
// frozen for the life of the process — it can never follow the request the way
// `resolveOrigin()` does in `middleware.ts`. `HUB_URL` is the hub's SERVER-SIDE
// LOOPBACK (deliberately so — see auth.ts's sso-verify fetch), so production
// measured as
//
//     302 -> http://127.0.0.1:13000/login?callbackUrl=https://<host>:3006
//
// i.e. a browser sent to a loopback port on its own machine. `pages.signIn` is
// now the LOCAL relative path `/auth/signin`, and `app/auth/signin/route.ts`
// calls this module to do the cross-origin hop on every request.
//
// ⛔ DO NOT "SIMPLIFY" THIS BACK INTO auth.ts by reading the env var there. The
// env var is correct for the server-to-server `sso-verify` fetch and wrong for a
// browser redirect: routing that fetch through the public TLS front door fails
// ERR_TLS_CERT_ALTNAME_INVALID (the certificate names the site, not the IP) and
// has already broken DDIVault sign-in once. Two call sites, two origins.
//
// It lives in lib/ rather than beside the handler because a Next.js route file
// may only export the fields Next recognises — any other export is a build
// error ("is not a valid Route export field"), so there is nowhere in route.ts
// to put a testable helper.
//

// Legacy fallback chain — the SAME one middleware.ts passes to resolveOrigin(),
// used ONLY when the incoming request carries no usable Host header. Never the
// primary source.
const HUB_URL_FALLBACK =
  process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

// ⛔ A CONSTANT, AND NOT DERIVED FROM THE REQUEST OR FROM ANY CLIENT INPUT.
//
// NextAuth appends its own `?callbackUrl=<absolute app URL>` when it bounces a
// browser to `pages.signIn`, and the obvious-looking thing to do is carry that
// value forward (sanitised onto this app's origin so it cannot name a foreign
// host). It would be wasted work: the hub's login page honours a callbackUrl
// ONLY when it is a hub-relative path — `rawCallback.startsWith('/')` and not
// `//`, `/sso` or `/login`, see net-vault `app/(auth)/login/page.tsx` — and
// falls back to `/launcher` for anything else, so an absolute DDIVault URL is
// discarded and the user stops off at the launcher.
//
// `/api/sso/ddivault` is the hub's documented SSO re-entry path and exactly what
// `middleware.ts`'s page gate already sends, so the user lands back inside
// DDIVault with no extra click. It also takes the client-supplied value out of
// the flow ENTIRELY: there is no open-redirect surface to guard rather than a
// guarded one, which is why nothing here parses an incoming callbackUrl.
// Standardised across all three satellites.
const HUB_CALLBACK = '/api/sso/ddivault';

/** The absolute hub login URL this request should be redirected to. */
export function signInRedirectTarget(req: NextRequest): string {
  // NetVault (the hub) always runs on port 3000 — same call shape as middleware.ts.
  const hubUrl = resolveOrigin(req, 3000, HUB_URL_FALLBACK);
  const target = new URL(`${hubUrl}/login`);
  target.searchParams.set('callbackUrl', HUB_CALLBACK);
  return target.toString();
}
