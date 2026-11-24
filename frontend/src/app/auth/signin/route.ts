import { NextRequest, NextResponse } from 'next/server';
import { signInRedirectTarget } from '@/lib/signInRedirect';

//
// frontend/src/app/auth/signin/route.ts — DDIVault's own, request-aware bounce
// to the NocVault hub's login page. `authOptions.pages.signIn` points here (a
// LOCAL relative path), because NextAuth v4 evaluates `pages` once at module
// load and so can never follow the request. All the reasoning, and the reason
// the hub env var must stay a loopback, is in `@/lib/signInRedirect`.
//
// ⛔ A Next.js route file may export only the fields Next recognises — the
// helper therefore lives in lib/, where the tests reach it.
//
// ⛔ This route MUST stay out of middleware.ts's page matcher (`auth/signin` is
// in the negative lookahead). It is only ever reached WITHOUT a session, so a
// gate in front of it would answer every sign-in attempt and this handler would
// never run.
//

// ⛔ Not decorative: this GET handler's whole answer is derived from the
// request's own Host/X-Forwarded-* headers. A cached response would pin one
// hostname into the redirect and hand it to every later caller — the same class
// of bug this route was added to fix.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // 307, not 302: the method and body are irrelevant for a GET, but 307 keeps
  // the semantics honest if NextAuth ever bounces a POST through here.
  return NextResponse.redirect(signInRedirectTarget(req), 307);
}
