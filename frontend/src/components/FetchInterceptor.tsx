'use client';

import { useEffect } from 'react';
import { useToast } from './Toast';

/**
 * FetchInterceptor — surfaces backend authorization failures to the user.
 *
 * Write actions are hidden from the UI for roles that can't perform them, but a
 * 403 can still come back (stale session, direct call, race). This patches
 * window.fetch once to watch same-origin /api/* responses and shows a toast on
 * 403 so the user gets clear feedback instead of a silent no-op.
 *
 * A 402 is the license-disabled status (the backend returns it once a license
 * is past its grace period / the app is unlicensed). When one comes back we
 * force an immediate license re-check via the `recheck-license` event so the
 * full-screen LicenseGate lock surfaces right away instead of waiting for the
 * next 5-min poll, and surface a toast — mirroring the 403 handling.
 *
 * It never consumes the response body (only reads status), so callers still get
 * an untouched Response to parse.
 */

let notify: ((msg: string) => void) | null = null;
let patched = false;

function patchFetch() {
  if (patched || typeof window === 'undefined') return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    try {
      if (res.status === 403 || res.status === 402) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const isApi = url.startsWith('/api/') || url.includes(`${window.location.origin}/api/`);
        const isAuth = url.includes('/api/auth/');
        if (isApi && !isAuth) {
          if (res.status === 402) {
            // License disabled — force an immediate license re-check so the
            // full-screen lock surfaces now rather than at the next 5-min poll.
            window.dispatchEvent(new Event('recheck-license'));
            if (notify) notify('Your NocVault license has expired — access is now restricted.');
          } else if (notify) {
            notify("You don't have permission to perform this action");
          }
        }
      }
    } catch {
      /* never let interception break the response */
    }
    return res;
  };
}

export function FetchInterceptor() {
  const { toast } = useToast();

  useEffect(() => { patchFetch(); }, []);

  useEffect(() => {
    notify = (msg: string) => toast(msg, 'error');
    return () => { notify = null; };
  }, [toast]);

  return null;
}
