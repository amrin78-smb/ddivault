'use strict';
/**
 * capabilities.js — what each DNS platform can and cannot tell us.
 *
 * ⛔ "THIS PLATFORM HAS NO SUCH CONCEPT" IS NOT "FALSE", AND NEITHER IS "WE
 * COULD NOT READ IT". Windows DNS has record scavenging; BIND and PowerDNS have
 * no equivalent at all. Rendering a BIND server as "Scavenging: Disabled" is a
 * confidently wrong answer that invites an engineer to go and enable a feature
 * that does not exist. Rendering it the same as "we could not reach the stats
 * channel" hides a real fault behind a cosmetic one.
 *
 * Four answers, deliberately distinct, and every consumer must render them
 * differently:
 *   supported      — we can read it, the value is real
 *   not_applicable — the platform has no such concept. Never a fault.
 *   not_available  — the concept exists but this server will not tell us
 *                    (channel disabled, key missing, permission denied). This
 *                    IS actionable: it usually means a config step was missed.
 *   unknown        — we tried and failed. A fault on OUR side, or transient.
 *
 * This mirrors the lesson from the MAC-vendor work (1.36.0): a missing row, a
 * withheld value and an unreadable catalogue are three different facts, and
 * collapsing them loses the only actionable one.
 */

const SUPPORTED      = 'supported';
const NOT_APPLICABLE = 'not_applicable';
const NOT_AVAILABLE  = 'not_available';
const UNKNOWN        = 'unknown';

/** Everything a DNS provider might be asked for. */
const CAPABILITIES = [
  'zones',          // enumerate zone names + types
  'records',        // read resource records
  'soa',            // SOA serial / timers
  'zone_type',      // primary / secondary / forward / native
  'query_stats',    // queries, NXDOMAIN, failures
  'forwarders',     // configured upstream forwarders
  'scavenging',     // record aging / scavenging
  'ad_integration', // Active-Directory-integrated zones
  'stale_records',  // records aged past a threshold
  'dnssec',         // zone signing status
  'writes',         // create/delete records
];

/**
 * ⛔ BIND'S FORWARDERS ARE DELIBERATELY not_available, NOT not_applicable.
 * BIND absolutely has forwarders — they are simply declared in named.conf and
 * NOT exposed over any remote interface we are willing to require (reading them
 * means shell access to the config file, which is exactly the dependency this
 * design exists to avoid). The concept exists and we cannot see it, so the
 * honest answer is "not available", and the UI should say so rather than imply
 * the server has none configured.
 */
const MATRIX = {
  windows: {
    zones: SUPPORTED, records: SUPPORTED, soa: SUPPORTED, zone_type: SUPPORTED,
    query_stats: SUPPORTED, forwarders: SUPPORTED, scavenging: SUPPORTED,
    ad_integration: SUPPORTED, stale_records: SUPPORTED,
    dnssec: NOT_AVAILABLE, writes: SUPPORTED,
  },
  bind: {
    zones: SUPPORTED,          // via the statistics channel
    records: SUPPORTED,        // via AXFR
    soa: SUPPORTED, zone_type: SUPPORTED,
    query_stats: SUPPORTED,    // statistics channel; not_available without it
    forwarders: NOT_AVAILABLE, // in named.conf, not exposed remotely
    scavenging: NOT_APPLICABLE,
    ad_integration: NOT_APPLICABLE,
    stale_records: NOT_APPLICABLE, // depends on aging timestamps BIND never keeps
    dnssec: NOT_AVAILABLE,
    writes: NOT_APPLICABLE,    // RFC 2136 is Phase 4; nothing is wired yet
  },
  /**
   * Knot, NSD, appliances — anything that speaks AXFR but offers no remote way
   * to ENUMERATE its zones. Verified against Knot 3.6.2: records, SOA and TSIG
   * all behave identically to BIND; only the zone list has to be supplied.
   */
  generic: {
    zones: SUPPORTED,            // from the operator-supplied list, SOA-confirmed
    records: SUPPORTED,          // AXFR
    soa: SUPPORTED,
    zone_type: NOT_AVAILABLE,    // not discoverable over the protocol
    query_stats: NOT_AVAILABLE,  // no vendor-neutral counter interface
    forwarders: NOT_AVAILABLE,
    scavenging: NOT_APPLICABLE,
    ad_integration: NOT_APPLICABLE,
    stale_records: NOT_APPLICABLE,
    dnssec: NOT_AVAILABLE,
    writes: NOT_APPLICABLE,
  },
  powerdns: {
    zones: SUPPORTED, records: SUPPORTED, soa: SUPPORTED, zone_type: SUPPORTED,
    query_stats: SUPPORTED,    // REST /statistics
    forwarders: NOT_APPLICABLE, // authoritative server; forwarding is the Recursor
    scavenging: NOT_APPLICABLE,
    ad_integration: NOT_APPLICABLE,
    stale_records: NOT_APPLICABLE,
    dnssec: SUPPORTED,         // the API reports per-zone signing state
    writes: NOT_APPLICABLE,    // Phase 4
  },
};

function capabilitiesFor(platform) {
  return MATRIX[String(platform || '').toLowerCase()] || null;
}

/**
 * What this server can do for `cap`, given its platform AND its configuration.
 * A capability the platform supports can still be not_available on a particular
 * server — a BIND host with no statistics channel configured cannot report
 * zones or query stats however capable BIND is in general.
 */
function capabilityFor(server, cap) {
  const m = capabilitiesFor(server && server.dns_platform);
  if (!m) return UNKNOWN;
  const base = m[cap] || UNKNOWN;
  if (base !== SUPPORTED) return base;
  const p = String(server.dns_platform).toLowerCase();
  if (p === 'bind' && (cap === 'zones' || cap === 'query_stats') && !server.dns_stats_url) {
    return NOT_AVAILABLE;
  }
  if (p === 'powerdns' && !server.dns_api_url) return NOT_AVAILABLE;
  // ⛔ This platform cannot discover its own zones. With none configured there
  // is nothing to collect, and saying so is more useful than an empty list.
  if (p === 'generic' && (cap === 'zones' || cap === 'records' || cap === 'soa')
      && !String(server.dns_zone_list || '').trim()) {
    return NOT_AVAILABLE;
  }
  if (p === 'bind' && cap === 'records' && !server.tsig_key_name) {
    // A transfer without TSIG can still work via an IP allow-list, so this is
    // not a hard no — but it is worth surfacing that nothing authenticates it.
    return SUPPORTED;
  }
  return SUPPORTED;
}

const isSupported = (server, cap) => capabilityFor(server, cap) === SUPPORTED;

module.exports = {
  SUPPORTED, NOT_APPLICABLE, NOT_AVAILABLE, UNKNOWN,
  CAPABILITIES, MATRIX, capabilitiesFor, capabilityFor, isSupported,
};
