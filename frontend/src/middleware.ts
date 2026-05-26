import { getToken } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';

const LOGIN_URL = 'http://192.168.6.111:3000/login?callbackUrl=%2Fapi%2Fsso%2Fddivault';

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
