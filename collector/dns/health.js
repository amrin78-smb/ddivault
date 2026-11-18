'use strict';
/**
 * health.js — health scoring for a DNS server we reach over the protocol.
 *
 * ⛔ THIS EXISTS BECAUSE SCORING EVERY SERVER BY `testWinRM` IS A CATEGORY
 * ERROR. haMonitor.pollHealth() starts at 100 and subtracts 50 when WinRM does
 * not answer. A BIND host has no WinRM and never will, so a server whose zones
 * and records we are successfully transferring scored 50 and rendered DEGRADED —
 * and OFFLINE outright once anyone pressed Test Connection, because that writes
 * winrm_test_ok=false and the DNS tab treats that as decisive.
 *
 * The same mistake, three times this month in three products: judging a thing by
 * a measurement that does not apply to it. The fix is never to soften the
 * threshold — it is to measure the thing that IS the health of THIS server.
 */

const { providerFor } = require('./index');
const client = require('./client');

/**
 * Probe a protocol-collected DNS server.
 *
 * Scored on what actually indicates health for one of these:
 *   - does it answer a DNS query at all  (the equivalent of WinRM reachability)
 *   - how fast                            (same thresholds as the Windows path)
 *   - can we still enumerate its zones    (stats channel / API still up)
 *   - did the last collection error       (recorded by sync.js)
 *   - are any of its zones replication-lagged
 *
 * @returns {Promise<{score, query_ms, reachable, detail, factors: string[]}>}
 */
async function probeProtocolHealth(db, server) {
  const provider = providerFor(server.dns_platform);
  const factors = [];
  let score = 100;
  let queryMs = null;
  let reachable = false;

  if (!provider) {
    return { score: 0, query_ms: null, reachable: false, detail: `no provider for ${server.dns_platform}`, factors: ['provider: none'] };
  }

  // ── 1. Does it answer DNS at all? ──
  // Ask for the SOA of a zone we already know it serves. ⛔ Not a fixed name
  // like the hostname: a BIND server authoritative for example.com has no
  // reason to resolve its own A record, and recursion is usually off, so a
  // generic lookup would report a perfectly healthy server as dead.
  let zoneName = null;
  try {
    const z = await db.query(
      `SELECT zone_name FROM dns_zones WHERE server_id = $1 AND is_reverse = FALSE
        ORDER BY record_count DESC NULLS LAST LIMIT 1`, [server.id]);
    zoneName = z.rows[0] && z.rows[0].zone_name;
  } catch { /* un-migrated or empty — handled below */ }

  if (zoneName) {
    const t0 = Date.now();
    try {
      await client.querySoa(server.dns_host, server.dns_port || 53, zoneName, { timeoutMs: 5000 });
      queryMs = Date.now() - t0;
      reachable = true;
      if (queryMs > 1000) { score -= 20; factors.push(`Query response: ${queryMs}ms (critical)`); }
      else if (queryMs > 500) { score -= 10; factors.push(`Query response: ${queryMs}ms (slow)`); }
      else { factors.push(`Query response: ${queryMs}ms`); }
    } catch (e) {
      score -= 50;
      factors.push(`DNS query: failed (${e.message})`);
    }
  } else {
    // ⛔ NOT A PENALTY. No zones yet means we have not collected successfully
    // even once — which the zone-channel check below reports properly. Scoring
    // a brand-new server down for having no history would make every freshly
    // added server look unhealthy for its first cycle.
    factors.push('DNS query: no known zone to probe yet');
  }

  // ── 2. Can we still enumerate zones? (stats channel / API) ──
  try {
    const t = await provider.testConnection(server);
    if (t && t.ok) {
      factors.push(`${server.dns_platform}: ${t.detail || 'reachable'}`);
    } else {
      score -= 20;
      factors.push(`${server.dns_platform} management channel: ${(t && t.detail) || 'unreachable'}`);
    }
  } catch (e) {
    score -= 20;
    factors.push(`${server.dns_platform} management channel: ${e.message}`);
  }

  // ── 3. Did the last collection report an error? ──
  if (server.dns_last_error) { score -= 10; factors.push(`Last collection: ${server.dns_last_error}`); }

  // ── 4. Replication lag, same weighting as the Windows path ──
  try {
    const lag = await db.query(
      `SELECT COUNT(*) AS c FROM dns_zones WHERE server_id = $1 AND replication_lag = TRUE`, [server.id]);
    if (parseInt(lag.rows[0].c, 10) > 0) { score -= 15; factors.push('SOA replication: lagging'); }
  } catch { /* column may not exist on an un-migrated DB */ }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, query_ms: queryMs, reachable, detail: factors.join('; '), factors };
}

module.exports = { probeProtocolHealth };
