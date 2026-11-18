'use strict';
/**
 * serverStatus.js — "is this server being collected?", answered per capability.
 *
 * ⛔ THIS EXISTS BECAUSE ONE SCALAR WAS ANSWERING FOR TWO INDEPENDENT THINGS.
 * `ddi_servers.poll_status` is written by exactly one place — the DHCP scope
 * writer (`collector/writers.js#writeScopeStats`) — and `collectScopeStats`
 * returns early for a `role='dns'` server. So the field that every consumer
 * read as "is this server collecting" was only ever a statement about DHCP, and
 * it was wrong in both directions at once:
 *
 *   * a DNS-only server read "pending" / "Never polled" while its zones and
 *     records were being collected on schedule (cosmetic, but it made a working
 *     server look broken, and a stale value made `/api/infrastructure/health`
 *     report 'warning' indefinitely for a poll that never runs); and
 *   * a `role='both'` server whose DNS collection failed outright still read
 *     'ok', because the DHCP half had succeeded. A false all-clear is the more
 *     dangerous direction, and it is the one nobody would have noticed.
 *
 * ⛔ FOUR ANSWERS, NOT TWO — the same rule as `collector/dns/capabilities.js`.
 * A capability the server does not have is NOT_APPLICABLE. It is not a failure,
 * not a success and not a zero, and it must never move the overall verdict:
 * judging a DHCP-only server by whether its DNS collection succeeded is how
 * this class of bug keeps reappearing in this codebase.
 */

/** A capability's outcome. */
const OK             = 'ok';
const ERROR          = 'error';
const PENDING        = 'pending';        // configured, nothing reported yet
const NOT_APPLICABLE = 'not_applicable'; // this server does not do this

/** Does this role include DHCP collection? */
function hasDhcp(role) {
  const r = String(role || 'both').toLowerCase();
  return r === 'dhcp' || r === 'both';
}

/** Does this role include DNS collection? */
function hasDns(role) {
  const r = String(role || 'both').toLowerCase();
  return r === 'dns' || r === 'both';
}

/**
 * The DHCP half. `poll_status` is the raw column; 'stale' is written by the WS
 * ingest server when an agent stops reporting, and is a real error state.
 */
function dhcpPart(server) {
  if (!hasDhcp(server.role)) {
    return { capability: 'dhcp', status: NOT_APPLICABLE, at: null, error: null };
  }
  const raw = server.poll_status ? String(server.poll_status).toLowerCase() : null;
  const status = raw === 'ok' ? OK
    : (raw === 'error' || raw === 'stale') ? ERROR
    : PENDING;
  return {
    capability: 'dhcp',
    status,
    at: server.last_polled || null,
    error: status === ERROR ? (server.poll_error || (raw === 'stale' ? 'Agent stopped reporting' : null)) : null,
  };
}

/**
 * The DNS half. `dns_last_error` is carried even on a pending/ok row because the
 * protocol path writes it for a partial success (a zone in the operator's list
 * that does not answer), which is worth surfacing without calling the whole
 * collection a failure.
 */
function dnsPart(server) {
  if (!hasDns(server.role)) {
    return { capability: 'dns', status: NOT_APPLICABLE, at: null, error: null };
  }
  const raw = server.dns_poll_status ? String(server.dns_poll_status).toLowerCase() : null;
  const status = raw === 'ok' ? OK : raw === 'error' ? ERROR : PENDING;
  return {
    capability: 'dns',
    status,
    at: server.dns_polled_at || null,
    error: server.dns_last_error || null,
  };
}

/**
 * Collapse the applicable parts into one verdict, for the places that genuinely
 * need a single value (a badge, an aggregate).
 *
 * ⛔ ANY APPLICABLE FAILURE WINS. A `both` server collecting DHCP perfectly and
 * no DNS at all is NOT 'ok' — that was the false all-clear this file exists to
 * remove. 'pending' means something applicable has never reported; it is a
 * neutral "not yet", not a fault, so it must not raise an alarm on a server that
 * was added a minute ago.
 */
function collectionStatus(server) {
  const parts = [dhcpPart(server), dnsPart(server)];
  const live = parts.filter((p) => p.status !== NOT_APPLICABLE);

  // No applicable capability at all: an unrecognised role. Say so rather than
  // picking one of the real answers.
  if (!live.length) return { status: 'unknown', parts };

  if (live.some((p) => p.status === ERROR))   return { status: ERROR, parts };
  if (live.every((p) => p.status === OK))     return { status: OK, parts };
  return { status: PENDING, parts };
}

/**
 * The most recent moment anything was actually collected from this server, for
 * the single "last collected" line a compact view wants.
 *
 * ⛔ NOT `last_polled`. That column is the DHCP poll's, so reading it for a
 * DNS-only server yields "Never polled" about a server whose zones were read
 * minutes ago — the original symptom.
 */
function lastCollectedAt(server) {
  const times = collectionStatus(server).parts
    .map((p) => p.at)
    .filter(Boolean)
    .map((t) => (t instanceof Date ? t : new Date(t)))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (!times.length) return null;
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

/** Shape added to an API row so a client never has to re-derive this. */
function describeCollection(server) {
  const { status, parts } = collectionStatus(server);
  const at = lastCollectedAt(server);
  return {
    collection_status: status,
    collection_parts: parts.map((p) => ({
      capability: p.capability,
      status: p.status,
      at: p.at instanceof Date ? p.at.toISOString() : (p.at || null),
      error: p.error || null,
    })),
    last_collected_at: at ? at.toISOString() : null,
  };
}

module.exports = {
  OK, ERROR, PENDING, NOT_APPLICABLE,
  hasDhcp, hasDns, dhcpPart, dnsPart,
  collectionStatus, lastCollectedAt, describeCollection,
};
