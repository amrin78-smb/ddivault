'use strict';
/**
 * powerdns.js — PowerDNS Authoritative Server provider (API-first).
 *
 * ⛔ RECORDS COME FROM THE REST API HERE, NOT AXFR, AND THAT IS DELIBERATE.
 * PowerDNS speaks AXFR perfectly well (verified), so using it would make the two
 * Linux providers look pleasingly symmetrical. It would also mean asking the
 * customer to add `allow-axfr-ips` on top of the API key they must already give
 * us — a second authorisation path, with its own failure mode, to collect data
 * the first one already returns. One credential, one path. AXFR stays available
 * in client.js for any future backend that offers nothing else.
 *
 * The API also answers things AXFR cannot: zone kind (Native/Master/Slave),
 * per-zone DNSSEC state, and server statistics.
 */

const R = require('../records');
const { NOT_APPLICABLE } = require('../capabilities');

const HTTP_TIMEOUT_MS = 15000;

function apiBase(server) {
  const u = String(server.dns_api_url || '').replace(/\/+$/, '');
  if (!u) throw new Error('PowerDNS API URL is not configured');
  const id = server.dns_api_server_id || 'localhost';
  return `${u}/api/v1/servers/${encodeURIComponent(id)}`;
}

async function apiGet(server, path) {
  const key = server.dns_api_key;
  if (!key) throw new Error('PowerDNS API key is not configured');
  const res = await fetch(`${apiBase(server)}${path}`, {
    headers: { 'X-API-Key': key, accept: 'application/json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  // ⛔ 401 MEANS THE KEY IS WRONG, NOT THAT THE SERVER IS DOWN. Collapsing it
  // into a generic failure sends the operator to check the network when the
  // actual fix is one field on the server form.
  if (res.status === 401 || res.status === 403) {
    throw new Error(`PowerDNS rejected the API key (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`PowerDNS API HTTP ${res.status}`);
  return res.json();
}

async function testConnection(server) {
  try {
    const d = await apiGet(server, '');
    return {
      ok: true, version: d.version || null,
      detail: `${d.daemon_type || 'powerdns'} ${d.version || ''}`.trim(),
    };
  } catch (e) {
    return { ok: false, version: null, detail: e.message };
  }
}

/** PowerDNS "kind" -> the vocabulary dns_zones already uses. */
function mapZoneKind(kind) {
  const s = String(kind || '').toLowerCase();
  if (s === 'master' || s === 'native') return 'Primary';
  if (s === 'slave') return 'Secondary';
  if (s === 'forwarded') return 'Forwarder';
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Primary';
}

async function listZones(server) {
  const zones = await apiGet(server, '/zones');
  return (Array.isArray(zones) ? zones : []).map((z) => {
    const name = String(z.name || '').replace(/\.+$/, '');
    return {
      zone_name: name,
      zone_type: mapZoneKind(z.kind),
      serial: Number(z.serial) || null,
      is_reverse: R.isReverseZone(name),
      dnssec: z.dnssec === true,
      api_id: z.id,
    };
  }).filter((z) => z.zone_name);
}

/**
 * ⛔ AN RRSET IS NOT A RECORD. The API returns one rrset per (name, type) with
 * an array of contents inside it — three A records on one host arrive as ONE
 * rrset carrying three values. Writing rrsets straight through would under-count
 * every round-robin host in the estate. They are expanded here so a PowerDNS row
 * means the same thing as a Windows or BIND row.
 */
async function getZoneRecords(server, zoneName) {
  const id = `${String(zoneName).replace(/\.+$/, '')}.`;
  const z = await apiGet(server, `/zones/${encodeURIComponent(id)}`);
  const flat = [];
  for (const rr of (z && z.rrsets) || []) {
    for (const rec of rr.records || []) {
      if (rec.disabled) continue;   // present in the backend but deliberately off
      flat.push({
        name: String(rr.name || '').replace(/\.+$/, ''),
        type: String(rr.type || '').toUpperCase(),
        ttl: Number(rr.ttl) || null,
        _raw: String(rec.content == null ? '' : rec.content),
      });
    }
  }
  // The API hands back presentation-format strings, already in the shape
  // dns_records stores, so only the relativising and skip-list are applied.
  const out = []; const counts = {};
  for (const r of flat) {
    if (R.SKIP_TYPES.has(r.type)) continue;
    const row = {
      hostname: R.relativise(r.name, zoneName),
      record_type: r.type,
      record_data: r._raw,
      ttl: r.ttl,
    };
    if (!row.record_data) continue;
    out.push(row);
    counts[row.record_type] = (counts[row.record_type] || 0) + 1;
  }
  return { records: out, counts, verified: true, serial: Number(z.serial) || null, dnssec: z.dnssec === true };
}

async function getSoa(server, zoneName) {
  const client = require('../client');
  return client.querySoa(server.dns_host, server.dns_port || 53, zoneName);
}

/** @see bind.js — these are cumulative counters too. */
async function getQueryStats(server) {
  const list = await apiGet(server, '/statistics');
  const m = {};
  for (const s of Array.isArray(list) ? list : []) {
    if (s && s.type === 'StatisticItem') m[s.name] = Number(s.value);
  }
  const total = (m['udp-queries'] || 0) + (m['tcp-queries'] || 0);
  const answers = (m['udp-answers'] || 0) + (m['tcp-answers'] || 0);
  return {
    total_queries: total,
    successful: answers,
    failed: m['servfail-packets'] || 0,
    // ⛔ PowerDNS has no NXDOMAIN counter in the authoritative statistics set.
    // null means "this server does not report it" — a 0 would be a measurement
    // we never made, and would read as "this server never returns NXDOMAIN".
    nxdomain_count: null,
    corrupt_packets: m['corrupt-packets'] || 0,
    latency_us: m.latency != null ? m.latency : null,
    uptime_s: m.uptime != null ? m.uptime : null,
    cumulative: true,
  };
}

async function getForwarders() {
  // Forwarding is the PowerDNS *Recursor*, a different daemon entirely.
  return { state: NOT_APPLICABLE, forwarders: [] };
}

module.exports = {
  platform: 'powerdns',
  testConnection, listZones, getZoneRecords, getSoa, getQueryStats, getForwarders,
  mapZoneKind,
};
