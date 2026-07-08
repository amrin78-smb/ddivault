'use strict';

/**
 * reportsScheduling.js — Saved report views, scheduled deliveries, run history,
 * and the compliance-pack download for DDIVault.
 *
 * Mounted at /api/reports BEFORE the main reports router so these specific paths
 * (/saved, /schedules, /history, /pack) win over the main router's catch-all
 * /:type route.
 *
 * All SQL is parameterized — user input is never string-interpolated.
 */

const express = require('express');
const { requireSuperAdmin, requireAuth, requireWrite, attachSiteFilter } = require('./middleware/rbac');
const { generateReport, generatePack, REPORTS } = require('./reports');
const emailer = require('./emailer');
const scheduler = require('../collector/reportScheduler'); // computeNextRun(schedule, fromDate), deliverSchedule(db, schedule)

// Actor identity for audit / created_by columns. The frontend stamps every
// /api/* request with x-ddi-actor (see middleware/rbac.js); fall back to system.
const actor = (req) => req.headers['x-ddi-actor'] || 'system';

// ── Small validation helpers ──────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CADENCES = ['daily', 'weekly', 'monthly'];
const FORMATS = ['pdf', 'csv'];

function isEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim());
}

// A report_type is valid only if it's a real report key. Rejecting bogus types up
// front avoids saving a schedule that would fail to generate on every run forever.
function isKnownReport(t) {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(REPORTS, t);
}

// Parse an int, returning null when absent/invalid.
function parseIntOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

// Validate the recipients list — must be a non-empty array of email strings.
// Returns { ok: true, value: [...] } or { ok: false, error }.
function validateRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { ok: false, error: 'recipients must be a non-empty array of email addresses' };
  }
  const cleaned = recipients.map(r => (typeof r === 'string' ? r.trim() : r));
  const bad = cleaned.filter(r => !isEmail(r));
  if (bad.length) {
    return { ok: false, error: `Invalid email address(es): ${bad.join(', ')}` };
  }
  return { ok: true, value: cleaned };
}

// Validate schedule scheduling fields. `partial` = true for PUT (only validate
// provided fields). Returns { ok, error?, values } where values holds the
// normalized cadence/hour/day_of_week/day_of_month/format.
function validateScheduleFields(body, partial) {
  const values = {};

  // format
  if (body.format !== undefined || !partial) {
    const fmt = (body.format || 'pdf').toLowerCase();
    if (!FORMATS.includes(fmt)) {
      return { ok: false, error: `format must be one of: ${FORMATS.join(', ')}` };
    }
    values.format = fmt;
  }

  // cadence
  let cadence = values.cadence;
  if (body.cadence !== undefined || !partial) {
    cadence = body.cadence;
    if (!CADENCES.includes(cadence)) {
      return { ok: false, error: `cadence must be one of: ${CADENCES.join(', ')}` };
    }
    values.cadence = cadence;
  }

  // hour (0-23, default 7)
  if (body.hour !== undefined || !partial) {
    const hour = body.hour === undefined || body.hour === null || body.hour === ''
      ? 7
      : parseIntOrNull(body.hour);
    if (hour == null || hour < 0 || hour > 23) {
      return { ok: false, error: 'hour must be an integer between 0 and 23' };
    }
    values.hour = hour;
  }

  // day_of_week (0-6) — required when cadence is weekly
  if (body.day_of_week !== undefined || cadence === 'weekly') {
    const dow = parseIntOrNull(body.day_of_week);
    if (cadence === 'weekly') {
      if (dow == null || dow < 0 || dow > 6) {
        return { ok: false, error: 'day_of_week (0-6) is required when cadence is weekly' };
      }
    } else if (dow != null && (dow < 0 || dow > 6)) {
      return { ok: false, error: 'day_of_week must be an integer between 0 and 6' };
    }
    values.day_of_week = dow;
  }

  // day_of_month (1-28) — required when cadence is monthly
  if (body.day_of_month !== undefined || cadence === 'monthly') {
    const dom = parseIntOrNull(body.day_of_month);
    if (cadence === 'monthly') {
      if (dom == null || dom < 1 || dom > 28) {
        return { ok: false, error: 'day_of_month (1-28) is required when cadence is monthly' };
      }
    } else if (dom != null && (dom < 1 || dom > 28)) {
      return { ok: false, error: 'day_of_month must be an integer between 1 and 28' };
    }
    values.day_of_month = dom;
  }

  return { ok: true, values };
}

// Standard 500 responder — guards res.headersSent for the streaming pack route.
function fail(res, err) {
  if (res.headersSent) { try { res.end(); } catch { /* stream already gone */ } return; }
  // Never leak raw DB/error text to the client (suite rule); log server-side only.
  console.error(err);
  res.status(500).json({ error: 'Reports admin failed' });
}

// ════════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════════
function createReportsSchedulingRouter(db) {
  const router = express.Router();

  // ── SAVED VIEWS (any authenticated user) ────────────────────

  router.get('/saved', requireAuth, async (req, res) => {
    try {
      const r = await db.query('SELECT * FROM saved_reports ORDER BY name');
      res.json({ data: r.rows });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/saved', requireWrite, async (req, res) => {
    try {
      const { name, report_type, params } = req.body || {};
      if (!name || !report_type) {
        return res.status(400).json({ error: 'name and report_type are required' });
      }
      if (!isKnownReport(report_type)) {
        return res.status(400).json({ error: 'Unknown report_type: ' + report_type });
      }
      const r = await db.query(
        `INSERT INTO saved_reports (name, report_type, params, created_by)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING *`,
        [name, report_type, JSON.stringify(params || {}), actor(req)]
      );
      res.json({ data: r.rows[0] });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/saved/:id', requireWrite, async (req, res) => {
    try {
      const id = parseIntOrNull(req.params.id);
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const { name, params } = req.body || {};
      const r = await db.query(
        `UPDATE saved_reports
            SET name = COALESCE($2, name),
                params = COALESCE($3::jsonb, params),
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id, name != null ? name : null, params != null ? JSON.stringify(params) : null]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Saved report not found' });
      res.json({ data: r.rows[0] });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/saved/:id', requireWrite, async (req, res) => {
    try {
      const id = parseIntOrNull(req.params.id);
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const r = await db.query('DELETE FROM saved_reports WHERE id = $1 RETURNING id', [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Saved report not found' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── SCHEDULES ───────────────────────────────────────────────

  router.get('/schedules', requireAuth, async (req, res) => {
    try {
      const r = await db.query('SELECT * FROM report_schedules ORDER BY name');
      res.json({ data: r.rows });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/schedules', requireSuperAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const { name, report_type, params } = body;
      if (!name || !report_type) {
        return res.status(400).json({ error: 'name and report_type are required' });
      }
      if (!isKnownReport(report_type)) {
        return res.status(400).json({ error: 'Unknown report_type: ' + report_type });
      }

      const recip = validateRecipients(body.recipients);
      if (!recip.ok) return res.status(400).json({ error: recip.error });

      const fields = validateScheduleFields(body, false);
      if (!fields.ok) return res.status(400).json({ error: fields.error });
      const v = fields.values;

      const nextRunAt = scheduler.computeNextRun(
        { cadence: v.cadence, hour: v.hour, day_of_week: v.day_of_week, day_of_month: v.day_of_month },
        new Date()
      );

      const r = await db.query(
        `INSERT INTO report_schedules
           (name, report_type, params, format, cadence, hour, day_of_week, day_of_month,
            recipients, enabled, next_run_at, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12)
         RETURNING *`,
        [
          name, report_type, JSON.stringify(params || {}), v.format, v.cadence,
          v.hour, v.day_of_week != null ? v.day_of_week : null,
          v.day_of_month != null ? v.day_of_month : null,
          recip.value,
          body.enabled === undefined ? true : !!body.enabled,
          nextRunAt, actor(req),
        ]
      );
      res.json({ data: r.rows[0] });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/schedules/:id', requireSuperAdmin, async (req, res) => {
    try {
      const id = parseIntOrNull(req.params.id);
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const body = req.body || {};

      const existing = await db.query('SELECT * FROM report_schedules WHERE id = $1', [id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Schedule not found' });
      const cur = existing.rows[0];

      // Validate provided recipients (if present).
      let recipients = cur.recipients;
      if (body.recipients !== undefined) {
        const recip = validateRecipients(body.recipients);
        if (!recip.ok) return res.status(400).json({ error: recip.error });
        recipients = recip.value;
      }

      // Validate name/report_type if explicitly cleared.
      if (body.name !== undefined && !body.name) {
        return res.status(400).json({ error: 'name cannot be empty' });
      }
      if (body.report_type !== undefined && !body.report_type) {
        return res.status(400).json({ error: 'report_type cannot be empty' });
      }
      if (body.report_type !== undefined && body.report_type && !isKnownReport(body.report_type)) {
        return res.status(400).json({ error: 'Unknown report_type: ' + body.report_type });
      }

      // Merge scheduling fields against current row, then validate the effective set.
      const merged = {
        cadence: body.cadence !== undefined ? body.cadence : cur.cadence,
        hour: body.hour !== undefined ? body.hour : cur.hour,
        day_of_week: body.day_of_week !== undefined ? body.day_of_week : cur.day_of_week,
        day_of_month: body.day_of_month !== undefined ? body.day_of_month : cur.day_of_month,
        format: body.format !== undefined ? body.format : cur.format,
      };
      const fields = validateScheduleFields(merged, false);
      if (!fields.ok) return res.status(400).json({ error: fields.error });
      const v = fields.values;

      // Recompute next_run_at when any scheduling field OR enabled changes.
      const schedulingChanged =
        body.cadence !== undefined || body.hour !== undefined ||
        body.day_of_week !== undefined || body.day_of_month !== undefined ||
        body.enabled !== undefined;
      const enabled = body.enabled !== undefined ? !!body.enabled : cur.enabled;
      const nextRunAt = schedulingChanged
        ? scheduler.computeNextRun(
            { cadence: v.cadence, hour: v.hour, day_of_week: v.day_of_week, day_of_month: v.day_of_month },
            new Date()
          )
        : cur.next_run_at;

      const params = body.params !== undefined ? JSON.stringify(body.params || {}) : null;

      const r = await db.query(
        `UPDATE report_schedules
            SET name = COALESCE($2, name),
                report_type = COALESCE($3, report_type),
                params = COALESCE($4::jsonb, params),
                format = $5,
                cadence = $6,
                hour = $7,
                day_of_week = $8,
                day_of_month = $9,
                recipients = $10::text[],
                enabled = $11,
                next_run_at = $12,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          id,
          body.name !== undefined ? body.name : null,
          body.report_type !== undefined ? body.report_type : null,
          params,
          v.format,
          v.cadence,
          v.hour,
          v.day_of_week != null ? v.day_of_week : null,
          v.day_of_month != null ? v.day_of_month : null,
          recipients,
          enabled,
          nextRunAt,
        ]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Schedule not found' });
      res.json({ data: r.rows[0] });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/schedules/:id', requireSuperAdmin, async (req, res) => {
    try {
      const id = parseIntOrNull(req.params.id);
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const r = await db.query('DELETE FROM report_schedules WHERE id = $1 RETURNING id', [id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Schedule not found' });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Run a schedule immediately (generate + email + log run/email history as a
  // 'manual' trigger). This deliberately does NOT advance/rewrite next_run_at or
  // the cadence — the normal scheduled run still fires as planned (avoids a
  // same-day duplicate). An in-flight guard inside deliverSchedule prevents this
  // from delivering concurrently with the auto tick (or a second click) for the
  // same schedule; if it's already running we return 409 instead of double-sending.
  router.post('/schedules/:id/run', requireSuperAdmin, async (req, res) => {
    try {
      const id = parseIntOrNull(req.params.id);
      if (id == null) return res.status(400).json({ error: 'Invalid id' });
      const existing = await db.query('SELECT * FROM report_schedules WHERE id = $1', [id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Schedule not found' });
      const row = existing.rows[0];

      const r = await scheduler.deliverSchedule(db, row, {
        triggerType: 'manual',
        updateState: false,
        generatedBy: actor(req),
      });
      if (r && r.busy) {
        return res.status(409).json({ error: 'Schedule is already running', result: r });
      }
      res.json({ ok: r && r.status === 'success', result: r });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── RUN HISTORY (any authenticated user) ────────────────────

  router.get('/history', requireAuth, async (req, res) => {
    try {
      let limit = parseIntOrNull(req.query.limit);
      if (limit == null) limit = 50;
      limit = Math.max(1, Math.min(200, limit));
      const r = await db.query(
        `SELECT id, schedule_id, report_type, format, row_count, status, error_msg,
                trigger_type, generated_by, created_at
           FROM report_run_history
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit]
      );
      res.json({ data: r.rows });
    } catch (err) {
      fail(res, err);
    }
  });

  // ── COMPLIANCE PACK (any authenticated user; site-scoped) ───

  router.get('/pack', attachSiteFilter, async (req, res) => {
    try {
      const typesRaw = (req.query.types || '').trim();
      if (!typesRaw) {
        return res.status(400).json({ error: 'types query parameter is required (comma-separated report keys)' });
      }
      const types = typesRaw.split(',').map(t => t.trim()).filter(Boolean);
      if (!types.length) {
        return res.status(400).json({ error: 'types query parameter is required (comma-separated report keys)' });
      }
      const validTypes = types.filter(isKnownReport);
      if (!validTypes.length) {
        return res.status(400).json({ error: 'No valid report types in: ' + types.join(', ') });
      }

      const { buffer, contentType, filename } = await generatePack(db, {
        types: validTypes,
        query: req.query,
        allowedSiteIds: req.allowedSiteIds,
        actor: actor(req),
        title: req.query.title || 'Compliance Pack',
      });

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

module.exports = { createReportsSchedulingRouter };
