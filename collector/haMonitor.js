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

/** Human-readable duration from seconds (e.g. 90 -> "2m", 7200 -> "2h"). */
function formatDuration(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// PostgreSQL inet values include CIDR (e.g. 172.24.0.10/32) which the
// PowerShell remoting functions reject — strip it before any PS use.
const cleanIp = ip => (ip || '').replace(/\/\d+$/, '').trim();

/**
 * Fire an alert only if there isn't already an OPEN one for the same condition.
 * "Open" = acknowledged=FALSE AND resolved_at IS NULL. dedupeKey is a SQL LIKE
 * pattern identifying the ongoing condition, so a re-poll with a slightly
 * different message (new score, serial, or state) doesn't create a duplicate;
 * it defaults to the exact message.
 */
async function fireAlertDeduped(db, { serverId, scopeId, message, severity, dedupeKey }) {
  const recent = await db.query(
    `SELECT id FROM alert_events
      WHERE message LIKE $1 AND acknowledged=FALSE AND resolved_at IS NULL LIMIT 1`,
    [dedupeKey || message]).catch(() => ({ rows: [] }));
  if (recent.rows.length) return;
  await db.query(
    `INSERT INTO alert_events (server_id, scope_id, message, severity) VALUES ($1,$2,$3,$4)`,
    [serverId || null, scopeId || null, message, severity || 'warning']).catch(() => {});
  log(`[Alert] ${(severity || 'warning').toUpperCase()}: ${message}`);
}

/** Auto-resolve open alerts whose condition has cleared (matched by LIKE pattern). */
async function resolveAlerts(db, { pattern, reason }) {
  await db.query(
    `UPDATE alert_events SET resolved_at=NOW(), resolved_reason=$2
      WHERE acknowledged=FALSE AND resolved_at IS NULL AND message LIKE $1`,
    [pattern, reason || 'condition-cleared']).catch(() => {});
}

// ── DHCP Failover ─────────────────────────────────────────────
async function pollFailover(db, ps, server, auth) {
  if (server.role === 'dns') return;
  const ip = cleanIp(server.ip_address);
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
        dedupeKey: `DHCP failover "${relName}" changed state:%`,
        severity: state === 'partner-down' || state === 'communication-interrupted' ? 'critical' : 'warning',
      });
    } else if (state === 'normal') {
      // Failover back to normal — auto-resolve any open alert for this relationship.
      await resolveAlerts(db, { pattern: `DHCP failover "${relName}" changed state:%`, reason: 'failover-normal' });
    }
  }
  log(`[Failover] ${ip} — ${pairs.length} relationship(s) checked`);
}

// ── DNS SOA / replication lag ─────────────────────────────────
async function pollDnsSoa(db, ps, server, auth) {
  if (server.role === 'dhcp') return;
  const ip = cleanIp(server.ip_address);
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
      const behind = peerMax - serial;
      // Estimate how far behind in wall-clock time using the zone's recent
      // average serial-change rate from dns_zone_sync snapshots (best-effort).
      let estStr = '';
      try {
        const rate = await db.query(
          `SELECT (MAX(soa_serial) - MIN(soa_serial)) AS dser,
                  EXTRACT(EPOCH FROM (MAX(checked_at) - MIN(checked_at))) AS dsec
             FROM dns_zone_sync
            WHERE zone_name = $1 AND checked_at > NOW() - INTERVAL '7 days'`,
          [z.zone_name]).catch(() => ({ rows: [{}] }));
        const dser = Number(rate.rows[0] && rate.rows[0].dser) || 0;
        const dsec = Number(rate.rows[0] && rate.rows[0].dsec) || 0;
        if (dser > 0 && dsec > 0 && behind > 0) {
          estStr = `, ~${formatDuration(behind * (dsec / dser))} behind`;
        }
      } catch { /* ignore rate estimate failures */ }

      await fireAlertDeduped(db, {
        serverId: server.id,
        message: `DNS zone "${z.zone_name}" on ${server.hostname} is behind (serial ${serial} < ${peerMax}) — ${behind} revision${behind === 1 ? '' : 's'} behind${estStr}`,
        dedupeKey: `DNS zone "${z.zone_name}" on ${server.hostname} is behind%`,
        severity: 'warning',
      });
    } else {
      // Zone caught up with its peers — auto-resolve any open replication-lag alert.
      await resolveAlerts(db, { pattern: `DNS zone "${z.zone_name}" on ${server.hostname} is behind%`, reason: 'replication-caught-up' });
    }
    checked++;
  }
  if (checked) log(`[DNS-SOA] ${ip} — ${checked} zone serial(s) checked`);
}

// ── Per-server health score ───────────────────────────────────
async function pollHealth(db, ps, server, auth) {
  const ip = cleanIp(server.ip_address);
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

  // Forwarder reachability (only relevant for DNS servers that have forwarders).
  let fwdTotal = 0, fwdDown = 0;
  if (isDns) {
    const fwd = await db.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_reachable = FALSE) AS down
         FROM dns_forwarder_health
        WHERE server_id = $1 AND last_checked > NOW() - INTERVAL '1 hour'`,
      [server.id]).catch(() => ({ rows: [{ total: 0, down: 0 }] }));
    fwdTotal = parseInt(fwd.rows[0].total) || 0;
    fwdDown = parseInt(fwd.rows[0].down) || 0;
  }

  await db.query(`UPDATE ddi_servers SET health_score=$2, health_checked_at=NOW(), query_ms=$3 WHERE id=$1`,
    [server.id, score, queryMs]).catch(() => {});
  await db.query(
    `INSERT INTO server_health_history (server_id, health_score, winrm_ok, scope_count, lease_count, zone_count, record_count, query_ms, soa_in_sync)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [server.id, score, winrmOk, c.scopes || 0, c.leases || 0, c.zones || 0, c.records || 0, queryMs, soaInSync]).catch(() => {});

  if (score < 80) {
    // Build a human-readable breakdown of the factors that drove the score down.
    const factors = [];
    factors.push(`WinRM: ${winrmOk ? 'OK' : 'Failed'}`);
    if (isDns) {
      if (queryMs != null) {
        const qual = queryMs > 1000 ? ' (critical)' : queryMs > 500 ? ' (slow)' : '';
        factors.push(`Query response: ${queryMs}ms${qual}`);
      } else if (winrmOk) {
        factors.push('Query response: no answer');
      }
      factors.push(`Zones: ${c.zones || 0}`);
      if (fwdTotal > 0) factors.push(`Forwarders: ${fwdDown > 0 ? 'unreachable' : 'OK'}`);
      if (soaInSync === false) factors.push('Replication: behind');
    }
    if (server.poll_status === 'error') factors.push('Poll status: error');
    if (worst >= 90) factors.push(`Scope utilization: ${Math.round(worst)}% (high)`);

    const breakdown = factors.length ? ` — ${factors.join(', ')}` : '';
    await fireAlertDeduped(db, {
      serverId: server.id,
      message: `Server "${server.hostname}" health score dropped to ${score}/100${breakdown}`,
      dedupeKey: `Server "${server.hostname}" health score dropped to%`,
      severity: score < 70 ? 'critical' : 'warning',
    });
  } else {
    // Server healthy again (score >= 80) — auto-resolve any open health alert for it.
    await resolveAlerts(db, { pattern: `Server "${server.hostname}" health score dropped to%`, reason: 'server-recovered' });
  }
  log(`[Health] ${ip} — score ${score}/100 (winrm=${winrmOk}, query=${queryMs ?? '—'}ms)`);
}

module.exports = { pollFailover, pollDnsSoa, pollHealth };
