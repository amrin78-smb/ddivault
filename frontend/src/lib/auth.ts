import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { Pool } from 'pg';

const netvaultDb = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432'),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  ssl:      false,
  max:      3,
});

const HUB_URL = process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

// Extract the `apps` claim (string[] of allowed app slugs) from an SSO JWT's
// payload. Read-only decode of the middle segment — NO signature verification
// here on purpose: the caller only invokes this AFTER the hub's sso-verify has
// already cryptographically validated the same token, so a forged/expired token
// never reaches this point. Returns undefined on any malformed input so callers
// fall back to default-all (fail open) rather than locking a user out.
function ssoApps(token: string): string[] | undefined {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const json = Buffer.from(part, 'base64').toString('utf8');
    const apps = JSON.parse(json).apps;
    return Array.isArray(apps) ? apps : undefined;
  } catch {
    return undefined;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email:    { label: 'Email',    type: 'email' },
        password: { label: 'Password', type: 'password' },
        token:    { label: 'Token',    type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials) return null;

        // ── SSO path: token provided by NetVault hub ──────────
        if (credentials.token) {
          try {
            const res = await fetch(`${HUB_URL}/api/auth/sso-verify`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ token: credentials.token }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (!data.email) return null;
            // Carry the allowed-apps claim from the incoming SSO token so
            // middleware.ts can gate per-user app access. `apps` is a string[]
            // of app slugs (e.g. ["netvault","ddivault"]); absent/empty =
            // default-all. The token was already cryptographically verified by
            // the hub's sso-verify above (it rejects forged/expired tokens), so
            // reading the apps claim from that same verified token's payload is
            // safe — a forged token never reaches this line.
            return {
              id:    String(data.userId || data.email),
              name:  data.name  || data.email,
              email: data.email,
              role:  data.role  || 'viewer',
              apps:  ssoApps(credentials.token),
            };
          } catch (err) {
            console.error('[Auth] SSO verify error:', err);
            return null;
          }
        }

        // Direct email/password is NOT supported — DDIVault has no login UI, and
        // the hub is the suite's single authentication point.
        //
        // This used to bcrypt-compare against netvault.users.password_hash right
        // here, making DDIVault a second front door into the hub's own user
        // table. Nothing in this app ever used it: there is no login page, and
        // the only signIn('credentials') call site is /sso, which passes a token.
        // It was reachable solely by POSTing directly to
        // /api/auth/callback/credentials.
        //
        // It also returned NO `apps` claim, and middleware treats an absent claim
        // as default-all — so this path additionally bypassed per-user app
        // access. A user explicitly denied DDIVault could reach it by logging in
        // here directly, while the hub correctly refused them.
        //
        // Keep it closed. Any authentication policy the hub enforces (MFA being
        // the immediate reason, but equally password rotation, lockout, or an IdP
        // migration) lives in NetVault's authorize(); a second password path here
        // silently opts out of all of it while the hub still reports the policy
        // as active.
        //
        // Matches SpanVault, which has always returned null here.
        return null;
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as any).role;
        token.id   = (user as any).id;
        // Persist the allowed-apps claim into DDIVault's own JWT so middleware.ts
        // (getToken) can enforce per-user app access. Only set when present on the
        // SSO login so older tokens (no claim) stay default-all (fail open).
        if (Array.isArray((user as any).apps)) {
          (token as any).apps = (user as any).apps;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role;
        (session.user as any).id   = token.id;
        (session.user as any).apps = (token as any).apps;
      }
      return session;
    },
  },

  pages: {
    // ⛔ LOCAL AND RELATIVE ON PURPOSE — DO NOT PUT A HUB URL BACK HERE.
    // NextAuth v4 reads `pages` ONCE, from this object, at module load: any
    // value here is frozen for the life of the process and can never follow the
    // request. `HUB_URL` above is the hub's server-side LOOPBACK (correct for
    // the sso-verify fetch, see authorize()), so `${HUB_URL}/login` redirected
    // BROWSERS to a loopback port — measured on production as
    // `302 -> http://127.0.0.1:13000/login?callbackUrl=...`, which is dead from
    // a browser. NextAuth resolves a relative path against its own origin, so
    // this keeps the first hop on DDIVault; `app/auth/signin/route.ts` then
    // derives the hub origin from the ACTUAL request via resolveOrigin() and
    // 307s there, the same way middleware.ts already does for page routes.
    // That route is excluded from middleware.ts's matcher — it must stay
    // reachable with no session or the redirect loops.
    signIn: '/auth/signin',
  },

  session: {
    strategy: 'jwt',
    maxAge:   8 * 60 * 60, // 8 hours
  },

  secret: process.env.NEXTAUTH_SECRET,
};
