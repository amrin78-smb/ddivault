'use strict';
/**
 * generic.js — any standards-compliant authoritative DNS server.
 *
 * ⛔ THIS IS NOT A LESSER PROVIDER, IT IS THE HONEST SHAPE FOR MOST OF THEM.
 * BIND and PowerDNS each got their own provider because each offers a remote
 * channel that can ENUMERATE zones — BIND's statistics-channel, PowerDNS's REST
 * API. Verified against the real daemons, Knot 3.6 and NSD do not: Knot's
 * control interface is a UNIX socket (`knotc -s <path>`), and NSD's needs
 * `nsd-control` over TLS with client certificates. Neither is something we are
 * willing to require on a customer's DNS server.
 *
 * Everything ELSE they do over the wire, identically. Measured against Knot
 * 3.6.2 with no code changes at all: AXFR refused without a key (NOTAUTH),
 * 12 records transferred with TSIG and the response verified, SOA probe clean,
 * a wrong key rejected as BADSIG — byte-identical output to the BIND path.
 *
 * So the only thing missing is the list of zones, and the operator supplies it.
 * That makes this provider cover Knot, NSD, and any appliance or managed service
 * that speaks AXFR — a better answer than a vendor list that is always one name
 * out of date.
 */

const client = require('./../client');
const R = require('./../records');
const { NOT_AVAILABLE } = require('./../capabilities');

/**
 * Parse the operator-supplied zone list.
 *
 * ⛔ TOLERANT ON PURPOSE. This is typed by hand into a textarea, and a trailing
 * dot, a blank line or a comma instead of a newline is not a configuration
 * error worth failing a whole server over. Comments are allowed so the list can
 * be annotated.
 */
function parseZoneList(raw) {
  return String(raw || '')
    .split(/[\n,;]+/)
    .map((z) => z.replace(/#.*$/, '').trim().replace(/\.+$/, '').toLowerCase())
    .filter((z) => z && /^[a-z0-9_.-]+$/.test(z));
}

function tsigOf(server) {
  if (!server.tsig_key_name || !server.tsig_secret) return null;
  return {
    keyName: server.tsig_key_name,
    algorithm: server.tsig_algorithm || 'hmac-sha256',
    secret: server.tsig_secret,
  };
}

async function testConnection(server) {
  const zones = parseZoneList(server.dns_zone_list);
  if (!zones.length) {
    return { ok: false, version: null, detail: 'No zones configured — this platform cannot discover them' };
  }
  try {
    const soa = await client.querySoa(server.dns_host, server.dns_port || 53, zones[0], { timeoutMs: 5000 });
    return { ok: true, version: null, detail: `answers for ${zones[0]} (serial ${soa.serial})` };
  } catch (e) {
    return { ok: false, version: null, detail: e.message };
  }
}

/**
 * The zones the operator told us about, confirmed by a SOA query.
 *
 * ⛔ A ZONE IN THE LIST THAT DOES NOT ANSWER IS REPORTED, NOT DROPPED. Silently
 * omitting it would look identical to the operator never having typed it, and
 * the most likely cause is a typo in exactly this field.
 */
async function listZones(server) {
  const names = parseZoneList(server.dns_zone_list);
  if (!names.length) throw new Error('No zones configured for this server');
  const out = [];
  const failed = [];
  for (const name of names) {
    try {
      const soa = await client.querySoa(server.dns_host, server.dns_port || 53, name, { timeoutMs: 5000 });
      out.push({
        zone_name: name,
        // ⛔ Not discoverable over the protocol. Every zone we can transfer is
        // one this server answers authoritatively for, which is what 'Primary'
        // means to the rest of the app; claiming to know Primary vs Secondary
        // would be a guess.
        zone_type: 'Primary',
        serial: soa.serial,
        is_reverse: R.isReverseZone(name),
        dnssec: null,
      });
    } catch (e) {
      failed.push(`${name} (${e.message})`);
    }
  }
  if (!out.length) throw new Error(`None of the configured zones answered: ${failed.join('; ')}`);
  if (failed.length) {
    const err = new Error(`configured zone(s) did not answer: ${failed.join('; ')}`);
    err.partial = out;          // the caller keeps what did work
    err.isPartial = true;
    throw err;
  }
  return out;
}

async function getZoneRecords(server, zoneName) {
  const r = await client.axfr({
    host: server.dns_host, port: server.dns_port || 53,
    zone: zoneName, tsig: tsigOf(server),
  });
  const n = R.normaliseZone(r.records, zoneName);
  return { records: n.records, counts: n.counts, verified: r.signed, bytes: r.bytes };
}

async function getSoa(server, zoneName) {
  return client.querySoa(server.dns_host, server.dns_port || 53, zoneName);
}

/**
 * ⛔ THROWS RATHER THAN RETURNING ZEROES. There is no vendor-neutral way to read
 * query counters, so a zeroed sample would be written into dns_query_stats and
 * render as "this server served no queries" — a measurement we never made. The
 * capability matrix reports query_stats as not_available for this platform.
 */
async function getQueryStats() {
  throw new Error('query statistics are not available over the DNS protocol alone');
}

async function getForwarders() {
  return { state: NOT_AVAILABLE, forwarders: [] };
}

module.exports = {
  platform: 'generic',
  testConnection, listZones, getZoneRecords, getSoa, getQueryStats, getForwarders,
  parseZoneList,
};
