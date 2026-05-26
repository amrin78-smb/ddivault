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

const HUB_URL = process.env.NETVAULT_HUB_URL || 'http://192.168.6.111:3000';

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
            return {
              id:    String(data.userId || data.email),
              name:  data.name  || data.email,
              email: data.email,
              role:  data.role  || 'user',
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
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role;
        (session.user as any).id   = token.id;
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
