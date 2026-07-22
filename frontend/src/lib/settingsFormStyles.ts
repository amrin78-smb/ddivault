// ════════════════════════════════════════════════════════════
// Shared Settings-form style tokens
// ════════════════════════════════════════════════════════════
// Single source of truth for the inline-style form fields used across the
// Settings tab (SmtpSettings, AlertRecipients, AlertRules, ApiKeysSection,
// and SettingField in app/page.tsx). Previously each file hand-copied its
// own INPUT/LABEL object literal, which drifted from the real `.input` CSS
// class in globals.css (padding 9px vs 8px, background --bg-primary vs
// --bg-card, font-size --text-md vs --text-base). INPUT here is kept in
// exact sync with `.input` — if you change one, change the other.
//
// INPUT_SM / INPUT_MD exist so short-value fields (a port number, a
// percentage, a day count, a short dropdown) don't stretch across an
// entire grid cell or modal width — apply them instead of `width: '100%'`
// wherever the field's value is inherently short.

export const INPUT: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-base)',
  fontFamily: 'inherit',
  outline: 'none',
};

export const LABEL: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-muted)',
  display: 'block',
  marginBottom: 4,
  fontWeight: 500,
};

// Short value: port number, percentage, day count, cooldown minutes, a
// bare-word dropdown (e.g. AlertRules' severity select), a date field.
export const INPUT_SM: React.CSSProperties = { ...INPUT, maxWidth: 140 };

// Medium value: an IP allowlist (short CSV), or a dropdown whose option text
// runs longer (e.g. AlertRecipients' site/severity selects).
export const INPUT_MD: React.CSSProperties = { ...INPUT, maxWidth: 220 };

// ────────────────────────────────────────────────────────────
// Compact flex-wrap field rows (follow-up to the INPUT_SM/INPUT_MD fix)
// ────────────────────────────────────────────────────────────
// Capping an input's width alone isn't enough when the field still sits in
// a CSS Grid row/column sized as an equal fraction (`1fr`) of the row — the
// grid column stays full-width, so the capped input leaves a dead gap of
// empty space before the boundary of that column. FORM_ROW replaces
// `display: 'grid'` on that specific container with a flex-wrap layout so
// field WIDTH drives layout instead of a fixed column track:
//   - FORM_ROW on the row container.
//   - FIELD_GROW on fields that keep `width: '100%'` (INPUT, uncapped) —
//     they grow to fill remaining space, same as a wide grid column.
//   - FIELD_FIXED on fields using INPUT_SM/INPUT_MD — they size to content
//     (no leftover gap) instead of stretching to a column's full width.
//   - FIELD_FULL replaces a `gridColumn: '1 / -1'` full-row span (CSS
//     Grid's spanning has no flex equivalent; `flexBasis: '100%'` forces
//     the same line-break behavior in a flex-wrap container).
export const FORM_ROW: React.CSSProperties = { display: 'flex', flexWrap: 'wrap' };
export const FIELD_GROW: React.CSSProperties = { flex: '1 1 220px' };
export const FIELD_FIXED: React.CSSProperties = { flex: '0 0 auto' };
export const FIELD_FULL: React.CSSProperties = { flexBasis: '100%' };
