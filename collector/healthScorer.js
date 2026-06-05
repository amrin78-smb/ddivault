/**
 * healthScorer.js — DDIVault per-site network health scoring.
 *
 * Pure local module. Computes four 0-100 component scores (DHCP, IPAM, DNS,
 * Security) per site and an overall weighted score, then appends a row to
 * site_health_scores (append-only history; the API reads the latest per site).
 *
 * NOTE on Security score: anomaly_events has no site_id column in this DB, so
 * the anomaly portion of the security score uses a GLOBAL 24h count as a proxy
 * and is applied identically to every site. The unknown-device portion is
 * per-site (derived from IPAM).
 *
 * NOTE on site_name: sites live cross-DB in NetVault. We resolve the real name
 * from the NetVault `sites` table (best-effort) and fall back to 'Site <id>'.
 */

const { Pool } = require('pg');

// Cross-DB read of NetVault site names (same connection pattern as api/middleware/rbac.js).
const netvaultDb = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432'),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
netvaultDb.on('error', () => {}); // never crash the collector on a netvault pool hiccup

// Returns { [site_id]: name }; empty map on any failure (falls back to 'Site <id>').
async function loadSiteNames() {
  try {
    const r = await netvaultDb.query('SELECT id, name FROM sites');
    return Object.fromEntries(r.rows.map((s) => [s.id, s.name]));
  } catch (err) {
    log('Could not load NetVault site names: ' + err.message);
    return {};
  }
}

function log(m) {
  console.log('[' + new Date().toISOString() + '] [Health] ' + m);
}

function clampInt(n) {
  if (n == null || isNaN(n)) return 0;
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return Math.round(n);
}

/**
 * Compute the DHCP score for a site.
 * Start 100. Per scope: 70-80% -> -10, 80-90% -> -20, >90% -> -30.
 * Each unreachable/errored server in the site -> -40 (once per server).
 */
async function scoreDhcp(db, siteId) {
  let score = 100;

  const scopes = await db.query(
    `SELECT sc.percent_used
       FROM dhcp_scopes sc
       JOIN ddi_servers s ON s.id = sc.server_id
      WHERE s.site_id = $1`,
    [siteId]
  );

  let worstScopePct = 0;
  for (const row of scopes.rows) {
    const pct = row.percent_used == null ? 0 : Number(row.percent_used);
    if (pct > worstScopePct) worstScopePct = pct;
    if (pct > 90) {
      score -= 30;
    } else if (pct >= 80) {
      score -= 20;
    } else if (pct >= 70) {
      score -= 10;
    }
  }

  // Count servers in this site that are unreachable / errored (once each).
  const unreach = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM ddi_servers
      WHERE site_id = $1
        AND (poll_status = 'error' OR (is_active = TRUE AND poll_status = 'unreachable'))`,
    [siteId]
  );
  const unreachable = unreach.rows[0] ? unreach.rows[0].n : 0;
  score -= unreachable * 40;

  return {
    score: clampInt(score),
    worstScopePct: Math.round(worstScopePct),
    unreachable,
  };
}

/**
 * Compute the IPAM score for a site.
 * Start 100. unknownRatio = sum(unknown)/sum(used+unknown).
 *   < 0.05 -> no penalty; > 0.20 -> -40; between -> -20.
 * Any subnet scanned within 7 days -> +10 (cap 100).
 * No subnets -> score 100 (nothing to fault), noted in details.
 */
async function scoreIpam(db, siteId) {
  let score = 100;

  const res = await db.query(
    `SELECT
        COUNT(*)::int AS subnet_count,
        COALESCE(SUM(used_hosts), 0)::numeric    AS used_sum,
        COALESCE(SUM(unknown_hosts), 0)::numeric AS unknown_sum,
        BOOL_OR(last_scanned IS NOT NULL AND last_scanned >= NOW() - INTERVAL '7 days') AS recently_scanned
       FROM ipam_subnets
      WHERE site_id = $1`,
    [siteId]
  );

  const row = res.rows[0] || {};
  const subnetCount = row.subnet_count || 0;

  if (subnetCount === 0) {
    return {
      score: 100,
      unknownRatio: 0,
      scanned: false,
      note: 'no subnets in site',
    };
  }

  const usedSum = Number(row.used_sum) || 0;
  const unknownSum = Number(row.unknown_sum) || 0;
  const denom = usedSum + unknownSum;
  const unknownRatio = denom > 0 ? unknownSum / denom : 0;

  if (unknownRatio > 0.2) {
    score -= 40;
  } else if (unknownRatio >= 0.05) {
    score -= 20;
  }

  const scanned = !!row.recently_scanned;
  if (scanned) {
    score += 10;
  }

  return {
    score: clampInt(score),
    unknownRatio: Math.round(unknownRatio * 1000) / 1000,
    scanned,
  };
}

/**
 * Compute the DNS score for a site.
 * Start 100. DNS servers = role in ('dns','both').
 *   Any dns server unreachable (poll_status='error') -> -40 (toward 60).
 *   Any replication_lag=TRUE on this site's zones -> -20.
 *   max(query_ms): <100 no penalty, <500 -> -20, >500 -> -40.
 * No DNS servers -> score 100, noted in details.
 */
async function scoreDns(db, siteId) {
  let score = 100;

  const servers = await db.query(
    `SELECT id, query_ms, winrm_test_ok, health_score
       FROM ddi_servers
      WHERE site_id = $1
        AND role IN ('dns', 'both')`,
    [siteId]
  );

  if (servers.rows.length === 0) {
    return {
      score: 100,
      maxQueryMs: null,
      lag: false,
      unreachable: false,
      note: 'no DNS servers in site',
    };
  }

  let maxQueryMs = 0;
  let anyUnreachable = false;
  for (const s of servers.rows) {
    // A DNS server is "unreachable" only when WinRM actually failed or its health
    // score is below 50 — not merely because the DNS monitor hasn't polled yet
    // (a responding, healthy server must not read unreachable).
    const winrmFailed = s.winrm_test_ok === false;
    const lowHealth = s.health_score != null && Number(s.health_score) < 50;
    if (winrmFailed || lowHealth) anyUnreachable = true;
    const q = s.query_ms == null ? 0 : Number(s.query_ms);
    if (q > maxQueryMs) maxQueryMs = q;
  }

  if (anyUnreachable) {
    score -= 40;
  }

  // Replication lag on any zone hosted by this site's DNS servers.
  const lagRes = await db.query(
    `SELECT BOOL_OR(z.replication_lag) AS lag
       FROM dns_zones z
       JOIN ddi_servers s ON s.id = z.server_id
      WHERE s.site_id = $1
        AND s.role IN ('dns', 'both')`,
    [siteId]
  );
  const lag = lagRes.rows[0] ? !!lagRes.rows[0].lag : false;
  if (lag) {
    score -= 20;
  }

  if (maxQueryMs > 500) {
    score -= 40;
  } else if (maxQueryMs >= 100) {
    score -= 20;
  }

  return {
    score: clampInt(score),
    maxQueryMs: Math.round(maxQueryMs),
    lag,
    unreachable: anyUnreachable,
  };
}

/**
 * Compute the Security score for a site.
 * Start 100. anomaly_events (GLOBAL 24h proxy — no site_id on the table):
 *   each warning -> -5, each critical -> -15, total anomaly penalty capped -60.
 * Per-site unknown device ratio > 10% -> -20.
 */
async function scoreSecurity(db, siteId, ipamResult) {
  let score = 100;

  const anom = await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE severity = 'warning')::int  AS warnings,
        COUNT(*) FILTER (WHERE severity = 'critical')::int AS criticals
       FROM anomaly_events
      WHERE detected_at >= NOW() - INTERVAL '24 hours'`
  );
  const warnings = anom.rows[0] ? anom.rows[0].warnings : 0;
  const criticals = anom.rows[0] ? anom.rows[0].criticals : 0;

  let anomalyPenalty = warnings * 5 + criticals * 15;
  if (anomalyPenalty > 60) anomalyPenalty = 60;
  score -= anomalyPenalty;

  const unknownRatio =
    ipamResult && ipamResult.unknownRatio != null ? ipamResult.unknownRatio : 0;
  if (unknownRatio > 0.1) {
    score -= 20;
  }

  return {
    score: clampInt(score),
    warnings,
    criticals,
    unknownRatio,
    note: 'anomaly counts are global (anomaly_events has no site_id)',
  };
}

/**
 * scoreSites — score every real site and append rows to site_health_scores.
 * @param {object} db — pg client/pool with .query()
 * @returns {Promise<{sites: Array}>}
 */
async function scoreSites(db) {
  log('Starting site health scoring run');

  const siteRes = await db.query(
    `SELECT DISTINCT site_id FROM ddi_servers WHERE site_id IS NOT NULL
     UNION
     SELECT DISTINCT site_id FROM ipam_subnets WHERE site_id IS NOT NULL`
  );

  const siteIds = siteRes.rows.map((r) => r.site_id);
  log('Found ' + siteIds.length + ' site(s) to score');

  const siteNames = await loadSiteNames();
  const scored = [];

  for (const siteId of siteIds) {
    try {
      const siteName = siteNames[siteId] || ('Site ' + siteId);

      const dhcp = await scoreDhcp(db, siteId);
      const ipam = await scoreIpam(db, siteId);
      const dns = await scoreDns(db, siteId);
      const security = await scoreSecurity(db, siteId, ipam);

      const overall = clampInt(
        dhcp.score * 0.4 + ipam.score * 0.2 + dns.score * 0.2 + security.score * 0.2
      );

      const details = {
        dhcp: {
          score: dhcp.score,
          worstScopePct: dhcp.worstScopePct,
          unreachable: dhcp.unreachable,
        },
        ipam: {
          score: ipam.score,
          unknownRatio: ipam.unknownRatio,
          scanned: ipam.scanned,
          note: ipam.note || null,
        },
        dns: {
          score: dns.score,
          maxQueryMs: dns.maxQueryMs,
          lag: dns.lag,
          unreachable: dns.unreachable,
          note: dns.note || null,
        },
        security: {
          score: security.score,
          warnings: security.warnings,
          criticals: security.criticals,
          unknownRatio: security.unknownRatio,
          note: security.note,
        },
      };

      await db.query(
        `INSERT INTO site_health_scores
           (site_id, site_name, calculated_at, overall_score,
            dhcp_score, ipam_score, dns_score, security_score, details)
         VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8)`,
        [
          siteId,
          siteName,
          overall,
          dhcp.score,
          ipam.score,
          dns.score,
          security.score,
          JSON.stringify(details),
        ]
      );

      log(
        'Site ' +
          siteId +
          ' scored: overall=' +
          overall +
          ' dhcp=' +
          dhcp.score +
          ' ipam=' +
          ipam.score +
          ' dns=' +
          dns.score +
          ' security=' +
          security.score
      );

      scored.push({
        site_id: siteId,
        site_name: siteName,
        overall_score: overall,
        dhcp_score: dhcp.score,
        ipam_score: ipam.score,
        dns_score: dns.score,
        security_score: security.score,
        details,
      });
    } catch (err) {
      log('ERROR scoring site ' + siteId + ': ' + (err && err.message ? err.message : err));
    }
  }

  log('Scoring run complete: ' + scored.length + ' site(s) scored');
  return { sites: scored };
}

module.exports = { scoreSites };
