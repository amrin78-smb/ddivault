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

// ════════════════════════════════════════════════════════════
// REPORT DEFINITIONS — each returns { columns, rows, summary }
// columns: [{ key, label, width, align, color? }]
// ════════════════════════════════════════════════════════════

async function reportSubnetUtilization(db, q, allowedSiteIds) {
  const params = [];
  const conds = [];
  if (q.site_id) { params.push(parseInt(q.site_id)); conds.push(`s.site_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`s.site_id = ANY($${params.length}::int[])`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await db.query(
    `SELECT s.id, host(s.network) AS network, s.prefix_length, s.name, s.site,
            s.total_hosts, s.used_hosts, s.free_hosts, s.unknown_hosts, s.last_scanned,
            CASE WHEN s.total_hosts > 0 THEN ROUND(s.used_hosts::numeric * 100 / s.total_hosts, 1) ELSE 0 END AS util
       FROM ipam_subnets s ${where}
      ORDER BY util DESC NULLS LAST`, params);

  const rows = r.rows.map(x => ({
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
  };
}

async function reportIpInventory(db, q, allowedSiteIds) {
  const params = [];
  const conds = [];
  if (q.subnet_id) { params.push(parseInt(q.subnet_id)); conds.push(`a.subnet_id = $${params.length}`); }
  if (q.status) { params.push(q.status); conds.push(`a.status = $${params.length}`); }
  if (q.site_id) { params.push(parseInt(q.site_id)); conds.push(`sn.site_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`sn.site_id = ANY($${params.length}::int[])`); }
  const staleDays = parseInt(q.stale_days || '30');
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
  const params = [];
  const conds = [];
  if (q.server_id) { params.push(parseInt(q.server_id)); conds.push(`sc.server_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`srv.site_id = ANY($${params.length}::int[])`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await db.query(
    `SELECT sc.id, sc.scope_id, sc.name, sc.in_use, sc.total_ips, sc.free, sc.percent_used, sc.state,
            srv.hostname AS server, srv.poll_status, srv.health_score
       FROM dhcp_scopes sc
       JOIN ddi_servers srv ON srv.id = sc.server_id
       ${where}
      ORDER BY sc.percent_used DESC`, params);

  // peak + forecast from history
  const ids = r.rows.map(x => x.id);
  const histMap = {};
  if (ids.length) {
    const h = await db.query(
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
  };
}

async function reportDnsZones(db, q, allowedSiteIds) {
  const params = [];
  const conds = [];
  if (q.server_id) { params.push(parseInt(q.server_id)); conds.push(`z.server_id = $${params.length}`); }
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
  };
}

async function reportNetworkChanges(db, q, allowedSiteIds) {
  const params = [];
  const conds = [];
  if (q.from) { params.push(q.from); conds.push(`timestamp >= $${params.length}`); }
  if (q.to) { params.push(q.to); conds.push(`timestamp <= $${params.length}`); }
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
  const days = parseInt(q.days || '30');
  const params = [days];
  const conds = [`a.status = 'unknown'`];
  if (q.site_id) { params.push(parseInt(q.site_id)); conds.push(`sn.site_id = $${params.length}`); }
  if (allowedSiteIds != null) { params.push(allowedSiteIds); conds.push(`sn.site_id = ANY($${params.length}::int[])`); }
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

const REPORTS = {
  'subnet-utilization': { title: 'Subnet Utilization Report', gather: reportSubnetUtilization, landscape: true },
  'ip-inventory':       { title: 'IP Address Inventory Report', gather: reportIpInventory, landscape: true },
  'dhcp-health':        { title: 'DHCP Scope Health Report', gather: reportDhcpHealth, landscape: true },
  'dns-zones':          { title: 'DNS Zone Report', gather: reportDnsZones, landscape: true },
  'network-changes':    { title: 'Network Change Report', gather: reportNetworkChanges, landscape: true },
  'rogue-devices':      { title: 'Security / Rogue Device Report', gather: reportRogueDevices, landscape: true },
};

// ════════════════════════════════════════════════════════════
// CSV RENDERER
// ════════════════════════════════════════════════════════════
function toCsv(columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

// ════════════════════════════════════════════════════════════
// PDF RENDERER
// ════════════════════════════════════════════════════════════
function renderPdf(res, { title, company, generatedBy, dateRange, columns, rows, summary, landscape, filename }) {
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const contentW = right - left;
  const generatedAt = new Date().toLocaleString('en-GB', { hour12: false });

  // ── Cover page ───────────────────────────────────────────
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

  // ── Data table ───────────────────────────────────────────
  doc.addPage();
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

  // ── Header / footer / page numbers on every page ─────────
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

  doc.end();
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

  router.get('/:type', attachSiteFilter, async (req, res) => {
    const def = REPORTS[req.params.type];
    if (!def) return res.status(404).json({ error: 'Unknown report type' });
    const format = (req.query.format || 'json').toLowerCase();
    try {
      const { columns, rows, summary } = await def.gather(db, req.query, req.allowedSiteIds);
      const safeCols = columns.map(c => ({ key: c.key, label: c.label, align: c.align || 'left' }));

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-${Date.now()}.csv"`);
        return res.send(toCsv(columns, rows));
      }
      if (format === 'pdf') {
        const company = await companyName(db);
        const actor = req.headers['x-ddi-actor'] || 'system';
        const dateRange = req.query.from || req.query.to
          ? `${req.query.from ? fmtDay(req.query.from) : '…'} → ${req.query.to ? fmtDay(req.query.to) : 'now'}`
          : 'All time';
        if (req.audit) req.audit({ action: 'export', entity_type: 'report', entity_name: def.title, change_summary: `Exported "${def.title}" as PDF (${rows.length} rows)` });
        return renderPdf(res, {
          title: def.title, company, generatedBy: actor, dateRange,
          columns, rows, summary, landscape: def.landscape,
          filename: `${req.params.type}-${Date.now()}.pdf`,
        });
      }
      // json (default — used by the preview panel)
      res.json({ title: def.title, columns: safeCols, rows, summary });
    } catch (err) {
      console.error(`[Reports] ${req.params.type} error:`, err.message);
      res.status(500).json({ error: 'Report generation failed', detail: err.message });
    }
  });

  return router;
}

module.exports = { createReportsRouter, REPORTS };
