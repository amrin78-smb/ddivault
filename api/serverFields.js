'use strict';
/**
 * serverFields.js — the two decisions the /api/servers write routes make that
 * are worth testing on their own: which DNS platform is acceptable, and when a
 * stored secret may be overwritten.
 *
 * ⛔ EXTRACTED SO THEY CAN BE TESTED, because both fail silently and
 * destructively. A platform that falls through to a default polls a Linux box
 * with PowerShell forever; a secret rule that treats "unchanged" as "clear"
 * destroys a credential during an unrelated edit. Neither produces an error at
 * the time, and both are only noticed at the next poll.
 */

/** Platforms this build can actually collect. */
const DNS_PLATFORMS = new Set(['windows', 'bind', 'powerdns']);

/**
 * @returns {string|null} the canonical platform, or null meaning "reject".
 *
 * ⛔ AN UNKNOWN PLATFORM IS REJECTED, NOT DEFAULTED. Quietly falling back to
 * 'windows' would accept "bind9" or "BIND " and then poll that server over
 * WinRM forever, reporting authentication errors about a host that has no
 * WinRM — a wrong answer wearing the costume of a network fault.
 */
function normaliseDnsPlatform(v) {
  if (v === undefined || v === null || v === '') return 'windows';
  const p = String(v).trim().toLowerCase();
  return DNS_PLATFORMS.has(p) ? p : null;
}

/** The placeholder the server form shows for a stored secret. */
const SECRET_MASK = '••••••••';

/**
 * May this submitted value replace the stored secret?
 *
 * ⛔ EMPTY MEANS "UNCHANGED", NOT "CLEAR IT". `ServersTab` initialises every
 * secret field to '' and PUTs the WHOLE form, so editing a description submits
 * ps_password: ''. Reading that as an explicit clear would silently destroy the
 * stored WinRM credential — and now the TSIG secret and PowerDNS API key — of
 * any server whose description someone tidied up. There is deliberately no
 * clear-the-secret path: the UI offers none, so adding one to the API would
 * make destruction reachable without making it visible.
 */
function shouldReplaceSecret(val) {
  return !!val && val !== SECRET_MASK;
}

module.exports = { DNS_PLATFORMS, normaliseDnsPlatform, SECRET_MASK, shouldReplaceSecret };
