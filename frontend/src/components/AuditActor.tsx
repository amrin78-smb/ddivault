'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';

/**
 * AuditActor — transparently stamps every same-origin /api/* request with the
 * signed-in user's identity so the backend audit trail records WHO did it.
 *
 * It patches window.fetch exactly once and reads the live actor from a ref-like
 * module variable updated whenever the session changes. No component re-renders
 * are triggered by this; it only augments outgoing request headers.
 */

let currentActor: { name: string; role: string; id: string } | null = null;
let patched = false;

function patchFetch() {
  if (patched || typeof window === 'undefined') return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const isApi = url.startsWith('/api/') || url.includes(`${window.location.origin}/api/`);
      // never stamp the NextAuth endpoints
      const isAuth = url.includes('/api/auth/');
      if (isApi && !isAuth && currentActor) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        headers.set('x-ddi-actor', currentActor.name);
        headers.set('x-ddi-actor-role', currentActor.role);
        if (currentActor.id) headers.set('x-ddi-actor-id', currentActor.id);
        return orig(input, { ...init, headers });
      }
    } catch {
      /* fall through to unmodified fetch */
    }
    return orig(input, init);
  };
}

export function AuditActor() {
  const { data: session } = useSession();

  useEffect(() => {
    patchFetch();
  }, []);

  useEffect(() => {
    const u = session?.user as { name?: string | null; email?: string | null; role?: string; id?: string } | undefined;
    currentActor = u
      ? { name: u.name || u.email || 'user', role: (u.role as string) || 'user', id: (u.id as string) || '' }
      : null;
  }, [session]);

  return null;
}
