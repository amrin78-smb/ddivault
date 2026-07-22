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
// short dropdown (severity, site), a date field.
export const INPUT_SM: React.CSSProperties = { ...INPUT, maxWidth: 140 };

// Medium value: an IP allowlist (short CSV).
export const INPUT_MD: React.CSSProperties = { ...INPUT, maxWidth: 220 };
