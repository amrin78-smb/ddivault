import { getToken } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';

// Uses NOCVAULT_HUB_URL (server-side env var, no NEXT_PUBLIC_ needed in middleware)
const HUB_URL   = process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://192.168.6.111:3000';
const LOGIN_URL  = `${HUB_URL}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault`;

export async function middleware(req: NextRequest) {
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET || 'bue3VdWszntJ24GMhfKg1QkPIEaZYC95',
  });

  if (!token) {
    return NextResponse.redirect(LOGIN_URL);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|sso|_next/static|_next/image|favicon.ico).*)'],
};
