// reportScheduler.js — DDIVault scheduled report delivery.
//
// Runs inside the collector process. On each tick it finds report_schedules that
// are due (next_run_at in the past or never run), generates each report via the
// shared report generator, emails the rendered PDF/CSV to every recipient, logs
// each generation and each send, and advances next_run_at to the next occurrence.
//
// All timing is LOCAL server time. computeNextRun is a pure function so it can be
// unit-tested and reused by the API when a schedule is created/updated.

const reports = require('../api/reports');  // { generateReport(db, opts) }
const emailer = require('../api/emailer');  // { sendReport(db,to,subj,html,attachments), renderReportHtml(title,intro,meta) }

// Compute the next run strictly AFTER fromDate, in local server time, at hour:00:00.000.
// schedule: { cadence, hour, day_of_week, day_of_month }.
function computeNextRun(schedule, fromDate) {
  const from = (fromDate instanceof Date && !isNaN(fromDate.getTime())) ? fromDate : new Date();
  let cadence = (schedule && schedule.cadence) || 'daily';
  if (cadence !== 'daily' && cadence !== 'weekly' && cadence !== 'monthly') cadence = 'daily';

  let hour = (schedule && schedule.hour != null) ? parseInt(schedule.hour, 10) : 7;
  if (isNaN(hour) || hour < 0 || hour > 23) hour = 7;

  const at = (y, m, d) => new Date(y, m, d, hour, 0, 0, 0);

  if (cadence === 'daily') {
    let cand = at(from.getFullYear(), from.getMonth(), from.getDate());
    if (cand.getTime() <= from.getTime()) {
      cand = at(from.getFullYear(), from.getMonth(), from.getDate() + 1);
    }
    return cand;
  }

  if (cadence === 'weekly') {
    let dow = (schedule && schedule.day_of_week != null) ? parseInt(schedule.day_of_week, 10) : 1;
    if (isNaN(dow) || dow < 0 || dow > 6) dow = 1;
    // Start from today; advance day-by-day until we land on the target day-of-week
    // at a time strictly after fromDate.
    for (let offset = 0; offset <= 7; offset++) {
      const cand = at(from.getFullYear(), from.getMonth(), from.getDate() + offset);
      if (cand.getDay() === dow && cand.getTime() > from.getTime()) return cand;
    }
    // Fallback (should never hit): one week out at target hour.
    return at(from.getFullYear(), from.getMonth(), from.getDate() + 7);
  }

  // monthly
  let dom = (schedule && schedule.day_of_month != null) ? parseInt(schedule.day_of_month, 10) : 1;
  if (isNaN(dom)) dom = 1;
  if (dom < 1) dom = 1;
  if (dom > 28) dom = 28; // clamp so it always exists in every month

  let cand = at(from.getFullYear(), from.getMonth(), dom);
  if (cand.getTime() <= from.getTime()) {
    cand = at(from.getFullYear(), from.getMonth() + 1, dom); // JS Date rolls month/year
  }
  return cand;
}

// Generate one report, email it to each recipient, and log everything.
// Never throws for a single-schedule failure — always returns a summary object.
//
// This does NOT advance next_run_at. For the scheduled path the caller
// (runDueReports) has already ATOMICALLY CLAIMED the run — it advanced
// next_run_at BEFORE any work began — so a crash mid-delivery cannot leave the
// row still-due and re-send to every recipient (S1), and a failed final UPDATE
// can no longer re-fire the run every tick (S4). For the manual "run now" path
// the cadence is deliberately left untouched so the next scheduled run still
// fires as planned (S2/S5).
//
// opts:
//   triggerType — 'scheduled' (default) or 'manual'; recorded in report_run_history.
//   updateState — when true, writes last_status back to the schedule after delivery
//                 (scheduled path only); never moves next_run_at. Default false.
//   generatedBy — value for report_run_history.generated_by (default 'scheduler').
async function deliverSchedule(db, schedule, opts) {
  opts = opts || {};
  const triggerType = opts.triggerType === 'manual' ? 'manual' : 'scheduled';
  const updateState = opts.updateState === true;
  const generatedBy = opts.generatedBy || 'scheduler';

  // In-flight guard: the same schedule id must never be delivered concurrently
  // (a manual "run now" racing the auto tick, or two manual clicks). Best-effort
  // within THIS process; cross-process safety comes from claimDueRun's atomic
  // claim. If already in flight, bail immediately without sending anything.
  if (_inFlight.has(schedule.id)) {
    return { status: 'busy', busy: true, runId: null, emailed: 0, failed: 0, skipped: 0, error: 'already running' };
  }
  _inFlight.add(schedule.id);

  let status = 'failed';
  let runId = null;
  let emailed = 0;
  let failed = 0;
  let skipped = 0;
  let error;

  const paramsJson = JSON.stringify((schedule && schedule.params) || {});
  const reportType = schedule.report_type;
  const format = schedule.format || 'pdf';

  try {
    // ── 1. Generate the report (ONLY generation lives in this try/catch) ────
    let out = null;
    try {
      out = await reports.generateReport(db, {
        type: reportType,
        query: schedule.params || {},
        allowedSiteIds: null,
        format,
        actor: 'scheduler',
      });
    } catch (genErr) {
      error = genErr.message;
      out = null;
    }

    if (!out) {
      // Generation genuinely failed → record 'failed', skip email. Logging is
      // best-effort and must never abort the schedule.
      try {
        await db.query(
          `INSERT INTO report_run_history
             (schedule_id, report_type, format, params, row_count, status, error_msg, trigger_type, generated_by, created_at)
           VALUES ($1,$2,$3,$4::jsonb,NULL,'failed',$5,$6,$7,NOW())`,
          [schedule.id, reportType, format, paramsJson, error, triggerType, generatedBy]
        );
      } catch (_) { /* logging must never abort the schedule */ }
    } else {
      // Generation succeeded. Record the 'success' history row in its OWN try so
      // a logging blip here is NOT misread as a generation failure that skips
      // email (S3). A failed history INSERT leaves runId null but still emails.
      try {
        const ins = await db.query(
          `INSERT INTO report_run_history
             (schedule_id, report_type, format, params, row_count, status, trigger_type, generated_by, created_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,'success',$6,$7,NOW())
           RETURNING id`,
          [schedule.id, reportType, format, paramsJson, out.rowCount, triggerType, generatedBy]
        );
        runId = ins.rows[0] && ins.rows[0].id;
      } catch (_) { /* history logging failure must NOT abort emailing */ }

      // ── 2. Email to each recipient ────────────────────────────────────────
      const subject = 'DDIVault report: ' + (out.title || schedule.name);
      const html = emailer.renderReportHtml(
        out.title || schedule.name,
        'Your scheduled DDIVault report "' + schedule.name + '" is attached.',
        [
          ['Report', out.title],
          ['Format', (schedule.format || 'pdf').toUpperCase()],
          ['Rows', String(out.rowCount)],
          ['Cadence', schedule.cadence],
        ]
      );
      const attachments = [{ filename: out.filename, content: out.buffer }];
      const recipients = Array.isArray(schedule.recipients) ? schedule.recipients : [];

      for (const email of recipients) {
        // Wrap each send+log so one bad recipient can't abort the rest.
        try {
          const r = await emailer.sendReport(db, email, subject, html, attachments);
          const sendStatus = r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed');
          // A 'skipped' send (SMTP disabled) is not a failure — count it separately so
          // it doesn't inflate the failure tally.
          if (r.ok) emailed++;
          else if (r.skipped) skipped++;
          else failed++;
          try {
            await db.query(
              `INSERT INTO report_email_log
                 (schedule_id, run_id, recipient, subject, status, error_msg, sent_at)
               VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
              [schedule.id, runId, email, subject, sendStatus, r.error || null]
            );
          } catch (_) { /* audit log best-effort */ }
        } catch (sendErr) {
          failed++;
          try {
            await db.query(
              `INSERT INTO report_email_log
                 (schedule_id, run_id, recipient, subject, status, error_msg, sent_at)
               VALUES ($1,$2,$3,$4,'failed',$5,NOW())`,
              [schedule.id, runId, email, subject, sendErr.message]
            );
          } catch (_) { /* audit log best-effort */ }
        }
      }
      // Overall success: report generated. (Individual recipient failures are
      // recorded per-row but do not, by themselves, mark the whole run failed.)
      status = 'success';
    }

    // ── 3. Record final status WITHOUT moving next_run_at ───────────────────
    // The claim already advanced next_run_at/last_run_at; here we only stamp the
    // outcome. Manual runs pass updateState=false so they never touch the cadence.
    if (updateState) {
      try {
        await db.query(
          `UPDATE report_schedules
              SET last_status = $1, updated_at = NOW()
            WHERE id = $2`,
          [status, schedule.id]
        );
      } catch (_) { /* never throw out of deliverSchedule */ }
    }

    return { status, runId, emailed, failed, skipped, error };
  } finally {
    _inFlight.delete(schedule.id);
  }
}

// Re-entrancy guard: the collector calls this on a 5-min interval. If one tick's
// work (many schedules / recipients / a hung SMTP send) outlives the interval, the
// next tick must NOT start a second pass over the same still-due rows (whose
// next_run_at hasn't advanced yet) — that would double-send. Only one run at a time.
let _running = false;

// Schedule ids currently being delivered in THIS process. Guards the auto tick's
// claimed run and a manual "run now" (or two manual clicks) from delivering the
// same schedule concurrently. deliverSchedule checks/sets/clears this in a finally.
const _inFlight = new Set();

// Atomically CLAIM a due run before any work: advance next_run_at (to the SAME
// value we would otherwise persist at the end) and stamp last_run_at, guarded on
// the row still being due at the value we selected. If another tick already
// claimed it — or it's no longer due/enabled — rowCount is 0 and we must NOT
// proceed. Returns true iff this caller won the claim. This makes a scheduled run
// at-most-once per period: a crash after the claim skips that period (visible in
// history) rather than re-sending duplicate emails to customers.
async function claimDueRun(db, schedule) {
  const nextRun = computeNextRun(schedule, new Date());
  const dueAt = schedule.next_run_at;
  let res;
  if (dueAt == null) {
    // "never run" rows are selected via next_run_at IS NULL — claim that state.
    res = await db.query(
      `UPDATE report_schedules
          SET last_run_at = NOW(), next_run_at = $2, updated_at = NOW()
        WHERE id = $1 AND enabled = TRUE AND next_run_at IS NULL
        RETURNING id`,
      [schedule.id, nextRun]
    );
  } else {
    res = await db.query(
      `UPDATE report_schedules
          SET last_run_at = NOW(), next_run_at = $2, updated_at = NOW()
        WHERE id = $1 AND enabled = TRUE AND next_run_at = $3
        RETURNING id`,
      [schedule.id, nextRun, dueAt]
    );
  }
  return res.rowCount === 1;
}

// Find and deliver all due schedules, in sequence (email sending stays gentle).
async function runDueReports(db) {
  if (_running) return { checked: 0, ran: 0, emailed: 0, failed: 0, failedRuns: 0, busy: true };
  _running = true;
  let checked = 0;
  let ran = 0;
  let emailed = 0;
  let failed = 0;
  let failedRuns = 0;   // schedules whose generation failed (distinct from recipient send failures)
  try {
    let rows = [];
    try {
      const res = await db.query(
        `SELECT * FROM report_schedules
          WHERE enabled = TRUE
            AND (next_run_at IS NULL OR next_run_at <= NOW())`
      );
      rows = res.rows;
    } catch (e) {
      console.error('[Reports] cannot fetch due schedules:', e.message);
      return { checked, ran, emailed, failed, failedRuns };
    }

    for (const row of rows) {
      checked++;

      // Don't even attempt to claim a row already being delivered in this process.
      if (_inFlight.has(row.id)) continue;

      // CLAIM before any work: advances next_run_at atomically so (a) a crash
      // mid-delivery can't leave the row still-due → everyone re-receives it, and
      // (b) a concurrent tick can't double-process it. Only proceed on a win.
      let claimed = false;
      try {
        claimed = await claimDueRun(db, row);
      } catch (e) {
        console.error('[Reports] claim failed for schedule ' + (row && row.id) + ':', e.message);
        continue;
      }
      if (!claimed) continue; // lost the claim, or no longer due/enabled

      try {
        const r = await deliverSchedule(db, row, { triggerType: 'scheduled', updateState: true });
        if (r && r.busy) continue; // being delivered elsewhere in this process
        ran++;
        emailed += r.emailed || 0;
        failed += r.failed || 0;
        if (r.status === 'failed') failedRuns++;   // count generation failures in the summary
      } catch (e) {
        // deliverSchedule should not throw, but guard so one failure never stops the loop.
        failedRuns++;
        console.error('[Reports] schedule ' + (row && row.id) + ' error:', e.message);
      }
    }

    return { checked, ran, emailed, failed, failedRuns };
  } finally {
    _running = false;
  }
}

module.exports = { computeNextRun, deliverSchedule, runDueReports };
