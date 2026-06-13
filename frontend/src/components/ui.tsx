'use client';

import { useEffect, useRef } from 'react';

// ════════════════════════════════════════════════════════════
// Shared UI primitives for DDIVault — used across all tabs.
// All components defined at module scope (never nested).
// ════════════════════════════════════════════════════════════

// ── Utilization colour helper ─────────────────────────────────
export function pctColor(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 80) return 'var(--yellow)';
  return 'var(--green)';
}

// ── Skeleton block ────────────────────────────────────────────
export function Skeleton({ width = '100%', height = 14, radius = 6, style }: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: React.CSSProperties;
}) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius, ...style }} />;
}

// ── Table skeleton ────────────────────────────────────────────
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: '4px 0' }}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 16, padding: '11px 14px', alignItems: 'center' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height={12} width={c === 0 ? 120 : `${Math.max(40, 100 / cols)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Card skeleton (KPI tiles etc.) ────────────────────────────
export function CardSkeleton({ count = 5, height = 88 }: { count?: number; height?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: 18,
        }}>
          <Skeleton height={28} width="50%" />
          <div style={{ height: 8 }} />
          <Skeleton height={12} width="70%" />
        </div>
      ))}
    </>
  );
}

// ── Empty state ───────────────────────────────────────────────
export function EmptyState({ icon, title, message, actionLabel, onAction }: {
  icon?: React.ReactNode;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '52px 24px', textAlign: 'center', color: 'var(--text-muted)',
    }}>
      {icon && (
        <div style={{
          width: 56, height: 56, borderRadius: 14, marginBottom: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-muted)',
        }}>
          {icon}
        </div>
      )}
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      {message && <div style={{ fontSize: 13, marginTop: 6, maxWidth: 420 }}>{message}</div>}
      {actionLabel && onAction && (
        <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// ── Page header (title + subtitle + right-aligned actions) ─────
export function PageHeader({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div className="page-head-row">
        <div className="page-title">{title}</div>
        {subtitle && <span className="page-head-sep">·</span>}
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────
export interface Crumb { label: string; onClick?: () => void }
export function Breadcrumb({ items, light = false }: { items: Crumb[]; light?: boolean }) {
  // `light` renders for dark backgrounds (e.g. the navy subnet-detail header), where
  // the default class colors (tuned for light backgrounds) would be unreadable.
  const linkStyle    = light ? { color: 'rgba(255,255,255,0.6)' } : undefined;
  const sepStyle     = light ? { color: 'rgba(255,255,255,0.4)' } : undefined;
  const currentStyle = light ? { color: 'rgba(255,255,255,0.9)' } : undefined;
  return (
    <nav className="breadcrumb">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span className="crumb-sep" style={sepStyle}>/</span>}
            {last || !c.onClick
              ? <span className="crumb-current" style={currentStyle}>{c.label}</span>
              : <button onClick={c.onClick} style={linkStyle}>{c.label}</button>}
          </span>
        );
      })}
    </nav>
  );
}

// ── Inline utilization bar ────────────────────────────────────
export function UtilBar({ pct, showLabel = true, width }: { pct: number; showLabel?: boolean; width?: number }) {
  const p = isNaN(pct) ? 0 : pct;
  const color = pctColor(p);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width }}>
      <div className="util-track">
        <div className="util-fill" style={{ width: `${Math.min(100, p)}%`, background: color }} />
      </div>
      {showLabel && <span style={{ fontSize: 11, fontWeight: 600, color, minWidth: 40, textAlign: 'right' }}>{p.toFixed(1)}%</span>}
    </div>
  );
}

// ── Trend indicator (↑ ↓ →) ───────────────────────────────────
export function Trend({ delta, invert = false }: { delta: number; invert?: boolean }) {
  // invert=false: rising is "bad" (red) — e.g. utilization. invert=true: rising is "good".
  const up = delta > 0.05, down = delta < -0.05;
  const arrow = up ? '↑' : down ? '↓' : '→';
  const good = invert ? up : down;
  const bad  = invert ? down : up;
  const color = good ? 'var(--green)' : bad ? 'var(--red)' : 'var(--text-muted)';
  return (
    <span style={{ color, fontSize: 12, fontWeight: 600 }}>
      {arrow} {Math.abs(delta).toFixed(1)}
    </span>
  );
}

// ── Spinner ───────────────────────────────────────────────────
export function Spinner({ size = 14, color = 'var(--primary)' }: { size?: number; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size,
      border: `2px solid var(--border)`, borderTopColor: color,
      borderRadius: '50%', animation: 'spin 0.8s linear infinite',
    }} />
  );
}

// ── Hook: refresh on global "R" key (dispatched by app shell) ──
export function useRefreshKey(cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const h = () => ref.current();
    window.addEventListener('ddivault:refresh', h);
    return () => window.removeEventListener('ddivault:refresh', h);
  }, []);
}

// ── Hook: call cb on Escape keypress (for modals) ─────────────
export function useEscape(cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}
