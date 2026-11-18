'use strict';
/**
 * serverFields.js — the decisions the /api/servers write routes make that are
 * worth testing on their own: which DNS platform is acceptable, when a stored
 * secret may be overwritten, and which servers an agent may be handed.
 *
 * ⛔ EXTRACTED SO THEY CAN BE TESTED, because both fail silently and
 * destructively. A platform that falls through to a default polls a Linux box
 * with PowerShell forever; a secret rule that treats "unchanged" as "clear"
 * destroys a credential during an unrelated edit. Neither produces an error at
 * the time, and both are only noticed at the next poll.
 */

/** Platforms this build can actually collect. */
const DNS_PLATFORMS = new Set(['windows', 'bind', 'powerdns', 'generic']);

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

/**
 * Which of the requested servers may actually be handed to an agent?
 *
 * ⛔ A PROTOCOL-COLLECTED SERVER PLUS AN AGENT OWNER IS A SERVER NOBODY
 * COLLECTS. `getActiveServers()` skips every row whose `agent_hub_id` is set
 * (an agent owns it), and the config pushed to an agent carries only the WinRM
 * fields — no `dns_platform`, no `dns_host`, no TSIG key. So the pair is
 * accepted and then collected by neither side, with nothing logged anywhere.
 * Before 1.37.0 the combination could not arise, because every server was
 * 'windows'; the Linux DNS work created it and this is the guard.
 *
 * ⛔ TWO DIFFERENT ANSWERS, MATCHING WHAT WAS ACTUALLY ASKED FOR. An id the
 * operator TYPED is refused outright — they meant that server, so tell them no.
 * A server pulled in by `assign_site_id` is SKIPPED and named — they meant the
 * site, and one Linux resolver in it must not fail the other twenty servers.
 * What neither path may do is drop a server without saying which: silence there
 * is indistinguishable from having worked.
 *
 * @param rows            {{id, hostname, dns_platform}[]} the referenced servers
 * @param assignIds       number[] every id to assign (after any site sweep)
 * @param explicitAssign  number[] only the ids the operator typed
 * @param isProtocol      (platform) => boolean
 * @returns {{refuse: string|null, skipped: Array, assignIds: number[]}}
 */
function planAgentAssignment(rows, assignIds, explicitAssign, isProtocol) {
  const bad = rows.filter((r) => assignIds.includes(r.id) && isProtocol(r.dns_platform));
  if (!bad.length) return { refuse: null, skipped: [], assignIds };

  const named = bad.filter((r) => explicitAssign.includes(r.id));
  if (named.length) {
    return {
      refuse: `${named.map((r) => `${r.hostname} (${r.dns_platform})`).join(', ')} `
            + 'is collected over the DNS protocol, which an agent cannot do yet. '
            + 'Leave it on central polling.',
      skipped: [], assignIds,
    };
  }
  const skipIds = new Set(bad.map((r) => r.id));
  return {
    refuse: null,
    skipped: bad.map((r) => ({ id: r.id, hostname: r.hostname, dns_platform: r.dns_platform })),
    assignIds: assignIds.filter((id) => !skipIds.has(id)),
  };
}

module.exports = {
  DNS_PLATFORMS, normaliseDnsPlatform, SECRET_MASK, shouldReplaceSecret, planAgentAssignment,
};
