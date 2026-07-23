'use client';

/**
 * Canonical score/forecast/severity color palettes for DDIVault. Reconciled
 * 2026-07 from a live design-token audit that found ~10 independent local
 * copies of the same 3 concepts, several disagreeing on color for the
 * identical threshold (confirmed live via Playwright before this fix: e.g.
 * SiteHealth.tsx rendered a 70-89 health score in orange while every other
 * score widget rendered it in yellow).
 */

// ── 0-100 health score (PillarScorecards, DNSTab, InfraHealthTab,
//    InfraRedundancy, SiteHealth) ───────────────────────────────
export function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--text-muted)';
  if (score >= 90) return 'var(--green)';
  if (score >= 70) return 'var(--yellow)';
  return 'var(--red)';
}

// ── Days-to-exhaustion capacity forecast (DHCPTab, CapacityForecast) ──
export function forecastColor(days: number | null | undefined): string {
  if (days == null) return 'var(--green)';
  if (days < 14) return 'var(--red)';
  if (days <= 30) return 'var(--yellow)';
  return 'var(--green)';
}

// ── Alert/anomaly severity (AlertRules, SecurityOverview, ActivityFeed,
//    Header alert-bell dropdown, Toast) ────────────────────────
export function severityColor(severity: string | null | undefined): string {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'var(--red)';
  if (s === 'medium' || s === 'warning' || s === 'warn') return 'var(--yellow)';
  if (s === 'low' || s === 'info') return 'var(--blue)';
  return 'var(--text-muted)';
}

export function severityBadgeClass(severity: string | null | undefined): string {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'badge-red';
  if (s === 'medium' || s === 'warning' || s === 'warn') return 'badge-yellow';
  if (s === 'low' || s === 'info') return 'badge-blue';
  return 'badge-gray';
}
