'use strict';
/**
 * stats.js — turn a DNS server's counters into dns_query_stats rows.
 *
 * ⛔ BIND AND POWERDNS REPORT TOTALS SINCE BOOT, NOT A RATE. Storing them raw
 * would show a server that has been up for a year as impossibly busy and a
 * freshly restarted one as idle, and the numbers would only ever climb. Every
 * sample here is therefore a DELTA against the previous one, with the elapsed
 * time used to derive queries_per_sec.
 *
 * ⛔ A COUNTER THAT WENT DOWN MEANS THE SERVER RESTARTED, NOT THAT TRAFFIC WAS
 * NEGATIVE. The delta is discarded in that case and the sample is recorded with
 * NULL rates — "we cannot know what happened across the restart" — rather than
 * a negative number, a zero, or a wildly wrong spike. The next sample is normal
 * again because this one re-establishes the baseline.
 */

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }

/**
 * @param {object} db
 * @param {object} server  serverContext()
 * @param {object} sample  provider.getQueryStats() result (cumulative:true)
 * @returns {Promise<{recorded: boolean, reason?: string, delta?: object}>}
 */
async function recordQueryStats(db, server, sample) {
  if (!sample) return { recorded: false, reason: 'no sample' };

  // The previous CUMULATIVE reading, kept alongside the row so the next delta
  // has something to subtract from.
  let prev = null;
  try {
    const r = await db.query(
      `SELECT recorded_at, cumulative_total, cumulative_success, cumulative_nxdomain, cumulative_failed
         FROM dns_query_stats
        WHERE server_id = $1 AND cumulative_total IS NOT NULL
        ORDER BY recorded_at DESC LIMIT 1`, [server.id]);
    prev = r.rows[0] || null;
  } catch (e) {
    // Un-migrated DB (the cumulative_* columns arrive with this feature).
    return { recorded: false, reason: `dns_query_stats not migrated: ${e.message}` };
  }

  const curTotal = num(sample.total_queries);
  const curSucc = num(sample.successful);
  const curNx = num(sample.nxdomain_count);
  const curFail = num(sample.failed);

  let total = null, successful = null, nxdomain = null, failed = null, qps = null;
  let reason = 'baseline';

  if (prev && curTotal != null && num(prev.cumulative_total) != null) {
    const prevTotal = num(prev.cumulative_total);
    const elapsedSec = Math.max(1, (Date.now() - new Date(prev.recorded_at).getTime()) / 1000);
    if (curTotal < prevTotal) {
      // ⛔ Restart. Record the new baseline, claim nothing about the interval.
      reason = 'counter reset (server restarted) — interval not computable';
    } else {
      total = curTotal - prevTotal;
      successful = curSucc != null && num(prev.cumulative_success) != null
        ? Math.max(0, curSucc - num(prev.cumulative_success)) : null;
      nxdomain = curNx != null && num(prev.cumulative_nxdomain) != null
        ? Math.max(0, curNx - num(prev.cumulative_nxdomain)) : null;
      failed = curFail != null && num(prev.cumulative_failed) != null
        ? Math.max(0, curFail - num(prev.cumulative_failed)) : null;
      qps = Math.round((total / elapsedSec) * 100) / 100;
      reason = 'delta';
    }
  }

  try {
    await db.query(
      `INSERT INTO dns_query_stats
         (server_id, recorded_at, total_queries, successful, failed, nxdomain_count,
          response_time_ms, queries_per_sec,
          cumulative_total, cumulative_success, cumulative_nxdomain, cumulative_failed)
       VALUES ($1, NOW(), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [server.id, total, successful, failed, nxdomain,
       num(server.query_ms), qps,
       curTotal, curSucc, curNx, curFail]);
  } catch (e) {
    return { recorded: false, reason: e.message };
  }
  return { recorded: true, reason, delta: { total, successful, failed, nxdomain, qps } };
}

module.exports = { recordQueryStats };
