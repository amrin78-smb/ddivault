'use strict';

/**
 * writers.js — shared DB-write half of the DDIVault collector (Phase 4b).
 *
 * The central collector (collector/collector.js) historically interleaved
 * "collect over WinRM" and "write to Postgres" inside each per-type function.
 * The remote-agent data plane needs the SECOND half only: an agent has already
 * collected the raw PowerShell output on its own LAN and ships it back over the
 * WebSocket ingest server (api/ws-server.js), which must persist it through the
 * EXACT same UPSERT/alert logic the central collector uses — so a scope written
 * by an agent is indistinguishable from one polled centrally.
 *
 * This module is therefore the single source of truth for "given already-
 * collected raw `data` for a server, write it". Both callers use it:
 *   - collector.js  — collects via powershellRunner, then calls write*(...).
 *   - ws-server.js  — receives ddi_result{kind,data} from an agent, then calls
 *                     write*(...) with the same raw shapes.
 *
 * Every function takes an explicit `db` Pool (never a module-global) so the two
 * callers pass their own pool. `ctx` carries { log, warn } loggers (default to
 * console) and, for scope stats, an optional async `getGateway(scopeId)` used
 * only when auto-creating a NEW IPAM subnet (WinRM-backed centrally; a no-op for
 * agent ingest, which simply skips gateway auto-fill).
 *
 * Plain JavaScript only — no TypeScript syntax.
 */

const ipamSync = require('./ipamSync');
const deviceClassifier = require('../api/deviceClassifier');

// ── Alert thresholds (identical to collector.js) ───────────────
const SCOPE_WARNING_PCT        = parseFloat(process.env.SCOPE_WARNING_PCT       || '80');
const SCOPE_CRITICAL_PCT       = parseFloat(process.env.SCOPE_CRITICAL_PCT      || '90');
const SCOPE_WARNING_CLEAR_PCT  = parseFloat(process.env.SCOPE_WARNING_CLEAR_PCT  || '75');
const SCOPE_CRITICAL_CLEAR_PCT = parseFloat(process.env.SCOPE_CRITICAL_CLEAR_PCT || '85');

// ── Pure coercion helpers (verbatim copies from collector.js) ──
// Kept here so this module is self-contained and has no circular dep on
// collector.js (which runs main() at load and would start a 2nd collector).
const cleanIp = ip => (ip || '').replace(/\/\d+$/, '').trim();

function scopeIdStr(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.IPAddressToString || v.Address || '').trim();
  return String(v).trim();
}

function parsePsDate(val) {
  if (!val) return null;
  const m = String(val).match(/\/Date\((\d+)\)\//);
  if (m) return new Date(parseInt(m[1])).toISOString();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parsePsDuration(val) {
  if (!val) return null;
  if (typeof val === 'object' && val !== null) {
    const d = val.Days || 0;
    const h = val.Hours || 0;
    const m = val.Minutes || 0;
    const s = val.Seconds || 0;
    if (d > 0) return `${d} day${d !== 1 ? 's' : ''}`;
    if (h > 0) return `${h} hour${h !== 1 ? 's' : ''}`;
    if (m > 0) return `${m} minute${m !== 1 ? 's' : ''}`;
    return `${s} seconds`;
  }
  return String(val);
}

function loggers(ctx) {
  const log  = (ctx && ctx.log)  || ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
  const warn = (ctx && ctx.warn) || ((m) => console.warn(`[${new Date().toISOString()}] WARN: ${m}`));
  return { log, warn };
}

async function updateServerStatus(db, serverId, status, errorMsg) {
  await db.query(
    `UPDATE ddi_servers SET last_polled=NOW(), poll_status=$2, poll_error=$3 WHERE id=$1`,
    [serverId, status, errorMsg || null]
  );
}

// Classify a device and persist fingerprint columns on a dhcp_leases row.
async function classifyAndTagLease(db, serverId, ip, mac, hostname) {
  if (!mac) return;
  try {
    const c = deviceClassifier.classifyDevice(mac, hostname || '');
    const randomized = deviceClassifier.isMacRandomized(mac);
    await db.query(
      `UPDATE dhcp_leases SET device_type=$1, device_vendor=$2, device_os=$3, risk_level=$4,
         is_mac_randomized=$5, first_seen=COALESCE(first_seen, NOW())
       WHERE server_id=$6 AND ip_address=$7::inet`,
      [c.type || null, c.vendor || null, c.os || null, c.risk_level || 'unknown', !!randomized, serverId, ip]
    ).catch(()=>{});
  } catch (_) {}
}

// Auto-create IPAM subnets/supernets from discovered DHCP scopes.
// getGateway(scopeId) is only invoked for NEW subnets; central passes a
// WinRM-backed resolver, agent ingest passes a null-returning stub.
async function syncScopesToIpam(db, ip, scopeConfig, ctx) {
  const { log } = loggers(ctx);
  const getGateway = (ctx && ctx.getGateway) || (async () => null);
  const scopes = Object.entries(scopeConfig || {}).map(([scopeId, cfg]) => ({
    scopeId,
    subnetMask: scopeIdStr(cfg.SubnetMask),
    name: cfg.Name || null,
  }));
  if (!scopes.length) return;
  try {
    const r = await ipamSync.syncScopesToIpam(db, scopes, { log, getGateway });
    if (r.created || r.updated || r.supernetsCreated) {
      log(`[IPAM Sync] ${ip} — ${r.created} created, ${r.updated} updated, ${r.supernetsCreated} supernet(s)`);
    }
  } catch (err) {
    console.error(`[IPAM Sync] ${ip} error:`, err.message);
  }
}

/**
 * Write DHCP scope stats + config for one server.
 * data = { stats: [...Get-DhcpServerv4ScopeStatistics], scopes: [...Get-DhcpServerv4Scope] }
 */
async function writeScopeStats(db, server, data, ctx) {
  const { log, warn } = loggers(ctx);
  const ip = cleanIp(server.ip_address);
  const stats  = (data && data.stats)  || [];
  const scopes = (data && data.scopes) || [];

  if (!stats || !stats.length) {
    warn(`[Scopes] No data from ${ip} — WinRM not reachable or DHCP role not installed`);
    await updateServerStatus(db, server.id, 'error', 'No scope stats returned — check WinRM');
    return;
  }

  const scopeConfig = {};
  for (const s of (scopes || [])) {
    const key = scopeIdStr(s.ScopeId);
    if (key) scopeConfig[key] = s;
  }

  let upserted = 0;
  const alertsToFire = [];

  for (const stat of stats) {
    const scopeId  = scopeIdStr(stat.ScopeId);
    if (!scopeId) continue;
    const inUse    = parseInt(stat.InUse    || 0);
    const free     = parseInt(stat.Free     || 0);
    const reserved = parseInt(stat.Reserved || 0);
    const pending  = parseInt(stat.Pending  || 0);
    const total    = inUse + free;
    const pct      = total > 0 ? parseFloat(((inUse / total) * 100).toFixed(2)) : 0;
    const cfg      = scopeConfig[scopeId] || {};
    const scopeState = total === 0 ? 'empty' : (cfg.State || 'Active').toLowerCase();

    const res = await db.query(
      `INSERT INTO dhcp_scopes
         (server_id, scope_id, name, start_range, end_range, subnet_mask,
          state, lease_duration, total_ips, in_use, free, reserved, pending,
          percent_used, description, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (server_id, scope_id) DO UPDATE SET
         name=EXCLUDED.name, start_range=EXCLUDED.start_range,
         end_range=EXCLUDED.end_range, subnet_mask=EXCLUDED.subnet_mask,
         state=EXCLUDED.state, lease_duration=EXCLUDED.lease_duration,
         total_ips=EXCLUDED.total_ips, in_use=EXCLUDED.in_use,
         free=EXCLUDED.free, reserved=EXCLUDED.reserved,
         pending=EXCLUDED.pending, percent_used=EXCLUDED.percent_used,
         description=EXCLUDED.description, last_updated=NOW()
       RETURNING id`,
      [server.id, scopeId, cfg.Name||null,
       scopeIdStr(cfg.StartRange)||null, scopeIdStr(cfg.EndRange)||null,
       scopeIdStr(cfg.SubnetMask)||null, scopeState,
       parsePsDuration(cfg.LeaseDuration),
       total, inUse, free, reserved, pending, pct, cfg.Description||null]
    );

    const dbScopeId = res.rows[0]?.id;
    if (dbScopeId) {
      await db.query(
        `INSERT INTO dhcp_scope_history (scope_id, in_use, free, reserved, percent_used)
         VALUES ($1,$2,$3,$4,$5)`,
        [dbScopeId, inUse, free, reserved, pct]
      );
    }

    const _mask = scopeIdStr(cfg.SubnetMask);
    const prefixLength = _mask ? ipamSync.maskToPrefixLength(_mask) : 0;
    if (prefixLength >= 1 && prefixLength <= 32) {
      await db.query(
        `UPDATE ipam_subnets SET used_hosts = $1, free_hosts = $2, total_hosts = $3, updated_at = NOW()
         WHERE network = $4::inet AND prefix_length = $5`,
        [inUse, free, total, scopeId, prefixLength]
      ).catch(() => {});
    }

    if (pct >= 100) {
      alertsToFire.push({ scopeId, pct, severity:'critical', msg:`[${ip}] Scope ${scopeId} is 100% FULL (${inUse}/${total} IPs)` });
    } else if (pct >= SCOPE_CRITICAL_PCT) {
      alertsToFire.push({ scopeId, pct, severity:'critical', msg:`[${ip}] Scope ${scopeId} is ${pct.toFixed(1)}% full — ${free} IPs remaining` });
    } else if (pct >= SCOPE_WARNING_PCT) {
      alertsToFire.push({ scopeId, pct, severity:'warning',  msg:`[${ip}] Scope ${scopeId} is ${pct.toFixed(1)}% full — ${free} IPs remaining` });
    }

    if (pct < SCOPE_CRITICAL_CLEAR_PCT) {
      await db.query(
        `UPDATE alert_events
            SET resolved_at = NOW(), resolved_reason = 'condition-cleared',
                acknowledged = TRUE, acknowledged_by = COALESCE(acknowledged_by, 'system'),
                acknowledged_at = COALESCE(acknowledged_at, NOW())
          WHERE scope_id = $1 AND severity = 'critical'
            AND acknowledged = FALSE AND resolved_at IS NULL`,
        [scopeId]
      ).catch(() => {});
    }
    if (pct < SCOPE_WARNING_CLEAR_PCT) {
      await db.query(
        `UPDATE alert_events
            SET resolved_at = NOW(), resolved_reason = 'condition-cleared',
                acknowledged = TRUE, acknowledged_by = COALESCE(acknowledged_by, 'system'),
                acknowledged_at = COALESCE(acknowledged_at, NOW())
          WHERE scope_id = $1 AND severity = 'warning'
            AND acknowledged = FALSE AND resolved_at IS NULL`,
        [scopeId]
      ).catch(() => {});
    }
    upserted++;
  }

  log(`[Scopes] ${ip} — updated ${upserted} scope(s)`);

  for (const alert of alertsToFire) {
    const open = await db.query(
      `SELECT id FROM alert_events
        WHERE scope_id=$1 AND severity=$2 AND acknowledged=FALSE AND resolved_at IS NULL
        LIMIT 1`,
      [alert.scopeId, alert.severity]
    );
    if (!open.rows.length) {
      await db.query(
        `INSERT INTO alert_events (scope_id, message, severity, server_id) VALUES ($1,$2,$3,$4)`,
        [alert.scopeId, alert.msg, alert.severity, server.id]
      );
      log(`[Alert] ${alert.severity.toUpperCase()}: ${alert.msg}`);
    }
  }

  await updateServerStatus(db, server.id, 'ok', null);
  await syncScopesToIpam(db, ip, scopeConfig, ctx);
}

/**
 * Write DHCP leases for one server.  data = [...Get-DhcpServerv4Lease]
 */
async function writeLeases(db, server, leases, ctx) {
  const { log, warn } = loggers(ctx);
  const ip = cleanIp(server.ip_address);
  if (!leases || !leases.length) {
    warn(`[Leases] No leases from ${ip}`);
    return;
  }

  await db.query(
    `UPDATE dhcp_leases SET address_state='Expired' WHERE server_id=$1 AND lease_expiry < NOW()`,
    [server.id]
  );

  let upserted = 0;
  for (const lease of leases) {
    const ip_addr = scopeIdStr(lease.IPAddress) || null;
    const mac     = lease.ClientId     || null;
    const host    = lease.HostName     || null;
    const scopeId = scopeIdStr(lease.ScopeId) || null;
    const state   = lease.AddressState || 'Active';
    const expiry  = parsePsDate(lease.LeaseExpiryTime);
    if (!ip_addr) continue;

    await db.query(
      `INSERT INTO dhcp_leases
         (server_id, scope_id, ip_address, hostname, mac_address, address_state, lease_expiry, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (server_id, ip_address) DO UPDATE SET
         scope_id=EXCLUDED.scope_id, hostname=EXCLUDED.hostname,
         mac_address=EXCLUDED.mac_address, address_state=EXCLUDED.address_state,
         lease_expiry=EXCLUDED.lease_expiry, last_seen=NOW()`,
      [server.id, scopeId, ip_addr, host, mac, state, expiry]
    );
    await classifyAndTagLease(db, server.id, ip_addr, mac, host);
    upserted++;
  }
  log(`[Leases] ${ip} — synced ${upserted} leases`);
}

/**
 * Write DHCP reservations for one server.  data = [...Get-DhcpServerv4Reservation]
 */
async function writeReservations(db, server, reservations, ctx) {
  const { log } = loggers(ctx);
  const ip = cleanIp(server.ip_address);
  if (!reservations || !reservations.length) return;
  let upserted = 0;
  for (const r of reservations) {
    const scopeId = scopeIdStr(r.ScopeId);
    const ipAddr  = scopeIdStr(r.IPAddress);
    const mac     = String(r.ClientId || '').trim().toLowerCase().replace(/-/g, ':');
    const name    = String(r.Name || '').trim() || null;
    if (!scopeId || !ipAddr) continue;
    await db.query(
      `INSERT INTO dhcp_leases
         (server_id, scope_id, ip_address, hostname, mac_address, address_state, last_seen)
       VALUES ($1,$2,$3::inet,$4,$5,'Reservation',NOW())
       ON CONFLICT (server_id, ip_address) DO UPDATE SET
         scope_id      = EXCLUDED.scope_id,
         hostname      = COALESCE(EXCLUDED.hostname, dhcp_leases.hostname),
         mac_address   = COALESCE(EXCLUDED.mac_address, dhcp_leases.mac_address),
         address_state = 'Reservation',
         last_seen     = NOW()`,
      [server.id, scopeId, ipAddr, name, mac]
    );
    await classifyAndTagLease(db, server.id, ipAddr, mac, name);
    upserted++;
  }
  log(`[Reservations] ${ip} — synced ${upserted} reservation(s)`);
}

/**
 * Write parsed DHCP log events for one server. data = [...parsed events]
 * (same shape dhcpReader.readDhcpLogSince produces). Returns the newest
 * event_time seen so the central tailer can advance its per-server cursor.
 */
async function writeDhcpEvents(db, server, events, ctx) {
  const { log } = loggers(ctx);
  const serverId = server.id;
  const ip = cleanIp(server.ip_address);
  if (!events || !events.length) return { inserted: 0, lastTime: null };

  let inserted = 0;
  let lastTime = null;

  for (const ev of events) {
    if (!ev.event_time) continue;
    try {
      // rowCount tells us whether this event was genuinely NEW (1) or a repeat the
      // ON CONFLICT swallowed (0). Everything below keys off that, because the tail
      // is re-read on every poll and in full after any restart, so the same events
      // arrive many times over.
      const res = await db.query(
        `INSERT INTO dhcp_events
           (server_id, event_id, event_type, ip_address, hostname, mac_address, description, raw_line, event_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [serverId, ev.event_id, ev.event_type, ev.ip_address, ev.hostname,
         ev.mac_address, ev.description, ev.raw_line, ev.event_time]
      );
      const isNew = res.rowCount === 1;
      // Was `inserted++` unconditionally, which counted events ATTEMPTED, not rows
      // stored — a restart reported "inserted 2012 new events" while 209 rows landed.
      if (isNew) inserted++;

      // lastTime advances for duplicates too: it is the high-water mark for what we
      // have SEEN, not what we stored, and it must move past re-read events.
      const t = new Date(ev.event_time);
      if (!lastTime || t > lastTime) lastTime = t;

      // ⛔ Everything from here on must be gated on isNew. lease_history has no
      // unique constraint and no ON CONFLICT, so writing it for a duplicate event
      // silently appends another copy. That is not hypothetical: this left 2056
      // surplus rows out of 5561 on the live server (37%), some lease events stored
      // 6 times, which skews every per-IP lease history and count built on them.
      // The 1020/2019 alert checks are gated for the same reason — they re-ran on
      // every re-read and only avoided duplicate alerts via their own open-alert
      // lookup, i.e. wasted queries on data already processed.
      if (!isNew) continue;

      if ([10,11,12,20].includes(ev.event_id) && ev.ip_address) {
        const typeMap = { 10:'assign', 11:'renew', 12:'release', 20:'expire' };
        await db.query(
          `INSERT INTO lease_history (server_id, ip_address, hostname, mac_address, event_type, event_time)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [serverId, ev.ip_address, ev.hostname, ev.mac_address, typeMap[ev.event_id], ev.event_time]
        ).catch(() => {});
      }

      if (ev.event_id === 1020) {
        const msg1020 = `[${ip}] DHCP scope full: ${ev.description}`;
        const open1020 = await db.query(
          `SELECT id FROM alert_events
            WHERE server_id=$1 AND scope_id=$2 AND message=$3
              AND acknowledged=FALSE AND resolved_at IS NULL
            LIMIT 1`,
          [serverId, ev.ip_address, msg1020]
        ).catch(() => ({ rows: [] }));
        if (!open1020.rows.length) {
          await db.query(
            `INSERT INTO alert_events (server_id, scope_id, message, severity)
             VALUES ($1,$2,$3,'critical')`,
            [serverId, ev.ip_address, msg1020]
          ).catch(() => {});
        }
      }
      if (ev.event_id === 2019) {
        const open2019 = await db.query(
          `SELECT id FROM alert_events
            WHERE server_id=$1 AND message LIKE '%Rogue DHCP server detected%'
              AND acknowledged=FALSE AND resolved_at IS NULL
            LIMIT 1`,
          [serverId]
        ).catch(() => ({ rows: [] }));
        if (!open2019.rows.length) {
          await db.query(
            `INSERT INTO alert_events (server_id, message, severity) VALUES ($1,$2,'critical')`,
            [serverId, `[${ip}] Rogue DHCP server detected!`]
          ).catch(() => {});
        }
      }
    } catch (err) {
      if (!err.message.includes('unique')) console.error('[Log] Insert error:', err.message);
    }
  }

  if (inserted > 0) log(`[Log] ${ip} — inserted ${inserted} new events`);
  return { inserted, lastTime };
}

/**
 * Write DNS zones (and, when provided, their records) for one server.
 * data = { zones: [...Get-DnsServerZone],
 *          recordsByZone: { "<ZoneName>": [...Get-DnsServerResourceRecord] } }
 * recordsByZone is optional and only consulted for eligible primary zones —
 * exactly the zones the central collector fetches records for.
 */
async function writeDnsZones(db, server, data, ctx) {
  const { log, warn } = loggers(ctx);
  const ip = cleanIp(server.ip_address);
  const zones = (data && data.zones) || [];
  const recordsByZone = (data && data.recordsByZone) || {};
  if (!zones || !zones.length) {
    warn(`[DNS] No zones from ${ip}`);
    return;
  }

  let zoneCount = 0;
  for (const zone of zones) {
    const res = await db.query(
      `INSERT INTO dns_zones (server_id, zone_name, zone_type, is_reverse, is_ds_integrated, is_auto_created)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (server_id, zone_name) DO UPDATE SET
         zone_type=EXCLUDED.zone_type, is_reverse=EXCLUDED.is_reverse,
         is_ds_integrated=EXCLUDED.is_ds_integrated, last_updated=NOW()
       RETURNING id`,
      [server.id, zone.ZoneName, zone.ZoneType, zone.IsReverseLookupZone===true,
       zone.IsDsIntegrated===true, zone.IsAutoCreated===true]
    );
    zoneCount++;

    const zoneDbId = res.rows[0]?.id;
    const records = recordsByZone[zone.ZoneName];
    if (zoneDbId && !zone.IsReverseLookupZone && !zone.IsAutoCreated && zone.ZoneType === 'Primary'
        && records && records.length) {
      for (const rec of records) {
        await db.query(
          `INSERT INTO dns_records (zone_id, hostname, record_type, record_data, ttl, last_seen)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (zone_id, hostname, record_type, record_data)
           DO UPDATE SET ttl = EXCLUDED.ttl, last_seen = NOW()`,
          [zoneDbId, rec.HostName, rec.RecordType, String(rec.RecordData||''), rec.TimeToLive||null]
        ).catch(() => {});
      }
      await db.query('UPDATE dns_zones SET record_count=$1 WHERE id=$2', [records.length, zoneDbId]);
    }
  }
  log(`[DNS] ${ip} — synced ${zoneCount} zones`);
}

/**
 * Write an IPAM ping-sweep result for one subnet (Phase 4b agent ingest).
 * subnet  = { id, network, prefix_length, name }
 * results = [ { ip, alive, ping_ms, mac_address, hostname, is_dhcp, dhcp_lease_id } ]
 *   — the per-IP outcome the AGENT collected on its own LAN (the central
 *   ipamScanner does this itself and does NOT use this function). Mirrors the
 *   status/classification/alert logic of ipamScanner.scanSubnet's write half so
 *   an agent-scanned subnet is indistinguishable from a centrally-scanned one.
 */
async function writeScanResult(db, subnet, results, ctx) {
  const { log, warn } = loggers(ctx);
  const subnetId = subnet.id;
  const label = `${subnet.network}/${subnet.prefix_length}${subnet.name ? ` (${subnet.name})` : ''}`;
  const list = Array.isArray(results) ? results : [];

  const jobRes = await db.query(
    `INSERT INTO ipam_scan_jobs (subnet_id, status) VALUES ($1, 'running') RETURNING id`,
    [subnetId]
  );
  const jobId = jobRes.rows[0].id;
  await db.query(
    `UPDATE ipam_subnets SET scan_status='scanning', last_scanned=NOW() WHERE id=$1`,
    [subnetId]
  );

  let hostsScanned = 0, hostsUp = 0, hostsUnknown = 0;
  try {
    const reservedRes = await db.query(
      `SELECT ip_address::text FROM ipam_addresses WHERE subnet_id=$1 AND is_reserved=TRUE`,
      [subnetId]
    );
    const reservedSet = new Set(reservedRes.rows.map(r => r.ip_address));

    for (const r of list) {
      const ip = String(r.ip || '').trim();
      if (!ip) continue;
      hostsScanned++;
      if (reservedSet.has(ip)) continue;

      const hostname   = r.hostname || null;
      const macAddress = r.mac_address || null;
      const isDhcp     = !!r.is_dhcp;
      const alive      = !!r.alive || (!!macAddress && !isDhcp);

      let devType = null, devVendor = null, devRisk = 'unknown';
      if (macAddress) {
        try {
          const c = deviceClassifier.classifyDevice(macAddress, hostname || '');
          devType = c.type || null; devVendor = c.vendor || null; devRisk = c.risk_level || 'unknown';
        } catch (_) {}
      }

      let status;
      if (isDhcp) { status = 'dhcp'; hostsUp++; }
      else if (alive) { status = 'unknown'; hostsUp++; hostsUnknown++; }
      else { status = 'available'; }

      await db.query(
        `INSERT INTO ipam_addresses
           (subnet_id, ip_address, status, hostname, mac_address, last_ping, ping_ms, last_seen, dhcp_lease_id, device_type, device_vendor, risk_level, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (subnet_id, ip_address) DO UPDATE SET
           status        = CASE WHEN ipam_addresses.is_reserved THEN ipam_addresses.status ELSE EXCLUDED.status END,
           hostname      = COALESCE(EXCLUDED.hostname, ipam_addresses.hostname),
           mac_address   = COALESCE(EXCLUDED.mac_address, ipam_addresses.mac_address),
           last_ping     = NOW(),
           ping_ms       = EXCLUDED.ping_ms,
           last_seen     = CASE WHEN EXCLUDED.status != 'available' THEN NOW() ELSE ipam_addresses.last_seen END,
           dhcp_lease_id = EXCLUDED.dhcp_lease_id,
           device_type   = EXCLUDED.device_type,
           device_vendor = COALESCE(EXCLUDED.device_vendor, ipam_addresses.device_vendor),
           risk_level    = EXCLUDED.risk_level,
           updated_at    = NOW()`,
        [subnetId, ip, status, hostname, macAddress, r.ping_ms != null ? r.ping_ms : null,
         alive || isDhcp ? new Date().toISOString() : null, r.dhcp_lease_id || null,
         devType, devVendor, devRisk]
      );

      if (status === 'unknown') {
        await db.query(
          `INSERT INTO alert_events (scope_id, message, severity)
           SELECT $1, $2, 'warning'
           WHERE NOT EXISTS (
             SELECT 1 FROM alert_events
             WHERE scope_id=$1 AND message LIKE $3 AND fired_at > NOW()-INTERVAL '24 hours'
           )`,
          [subnet.network, `Unknown device at ${ip}${hostname ? ` (${hostname})` : ''} — responds to ping but has no DHCP lease`,
           `%Unknown device at ${ip}%`]
        ).catch(() => {});
      }
    }

    const freeHosts = hostsScanned - hostsUp;
    await db.query(
      `UPDATE ipam_subnets SET scan_status='done', last_scanned=NOW(),
         total_hosts=$2, used_hosts=$3, free_hosts=$4, unknown_hosts=$5 WHERE id=$1`,
      [subnetId, hostsScanned, hostsUp, freeHosts, hostsUnknown]
    );
    await db.query(
      `UPDATE ipam_scan_jobs SET status='done', completed_at=NOW(),
         hosts_scanned=$2, hosts_up=$3, hosts_unknown=$4, progress_pct=100, updated_at=NOW() WHERE id=$1`,
      [jobId, hostsScanned, hostsUp, hostsUnknown]
    );
    log(`[Scan] ${label} — DONE (agent). Alive: ${hostsUp}/${hostsScanned}, Unknown: ${hostsUnknown}`);
    return { hostsScanned, hostsUp, hostsUnknown, freeHosts };
  } catch (err) {
    warn(`[Scan] ${label} — write error: ${err.message}`);
    await db.query(`UPDATE ipam_subnets SET scan_status='error' WHERE id=$1`, [subnetId]).catch(() => {});
    await db.query(
      `UPDATE ipam_scan_jobs SET status='error', completed_at=NOW(), error_msg=$2 WHERE id=$1`,
      [jobId, err.message]
    ).catch(() => {});
    return {};
  }
}

module.exports = {
  writeScopeStats,
  writeLeases,
  writeReservations,
  writeDhcpEvents,
  writeDnsZones,
  writeScanResult,
  updateServerStatus,
  classifyAndTagLease,
  // helpers re-exported for callers that need identical coercion
  scopeIdStr, parsePsDate, parsePsDuration, cleanIp,
};
