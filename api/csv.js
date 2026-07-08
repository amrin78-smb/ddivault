'use strict';

/**
 * Escape a single value for a CSV cell, with a CSV/formula-injection guard.
 *
 * A cell that starts with = + - @ (or a leading tab/CR) is interpreted as a FORMULA
 * by Excel / Google Sheets, so a network-sourced string like `=cmd|...` would execute
 * when someone opens the exported file. Neutralize it by prefixing a single quote so
 * it renders as text, then apply standard RFC-4180 quoting when the value contains a
 * quote, comma, or newline.
 *
 * Every CSV export in DDIVault (reports, DHCP leases, audit log) routes through this —
 * their cells carry device/host/DNS/user-supplied strings, so the guard belongs in one
 * shared place that can't drift or be forgotten.
 */
function escapeCsvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { escapeCsvCell };
