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
// ════════════════════════════════════════════════════════════
// PROTOCOL SOA — reading the serial without WinRM at all
// ════════════════════════════════════════════════════════════
// A plain DNS SOA query over port 53 returns the same seven fields the PowerShell
// cmdlet does (serial, primary, email, refresh, retry, expire, minimum), needs no
// authentication, and opens no WinRM session — so the largest of the per-zone passes
// costs ZERO domain logons. That matters because 1.41.0 only reduced the WinRM call
// count; this removes the SOA pass from WinRM entirely.
//
// ⛔ THIS IS NOT "registering Windows as a protocol platform", which
// collector/dns/index.js refuses ON PURPOSE because AXFR silently drops scavenging,
// aging and AD-integration data that only the cmdlets expose. We borrow ONE protocol
// primitive (querySoa, which is not AXFR) and keep every Windows-only read on
// PowerShell. providerFor('windows') must keep returning null.
//
// ⛔ AXFR is deliberately NOT used for records here: Windows DNS ships with zone
// transfers DISABLED, so it would fail on a default install, and enabling it per zone
// is a security decision for the operator, not something a collector should assume.
const soaClient = require('./dns/client');

// Per-query budget. Short on purpose: a DNS query that is going to answer answers in
// milliseconds, and the fallback below is cheap.
const SOA_QUERY_TIMEOUT_MS = parseInt(process.env.DDI_SOA_QUERY_TIMEOUT_MS || '3000', 10);
// Hundreds of zones sequentially would be latency-bound, so fan out — but modestly:
// these are unauthenticated UDP queries, not the thing we are trying to stop.
const SOA_QUERY_CONCURRENCY = parseInt(process.env.DDI_SOA_QUERY_CONCURRENCY || '8', 10);
// ⛔ Circuit breaker. If port 53 is not reachable from the collector, trying every zone
// burns one full timeout EACH before we learn it — 339 zones x 3s is 17 minutes of dead
// waiting per tick. Probe a few, and if none answers, hand the whole server to the
// batched WinRM reader in one go.
const SOA_PROBE_LIMIT = parseInt(process.env.DDI_SOA_PROBE_LIMIT || '3', 10);

// Scavenging/aging is zone METADATA, so changing it does NOT bump the SOA serial —
// serial-gating it would mean an operator's change is never noticed. A slow independent
// interval instead: this config changes about never, and it is the only per-zone pass
// left on WinRM during a normal tick.
const SCAVENGING_MIN_INTERVAL_MS = parseInt(
  process.env.DDI_SCAVENGING_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
const lastScavengingAt = new Map(); // server.id -> epoch ms

/** Map querySoa's output onto the field names the cmdlet path already produced. */
function soaFields(s) {
  return {
    ok: true,
    via: 'dns',
    Serial: s.serial,
    PrimaryServer: s.primary,
    AdminEmail: s.email,
    Refresh: s.refresh,
    Retry: s.retry,
    Expire: s.expire,
    // The SOA MINIMUM field, which is what the soa_ttl column means. The cmdlet read
    // this off RecordData, whose SOA shape exposes MinimumTimeToLive rather than
    // TimeToLive, so values may start appearing here where they were previously null.
    MinTTL: s.minimum == null ? s.ttl : s.minimum,
  };
}

/**
 * SOA for every zone, protocol-first, WinRM only for what protocol could not answer.
 *
 * Returns the same { '<zone>': { ok, Serial, ... } } map the batched WinRM reader does,
 * plus a `via` field ('dns' | 'winrm') so the log can show how much WinRM was avoided.
 */
async function readZoneSoa(ps, server, ip, auth, zones, deps) {
  const client = (deps && deps.soa) || soaClient;
  const host = (server.dns_host && String(server.dns_host).replace(/\/\d+$/, '').trim()) || ip;
  const port = Number(server.dns_port) || 53;
  const got = {};
  const failed = [];
  if (!zones.length) return got;

  const ask = async (z) => {
    try {
      got[z.zone_name] = soaFields(
        await client.querySoa(host, port, z.zone_name, { timeoutMs: SOA_QUERY_TIMEOUT_MS }));
      return true;
    } catch (e) {
      failed.push(z);
      return false;
    }
  };

  // Probe first — see SOA_PROBE_LIMIT.
  const probe = zones.slice(0, SOA_PROBE_LIMIT);
  let anyAnswered = false;
  for (const z of probe) { if (await ask(z)) anyAnswered = true; }

  if (!anyAnswered) {
    // Port 53 is unusable from here for this server. Do not probe the rest.
    log(`[SOA] ${ip}: no DNS answer on ${host}:${port} after ${probe.length} probe(s) — using WinRM for all ${zones.length} zone(s)`);
    return await soaViaWinrm(ps, ip, auth, zones, {});
  }

  const rest = zones.slice(SOA_PROBE_LIMIT);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, SOA_QUERY_CONCURRENCY) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= rest.length) return;
      await ask(rest[i]);
    }
  }));

  const viaDns = Object.keys(got).length;
  if (!failed.length) {
    log(`[SOA] ${ip}: ${viaDns} zone(s) read over DNS — no WinRM call made`);
    return got;
  }
  log(`[SOA] ${ip}: ${viaDns} zone(s) over DNS, ${failed.length} falling back to WinRM`);
  return await soaViaWinrm(ps, ip, auth, failed, got);
}

/** ONE batched WinRM read for the zones protocol could not answer, merged into `into`. */
async function soaViaWinrm(ps, ip, auth, zones, into) {
  let batch = {};
  try { batch = (await ps.getDnsZoneSoaDetailBatch(ip, auth, zones)) || {}; }
  catch (e) { log(`[SOA] ${ip}: WinRM fallback failed: ${e.message}`); }
  for (const z of zones) {
    const e = batch[z.zone_name];
    into[z.zone_name] = (e && e.ok)
      ? Object.assign({}, e, { via: 'winrm' })
      : (e || { ok: false, error: 'not read by DNS or WinRM' });
  }
  return into;
}

/**
 * Serial and record count we already hold, so an unchanged zone costs nothing.
 *
 * Mirrors collector/dns/sync.js storedSerials, including its deliberate swallow: on a
 * first run or an un-migrated column there is simply no prior state, which is not an
 * error — it just means every zone looks changed and gets read once.
 */
async function storedZoneState(db, serverId) {
  const m = new Map();
  try {
    const r = await db.query(
      'SELECT zone_name, soa_serial, record_count FROM dns_zones WHERE server_id = $1', [serverId]);
    for (const row of r.rows) {
      m.set(row.zone_name, {
        serial: row.soa_serial == null ? null : Number(row.soa_serial),
        count: row.record_count == null ? 0 : Number(row.record_count),
      });
    }
  } catch (e) { /* first run, or the column is missing on an un-migrated DB */ }
  return m;
}

/** True when this server's scavenging pass is due (see SCAVENGING_MIN_INTERVAL_MS). */
function scavengingDue(serverId, now) {
  const last = lastScavengingAt.get(serverId);
  return last == null || (now - last) >= SCAVENGING_MIN_INTERVAL_MS;
}

async function detectDnsRoles(db, ps, server, ip, auth) {
  let role;
  try { role = await ps.getDnsServerRole(ip, auth); } catch (e) { log(`[Roles] ${ip}: ${e.message}`); return; }
  if (!role) return;

  // Defensive: runPS double-encodes in some paths (a JSON string of a JSON
  // string), so JSON.parse can hand back a STRING instead of an object — then
  // role.isPDC is undefined and is_dns_primary is never set. Re-parse here.
  if (typeof role === 'string') {
    try { role = JSON.parse(role); } catch { log(`[Roles] ${ip}: role not parseable: ${role.slice(0, 120)}`); return; }
  }
  if (!role || typeof role !== 'object') return;

  // PowerShell ConvertTo-Json emits lowercase booleans, but tolerate the
  // string forms ("True"/"true") that show up when a value round-trips as text.
  const isPdc = role.isPDC === true || role.isPDC === 'True' || role.isPDC === 'true';

  console.log(`[DNS-Monitor] Role detection for ${server.hostname}: raw=${JSON.stringify(role)}, isPDC=${role?.isPDC}, isPdc=${isPdc}`);
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
/**
 * SOA pass. Reads over DNS where it can, WinRM only for the remainder.
 *
 * @returns {{changed:Set<string>}} the zones whose serial MOVED (or that we hold no
 *   records for yet). pollZoneRecordCounts takes only those, so an unchanged zone
 *   costs no WinRM call at all — the same gate collector/dns/sync.js applies to the
 *   protocol platforms.
 *
 * Per-zone failure isolation is preserved: a zone whose entry is ok:false is logged
 * and skipped, exactly as the original per-zone `continue` did. A total read failure
 * deliberately does NOT return early — it leaves the map empty so every zone is
 * skipped and the cross-server recompute below still runs.
 */
async function pollZoneSyncStatus(db, ps, server, ip, auth, zones, deps) {
  const prior = await storedZoneState(db, server.id);
  const changed = new Set();

  let batch = {};
  try { batch = (await readZoneSoa(ps, server, ip, auth, zones, deps)) || {}; }
  catch (e) { log(`[SOA] ${ip}: SOA pass failed: ${e.message}`); }

  for (const z of zones) {
    const soa = batch[z.zone_name];
    if (!soa || !soa.ok) {
      if (soa && soa.error) log(`[SOA] ${ip}/${z.zone_name}: ${soa.error}`);
      continue;
    }
    if (soa.Serial == null) continue;
    const serial = parseInt(soa.Serial);
    if (!Number.isFinite(serial)) continue;

    // The gate. A zone whose serial is unchanged AND whose records we already hold
    // cannot have changed — the SOA serial is REQUIRED to move when zone contents do.
    // Anything else (new zone, serial moved, no records yet) needs a record count.
    const p = prior.get(z.zone_name);
    const unchanged = p && p.serial != null && p.serial === serial && p.count > 0;
    if (!unchanged) changed.add(z.zone_name);

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

  return { changed };
}

// ── 3. Zone record counts ─────────────────────────────────────
async function pollZoneRecordCounts(db, ps, ip, auth, zones) {
  // A quiet tick passes an EMPTY list (every zone's serial unchanged), and that must
  // cost nothing at all — not even an async hop into the reader.
  if (!zones || !zones.length) return;
  // Batched — see pollZoneSyncStatus above.
  let batch = {};
  try { batch = (await ps.getDnsZoneRecordCountsBatch(ip, auth, zones)) || {}; }
  catch (e) { log(`[Counts] ${ip}: batch read failed: ${e.message}`); }

  for (const z of zones) {
    const counts = batch[z.zone_name];
    if (!counts || !counts.ok) {
      if (counts && counts.error) log(`[Counts] ${ip}/${z.zone_name}: ${counts.error}`);
      continue;
    }
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
  try { raw = await ps.getDnsForwarders(ip, auth); }
  catch (e) { log(`[Forwarders] ${ip}: PS call failed: ${e.message}`); raw = null; }

  // Normalize the live PS result to a candidate array.
  let candidates = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
  log(`[Forwarders] ${ip}: PS returned ${candidates.length} forwarders`);

  // Fallback — if the live call returned nothing, use the forwarders already
  // stored on ddi_servers (populated earlier by detectDnsRoles). Distinguishes
  // a PS failure / empty result from a server that genuinely has no forwarders.
  if (!candidates.length) {
    const stored = await db
      .query('SELECT dns_forwarders FROM ddi_servers WHERE id=$1', [server.id])
      .catch(() => ({ rows: [] }));
    candidates = stored.rows[0]?.dns_forwarders || [];
    if (candidates.length) log(`[Forwarders] ${ip}: using ${candidates.length} stored forwarders`);
  }

  const list = candidates
    .map(v => (typeof v === 'string' ? v.trim() : v))
    .filter(isIpStr);

  for (const fwd of list) {
    let r;
    try { r = await ps.testDnsForwarder(ip, auth, fwd); }
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
  if (!zones || !zones.length) return;
  // Batched — see pollZoneSyncStatus above.
  let batch = {};
  try { batch = (await ps.getDnsZoneScavengingBatch(ip, auth, zones)) || {}; }
  catch (e) { log(`[Scavenging] ${ip}: batch read failed: ${e.message}`); }

  for (const z of zones) {
    const sc = batch[z.zone_name];
    if (!sc || !sc.ok) {
      if (sc && sc.error) log(`[Scavenging] ${ip}/${z.zone_name}: ${sc.error}`);
      continue;
    }
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
  // Poll a single DNS server end-to-end. Returns true if the server was actually
  // polled (false if skipped — DHCP-only role or unresolvable auth). Each check
  // is independently guarded so a failure in one never aborts the others.
  async function pollServer(server) {
    if (server.role === 'dhcp') return false;
    const ip = cleanIp(server.ip_address);
    let auth;
    try { auth = serverAuth(server); } catch { return false; }

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
    // SOA first — it reads over DNS where it can and tells us which zones MOVED.
    let changed = new Set();
    try {
      const r = await pollZoneSyncStatus(db, ps, server, ip, auth, zones);
      if (r && r.changed) changed = r.changed;
    } catch (e) { log(`[SOA] ${ip} failed: ${e.message}`); }

    // Only the moved zones need a record count. On a quiet tick this is an EMPTY list,
    // which makes zero WinRM calls — the whole point of the serial gate.
    const changedZones = zones.filter(z => changed.has(z.zone_name));
    if (changedZones.length) {
      log(`[Counts] ${ip}: ${changedZones.length} of ${zones.length} zone(s) changed`);
      try { await pollZoneRecordCounts(db, ps, ip, auth, changedZones); } catch (e) { log(`[Counts] ${ip} failed: ${e.message}`); }
    }

    try { await checkForwarderHealth(db, ps, server, ip, auth); } catch (e) { log(`[Forwarders] ${ip} failed: ${e.message}`); }

    // ⛔ Scavenging is NOT serial-gated: aging config is zone metadata and does not move
    // the SOA serial, so gating it would mean an operator's change is never seen. Slow
    // independent interval instead — see SCAVENGING_MIN_INTERVAL_MS.
    if (scavengingDue(server.id, Date.now())) {
      try {
        await pollScavenging(db, ps, ip, auth, zones);
        lastScavengingAt.set(server.id, Date.now());
      } catch (e) { log(`[Scavenging] ${ip} failed: ${e.message}`); }
    }

    return true;
  }

  // Poll all DNS servers in parallel so a slow server (e.g. BKKDC01 at 7–8 min)
  // no longer blocks the others — total time is max(per-server) not the sum.
  const results = await Promise.allSettled(
    servers.map(server => pollServer(server).catch(err =>
      log(`Error polling ${server.hostname}: ${err.message}`)
    ))
  );
  const serverCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

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
  let zonesChecked = 0;
  let zonesNullResult = 0;
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

    // Batched — see pollZoneSyncStatus. ⛔ The ok flag carries the SAME contract the
    // single-zone reader's forced array established, and it matters more here than
    // anywhere else because this function DELETEs a zone's prior snapshot before
    // inserting: ok:true with Records []  = "genuinely no stale records, clear it",
    // while ok:false or a missing entry   = "could not read, LEAVE THE SNAPSHOT".
    let staleBatch = {};
    try { staleBatch = (await ps.getDnsStaleRecordsBatch(ip, auth, zones, 90)) || {}; }
    catch (e) { log(`[Stale] ${ip}: batch read failed: ${e.message}`); }

    for (const z of zones) {
      zonesChecked++;
      const entry = staleBatch[z.zone_name];
      const raw = (entry && entry.ok)
        ? (Array.isArray(entry.Records) ? entry.Records : (entry.Records ? [entry.Records] : []))
        : null;
      if (entry && !entry.ok && entry.error) log(`[Stale] ${ip}/${z.zone_name}: ${entry.error}`);
      // null is now UNAMBIGUOUS: the reader forces an array, so a zone with no stale
      // records returns `[]` and only a genuine read failure yields null (see
      // powershellRunner.getDnsStaleRecordsBatch, which carries the same contract via
      // its ok flag). Previously both produced null, which
      // made this counter meaningless — on the live server it reported "242 zone(s)
      // returned no result" when every one of those 242 was simply a zone with zero
      // stale records and not a single PowerShell call had failed.
      if (raw === null || raw === undefined) {
        // A failed read tells us NOTHING about this zone, so leave the previous
        // snapshot alone. Falling through would DELETE it and insert nothing, i.e.
        // silently report "0 stale records" for a zone we could not read — which is
        // exactly what the old summary line claimed it was avoiding ("prior snapshot
        // kept") while the code deleted the rows regardless.
        zonesNullResult++;
        continue;
      }
      const records = Array.isArray(raw) ? raw : [raw];

      // Fresh snapshot — clear prior stale rows for this zone first. Safe now that a
      // failed read has already been skipped above: reaching here means the zone was
      // read successfully and `records` is its true current state (possibly empty).
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
  log(`detectStaleRecords complete — ${total} stale record(s) recorded across ${zonesChecked} zone(s)` +
      (zonesNullResult ? `; ${zonesNullResult} zone(s) COULD NOT BE READ (PowerShell failure — previous snapshot left untouched)` : ''));
}

module.exports = {
  runDnsMonitor,
  detectStaleRecords,
  // Exported for tests — these take (db, ps, ...) explicitly so a fake db/ps can
  // drive them. Nothing in src calls them from outside this module.
  pollZoneSyncStatus,
  pollZoneRecordCounts,
  pollScavenging,
  readZoneSoa,
  storedZoneState,
  scavengingDue,
};
