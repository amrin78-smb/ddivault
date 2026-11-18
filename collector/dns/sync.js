'use strict';
/**
 * sync.js — collect a Linux/third-party DNS server into the SAME tables the
 * Windows path writes.
 *
 * ⛔ THIS ADAPTS TO writers.js, writers.js DOES NOT ADAPT TO THIS. The writer
 * already handles zone upsert, the record unique-key, record_count and the
 * conflict semantics, and it is the code production has been running against
 * 339 zones. Reshaping it for a second producer would put the Windows estate at
 * risk to make the new path prettier, so the new path speaks the writer's
 * existing vocabulary (ZoneName/ZoneType/HostName/RecordData) instead.
 */

const { providerFor, serverContext } = require('./index');
const caps = require('./capabilities');

function log(ctx, m) { (ctx && ctx.log ? ctx.log : console.log)(m); }
function warn(ctx, m) { (ctx && ctx.warn ? ctx.warn : console.warn)(m); }

/**
 * Serials we already hold, so an unchanged zone is never transferred.
 *
 * ⛔ THIS IS THE DIFFERENCE BETWEEN A FEATURE AND AN OUTAGE. Production holds
 * 339 zones / 256,951 records. Transferring every zone every cycle moves
 * hundreds of MB to discover that nothing changed — and AXFR is TCP, so it is
 * the DNS server's resources being spent too. A zone's SOA serial is REQUIRED
 * to change when its contents do, so one small query per zone replaces the
 * transfer for every zone that did not move.
 */
async function storedSerials(db, serverId) {
  const m = new Map();
  try {
    const r = await db.query('SELECT zone_name, soa_serial, record_count FROM dns_zones WHERE server_id = $1', [serverId]);
    for (const row of r.rows) m.set(row.zone_name, { serial: row.soa_serial == null ? null : Number(row.soa_serial), count: row.record_count });
  } catch (e) { /* first run, or the column is missing on an un-migrated DB */ }
  return m;
}

/** The writer's own eligibility test, mirrored so we do not transfer what it will discard. */
function writerWillStoreRecords(z) {
  return !z.is_reverse && z.zone_type === 'Primary';
}

/**
 * @param {object} db      pg pool
 * @param {object} row     a ddi_servers row (secrets already decrypted)
 * @param {object} writers collector/writers.js
 * @returns {Promise<{zones:number, transferred:number, skipped:number, records:number, error:string|null}>}
 */
async function syncProtocolDns(db, row, writers, ctx) {
  const server = serverContext(row);
  const provider = providerFor(server.dns_platform);
  const out = { zones: 0, transferred: 0, skipped: 0, records: 0, error: null };
  if (!provider) { out.error = `no provider for platform "${server.dns_platform}"`; return out; }
  if (!server.dns_host) { out.error = 'no DNS host/IP configured'; return out; }

  let zones;
  try {
    zones = await provider.listZones(server);
  } catch (e) {
    out.error = `zone list failed: ${e.message}`;
    await recordOutcome(db, row.id, server, out);
    return out;
  }
  out.zones = zones.length;

  const known = await storedSerials(db, row.id);
  const wZones = [];
  const recordsByZone = {};

  for (const z of zones) {
    // Shape the zone the way writers.writeDnsZones expects.
    wZones.push({
      ZoneName: z.zone_name,
      ZoneType: z.zone_type,
      IsReverseLookupZone: !!z.is_reverse,
      // ⛔ AD integration and auto-created zones are WINDOWS concepts. false is
      // the correct value to store for a platform that has no such notion —
      // the capability matrix is what tells the UI not to render it as a fact
      // about this server. See capabilities.js.
      IsDsIntegrated: false,
      IsAutoCreated: false,
    });

    if (!writerWillStoreRecords(z)) continue;

    const prior = known.get(z.zone_name);
    let serial = z.serial;
    if (serial == null) {
      try { serial = (await provider.getSoa(server, z.zone_name)).serial; }
      catch (e) { warn(ctx, `[DNS/${server.dns_platform}] ${z.zone_name}: SOA probe failed: ${e.message}`); }
    }
    // Unchanged serial AND we already hold records for it -> nothing to fetch.
    if (prior && prior.serial != null && serial != null && prior.serial === serial && prior.count > 0) {
      out.skipped++;
      continue;
    }

    try {
      const r = await provider.getZoneRecords(server, z.zone_name);
      recordsByZone[z.zone_name] = r.records.map((x) => ({
        HostName: x.hostname, RecordType: x.record_type,
        RecordData: x.record_data, TimeToLive: x.ttl,
      }));
      out.transferred++;
      out.records += r.records.length;
    } catch (e) {
      // ⛔ ONE BAD ZONE MUST NOT COST THE OTHER 338. A zone whose transfer is
      // refused (a key that covers only some zones is normal) is logged and
      // left with whatever records it already had, rather than aborting the run
      // or emptying it.
      warn(ctx, `[DNS/${server.dns_platform}] ${z.zone_name}: transfer failed: ${e.message}`);
      out.error = out.error || `${z.zone_name}: ${e.message}`;
    }
  }

  if (wZones.length) {
    await writers.writeDnsZones(db, row, { zones: wZones, recordsByZone }, ctx);
    await persistSerials(db, row.id, zones);
  }
  await recordOutcome(db, row.id, server, out);
  log(ctx, `[DNS/${server.dns_platform}] ${server.dns_host} — ${out.zones} zones, ${out.transferred} transferred, ${out.skipped} unchanged, ${out.records} records`);
  return out;
}

async function persistSerials(db, serverId, zones) {
  for (const z of zones) {
    if (z.serial == null) continue;
    try {
      await db.query('UPDATE dns_zones SET soa_serial = $1 WHERE server_id = $2 AND zone_name = $3',
        [z.serial, serverId, z.zone_name]);
    } catch { /* un-migrated column — the next schema apply fixes it */ }
  }
}

/**
 * Persist what this server can actually do, plus the last error.
 * ⛔ The capability verdict is STORED, not re-derived at render time, so a
 * capability that silently DEGRADED (someone switched the statistics channel
 * off, so zones went supported -> not_available) is visible as a change rather
 * than as a page that quietly went blank.
 */
async function recordOutcome(db, serverId, server, out) {
  const verdict = {};
  for (const c of caps.CAPABILITIES) verdict[c] = caps.capabilityFor(server, c);
  try {
    await db.query(
      `UPDATE ddi_servers SET dns_capabilities = $1::jsonb, dns_last_error = $2, last_polled = NOW() WHERE id = $3`,
      [JSON.stringify(verdict), out.error, serverId]);
  } catch (e) { /* un-migrated DB */ }
}

module.exports = { syncProtocolDns, storedSerials, writerWillStoreRecords };
