'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { Pool } = require('pg');
const ps        = require('./powershellRunner');
const dhcp      = require('./dhcpReader');
const ha        = require('./haMonitor');
const ipamSync  = require('./ipamSync');
const { decrypt } = require('./credStore');

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
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

db.on('error', (err) => console.error('[DB] Pool error:', err.message));

const SCOPE_WARNING_PCT    = parseFloat(process.env.SCOPE_WARNING_PCT  || '80');
const SCOPE_CRITICAL_PCT   = parseFloat(process.env.SCOPE_CRITICAL_PCT || '90');

const INTERVAL_LOG_TAIL    = 60  * 1000;
const INTERVAL_SCOPE_STATS = 5   * 60 * 1000;
const INTERVAL_LEASE_SYNC  = 15  * 60 * 1000;
const INTERVAL_DNS_SYNC    = 60  * 60 * 1000;
const INTERVAL_FAILOVER    = 5   * 60 * 1000;   // DHCP failover state
const INTERVAL_SOA_SYNC    = 15  * 60 * 1000;   // DNS SOA replication lag
const INTERVAL_HEALTH      = 5   * 60 * 1000;   // per-server health score

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

function isValidIp(val) {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed || trimmed.includes('x') || trimmed.includes('X')) return false;
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed);
}

async function getActiveServers() {
  const result = await db.query(
    `SELECT id, hostname, ip_address::text as ip_address, role,
            auth_mode, ps_username, ps_password, winrm_port, winrm_https
     FROM ddi_servers WHERE is_active = TRUE ORDER BY id`
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

async function collectScopeStats(server) {
  if (server.role === 'dns') return;
  const ip   = cleanIp(server.ip_address);
  const auth = serverAuth(server);
  log(`[Scopes] Polling ${ip} (id=${server.id}, mode=${auth.auth_mode})...`);

  const stats  = ps.getDhcpScopeStats(ip, auth);
  const scopes = ps.getDhcpScopes(ip, auth);

  if (!stats || !stats.length) {
    warn(`[Scopes] No data from ${ip} — WinRM not reachable or DHCP role not installed`);
    await updateServerStatus(server.id, 'error', 'No scope stats returned — check WinRM');
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
    if (!scopeId) continue; // skip if no scope ID — avoids NOT NULL violation
    const pct      = parseFloat(stat.PercentageInUse || 0);
    const inUse    = parseInt(stat.InUse    || 0);
    const free     = parseInt(stat.Free     || 0);
    const reserved = parseInt(stat.Reserved || 0);
    const pending  = parseInt(stat.Pending  || 0);
    const total    = inUse + free + reserved;
    const cfg      = scopeConfig[scopeId] || {};

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
       scopeIdStr(cfg.SubnetMask)||null, cfg.State||'Active',
       cfg.LeaseDuration ? String(cfg.LeaseDuration) : null,
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

    if (pct >= 100) {
      alertsToFire.push({ scopeId, pct, severity:'critical', msg:`[${ip}] Scope ${scopeId} is 100% FULL (${inUse}/${total} IPs)` });
    } else if (pct >= SCOPE_CRITICAL_PCT) {
      alertsToFire.push({ scopeId, pct, severity:'critical', msg:`[${ip}] Scope ${scopeId} is ${pct.toFixed(1)}% full — ${free} IPs remaining` });
    } else if (pct >= SCOPE_WARNING_PCT) {
      alertsToFire.push({ scopeId, pct, severity:'warning',  msg:`[${ip}] Scope ${scopeId} is ${pct.toFixed(1)}% full — ${free} IPs remaining` });
    }
    upserted++;
  }

  log(`[Scopes] ${ip} — updated ${upserted} scope(s)`);

  for (const alert of alertsToFire) {
    const recent = await db.query(
      `SELECT id FROM alert_events WHERE scope_id=$1 AND severity=$2 AND fired_at > NOW()-INTERVAL '1 hour' LIMIT 1`,
      [alert.scopeId, alert.severity]
    );
    if (!recent.rows.length) {
      await db.query(
        `INSERT INTO alert_events (scope_id, message, severity, server_id) VALUES ($1,$2,$3,$4)`,
        [alert.scopeId, alert.msg, alert.severity, server.id]
      );
      log(`[Alert] ${alert.severity.toUpperCase()}: ${alert.msg}`);
    }
  }

  await updateServerStatus(server.id, 'ok', null);

  await syncScopesToIpam(server, auth, ip, scopeConfig);
}

// Auto-create IPAM subnets/supernets from discovered DHCP scopes.
async function syncScopesToIpam(server, auth, ip, scopeConfig) {
  const scopes = Object.entries(scopeConfig || {}).map(([scopeId, cfg]) => ({
    scopeId,
    subnetMask: scopeIdStr(cfg.SubnetMask),
    name: cfg.Name || null,
  }));
  if (!scopes.length) return;
  // Resolve gateway (DHCP option 3) on demand — only invoked for NEW subnets.
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
  try {
    const r = await ipamSync.syncScopesToIpam(db, scopes, { log, getGateway });
    if (r.created || r.updated || r.supernetsCreated) {
      log(`[IPAM Sync] ${ip} — ${r.created} created, ${r.updated} updated, ${r.supernetsCreated} supernet(s)`);
    }
  } catch (err) {
    console.error(`[IPAM Sync] ${ip} error:`, err.message);
  }
}

async function syncLeases(server) {
  if (server.role === 'dns') return;
  const ip   = cleanIp(server.ip_address);
  const auth = serverAuth(server);
  log(`[Leases] Syncing from ${ip}...`);

  const leases = ps.getDhcpLeases(ip, auth);
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
    const ip_addr = scopeIdStr(lease.IPAddress) || null; // IPAddress object → string
    const mac     = lease.ClientId     || null;
    const host    = lease.HostName     || null;
    const scopeId = scopeIdStr(lease.ScopeId) || null;   // IPAddress object → string
    const state   = lease.AddressState || 'Active';
    const expiry  = parsePsDate(lease.LeaseExpiryTime); // PS /Date(ms)/ → ISO-8601
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
    upserted++;
  }
  log(`[Leases] ${ip} — synced ${upserted} leases`);
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
      upserted++;
    }
    log(`[Reservations] ${ip} — synced ${upserted} reservation(s)`);
  } catch (err) {
    console.error(`[Reservations] Error on ${ip}:`, err.message);
  }
}

async function tailDhcpLog(server) {
  if (server.role === 'dns') return;
  const serverId = server.id;
  const ip       = cleanIp(server.ip_address);

  const uncBase   = (process.env.DHCP_LOG_UNC   || '').trim();
  const localBase = (process.env.DHCP_LOG_LOCAL  || '').trim();
  if (uncBase)   process.env.DHCP_LOG_UNC   = uncBase.replace(/192\.168\.x\.x/i, ip);
  if (localBase) process.env.DHCP_LOG_LOCAL = localBase;

  const since  = lastLogEventTime[serverId] || null;
  const events = dhcp.readDhcpLogSince(since);
  if (!events.length) return;

  let inserted = 0;
  let lastTime = since;

  for (const ev of events) {
    if (!ev.event_time) continue;
    try {
      await db.query(
        `INSERT INTO dhcp_events
           (server_id, event_id, event_type, ip_address, hostname, mac_address, description, raw_line, event_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [serverId, ev.event_id, ev.event_type, ev.ip_address, ev.hostname,
         ev.mac_address, ev.description, ev.raw_line, ev.event_time]
      );
      inserted++;

      const t = new Date(ev.event_time);
      if (!lastTime || t > lastTime) lastTime = t;

      if ([10,11,12,20].includes(ev.event_id) && ev.ip_address) {
        const typeMap = { 10:'assign', 11:'renew', 12:'release', 20:'expire' };
        await db.query(
          `INSERT INTO lease_history (server_id, ip_address, hostname, mac_address, event_type, event_time)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [serverId, ev.ip_address, ev.hostname, ev.mac_address, typeMap[ev.event_id], ev.event_time]
        ).catch(() => {});
      }

      if (ev.event_id === 1020) {
        await db.query(
          `INSERT INTO alert_events (server_id, scope_id, message, severity)
           VALUES ($1,$2,$3,'critical')`,
          [serverId, ev.ip_address, `[${ip}] DHCP scope full: ${ev.description}`]
        ).catch(() => {});
      }
      if (ev.event_id === 2019) {
        await db.query(
          `INSERT INTO alert_events (server_id, message, severity) VALUES ($1,$2,'critical')`,
          [serverId, `[${ip}] Rogue DHCP server detected!`]
        ).catch(() => {});
      }
    } catch (err) {
      if (!err.message.includes('unique')) console.error('[Log] Insert error:', err.message);
    }
  }

  if (inserted > 0) log(`[Log] ${ip} — inserted ${inserted} new events`);
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
    if (zoneDbId && !zone.IsReverseLookupZone && !zone.IsAutoCreated && zone.ZoneType === 'Primary') {
      const records = ps.getDnsRecords(ip, zone.ZoneName, auth);
      if (records && records.length) {
        for (const rec of records) {
          await db.query(
            `INSERT INTO dns_records (zone_id, hostname, record_type, record_data, ttl)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [zoneDbId, rec.HostName, rec.RecordType, String(rec.RecordData||''), rec.TimeToLive||null]
          ).catch(() => {});
        }
        await db.query('UPDATE dns_zones SET record_count=$1 WHERE id=$2', [records.length, zoneDbId]);
      }
    }
  }
  log(`[DNS] ${ip} — synced ${zoneCount} zones`);
}

// ── HA / health wrappers (adapt ha module signature to pollAll) ──
async function pollFailover(server) { return ha.pollFailover(db, ps, server, serverAuth(server)); }
async function pollDnsSoa(server)   { return ha.pollDnsSoa(db, ps, server, serverAuth(server)); }
async function pollHealth(server)   { return ha.pollHealth(db, ps, server, serverAuth(server)); }

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
  await pollAll(collectScopeStats, 'Scopes');
  await pollAll(syncLeases,        'Leases');
  await pollAll(syncReservations,  'Reservations');
  await pollAll(syncDns,           'DNS');
  await pollAll(pollFailover,      'Failover');
  await pollAll(pollHealth,        'Health');

  setInterval(() => pollAll(tailDhcpLog,       'Log'),          INTERVAL_LOG_TAIL);
  setInterval(() => pollAll(collectScopeStats, 'Scopes'),       INTERVAL_SCOPE_STATS);
  setInterval(() => pollAll(syncLeases,        'Leases'),       INTERVAL_LEASE_SYNC);
  setInterval(() => pollAll(syncReservations,  'Reservations'), INTERVAL_LEASE_SYNC);
  setInterval(() => pollAll(syncDns,           'DNS'),          INTERVAL_DNS_SYNC);
  setInterval(() => pollAll(pollFailover,      'Failover'), INTERVAL_FAILOVER);
  setInterval(() => pollAll(pollDnsSoa,        'DNS-SOA'),  INTERVAL_SOA_SYNC);
  setInterval(() => pollAll(pollHealth,        'Health'),   INTERVAL_HEALTH);

  log('=== DDIVault Collector running ===');
}

main().catch(err => {
  console.error('[FATAL] Startup error:', err.message, err.stack);
  process.exit(1);
});
