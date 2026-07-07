'use strict';

/**
 * reports.js — Professional reporting engine for DDIVault
 *
 * Six report types, each renderable as JSON, CSV, or PDF (via pdfkit).
 * Exports an Express router mounted at /api/reports.
 *
 * Every report shares: cover page, page header/footer with page numbers,
 * zebra-striped tables, landscape orientation for wide tables.
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const { attachSiteFilter } = require('./middleware/rbac');

// ── Brand palette (matches the frontend design system) ────────
const RED = '#C8102E';
const NAVY = '#1a2744';
const MUTED = '#64748b';
const LIGHT = '#f1f5f9';
const BORDER = '#e2e8f0';
const GREEN = '#16a34a';
const YELLOW = '#d97706';

// ── Small helpers ─────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-GB', { hour12: false }); } catch { return String(d); }
}
function fmtDay(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-GB'); } catch { return String(d); }
}
function pct(n) { return `${(parseFloat(n) || 0).toFixed(1)}%`; }
function num(n) { return (n == null || n === '') ? '—' : String(n); }

/** Least-squares slope of utilization vs time → days to 100%. */
function daysToExhaustion(history) {
  // history: [{ recorded_at, percent_used }] ascending
  const pts = (history || []).filter(h => h.percent_used != null);
  if (pts.length < 2) return null;
  const t0 = new Date(pts[0].recorded_at).getTime();
  const xs = pts.map(p => (new Date(p.recorded_at).getTime() - t0) / 86400000); // days
  const ys = pts.map(p => parseFloat(p.percent_used));
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom; // pct per day
  if (slope <= 0.001) return Infinity; // not growing
  const current = ys[ys.length - 1];
  const remaining = 100 - current;
  if (remaining <= 0) return 0;
  return Math.round(remaining / slope);
}
function fmtForecast(days) {
  if (days == null) return 'No data';
  if (days === Infinity) return 'Stable';
  if (days === 0) return 'Exhausted';
  if (days > 3650) return '> 10 yrs';
  return `${days} days`;
}

async function companyName(db) {
  try {
    const r = await db.query("SELECT value FROM app_settings WHERE key = 'company_name'");
    return (r.rows[0] && r.rows[0].value) || 'NocVault';
  } catch { return 'NocVault'; }
}

// ── Input validation (hardening) ──────────────────────────────
// Time-period params (from/to/as_of) and numeric filters (server_id/site_id/…)
// are parameterized ($n) so there's no injection risk, but malformed input
// (e.g. ?from=lastweek, ?server_id=abc) previously reached Postgres and threw
// "invalid input syntax…", caught by the generic handler and surfaced as an
// HTTP 500 that LEAKS the raw DB message. These helpers validate/normalize such
// input UP FRONT and throw a typed 400 with a generic message before any query
// runs, so genuinely bad input never reaches the DB (or the 500 handler).
class BadRequestError extends Error {
  constructor(message) { super(message); this.name = 'BadRequestError'; this.status = 400; }
}

// Validate a single date-ish param. Absent → null. Present-but-unparseable →
// throws BadRequestError. Accepts ISO-8601 / YYYY-MM-DD (anything Date.parse
// understands); normalizes to ISO so downstream params are consistent.
function dateParam(v, name) {
  if (v == null || v === '') return null;
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new BadRequestError(`invalid ${name}`);
  return new Date(t).toISOString();
}

// Validate an integer filter param. Absent → null. Present-but-non-integer
// (e.g. 'abc', '1.5', '5x') → throws BadRequestError. Returns a Number.
function intParam(v, name) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) throw new BadRequestError(`invalid ${name}`);
  return parseInt(s, 10);
}

// Validate + normalize the time-period chooser params into { from, to, asOf }
// (ISO strings or null). Throws BadRequestError on malformed input.
function parseRangeParams(q) {
  q = q || {};
  return {
    from: dateParam(q.from, 'from'),
    to: dateParam(q.to, 'to'),
    asOf: dateParam(q.as_of, 'as_of'),
  };
}

// ── Universal date range (Phase 1) ────────────────────────────
// Returns { from, to, asOf }. `days` is honored for backward-compat by the
// individual reports that already understand it (rogue-devices) and is exposed
// here so trend reports can fall back to a default window. Time-period params
// are validated (throws a typed 400 on malformed input) BEFORE any query runs.
function resolveRange(q) {
  const { from, to, asOf } = parseRangeParams(q);
  return {
    from, to, asOf,
    days: intParam(q && q.days, 'days'),
  };
}

// Rolling-window presets persisted by saved views / scheduled reports. Stored as
// `range_preset` (not frozen from/to) so a recurring report re-resolves the window on
// each run. Expanded at the request/generation boundary so EVERY report — whether it
// reads q.from/q.to directly or via resolveRange — sees concrete timestamps.
const RANGE_PRESET_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
function expandRangePreset(q) {
  if (!q || !q.range_preset || !RANGE_PRESET_DAYS[q.range_preset]) return q;
  const now = new Date();
  const from = new Date(now.getTime() - RANGE_PRESET_DAYS[q.range_preset] * 86400000);
  return { ...q, from: from.toISOString(), to: now.toISOString() };
}

// Human-friendly duration from seconds (used for MTTR).
function humanDuration(secs) {
  if (secs == null || isNaN(secs)) return '—';
  let s = Math.max(0, Math.round(secs));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Chart primitives (Phase 2 — PDF vector charts) ────────────
const SERIES_COLORS = ['#3b82f6', RED, GREEN, YELLOW, '#8b5cf6', '#0ea5e9'];

function fmtAxis(v, yFormat) {
  const r = Math.round(v);
  if (yFormat === 'percent') return `${r}%`;
  if (yFormat === 'ms') return `${r}ms`;
  return `${r}`;
}

/**
 * Draw one ChartSpec into the PDF using vector primitives only.
 * chart: { type:'line'|'area'|'bar', title, x:[], series:[{label,points,color?}], yFormat }
 */
function drawChart(doc, x0, y0, w, h, chart) {
  const yFormat = chart.yFormat || 'number';
  const series = Array.isArray(chart.series) ? chart.series : [];
  const xs = Array.isArray(chart.x) ? chart.x : [];
  const n = xs.length;

  const padL = 38, padR = 12, padT = 8, padB = 34;
  const plotX = x0 + padL;
  const plotY = y0 + padT;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, h - padT - padB);

  // domain
  const vals = [];
  for (const s of series) for (const p of (s.points || [])) if (p != null && !isNaN(p)) vals.push(Number(p));
  let min = vals.length ? Math.min(...vals) : 0;
  let max = vals.length ? Math.max(...vals) : 1;
  if (min > 0) min = 0;              // all our metrics are non-negative → baseline at 0
  if (min === max) max = min + 1;    // avoid divide-by-zero

  doc.save();
  // plot border
  doc.rect(plotX, plotY, plotW, plotH).lineWidth(0.5).strokeColor(BORDER).stroke();

  // gridlines + y labels
  const gridN = 4;
  doc.font('Helvetica').fontSize(7);
  for (let i = 0; i <= gridN; i++) {
    const gy = plotY + (plotH * i / gridN);
    const val = max - (max - min) * i / gridN;
    doc.moveTo(plotX, gy).lineTo(plotX + plotW, gy).lineWidth(0.3).strokeColor(BORDER).stroke();
    doc.fillColor(MUTED).text(fmtAxis(val, yFormat), x0, gy - 3, { width: padL - 5, align: 'right' });
  }

  const xAt = (i) => n <= 1 ? plotX + plotW / 2 : plotX + (plotW * i / (n - 1));
  const yAt = (v) => plotY + plotH - (plotH * (Number(v) - min) / (max - min));

  series.forEach((s, si) => {
    const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];
    const pts = s.points || [];
    if (chart.type === 'bar') {
      const groupW = n > 0 ? plotW / n : plotW;
      const barW = Math.max(1, (groupW * 0.72) / series.length);
      pts.forEach((p, i) => {
        if (p == null || isNaN(p)) return;
        const bx = plotX + groupW * i + groupW * 0.14 + si * barW;
        const by = yAt(p);
        doc.rect(bx, by, barW, plotY + plotH - by).fill(color);
      });
    } else {
      // line / area — break the path on null points
      let run = [];
      const flush = () => {
        if (!run.length) return;
        if (chart.type === 'area') {
          doc.moveTo(run[0][0], plotY + plotH);
          run.forEach(pt => doc.lineTo(pt[0], pt[1]));
          doc.lineTo(run[run.length - 1][0], plotY + plotH);
          doc.closePath();
          doc.fillColor(color).fillOpacity(0.12).fill();
          doc.fillOpacity(1);
        }
        if (run.length === 1) {
          doc.circle(run[0][0], run[0][1], 1.6).fill(color);
        } else {
          doc.moveTo(run[0][0], run[0][1]);
          for (let k = 1; k < run.length; k++) doc.lineTo(run[k][0], run[k][1]);
          doc.lineWidth(1.2).strokeColor(color).stroke();
        }
        run = [];
      };
      pts.forEach((p, i) => {
        if (p == null || isNaN(p)) { flush(); }
        else run.push([xAt(i), yAt(p)]);
      });
      flush();
    }
  });

  // x labels (first / mid / last)
  doc.font('Helvetica').fontSize(7).fillColor(MUTED);
  const idxs = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const seen = new Set();
  idxs.forEach(i => {
    if (i == null || seen.has(i) || xs[i] == null) return;
    seen.add(i);
    doc.text(String(xs[i]), xAt(i) - 26, plotY + plotH + 4, { width: 52, align: 'center' });
  });

  // legend
  let lx = plotX;
  const ly = plotY + plotH + 16;
  doc.font('Helvetica').fontSize(7);
  series.forEach((s, si) => {
    const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];
    const label = s.label || `Series ${si + 1}`;
    doc.rect(lx, ly, 8, 8).fill(color);
    doc.fillColor(MUTED).text(label, lx + 11, ly, { width: 140, lineBreak: false });
    lx += 11 + doc.widthOfString(label) + 16;
  });
  doc.restore();
}

// ════════════════════════════════════════════════════════════
// REPORT DEFINITIONS — each returns { columns, rows, summary }
// columns: [{ key, label, width, align, color? }]
// ════════════════════════════════════════════════════════════

async function reportSubnetUtilization(db, q, allowedSiteIds) {
  const params = [];
  const conds = [];
  const siteId = intParam(q.site_id, 'site_id');
  if (siteId != null) { params.push(siteId); conds.push(`s.site_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`s.site_id = ANY($${params.length}::int[])`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await db.query(
    `SELECT s.id, host(s.network) AS network, s.prefix_length, s.name, s.site,
            s.total_hosts, s.used_hosts, s.free_hosts, s.unknown_hosts, s.last_scanned,
            CASE WHEN s.total_hosts > 0 THEN ROUND(s.used_hosts::numeric * 100 / s.total_hosts, 1) ELSE 0 END AS util
       FROM ipam_subnets s ${where}
      ORDER BY util DESC NULLS LAST`, params);

  const rows = r.rows.map(x => ({
    _id: x.id,
    cidr: `${x.network}/${x.prefix_length}`,
    name: x.name || '—',
    site: x.site || '—',
    used: `${x.used_hosts || 0} / ${x.total_hosts || 0}`,
    unknown: x.unknown_hosts || 0,
    util: pct(x.util),
    _util: parseFloat(x.util) || 0,
    last_scanned: fmtDay(x.last_scanned),
  }));

  const over90 = rows.filter(r => r._util >= 90).length;
  const over80 = rows.filter(r => r._util >= 80 && r._util < 90).length;
  return {
    columns: [
      { key: 'cidr', label: 'Subnet', width: 110 },
      { key: 'name', label: 'Name', width: 120 },
      { key: 'site', label: 'Site', width: 80 },
      { key: 'used', label: 'Used / Total', width: 90, align: 'right' },
      { key: 'unknown', label: 'Unknown', width: 60, align: 'right' },
      { key: 'util', label: 'Utilization', width: 70, align: 'right', color: r => r._util >= 90 ? RED : r._util >= 80 ? YELLOW : GREEN },
      { key: 'last_scanned', label: 'Last Scan', width: 80 },
    ],
    rows,
    summary: [
      { label: 'Total Subnets', value: rows.length },
      { label: 'Critical (≥90%)', value: over90, color: RED },
      { label: 'Warning (80–90%)', value: over80, color: YELLOW },
      { label: 'Healthy (<80%)', value: rows.length - over90 - over80, color: GREEN },
    ],
    drill: { entity: 'subnet', idKey: '_id' },
  };
}

async function reportIpInventory(db, q, allowedSiteIds) {
  const params = [];
  const conds = [];
  const subnetId = intParam(q.subnet_id, 'subnet_id');
  const siteId = intParam(q.site_id, 'site_id');
  if (subnetId != null) { params.push(subnetId); conds.push(`a.subnet_id = $${params.length}`); }
  if (q.status) { params.push(q.status); conds.push(`a.status = $${params.length}`); }
  if (siteId != null) { params.push(siteId); conds.push(`sn.site_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`sn.site_id = ANY($${params.length}::int[])`); }
  const staleDays = intParam(q.stale_days, 'stale_days') ?? 30;
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await db.query(
    `SELECT host(a.ip_address) AS ip, a.hostname, a.mac_address, a.status,
            host(sn.network) || '/' || sn.prefix_length AS subnet, sn.site, a.last_seen,
            CASE WHEN a.dhcp_lease_id IS NOT NULL THEN 'Yes' ELSE 'No' END AS has_lease,
            (a.last_seen IS NOT NULL AND a.last_seen < NOW() - ($${params.length + 1} || ' days')::interval) AS stale
       FROM ipam_addresses a
       JOIN ipam_subnets sn ON sn.id = a.subnet_id
       ${where}
      ORDER BY a.ip_address`, [...params, staleDays]);

  const rows = r.rows.map(x => ({
    ip: x.ip,
    hostname: x.hostname || '—',
    mac: x.mac_address || '—',
    status: x.status,
    subnet: x.subnet,
    site: x.site || '—',
    lease: x.has_lease,
    last_seen: fmtDate(x.last_seen),
    _stale: x.stale,
  }));
  const stale = rows.filter(r => r._stale).length;
  return {
    columns: [
      { key: 'ip', label: 'IP Address', width: 90 },
      { key: 'hostname', label: 'Hostname', width: 120 },
      { key: 'mac', label: 'MAC', width: 110 },
      { key: 'status', label: 'Status', width: 64 },
      { key: 'subnet', label: 'Subnet', width: 100 },
      { key: 'site', label: 'Site', width: 70 },
      { key: 'lease', label: 'DHCP', width: 44, align: 'center' },
      { key: 'last_seen', label: 'Last Seen', width: 110, color: r => r._stale ? RED : null },
    ],
    rows,
    summary: [
      { label: 'Total Addresses', value: rows.length },
      { label: 'DHCP-backed', value: rows.filter(r => r.lease === 'Yes').length },
      { label: `Stale (>${staleDays}d)`, value: stale, color: stale ? YELLOW : GREEN },
      { label: 'Reserved', value: rows.filter(r => r.status === 'reserved').length },
    ],
  };
}

async function reportDhcpHealth(db, q, allowedSiteIds) {
  const range = resolveRange(q);
  const params = [];
  const conds = [];
  const serverId = intParam(q.server_id, 'server_id');
  if (serverId != null) { params.push(serverId); conds.push(`sc.server_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`srv.site_id = ANY($${params.length}::int[])`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  let r;
  if (range.asOf) {
    // Point-in-time: resolve util/in_use/free from the newest history row <= asOf per scope.
    params.push(range.asOf);
    const asOfIdx = params.length;
    r = await db.query(
      `SELECT sc.id, sc.scope_id, sc.name, sc.total_ips, sc.state,
              srv.hostname AS server, srv.poll_status, srv.health_score,
              h.in_use, h.free, h.percent_used
         FROM dhcp_scopes sc
         JOIN ddi_servers srv ON srv.id = sc.server_id
         LEFT JOIN LATERAL (
           SELECT in_use, free, percent_used
             FROM dhcp_scope_history
            WHERE scope_id = sc.id AND recorded_at <= $${asOfIdx}
            ORDER BY recorded_at DESC
            LIMIT 1
         ) h ON true
         ${where}
        ORDER BY h.percent_used DESC NULLS LAST`, params);
  } else {
    r = await db.query(
      `SELECT sc.id, sc.scope_id, sc.name, sc.in_use, sc.total_ips, sc.free, sc.percent_used, sc.state,
              srv.hostname AS server, srv.poll_status, srv.health_score
         FROM dhcp_scopes sc
         JOIN ddi_servers srv ON srv.id = sc.server_id
         ${where}
        ORDER BY sc.percent_used DESC`, params);
  }

  // peak + forecast from history — must honor as_of so a historical snapshot is
  // annotated with the peak/forecast for the 14 days ENDING AT as_of, not today's.
  // When as_of is unset, keep the present-relative (NOW - 14d) window.
  const ids = r.rows.map(x => x.id);
  const histMap = {};
  if (ids.length) {
    const h = range.asOf
      ? await db.query(
          `SELECT scope_id, percent_used, recorded_at FROM dhcp_scope_history
            WHERE scope_id = ANY($1)
              AND recorded_at <= $2
              AND recorded_at > $2::timestamptz - INTERVAL '14 days'
            ORDER BY scope_id, recorded_at ASC`, [ids, range.asOf])
      : await db.query(
          `SELECT scope_id, percent_used, recorded_at FROM dhcp_scope_history
            WHERE scope_id = ANY($1) AND recorded_at > NOW() - INTERVAL '14 days'
            ORDER BY scope_id, recorded_at ASC`, [ids]);
    for (const row of h.rows) {
      (histMap[row.scope_id] = histMap[row.scope_id] || []).push(row);
    }
  }
  const rows = r.rows.map(x => {
    const hist = histMap[x.id] || [];
    const peak = hist.reduce((m, p) => Math.max(m, parseFloat(p.percent_used) || 0), parseFloat(x.percent_used) || 0);
    return {
      _id: x.id,
      scope: x.scope_id,
      name: x.name || '—',
      server: x.server,
      used: `${x.in_use || 0} / ${x.total_ips || 0}`,
      util: pct(x.percent_used),
      _util: parseFloat(x.percent_used) || 0,
      peak: pct(peak),
      forecast: fmtForecast(daysToExhaustion(hist)),
      state: x.state || '—',
    };
  });
  return {
    columns: [
      { key: 'scope', label: 'Scope', width: 90 },
      { key: 'name', label: 'Name', width: 110 },
      { key: 'server', label: 'Server', width: 100 },
      { key: 'used', label: 'Used / Total', width: 90, align: 'right' },
      { key: 'util', label: 'Current', width: 60, align: 'right', color: r => r._util >= 90 ? RED : r._util >= 80 ? YELLOW : GREEN },
      { key: 'peak', label: 'Peak (14d)', width: 60, align: 'right' },
      { key: 'forecast', label: 'Forecast', width: 70, align: 'right' },
      { key: 'state', label: 'State', width: 56 },
    ],
    rows,
    summary: [
      { label: 'Total Scopes', value: rows.length },
      { label: 'Critical (≥90%)', value: rows.filter(r => r._util >= 90).length, color: RED },
      { label: 'Warning (80–90%)', value: rows.filter(r => r._util >= 80 && r._util < 90).length, color: YELLOW },
    ],
    drill: { entity: 'scope', idKey: '_id' },
  };
}

async function reportDnsZones(db, q, allowedSiteIds) {
  const params = [];
  const conds = [];
  const serverId = intParam(q.server_id, 'server_id');
  if (serverId != null) { params.push(serverId); conds.push(`z.server_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`srv.site_id = ANY($${params.length}::int[])`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await db.query(
    `SELECT z.id, z.zone_name, z.zone_type, z.is_reverse, z.record_count, z.last_updated,
            z.soa_serial, z.replication_lag, srv.hostname AS server,
            (SELECT COUNT(*) FROM dns_records rc WHERE rc.zone_id = z.id AND rc.record_type='A') AS a_count,
            (SELECT COUNT(*) FROM dns_records rc WHERE rc.zone_id = z.id AND rc.record_type='AAAA') AS aaaa_count,
            (SELECT COUNT(*) FROM dns_records rc WHERE rc.zone_id = z.id AND rc.record_type='CNAME') AS cname_count,
            (SELECT COUNT(*) FROM dns_records rc WHERE rc.zone_id = z.id AND rc.record_type='MX') AS mx_count,
            (SELECT COUNT(*) FROM dns_records rc WHERE rc.zone_id = z.id AND rc.record_type='PTR') AS ptr_count,
            (SELECT COUNT(*) FROM dns_records rc WHERE rc.zone_id = z.id AND rc.record_type='TXT') AS txt_count,
            (SELECT COUNT(*) FROM dns_records rc WHERE rc.zone_id = z.id AND rc.last_seen < NOW() - INTERVAL '90 days') AS stale_count
       FROM dns_zones z JOIN ddi_servers srv ON srv.id = z.server_id
       ${where}
      ORDER BY z.zone_name`, params);

  const rows = r.rows.map(x => ({
    _id: x.id,
    zone: x.zone_name,
    server: x.server,
    type: x.zone_type || (x.is_reverse ? 'Reverse' : 'Primary'),
    records: x.record_count || 0,
    a: x.a_count, cname: x.cname_count, mx: x.mx_count, ptr: x.ptr_count, txt: x.txt_count,
    stale: parseInt(x.stale_count) || 0,
    serial: x.soa_serial != null ? String(x.soa_serial) : '—',
    _lag: x.replication_lag,
  }));
  return {
    columns: [
      { key: 'zone', label: 'Zone', width: 150 },
      { key: 'server', label: 'Server', width: 100 },
      { key: 'type', label: 'Type', width: 64 },
      { key: 'records', label: 'Records', width: 56, align: 'right' },
      { key: 'a', label: 'A', width: 36, align: 'right' },
      { key: 'cname', label: 'CNAME', width: 50, align: 'right' },
      { key: 'mx', label: 'MX', width: 36, align: 'right' },
      { key: 'ptr', label: 'PTR', width: 40, align: 'right' },
      { key: 'stale', label: 'Stale 90d+', width: 60, align: 'right', color: r => r.stale > 0 ? YELLOW : null },
      { key: 'serial', label: 'SOA Serial', width: 80, align: 'right' },
    ],
    rows,
    summary: [
      { label: 'Total Zones', value: rows.length },
      { label: 'Total Records', value: rows.reduce((a, b) => a + (b.records || 0), 0) },
      { label: 'Stale Records', value: rows.reduce((a, b) => a + b.stale, 0), color: YELLOW },
      { label: 'Replication Lag', value: rows.filter(r => r._lag).length, color: RED },
    ],
    drill: { entity: 'zone', idKey: '_id' },
  };
}

async function reportNetworkChanges(db, q, allowedSiteIds) {
  const range = resolveRange(q);
  const params = [];
  const conds = [];
  if (range.from) { params.push(range.from); conds.push(`timestamp >= $${params.length}`); }
  if (range.to) { params.push(range.to); conds.push(`timestamp <= $${params.length}`); }
  if (q.username) { params.push(q.username); conds.push(`username = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`site_id = ANY($${params.length}::int[])`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await db.query(
    `SELECT timestamp, username, user_role, action, entity_type, entity_name, change_summary, result, ip_address
       FROM audit_log ${where}
      ORDER BY timestamp DESC LIMIT 5000`, params);
  const rows = r.rows.map(x => ({
    when: fmtDate(x.timestamp),
    user: x.username,
    action: String(x.action || '').toUpperCase(),
    entity: x.entity_type,
    name: x.entity_name || '—',
    summary: x.change_summary || '—',
    result: x.result,
    ip: x.ip_address || '—',
    _failed: x.result !== 'success',
  }));
  const byUser = {};
  rows.forEach(r => { byUser[r.user] = (byUser[r.user] || 0) + 1; });
  const topUser = Object.entries(byUser).sort((a, b) => b[1] - a[1])[0];
  return {
    columns: [
      { key: 'when', label: 'Timestamp', width: 110 },
      { key: 'user', label: 'User', width: 90 },
      { key: 'action', label: 'Action', width: 64 },
      { key: 'entity', label: 'Entity', width: 90 },
      { key: 'name', label: 'Name', width: 110 },
      { key: 'summary', label: 'Summary', width: 180 },
      { key: 'result', label: 'Result', width: 56, color: r => r._failed ? RED : GREEN },
    ],
    rows,
    summary: [
      { label: 'Total Changes', value: rows.length },
      { label: 'Unique Users', value: Object.keys(byUser).length },
      { label: 'Most Active', value: topUser ? `${topUser[0]} (${topUser[1]})` : '—' },
      { label: 'Failed Ops', value: rows.filter(r => r._failed).length, color: RED },
    ],
  };
}

async function reportRogueDevices(db, q, allowedSiteIds) {
  const range = resolveRange(q);
  const days = range.days != null ? range.days : 30;
  const params = [days];
  const conds = [`a.status = 'unknown'`];
  const siteId = intParam(q.site_id, 'site_id');
  if (siteId != null) { params.push(siteId); conds.push(`sn.site_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`sn.site_id = ANY($${params.length}::int[])`); }
  // Optional explicit window (Phase 1): device active within [from, to] by last_seen,
  // and first appeared on/before `to`.
  if (range.from) { params.push(range.from); conds.push(`a.last_seen >= $${params.length}`); }
  if (range.to) { params.push(range.to); conds.push(`a.created_at <= $${params.length}`); }
  const r = await db.query(
    `SELECT host(a.ip_address) AS ip, a.mac_address, a.hostname,
            host(sn.network) || '/' || sn.prefix_length AS subnet, sn.site,
            a.created_at AS first_seen, a.last_seen, a.ping_ms,
            (a.created_at > NOW() - ($1 || ' days')::interval) AS is_new
       FROM ipam_addresses a
       JOIN ipam_subnets sn ON sn.id = a.subnet_id
      WHERE ${conds.join(' AND ')}
      ORDER BY a.last_seen DESC NULLS LAST`, params);
  const rows = r.rows.map(x => ({
    ip: x.ip,
    mac: x.mac_address || '—',
    hostname: x.hostname || '—',
    subnet: x.subnet,
    site: x.site || '—',
    first_seen: fmtDate(x.first_seen),
    last_seen: fmtDate(x.last_seen),
    ping: x.ping_ms != null ? `${x.ping_ms} ms` : '—',
    _new: x.is_new,
  }));
  return {
    columns: [
      { key: 'ip', label: 'IP Address', width: 90 },
      { key: 'mac', label: 'MAC Address', width: 120 },
      { key: 'hostname', label: 'Hostname', width: 120 },
      { key: 'subnet', label: 'Subnet', width: 100 },
      { key: 'site', label: 'Site', width: 80 },
      { key: 'first_seen', label: 'First Seen', width: 110, color: r => r._new ? RED : null },
      { key: 'last_seen', label: 'Last Seen', width: 110 },
      { key: 'ping', label: 'Ping', width: 50, align: 'right' },
    ],
    rows,
    summary: [
      { label: 'Rogue Devices', value: rows.length, color: rows.length ? RED : GREEN },
      { label: `New (last ${days}d)`, value: rows.filter(r => r._new).length, color: YELLOW },
      { label: 'With Hostname', value: rows.filter(r => r.hostname !== '—').length },
    ],
  };
}

// ════════════════════════════════════════════════════════════
// TREND REPORTS (Phase 2) — return { columns, rows, summary, charts }
// Bucketed by day over the resolved range (default last 30 days).
// ════════════════════════════════════════════════════════════

async function reportDhcpUtilizationTrend(db, q, allowedSiteIds) {
  const range = resolveRange(q);

  const serverId = intParam(q.server_id, 'server_id');

  // Daily avg + peak across scopes (chart)
  const dp = [];
  const dc = [];
  if (serverId != null) { dp.push(serverId); dc.push(`sc.server_id = $${dp.length}`); }
  if (allowedSiteIds != null) { dp.push(allowedSiteIds); dc.push(`srv.site_id = ANY($${dp.length}::int[])`); }
  if (range.from) { dp.push(range.from); dc.push(`h.recorded_at >= $${dp.length}`); }
  else { dc.push(`h.recorded_at >= NOW() - INTERVAL '30 days'`); }
  if (range.to) { dp.push(range.to); dc.push(`h.recorded_at <= $${dp.length}`); }
  const dwhere = `WHERE ${dc.join(' AND ')}`;
  const daily = await db.query(
    `SELECT to_char(date_trunc('day', h.recorded_at), 'YYYY-MM-DD') AS day,
            ROUND(AVG(h.percent_used)::numeric, 1) AS avg_util,
            ROUND(MAX(h.percent_used)::numeric, 1) AS peak_util
       FROM dhcp_scope_history h
       JOIN dhcp_scopes sc ON sc.id = h.scope_id
       JOIN ddi_servers srv ON srv.id = sc.server_id
       ${dwhere}
      GROUP BY 1 ORDER BY 1`, dp);

  const x = daily.rows.map(d => d.day);
  const avgPts = daily.rows.map(d => (d.avg_util == null ? null : parseFloat(d.avg_util)));
  const peakPts = daily.rows.map(d => (d.peak_util == null ? null : parseFloat(d.peak_util)));

  // Per-scope table: current util + peak within range
  const sp = [];
  const sc = [];
  if (serverId != null) { sp.push(serverId); sc.push(`sc.server_id = $${sp.length}`); }
  if (allowedSiteIds != null) { sp.push(allowedSiteIds); sc.push(`srv.site_id = ANY($${sp.length}::int[])`); }
  let peakFrom = `h.recorded_at >= NOW() - INTERVAL '30 days'`;
  if (range.from) { sp.push(range.from); peakFrom = `h.recorded_at >= $${sp.length}`; }
  let peakTo = '';
  if (range.to) { sp.push(range.to); peakTo = ` AND h.recorded_at <= $${sp.length}`; }
  const swhere = sc.length ? `WHERE ${sc.join(' AND ')}` : '';
  const perScope = await db.query(
    `SELECT sc.scope_id, sc.name, srv.hostname AS server, sc.percent_used AS current_util,
            ROUND(MAX(CASE WHEN ${peakFrom}${peakTo} THEN h.percent_used END)::numeric, 1) AS peak_util
       FROM dhcp_scopes sc
       JOIN ddi_servers srv ON srv.id = sc.server_id
       LEFT JOIN dhcp_scope_history h ON h.scope_id = sc.id
       ${swhere}
      GROUP BY sc.id, sc.scope_id, sc.name, srv.hostname, sc.percent_used
      ORDER BY sc.percent_used DESC NULLS LAST`, sp);

  const rows = perScope.rows.map(r => ({
    scope: r.scope_id,
    name: r.name || '—',
    server: r.server,
    current: pct(r.current_util),
    peak: r.peak_util != null ? pct(r.peak_util) : '—',
    _util: parseFloat(r.current_util) || 0,
  }));

  const peakOverall = peakPts.reduce((m, p) => (p != null && p > m ? p : m), 0);
  const avgOverall = avgPts.length ? avgPts.filter(p => p != null).reduce((a, b) => a + b, 0) / Math.max(1, avgPts.filter(p => p != null).length) : 0;

  return {
    columns: [
      { key: 'scope', label: 'Scope', width: 100 },
      { key: 'name', label: 'Name', width: 130 },
      { key: 'server', label: 'Server', width: 120 },
      { key: 'current', label: 'Current', width: 70, align: 'right', color: r => r._util >= 90 ? RED : r._util >= 80 ? YELLOW : GREEN },
      { key: 'peak', label: 'Peak (range)', width: 80, align: 'right' },
    ],
    rows,
    summary: [
      { label: 'Scopes', value: rows.length },
      { label: 'Peak Utilization', value: pct(peakOverall), color: peakOverall >= 90 ? RED : peakOverall >= 80 ? YELLOW : GREEN },
      { label: 'Avg Utilization', value: pct(avgOverall) },
    ],
    charts: [{
      type: 'line',
      title: 'Daily DHCP Utilization (avg & peak across scopes)',
      x,
      series: [
        { label: 'Avg %', points: avgPts },
        { label: 'Peak %', points: peakPts },
      ],
      yFormat: 'percent',
    }],
  };
}

async function reportIpamGrowthTrend(db, q, allowedSiteIds) {
  const range = resolveRange(q);
  // ipam_utilization_history is a global, estate-wide aggregate with NO site
  // dimension, so it cannot be scoped to a site-restricted caller. Restrict the
  // report to full-visibility (super-admin/admin) users; scoped users get an
  // empty result with an explanatory summary rather than cross-site totals.
  if (allowedSiteIds != null) {
    return {
      columns: [
        { key: 'day', label: 'Date', width: 90 },
        { key: 'used', label: 'Used IPs', width: 90, align: 'right' },
        { key: 'free', label: 'Free IPs', width: 90, align: 'right' },
        { key: 'total', label: 'Total IPs', width: 90, align: 'right' },
        { key: 'util', label: 'Utilization', width: 80, align: 'right' },
      ],
      rows: [],
      summary: [{ label: 'Estate-wide report', value: 'Full access required' }],
      charts: [],
    };
  }
  const params = [];
  const conds = [];
  if (range.from) { params.push(range.from); conds.push(`recorded_at >= $${params.length}`); }
  else { conds.push(`recorded_at >= NOW() - INTERVAL '30 days'`); }
  if (range.to) { params.push(range.to); conds.push(`recorded_at <= $${params.length}`); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const daily = await db.query(
    `SELECT to_char(date_trunc('day', recorded_at), 'YYYY-MM-DD') AS day,
            ROUND(AVG(utilization_pct)::numeric, 1) AS util,
            ROUND(AVG(used_ips)::numeric, 0) AS used,
            ROUND(AVG(free_ips)::numeric, 0) AS free,
            ROUND(AVG(total_ips)::numeric, 0) AS total
       FROM ipam_utilization_history
       ${where}
      GROUP BY 1 ORDER BY 1`, params);

  const x = daily.rows.map(d => d.day);
  const utilPts = daily.rows.map(d => (d.util == null ? null : parseFloat(d.util)));
  const usedPts = daily.rows.map(d => (d.used == null ? null : parseInt(d.used)));
  const freePts = daily.rows.map(d => (d.free == null ? null : parseInt(d.free)));

  const rows = daily.rows.map(d => ({
    day: d.day,
    used: num(d.used),
    free: num(d.free),
    total: num(d.total),
    util: pct(d.util),
  }));

  const last = daily.rows[daily.rows.length - 1] || {};
  return {
    columns: [
      { key: 'day', label: 'Date', width: 90 },
      { key: 'used', label: 'Used IPs', width: 90, align: 'right' },
      { key: 'free', label: 'Free IPs', width: 90, align: 'right' },
      { key: 'total', label: 'Total IPs', width: 90, align: 'right' },
      { key: 'util', label: 'Utilization', width: 80, align: 'right' },
    ],
    rows,
    summary: [
      { label: 'Current Utilization', value: pct(last.util) },
      { label: 'Used IPs', value: num(last.used) },
      { label: 'Free IPs', value: num(last.free) },
    ],
    charts: [
      {
        type: 'area',
        title: 'IPAM Utilization Trend',
        x,
        series: [{ label: 'Utilization %', points: utilPts }],
        yFormat: 'percent',
      },
      {
        type: 'line',
        title: 'IP Address Growth (used vs free)',
        x,
        series: [
          { label: 'Used IPs', points: usedPts },
          { label: 'Free IPs', points: freePts },
        ],
        yFormat: 'number',
      },
    ],
  };
}

async function reportDnsQueryTrend(db, q, allowedSiteIds) {
  const range = resolveRange(q);
  const params = [];
  const conds = [];
  const serverId = intParam(q.server_id, 'server_id');
  if (serverId != null) { params.push(serverId); conds.push(`d.server_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`srv.site_id = ANY($${params.length}::int[])`); }
  if (range.from) { params.push(range.from); conds.push(`d.recorded_at >= $${params.length}`); }
  else { conds.push(`d.recorded_at >= NOW() - INTERVAL '30 days'`); }
  if (range.to) { params.push(range.to); conds.push(`d.recorded_at <= $${params.length}`); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const daily = await db.query(
    `SELECT to_char(date_trunc('day', d.recorded_at), 'YYYY-MM-DD') AS day,
            SUM(d.total_queries) AS total,
            SUM(d.nxdomain_count) AS nxdomain,
            ROUND(AVG(d.queries_per_sec)::numeric, 1) AS qps,
            ROUND(AVG(d.response_time_ms)::numeric, 1) AS resp_ms
       FROM dns_query_stats d
       JOIN ddi_servers srv ON srv.id = d.server_id
       ${where}
      GROUP BY 1 ORDER BY 1`, params);

  const x = daily.rows.map(d => d.day);
  const qpsPts = daily.rows.map(d => (d.qps == null ? null : parseFloat(d.qps)));
  const respPts = daily.rows.map(d => (d.resp_ms == null ? null : parseFloat(d.resp_ms)));
  const nxRatePts = daily.rows.map(d => {
    const t = parseInt(d.total) || 0;
    const nx = parseInt(d.nxdomain) || 0;
    return t > 0 ? Math.round((nx / t) * 1000) / 10 : null;
  });

  const rows = daily.rows.map((d, i) => ({
    day: d.day,
    total: num(d.total),
    qps: d.qps != null ? String(d.qps) : '—',
    nxdomain: num(d.nxdomain),
    nx_rate: nxRatePts[i] != null ? `${nxRatePts[i]}%` : '—',
    resp_ms: d.resp_ms != null ? `${d.resp_ms} ms` : '—',
  }));

  const totalQueries = daily.rows.reduce((a, d) => a + (parseInt(d.total) || 0), 0);
  const totalNx = daily.rows.reduce((a, d) => a + (parseInt(d.nxdomain) || 0), 0);
  const qpsVals = qpsPts.filter(p => p != null);
  const avgQps = qpsVals.length ? qpsVals.reduce((a, b) => a + b, 0) / qpsVals.length : 0;
  const avgNxRate = totalQueries > 0 ? (totalNx / totalQueries) * 100 : 0;

  return {
    columns: [
      { key: 'day', label: 'Date', width: 90 },
      { key: 'total', label: 'Total Queries', width: 100, align: 'right' },
      { key: 'qps', label: 'Avg QPS', width: 70, align: 'right' },
      { key: 'nxdomain', label: 'NXDOMAIN', width: 90, align: 'right' },
      { key: 'nx_rate', label: 'NXDOMAIN %', width: 80, align: 'right' },
      { key: 'resp_ms', label: 'Resp Time', width: 80, align: 'right' },
    ],
    rows,
    summary: [
      { label: 'Total Queries', value: totalQueries.toLocaleString() },
      { label: 'Avg QPS', value: avgQps.toFixed(1) },
      { label: 'Avg NXDOMAIN %', value: pct(avgNxRate), color: avgNxRate >= 10 ? YELLOW : GREEN },
    ],
    charts: [
      { type: 'line', title: 'DNS Query Rate (queries/sec)', x, series: [{ label: 'QPS', points: qpsPts }], yFormat: 'number' },
      { type: 'line', title: 'NXDOMAIN Rate', x, series: [{ label: 'NXDOMAIN %', points: nxRatePts, color: YELLOW }], yFormat: 'percent' },
      { type: 'line', title: 'Response Time', x, series: [{ label: 'Response', points: respPts, color: '#8b5cf6' }], yFormat: 'ms' },
    ],
  };
}

async function reportAlertAnomalyTrend(db, q, allowedSiteIds) {
  const range = resolveRange(q);
  const siteId = intParam(q.site_id, 'site_id');
  // A caller is "site scoped" when RBAC restricts them (allowedSiteIds set) OR they
  // picked an explicit site in the filter. In that mode the anomaly series is
  // suppressed (see below) and the alert series is filtered by site.
  const siteScoped = (allowedSiteIds != null) || (Number.isInteger(siteId));

  // ── Alerts per day — scoped to the caller's allowed sites (and an explicit
  //    site filter) via server_id -> ddi_servers.site_id. Alerts with a NULL
  //    server_id can't be attributed to a site and are excluded for scoped callers,
  //    which is the safe default (never leak another site's alert volume).
  const ap = [];
  const aconds = [];
  if (range.from) { ap.push(range.from); aconds.push(`fired_at >= $${ap.length}`); }
  else { aconds.push(`fired_at >= NOW() - INTERVAL '30 days'`); }
  if (range.to) { ap.push(range.to); aconds.push(`fired_at <= $${ap.length}`); }
  if (allowedSiteIds != null) { ap.push(allowedSiteIds); aconds.push(`server_id IN (SELECT id FROM ddi_servers WHERE site_id = ANY($${ap.length}::int[]))`); }
  if (Number.isInteger(siteId)) { ap.push(siteId); aconds.push(`server_id IN (SELECT id FROM ddi_servers WHERE site_id = $${ap.length})`); }
  const aw = aconds.join(' AND ');
  const alerts = await db.query(
    `SELECT to_char(date_trunc('day', fired_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS c
       FROM alert_events WHERE ${aw} GROUP BY 1`, ap);

  // MTTR + unresolved (same window + same site scoping)
  const mttr = await db.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - fired_at))) AS mttr_secs,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND acknowledged = FALSE)::int AS unresolved,
            COUNT(*)::int AS total
       FROM alert_events WHERE ${aw}`, ap);

  // ── Anomalies per day — anomaly_events has NO site linkage in the schema, so it
  //    cannot be attributed to a site. To avoid leaking estate-wide anomaly volume
  //    to a site-scoped caller (or misrepresenting an explicit single-site filter),
  //    anomalies are only included in the unscoped, no-site-filter view.
  const anomMap = {};
  if (!siteScoped) {
    const np = [];
    const nconds = [];
    if (range.from) { np.push(range.from); nconds.push(`detected_at >= $${np.length}`); }
    else { nconds.push(`detected_at >= NOW() - INTERVAL '30 days'`); }
    if (range.to) { np.push(range.to); nconds.push(`detected_at <= $${np.length}`); }
    const anomalies = await db.query(
      `SELECT to_char(date_trunc('day', detected_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS c
         FROM anomaly_events WHERE ${nconds.join(' AND ')} GROUP BY 1`, np);
    anomalies.rows.forEach(r => { anomMap[r.day] = r.c; });
  }

  const alertMap = {}; alerts.rows.forEach(r => { alertMap[r.day] = r.c; });
  const x = Array.from(new Set([...Object.keys(alertMap), ...Object.keys(anomMap)])).sort();
  const alertPts = x.map(d => alertMap[d] || 0);
  const anomPts = x.map(d => anomMap[d] || 0);

  const rows = x.map(d => {
    const row = { day: d, alerts: alertMap[d] || 0 };
    if (!siteScoped) row.anomalies = anomMap[d] || 0;
    return row;
  });

  const totalAlerts = alertPts.reduce((a, b) => a + b, 0);
  const totalAnoms = anomPts.reduce((a, b) => a + b, 0);
  const m = mttr.rows[0] || {};
  const mttrSecs = m.mttr_secs != null ? parseFloat(m.mttr_secs) : null;

  const columns = [
    { key: 'day', label: 'Date', width: 100 },
    { key: 'alerts', label: 'Alerts', width: 90, align: 'right' },
  ];
  if (!siteScoped) columns.push({ key: 'anomalies', label: 'Anomalies', width: 90, align: 'right' });

  const summary = [{ label: 'Total Alerts', value: totalAlerts, color: totalAlerts ? YELLOW : GREEN }];
  if (!siteScoped) summary.push({ label: 'Total Anomalies', value: totalAnoms, color: totalAnoms ? YELLOW : GREEN });
  summary.push({ label: 'MTTR', value: humanDuration(mttrSecs) });
  summary.push({ label: 'Unresolved', value: m.unresolved || 0, color: (m.unresolved || 0) > 0 ? RED : GREEN });

  const series = [{ label: 'Alerts', points: alertPts, color: RED }];
  if (!siteScoped) series.push({ label: 'Anomalies', points: anomPts, color: '#8b5cf6' });

  return {
    columns,
    rows,
    summary,
    charts: [{
      type: 'bar',
      title: siteScoped ? 'Alerts per Day (site-scoped)' : 'Alerts & Anomalies per Day',
      x,
      series,
      yFormat: 'number',
    }],
  };
}

async function reportSiteHealthTrend(db, q, allowedSiteIds) {
  const range = resolveRange(q);
  const params = [];
  const conds = [];
  const siteId = intParam(q.site_id, 'site_id');
  if (siteId != null) { params.push(siteId); conds.push(`site_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`site_id = ANY($${params.length}::int[])`); }
  if (range.from) { params.push(range.from); conds.push(`calculated_at >= $${params.length}`); }
  else { conds.push(`calculated_at >= NOW() - INTERVAL '30 days'`); }
  if (range.to) { params.push(range.to); conds.push(`calculated_at <= $${params.length}`); }
  const where = `WHERE ${conds.join(' AND ')}`;

  const daily = await db.query(
    `SELECT to_char(date_trunc('day', calculated_at), 'YYYY-MM-DD') AS day,
            ROUND(AVG(overall_score)::numeric, 0) AS overall,
            ROUND(AVG(dhcp_score)::numeric, 0) AS dhcp,
            ROUND(AVG(ipam_score)::numeric, 0) AS ipam,
            ROUND(AVG(dns_score)::numeric, 0) AS dns,
            ROUND(AVG(security_score)::numeric, 0) AS security
       FROM site_health_scores
       ${where}
      GROUP BY 1 ORDER BY 1`, params);

  const x = daily.rows.map(d => d.day);
  const mkPts = (k) => daily.rows.map(d => (d[k] == null ? null : parseFloat(d[k])));

  // Latest score per site (table)
  const latest = await db.query(
    `SELECT DISTINCT ON (site_id) site_id, site_name, overall_score, dhcp_score, ipam_score,
            dns_score, security_score, calculated_at
       FROM site_health_scores
       ${where}
      ORDER BY site_id, calculated_at DESC`, params);

  const scoreColor = (v) => v == null ? null : (v < 60 ? RED : v < 80 ? YELLOW : GREEN);
  const rows = latest.rows.map(r => ({
    site: r.site_name || `Site ${r.site_id}`,
    overall: num(r.overall_score),
    dhcp: num(r.dhcp_score),
    ipam: num(r.ipam_score),
    dns: num(r.dns_score),
    security: num(r.security_score),
    when: fmtDay(r.calculated_at),
    _overall: r.overall_score,
  }));

  const overalls = latest.rows.map(r => r.overall_score).filter(v => v != null);
  const avgOverall = overalls.length ? Math.round(overalls.reduce((a, b) => a + b, 0) / overalls.length) : 0;
  const worst = latest.rows.filter(r => r.overall_score != null).sort((a, b) => a.overall_score - b.overall_score)[0];

  return {
    columns: [
      { key: 'site', label: 'Site', width: 130 },
      { key: 'overall', label: 'Overall', width: 70, align: 'right', color: r => scoreColor(r._overall) },
      { key: 'dhcp', label: 'DHCP', width: 60, align: 'right' },
      { key: 'ipam', label: 'IPAM', width: 60, align: 'right' },
      { key: 'dns', label: 'DNS', width: 60, align: 'right' },
      { key: 'security', label: 'Security', width: 70, align: 'right' },
      { key: 'when', label: 'As Of', width: 90 },
    ],
    rows,
    summary: [
      { label: 'Sites Tracked', value: latest.rows.length },
      { label: 'Avg Overall', value: avgOverall, color: scoreColor(avgOverall) },
      { label: 'Worst Site', value: worst ? `${worst.site_name || `Site ${worst.site_id}`} (${worst.overall_score})` : '—', color: worst && worst.overall_score < 60 ? RED : YELLOW },
    ],
    charts: [{
      type: 'line',
      title: 'Site Health Score Trend',
      x,
      series: [
        { label: 'Overall', points: mkPts('overall'), color: NAVY },
        { label: 'DHCP', points: mkPts('dhcp') },
        { label: 'IPAM', points: mkPts('ipam') },
        { label: 'DNS', points: mkPts('dns') },
        { label: 'Security', points: mkPts('security') },
      ],
      yFormat: 'number',
    }],
  };
}

const REPORTS = {
  'subnet-utilization': { title: 'Subnet Utilization Report', gather: reportSubnetUtilization, landscape: true },
  'ip-inventory':       { title: 'IP Address Inventory Report', gather: reportIpInventory, landscape: true },
  'dhcp-health':        { title: 'DHCP Scope Health Report', gather: reportDhcpHealth, landscape: true },
  'dns-zones':          { title: 'DNS Zone Report', gather: reportDnsZones, landscape: true },
  'network-changes':    { title: 'Network Change Report', gather: reportNetworkChanges, landscape: true },
  'rogue-devices':      { title: 'Security / Rogue Device Report', gather: reportRogueDevices, landscape: true },
  'dhcp-utilization-trend': { title: 'DHCP Utilization Trend', gather: reportDhcpUtilizationTrend, landscape: true },
  'ipam-growth-trend':      { title: 'IPAM Growth Trend', gather: reportIpamGrowthTrend, landscape: true },
  'dns-query-trend':        { title: 'DNS Query Trend', gather: reportDnsQueryTrend, landscape: true },
  'alert-anomaly-trend':    { title: 'Alerts & Anomalies Trend', gather: reportAlertAnomalyTrend, landscape: true },
  'site-health-trend':      { title: 'Site Health Trend', gather: reportSiteHealthTrend, landscape: true },
};

// ════════════════════════════════════════════════════════════
// CSV RENDERER
// ════════════════════════════════════════════════════════════
function toCsv(columns, rows) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    // CSV/formula-injection guard: a cell that starts with = + - @ (or a leading
    // tab/CR) is treated as a formula by Excel/Sheets. Report cells include
    // network-sourced strings (hostnames, DNS records, device names), so neutralize
    // by prefixing a single quote before the normal quote-escaping below.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

// ════════════════════════════════════════════════════════════
// PDF RENDERER
// ════════════════════════════════════════════════════════════
// ── Cover page (single report) ───────────────────────────────
// `opts` carries the render payload plus a computed `generatedAt`.
function drawCover(doc, opts, layout) {
  const { title, company, generatedBy, dateRange, summary, rows, generatedAt } = opts;
  const { pageW, left, contentW } = layout;

  doc.rect(0, 0, pageW, 150).fill(NAVY);
  doc.rect(0, 150, pageW, 6).fill(RED);
  // logo placeholder
  doc.roundedRect(left, 44, 64, 64, 10).fill(RED);
  doc.fillColor('#fff').fontSize(30).font('Helvetica-Bold').text('N', left, 60, { width: 64, align: 'center' });
  doc.fillColor('#fff').fontSize(22).font('Helvetica-Bold').text('NocVault', left + 80, 56);
  doc.fillColor('#cbd5e1').fontSize(11).font('Helvetica').text('DDIVault — DNS · DHCP · IPAM', left + 80, 86);

  doc.fillColor(NAVY).fontSize(28).font('Helvetica-Bold').text(title, left, 230, { width: contentW });
  doc.moveTo(left, 274).lineTo(left + 120, 274).lineWidth(3).stroke(RED);

  const meta = [
    ['Company', company],
    ['Generated', generatedAt],
    ['Generated by', generatedBy || 'system'],
    ['Date range', dateRange || 'All time'],
    ['Records', String(rows.length)],
  ];
  let my = 310;
  doc.fontSize(11);
  meta.forEach(([k, v]) => {
    doc.fillColor(MUTED).font('Helvetica-Bold').text(k, left, my, { width: 120, continued: false });
    doc.fillColor('#0f172a').font('Helvetica').text(v, left + 130, my, { width: contentW - 130 });
    my += 24;
  });

  // summary chips on cover
  if (summary && summary.length) {
    my += 12;
    doc.fillColor(NAVY).fontSize(13).font('Helvetica-Bold').text('Summary', left, my);
    my += 22;
    let cx = left;
    const chipW = Math.min(150, (contentW - 30) / Math.max(summary.length, 1));
    summary.forEach(s => {
      doc.roundedRect(cx, my, chipW - 10, 52, 8).fillAndStroke(LIGHT, BORDER);
      doc.fillColor(s.color || NAVY).fontSize(18).font('Helvetica-Bold').text(String(s.value), cx + 10, my + 8, { width: chipW - 26 });
      doc.fillColor(MUTED).fontSize(8).font('Helvetica').text(s.label, cx + 10, my + 32, { width: chipW - 26 });
      cx += chipW;
    });
  }
}

// ── Charts (trend reports) ───────────────────────────────────
// Adds a page and draws each ChartSpec. No-op when there are no charts,
// so single-report output is unchanged.
function drawCharts(doc, opts, layout, o2 = {}) {
  const { charts } = opts;
  const { left, contentW, pageH } = layout;
  if (Array.isArray(charts) && charts.length) {
    let cy;
    // o2.continueOnPage: keep drawing on the current page (used by the compliance pack
    // so a section title isn't stranded on its own blank page). Default: fresh page
    // (single-report path — byte-identical to before).
    if (o2.continueOnPage) { cy = doc.y + 10; }
    else { doc.addPage(); cy = doc.page.margins.top; }
    const chartH = 150;
    const titleH = 18;
    for (const chart of charts) {
      if (cy + titleH + chartH > pageH - doc.page.margins.bottom) {
        doc.addPage();
        cy = doc.page.margins.top;
      }
      doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold')
        .text(chart.title || 'Trend', left, cy, { width: contentW });
      cy += titleH;
      drawChart(doc, left, cy, contentW, chartH, chart);
      cy += chartH + 24;
    }
  }
}

// ── Data table ───────────────────────────────────────────────
// Adds a page, then draws the zebra-striped table (recomputes its own
// column geometry from `opts.columns`, so it is reusable per section).
function drawTable(doc, opts, layout, o2 = {}) {
  const { columns, rows } = opts;
  const { left, contentW, pageH } = layout;
  // o2.continueOnPage: draw on the current page instead of a fresh one (pack sections
  // with no charts). Default: fresh page (single-report path — byte-identical).
  if (o2.continueOnPage) { doc.y = doc.y + 10; }
  else { doc.addPage(); }
  const rowH = 18;
  const headerH = 22;
  // scale column widths to content width
  const totalW = columns.reduce((a, c) => a + (c.width || 80), 0);
  const scale = contentW / totalW;
  const colX = [];
  let acc = left;
  columns.forEach(c => { colX.push(acc); acc += (c.width || 80) * scale; });

  function drawHeader() {
    const y = doc.y;
    doc.rect(left, y, contentW, headerH).fill(NAVY);
    doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
    columns.forEach((c, i) => {
      const w = (c.width || 80) * scale;
      doc.text(c.label, colX[i] + 4, y + 7, { width: w - 8, align: c.align || 'left', ellipsis: true });
    });
    doc.y = y + headerH;
  }

  drawHeader();
  doc.font('Helvetica').fontSize(8);
  rows.forEach((r, idx) => {
    if (doc.y + rowH > pageH - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
      doc.font('Helvetica').fontSize(8);
    }
    const y = doc.y;
    if (idx % 2 === 1) doc.rect(left, y, contentW, rowH).fill(LIGHT);
    columns.forEach((c, i) => {
      const w = (c.width || 80) * scale;
      const color = typeof c.color === 'function' ? (c.color(r) || '#1e293b') : '#1e293b';
      doc.fillColor(color).text(String(r[c.key] == null ? '' : r[c.key]), colX[i] + 4, y + 5, { width: w - 8, align: c.align || 'left', ellipsis: true, lineBreak: false });
    });
    doc.y = y + rowH;
  });

  if (rows.length === 0) {
    doc.fillColor(MUTED).fontSize(11).font('Helvetica-Oblique').text('No data matched the selected filters.', left, doc.y + 16, { width: contentW, align: 'center' });
  }
}

// ── Header / footer / page numbers on every buffered page ────
// Runs the bufferedPageRange loop; must be called before doc.end().
function stampHeadersFooters(doc, { title, company, generatedAt }) {
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const contentW = right - left;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (i > range.start) {
      // running header (skip cover)
      doc.fillColor(MUTED).fontSize(8).font('Helvetica')
        .text(`${title}`, left, 18, { width: contentW / 2, align: 'left' });
      doc.text(company, left + contentW / 2, 18, { width: contentW / 2, align: 'right' });
      doc.moveTo(left, 30).lineTo(right, 30).lineWidth(0.5).strokeColor(BORDER).stroke();
    }
    // footer
    doc.fillColor(MUTED).fontSize(8).font('Helvetica')
      .text(`Generated ${generatedAt}`, left, pageH - 26, { width: contentW / 2, align: 'left' });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + contentW / 2, pageH - 26, { width: contentW / 2, align: 'right' });
  }
}

// Build a fully-drawn single-report PDFDocument. Does NOT pipe or end() it —
// callers choose the sink (renderPdf → res, renderPdfToBuffer → Buffer).
function buildPdfDoc(opts) {
  const { title, company, landscape } = opts;
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true });

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const contentW = right - left;
  const generatedAt = new Date().toLocaleString('en-GB', { hour12: false });
  const layout = { pageW, pageH, left, right, contentW };
  const o = { ...opts, generatedAt };

  drawCover(doc, o, layout);
  drawCharts(doc, o, layout);
  drawTable(doc, o, layout);
  stampHeadersFooters(doc, { title, company, generatedAt });

  return doc;
}

function renderPdf(res, opts) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}"`);
  const doc = buildPdfDoc(opts);
  doc.pipe(res);
  doc.end();
}

// Off-request rendering — resolves to the full PDF as a Buffer.
function renderPdfToBuffer(opts) {
  return new Promise((resolve, reject) => {
    const doc = buildPdfDoc(opts);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ════════════════════════════════════════════════════════════
// OFF-REQUEST GENERATION (scheduler / emailer / multi-report pack)
// ════════════════════════════════════════════════════════════

// Runs a report's gather() and renders it to a deliverable payload — no req/res.
async function generateReport(db, { type, query = {}, allowedSiteIds = null, format = 'pdf', actor = 'system', company }) {
  const def = REPORTS[type];
  if (!def) throw new Error('Unknown report type: ' + type);
  query = expandRangePreset(query);   // rolling saved/scheduled window → concrete from/to
  const { columns, rows, summary, charts } = await def.gather(db, query, allowedSiteIds);
  const comp = company || await companyName(db);
  const dateRange = (query.from || query.to)
    ? `${query.from ? fmtDay(query.from) : '…'} → ${query.to ? fmtDay(query.to) : 'now'}`
    : (query.as_of ? `As of ${fmtDay(query.as_of)}` : 'All time');
  const stamp = Date.now();
  if (format === 'csv') {
    return { buffer: Buffer.from(toCsv(columns, rows), 'utf8'), contentType: 'text/csv', filename: `${type}-${stamp}.csv`, rowCount: rows.length, title: def.title };
  }
  const buffer = await renderPdfToBuffer({ title: def.title, company: comp, generatedBy: actor, dateRange, columns, rows, summary, charts, landscape: def.landscape, filename: `${type}-${stamp}.pdf` });
  return { buffer, contentType: 'application/pdf', filename: `${type}-${stamp}.pdf`, rowCount: rows.length, title: def.title };
}

// Draws several reports into ONE PDF: a pack cover, then each report as a section
// (its charts + table). allowedSiteIds=null for an estate-wide export.
async function generatePack(db, { types = [], query = {}, allowedSiteIds = null, actor = 'system', company, title = 'Compliance Pack' }) {
  query = expandRangePreset(query);   // rolling window → concrete from/to for all sections
  const comp = company || await companyName(db);
  const generatedAt = new Date().toLocaleString('en-GB', { hour12: false });
  const included = (Array.isArray(types) ? types : []).filter(t => REPORTS[t]);

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const contentW = right - left;
  const layout = { pageW, pageH, left, right, contentW };

  // ── Pack cover (reuses the single-report cover style) ────
  doc.rect(0, 0, pageW, 150).fill(NAVY);
  doc.rect(0, 150, pageW, 6).fill(RED);
  doc.roundedRect(left, 44, 64, 64, 10).fill(RED);
  doc.fillColor('#fff').fontSize(30).font('Helvetica-Bold').text('N', left, 60, { width: 64, align: 'center' });
  doc.fillColor('#fff').fontSize(22).font('Helvetica-Bold').text('NocVault', left + 80, 56);
  doc.fillColor('#cbd5e1').fontSize(11).font('Helvetica').text('DDIVault — DNS · DHCP · IPAM', left + 80, 86);

  doc.fillColor(NAVY).fontSize(28).font('Helvetica-Bold').text(title, left, 230, { width: contentW });
  doc.moveTo(left, 274).lineTo(left + 120, 274).lineWidth(3).stroke(RED);

  const meta = [
    ['Company', comp],
    ['Generated', generatedAt],
    ['Generated by', actor || 'system'],
    ['Reports', String(included.length)],
  ];
  let my = 310;
  doc.fontSize(11);
  meta.forEach(([k, v]) => {
    doc.fillColor(MUTED).font('Helvetica-Bold').text(k, left, my, { width: 120, continued: false });
    doc.fillColor('#0f172a').font('Helvetica').text(v, left + 130, my, { width: contentW - 130 });
    my += 24;
  });

  my += 12;
  doc.fillColor(NAVY).fontSize(13).font('Helvetica-Bold').text('Included reports', left, my);
  my += 22;
  doc.fontSize(11).font('Helvetica');
  if (included.length) {
    included.forEach((t, i) => {
      doc.fillColor('#0f172a').text(`${i + 1}.  ${REPORTS[t].title}`, left, my, { width: contentW });
      my += 20;
    });
  } else {
    doc.fillColor(MUTED).font('Helvetica-Oblique').text('No valid report types selected.', left, my, { width: contentW });
  }

  // ── One section per report ───────────────────────────────
  for (const type of included) {
    const def = REPORTS[type];
    doc.addPage();
    doc.fillColor(NAVY).fontSize(16).font('Helvetica-Bold').text(def.title, left, doc.page.margins.top, { width: contentW });
    doc.moveTo(left, doc.y + 4).lineTo(left + 120, doc.y + 4).lineWidth(2).stroke(RED);
    try {
      const { columns, rows, summary, charts } = await def.gather(db, query, allowedSiteIds);
      const o = { title: def.title, company: comp, columns, rows, summary, charts };
      const hasCharts = Array.isArray(charts) && charts.length > 0;
      // Charts (if any) continue on the section-title page; the table then flows on
      // (its own fresh page after charts, or the title page when there are no charts).
      drawCharts(doc, o, layout, { continueOnPage: true });
      drawTable(doc, o, layout, { continueOnPage: !hasCharts });
    } catch (err) {
      doc.fillColor(RED).fontSize(11).font('Helvetica-Oblique')
        .text(`This section failed to generate: ${err.message}`, left, doc.y + 16, { width: contentW });
    }
  }

  stampHeadersFooters(doc, { title, company: comp, generatedAt });

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
  return { buffer, contentType: 'application/pdf', filename: 'compliance-pack-' + Date.now() + '.pdf', title };
}

// ════════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════════
function createReportsRouter(db) {
  const router = express.Router();

  // List available reports (for the UI cards)
  router.get('/', (_req, res) => {
    res.json({
      data: Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title })),
    });
  });

  // ── Drill-down (Phase 3) ─────────────────────────────────
  // MUST be registered BEFORE '/:type' so it isn't shadowed.
  router.get('/drill/:entity/:id', attachSiteFilter, async (req, res) => {
    const entity = req.params.entity;
    const allowed = req.allowedSiteIds; // array or null (null = all sites)
    // Strict: entity ids are always positive integers (from a row's hidden _id).
    // Reject anything else ('5x', '', negatives) rather than letting parseInt coerce.
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const siteAllowed = (siteId) => allowed == null || (siteId != null && allowed.includes(siteId));
    try {
      if (entity === 'scope') {
        const q = await db.query(
          `SELECT sc.id, sc.scope_id, sc.name, sc.server_id, sc.in_use, sc.total_ips, sc.free,
                  sc.percent_used, sc.state, srv.hostname AS server, srv.site_id
             FROM dhcp_scopes sc JOIN ddi_servers srv ON srv.id = sc.server_id
            WHERE sc.id = $1`, [id]);
        if (!q.rows.length) return res.status(404).json({ error: 'Scope not found' });
        const s = q.rows[0];
        if (!siteAllowed(s.site_id)) return res.status(403).json({ error: 'Forbidden' });

        const util = parseFloat(s.percent_used) || 0;
        const h = await db.query(
          `SELECT to_char(date_trunc('day', recorded_at), 'YYYY-MM-DD') AS day,
                  ROUND(AVG(percent_used)::numeric, 1) AS util
             FROM dhcp_scope_history
            WHERE scope_id = $1 AND recorded_at > NOW() - INTERVAL '90 days'
            GROUP BY 1 ORDER BY 1`, [id]);
        const leases = await db.query(
          `SELECT host(ip_address) AS ip, mac_address, hostname, address_state, lease_expiry
             FROM dhcp_leases
            WHERE server_id = $1 AND scope_id = $2
            ORDER BY ip_address LIMIT 100`, [s.server_id, s.scope_id]);

        return res.json({
          title: `Scope ${s.scope_id}`,
          subtitle: s.name || undefined,
          facts: [
            { label: 'Name', value: s.name || '—' },
            { label: 'Server', value: s.server },
            { label: 'Current Utilization', value: pct(s.percent_used), color: util >= 90 ? RED : util >= 80 ? YELLOW : GREEN },
            { label: 'Used / Total', value: `${s.in_use || 0} / ${s.total_ips || 0}` },
            { label: 'State', value: s.state || '—' },
          ],
          charts: [{
            type: 'line',
            title: 'Scope Utilization (90 days)',
            x: h.rows.map(r => r.day),
            series: [{ label: 'Utilization %', points: h.rows.map(r => r.util == null ? null : parseFloat(r.util)) }],
            yFormat: 'percent',
          }],
          tables: [{
            title: `Active Leases (up to 100)`,
            columns: [
              { key: 'ip', label: 'IP Address', align: 'left' },
              { key: 'mac', label: 'MAC', align: 'left' },
              { key: 'hostname', label: 'Hostname', align: 'left' },
              { key: 'state', label: 'State', align: 'left' },
              { key: 'expiry', label: 'Expiry', align: 'left' },
            ],
            rows: leases.rows.map(l => ({
              ip: l.ip,
              mac: l.mac_address || '—',
              hostname: l.hostname || '—',
              state: l.address_state || '—',
              expiry: fmtDate(l.lease_expiry),
            })),
          }],
        });
      }

      if (entity === 'subnet') {
        const q = await db.query(
          `SELECT s.id, host(s.network) || '/' || s.prefix_length AS cidr, s.name, s.site, s.site_id,
                  s.total_hosts, s.used_hosts, s.free_hosts,
                  CASE WHEN s.total_hosts > 0 THEN ROUND(s.used_hosts::numeric * 100 / s.total_hosts, 1) ELSE 0 END AS util
             FROM ipam_subnets s WHERE s.id = $1`, [id]);
        if (!q.rows.length) return res.status(404).json({ error: 'Subnet not found' });
        const s = q.rows[0];
        if (!siteAllowed(s.site_id)) return res.status(403).json({ error: 'Forbidden' });
        const util = parseFloat(s.util) || 0;
        const addrs = await db.query(
          `SELECT host(ip_address) AS ip, hostname, mac_address, status, last_seen
             FROM ipam_addresses WHERE subnet_id = $1 ORDER BY ip_address LIMIT 200`, [id]);
        return res.json({
          title: s.cidr,
          subtitle: s.name || undefined,
          facts: [
            { label: 'CIDR', value: s.cidr },
            { label: 'Name', value: s.name || '—' },
            { label: 'Site', value: s.site || '—' },
            { label: 'Utilization', value: pct(s.util), color: util >= 90 ? RED : util >= 80 ? YELLOW : GREEN },
            { label: 'Used / Total', value: `${s.used_hosts || 0} / ${s.total_hosts || 0}` },
          ],
          tables: [{
            title: 'Addresses (up to 200)',
            columns: [
              { key: 'ip', label: 'IP Address', align: 'left' },
              { key: 'hostname', label: 'Hostname', align: 'left' },
              { key: 'mac', label: 'MAC', align: 'left' },
              { key: 'status', label: 'Status', align: 'left' },
              { key: 'last_seen', label: 'Last Seen', align: 'left' },
            ],
            rows: addrs.rows.map(a => ({
              ip: a.ip,
              hostname: a.hostname || '—',
              mac: a.mac_address || '—',
              status: a.status,
              last_seen: fmtDate(a.last_seen),
            })),
          }],
        });
      }

      if (entity === 'zone') {
        const q = await db.query(
          `SELECT z.id, z.zone_name, z.zone_type, z.is_reverse, z.record_count, srv.hostname AS server, srv.site_id
             FROM dns_zones z JOIN ddi_servers srv ON srv.id = z.server_id
            WHERE z.id = $1`, [id]);
        if (!q.rows.length) return res.status(404).json({ error: 'Zone not found' });
        const z = q.rows[0];
        if (!siteAllowed(z.site_id)) return res.status(403).json({ error: 'Forbidden' });
        const recs = await db.query(
          `SELECT hostname, record_type, record_data, ttl, last_seen
             FROM dns_records WHERE zone_id = $1 ORDER BY record_type, hostname LIMIT 200`, [id]);
        const staleCount = await db.query(
          `SELECT COUNT(*)::int AS c FROM dns_records
            WHERE zone_id = $1 AND last_seen < NOW() - INTERVAL '90 days'`, [id]);
        return res.json({
          title: z.zone_name,
          subtitle: z.server,
          facts: [
            { label: 'Zone', value: z.zone_name },
            { label: 'Server', value: z.server },
            { label: 'Type', value: z.zone_type || (z.is_reverse ? 'Reverse' : 'Primary') },
            { label: 'Records', value: num(z.record_count) },
            { label: 'Stale (90d+)', value: (staleCount.rows[0] && staleCount.rows[0].c) || 0, color: (staleCount.rows[0] && staleCount.rows[0].c) > 0 ? YELLOW : GREEN },
          ],
          tables: [{
            title: 'Records (up to 200)',
            columns: [
              { key: 'name', label: 'Name', align: 'left' },
              { key: 'type', label: 'Type', align: 'left' },
              { key: 'data', label: 'Data', align: 'left' },
              { key: 'ttl', label: 'TTL', align: 'right' },
            ],
            rows: recs.rows.map(r => ({
              name: r.hostname,
              type: r.record_type,
              data: r.record_data || '—',
              ttl: r.ttl == null ? '—' : String(r.ttl),
            })),
          }],
        });
      }

      return res.status(404).json({ error: 'Unknown entity' });
    } catch (err) {
      console.error(`[Reports] drill ${entity} error:`, err.message);
      // Log the detail server-side only; do NOT return err.message to the client
      // (it can carry raw Postgres text — table/constraint names, etc.).
      res.status(500).json({ error: 'Drill failed' });
    }
  });

  router.get('/:type', attachSiteFilter, async (req, res) => {
    const def = REPORTS[req.params.type];
    if (!def) return res.status(404).json({ error: 'Unknown report type' });
    const format = (req.query.format || 'json').toLowerCase();
    try {
      const query = expandRangePreset(req.query);   // rolling saved-view window → concrete from/to
      const { columns, rows, summary, charts, drill } = await def.gather(db, query, req.allowedSiteIds);
      const safeCols = columns.map(c => ({ key: c.key, label: c.label, align: c.align || 'left' }));

      // Best-effort audit of manual downloads to report_run_history. A logging
      // failure must NEVER break the actual export, so this is wrapped + swallowed.
      const logRun = async (fmt) => {
        try {
          await db.query(
            `INSERT INTO report_run_history (report_type, format, params, row_count, status, trigger_type, generated_by)
             VALUES ($1, $2, $3::jsonb, $4, 'success', 'manual', $5)`,
            [req.params.type, fmt, JSON.stringify(req.query), rows.length, req.headers['x-ddi-actor'] || 'system']);
        } catch (e) {
          console.error(`[Reports] run-history log failed:`, e.message);
        }
      };

      if (format === 'csv') {
        await logRun('csv');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-${Date.now()}.csv"`);
        return res.send(toCsv(columns, rows));
      }
      if (format === 'pdf') {
        const company = await companyName(db);
        const actor = req.headers['x-ddi-actor'] || 'system';
        const dateRange = query.from || query.to
          ? `${query.from ? fmtDay(query.from) : '…'} → ${query.to ? fmtDay(query.to) : 'now'}`
          : (query.as_of ? `As of ${fmtDay(query.as_of)}` : 'All time');
        await logRun('pdf');
        if (req.audit) req.audit({ action: 'export', entity_type: 'report', entity_name: def.title, change_summary: `Exported "${def.title}" as PDF (${rows.length} rows)` });
        return renderPdf(res, {
          title: def.title, company, generatedBy: actor, dateRange,
          columns, rows, summary, charts, landscape: def.landscape,
          filename: `${req.params.type}-${Date.now()}.pdf`,
        });
      }
      // json (default — used by the preview panel)
      res.json({ title: def.title, columns: safeCols, rows, summary, charts, drill });
    } catch (err) {
      // Malformed time-period / numeric params are validated up front (before any
      // query runs) → answer with a clean 400 and a generic message, never leaking
      // the raw DB error via the 500 path below.
      if (err instanceof BadRequestError) return res.status(400).json({ error: err.message });
      console.error(`[Reports] ${req.params.type} error:`, err.message);
      // For the PDF path renderPdf() has already set headers and piped the doc, so a
      // mid-render throw can't be answered with a 500 JSON — that would emit a second
      // set of headers (ERR_HTTP_HEADERS_SENT). Just tear the stream down cleanly.
      if (res.headersSent) { try { res.end(); } catch { /* stream already gone */ } return; }
      // Detail logged above; return a generic message so raw DB error text is not
      // disclosed to the client.
      res.status(500).json({ error: 'Report generation failed' });
    }
  });

  return router;
}

module.exports = { createReportsRouter, REPORTS, generateReport, generatePack };
