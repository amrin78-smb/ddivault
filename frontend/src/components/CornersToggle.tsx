'use client';
import { useEffect, useState } from 'react';
import { applyCorners, getCorners, CORNERS_EVENT, type Corners } from '@/lib/corners';

/**
 * Corner-style preference row for the header's user-avatar dropdown: an icon +
 * "Corners" label on the left (matching the other dropdown items) and a compact
 * two-segment control (Rounded | Square) on the right.
 *
 * Lives in the avatar dropdown rather than Settings on purpose: DDIVault's
 * Settings tab is gated behind `canManageSystem`, so a per-browser display
 * preference placed there would be unreachable for every non-admin user. The
 * avatar menu is where per-user preferences belong (the dark-mode item is
 * already there) and it stays reachable by every role. This control is NOT
 * admin-gated.
 *
 * Colors use the CARD surface tokens (`--bg-card` / `--surface-subtle` /
 * `--text-*` / `--border`), because the dropdown panel is a card in BOTH themes.
 * The alpha-white-over-navy treatment this control used while it sat in the
 * navy bar is deliberately gone — it is invisible on a card surface. Radius
 * still comes from `--radius-sm`, so the control squares itself off with the
 * rest of the app.
 */

// Defined at MODULE top level — a component defined inside another component is
// a new type on every render and remounts (and loses focus) on every keystroke.
function Segment({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: '4px 10px',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: active ? 'var(--bg-card)' : 'transparent',
        boxShadow: active ? 'var(--shadow-sm)' : 'none',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        fontSize: 'var(--text-xs)',
        fontWeight: active ? 600 : 500,
        fontFamily: 'inherit',
        letterSpacing: '0.02em',
        cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--text-secondary)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
      {label}
    </button>
  );
}

// Module-level icon, same 16px stroke style as the other dropdown-item icons.
function CornersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
      <path d="M3 9V5a2 2 0 0 1 2-2h4" />
      <path d="M15 3h4a2 2 0 0 1 2 2v4" />
      <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
      <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
    </svg>
  );
}

export default function CornersToggle() {
  // NEVER read the <html> attribute during render — it does not exist during the
  // server render, so reading it at render time causes a hydration mismatch.
  // Server + first client render always assume the default ('rounded'); the
  // effect below corrects it from the attribute the no-flash script already set.
  const [corners, setCorners] = useState<Corners>('rounded');

  useEffect(() => {
    setCorners(getCorners());
    const sync = () => setCorners(getCorners());
    window.addEventListener(CORNERS_EVENT, sync);
    return () => window.removeEventListener(CORNERS_EVENT, sync);
  }, []);

  const set = (next: Corners) => {
    applyCorners(next);
    setCorners(next);
  };

  return (
    <div
      role="group"
      aria-label="Corner style"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        // 16px horizontal + var(--text-base) + gap 10 match the sibling dropdown
        // items exactly; the vertical padding is 6px rather than their 10px so the
        // taller segmented control lands on the SAME ~38px row height they do.
        padding: '6px 16px', width: '100%',
        color: 'var(--text-secondary)', fontSize: 'var(--text-base)', fontWeight: 500,
      }}
    >
      <CornersIcon />
      <span>Corners</span>
      <div style={{ flex: 1 }} />
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        background: 'var(--surface-subtle)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        flexShrink: 0,
      }}>
        <Segment label="Rounded" active={corners === 'rounded'} onClick={() => set('rounded')} />
        <Segment label="Square" active={corners === 'square'} onClick={() => set('square')} />
      </div>
    </div>
  );
}
