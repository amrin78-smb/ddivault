'use client';
import { useEffect, useState } from 'react';
import { applyCorners, getCorners, CORNERS_EVENT, type Corners } from '@/lib/corners';

/**
 * Compact segmented control (Rounded | Square) for the header, sized to sit
 * beside the 38px dark-mode toggle.
 *
 * Lives in the header rather than Settings on purpose: DDIVault's Settings tab
 * is gated behind `canManageSystem`, so a per-browser display preference placed
 * there would be unreachable for every non-admin user. This control is NOT
 * admin-gated.
 *
 * Colors follow the header's own chrome language (alpha-white over the fixed
 * navy bar) rather than the page surface tokens — the header is brand chrome
 * and stays navy in BOTH themes, so var(--bg-card) here would render a white
 * card on a navy bar in light mode. Alpha-white reads correctly in both themes,
 * exactly as the adjacent bell / theme-toggle buttons already do. Radius and
 * type still come from tokens, so the control squares itself off with the rest
 * of the app.
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
        padding: '0 10px',
        height: '100%',
        border: 'none',
        background: active ? 'rgba(255,255,255,0.16)' : 'transparent',
        color: active ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        fontFamily: 'inherit',
        letterSpacing: '0.02em',
        cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
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
      title="Corner style"
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        height: 38,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <Segment label="Rounded" active={corners === 'rounded'} onClick={() => set('rounded')} />
      <div style={{ width: 1, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
      <Segment label="Square" active={corners === 'square'} onClick={() => set('square')} />
    </div>
  );
}
