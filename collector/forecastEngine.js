// forecastEngine.js — DDIVault capacity planning via linear regression.
//
// Pure local computation: pulls DHCP scope utilization history, aggregates to
// daily peaks, filters out anomalous/ramp-up days, fits a least-squares line of
// in_use leases over time (days), and projects when each scope will cross
// 80% / 90% / 100% utilization. Results are upserted into scope_forecasts and
// (optionally) raise scope_exhaustion_forecast alerts with email dispatch.
//
// Each forecast is classified by `status`:
//   'ok'                — growing and exhaustion projected within a year
//   'stable'            — growth below ~0.5 leases/day, OR exhaustion not
//                         projected within ~365 days; not alarmist
//   'insufficient_data' — fewer than 7 usable peak-days; days null
//
// Exhaustion alerts only fire for 'ok' forecasts at the highest confidence
// tier (>= 14 peak-days), within the configured threshold (default 30 days).
//
// NOTE: There is no per-subnet history table, so IPAM subnet forecasting is
// intentionally not implemented here. If a subnet history table is added
// later, mirror the runForecasts logic against it.

const MIN_PEAK_DAYS = 7;        // minimum days of peak data for a forecast
const MAX_PEAK_DAYS = 14;       // only the most recent N peak-days are relevant
const ANOMALY_FLOOR_PCT = 0.2;  // drop days whose peak < 20% of the median peak
const STABLE_SLOPE = 0.5;       // leases/day below which a scope is "stable"

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

  // Pull the alert rule once (default threshold 30 days, default severity 'warning').
  let alertThreshold = 30;
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
      const dbId = scope.id;             // dhcp_scopes.id (FK target for history)
      const scopeTextId = scope.scope_id; // textual scope id (e.g. "10.0.0.0")
      const name = scope.name;
      const total = Number(scope.total_ips);

      if (!(total > 0)) {
        continue; // cannot compute a percentage
      }

      // Shared upsert — handles all three statuses through one code path.
      const upsertForecast = (f) =>
        db.query(
          `INSERT INTO scope_forecasts
             (scope_id, calculated_at, current_pct, growth_rate_per_day,
              days_to_80pct, days_to_90pct, days_to_full, confidence,
              recommendation, data_points, status)
           VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (scope_id) DO UPDATE SET
             calculated_at      = NOW(),
             current_pct        = EXCLUDED.current_pct,
             growth_rate_per_day= EXCLUDED.growth_rate_per_day,
             days_to_80pct      = EXCLUDED.days_to_80pct,
             days_to_90pct      = EXCLUDED.days_to_90pct,
             days_to_full       = EXCLUDED.days_to_full,
             confidence         = EXCLUDED.confidence,
             recommendation     = EXCLUDED.recommendation,
             data_points        = EXCLUDED.data_points,
             status             = EXCLUDED.status`,
          [
            dbId, f.currentPct, f.growthRate, f.daysTo80, f.daysTo90,
            f.daysToFull, f.confidence, f.recommendation, f.dataPoints, f.status,
          ]
        );

      const currentPctOf = (val) =>
        Math.round((Number(val) / total) * 100 * 100) / 100;

      const insufficient = async (dataPoints) => {
        await upsertForecast({
          currentPct: currentPctOf(scope.in_use),
          growthRate: 0,
          daysTo80: null, daysTo90: null, daysToFull: null,
          confidence: 'low',
          recommendation: 'Insufficient data — need at least 7 days of history',
          dataPoints,
          status: 'insufficient_data',
        });
        upserted++;
        processed++;
      };

      // 1. Fetch last 30 days of raw history (aggregated to daily peaks below).
      const hr = await db.query(
        `SELECT in_use, recorded_at, EXTRACT(EPOCH FROM recorded_at) AS ts
           FROM dhcp_scope_history
          WHERE scope_id = $1
            AND recorded_at > NOW() - INTERVAL '30 days'
          ORDER BY recorded_at ASC`,
        [dbId]
      );
      const hist = hr.rows;

      // 2. Aggregate to one peak (max in_use) reading per calendar day. Newly
      //    added scopes ramp up and night/off-hours readings are low; daily
      //    peaks smooth out that noise so the regression tracks real growth.
      const dailyPeaks = {};
      for (const row of hist) {
        const day = new Date(row.recorded_at).toISOString().split('T')[0];
        if (!dailyPeaks[day] || Number(row.in_use) > Number(dailyPeaks[day].in_use)) {
          dailyPeaks[day] = row;
        }
      }
      const peakHistory = Object.values(dailyPeaks).sort(
        (a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)
      );

      // 3. Require at least 7 days of peak data for a reliable forecast.
      if (peakHistory.length < MIN_PEAK_DAYS) {
        await insufficient(peakHistory.length);
        continue;
      }

      // 4. Drop anomalous days (peak < 20% of median peak) — collector outages or
      //    a scope that was only just added show up as near-zero days and skew
      //    the regression line.
      const sortedPeaks = peakHistory.map((r) => Number(r.in_use)).sort((a, b) => a - b);
      const medianPeak = sortedPeaks[Math.floor(sortedPeaks.length / 2)];
      let filteredHistory = peakHistory.filter(
        (r) => Number(r.in_use) >= medianPeak * ANOMALY_FLOOR_PCT
      );

      // 5. Cap at the most recent 14 peak-days — older data is less relevant.
      filteredHistory = filteredHistory.slice(-MAX_PEAK_DAYS);

      // Guard: if filtering left too few points to regress, treat as insufficient.
      if (filteredHistory.length < MIN_PEAK_DAYS) {
        await insufficient(filteredHistory.length);
        continue;
      }

      // 6. Linear regression of daily-peak in_use over time-in-days.
      const ts0 = Number(filteredHistory[0].ts);
      const xs = filteredHistory.map((h) => (Number(h.ts) - ts0) / 86400);
      const ys = filteredHistory.map((h) => Number(h.in_use));
      const { slope, ok } = linregSlope(xs, ys);
      if (!ok) {
        continue; // degenerate x (e.g. all readings land on the same day)
      }
      const growthRate = slope; // leases/day

      const dataPoints = filteredHistory.length;
      const latestInUse = Number(filteredHistory[filteredHistory.length - 1].in_use);
      const current = Number.isFinite(latestInUse) ? latestInUse : Number(scope.in_use);
      const currentPct = currentPctOf(current);

      // 7. Confidence from sample size (peak-days actually used).
      let confidence;
      if (dataPoints >= 14) confidence = 'high';
      else if (dataPoints >= 10) confidence = 'medium';
      else confidence = 'low';

      // 8. Below ~0.5 leases/day the scope is effectively flat — don't raise an
      //    alarmist exhaustion forecast; report it as stable instead.
      if (slope < STABLE_SLOPE) {
        await upsertForecast({
          currentPct,
          growthRate,
          daysTo80: null, daysTo90: null, daysToFull: null,
          confidence,
          recommendation: 'Stable — no significant growth',
          dataPoints,
          status: 'stable',
        });
        upserted++;
        processed++;
        continue;
      }

      // 9. Percentages and time-to-target.
      // Cap forecast days so a near-zero (but positive) slope can't produce an
      // astronomical value that overflows the INTEGER columns. 9999 days ≈ 27y.
      const safeDays = (days) => {
        if (days == null || !isFinite(days) || days < 0) return null;
        return Math.min(Math.round(days), 9999);
      };
      function daysTo(target) {
        if (slope <= 0) return null;          // not growing
        if (current >= target) return 0;       // already there
        return safeDays(Math.ceil((target - current) / slope));
      }
      const daysTo80 = daysTo(0.8 * total);
      const daysTo90 = daysTo(0.9 * total);
      const daysToFull = daysTo(total);

      // 9b. Pathological near-zero-slope guard: a tiny positive slope above
      //     STABLE_SLOPE can still project exhaustion hundreds/thousands of days
      //     out. Anything beyond ~365 days is not actionable — report it as
      //     'stable' rather than an alarming "exhausts in 9999 days".
      if (daysToFull == null || daysToFull > 365) {
        await upsertForecast({
          currentPct,
          growthRate,
          daysTo80, daysTo90, daysToFull,
          confidence,
          recommendation: 'Stable — exhaustion not projected within a year',
          dataPoints,
          status: 'stable',
        });
        upserted++;
        processed++;
        continue;
      }

      // 10. Recommendation text.
      let recommendation;
      if (daysToFull == null) {
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

      // 11. Upsert forecast.
      await upsertForecast({
        currentPct, growthRate, daysTo80, daysTo90, daysToFull,
        confidence, recommendation, dataPoints, status: 'ok',
      });
      upserted++;

      // 12. Alert (with 72h dedup) + best-effort email dispatch.
      // Only fire when the forecast is high-confidence (>= 14 peak-days used).
      // Lower-confidence trends are too noisy to alert on.
      if (
        alertEnabled &&
        confidence === 'high' &&
        daysToFull != null &&
        daysToFull <= alertThreshold
      ) {
        const message = `Scope ${scopeTextId} (${name}) forecast to exhaust in ~${daysToFull} days`;
        try {
          const dup = await db.query(
            `SELECT 1 FROM alert_events
              WHERE scope_id = $1
                AND severity = $2
                AND message LIKE 'Scope ' || $3 || ' %forecast to exhaust%'
                AND fired_at > NOW() - INTERVAL '72 hours'
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
