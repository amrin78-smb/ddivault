export { default } from 'next-auth/middleware';

export const config = {
  matcher: [
    '/((?!api/auth|sso|_next/static|_next/image|favicon.ico).*)',
  ],
};
