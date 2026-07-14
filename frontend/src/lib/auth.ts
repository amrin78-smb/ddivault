import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

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

        // ── Direct credentials path (fallback) ────────────────
        if (!credentials.email || !credentials.password) return null;
        try {
          const result = await netvaultDb.query(
            'SELECT id, name, email, password_hash, role FROM users WHERE email = $1 LIMIT 1',
            [credentials.email]
          );
          const user = result.rows[0];
          if (!user) return null;
          const valid = await bcrypt.compare(credentials.password, user.password_hash);
          if (!valid) return null;
          return {
            id:    String(user.id),
            name:  user.name,
            email: user.email,
            role:  user.role,
          };
        } catch (err) {
          console.error('[Auth] DB error:', err);
          return null;
        }
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
    signIn: `${HUB_URL}/login`,
  },

  session: {
    strategy: 'jwt',
    maxAge:   8 * 60 * 60, // 8 hours
  },

  secret: process.env.NEXTAUTH_SECRET,
};
