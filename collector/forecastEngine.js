// forecastEngine.js — DDIVault capacity planning via linear regression.
//
// Pure local computation: pulls DHCP scope utilization history, fits a
// least-squares line of in_use leases over time (days), and projects when
// each scope will cross 80% / 90% / 100% utilization. Results are upserted
// into scope_forecasts and (optionally) raise scope_exhaustion_forecast
// alerts with email dispatch.
//
// NOTE: There is no per-subnet history table, so IPAM subnet forecasting is
// intentionally not implemented here. If a subnet history table is added
// later, mirror the runForecasts logic against it.

function log(m) {
  console.log('[' + new Date().toISOString() + '] ' + m);
}

// Least-squares linear regression. xs = days, ys = in_use.
// Returns { slope, ok }. ok=false when the denominator is zero (degenerate x).
function linregSlope(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, ok: false };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, ok: true };
}

async function runForecasts(db) {
  let processed = 0;
  let upserted = 0;
  let fired = 0;

  // Pull the alert rule once (default threshold 14 days, default severity 'warning').
  let alertThreshold = 14;
  let alertEnabled = false;
  let alertSeverity = 'warning';
  try {
    const r = await db.query(
      `SELECT threshold_value, is_enabled, severity
         FROM alert_rule_config
        WHERE rule_type = 'scope_exhaustion_forecast'
        LIMIT 1`
    );
    if (r.rows.length) {
      const row = r.rows[0];
      if (row.threshold_value != null) alertThreshold = Number(row.threshold_value);
      alertEnabled = !!row.is_enabled;
      if (row.severity) alertSeverity = row.severity;
    }
  } catch (e) {
    log('Could not read scope_exhaustion_forecast rule config: ' + e.message);
  }

  let scopes;
  try {
    const sr = await db.query(
      `SELECT id, scope_id, name, in_use, total_ips, server_id FROM dhcp_scopes`
    );
    scopes = sr.rows;
  } catch (e) {
    log('Failed to load dhcp_scopes: ' + e.message);
    return { scopes: 0, forecasts: 0, alerts: 0 };
  }

  for (const scope of scopes) {
    try {
      const dbId = scope.id;            // dhcp_scopes.id (FK target for history)
      const scopeTextId = scope.scope_id; // textual scope id (e.g. "10.0.0.0")
      const name = scope.name;
      const total = Number(scope.total_ips);

      // 1. Fetch last 30 days of history.
      const hr = await db.query(
        `SELECT in_use, EXTRACT(EPOCH FROM recorded_at) AS ts
           FROM dhcp_scope_history
          WHERE scope_id = $1
            AND recorded_at > NOW() - INTERVAL '30 days'
          ORDER BY recorded_at ASC`,
        [dbId]
      );
      const hist = hr.rows;
      const dataPoints = hist.length;
      if (dataPoints < 7) {
        continue; // not enough signal to forecast
      }

      // 2. Linear regression of in_use over time-in-days.
      const ts0 = Number(hist[0].ts);
      const xs = hist.map((h) => (Number(h.ts) - ts0) / 86400);
      const ys = hist.map((h) => Number(h.in_use));
      const { slope, ok } = linregSlope(xs, ys);
      if (!ok) {
        continue; // degenerate x (e.g. all same timestamp)
      }
      const growthRate = slope; // leases/day

      // 3. Current usage / total.
      const latestInUse = Number(hist[hist.length - 1].in_use);
      const current = Number.isFinite(latestInUse) ? latestInUse : Number(scope.in_use);
      if (!(total > 0)) {
        continue; // cannot compute a percentage
      }

      // 4. Percentages and time-to-target.
      const currentPct = Math.round((current / total) * 100 * 100) / 100;

      function daysTo(target) {
        if (slope <= 0) return null;          // not growing
        if (current >= target) return 0;       // already there
        return Math.max(0, Math.ceil((target - current) / slope));
      }
      const daysTo80 = daysTo(0.8 * total);
      const daysTo90 = daysTo(0.9 * total);
      const daysToFull = daysTo(total);

      // 5. Confidence from sample size.
      let confidence;
      if (dataPoints >= 30) confidence = 'high';
      else if (dataPoints >= 14) confidence = 'medium';
      else confidence = 'low';

      // 6. Recommendation text.
      let recommendation;
      if (slope <= 0 || daysToFull == null) {
        recommendation = 'Scope healthy — no action needed';
      } else if (daysToFull <= 7) {
        recommendation = 'Critical — expand scope immediately';
      } else if (daysToFull <= 14) {
        recommendation = `Action required — scope exhausts in ~${daysToFull} days. Consider expanding to /23`;
      } else if (daysTo80 != null && daysTo80 <= 30) {
        recommendation = `Monitor closely — will reach 80% in ~${daysTo80} days`;
      } else {
        recommendation = 'Scope healthy — no action needed';
      }

      // 7. Upsert forecast.
      await db.query(
        `INSERT INTO scope_forecasts
           (scope_id, calculated_at, current_pct, growth_rate_per_day,
            days_to_80pct, days_to_90pct, days_to_full, confidence,
            recommendation, data_points)
         VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (scope_id) DO UPDATE SET
           calculated_at      = NOW(),
           current_pct        = EXCLUDED.current_pct,
           growth_rate_per_day= EXCLUDED.growth_rate_per_day,
           days_to_80pct      = EXCLUDED.days_to_80pct,
           days_to_90pct      = EXCLUDED.days_to_90pct,
           days_to_full       = EXCLUDED.days_to_full,
           confidence         = EXCLUDED.confidence,
           recommendation     = EXCLUDED.recommendation,
           data_points        = EXCLUDED.data_points`,
        [
          dbId,
          currentPct,
          growthRate,
          daysTo80,
          daysTo90,
          daysToFull,
          confidence,
          recommendation,
          dataPoints,
        ]
      );
      upserted++;

      // 8. Alert (with 24h dedup) + best-effort email dispatch.
      if (alertEnabled && daysToFull != null && daysToFull <= alertThreshold) {
        const message = `Scope ${scopeTextId} (${name}) forecast to exhaust in ~${daysToFull} days`;
        try {
          const dup = await db.query(
            `SELECT 1 FROM alert_events
              WHERE scope_id = $1
                AND severity = $2
                AND message LIKE 'Scope ' || $3 || ' %forecast to exhaust%'
                AND fired_at > NOW() - INTERVAL '24 hours'
              LIMIT 1`,
            [scopeTextId, alertSeverity, scopeTextId]
          );
          if (dup.rows.length === 0) {
            const ins = await db.query(
              `INSERT INTO alert_events (server_id, scope_id, message, severity, fired_at)
               VALUES ($1, $2, $3, $4, NOW())
               RETURNING *`,
              [scope.server_id, scopeTextId, message, alertSeverity]
            );
            fired++;
            const insertedRow = ins.rows[0];
            try {
              const ad = require('../api/alertDispatcher');
              await ad.dispatchAlert(db, insertedRow, 'scope_exhaustion_forecast');
            } catch (_) {
              // dispatch failure must never break forecasting
            }
          }
        } catch (e) {
          log(`Alert handling failed for scope ${scopeTextId}: ${e.message}`);
        }
      }

      processed++;
    } catch (e) {
      log(`Forecast failed for scope ${scope && scope.scope_id}: ${e.message}`);
    }
  }

  log(`Forecast run complete — scopes=${processed} forecasts=${upserted} alerts=${fired}`);
  return { scopes: processed, forecasts: upserted, alerts: fired };
}

module.exports = { runForecasts };
