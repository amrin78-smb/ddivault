'use strict';
/**
 * bind.js — BIND 9 provider.
 *
 * Records come from AXFR (the protocol every authoritative server speaks);
 * zone enumeration and query statistics come from BIND's statistics-channel,
 * because neither is expressible in the DNS protocol itself.
 *
 * ⛔ WE NEVER READ named.conf AND NEVER SHELL IN. That is the whole point of
 * this design: no SSH key on a customer's DNS server, no root, no agent, no
 * config parser to keep in step with BIND releases. The cost is that anything
 * living ONLY in named.conf — forwarders, most notably — is honestly reported as
 * not_available rather than guessed at. See capabilities.js.
 */

const client = require('../client');
const R = require('../records');
const { NOT_AVAILABLE } = require('../capabilities');

const HTTP_TIMEOUT_MS = 10000;

/**
 * ⛔ BIND'S STATISTICS CHANNEL LISTS FOUR ZONES THAT DO NOT EXIST AS ZONES.
 * `authors.bind`, `hostname.bind`, `version.bind` and `id.server` are built-in
 * CHAOS-class pseudo-zones every BIND server reports. Measured on a stock 9.20:
 * a 2-zone server lists 6. Left in, DDIVault would create four phantom zones per
 * BIND server and then fail to AXFR each of them every cycle, producing a steady
 * drip of errors about zones the operator has never heard of.
 */
const BUILTIN_ZONES = new Set(['authors.bind', 'hostname.bind', 'version.bind', 'id.server']);

function statsBase(server) {
  const u = String(server.dns_stats_url || '').replace(/\/+$/, '');
  if (!u) throw new Error('BIND statistics-channel URL is not configured');
  return u;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
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
  const out = { ok: false, version: null, detail: null, stats_channel: false };
  try {
    const d = await getJson(`${statsBase(server)}/json/v1/server`);
    out.stats_channel = true;
    out.version = d.version || null;
    out.ok = true;
    out.detail = 'statistics channel reachable';
  } catch (e) {
    out.detail = `statistics channel: ${e.message}`;
  }
  return out;
}

/** @returns {Promise<Array<{zone_name, zone_type, serial, is_reverse}>>} */
async function listZones(server) {
  const d = await getJson(`${statsBase(server)}/json/v1/zones`);
  const views = d && d.views ? Object.values(d.views) : [];
  const out = [];
  const seen = new Set();
  for (const v of views) {
    for (const z of (v && v.zones) || []) {
      const name = String(z.name || '').replace(/\.+$/, '');
      if (!name) continue;
      if (BUILTIN_ZONES.has(name.toLowerCase())) continue;
      if (String(z.type || '').toLowerCase() === 'builtin') continue;
      if (seen.has(name)) continue;           // the same zone can appear in several views
      seen.add(name);
      out.push({
        zone_name: name,
        zone_type: mapZoneType(z.type),
        serial: Number(z.serial) || null,
        is_reverse: R.isReverseZone(name),
        dnssec: null,
      });
    }
  }
  return out;
}

/** BIND's words for zone roles, mapped onto the ones dns_zones already stores. */
function mapZoneType(t) {
  const s = String(t || '').toLowerCase();
  if (s === 'primary' || s === 'master') return 'Primary';
  if (s === 'secondary' || s === 'slave') return 'Secondary';
  if (s === 'forward') return 'Forwarder';
  if (s === 'stub') return 'Stub';
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Primary';
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
 * Map BIND's counters onto dns_query_stats.
 * ⛔ THESE ARE CUMULATIVE SINCE BOOT, NOT A RATE. Storing them as if they were
 * per-interval would show a server that has been up for a year as impossibly
 * busy. The caller takes the delta against the previous sample; `boot_time` is
 * returned so a restart (counters reset to zero) is distinguishable from a quiet
 * period rather than producing a negative delta.
 */
async function getQueryStats(server) {
  const d = await getJson(`${statsBase(server)}/json/v1/server`);
  const ns = d.nsstats || {};
  const op = d.opcodes || {};
  const total = Number(op.QUERY) || 0;
  const nx = Number(ns.QryNXDOMAIN) || 0;
  const success = Number(ns.QrySuccess) || 0;
  return {
    total_queries: total,
    successful: success,
    nxdomain_count: nx,
    failed: Number(ns.QryFailure) || 0,
    auth_answers: Number(ns.QryAuthAns) || 0,
    boot_time: d['boot-time'] || null,
    cumulative: true,
  };
}

async function getForwarders() {
  // Declared in named.conf and not exposed over any remote interface we require.
  return { state: NOT_AVAILABLE, forwarders: [] };
}

module.exports = {
  platform: 'bind',
  testConnection, listZones, getZoneRecords, getSoa, getQueryStats, getForwarders,
  BUILTIN_ZONES, mapZoneType,
};
