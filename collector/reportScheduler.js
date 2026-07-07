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

// Generate one scheduled report, email it to each recipient, and log everything.
// Never throws for a single-schedule failure — always returns a summary object.
async function deliverSchedule(db, schedule) {
  let status = 'failed';
  let runId = null;
  let emailed = 0;
  let failed = 0;
  let skipped = 0;
  let error;

  let out = null;
  const paramsJson = JSON.stringify((schedule && schedule.params) || {});
  const reportType = schedule.report_type;
  const format = schedule.format || 'pdf';

  // ── 1. Generate the report ──────────────────────────────────────────────
  try {
    out = await reports.generateReport(db, {
      type: reportType,
      query: schedule.params || {},
      allowedSiteIds: null,
      format,
      actor: 'scheduler',
    });
    const ins = await db.query(
      `INSERT INTO report_run_history
         (schedule_id, report_type, format, params, row_count, status, trigger_type, generated_by, created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,'success','scheduled','scheduler',NOW())
       RETURNING id`,
      [schedule.id, reportType, format, paramsJson, out.rowCount]
    );
    runId = ins.rows[0] && ins.rows[0].id;
  } catch (genErr) {
    error = genErr.message;
    try {
      await db.query(
        `INSERT INTO report_run_history
           (schedule_id, report_type, format, params, row_count, status, error_msg, trigger_type, generated_by, created_at)
         VALUES ($1,$2,$3,$4::jsonb,NULL,'failed',$5,'scheduled','scheduler',NOW())`,
        [schedule.id, reportType, format, paramsJson, genErr.message]
      );
    } catch (_) { /* logging must never abort the schedule */ }
    out = null;
  }

  // ── 2. Email to each recipient (only if generation succeeded) ───────────
  if (out) {
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

  // ── 3. Always advance the schedule so a failure doesn't hammer ──────────
  const nextRun = computeNextRun(schedule, new Date());
  try {
    await db.query(
      `UPDATE report_schedules
          SET last_run_at = NOW(), last_status = $1, next_run_at = $2, updated_at = NOW()
        WHERE id = $3`,
      [status, nextRun, schedule.id]
    );
  } catch (_) { /* never throw out of deliverSchedule */ }

  return { status, runId, emailed, failed, skipped, error };
}

// Re-entrancy guard: the collector calls this on a 5-min interval. If one tick's
// work (many schedules / recipients / a hung SMTP send) outlives the interval, the
// next tick must NOT start a second pass over the same still-due rows (whose
// next_run_at hasn't advanced yet) — that would double-send. Only one run at a time.
let _running = false;

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
      try {
        const r = await deliverSchedule(db, row);
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
