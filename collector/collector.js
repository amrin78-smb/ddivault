'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { Pool } = require('pg');
const ps        = require('./powershellRunner');
const dhcp      = require('./dhcpReader');
const ha        = require('./haMonitor');
const dnsMonitor = require('./dnsMonitor');
const ipamSync  = require('./ipamSync');
const { decrypt } = require('./credStore');
const writers   = require('./writers');   // shared DB-write half (also used by api/ws-server.js)
const forecastEngine  = require('./forecastEngine');   // { runForecasts(db) }
const anomalyDetector = require('./anomalyDetector');   // { detectAnomalies(db), buildBaselines(db) }
const healthScorer    = require('./healthScorer');      // { scoreSites(db) }
const deviceClassifier = require('../api/deviceClassifier'); // { classifyDevice(mac,hostname), isMacRandomized(mac) }
const reportScheduler = require('./reportScheduler'); // { runDueReports(db), deliverSchedule(db,s), computeNextRun(s,from) }

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DDI_DB_NAME || 'ddivault',
  user:     process.env.DDI_DB_USER || 'ddivault_user',
  password: process.env.DDI_DB_PASS || '',
  max: 10,                          // increased from 5 — DNS monitor + DHCP polling overlap
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,   // increased from 5000 — avoid "connection terminated due to connection timeout"
});

db.on('error', (err) => console.error('[DB] Pool error:', err.message));

const SCOPE_WARNING_PCT        = parseFloat(process.env.SCOPE_WARNING_PCT       || '80');
const SCOPE_CRITICAL_PCT       = parseFloat(process.env.SCOPE_CRITICAL_PCT      || '90');
const SCOPE_WARNING_CLEAR_PCT  = parseFloat(process.env.SCOPE_WARNING_CLEAR_PCT  || '75');
const SCOPE_CRITICAL_CLEAR_PCT = parseFloat(process.env.SCOPE_CRITICAL_CLEAR_PCT || '85');

// 300s, matching the agent's dhcp_events cadence (agent/modules/ddi/index.js
// defaults dhcp_events_interval_s to 300) so central and agent collection poll
// alike. Was 60s, which is far tighter than DHCP event data warrants and now
// costs a WinRM round trip per server per tick.
const INTERVAL_LOG_TAIL    = 300 * 1000;
// Lines pulled per tick. At ~91 bytes/line (measured on a live log) 2000 lines
// is ~180KB per server per poll, comfortably covering 5 minutes of events on a
// busy server while bounding the WinRM payload.
const DHCP_LOG_TAIL_LINES  = 2000;
const INTERVAL_SCOPE_STATS = 5   * 60 * 1000;
const INTERVAL_LEASE_SYNC  = 15  * 60 * 1000;
const INTERVAL_DNS_SYNC    = 60  * 60 * 1000;
const INTERVAL_FAILOVER    = 5   * 60 * 1000;   // DHCP failover state
const INTERVAL_SOA_SYNC    = 15  * 60 * 1000;   // DNS SOA replication lag
const INTERVAL_HEALTH      = 5   * 60 * 1000;   // per-server health score
const INTERVAL_FORECAST    = 6   * 60 * 60 * 1000; // 6 hours
const INTERVAL_ANOMALY     = 30  * 60 * 1000;      // 30 minutes
const INTERVAL_SITEHEALTH  = 15  * 60 * 1000;      // 15 minutes
const INTERVAL_DNS_MONITOR = 20  * 60 * 1000;      // 20 minutes — DNS infra monitoring (servers polled in parallel)
const INTERVAL_DIGEST      = 60  * 60 * 1000;      // hourly digest + nightly-baseline tick
const INTERVAL_REPORTS     = 5 * 60 * 1000; // scheduled report delivery check (every 5 min)

const lastLogEventTime = {};

function log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toISOString()}] WARN: ${msg}`); }

// PostgreSQL inet values include CIDR (e.g. 172.24.0.10/32) which the
// PowerShell remoting functions reject — strip it before any PS use.
const cleanIp = ip => (ip || '').replace(/\/\d+$/, '').trim();

// PowerShell serializes a .NET IPAddress (e.g. a DHCP ScopeId) as an object
// with an IPAddressToString property, not a plain string. Coerce to the IP
// string so it never lands in the DB as an object / "[object Object]".
function scopeIdStr(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.IPAddressToString || v.Address || '').trim();
  return String(v).trim();
}

// PowerShell serializes a .NET DateTime as "/Date(1781141126961)/" which
// PostgreSQL rejects for TIMESTAMPTZ columns. Convert to ISO-8601 (or null).
function parsePsDate(val) {
  if (!val) return null;
  const m = String(val).match(/\/Date\((\d+)\)\//);
  if (m) return new Date(parseInt(m[1])).toISOString();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// PowerShell serializes a .NET TimeSpan (e.g. DHCP LeaseDuration) as an object with
// Days/Hours/Minutes/Seconds. Convert to a human-readable string (or pass through).
function parsePsDuration(val) {
  if (!val) return null;
  // .NET TimeSpan serialized as object with Days, Hours, Minutes, Seconds
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

function isValidIp(val) {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed || trimmed.includes('x') || trimmed.includes('X')) return false;
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed);
}

async function getActiveServers() {
  // agent_hub_id IS NULL — servers owned by a remote agent (Phase 4b) are polled
  // by that agent, NOT the central collector. The WS ingest server pushes them
  // their config and writes back their results via collector/writers.js.
  const result = await db.query(
    `SELECT id, hostname, ip_address::text as ip_address, role,
            auth_mode, ps_username, ps_password, winrm_port, winrm_https
     FROM ddi_servers WHERE is_active = TRUE AND agent_hub_id IS NULL ORDER BY id`
  );
  // Decrypt passwords
  return result.rows.map(row => ({
    ...row,
    ps_password: row.ps_password ? decrypt(row.ps_password) : null,
  }));
}

/**
 * Build auth object for powershellRunner — uses per-server config,
 * falls back to .env.local globals if not set on server.
 */
function serverAuth(server) {
  return {
    auth_mode:   server.auth_mode   || process.env.PS_AUTH_MODE || 'kerberos',
    ps_username: server.ps_username || process.env.PS_USERNAME   || null,
    ps_password: server.ps_password || process.env.PS_PASSWORD   || null,
    winrm_port:  server.winrm_port  || 5985,
    winrm_https: server.winrm_https || false,
  };
}

/**
 * Seed initial server from .env.local ONLY if:
 * - DHCP_SERVER is set AND is a valid IP (not a placeholder)
 * - No servers exist in DB yet
 */
async function seedInitialServer() {
  const rawIp = (process.env.DHCP_SERVER || '').trim();

  if (!rawIp) {
    log('[Seed] DHCP_SERVER not set — skipping seed. Add servers via Known Servers tab.');
    return;
  }

  if (!isValidIp(rawIp)) {
    log(`[Seed] DHCP_SERVER="${rawIp}" is a placeholder — skipping seed. Update .env.local with a real IP or add servers via Known Servers tab.`);
    return;
  }

  const existing = await db.query('SELECT COUNT(*) as cnt FROM ddi_servers');
  if (parseInt(existing.rows[0].cnt) > 0) return;

  log(`[Seed] Adding initial server from .env.local: ${rawIp}`);
  const dnsSrv = (process.env.DNS_SERVER || '').trim();
  const role   = isValidIp(dnsSrv) && dnsSrv !== rawIp ? 'dhcp' : 'both';

  await db.query(
    `INSERT INTO ddi_servers (hostname, ip_address, role, poll_status)
     VALUES ($1, $2, $3, 'pending') ON CONFLICT DO NOTHING`,
    [rawIp, rawIp, role]
  );

  if (isValidIp(dnsSrv) && dnsSrv !== rawIp) {
    await db.query(
      `INSERT INTO ddi_servers (hostname, ip_address, role, poll_status)
       VALUES ($1, $2, 'dns', 'pending') ON CONFLICT DO NOTHING`,
      [dnsSrv, dnsSrv, 'dns']
    );
  }
}

async function updateServerStatus(serverId, status, errorMsg) {
  await db.query(
    `UPDATE ddi_servers SET last_polled=NOW(), poll_status=$2, poll_error=$3 WHERE id=$1`,
    [serverId, status, errorMsg || null]
  );
}

// ── Per-type COLLECT functions (central only) ─────────────────
// Each collects raw PowerShell/WinRM output for one server, then hands the
// DB-WRITE half to collector/writers.js — the SAME writers the WS ingest server
// (api/ws-server.js) calls for agent-shipped results, so a scope/lease/zone
// written by an agent is byte-identical to one polled centrally.

async function collectScopeStats(server) {
  if (server.role === 'dns') return;
  const ip   = cleanIp(server.ip_address);
  const auth = serverAuth(server);
  log(`[Scopes] Polling ${ip} (id=${server.id}, mode=${auth.auth_mode})...`);

  const stats  = ps.getDhcpScopeStats(ip, auth);
  const scopes = ps.getDhcpScopes(ip, auth);

  // Resolve gateway (DHCP option 3) on demand — only invoked for NEW subnets.
  // WinRM-backed; the agent-ingest path passes no getGateway (subnets just get
  // no auto gateway), so this resolver stays central-only.
  const getGateway = async (scopeId) => {
    try {
      const opts = ps.getDhcpScopeOptions(ip, auth, scopeId);
      const arr = Array.isArray(opts) ? opts : (opts ? [opts] : []);
      const o = arr.find(x => Number(x.OptionId) === 3);
      if (!o) return null;
      const v = Array.isArray(o.Value) ? o.Value[0] : o.Value;
      return scopeIdStr(v) || null;
    } catch (_) { return null; }
  };

  await writers.writeScopeStats(db, server, { stats, scopes }, { log, warn, getGateway });
}

async function syncLeases(server) {
  if (server.role === 'dns') return;
  const ip   = cleanIp(server.ip_address);
  const auth = serverAuth(server);
  log(`[Leases] Syncing from ${ip}...`);

  const leases = ps.getDhcpLeases(ip, auth);
  await writers.writeLeases(db, server, leases, { log, warn });
}

// Reservations are fetched separately from leases (Get-DhcpServerv4Reservation),
// then stored in dhcp_leases with address_state='Reservation' so the Reservations
// tab (which queries /api/leases?state=Reservation) can display them.
async function syncReservations(server) {
  if (server.role === 'dns') return;
  const ip   = cleanIp(server.ip_address);
  const auth = serverAuth(server);
  try {
    const reservations = ps.getDhcpReservations(ip, null, auth);
    await writers.writeReservations(db, server, reservations, { log, warn });
  } catch (err) {
    console.error(`[Reservations] Error on ${ip}:`, err.message);
  }
}

// Tail one server's DHCP audit log.
//
// DEFAULT TRANSPORT IS WinRM — the same authenticated channel used for scopes,
// leases and DNS. It needs no file share on the DHCP server, no filesystem ACLs
// for the collector's service identity, and no SMB/445. The previous SMB-only
// route required all three and had never worked on any install here.
//
// DHCP_LOG_UNC / DHCP_LOG_LOCAL remain as an explicit OVERRIDE, for sites that
// already publish the logs on a share (or run the collector on the DHCP server
// itself). The 192.168.x.x token in DHCP_LOG_UNC is substituted per server, as
// it always intended to be — that substitution only started working once
// dhcpReader stopped capturing the env var at module load.
async function tailDhcpLog(server) {
  if (server.role === 'dns') return;
  const serverId = server.id;
  const ip       = cleanIp(server.ip_address);
  const since    = lastLogEventTime[serverId] || null;

  const uncBase   = (process.env.DHCP_LOG_UNC   || '').trim();
  const localBase = (process.env.DHCP_LOG_LOCAL || '').trim();
  const override  = uncBase || localBase;

  let events;
  if (override) {
    if (uncBase)   process.env.DHCP_LOG_UNC   = uncBase.replace(/192\.168\.x\.x/i, ip);
    if (localBase) process.env.DHCP_LOG_LOCAL = localBase;
    events = dhcp.readDhcpLogSince(since);
  } else {
    const raw = ps.getDhcpAuditLog(ip, serverAuth(server), dhcp.dayFileName(new Date()), DHCP_LOG_TAIL_LINES);
    if (!raw) return;
    events = dhcp.parseLines(raw);
    // Same high-water filter readDhcpLogSince applies, so both transports behave
    // identically and re-reading the tail never re-inserts.
    if (since) events = events.filter((e) => e.event_time && new Date(e.event_time) > since);
  }
  if (!events.length) return;

  const { lastTime } = await writers.writeDhcpEvents(db, server, events, { log, warn });
  if (lastTime) lastLogEventTime[serverId] = lastTime;
}

async function syncDns(server) {
  if (server.role === 'dhcp') return;
  const ip   = cleanIp(server.ip_address);
  const auth = serverAuth(server);
  log(`[DNS] Syncing zones from ${ip}...`);

  const zones = ps.getDnsZones(ip, auth);
  if (!zones || !zones.length) {
    warn(`[DNS] No zones from ${ip}`);
    return;
  }

  // Collect records for the eligible primary zones (same filter the writer
  // re-applies), keyed by zone name, then write zones + records in one call.
  const recordsByZone = {};
  for (const zone of zones) {
    if (!zone.IsReverseLookupZone && !zone.IsAutoCreated && zone.ZoneType === 'Primary') {
      const records = ps.getDnsRecords(ip, zone.ZoneName, auth);
      if (records && records.length) recordsByZone[zone.ZoneName] = records;
    }
  }

  await writers.writeDnsZones(db, server, { zones, recordsByZone }, { log, warn });
}

// ── HA / health wrappers (adapt ha module signature to pollAll) ──
async function pollFailover(server) { return ha.pollFailover(db, ps, server, serverAuth(server)); }
async function pollDnsSoa(server)   { return ha.pollDnsSoa(db, ps, server, serverAuth(server)); }
async function pollHealth(server)   { return ha.pollHealth(db, ps, server, serverAuth(server)); }

// ── Intelligence job wrappers (whole-DB, no per-server arg) ──
async function runForecasts()   { try { const r = await forecastEngine.runForecasts(db);   log(`[Forecast] ${JSON.stringify(r)}`); } catch (e) { console.error('[Forecast] error:', e.message); } }
async function runAnomalies()   { try { const r = await anomalyDetector.detectAnomalies(db); log(`[Anomaly] ${JSON.stringify(r)}`); } catch (e) { console.error('[Anomaly] error:', e.message); } }
async function runSiteHealth()  { try { const r = await healthScorer.scoreSites(db);         log(`[Health] sites ${JSON.stringify(r)}`); } catch (e) { console.error('[SiteHealth] error:', e.message); } }
async function runReportScheduler() { try { const r = await reportScheduler.runDueReports(db); if (r && (r.ran || r.failed)) log('[Reports] ' + JSON.stringify(r)); } catch (e) { console.error('[Reports] error:', e.message); } }

// Poll scopes across all servers, then record one IPAM utilization snapshot per
// cycle (self-throttled to ~hourly) for the trend chart.
async function pollScopesCycle() {
  await pollAll(collectScopeStats, 'Scopes');
  // Record an IPAM utilization snapshot (self-throttled to ~hourly) for the trend chart.
  try {
    await ipamSync.recordUtilizationSnapshot(db);
  } catch (e) {
    console.error('[IPAM Snapshot] error:', e.message);
  }
}
// Re-entrancy guard — the DNS monitor runs every 20m and can take minutes on
// servers with many zones (servers are polled in parallel, so the run takes
// max(per-server) not the sum). If a previous run is still in flight, skip this tick
// so DNS monitoring never runs concurrently with itself and exhausts the DB pool
// while DHCP polling (every 5m) is also active.
let _dnsMonitorRunning = false;
async function runDnsMonitor() {
  if (_dnsMonitorRunning) {
    log('[DNS-Monitor] previous run still in progress — skipping this tick');
    return;
  }
  _dnsMonitorRunning = true;
  try {
    const servers = await getActiveServers().catch(() => []);
    if (!servers.length) return;
    await dnsMonitor.runDnsMonitor(db, ps, servers, serverAuth);
  } catch (e) {
    console.error('[DNS-Monitor] error:', e.message);
  } finally {
    _dnsMonitorRunning = false;
  }
}
async function runDnsStale() {
  const servers = await getActiveServers().catch(() => []);
  if (!servers.length) return;
  try { await dnsMonitor.detectStaleRecords(db, ps, servers, serverAuth); }
  catch (e) { console.error('[DNS-Stale] error:', e.message); }
}
// hourly tick: send digest emails; run baselines + nightly stale snapshot once per day.
//
// Both the baseline builder and the stale-record snapshot are once-daily jobs that
// should fire at/after 02:00 local time. The original gate required the hour to be
// EXACTLY 2 (`getHours() === 2`); because hourlyTick is anchored to collector start
// (not wall-clock :00) and setInterval drifts, a tick can straddle the 02:xx hour
// (e.g. 01:58 → 03:01), skipping the whole window and silently losing that day's run.
// This is exactly what stranded the `dns_stale_records` snapshot (table froze while
// the 15-min DNS monitor kept producing anomalies). Fix: fire on the FIRST tick AT OR
// AFTER 02:00 each day (`getHours() >= 2`), still guarded once-per-day so it runs once.
// The stale snapshot has its own day-guard so a baseline failure can never skip it.
let _lastBaselineDay = null;
let _lastStaleDay = null;
async function hourlyTick() {
  try { const ad = require('../api/alertDispatcher'); await ad.sendHourlyDigest(db); } catch (e) { console.error('[Digest] error:', e.message); }
  const now = new Date(); const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  if (now.getHours() >= 2) {
    if (_lastBaselineDay !== day) {
      _lastBaselineDay = day;
      try {
        const r = await anomalyDetector.buildBaselines(db); log(`[Baselines] ${JSON.stringify(r)}`);
      } catch (e) { console.error('[Baselines] error:', e.message); }
    }
    if (_lastStaleDay !== day) {
      _lastStaleDay = day;
      try { log('[DNS-Stale] starting nightly snapshot'); await runDnsStale(); }
      catch (e) { console.error('[DNS-Stale] nightly snapshot error:', e.message); }
    }
  }
}

async function pollAll(fn, label) {
  const servers = await getActiveServers().catch(err => {
    console.error(`[DB] Cannot fetch servers for ${label}:`, err.message);
    return [];
  });
  if (!servers.length) {
    log(`[${label}] No active servers yet — add one via the Known Servers tab`);
    return;
  }
  for (const server of servers) {
    // Skip servers with placeholder / invalid IPs (e.g. 192.168.x.x, localhost,
    // empty) — strip the ::text CIDR suffix first, then validate.
    const ip = (server.ip_address || '').replace(/\/\d+$/, '').trim();
    if (!isValidIp(ip)) {
      log(`[${label}] Skipping ${server.hostname || ip || 'unknown'} — placeholder/invalid IP`);
      continue;
    }
    try { await fn(server); }
    catch (err) { console.error(`[${label}] Error on ${server.ip_address}:`, err.message); }
  }
}

async function main() {
  log('=== DDIVault Collector starting ===');

  try {
    await db.query('SELECT 1');
    log('[DB] Connected to ddivault database');
  } catch (err) {
    console.error('[DB] Cannot connect:', err.message);
    process.exit(1);
  }

  // Safe seed — skips if DHCP_SERVER is blank or a placeholder
  await seedInitialServer();

  await pollAll(tailDhcpLog,       'Log');
  await pollScopesCycle();
  await pollAll(syncLeases,        'Leases');
  await pollAll(syncReservations,  'Reservations');
  await pollAll(syncDns,           'DNS');
  await pollAll(pollFailover,      'Failover');
  await pollAll(pollHealth,        'Health');

  // Initial intelligence runs (best-effort — failures must not stop startup)
  try { await runForecasts(); }  catch (e) { console.error('[Forecast] startup error:', e.message); }
  try { await runSiteHealth(); } catch (e) { console.error('[SiteHealth] startup error:', e.message); }
  try { await runAnomalies(); }  catch (e) { console.error('[Anomaly] startup error:', e.message); }
  try { await runDnsMonitor(); } catch (e) { console.error('[DNS-Monitor] startup error:', e.message); }
  try { await runReportScheduler(); } catch (e) { console.error('[Reports] startup error:', e.message); }

  setInterval(() => pollAll(tailDhcpLog,       'Log'),          INTERVAL_LOG_TAIL);
  setInterval(() => pollScopesCycle(),                          INTERVAL_SCOPE_STATS);
  setInterval(() => pollAll(syncLeases,        'Leases'),       INTERVAL_LEASE_SYNC);
  setInterval(() => pollAll(syncReservations,  'Reservations'), INTERVAL_LEASE_SYNC);
  setInterval(() => pollAll(syncDns,           'DNS'),          INTERVAL_DNS_SYNC);
  setInterval(() => pollAll(pollFailover,      'Failover'), INTERVAL_FAILOVER);
  setInterval(() => pollAll(pollDnsSoa,        'DNS-SOA'),  INTERVAL_SOA_SYNC);
  setInterval(() => pollAll(pollHealth,        'Health'),   INTERVAL_HEALTH);

  setInterval(runForecasts,  INTERVAL_FORECAST);
  setInterval(runAnomalies,  INTERVAL_ANOMALY);
  setInterval(runSiteHealth, INTERVAL_SITEHEALTH);
  setInterval(runDnsMonitor, INTERVAL_DNS_MONITOR);
  setInterval(hourlyTick,    INTERVAL_DIGEST);
  setInterval(runReportScheduler, INTERVAL_REPORTS);

  log('=== DDIVault Collector running ===');
}

main().catch(err => {
  console.error('[FATAL] Startup error:', err.message, err.stack);
  process.exit(1);
});
