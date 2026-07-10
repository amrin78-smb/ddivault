import { getToken } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';

// Uses NOCVAULT_HUB_URL (server-side env var, no NEXT_PUBLIC_ needed in middleware)
const HUB_URL   = process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
const LOGIN_URL  = `${HUB_URL}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault`;

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
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  });

  if (!token) {
    return NextResponse.redirect(LOGIN_URL);
  }

  // Per-user app-access enforcement: a valid session whose allowed-apps claim
  // omits ddivault is bounced to the hub launcher with a denied banner. The
  // launcher lives on the hub origin, so this never loops inside DDIVault.
  if (!appAllowed((token as { apps?: unknown }).apps, 'ddivault')) {
    return NextResponse.redirect(`${HUB_URL}/launcher?denied=ddivault`);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|sso|_next/static|_next/image|favicon.ico).*)'],
};
