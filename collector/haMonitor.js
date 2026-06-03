'use strict';

/**
 * haMonitor.js — HA & infrastructure health collection for DDIVault
 *
 * Three responsibilities, each called on its own interval from collector.js:
 *   pollFailover  — DHCP failover relationships + per-scope sync status
 *   pollDnsSoa    — DNS zone SOA serials → replication-lag detection
 *   pollHealth    — per-server health score (0-100) + history + alerts
 *
 * All functions are defensive: a failure on one server never aborts the others.
 */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toISOString()}] WARN: ${msg}`); }

/** Insert an alert only if an equivalent one hasn't fired in the last hour. */
async function fireAlertDeduped(db, { serverId, scopeId, message, severity }) {
  const recent = await db.query(
    `SELECT id FROM alert_events WHERE message=$1 AND fired_at > NOW()-INTERVAL '1 hour' LIMIT 1`,
    [message]).catch(() => ({ rows: [] }));
  if (recent.rows.length) return;
  await db.query(
    `INSERT INTO alert_events (server_id, scope_id, message, severity) VALUES ($1,$2,$3,$4)`,
    [serverId || null, scopeId || null, message, severity || 'warning']).catch(() => {});
  log(`[Alert] ${(severity || 'warning').toUpperCase()}: ${message}`);
}

// ── DHCP Failover ─────────────────────────────────────────────
async function pollFailover(db, ps, server, auth) {
  if (server.role === 'dns') return;
  const ip = server.ip_address;
  let pairs;
  try { pairs = ps.getDhcpFailover(ip, auth); }
  catch (err) { warn(`[Failover] ${ip}: ${err.message}`); return; }
  if (!pairs || !pairs.length) return;

  for (const p of pairs) {
    const relName = p.Name || `${p.PrimaryServerName}↔${p.SecondaryServerName}`;
    const mode = p.Mode === 'LoadBalance' ? 'load-balance' : (p.Mode ? String(p.Mode).toLowerCase() : 'hot-standby');
    const state = (p.State || 'unknown').toString().toLowerCase().replace(/\s+/g, '-');
    const mclt = p.MaxClientLeadTime ? parseInt(String(p.MaxClientLeadTime).replace(/\D/g, '')) || null : null;

    // Resolve partner server ids by hostname (best-effort).
    const prim = await db.query(`SELECT id FROM ddi_servers WHERE hostname ILIKE $1 OR host(ip_address)=$2 LIMIT 1`,
      [`%${p.PrimaryServerName || server.hostname}%`, ip]).catch(() => ({ rows: [] }));
    const sec = await db.query(`SELECT id FROM ddi_servers WHERE hostname ILIKE $1 LIMIT 1`,
      [`%${p.SecondaryServerName || ''}%`]).catch(() => ({ rows: [] }));

    // Detect state change vs last stored state → alert.
    const existing = await db.query(`SELECT id, state FROM dhcp_failover_pairs WHERE relationship_name=$1 LIMIT 1`, [relName]).catch(() => ({ rows: [] }));
    const prevState = existing.rows[0] ? existing.rows[0].state : null;

    if (existing.rows.length) {
      await db.query(
        `UPDATE dhcp_failover_pairs SET primary_server_id=$2, secondary_server_id=$3, mode=$4, state=$5,
           mclt=$6, split_ratio=$7, last_checked=NOW() WHERE id=$1`,
        [existing.rows[0].id, prim.rows[0]?.id || null, sec.rows[0]?.id || null, mode, state, mclt, p.LoadBalancePercent || null]);
    } else {
      await db.query(
        `INSERT INTO dhcp_failover_pairs (primary_server_id, secondary_server_id, relationship_name, mode, state, mclt, split_ratio)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [prim.rows[0]?.id || null, sec.rows[0]?.id || null, relName, mode, state, mclt, p.LoadBalancePercent || null]);
    }

    if (prevState && prevState !== state && state !== 'normal') {
      await fireAlertDeduped(db, {
        serverId: server.id, message: `DHCP failover "${relName}" changed state: ${prevState} → ${state}`,
        severity: state === 'partner-down' || state === 'communication-interrupted' ? 'critical' : 'warning',
      });
    }
  }
  log(`[Failover] ${ip} — ${pairs.length} relationship(s) checked`);
}

// ── DNS SOA / replication lag ─────────────────────────────────
async function pollDnsSoa(db, ps, server, auth) {
  if (server.role === 'dhcp') return;
  const ip = server.ip_address;
  const zones = await db.query(
    `SELECT id, zone_name FROM dns_zones WHERE server_id=$1 AND is_reverse=FALSE`, [server.id]).catch(() => ({ rows: [] }));
  let checked = 0;
  for (const z of zones.rows) {
    let soa;
    try { soa = ps.getDnsZoneSoa(ip, z.zone_name, auth); } catch { continue; }
    if (!soa || soa.Serial == null) continue;
    const serial = parseInt(soa.Serial);

    // Compare with the max serial seen for the same zone name on OTHER servers.
    const others = await db.query(
      `SELECT MAX(soa_serial) AS maxserial FROM dns_zones WHERE zone_name=$1 AND server_id<>$2 AND soa_serial IS NOT NULL`,
      [z.zone_name, server.id]).catch(() => ({ rows: [{ maxserial: null }] }));
    const peerMax = others.rows[0].maxserial != null ? parseInt(others.rows[0].maxserial) : null;
    const lag = peerMax != null && serial < peerMax;

    await db.query(
      `UPDATE dns_zones SET soa_serial=$2, soa_checked_at=NOW(), replication_lag=$3 WHERE id=$1`,
      [z.id, serial, lag]).catch(() => {});

    if (lag) {
      await fireAlertDeduped(db, {
        serverId: server.id, message: `DNS zone "${z.zone_name}" on ${server.hostname} is behind (serial ${serial} < ${peerMax})`,
        severity: 'warning',
      });
    }
    checked++;
  }
  if (checked) log(`[DNS-SOA] ${ip} — ${checked} zone serial(s) checked`);
}

// ── Per-server health score ───────────────────────────────────
async function pollHealth(db, ps, server, auth) {
  const ip = server.ip_address;
  let score = 100;
  const isDns = server.role !== 'dhcp';

  // WinRM reachability
  let winrmOk = true;
  try {
    const t = ps.testWinRM(ip, auth);
    winrmOk = !!t.ok;
  } catch { winrmOk = false; }
  if (!winrmOk) score -= 50;

  // Poll status from the main collector
  if (server.poll_status === 'error') score -= 20;

  // Scope pressure
  const scopes = await db.query(
    `SELECT MAX(percent_used) AS worst, COUNT(*) AS c FROM dhcp_scopes WHERE server_id=$1`, [server.id]).catch(() => ({ rows: [{ worst: 0, c: 0 }] }));
  const worst = parseFloat(scopes.rows[0].worst) || 0;
  if (worst >= 95) score -= 15; else if (worst >= 90) score -= 10;

  // DNS query response time
  let queryMs = null, soaInSync = null;
  if (isDns && winrmOk) {
    try {
      const q = ps.testDnsQuery(ip, server.hostname, auth);
      if (q && q.Ok) { queryMs = parseInt(q.Ms); if (queryMs > 500) score -= 10; }
      else { score -= 20; }
    } catch { /* ignore */ }
    const lagged = await db.query(`SELECT COUNT(*) AS c FROM dns_zones WHERE server_id=$1 AND replication_lag=TRUE`, [server.id]).catch(() => ({ rows: [{ c: 0 }] }));
    soaInSync = parseInt(lagged.rows[0].c) === 0;
    if (!soaInSync) score -= 15;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const counts = await db.query(
    `SELECT (SELECT COUNT(*) FROM dhcp_scopes WHERE server_id=$1) AS scopes,
            (SELECT COUNT(*) FROM dhcp_leases WHERE server_id=$1) AS leases,
            (SELECT COUNT(*) FROM dns_zones WHERE server_id=$1) AS zones,
            (SELECT COALESCE(SUM(record_count),0) FROM dns_zones WHERE server_id=$1) AS records`,
    [server.id]).catch(() => ({ rows: [{}] }));
  const c = counts.rows[0];

  await db.query(`UPDATE ddi_servers SET health_score=$2, health_checked_at=NOW(), query_ms=$3 WHERE id=$1`,
    [server.id, score, queryMs]).catch(() => {});
  await db.query(
    `INSERT INTO server_health_history (server_id, health_score, winrm_ok, scope_count, lease_count, zone_count, record_count, query_ms, soa_in_sync)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [server.id, score, winrmOk, c.scopes || 0, c.leases || 0, c.zones || 0, c.records || 0, queryMs, soaInSync]).catch(() => {});

  if (score < 80) {
    await fireAlertDeduped(db, {
      serverId: server.id, message: `Server "${server.hostname}" health score dropped to ${score}/100`,
      severity: score < 70 ? 'critical' : 'warning',
    });
  }
  log(`[Health] ${ip} — score ${score}/100 (winrm=${winrmOk}, query=${queryMs ?? '—'}ms)`);
}

module.exports = { pollFailover, pollDnsSoa, pollHealth };
