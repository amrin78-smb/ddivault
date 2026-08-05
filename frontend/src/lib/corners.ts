'use client';

/**
 * Corner-style handling for DDIVault — the square/rounded twin of the dark-mode
 * preference in `components/ThemeContext.tsx`. The choice is stored in
 * localStorage and applied as a `data-corners` attribute on <html>; the square
 * token overrides live in `app/globals.css` under `:root[data-corners="square"]`.
 * A no-flash inline script in the root layout (`app/layout.tsx`) applies the
 * saved style before paint, so this module only reads/toggles at runtime.
 * Default is rounded.
 *
 * Rounded is the ABSENCE of the attribute — there is no data-corners="rounded"
 * selector to keep in sync, so `applyCorners('rounded')` REMOVES the attribute
 * rather than setting it.
 *
 * The <html> attribute — not React state — is the source of truth, because the
 * no-flash script sets it before React ever mounts. Components must read it in
 * an effect, never during render (the attribute does not exist during the
 * server render, so reading at render causes a hydration mismatch).
 */
export type Corners = 'rounded' | 'square';

/** Matches the existing 'ddivault-theme' localStorage prefix used by ThemeContext. */
export const CORNERS_KEY = 'ddivault-corners';

/** Event fired on window whenever the corner style changes. */
export const CORNERS_EVENT = 'ddivault:corners';

export function getCorners(): Corners {
  if (typeof document === 'undefined') return 'rounded';
  return document.documentElement.getAttribute('data-corners') === 'square' ? 'square' : 'rounded';
}

export function applyCorners(corners: Corners) {
  if (typeof document === 'undefined') return;
  if (corners === 'square') document.documentElement.setAttribute('data-corners', 'square');
  else document.documentElement.removeAttribute('data-corners');
  try { localStorage.setItem(CORNERS_KEY, corners); } catch { /* ignore (private mode / disabled storage) */ }
  // Let any other mounted toggle re-sync its state.
  window.dispatchEvent(new CustomEvent(CORNERS_EVENT, { detail: corners }));
}

export function toggleCorners(): Corners {
  const next: Corners = getCorners() === 'square' ? 'rounded' : 'square';
  applyCorners(next);
  return next;
}

/** Inline <script> body that sets data-corners before first paint (no flash). */
export const CORNERS_INIT_SCRIPT =
  `(function(){try{var c=localStorage.getItem('${CORNERS_KEY}');if(c==='square'){document.documentElement.setAttribute('data-corners','square');}}catch(e){}})();`;
