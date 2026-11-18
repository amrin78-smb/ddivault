'use strict';
/**
 * records.js — turn wire-format records into the rows dns_records already holds.
 *
 * ⛔ THE EXISTING WINDOWS ROWS ARE THE CONTRACT, NOT A SUGGESTION. The Windows
 * collector writes `rec.HostName` from Get-DnsServerResourceRecord, which is the
 * name RELATIVE to the zone ("web", or "@" for the apex). AXFR returns fully
 * qualified names ("web.lab.example"). Writing FQDNs would put two spellings of
 * the same host in one table — the unique key is
 * (zone_id, hostname, record_type, record_data), so the same record collected by
 * two different platforms would not collide, it would DOUBLE. Every Linux record
 * is therefore relativised to match what Windows already stored.
 */

/** "web.lab.example" in zone "lab.example" -> "web"; the apex -> "@". */
function relativise(fqdn, zoneName) {
  const n = String(fqdn || '').replace(/\.+$/, '').toLowerCase();
  const z = String(zoneName || '').replace(/\.+$/, '').toLowerCase();
  if (!z) return n || '@';
  if (n === z) return '@';
  if (n.endsWith(`.${z}`)) return n.slice(0, -(z.length + 1)) || '@';
  return n || '@'; // out-of-zone (glue): keep it whole rather than mangling it
}

/** TXT rdata arrives as Buffer chunks; join them the way a zone file shows it. */
function txtToString(data) {
  const parts = Array.isArray(data) ? data : [data];
  return parts.map((p) => (Buffer.isBuffer(p) ? p.toString('utf8') : String(p == null ? '' : p))).join('');
}

function stripDot(v) { return String(v == null ? '' : v).replace(/\.+$/, ''); }

/**
 * ⛔ TYPES WE DELIBERATELY DO NOT STORE. SOA is zone-level and already lives on
 * dns_zones.soa_serial; the DNSSEC types are high-volume machine data that would
 * bury the records a human is looking for (one signed zone can carry an RRSIG
 * for every RRset). Dropping them is a product decision, not an oversight — so
 * it is listed here rather than implied by a missing branch.
 */
const SKIP_TYPES = new Set(['SOA', 'RRSIG', 'NSEC', 'NSEC3', 'NSEC3PARAM', 'DNSKEY', 'TSIG', 'OPT']);

/**
 * @returns {{hostname, record_type, record_data, ttl}|null} null = skip this one
 */
function normaliseRecord(rec, zoneName) {
  if (!rec || !rec.type) return null;
  const type = String(rec.type).toUpperCase();
  if (SKIP_TYPES.has(type)) return null;

  const d = rec.data;
  let data;
  switch (type) {
    case 'A': case 'AAAA':
      data = String(d); break;
    case 'CNAME': case 'NS': case 'PTR': case 'DNAME':
      data = stripDot(d); break;
    case 'MX':
      data = `${d && d.preference != null ? d.preference : 0} ${stripDot(d && d.exchange)}`; break;
    case 'SRV':
      data = `${d.priority} ${d.weight} ${d.port} ${stripDot(d.target)}`; break;
    case 'TXT':
      data = txtToString(d); break;
    case 'CAA':
      data = `${d.flags || 0} ${d.tag} "${d.value}"`; break;
    case 'NAPTR':
      data = `${d.order} ${d.preference} "${d.flags}" "${d.services}" "${d.regexp}" ${stripDot(d.replacement)}`; break;
    default:
      // An unknown type is still a real record — keep it, legibly, rather than
      // dropping it silently or writing "[object Object]".
      data = Buffer.isBuffer(d) ? d.toString('hex') : (typeof d === 'object' ? JSON.stringify(d) : String(d));
  }
  if (data == null || data === '') return null;

  return {
    hostname: relativise(rec.name, zoneName),
    record_type: type,
    record_data: data,
    ttl: Number.isFinite(rec.ttl) ? rec.ttl : null,
  };
}

/** Whole-zone convenience: normalise, drop skips, and count by type. */
function normaliseZone(records, zoneName) {
  const out = [];
  const counts = {};
  for (const r of records || []) {
    const n = normaliseRecord(r, zoneName);
    if (!n) continue;
    out.push(n);
    counts[n.record_type] = (counts[n.record_type] || 0) + 1;
  }
  return { records: out, counts };
}

/** A reverse zone by name — same test the Windows path's IsReverseLookupZone makes. */
function isReverseZone(zoneName) {
  return /\.(in-addr|ip6)\.arpa\.?$/i.test(String(zoneName || ''));
}

module.exports = { relativise, normaliseRecord, normaliseZone, txtToString, isReverseZone, SKIP_TYPES };
