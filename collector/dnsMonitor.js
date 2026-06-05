'use strict';

/**
 * dnsMonitor.js — DNS infrastructure monitoring for DDIVault.
 *
 * Two exported entry points, each called on its own cadence from collector.js:
 *   runDnsMonitor     — per-server: roles, zone SOA sync, record counts,
 *                       forwarder health, scavenging config (every 15m)
 *   detectStaleRecords — nightly snapshot of stale DNS records per zone
 *
 * All functions are fully defensive: a failure on one server or one zone
 * never aborts the others, and the exported functions never throw.
 */

function log(msg) { console.log(`[${new Date().toISOString()}] [DNS-Monitor] ${msg}`); }

// PostgreSQL inet values include CIDR (e.g. 172.24.0.10/32) which the
// PowerShell remoting functions reject — strip it before any PS use.
const cleanIp = ip => (ip || '').replace(/\/\d+$/, '').trim();

// PowerShell serializes a .NET DateTime as "/Date(1781141126961)/" which
// PostgreSQL rejects for TIMESTAMPTZ columns. Convert to ISO-8601 (or null).
function parsePsDate(val) {
  if (!val) return null;
  const m = String(val).match(/\/Date\((\d+)\)\//);
  if (m) return new Date(parseInt(m[1])).toISOString();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Validate a plain IPv4 string (for forwarder lists).
function isIpStr(v) {
  return typeof v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v.trim());
}

function toInt(v) {
  const n = parseInt(v);
  return Number.isFinite(n) ? n : 0;
}

// ── 1. Server roles + forwarders ──────────────────────────────
async function detectDnsRoles(db, ps, server, ip, auth) {
  let role;
  try { role = ps.getDnsServerRole(ip, auth); } catch (e) { log(`[Roles] ${ip}: ${e.message}`); return; }
  if (!role) return;

  const isPdc = role.isPDC === true;
  // Parse comma-separated forwarder string into a JS array (text[]).
  const forwarders = String(role.forwarders || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  await db.query(
    `INSERT INTO dns_server_roles (server_id, is_primary, is_pdc_emulator, domain, replication_type, detected_at, updated_at)
     VALUES ($1,$2,$3,$4,'ad-integrated',NOW(),NOW())
     ON CONFLICT (server_id) DO UPDATE SET
       is_primary=EXCLUDED.is_primary, is_pdc_emulator=EXCLUDED.is_pdc_emulator,
       domain=EXCLUDED.domain, replication_type=EXCLUDED.replication_type, updated_at=NOW()`,
    [server.id, isPdc, isPdc, role.domain || null]
  ).catch(e => log(`[Roles] ${ip} upsert failed: ${e.message}`));

  await db.query(
    `UPDATE ddi_servers SET is_dns_primary=$2, dns_forwarders=$3 WHERE id=$1`,
    [server.id, isPdc, forwarders]
  ).catch(e => log(`[Roles] ${ip} server update failed: ${e.message}`));
}

// ── 2. Zone SOA / sync status ─────────────────────────────────
async function pollZoneSyncStatus(db, ps, server, ip, auth, zones) {
  for (const z of zones) {
    let soa;
    try { soa = ps.getDnsZoneSoaDetail(ip, auth, z.zone_name); }
    catch (e) { log(`[SOA] ${ip}/${z.zone_name}: ${e.message}`); continue; }
    if (!soa || soa.Serial == null) continue;
    const serial = parseInt(soa.Serial);
    if (!Number.isFinite(serial)) continue;

    await db.query(
      `INSERT INTO dns_zone_sync
         (zone_name, server_id, soa_serial, soa_primary, soa_email, soa_refresh, soa_retry, soa_expire, soa_ttl, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (zone_name, server_id) DO UPDATE SET
         soa_serial=EXCLUDED.soa_serial, soa_primary=EXCLUDED.soa_primary,
         soa_email=EXCLUDED.soa_email, soa_refresh=EXCLUDED.soa_refresh,
         soa_retry=EXCLUDED.soa_retry, soa_expire=EXCLUDED.soa_expire,
         soa_ttl=EXCLUDED.soa_ttl, checked_at=NOW()`,
      [z.zone_name, server.id, serial,
       soa.PrimaryServer || null, soa.AdminEmail || null,
       toInt(soa.Refresh), toInt(soa.Retry), toInt(soa.Expire), toInt(soa.MinTTL)]
    ).catch(e => log(`[SOA] ${ip}/${z.zone_name} upsert failed: ${e.message}`));

    await db.query(
      `UPDATE dns_zones SET soa_serial=$2 WHERE id=$1`,
      [z.id, serial]
    ).catch(() => {});
  }

  // Recompute is_in_sync / lag_seconds per zone_name across all servers.
  // lag_seconds is repurposed as (max_serial - soa_serial) for display.
  await db.query(
    `UPDATE dns_zone_sync s SET
       is_in_sync = (s.soa_serial = m.maxserial),
       lag_seconds = (m.maxserial - s.soa_serial)
     FROM (
       SELECT zone_name, MAX(soa_serial) AS maxserial
         FROM dns_zone_sync
        WHERE soa_serial IS NOT NULL
        GROUP BY zone_name
     ) m
     WHERE s.zone_name = m.zone_name`
  ).catch(e => log(`[SOA] ${ip} sync recompute failed: ${e.message}`));
}

// ── 3. Zone record counts ─────────────────────────────────────
async function pollZoneRecordCounts(db, ps, ip, auth, zones) {
  for (const z of zones) {
    let counts;
    try { counts = ps.getDnsZoneRecordCounts(ip, auth, z.zone_name); }
    catch (e) { log(`[Counts] ${ip}/${z.zone_name}: ${e.message}`); continue; }
    if (!counts) continue;
    await db.query(
      `UPDATE dns_zones SET record_count_a=$2, record_count_ptr=$3, record_count_cname=$4,
         record_count_mx=$5, record_count=$6 WHERE id=$1`,
      [z.id, toInt(counts.A), toInt(counts.PTR), toInt(counts.CNAME),
       toInt(counts.MX), toInt(counts.Total)]
    ).catch(e => log(`[Counts] ${ip}/${z.zone_name} update failed: ${e.message}`));
  }
}

// ── 4. Forwarder health ───────────────────────────────────────
async function checkForwarderHealth(db, ps, server, ip, auth) {
  let raw;
  try { raw = ps.getDnsForwarders(ip, auth); }
  catch (e) { log(`[Forwarders] ${ip}: ${e.message}`); return; }
  if (!raw) return;
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(v => (typeof v === 'string' ? v.trim() : v))
    .filter(isIpStr);

  for (const fwd of list) {
    let r;
    try { r = ps.testDnsForwarder(ip, auth, fwd); }
    catch (e) { log(`[Forwarders] ${ip}->${fwd}: ${e.message}`); continue; }
    if (!r) continue;
    // If result is an array, it means the DNS query succeeded (Resolve-DnsName
    // returned raw records) but the PS script didn't wrap it in our expected
    // object format. Treat that as reachable. Otherwise parse the explicit
    // Reachable flag: PowerShell booleans can serialize as JSON true, the string
    // "True", or 1 depending on the ConvertTo-Json path — handle all forms so a
    // reachable forwarder (e.g. 1.1.1.1 at 328ms) is never recorded as down,
    // and a raw record array is never passed to a boolean DB column.
    const isArray = Array.isArray(r);
    const isReachable = isArray ? true : (r.Reachable === true || r.Reachable === 'True' || r.Reachable === 1);
    const responseMs = isArray ? null : toInt(r.ResponseMs);
    log(`Forwarder ${fwd}: reachable=${isReachable}, raw=${isArray ? 'array' : JSON.stringify(r.Reachable)}, ms=${responseMs}`);
    await db.query(
      `INSERT INTO dns_forwarder_health (server_id, forwarder_ip, is_reachable, response_time_ms, last_checked)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (server_id, forwarder_ip) DO UPDATE SET
         is_reachable=EXCLUDED.is_reachable, response_time_ms=EXCLUDED.response_time_ms, last_checked=NOW()`,
      [server.id, fwd, isReachable, responseMs]
    ).catch(e => log(`[Forwarders] ${ip}->${fwd} upsert failed: ${e.message}`));
  }
}

// ── 5. Scavenging / aging config ──────────────────────────────
async function pollScavenging(db, ps, ip, auth, zones) {
  for (const z of zones) {
    let sc;
    try { sc = ps.getDnsZoneScavenging(ip, auth, z.zone_name); }
    catch (e) { log(`[Scavenging] ${ip}/${z.zone_name}: ${e.message}`); continue; }
    if (!sc) continue;
    const aging = sc.AgingEnabled === true;
    await db.query(
      `UPDATE dns_zones SET scavenging_enabled=$2, aging_enabled=$3 WHERE id=$1`,
      [z.id, aging, aging]
    ).catch(e => log(`[Scavenging] ${ip}/${z.zone_name} update failed: ${e.message}`));
  }
}

/**
 * runDnsMonitor — main per-server DNS monitoring sweep.
 * `servers` is an array of active server rows; `serverAuth(server)` → auth object.
 */
async function runDnsMonitor(db, ps, servers, serverAuth) {
  let serverCount = 0;
  for (const server of servers) {
    if (server.role === 'dhcp') continue;
    const ip = cleanIp(server.ip_address);
    let auth;
    try { auth = serverAuth(server); } catch { continue; }

    // Confirm credentials are resolved correctly for this server (mirrors the
    // pattern collector.js uses for DHCP polling). For credential mode this
    // surfaces whether ps_username/ps_password actually made it through.
    log(`Polling ${server.hostname} (id=${server.id}, mode=${auth.auth_mode}, ` +
        `user=${auth.ps_username || 'none'}, hasPass=${auth.ps_password ? 'yes' : 'no'})`);

    // Forward zones for this server, fetched once and shared by the checks.
    let zones = [];
    try {
      const r = await db.query(
        `SELECT id, zone_name FROM dns_zones WHERE server_id=$1 AND is_reverse=FALSE`,
        [server.id]
      );
      zones = r.rows;
    } catch (e) { log(`[Zones] ${ip}: ${e.message}`); }

    try { await detectDnsRoles(db, ps, server, ip, auth); } catch (e) { log(`[Roles] ${ip} failed: ${e.message}`); }
    try { await pollZoneSyncStatus(db, ps, server, ip, auth, zones); } catch (e) { log(`[SOA] ${ip} failed: ${e.message}`); }
    try { await pollZoneRecordCounts(db, ps, ip, auth, zones); } catch (e) { log(`[Counts] ${ip} failed: ${e.message}`); }
    try { await checkForwarderHealth(db, ps, server, ip, auth); } catch (e) { log(`[Forwarders] ${ip} failed: ${e.message}`); }
    try { await pollScavenging(db, ps, ip, auth, zones); } catch (e) { log(`[Scavenging] ${ip} failed: ${e.message}`); }

    serverCount++;
  }

  // Best-effort anomaly evaluation over the freshly collected data.
  try { await require('./anomalyDetector').detectDnsAnomalies(db); }
  catch (e) { log(`[Anomaly] DNS anomaly detection failed: ${e.message}`); }

  log(`runDnsMonitor complete — ${serverCount} DNS server(s) checked`);
}

/**
 * detectStaleRecords — nightly stale-record snapshot per forward zone.
 * Replaces the existing snapshot for each zone (fresh per run).
 */
async function detectStaleRecords(db, ps, servers, serverAuth) {
  let total = 0;
  for (const server of servers) {
    if (server.role === 'dhcp') continue;
    const ip = cleanIp(server.ip_address);
    let auth;
    try { auth = serverAuth(server); } catch { continue; }

    let zones = [];
    try {
      const r = await db.query(
        `SELECT id, zone_name FROM dns_zones WHERE server_id=$1 AND is_reverse=FALSE`,
        [server.id]
      );
      zones = r.rows;
    } catch (e) { log(`[Stale] ${ip} zones: ${e.message}`); continue; }

    for (const z of zones) {
      let raw;
      try { raw = ps.getDnsStaleRecords(ip, auth, z.zone_name, 90); }
      catch (e) { log(`[Stale] ${ip}/${z.zone_name}: ${e.message}`); continue; }
      const records = raw ? (Array.isArray(raw) ? raw : [raw]) : [];

      // Fresh snapshot — clear prior stale rows for this zone first.
      try { await db.query(`DELETE FROM dns_stale_records WHERE zone_id=$1`, [z.id]); }
      catch (e) { log(`[Stale] ${ip}/${z.zone_name} clear failed: ${e.message}`); continue; }

      const now = Date.now();
      for (const rec of records) {
        const iso = parsePsDate(rec.TimeStamp);
        let daysStale = null;
        if (iso) {
          const ms = now - new Date(iso).getTime();
          if (Number.isFinite(ms)) daysStale = Math.max(0, Math.floor(ms / 86400000));
        }
        await db.query(
          `INSERT INTO dns_stale_records (zone_id, hostname, record_type, record_data, last_updated, days_stale, detected_at)
           VALUES ($1,$2,$3,NULL,$4,$5,NOW())`,
          [z.id, rec.HostName || null, rec.RecordType || null, iso, daysStale]
        ).catch(e => log(`[Stale] ${ip}/${z.zone_name} insert failed: ${e.message}`));
        total++;
      }
    }
  }
  log(`detectStaleRecords complete — ${total} stale record(s) recorded`);
}

module.exports = { runDnsMonitor, detectStaleRecords };
