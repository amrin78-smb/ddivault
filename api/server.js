'use strict';

/**
 * server.js — DDIVault REST API
 * Port: 3007 (internal, localhost only — frontend proxies /api/* here)
 *
 * CRITICAL: This is plain JavaScript. NO TypeScript syntax allowed.
 * No "as string", no ": string[]", no type annotations.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

// ── Crash resilience ─────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const app  = express();
const PORT = parseInt(process.env.DDI_API_PORT || '3007');

// ── Database ─────────────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DDI_DB_NAME || 'ddivault',
  user:     process.env.DDI_DB_USER || 'ddivault_user',
  password: process.env.DDI_DB_PASS || '',
  max: 10,
  idleTimeoutMillis: 30000,
});

db.on('error', (err) => console.error('[DB] Pool error:', err.message));

// ── Enterprise modules ────────────────────────────────────────
const { auditContext } = require('./middleware/audit');
const { generateKey, maskedDisplay } = require('./middleware/apiAuth');
const { requireWrite, requireSuperAdmin, attachSiteFilter } = require('./middleware/rbac');
const { createReportsRouter } = require('./reports');
const { createV1Router } = require('./v1');
const { getLicense, getLicenseState } = require('./licenseCheck');
const emailer = require('./emailer');
const alertDispatcher = require('./alertDispatcher');

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: 'http://localhost:3006', exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'] }));
app.use(express.json());

// Audit context — attaches req.audit() + auto-fallback for mutating routes
app.use(auditContext(db));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Input validation helpers ──────────────────────────────────
function safeInt(val, def, max) {
  const n = parseInt(val || def);
  if (isNaN(n) || n <= 0) return def;
  return max ? Math.min(n, max) : n;
}

function safeHours(val, max) {
  return safeInt(val, 24, max || 720);
}

function safePage(val) {
  return safeInt(val, 1);
}

function safeLimit(val) {
  return safeInt(val, 50, 500);
}

// ── License enforcement ───────────────────────────────────────
async function enforceLicense(req, res, next) {
  const license = await getLicense();
  const state   = getLicenseState(license);
  req.licenseState = state;
  req.license      = license;

  // Block writes during grace/disabled (except acknowledge endpoints)
  if (!state.canWrite && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const isAck = req.method === 'POST'
      && (req.path.startsWith('/api/alerts') || req.path.startsWith('/api/anomalies'))
      && (req.path.includes('acknowledge') || req.path.includes('/ack'));
    if (!isAck) {
      return res.status(402).json({
        error: 'License expired — write operations disabled',
        license_status: license?.status,
        days_remaining: license?.daysRemaining,
        renew_url: `${process.env.NOCVAULT_HUB_URL || ''}/settings/license`,
      });
    }
  }

  // Block all access when fully disabled (health + license-status always allowed)
  if (state.disabled && !req.path.startsWith('/api/health') && !req.path.startsWith('/api/license-status')) {
    return res.status(402).json({
      error: 'DDIVault license has expired. Please renew your NocVault license.',
      license_status: license?.status,
      renew_url: `${process.env.NOCVAULT_HUB_URL || ''}/settings/license`,
    });
  }
  next();
}

app.get('/api/license-status', async (req, res) => {
  const license = await getLicense();
  const state   = getLicenseState(license);
  res.json({ license, state });
});

app.use(enforceLicense);

// ── Health ────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW() as ts');
    res.json({ status: 'ok', db: 'connected', time: result.rows[0].ts, version: '1.0.0' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// ── Dashboard Stats ───────────────────────────────────────────
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [scopes, leases, zones, alerts] = await Promise.all([
      db.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE percent_used >= 90) as critical, COUNT(*) FILTER (WHERE percent_used >= 80 AND percent_used < 90) as warning FROM dhcp_scopes'),
      db.query("SELECT COUNT(*) as total FROM dhcp_leases WHERE address_state = 'Active'"),
      db.query('SELECT COUNT(*) as total FROM dns_zones'),
      db.query("SELECT COUNT(*) as total FROM alert_events WHERE acknowledged = FALSE"),
    ]);

    const scopeRow   = scopes.rows[0];
    const totalIPs   = await db.query('SELECT COALESCE(SUM(total_ips),0) as total, COALESCE(SUM(free),0) as free, COALESCE(SUM(in_use),0) as in_use FROM dhcp_scopes');
    const ipRow      = totalIPs.rows[0];

    res.json({
      scopes: {
        total:    parseInt(scopeRow.total),
        critical: parseInt(scopeRow.critical),
        warning:  parseInt(scopeRow.warning),
      },
      ips: {
        total:  parseInt(ipRow.total),
        in_use: parseInt(ipRow.in_use),
        free:   parseInt(ipRow.free),
      },
      active_leases:    parseInt(leases.rows[0].total),
      dns_zones:        parseInt(zones.rows[0].total),
      unacked_alerts:   parseInt(alerts.rows[0].total),
    });
  } catch (err) {
    console.error('[API] dashboard/stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Recent DHCP events for dashboard widget
app.get('/api/dashboard/recent-events', async (req, res) => {
  try {
    const limit = safeLimit(req.query.limit);
    const rows = await db.query(
      `SELECT e.id, e.event_id, e.event_type, e.ip_address, e.hostname,
              e.mac_address, e.description, e.event_time,
              s.hostname as server_hostname
       FROM dhcp_events e
       LEFT JOIN ddi_servers s ON s.id = e.server_id
       ORDER BY e.event_time DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] recent-events error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DHCP Scopes ───────────────────────────────────────────────
app.get('/api/scopes', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `WHERE srv.site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const rows = await db.query(
      `SELECT sc.*, srv.hostname as server_hostname, srv.ip_address as server_ip
       FROM dhcp_scopes sc
       LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       ${siteFilter}
       ORDER BY sc.percent_used DESC, sc.scope_id`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] scopes error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/scopes/:scopeId/history', async (req, res) => {
  try {
    const { scopeId } = req.params;
    const hours = safeHours(req.query.hours);

    const scope = await db.query('SELECT id FROM dhcp_scopes WHERE scope_id = $1 LIMIT 1', [scopeId]);
    if (!scope.rows.length) return res.status(404).json({ error: 'Scope not found' });

    const rows = await db.query(
      `SELECT in_use, free, percent_used, recorded_at
       FROM dhcp_scope_history
       WHERE scope_id = $1
         AND recorded_at > NOW() - make_interval(hours => $2)
       ORDER BY recorded_at ASC`,
      [scope.rows[0].id, hours]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] scope history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/scopes/:scopeId/leases', async (req, res) => {
  try {
    const { scopeId } = req.params;
    const page  = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const offset = (page - 1) * limit;

    const count = await db.query(
      'SELECT COUNT(*) as total FROM dhcp_leases WHERE scope_id = $1',
      [scopeId]
    );
    const rows = await db.query(
      `SELECT * FROM dhcp_leases
       WHERE scope_id = $1
       ORDER BY ip_address
       LIMIT $2 OFFSET $3`,
      [scopeId, limit, offset]
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] scope leases error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DHCP Scope Management (write operations) ──────────────────
// Helpers
const okCheck = r => typeof r === 'string' && r.includes('ok');
const scopeIdStr = v => v == null ? '' : (typeof v === 'object' ? String(v.IPAddressToString || v.Address || '') : String(v));

async function getScopeRow(scopeId, serverId) {
  const q = serverId
    ? await db.query('SELECT * FROM dhcp_scopes WHERE scope_id=$1 AND server_id=$2 LIMIT 1', [scopeId, parseInt(serverId)])
    : await db.query('SELECT * FROM dhcp_scopes WHERE scope_id=$1 LIMIT 1', [scopeId]);
  return q.rows[0] || null;
}

// 1. Create a DHCP scope
app.post('/api/scopes', requireWrite, async (req, res) => {
  try {
    const { server_id, name, startRange, endRange, subnetMask, description, leaseDuration, state, dnsServers, gateway, domainName } = req.body;
    if (!server_id || !name || !startRange || !endRange || !subnetMask) {
      return res.status(400).json({ error: 'server_id, name, startRange, endRange, subnetMask required' });
    }

    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const created = psWrite.createDhcpScope(ip, auth, { name, startRange, endRange, subnetMask, description, leaseDuration, state });
    if (!created) {
      return res.status(500).json({ error: 'Scope creation failed — check WinRM/DHCP role' });
    }

    let scopeId = scopeIdStr(created.ScopeId);
    if (!scopeId) scopeId = scopeIdStr(created);
    if (!scopeId) scopeId = String(startRange);

    // Apply scope options (best-effort — failures don't fail the create)
    if (dnsServers) {
      try {
        const dnsArray = String(dnsServers).split(',').map(s => s.trim()).filter(Boolean);
        if (dnsArray.length) psWrite.setDhcpScopeOption(ip, auth, scopeId, 6, dnsArray);
      } catch (e) { console.error('[API] scope option DNS error:', e.message); }
    }
    if (gateway) {
      try { psWrite.setDhcpScopeOption(ip, auth, scopeId, 3, [gateway]); }
      catch (e) { console.error('[API] scope option gateway error:', e.message); }
    }
    if (domainName) {
      try { psWrite.setDhcpScopeOption(ip, auth, scopeId, 15, [domainName]); }
      catch (e) { console.error('[API] scope option domain error:', e.message); }
    }

    const stateStr = state === 'InActive' ? 'InActive' : 'Active';
    await db.query(
      `INSERT INTO dhcp_scopes (server_id, scope_id, name, start_range, end_range, subnet_mask, state, lease_duration, total_ips, in_use, free, reserved, pending, percent_used, description, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,0,0,0,0,$9,NOW())
       ON CONFLICT (server_id, scope_id) DO UPDATE SET name=EXCLUDED.name, start_range=EXCLUDED.start_range, end_range=EXCLUDED.end_range, subnet_mask=EXCLUDED.subnet_mask, state=EXCLUDED.state, lease_duration=EXCLUDED.lease_duration, description=EXCLUDED.description, last_updated=NOW()`,
      [parseInt(server_id), scopeId, name, startRange, endRange, subnetMask, stateStr, leaseDuration || null, description || null]
    );

    if (req.audit) req.audit({ action: 'create', entity_type: 'dhcp_scope', entity_name: name, server_id: parseInt(server_id), change_summary: `Created DHCP scope ${name} (${scopeId})` });

    res.json({ success: true, data: { scope_id: scopeId, server_id: parseInt(server_id), name, start_range: startRange, end_range: endRange, subnet_mask: subnetMask, state: stateStr } });
  } catch (err) {
    console.error('[API] create scope error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Edit a DHCP scope
app.put('/api/scopes/:scopeId', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const { server_id, name, description, leaseDuration, state } = req.body;

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.editDhcpScope(ip, auth, scopeId, { name, description, leaseDuration, state });
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Scope update failed — check WinRM/DHCP role' });
    }

    const sets = [];
    const vals = [];
    if (name !== undefined)          { vals.push(name);          sets.push(`name=$${vals.length}`); }
    if (description !== undefined)    { vals.push(description);   sets.push(`description=$${vals.length}`); }
    if (leaseDuration !== undefined) { vals.push(leaseDuration); sets.push(`lease_duration=$${vals.length}`); }
    if (state !== undefined)         { vals.push(state);         sets.push(`state=$${vals.length}`); }
    if (sets.length) {
      sets.push('last_updated=NOW()');
      vals.push(scopeRow.id);
      await db.query(`UPDATE dhcp_scopes SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    }

    if (req.audit) req.audit({ action: 'modify', entity_type: 'dhcp_scope', entity_name: name || scopeRow.name, server_id: scopeRow.server_id, change_summary: `Edited DHCP scope ${scopeId}` });

    res.json({ success: true });
  } catch (err) {
    console.error('[API] edit scope error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Set scope state (Active / InActive)
app.patch('/api/scopes/:scopeId/state', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const { state, server_id } = req.body;
    if (state !== 'Active' && state !== 'InActive') {
      return res.status(400).json({ error: "state must be 'Active' or 'InActive'" });
    }

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.setScopeState(ip, auth, scopeId, state);
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Scope state change failed — check WinRM/DHCP role' });
    }

    await db.query('UPDATE dhcp_scopes SET state=$1, last_updated=NOW() WHERE id=$2', [state, scopeRow.id]);

    if (req.audit) req.audit({ action: 'modify', entity_type: 'dhcp_scope', entity_name: scopeRow.name, server_id: scopeRow.server_id, change_summary: `Set DHCP scope ${scopeId} state to ${state}` });

    res.json({ success: true, state });
  } catch (err) {
    console.error('[API] scope state error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Delete a DHCP scope
app.delete('/api/scopes/:scopeId', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const server_id = req.body.server_id || req.query.server_id;

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.deleteDhcpScope(ip, auth, scopeId);
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Scope deletion failed — check WinRM/DHCP role' });
    }

    await db.query('DELETE FROM dhcp_leases WHERE server_id=$1 AND scope_id=$2', [scopeRow.server_id, scopeId]);
    await db.query('DELETE FROM dhcp_scopes WHERE id=$1', [scopeRow.id]);

    if (req.audit) req.audit({ action: 'delete', entity_type: 'dhcp_scope', entity_name: scopeRow.name, server_id: scopeRow.server_id, change_summary: `Deleted DHCP scope ${scopeId}` });

    res.json({ success: true });
  } catch (err) {
    console.error('[API] delete scope error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Get scope options (read)
app.get('/api/scopes/:scopeId/options', async (req, res) => {
  try {
    const { scopeId } = req.params;
    const scopeRow = await getScopeRow(scopeId, req.query.server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const opts = psWrite.getDhcpScopeOptions(ip, auth, scopeId);
    res.json({ data: Array.isArray(opts) ? opts : (opts ? [opts] : []) });
  } catch (err) {
    console.error('[API] scope options get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. Set a scope option
app.post('/api/scopes/:scopeId/options', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const { optionId, values, server_id } = req.body;
    if (optionId === undefined || optionId === null || isNaN(parseInt(optionId))) {
      return res.status(400).json({ error: 'optionId (number) required' });
    }
    if (!Array.isArray(values) || values.length === 0) {
      return res.status(400).json({ error: 'values must be a non-empty array' });
    }

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.setDhcpScopeOption(ip, auth, scopeId, parseInt(optionId), values);
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Setting scope option failed — check WinRM/DHCP role' });
    }

    if (req.audit) req.audit({ action: 'modify', entity_type: 'dhcp_scope', entity_name: scopeRow.name, server_id: scopeRow.server_id, change_summary: `Set option ${optionId} on DHCP scope ${scopeId}` });

    res.json({ success: true });
  } catch (err) {
    console.error('[API] set scope option error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. Get scope exclusions (read)
app.get('/api/scopes/:scopeId/exclusions', async (req, res) => {
  try {
    const { scopeId } = req.params;
    const scopeRow = await getScopeRow(scopeId, req.query.server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const ex = psWrite.getDhcpExclusions(ip, auth, scopeId);
    res.json({ data: Array.isArray(ex) ? ex : (ex ? [ex] : []) });
  } catch (err) {
    console.error('[API] scope exclusions get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 8. Add a scope exclusion
app.post('/api/scopes/:scopeId/exclusions', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const { startRange, endRange, server_id } = req.body;
    if (!startRange || !endRange) {
      return res.status(400).json({ error: 'startRange and endRange required' });
    }

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.addDhcpExclusion(ip, auth, scopeId, startRange, endRange);
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Adding exclusion failed — check WinRM/DHCP role' });
    }

    if (req.audit) req.audit({ action: 'create', entity_type: 'dhcp_scope', entity_name: scopeRow.name, server_id: scopeRow.server_id, change_summary: `Added exclusion ${startRange}-${endRange} on DHCP scope ${scopeId}` });

    res.json({ success: true });
  } catch (err) {
    console.error('[API] add exclusion error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Leases ────────────────────────────────────────────────────
app.get('/api/leases', async (req, res) => {
  try {
    const page    = safePage(req.query.page);
    const limit   = safeLimit(req.query.limit);
    const offset  = (page - 1) * limit;
    const search  = (req.query.search || '').trim();
    const scopeId = (req.query.scope  || '').trim();
    const state   = (req.query.state  || '').trim();

    const params  = [];
    const where   = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(l.ip_address::text ILIKE $${params.length} OR l.hostname ILIKE $${params.length} OR l.mac_address ILIKE $${params.length})`);
    }
    if (scopeId) {
      params.push(scopeId);
      where.push(`l.scope_id = $${params.length}`);
    }
    if (state) {
      params.push(state);
      where.push(`l.address_state = $${params.length}`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countParams = [...params];
    const count = await db.query(
      `SELECT COUNT(*) as total FROM dhcp_leases l ${whereClause}`,
      countParams
    );

    params.push(limit, offset);
    const rows = await db.query(
      `SELECT l.*, s.hostname as server_hostname
       FROM dhcp_leases l
       LEFT JOIN ddi_servers s ON s.id = l.server_id
       ${whereClause}
       ORDER BY l.ip_address
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] leases error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/leases/ip/:ip/history', async (req, res) => {
  try {
    const ip = req.params.ip;
    const rows = await db.query(
      `SELECT * FROM lease_history
       WHERE ip_address = $1
       ORDER BY event_time DESC
       LIMIT 200`,
      [ip]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] lease IP history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export leases as CSV
app.get('/api/leases/export', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT ip_address, hostname, mac_address, scope_id, address_state,
              lease_start, lease_expiry, last_seen
       FROM dhcp_leases
       ORDER BY ip_address`
    );

    const header = 'IP Address,Hostname,MAC Address,Scope,State,Lease Start,Lease Expiry,Last Seen\n';
    const csv = rows.rows.map(r =>
      [r.ip_address, r.hostname || '', r.mac_address || '', r.scope_id || '',
       r.address_state || '', r.lease_start || '', r.lease_expiry || '', r.last_seen || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leases.csv"');
    res.send(header + csv);
  } catch (err) {
    console.error('[API] leases export error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DHCP Events ───────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    const page      = safePage(req.query.page);
    const limit     = safeLimit(req.query.limit);
    const offset    = (page - 1) * limit;
    const hours     = safeHours(req.query.hours);
    const eventType = (req.query.type || '').trim();
    const severity  = (req.query.severity || '').trim();

    const params  = [hours];
    const where   = [`e.event_time > NOW() - make_interval(hours => $1)`];

    if (eventType) {
      params.push(eventType);
      where.push(`e.event_type = $${params.length}`);
    }
    if (severity) {
      const sevMap = {
        critical: [1020, 2019, 34],
        warning:  [1016, 15, 30],
        info:     [10, 11, 12],
      };
      const ids = sevMap[severity];
      if (ids) {
        params.push(ids);
        where.push(`e.event_id = ANY($${params.length})`);
      }
    }

    const whereClause = 'WHERE ' + where.join(' AND ');

    const countParams = [...params];
    const count = await db.query(
      `SELECT COUNT(*) as total FROM dhcp_events e ${whereClause}`,
      countParams
    );

    params.push(limit, offset);
    const rows = await db.query(
      `SELECT e.*, s.hostname as server_hostname
       FROM dhcp_events e
       LEFT JOIN ddi_servers s ON s.id = e.server_id
       ${whereClause}
       ORDER BY e.event_time DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] events error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM Subnets ──────────────────────────────────────────────
app.get('/api/subnets', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT s.*,
         (SELECT COUNT(*) FROM dhcp_leases l
          WHERE l.ip_address << (s.network || '/' || s.prefix_length)::inet) as used_ips
       FROM ipam_subnets s
       ORDER BY s.network`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] subnets error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/subnets', requireWrite, async (req, res) => {
  try {
    const { network, prefix_length, name, description, gateway, vlan_id, site, owner } = req.body;
    if (!network || !prefix_length) return res.status(400).json({ error: 'network and prefix_length required' });

    const result = await db.query(
      `INSERT INTO ipam_subnets (network, prefix_length, name, description, gateway, vlan_id, site, owner, is_managed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
       ON CONFLICT (network, prefix_length) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         gateway = EXCLUDED.gateway, vlan_id = EXCLUDED.vlan_id,
         site = EXCLUDED.site, owner = EXCLUDED.owner, updated_at = NOW()
       RETURNING *`,
      [network, parseInt(prefix_length), name || null, description || null,
       gateway || null, vlan_id ? parseInt(vlan_id) : null, site || null, owner || null]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] subnet create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/subnets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, gateway, vlan_id, site, owner } = req.body;
    const result = await db.query(
      `UPDATE ipam_subnets SET name=$1, description=$2, gateway=$3, vlan_id=$4,
              site=$5, owner=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [name || null, description || null, gateway || null,
       vlan_id ? parseInt(vlan_id) : null, site || null, owner || null, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] subnet update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/subnets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.query('DELETE FROM ipam_subnets WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] subnet delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DNS ───────────────────────────────────────────────────────
app.get('/api/dns/zones', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `WHERE s.site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const rows = await db.query(
      `SELECT z.*, s.hostname as server_hostname
       FROM dns_zones z
       LEFT JOIN ddi_servers s ON s.id = z.server_id
       ${siteFilter}
       ORDER BY z.is_reverse ASC, z.zone_name`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] dns zones error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dns/records', async (req, res) => {
  try {
    const page   = safePage(req.query.page);
    const limit  = safeLimit(req.query.limit);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const type   = (req.query.type || '').trim();
    const zoneId = req.query.zone_id;

    const params = [];
    const where  = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(r.hostname ILIKE $${params.length} OR r.record_data ILIKE $${params.length})`);
    }
    if (type) {
      params.push(type);
      where.push(`r.record_type = $${params.length}`);
    }
    if (zoneId) {
      params.push(parseInt(zoneId));
      where.push(`r.zone_id = $${params.length}`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const count = await db.query(
      `SELECT COUNT(*) as total FROM dns_records r ${whereClause}`,
      [...params]
    );

    params.push(limit, offset);
    const rows = await db.query(
      `SELECT r.*, z.zone_name
       FROM dns_records r
       JOIN dns_zones z ON z.id = r.zone_id
       ${whereClause}
       ORDER BY r.hostname, r.record_type
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] dns records error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dns/record-type-breakdown', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT record_type, COUNT(*) as count
       FROM dns_records
       GROUP BY record_type
       ORDER BY count DESC`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] dns breakdown error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Alerts ────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try {
    const page   = safePage(req.query.page);
    const limit  = safeLimit(req.query.limit);
    const offset = (page - 1) * limit;
    const unackedOnly = req.query.unacked === 'true';

    const where = unackedOnly ? 'WHERE acknowledged = FALSE' : '';

    const count = await db.query(`SELECT COUNT(*) as total FROM alert_events ${where}`);
    const rows  = await db.query(
      `SELECT ae.*, ar.name as rule_name, s.hostname as server_hostname
       FROM alert_events ae
       LEFT JOIN alert_rules ar ON ar.id = ae.rule_id
       LEFT JOIN ddi_servers s ON s.id = ae.server_id
       ${where}
       ORDER BY ae.fired_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] alerts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alerts/:id/acknowledge', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.body.user || 'admin';
    await db.query(
      `UPDATE alert_events SET acknowledged = TRUE, acknowledged_by = $2, acknowledged_at = NOW()
       WHERE id = $1`,
      [id, user]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] ack alert error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alerts/acknowledge-all', requireWrite, async (req, res) => {
  try {
    const user = req.body.user || 'admin';
    await db.query(
      `UPDATE alert_events SET acknowledged = TRUE, acknowledged_by = $1, acknowledged_at = NOW()
       WHERE acknowledged = FALSE`,
      [user]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] ack all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alert-rules', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM alert_rules ORDER BY id');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] alert rules error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/alert-rules/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { threshold_value, is_enabled } = req.body;
    await db.query(
      'UPDATE alert_rules SET threshold_value=$1, is_enabled=$2 WHERE id=$3',
      [threshold_value, is_enabled, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] update rule error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════
// Intelligence & Alerting
// ════════════════════════════════════════════════════════════════

// ── Feature 1: Email alerting ─────────────────────────────────
app.get('/api/smtp', requireSuperAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM smtp_config ORDER BY id LIMIT 1');
    if (!r.rows.length) return res.json({ data: null });
    const row = { ...r.rows[0] };
    row.password = row.password ? '********' : '';
    res.json({ data: row });
  } catch (err) {
    console.error('[API] smtp get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/smtp', requireSuperAdmin, async (req, res) => {
  try {
    const { host, port, secure, username, password, from_email, from_name, enabled } = req.body;
    const existing = await db.query('SELECT * FROM smtp_config ORDER BY id LIMIT 1');

    let encryptedPass;
    if (password && password !== '********') {
      encryptedPass = encryptCred(password);
    } else if (existing.rows.length) {
      encryptedPass = existing.rows[0].password; // preserve existing
    } else {
      encryptedPass = null;
    }

    if (existing.rows.length) {
      await db.query(
        `UPDATE smtp_config SET host=$1, port=$2, secure=$3, username=$4,
           password=$5, from_email=$6, from_name=$7, enabled=$8, updated_at=NOW()
         WHERE id=$9`,
        [host, port, secure, username, encryptedPass, from_email, from_name, enabled, existing.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO smtp_config (host, port, secure, username, password, from_email, from_name, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [host, port, secure, username, encryptedPass, from_email, from_name, enabled]
      );
    }
    emailer.invalidateSmtpCache();
    if (req.audit) req.audit({ action: 'modify', entity_type: 'smtp_config', entity_name: 'SMTP configuration', change_summary: 'Updated SMTP configuration' });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] smtp post error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/smtp/test', requireSuperAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    const r = await emailer.sendTestEmail(db, to);
    res.json(r);
  } catch (err) {
    console.error('[API] smtp test error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alert-recipients', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM alert_recipients ORDER BY created_at DESC');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] alert-recipients get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alert-recipients', requireWrite, async (req, res) => {
  try {
    const { email, name, role_filter, site_id, is_active } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const r = await db.query(
      `INSERT INTO alert_recipients (email, name, role_filter, site_id, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [email, name || null, role_filter || null, site_id || null, is_active !== false]
    );
    if (req.audit) req.audit({ action: 'create', entity_type: 'alert_recipient', entity_id: r.rows[0].id, entity_name: email, change_summary: `Added alert recipient ${email}` });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] alert-recipients post error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/alert-recipients/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { email, name, role_filter, site_id, is_active } = req.body;
    const r = await db.query(
      `UPDATE alert_recipients SET email=$1, name=$2, role_filter=$3, site_id=$4, is_active=$5
       WHERE id=$6 RETURNING *`,
      [email, name || null, role_filter || null, site_id || null, is_active !== false, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Recipient not found' });
    if (req.audit) req.audit({ action: 'modify', entity_type: 'alert_recipient', entity_id: id, entity_name: r.rows[0].email, change_summary: `Updated alert recipient ${r.rows[0].email}` });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] alert-recipients put error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/alert-recipients/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const prev = await db.query('SELECT email FROM alert_recipients WHERE id=$1', [id]);
    await db.query('DELETE FROM alert_recipients WHERE id=$1', [id]);
    if (req.audit) req.audit({ action: 'delete', entity_type: 'alert_recipient', entity_id: id, entity_name: prev.rows[0] ? prev.rows[0].email : String(id), change_summary: 'Removed alert recipient' });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] alert-recipients delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alert-rule-config', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM alert_rule_config ORDER BY rule_type');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] alert-rule-config get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/alert-rule-config/:type', requireSuperAdmin, async (req, res) => {
  try {
    const type = req.params.type;
    const { is_enabled, threshold_value, severity, cooldown_mins, digest_mode } = req.body;
    const r = await db.query(
      `UPDATE alert_rule_config
         SET is_enabled=$2, threshold_value=$3, severity=$4, cooldown_mins=$5, digest_mode=$6, updated_at=NOW()
       WHERE rule_type=$1 RETURNING *`,
      [type, is_enabled, threshold_value, severity, cooldown_mins, digest_mode]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Rule config not found' });
    if (req.audit) req.audit({ action: 'modify', entity_type: 'alert_rule_config', entity_name: type, change_summary: `Updated alert rule config ${type}` });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] alert-rule-config put error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// One-click email acknowledgement (token-guarded GET that mutates)
app.get('/api/alerts/:id/acknowledge', async (req, res) => {
  try {
    if (!emailer.verifyAckToken(req.params.id, req.query.token)) {
      return res.status(403).send('Invalid or expired link');
    }
    await db.query(
      `UPDATE alert_events SET acknowledged=TRUE, acknowledged_by='email-link', acknowledged_at=NOW()
       WHERE id=$1`,
      [parseInt(req.params.id)]
    );
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✓ Alert acknowledged</h2><p>You can close this window.</p></body></html>');
  } catch (err) {
    console.error('[API] email ack error:', err.message);
    res.status(500).send('Error acknowledging alert');
  }
});

// ── Feature 2: Forecasts ──────────────────────────────────────
app.get('/api/forecasts/scopes', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT f.*, sc.scope_id as scope_cidr, sc.name as scope_name, sc.percent_used,
              srv.hostname as server_hostname, srv.site_id
       FROM scope_forecasts f
       JOIN dhcp_scopes sc ON sc.id = f.scope_id
       LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       ORDER BY (f.days_to_full IS NULL), f.days_to_full ASC`
    );
    if (rows.rows.length === 0) {
      return res.json({ data: [], message: 'Forecasts will appear after 7 days of scope history data' });
    }
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] forecasts scopes error:', err.code, err.message);
    // 42P01 = undefined_table — schema migration not run yet
    if (err.code === '42P01') {
      return res.json({ data: [], message: 'Forecast tables not migrated yet — run scripts/schema.sql' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/forecasts/scopes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db.query(
      `SELECT f.*, sc.scope_id as scope_cidr, sc.name as scope_name, sc.percent_used,
              srv.hostname as server_hostname, srv.site_id
       FROM scope_forecasts f
       JOIN dhcp_scopes sc ON sc.id = f.scope_id
       LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       WHERE f.scope_id=$1
       ORDER BY (f.days_to_full IS NULL), f.days_to_full ASC`,
      [id]
    );
    res.json({ data: rows.rows[0] || null });
  } catch (err) {
    console.error('[API] forecast scope error:', err.code, err.message);
    if (err.code === '42P01') return res.json({ data: null, message: 'Forecast tables not migrated yet' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/forecasts/summary', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE days_to_full IS NOT NULL AND days_to_full < 14) as critical,
         COUNT(*) FILTER (WHERE days_to_full >= 14 AND days_to_full <= 30) as warning,
         COUNT(*) FILTER (WHERE days_to_full IS NULL OR days_to_full > 30) as healthy
       FROM scope_forecasts`
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] forecasts summary error:', err.code, err.message);
    if (err.code === '42P01') return res.json({ data: { critical: 0, warning: 0, healthy: 0 }, message: 'Forecast tables not migrated yet' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Feature 4: Anomalies ──────────────────────────────────────
app.get('/api/anomalies', async (req, res) => {
  try {
    const { type, severity, acknowledged, since } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const conditions = [];
    const params = [];
    if (type) { params.push(type); conditions.push(`anomaly_type = $${params.length}`); }
    if (severity) { params.push(severity); conditions.push(`severity = $${params.length}`); }
    if (acknowledged === 'true') conditions.push('acknowledged = TRUE');
    else if (acknowledged === 'false') conditions.push('acknowledged = FALSE');
    if (since) { params.push(since); conditions.push(`detected_at > NOW() - $${params.length}::interval`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const rows = await db.query(
      `SELECT * FROM anomaly_events ${where} ORDER BY detected_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] anomalies error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/anomalies/summary', async (req, res) => {
  try {
    const byType = await db.query(
      `SELECT anomaly_type, severity, COUNT(*) as count
       FROM anomaly_events
       WHERE detected_at > NOW() - INTERVAL '7 days'
       GROUP BY anomaly_type, severity`
    );
    const counts = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE detected_at > date_trunc('day', NOW())) as today,
         COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '7 days') as week
       FROM anomaly_events`
    );
    res.json({ data: { byType: byType.rows, today: parseInt(counts.rows[0].today), week: parseInt(counts.rows[0].week) } });
  } catch (err) {
    console.error('[API] anomalies summary error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/anomalies/acknowledge-all', requireWrite, async (req, res) => {
  try {
    const by = (req.user && req.user.email) || req.body.user || 'admin';
    const result = await db.query(
      `UPDATE anomaly_events SET acknowledged=TRUE, acknowledged_at=NOW(), acknowledged_by=$1 WHERE acknowledged=FALSE`,
      [by]
    );
    if (req.audit) req.audit({ action: 'modify', entity_type: 'anomaly_event', entity_id: null, entity_name: 'all', change_summary: `Acknowledged all anomalies (${result.rowCount})` });
    res.json({ success: true, count: result.rowCount });
  } catch (err) {
    console.error('[API] anomaly ack-all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/anomalies/:id/ack', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const by = (req.user && req.user.email) || 'admin';
    await db.query(
      `UPDATE anomaly_events SET acknowledged=TRUE, acknowledged_at=NOW(), acknowledged_by=$2 WHERE id=$1`,
      [id, by]
    );
    if (req.audit) req.audit({ action: 'modify', entity_type: 'anomaly_event', entity_id: id, entity_name: String(id), change_summary: `Acknowledged anomaly ${id}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] anomaly ack error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Feature 5: Site health ────────────────────────────────────
app.get('/api/site-health', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT DISTINCT ON (site_id) * FROM site_health_scores
       ORDER BY site_id, calculated_at DESC`
    );
    // Resolve real site names from NetVault (best-effort; falls back to stored name / Site <id>)
    let names = {};
    try {
      const s = await netvaultDb.query('SELECT id, name FROM sites');
      names = Object.fromEntries(s.rows.map(r => [r.id, r.name]));
    } catch (e) {
      console.error('[API] site-health name resolve failed:', e.message);
    }
    const data = rows.rows.map(r => ({
      ...r,
      site_name: names[r.site_id] || r.site_name || `Site ${r.site_id}`,
    }));
    res.json({ data });
  } catch (err) {
    console.error('[API] site-health error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/site-health/:siteId', async (req, res) => {
  try {
    const siteId = parseInt(req.params.siteId);
    const rows = await db.query(
      `SELECT * FROM site_health_scores WHERE site_id=$1 ORDER BY calculated_at DESC LIMIT 100`,
      [siteId]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] site-health history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Servers (enhanced with auth) ──────────────────────────────
app.get('/api/servers', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `WHERE site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const rows = await db.query(
      `SELECT id, hostname, ip_address::text as ip_address, role, description,
              is_active, last_polled, poll_status, poll_error,
              auth_mode, ps_username, winrm_port, winrm_https,
              winrm_test_ok, winrm_tested_at, notes, site_id,
              created_at, updated_at
       FROM ddi_servers ${siteFilter} ORDER BY created_at DESC`,
      params
    );
    // Enrich with site names from NetVault if any site_ids present
    const siteIds = [...new Set(rows.rows.map(r => r.site_id).filter(Boolean))];
    let siteMap = {};
    if (siteIds.length) {
      const sites = await netvaultDb.query(
        `SELECT id, name FROM sites WHERE id = ANY($1)`, [siteIds]
      ).catch(() => ({ rows: [] }));
      for (const s of sites.rows) siteMap[s.id] = s.name;
    }
    const data = rows.rows.map(r => ({
      ...r,
      ps_password: undefined, // never return password
      site_name: r.site_id ? siteMap[r.site_id] || null : null,
    }));
    res.json({ data });
  } catch (err) {
    console.error('[API] servers error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/servers', requireWrite, async (req, res) => {
  try {
    const {
      hostname, ip_address, role, description,
      auth_mode, ps_username, ps_password,
      winrm_port, winrm_https, notes, site_id,
    } = req.body;
    if (!hostname && !ip_address) return res.status(400).json({ error: 'hostname or ip_address required' });

    const encryptedPass = ps_password ? encryptCred(ps_password) : null;

    const result = await db.query(
      `INSERT INTO ddi_servers
         (hostname, ip_address, role, description, auth_mode, ps_username, ps_password,
          winrm_port, winrm_https, notes, site_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, hostname, ip_address::text, role, description,
                 auth_mode, ps_username, winrm_port, winrm_https, notes, site_id, is_active, created_at`,
      [
        hostname || null, ip_address || null, role || 'both', description || null,
        auth_mode || 'kerberos', ps_username || null, encryptedPass,
        parseInt(winrm_port || '5985'), winrm_https === true,
        notes || null, site_id ? parseInt(site_id) : null,
      ]
    );
    if (req.audit) req.audit({ action: 'create', entity_type: 'server', entity_id: result.rows[0].id, entity_name: hostname || ip_address, server_id: result.rows[0].id, new_value: { hostname, ip_address, role, auth_mode } });

    // Fire and forget — add the new server IP to WinRM TrustedHosts so stored-credential
    // auth can connect. Don't block the response.
    const { addToTrustedHosts } = require('../collector/powershellRunner');
    setImmediate(() => addToTrustedHosts(ip_address));

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] server create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/servers/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const {
      hostname, ip_address, role, description, is_active,
      auth_mode, ps_username, ps_password,
      winrm_port, winrm_https, notes,
    } = req.body;

    // Only re-encrypt password if a new one was provided
    let encryptedPass = undefined;
    if (ps_password && ps_password !== '••••••••') {
      encryptedPass = encryptCred(ps_password);
    }

    const result = await db.query(
      `UPDATE ddi_servers SET
         hostname=$2, ip_address=$3, role=$4, description=$5,
         is_active=$6, auth_mode=$7, ps_username=$8,
         ${encryptedPass !== undefined ? 'ps_password=$9,' : ''}
         winrm_port=${encryptedPass !== undefined ? '$10' : '$9'},
         winrm_https=${encryptedPass !== undefined ? '$11' : '$10'},
         notes=${encryptedPass !== undefined ? '$12' : '$11'},
         updated_at=NOW()
       WHERE id=$1
       RETURNING id, hostname, ip_address::text, role, description,
                 auth_mode, ps_username, winrm_port, winrm_https,
                 winrm_test_ok, winrm_tested_at, notes, is_active`,
      encryptedPass !== undefined
        ? [id, hostname||null, ip_address||null, role||'both', description||null,
           is_active !== false, auth_mode||'kerberos', ps_username||null,
           encryptedPass, parseInt(winrm_port||'5985'), winrm_https===true, notes||null]
        : [id, hostname||null, ip_address||null, role||'both', description||null,
           is_active !== false, auth_mode||'kerberos', ps_username||null,
           parseInt(winrm_port||'5985'), winrm_https===true, notes||null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.audit) req.audit({ action: 'modify', entity_type: 'server', entity_id: id, entity_name: result.rows[0].hostname, server_id: id, new_value: { hostname, role, auth_mode, is_active: is_active !== false } });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] server update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/servers/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const prev = await db.query('SELECT hostname FROM ddi_servers WHERE id=$1', [id]);
    await db.query('DELETE FROM ddi_servers WHERE id=$1', [id]);
    if (req.audit) req.audit({ action: 'delete', entity_type: 'server', entity_id: id, entity_name: prev.rows[0] ? prev.rows[0].hostname : String(id), server_id: id });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] server delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test WinRM connection for a server
app.post('/api/servers/:id/test-connection', requireWrite, async (req, res) => {
  try {
    const id  = parseInt(req.params.id);
    const serverData = await getServerWithAuth(id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    // Add to TrustedHosts before testing — ensures the test can succeed for stored creds.
    psWrite.addToTrustedHosts(ip);

    console.log(`[API] Testing WinRM connection to ${ip} (mode=${auth.auth_mode})...`);
    const result = psWrite.testWinRM(ip, auth);

    // Update test result in DB
    await db.query(
      `UPDATE ddi_servers SET winrm_test_ok=$2, winrm_tested_at=NOW(), poll_error=$3 WHERE id=$1`,
      [id, result.ok, result.error || null]
    );

    if (req.audit) req.audit({ action: 'test', entity_type: 'server', entity_id: id, entity_name: ip, server_id: id, result: result.ok ? 'success' : 'failure', error_message: result.error || null, change_summary: `WinRM test ${result.ok ? 'succeeded' : 'failed'} for ${ip}` });
    res.json({
      ok:         result.ok,
      latency_ms: result.latencyMs,
      error:      result.error,
      server_ip:  ip,
      auth_mode:  auth.auth_mode,
    });
  } catch (err) {
    console.error('[API] test connection error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Settings ─────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await db.query('SELECT key, value FROM app_settings');
    const settings = {};
    for (const r of rows.rows) settings[r.key] = r.value;
    res.json({ data: settings });
  } catch (err) {
    console.error('[API] settings error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/settings', requireSuperAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    const prev = await db.query('SELECT value FROM app_settings WHERE key=$1', [key]);
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, value || '']
    );
    if (req.audit) req.audit({ action: 'modify', entity_type: 'setting', entity_id: key, entity_name: key, old_value: prev.rows[0] ? { value: prev.rows[0].value } : null, new_value: { value: value || '' }, change_summary: `Setting "${key}" changed` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] settings update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Supernets ─────────────────────────────────────────
app.get('/api/ipam/supernets', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `WHERE s.site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const rows = await db.query(
      `SELECT s.*,
         COUNT(sub.id) as subnet_count,
         COALESCE(SUM(sub.total_hosts),0) as total_hosts,
         COALESCE(SUM(sub.used_hosts),0)  as used_hosts,
         COALESCE(SUM(sub.free_hosts),0)  as free_hosts
       FROM ipam_supernets s
       LEFT JOIN ipam_subnets sub ON sub.supernet_id = s.id
       ${siteFilter}
       GROUP BY s.id
       ORDER BY s.network`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] supernets error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/supernets', requireWrite, async (req, res) => {
  try {
    const { network, prefix_length, name, description, site, site_id } = req.body;
    if (!network || !prefix_length) return res.status(400).json({ error: 'network and prefix_length required' });
    const siteIdVal = site_id != null && site_id !== '' ? parseInt(site_id) : null;
    const result = await db.query(
      `INSERT INTO ipam_supernets (network, prefix_length, name, description, site, site_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (network, prefix_length) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, site=EXCLUDED.site,
         site_id=EXCLUDED.site_id, updated_at=NOW()
       RETURNING *`,
      [network, parseInt(prefix_length), name||null, description||null, site||null, siteIdVal]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] supernet create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/ipam/supernets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, site_id } = req.body;
    const result = await db.query(
      `UPDATE ipam_supernets SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         site_id = $4,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, name ?? null, description ?? null, site_id != null && site_id !== '' ? parseInt(site_id) : null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.audit) req.audit({ action: 'modify', entity_type: 'supernet', entity_id: id, entity_name: result.rows[0].name || String(id), new_value: { name, site_id } });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[API] supernet update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ipam/supernets/:id', requireWrite, async (req, res) => {
  try {
    await db.query('DELETE FROM ipam_supernets WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] supernet delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Subnets (enhanced) ────────────────────────────────
app.get('/api/ipam/subnets', attachSiteFilter, async (req, res) => {
  try {
    await expireStuckScans();
    const supernet_id = req.query.supernet_id;
    const params = [];
    const conds = [];
    if (supernet_id) {
      params.push(parseInt(supernet_id));
      conds.push(`s.supernet_id = $${params.length}`);
    }
    if (req.allowedSiteIds !== null) {
      params.push(req.allowedSiteIds);
      conds.push(`s.site_id = ANY($${params.length}::int[])`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await db.query(
      `SELECT s.*,
         sn.name as supernet_name,
         host(sn.network) as supernet_network,
         sn.prefix_length as supernet_prefix,
         (SELECT COUNT(*) FROM ipam_addresses a WHERE a.subnet_id = s.id) as ip_count,
         (SELECT COUNT(*) FROM ipam_addresses a WHERE a.subnet_id = s.id AND a.status = 'dhcp') as dhcp_count,
         (SELECT COUNT(*) FROM ipam_addresses a WHERE a.subnet_id = s.id AND a.status = 'unknown') as unknown_count,
         (SELECT COUNT(*) FROM ipam_addresses a WHERE a.subnet_id = s.id AND a.status = 'reserved') as reserved_count
       FROM ipam_subnets s
       LEFT JOIN ipam_supernets sn ON sn.id = s.supernet_id
       ${where}
       ORDER BY s.network`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] ipam subnets error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/subnets', requireWrite, async (req, res) => {
  try {
    const { network, prefix_length, name, description, gateway, vlan_id,
            site, site_id, owner, supernet_id, location, notes } = req.body;
    if (!network || !prefix_length) return res.status(400).json({ error: 'network and prefix_length required' });
    const totalHosts = Math.max(0, Math.pow(2, 32 - parseInt(prefix_length)) - 2);
    const siteIdVal = site_id != null && site_id !== '' ? parseInt(site_id) : null;
    const result = await db.query(
      `INSERT INTO ipam_subnets
         (network, prefix_length, name, description, gateway, vlan_id, site, owner,
          supernet_id, location, notes, site_id, is_managed, total_hosts, free_hosts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,TRUE,$12,$12)
       ON CONFLICT (network, prefix_length) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         gateway=EXCLUDED.gateway, vlan_id=EXCLUDED.vlan_id,
         site=EXCLUDED.site, owner=EXCLUDED.owner,
         supernet_id=EXCLUDED.supernet_id, location=EXCLUDED.location,
         notes=EXCLUDED.notes, site_id=EXCLUDED.site_id, updated_at=NOW()
       RETURNING *`,
      [network, parseInt(prefix_length), name||null, description||null,
       gateway||null, vlan_id?parseInt(vlan_id):null, site||null, owner||null,
       supernet_id?parseInt(supernet_id):null, location||null, notes||null, totalHosts, siteIdVal]
    );
    if (req.audit) req.audit({ action: 'create', entity_type: 'subnet', entity_id: result.rows[0].id, entity_name: `${network}/${prefix_length}`, new_value: { network, prefix_length, name, site, vlan_id } });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] ipam subnet create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/ipam/subnets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, gateway, vlan_id, site, owner, supernet_id, location, notes, site_id, is_sensitive } = req.body;
    const result = await db.query(
      `UPDATE ipam_subnets SET
         name=$2, description=$3, gateway=$4, vlan_id=$5, site=$6, owner=$7,
         supernet_id=$8, location=$9, notes=$10, site_id=$11,
         is_sensitive=COALESCE($12, is_sensitive), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id, name||null, description||null, gateway||null,
       vlan_id?parseInt(vlan_id):null, site||null, owner||null,
       supernet_id?parseInt(supernet_id):null, location||null, notes||null,
       site_id != null && site_id !== '' ? parseInt(site_id) : null,
       typeof is_sensitive === 'boolean' ? is_sensitive : null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] ipam subnet update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ipam/subnets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const prev = await db.query('SELECT host(network) AS network, prefix_length FROM ipam_subnets WHERE id=$1', [id]);
    await db.query('DELETE FROM ipam_subnets WHERE id=$1', [id]);
    if (req.audit) req.audit({ action: 'delete', entity_type: 'subnet', entity_id: id, entity_name: prev.rows[0] ? `${prev.rows[0].network}/${prev.rows[0].prefix_length}` : String(id) });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] ipam subnet delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — IP Addresses ───────────────────────────────────────
app.get('/api/ipam/subnets/:id/addresses', attachSiteFilter, async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const status = req.query.status || '';
    const params = [id];
    let where = 'WHERE a.subnet_id = $1';
    if (status) { params.push(status); where += ` AND a.status = $${params.length}`; }
    if (req.allowedSiteIds !== null) {
      params.push(req.allowedSiteIds);
      where += ` AND EXISTS (SELECT 1 FROM ipam_subnets sn WHERE sn.id = a.subnet_id AND sn.site_id = ANY($${params.length}::int[]))`;
    }
    const rows = await db.query(
      `SELECT a.*, l.lease_expiry, l.address_state
       FROM ipam_addresses a
       LEFT JOIN dhcp_leases l ON l.id = a.dhcp_lease_id
       ${where}
       ORDER BY a.ip_address`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] ip addresses error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reserve an IP
app.post('/api/ipam/subnets/:id/addresses/:ip/reserve', requireWrite, async (req, res) => {
  try {
    const subnetId  = parseInt(req.params.id);
    const ip        = req.params.ip;
    const { description, owner, reserved_by } = req.body;
    await db.query(
      `INSERT INTO ipam_addresses
         (subnet_id, ip_address, status, description, owner, is_reserved, reserved_by, reserved_at)
       VALUES ($1,$2,'reserved',$3,$4,TRUE,$5,NOW())
       ON CONFLICT (subnet_id, ip_address) DO UPDATE SET
         status='reserved', description=EXCLUDED.description, owner=EXCLUDED.owner,
         is_reserved=TRUE, reserved_by=EXCLUDED.reserved_by, reserved_at=NOW(), updated_at=NOW()`,
      [subnetId, ip, description||null, owner||null, reserved_by||'admin']
    );
    await db.query(
      `INSERT INTO ipam_audit (ip_address, subnet_id, action, new_status, performed_by, notes)
       VALUES ($1,$2,'reserved','reserved',$3,$4)`,
      [ip, subnetId, reserved_by||'admin', description||null]
    );
    if (req.audit) req.audit({ action: 'reserve', entity_type: 'ip_address', entity_id: ip, entity_name: ip, new_value: { description, owner }, change_summary: `Reserved IP ${ip}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] reserve ip error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Release a reserved IP
app.post('/api/ipam/subnets/:id/addresses/:ip/release', requireWrite, async (req, res) => {
  try {
    const subnetId = parseInt(req.params.id);
    const ip       = req.params.ip;
    await db.query(
      `UPDATE ipam_addresses SET
         status='available', is_reserved=FALSE, reserved_by=NULL, reserved_at=NULL, updated_at=NOW()
       WHERE subnet_id=$1 AND ip_address=$2`,
      [subnetId, ip]
    );
    await db.query(
      `INSERT INTO ipam_audit (ip_address, subnet_id, action, old_status, new_status, performed_by)
       VALUES ($1,$2,'released','reserved','available','admin')`,
      [ip, subnetId]
    );
    if (req.audit) req.audit({ action: 'release', entity_type: 'ip_address', entity_id: ip, entity_name: ip, change_summary: `Released IP ${ip}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] release ip error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Scan ───────────────────────────────────────────────
const { scanAllSubnets } = require('../collector/ipamScanner');
const scanningSubnets = new Set(); // prevent concurrent scans of same subnet

// Auto-expire scans stuck in 'running'/'scanning' for >30 min (covers process
// crashes/restarts where the in-memory scanningSubnets set was lost). Runs on
// startup and on every scan-status poll so the UI never shows a permanent "Scanning".
async function expireStuckScans() {
  try {
    await db.query(`
      UPDATE ipam_scan_jobs SET status='error', error_msg='Scan timed out'
      WHERE status='running' AND started_at < NOW() - INTERVAL '30 minutes'`);
    await db.query(`
      UPDATE ipam_subnets s SET scan_status='error'
      WHERE s.scan_status='scanning'
        AND NOT EXISTS (
          SELECT 1 FROM ipam_scan_jobs j
          WHERE j.subnet_id = s.id AND j.status='running'
            AND j.started_at > NOW() - INTERVAL '30 minutes'
        )`);
  } catch (err) {
    console.error('[ScanExpiry] error:', err.message);
  }
}

app.post('/api/ipam/subnets/:id/scan', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (scanningSubnets.has(id)) {
      return res.status(409).json({ error: 'Scan already in progress for this subnet' });
    }
    const subnetRes = await db.query(
      'SELECT id, host(network) as network, prefix_length, name FROM ipam_subnets WHERE id=$1', [id]
    );
    if (!subnetRes.rows.length) return res.status(404).json({ error: 'Subnet not found' });
    const subnet = subnetRes.rows[0];

    if (req.audit) req.audit({ action: 'scan', entity_type: 'subnet', entity_id: id, entity_name: `${subnet.network}/${subnet.prefix_length}`, change_summary: `Started scan of ${subnet.network}/${subnet.prefix_length}` });
    res.json({ success: true, message: `Scan started for ${subnet.network}/${subnet.prefix_length}` });

    // Run scan in a completely separate child process — does NOT block the API
    scanningSubnets.add(id);
    const { fork } = require('child_process');
    const worker = fork(
      require('path').join(__dirname, '..', 'collector', 'scanWorker.js'),
      [String(id), subnet.network, String(subnet.prefix_length), subnet.name || ''],
      { silent: false, env: process.env }
    );
    worker.on('exit', (code) => {
      scanningSubnets.delete(id);
      console.log(`[API] Scan worker exited for subnet ${id} with code ${code}`);
    });
    worker.on('error', (err) => {
      scanningSubnets.delete(id);
      console.error(`[API] Scan worker error for subnet ${id}: ${err.message}`);
    });
  } catch (err) {
    console.error('[API] scan start error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/scan-all', requireWrite, async (req, res) => {
  try {
    res.json({ success: true, message: 'Full IPAM scan started' });
    scanAllSubnets().catch(err => console.error('[API] scan-all error:', err.message));
  } catch (err) {
    console.error('[API] scan-all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manually trigger IPAM sync from ALL DHCP scopes across all active DHCP-capable servers
app.post('/api/ipam/sync-from-dhcp', requireWrite, async (req, res) => {
  try {
    const ipamSync = require('../collector/ipamSync');
    const totals = { created: 0, updated: 0, supernetsCreated: 0 };
    const servers = await db.query(
      "SELECT id FROM ddi_servers WHERE is_active = TRUE AND role IN ('dhcp','both')"
    );
    for (const server of servers.rows) {
      try {
        const sd = await getServerWithAuth(server.id);
        if (!sd) continue;
        const rawScopes = psWrite.getDhcpScopes(sd.ip, sd.auth);
        const scopes = (rawScopes || []).map(s => ({
          scopeId: scopeIdStr(s.ScopeId),
          subnetMask: scopeIdStr(s.SubnetMask),
          name: s.Name || null,
        }));
        const getGateway = async (scopeId) => {
          try {
            const opts = psWrite.getDhcpScopeOptions(sd.ip, sd.auth, scopeId);
            const arr = Array.isArray(opts) ? opts : (opts ? [opts] : []);
            const o = arr.find(x => Number(x.OptionId) === 3);
            if (!o) return null;
            const v = Array.isArray(o.Value) ? o.Value[0] : o.Value;
            return scopeIdStr(v) || null;
          } catch (_) { return null; }
        };
        const r = await ipamSync.syncScopesToIpam(db, scopes, { log: (m) => console.log(m), getGateway });
        totals.created += r.created;
        totals.updated += r.updated;
        totals.supernetsCreated += r.supernetsCreated;
      } catch (serverErr) {
        console.error(`[API] sync-from-dhcp server ${server.id} error:`, serverErr.message);
      }
    }
    if (req.audit) req.audit({
      action: 'sync',
      entity_type: 'ipam',
      entity_name: 'dhcp-sync',
      change_summary: `IPAM sync from DHCP: ${totals.created} created, ${totals.updated} updated`,
    });
    res.json({ success: true, created: totals.created, updated: totals.updated, supernetsCreated: totals.supernetsCreated });
  } catch (err) {
    console.error('[API] sync-from-dhcp error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/ipam/subnets/:id/scan-status', async (req, res) => {
  try {
    await expireStuckScans();
    const id = parseInt(req.params.id);
    const subnet = await db.query(
      'SELECT scan_status, last_scanned, total_hosts, used_hosts, free_hosts, unknown_hosts FROM ipam_subnets WHERE id=$1',
      [id]
    );
    const lastJob = await db.query(
      `SELECT * FROM ipam_scan_jobs WHERE subnet_id=$1 ORDER BY started_at DESC LIMIT 1`, [id]
    );
    // Live IP counts from ipam_addresses
    const counts = await db.query(
      `SELECT status, COUNT(*) as count FROM ipam_addresses WHERE subnet_id=$1 GROUP BY status`, [id]
    );
    const countMap = {};
    for (const r of counts.rows) countMap[r.status] = parseInt(r.count);
    res.json({
      scanning:   scanningSubnets.has(id),
      subnet:     subnet.rows[0] || {},
      last_job:   lastJob.rows[0] || null,
      ip_counts:  countMap,
      scanned_so_far: Object.values(countMap).reduce((a, b) => a + b, 0),
    });
  } catch (err) {
    console.error('[API] scan status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Global scan status — all subnets currently scanning
app.get('/api/ipam/scan-status', async (req, res) => {
  try {
    await expireStuckScans();
    const jobsQ = await db.query(`
      SELECT
        j.subnet_id, j.status, j.hosts_scanned, j.hosts_up, j.hosts_unknown,
        j.started_at, j.error_msg, s.total_hosts,
        host(s.network) as network, s.prefix_length, s.name,
        ROUND((j.hosts_scanned::numeric / NULLIF(s.total_hosts, 0)) * 100) as progress_pct,
        EXTRACT(EPOCH FROM (NOW() - j.started_at))::int as elapsed_seconds
      FROM ipam_scan_jobs j
      JOIN ipam_subnets s ON s.id = j.subnet_id
      WHERE j.status = 'running' AND j.started_at > NOW() - INTERVAL '30 minutes'
      ORDER BY j.started_at DESC`);
    const allSubnets = await db.query(
      `SELECT id, host(network) as network, prefix_length, name, scan_status, last_scanned,
              total_hosts, used_hosts, free_hosts, unknown_hosts
       FROM ipam_subnets WHERE is_managed=TRUE ORDER BY network`
    );
    const ids = jobsQ.rows.map(r => r.subnet_id);
    res.json({
      scanning: ids,            // new: subnet ids with a live running job
      scanning_ids: ids,        // backward-compat
      active_scans: ids.length, // backward-compat
      jobs: jobsQ.rows,         // enriched: progress_pct, elapsed_seconds, network, name, totals
      subnets: allSubnets.rows,
    });
  } catch (err) {
    console.error('[API] global scan status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — VLANs ─────────────────────────────────────────────
app.get('/api/ipam/vlans', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM ipam_vlans ORDER BY vlan_id');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] vlans error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/vlans', requireWrite, async (req, res) => {
  try {
    const { vlan_id, name, description, site } = req.body;
    if (!vlan_id) return res.status(400).json({ error: 'vlan_id required' });
    const result = await db.query(
      `INSERT INTO ipam_vlans (vlan_id, name, description, site)
       VALUES ($1,$2,$3,$4) ON CONFLICT (vlan_id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, site=EXCLUDED.site
       RETURNING *`,
      [parseInt(vlan_id), name||null, description||null, site||null]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] vlan create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ipam/vlans/:id', requireWrite, async (req, res) => {
  try {
    await db.query('DELETE FROM ipam_vlans WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] vlan delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Audit ─────────────────────────────────────────────
app.get('/api/ipam/audit', async (req, res) => {
  try {
    const limit = safeLimit(req.query.limit);
    const ip    = (req.query.ip || '').trim();
    const params = [limit];
    let where = '';
    if (ip) { params.push(ip); where = `WHERE ip_address = $${params.length}`; }
    const rows = await db.query(
      `SELECT * FROM ipam_audit ${where} ORDER BY created_at DESC LIMIT $1`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] ipam audit error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DNS Management (write operations) ────────────────────────
const psWrite = require('../collector/powershellRunner');
const { encrypt: encryptCred, decrypt: decryptCred } = require('../collector/credStore');

/**
 * Load a server row and build auth object for PS runner.
 */
async function getServerWithAuth(serverId) {
  const result = await db.query('SELECT * FROM ddi_servers WHERE id=$1', [parseInt(serverId)]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    ip:   row.ip_address,
    auth: {
      auth_mode:   row.auth_mode   || 'kerberos',
      ps_username: row.ps_username || null,
      ps_password: row.ps_password ? decryptCred(row.ps_password) : null,
      winrm_port:  row.winrm_port  || 5985,
      winrm_https: row.winrm_https || false,
    },
    row,
  };
}

// Get DNS server list from ddi_servers
app.get('/api/dns/servers', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, hostname, ip_address::text as ip_address, role, poll_status, last_polled
       FROM ddi_servers WHERE role IN ('dns','both') AND is_active=TRUE ORDER BY hostname`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] dns servers error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add DNS record — runs PowerShell on the actual DNS server
app.post('/api/dns/records', requireWrite, async (req, res) => {
  try {
    const { server_id, zone_name, hostname, record_type, record_data, ttl, preference } = req.body;
    if (!server_id || !zone_name || !hostname || !record_type || !record_data) {
      return res.status(400).json({ error: 'server_id, zone_name, hostname, record_type, record_data required' });
    }

    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip: serverIp, auth } = serverData;

    let ok = false;
    const ttlSec = parseInt(ttl || '3600');

    switch (record_type.toUpperCase()) {
      case 'A':     ok = psWrite.addDnsARecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      case 'CNAME': ok = psWrite.addDnsCNameRecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      case 'PTR':   ok = psWrite.addDnsPtrRecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      case 'MX':    ok = psWrite.addDnsMxRecord(serverIp, zone_name, hostname, record_data, parseInt(preference||'10'), ttlSec, auth); break;
      case 'TXT':   ok = psWrite.addDnsTxtRecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      default: return res.status(400).json({ error: `Unsupported record type: ${record_type}` });
    }

    if (!ok) return res.status(500).json({ error: 'PowerShell command failed — check WinRM and DNS server role' });

    // Store in our DB too
    const zoneRes = await db.query('SELECT id FROM dns_zones WHERE zone_name=$1 AND server_id=$2', [zone_name, parseInt(server_id)]);
    if (zoneRes.rows.length) {
      await db.query(
        `INSERT INTO dns_records (zone_id, hostname, record_type, record_data, ttl)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING`,
        [zoneRes.rows[0].id, hostname, record_type.toUpperCase(), record_data, ttlSec]
      );
    }

    if (req.audit) req.audit({ action: 'create', entity_type: 'dns_record', entity_name: `${hostname} ${record_type.toUpperCase()}`, server_id, new_value: { hostname, record_type, record_data, zone_name }, change_summary: `Added ${record_type.toUpperCase()} record ${hostname} → ${record_data}` });
    res.json({ success: true, message: `${record_type} record created: ${hostname} → ${record_data}` });
  } catch (err) {
    console.error('[API] dns add record error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete DNS record
app.delete('/api/dns/records', requireWrite, async (req, res) => {
  try {
    const { server_id, zone_name, hostname, record_type, record_data } = req.body;
    if (!server_id || !zone_name || !hostname || !record_type) {
      return res.status(400).json({ error: 'server_id, zone_name, hostname, record_type required' });
    }
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const ok = psWrite.removeDnsRecord(serverData.ip, zone_name, hostname, record_type, record_data, serverData.auth);
    if (!ok) return res.status(500).json({ error: 'PowerShell delete failed — check WinRM permissions' });

    // Remove from DB
    await db.query(
      `DELETE FROM dns_records WHERE hostname=$1 AND record_type=$2 AND record_data=$3
       AND zone_id IN (SELECT id FROM dns_zones WHERE zone_name=$4 AND server_id=$5)`,
      [hostname, record_type, record_data||'', zone_name, parseInt(server_id)]
    ).catch(() => {});

    if (req.audit) req.audit({ action: 'delete', entity_type: 'dns_record', entity_name: `${hostname} ${record_type}`, server_id, old_value: { hostname, record_type, record_data, zone_name }, change_summary: `Deleted ${record_type} record ${hostname}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] dns delete record error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add DNS zone
app.post('/api/dns/zones', requireWrite, async (req, res) => {
  try {
    const { server_id, zone_name, zone_type, replication_scope } = req.body;
    if (!server_id || !zone_name) return res.status(400).json({ error: 'server_id and zone_name required' });
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const ok = psWrite.addDnsZone(serverData.ip, zone_name, zone_type || 'Primary', replication_scope || 'Domain', serverData.auth);
    if (!ok) return res.status(500).json({ error: 'Zone creation failed — check WinRM and DNS server role' });

    await db.query(
      `INSERT INTO dns_zones (server_id, zone_name, zone_type, is_reverse, is_ds_integrated)
       VALUES ($1,$2,$3,FALSE,TRUE) ON CONFLICT (server_id, zone_name) DO NOTHING`,
      [parseInt(server_id), zone_name, zone_type || 'Primary']
    );

    if (req.audit) req.audit({ action: 'create', entity_type: 'dns_zone', entity_name: zone_name, server_id, new_value: { zone_name, zone_type: zone_type || 'Primary' }, change_summary: `Created zone ${zone_name}` });
    res.json({ success: true, message: `Zone ${zone_name} created` });
  } catch (err) {
    console.error('[API] dns add zone error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete DNS zone
app.delete('/api/dns/zones/:id', requireWrite, async (req, res) => {
  try {
    const zoneRes = await db.query(
      `SELECT z.*, s.ip_address::text as server_ip, s.auth_mode, s.ps_username,
              s.ps_password, s.winrm_port, s.winrm_https
       FROM dns_zones z JOIN ddi_servers s ON s.id = z.server_id WHERE z.id=$1`,
      [parseInt(req.params.id)]
    );
    if (!zoneRes.rows.length) return res.status(404).json({ error: 'Zone not found' });
    const zone = zoneRes.rows[0];
    const auth = {
      auth_mode: zone.auth_mode || 'kerberos',
      ps_username: zone.ps_username || null,
      ps_password: zone.ps_password ? decryptCred(zone.ps_password) : null,
      winrm_port: zone.winrm_port || 5985,
      winrm_https: zone.winrm_https || false,
    };

    const ok = psWrite.removeDnsZone(zone.server_ip, zone.zone_name, auth);
    if (!ok) return res.status(500).json({ error: 'Zone deletion failed on DNS server' });

    await db.query('DELETE FROM dns_zones WHERE id=$1', [zone.id]);
    if (req.audit) req.audit({ action: 'delete', entity_type: 'dns_zone', entity_id: zone.id, entity_name: zone.zone_name, server_id: zone.server_id, change_summary: `Deleted zone ${zone.zone_name}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] dns delete zone error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS server stats
app.get('/api/dns/stats/:serverId', async (req, res) => {
  try {
    const serverRes = await db.query('SELECT ip_address::text as ip FROM ddi_servers WHERE id=$1', [parseInt(req.params.serverId)]);
    if (!serverRes.rows.length) return res.status(404).json({ error: 'Server not found' });
    const stats = psWrite.getDnsServerStats(serverRes.rows[0].ip);
    res.json({ data: stats || {} });
  } catch (err) {
    console.error('[API] dns stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DHCP Reservation — write via PowerShell ───────────────────
app.post('/api/dhcp/reservations', requireWrite, async (req, res) => {
  try {
    const { server_id, scope_id, ip_address, mac_address, name, description } = req.body;
    if (!server_id || !scope_id || !ip_address || !mac_address) {
      return res.status(400).json({ error: 'server_id, scope_id, ip_address, mac_address required' });
    }
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const ok = psWrite.addDhcpReservation(serverData.ip, scope_id, ip_address, mac_address, name || ip_address, serverData.auth);
    if (!ok) return res.status(500).json({ error: 'DHCP reservation failed — check WinRM and DHCP server role' });

    // Update lease record to show it is now reserved
    await db.query(
      `UPDATE dhcp_leases SET address_state='Reservation', hostname=COALESCE($3, hostname)
       WHERE server_id=$1 AND ip_address=$2`,
      [parseInt(server_id), ip_address, name || null]
    ).catch(() => {});

    // Log to audit
    await db.query(
      `INSERT INTO ipam_audit (ip_address, action, new_status, hostname, mac_address, performed_by, notes)
       VALUES ($1,'reserved','reserved',$2,$3,'admin',$4)`,
      [ip_address, name||null, mac_address, description||null]
    ).catch(() => {});

    if (req.audit) req.audit({ action: 'reserve', entity_type: 'dhcp_reservation', entity_name: ip_address, server_id, new_value: { ip_address, mac_address, name }, change_summary: `Created reservation ${ip_address} → ${mac_address}` });
    res.json({ success: true, message: `Reservation created: ${ip_address} → ${mac_address}` });
  } catch (err) {
    console.error('[API] dhcp reservation error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove DHCP reservation
app.delete('/api/dhcp/reservations', requireWrite, async (req, res) => {
  try {
    const { server_id, scope_id, ip_address } = req.body;
    if (!server_id || !scope_id || !ip_address) {
      return res.status(400).json({ error: 'server_id, scope_id, ip_address required' });
    }
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const ok = psWrite.removeDhcpReservation(serverData.ip, scope_id, ip_address, serverData.auth);
    if (!ok) return res.status(500).json({ error: 'Removal failed on DHCP server' });

    await db.query(
      `UPDATE dhcp_leases SET address_state='Active' WHERE server_id=$1 AND ip_address=$2`,
      [parseInt(server_id), ip_address]
    ).catch(() => {});

    if (req.audit) req.audit({ action: 'release', entity_type: 'dhcp_reservation', entity_name: ip_address, server_id, change_summary: `Removed reservation ${ip_address}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] dhcp remove reservation error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all reservations for a scope
app.get('/api/dhcp/reservations/:serverId/:scopeId', async (req, res) => {
  try {
    const serverRes = await db.query('SELECT ip_address::text as ip FROM ddi_servers WHERE id=$1', [parseInt(req.params.serverId)]);
    if (!serverRes.rows.length) return res.status(404).json({ error: 'Server not found' });
    const reservations = psWrite.getDhcpReservations(serverRes.rows[0].ip, req.params.scopeId);
    res.json({ data: reservations || [] });
  } catch (err) {
    console.error('[API] dhcp reservations error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Sites (from NetVault DB) ──────────────────────────────────
const netvaultDb = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432'),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.DDI_DB_USER      || 'ddivault_user',
  password: process.env.DDI_DB_PASS      || '',
  max: 3,
  ssl: false,
});

app.get('/api/sites', async (req, res) => {
  try {
    const rows = await netvaultDb.query(
      `SELECT s.id, s.name, s.code, s.city, s.site_type, s.site_status,
              c.name as country_name
       FROM sites s
       LEFT JOIN countries c ON c.id = s.country_id
       WHERE s.site_status = 'Active'
       ORDER BY s.name`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] sites error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — CSV/Excel Import ───────────────────────────────────
app.post('/api/ipam/import', requireWrite, async (req, res) => {
  try {
    const { rows } = req.body; // array of subnet objects from parsed CSV
    if (!rows || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'No rows provided' });
    }

    let imported = 0, skipped = 0, errors = [];

    for (const row of rows) {
      const network      = (row.network      || '').trim();
      const prefix       = parseInt(row.prefix_length || row.prefix || '24');
      const name         = (row.name         || '').trim() || null;
      const gateway      = (row.gateway      || '').trim() || null;
      const vlan_id      = row.vlan_id ? parseInt(row.vlan_id) : null;
      const site         = (row.site         || '').trim() || null;
      const description  = (row.description  || '').trim() || null;
      const owner        = (row.owner        || '').trim() || null;
      const location     = (row.location     || '').trim() || null;
      const supernetRef  = (row.supernet     || '').trim() || null;

      if (!network || isNaN(prefix)) {
        errors.push(`Row skipped — missing network or prefix: ${JSON.stringify(row)}`);
        skipped++;
        continue;
      }

      // Look up supernet if provided
      let supernet_id = null;
      if (supernetRef) {
        const [snet, spfx] = supernetRef.split('/');
        const snRes = await db.query(
          `SELECT id FROM ipam_supernets WHERE network::text = $1 AND prefix_length = $2 LIMIT 1`,
          [snet, parseInt(spfx)]
        ).catch(() => ({ rows: [] }));
        if (snRes.rows.length) supernet_id = snRes.rows[0].id;
      }

      const totalHosts = Math.max(0, Math.pow(2, 32 - prefix) - 2);

      await db.query(
        `INSERT INTO ipam_subnets
           (network, prefix_length, name, description, gateway, vlan_id, site, owner,
            supernet_id, location, is_managed, total_hosts, free_hosts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$11)
         ON CONFLICT (network, prefix_length) DO UPDATE SET
           name=COALESCE(EXCLUDED.name, ipam_subnets.name),
           description=COALESCE(EXCLUDED.description, ipam_subnets.description),
           gateway=COALESCE(EXCLUDED.gateway, ipam_subnets.gateway),
           vlan_id=COALESCE(EXCLUDED.vlan_id, ipam_subnets.vlan_id),
           site=COALESCE(EXCLUDED.site, ipam_subnets.site),
           owner=COALESCE(EXCLUDED.owner, ipam_subnets.owner),
           supernet_id=COALESCE(EXCLUDED.supernet_id, ipam_subnets.supernet_id),
           location=COALESCE(EXCLUDED.location, ipam_subnets.location),
           updated_at=NOW()`,
        [network, prefix, name, description, gateway, vlan_id, site, owner,
         supernet_id, location, totalHosts]
      );
      imported++;
    }

    if (req.audit) req.audit({ action: 'import', entity_type: 'subnet', entity_name: `${imported} subnets`, change_summary: `Imported ${imported} subnets (${skipped} skipped)`, new_value: { imported, skipped, errors: errors.length } });
    res.json({ success: true, imported, skipped, errors });
  } catch (err) {
    console.error('[API] ipam import error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ── Global Search ─────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ data: [] });

    // ── Structured query parsing (key:value) ──────────────────
    const m = q.match(/^(\w+):(.+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      const known = ['type', 'vendor', 'subnet', 'scope', 'site', 'new', 'risk', 'anomaly', 'status'];
      if (known.includes(key)) {
        try {
          let rows = [];
          if (key === 'type') {
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, device_vendor, address_state, scope_id
               FROM dhcp_leases
               WHERE device_type ILIKE $1 LIMIT 100`,
              [`%${val}%`]
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_type, x.device_vendor, x.mac_address].filter(Boolean).join(' · '),
              status: x.address_state, meta: { device_type: x.device_type, device_vendor: x.device_vendor },
            }));
          } else if (key === 'vendor') {
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, device_vendor, address_state
               FROM dhcp_leases WHERE device_vendor ILIKE $1 LIMIT 100`,
              [`%${val}%`]
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_vendor, x.device_type, x.mac_address].filter(Boolean).join(' · '),
              status: x.address_state, meta: { device_vendor: x.device_vendor },
            }));
          } else if (key === 'subnet') {
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, address_state, scope_id
               FROM dhcp_leases WHERE host(ip_address) LIKE $1 LIMIT 100`,
              [`${val}%`]
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_type, x.mac_address, 'Scope: ' + x.scope_id].filter(Boolean).join(' · '),
              status: x.address_state, meta: {},
            }));
          } else if (key === 'scope') {
            let op = '>=', numStr = val;
            if (val[0] === '>') { op = '>'; numStr = val.slice(1); }
            else if (val[0] === '<') { op = '<'; numStr = val.slice(1); }
            const num = parseFloat(numStr);
            const r = await db.query(
              `SELECT sc.scope_id, sc.name, sc.start_range::text, sc.end_range::text, sc.percent_used,
                      srv.hostname AS server_hostname
               FROM dhcp_scopes sc LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
               WHERE sc.percent_used ${op} $1 ORDER BY sc.percent_used DESC LIMIT 100`,
              [isNaN(num) ? 0 : num]
            );
            rows = r.rows.map(x => ({
              type: 'scope', title: x.scope_id,
              subtitle: [x.name, x.server_hostname, x.percent_used + '% used'].filter(Boolean).join(' · '),
              status: null, meta: { percent_used: x.percent_used },
            }));
          } else if (key === 'site') {
            const srv = await db.query(
              `SELECT hostname, ip_address::text, role FROM ddi_servers
               WHERE hostname ILIKE $1 OR site_id::text = $2 LIMIT 50`,
              [`%${val}%`, val]
            );
            for (const x of srv.rows) {
              rows.push({
                type: 'server', title: x.hostname,
                subtitle: [x.ip_address, x.role].filter(Boolean).join(' · '),
                status: null, meta: {},
              });
            }
            const sub = await db.query(
              `SELECT host(network) as network, prefix_length, name, site FROM ipam_subnets
               WHERE site ILIKE $1 LIMIT 50`,
              [`%${val}%`]
            );
            for (const x of sub.rows) {
              rows.push({
                type: 'subnet', title: x.network + '/' + x.prefix_length,
                subtitle: [x.name, x.site].filter(Boolean).join(' · '),
                status: null, meta: {},
              });
            }
            rows = rows.slice(0, 100);
          } else if (key === 'new') {
            const cutoff = val.toLowerCase() === 'today'
              ? `date_trunc('day', NOW())`
              : `NOW() - INTERVAL '7 days'`;
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, address_state, first_seen
               FROM dhcp_leases WHERE first_seen > ${cutoff} ORDER BY first_seen DESC LIMIT 100`
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_type, x.mac_address].filter(Boolean).join(' · '),
              status: x.address_state, meta: { first_seen: x.first_seen },
            }));
          } else if (key === 'risk') {
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, risk_level, address_state
               FROM dhcp_leases WHERE risk_level = $1 LIMIT 100`,
              [val.toLowerCase()]
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_type, x.risk_level, x.mac_address].filter(Boolean).join(' · '),
              status: x.address_state, meta: { risk_level: x.risk_level },
            }));
          } else if (key === 'anomaly') {
            const r = await db.query(
              `SELECT id, anomaly_type, severity, description, detected_at
               FROM anomaly_events WHERE detected_at > date_trunc('day', NOW())
               ORDER BY detected_at DESC LIMIT 100`
            );
            rows = r.rows.map(x => ({
              type: 'anomaly', title: x.anomaly_type,
              subtitle: [x.severity, x.description].filter(Boolean).join(' · '),
              status: x.severity, meta: { id: x.id, detected_at: x.detected_at },
            }));
          } else if (key === 'status') {
            const r = await db.query(
              `SELECT a.ip_address::text, a.hostname, a.mac_address, a.status,
                      s.name as subnet_name
               FROM ipam_addresses a
               LEFT JOIN ipam_subnets s ON s.id = a.subnet_id
               WHERE a.status = $1 LIMIT 100`,
              [val.toLowerCase()]
            );
            rows = r.rows.map(x => ({
              type: 'ip', title: x.ip_address,
              subtitle: [x.hostname, x.mac_address, x.subnet_name].filter(Boolean).join(' · '),
              status: x.status, meta: {},
            }));
          }
          return res.json({ data: rows, structured: true, query: q });
        } catch (e) {
          console.error('[API] structured search error:', e.message);
          return res.json({ data: [], structured: true, query: q });
        }
      }
    }

    const results = [];

    // Search IPAM addresses (IP, hostname, MAC)
    const ipam = await db.query(
      `SELECT
         a.ip_address::text, a.hostname, a.mac_address, a.status,
         host(s.network) as subnet, s.prefix_length, s.name as subnet_name,
         sn.name as supernet_name
       FROM ipam_addresses a
       JOIN ipam_subnets s ON s.id = a.subnet_id
       LEFT JOIN ipam_supernets sn ON sn.id = s.supernet_id
       WHERE
         a.ip_address::text ILIKE $1 OR
         a.hostname ILIKE $1 OR
         a.mac_address ILIKE $1
       LIMIT 20`,
      [`%${q}%`]
    );
    for (const r of ipam.rows) {
      results.push({
        type: 'ip',
        title: r.ip_address,
        subtitle: [r.hostname, r.mac_address, r.subnet + '/' + r.prefix_length].filter(Boolean).join(' · '),
        status: r.status,
        meta: { subnet: r.subnet, prefix: r.prefix_length, subnet_name: r.subnet_name },
      });
    }

    // Search subnets (network, name, description, site)
    const subnets = await db.query(
      `SELECT host(network) as network, prefix_length, name, description, site, gateway::text
       FROM ipam_subnets
       WHERE
         network::text ILIKE $1 OR
         name ILIKE $1 OR
         site ILIKE $1 OR
         description ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    for (const r of subnets.rows) {
      results.push({
        type: 'subnet',
        title: r.network + '/' + r.prefix_length,
        subtitle: [r.name, r.site, r.description].filter(Boolean).join(' · '),
        status: null,
        meta: { network: r.network, prefix: r.prefix_length },
      });
    }

    // Search supernets
    const supernets = await db.query(
      `SELECT host(network) as network, prefix_length, name, site
       FROM ipam_supernets
       WHERE network::text ILIKE $1 OR name ILIKE $1 OR site ILIKE $1
       LIMIT 5`,
      [`%${q}%`]
    );
    for (const r of supernets.rows) {
      results.push({
        type: 'supernet',
        title: r.network + '/' + r.prefix_length,
        subtitle: [r.name, r.site].filter(Boolean).join(' · '),
        status: null,
        meta: {},
      });
    }

    // Search DHCP scopes (scope_id like 172.24.215.0, or name like "TU-WiFi4")
    const scopes = await db.query(
      `SELECT sc.scope_id, sc.name, sc.start_range::text, sc.end_range::text,
              sc.percent_used, srv.hostname AS server_hostname
       FROM dhcp_scopes sc LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       WHERE sc.scope_id ILIKE $1 OR sc.name ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    for (const r of scopes.rows) {
      results.push({
        type: 'scope',
        title: r.scope_id,
        subtitle: [r.name, r.server_hostname, r.start_range + ' - ' + r.end_range].filter(Boolean).join(' · '),
        status: null,
        meta: { percent_used: r.percent_used },
      });
    }

    // Search DHCP leases
    const leases = await db.query(
      `SELECT ip_address::text, hostname, mac_address, address_state, scope_id
       FROM dhcp_leases
       WHERE
         ip_address::text ILIKE $1 OR
         hostname ILIKE $1 OR
         mac_address ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    for (const r of leases.rows) {
      results.push({
        type: 'lease',
        title: r.ip_address,
        subtitle: [r.hostname, r.mac_address, 'Scope: ' + r.scope_id].filter(Boolean).join(' · '),
        status: r.address_state,
        meta: {},
      });
    }

    // Search DNS records
    const dns = await db.query(
      `SELECT r.hostname, r.record_type, r.record_data, z.zone_name
       FROM dns_records r
       JOIN dns_zones z ON z.id = r.zone_id
       WHERE r.hostname ILIKE $1 OR r.record_data ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    for (const r of dns.rows) {
      results.push({
        type: 'dns',
        title: r.hostname + '.' + r.zone_name,
        subtitle: r.record_type + ' → ' + r.record_data,
        status: null,
        meta: {},
      });
    }

    res.json({ data: results, query: q, total: results.length });
  } catch (err) {
    console.error('[API] search error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Next available IP in a subnet ─────────────────────────────
app.get('/api/ipam/subnets/:id/next-ip', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const subnetRes = await db.query(
      'SELECT id, host(network) as network, prefix_length FROM ipam_subnets WHERE id=$1', [id]
    );
    if (!subnetRes.rows.length) return res.status(404).json({ error: 'Subnet not found' });
    const { network, prefix_length } = subnetRes.rows[0];

    // Get all used/reserved IPs in this subnet
    const usedRes = await db.query(
      `SELECT ip_address::text FROM ipam_addresses
       WHERE subnet_id=$1 AND status != 'available'
       ORDER BY ip_address`,
      [id]
    );
    const usedSet = new Set(usedRes.rows.map(r => r.ip_address));

    // Generate host IPs and find first available
    const parts  = network.split('.').map(Number);
    const hostCount = Math.pow(2, 32 - parseInt(prefix_length)) - 2;
    let base = (parts[0]<<24)|(parts[1]<<16)|(parts[2]<<8)|parts[3];
    base = base & (~0 << (32 - parseInt(prefix_length)));

    let nextIp = null;
    for (let i = 2; i <= hostCount; i++) { // start from .2 (skip gateway .1)
      const ip = base + i;
      const ipStr = `${(ip>>>24)&255}.${(ip>>>16)&255}.${(ip>>>8)&255}.${ip&255}`;
      if (!usedSet.has(ipStr)) { nextIp = ipStr; break; }
    }

    if (!nextIp) return res.json({ available: false, message: 'Subnet is full' });
    res.json({ available: true, ip: nextIp, subnet: network + '/' + prefix_length });
  } catch (err) {
    console.error('[API] next-ip error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Next available subnet in a supernet ───────────────────────
app.get('/api/ipam/supernets/:id/next-subnet', async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const prefix = parseInt(req.query.prefix || '24');

    const snRes = await db.query(
      'SELECT id, host(network) as network, prefix_length, site FROM ipam_supernets WHERE id=$1', [id]
    );
    if (!snRes.rows.length) return res.status(404).json({ error: 'Supernet not found' });
    const supernet = snRes.rows[0];

    // Get all existing subnets within this supernet
    const existingRes = await db.query(
      `SELECT host(network) as network, prefix_length FROM ipam_subnets
       WHERE network << ($1 || '/' || $2)::inet
       ORDER BY network`,
      [supernet.network, supernet.prefix_length]
    );

    // Get all OTHER supernets assigned to different sites (must not overlap)
    const otherSupernetsRes = await db.query(
      `SELECT host(network) as network, prefix_length, site FROM ipam_supernets
       WHERE id != $1 AND site IS NOT NULL AND site != $2`,
      [id, supernet.site || '']
    );

    const existingSet = new Set(
      existingRes.rows.map(r => r.network + '/' + r.prefix_length)
    );

    // Generate candidate subnets
    const snParts   = supernet.network.split('.').map(Number);
    const snBase    = (snParts[0]<<24)|(snParts[1]<<16)|(snParts[2]<<8)|snParts[3];
    const snMask    = ~0 << (32 - supernet.prefix_length);
    const snEnd     = (snBase & snMask) + (Math.pow(2, 32 - supernet.prefix_length)) - 1;
    const blockSize = Math.pow(2, 32 - prefix);

    let nextSubnet = null;
    for (let addr = (snBase & snMask); addr + blockSize - 1 <= snEnd; addr += blockSize) {
      const candidate = `${(addr>>>24)&255}.${(addr>>>16)&255}.${(addr>>>8)&255}.${addr&255}/${prefix}`;
      const candidateNet = candidate.split('/')[0];

      // Skip if already used
      if (existingSet.has(candidate)) continue;

      // Skip if overlaps with another site's supernet
      let blocked = false;
      for (const other of otherSupernetsRes.rows) {
        const otherParts = other.network.split('.').map(Number);
        const otherBase  = (otherParts[0]<<24)|(otherParts[1]<<16)|(otherParts[2]<<8)|otherParts[3];
        const otherMask  = ~0 << (32 - other.prefix_length);
        const otherEnd   = (otherBase & otherMask) + Math.pow(2, 32 - other.prefix_length) - 1;
        if (addr >= (otherBase & otherMask) && addr <= otherEnd) {
          blocked = true; break;
        }
      }
      if (blocked) continue;

      nextSubnet = candidate;
      break;
    }

    if (!nextSubnet) return res.json({ available: false, message: 'No available subnet blocks' });
    res.json({
      available: true,
      subnet: nextSubnet,
      prefix,
      supernet: supernet.network + '/' + supernet.prefix_length,
      site: supernet.site,
    });
  } catch (err) {
    console.error('[API] next-subnet error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Conflict detection ────────────────────────────────────────
app.get('/api/ipam/conflicts', async (req, res) => {
  try {
    const conflicts = await db.query(
      `SELECT
         a.id as id_a, host(a.network) as network_a, a.prefix_length as prefix_a, a.name as name_a, a.site as site_a,
         b.id as id_b, host(b.network) as network_b, b.prefix_length as prefix_b, b.name as name_b, b.site as site_b
       FROM ipam_subnets a
       JOIN ipam_subnets b ON a.id < b.id
       WHERE a.network::inet && b.network::inet`
    );
    res.json({ data: conflicts.rows, count: conflicts.rows.length });
  } catch (err) {
    console.error('[API] conflicts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Utilization history for all scopes (sparklines)
app.get('/api/scopes/history/all', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours || '168'); // default 7 days
    const rows = await db.query(
      `SELECT
         h.scope_id,
         s.scope_id as scope_network,
         s.name,
         h.percent_used,
         h.in_use,
         h.free,
         h.recorded_at
       FROM dhcp_scope_history h
       JOIN dhcp_scopes s ON s.id = h.scope_id
       WHERE h.recorded_at > NOW() - make_interval(hours => $1)
       ORDER BY h.scope_id, h.recorded_at ASC`,
      [hours]
    );

    // Group by scope
    const grouped = {};
    for (const row of rows.rows) {
      const key = row.scope_network;
      if (!grouped[key]) grouped[key] = { scope_id: row.scope_network, name: row.name, history: [] };
      grouped[key].history.push({
        percent_used: parseFloat(row.percent_used),
        in_use: row.in_use,
        recorded_at: row.recorded_at,
      });
    }
    res.json({ data: Object.values(grouped) });
  } catch (err) {
    console.error('[API] scope history all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════
// AUDIT LOG (internal API for the Audit Log tab)
// ════════════════════════════════════════════════════════════
function buildAuditFilters(q, allowedSiteIds) {
  const conds = [], vals = [];
  if (q.action)      { vals.push(q.action);             conds.push(`action = $${vals.length}`); }
  if (q.entity_type) { vals.push(q.entity_type);        conds.push(`entity_type = $${vals.length}`); }
  if (q.username)    { vals.push(q.username);           conds.push(`username = $${vals.length}`); }
  if (q.result)      { vals.push(q.result);             conds.push(`result = $${vals.length}`); }
  if (q.site_id)     { vals.push(parseInt(q.site_id));  conds.push(`site_id = $${vals.length}`); }
  if (q.from)        { vals.push(q.from);               conds.push(`timestamp >= $${vals.length}`); }
  if (q.to)          { vals.push(q.to);                 conds.push(`timestamp <= $${vals.length}`); }
  if (q.q) { vals.push(`%${q.q}%`); conds.push(`(entity_name ILIKE $${vals.length} OR change_summary ILIKE $${vals.length})`); }
  // Site-scope restriction for site_admin (null = unrestricted)
  if (allowedSiteIds != null) { vals.push(allowedSiteIds); conds.push(`site_id = ANY($${vals.length}::int[])`); }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', vals };
}

app.get('/api/audit', attachSiteFilter, async (req, res) => {
  try {
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const { where, vals } = buildAuditFilters(req.query, req.allowedSiteIds);
    const totalRes = await db.query(`SELECT COUNT(*) AS c FROM audit_log ${where}`, vals);
    const total = parseInt(totalRes.rows[0].c);
    const rows = await db.query(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limit, (page - 1) * limit]);
    res.json({ data: rows.rows, total, page, limit });
  } catch (err) {
    console.error('[API] audit list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/audit/stats', async (req, res) => {
  try {
    const [today, week, topUsers, topActions, topEntities] = await Promise.all([
      db.query("SELECT COUNT(*) AS c FROM audit_log WHERE timestamp >= date_trunc('day', NOW())"),
      db.query("SELECT COUNT(*) AS c FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days'"),
      db.query("SELECT username, COUNT(*) AS c FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY username ORDER BY c DESC LIMIT 5"),
      db.query("SELECT action, COUNT(*) AS c FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY action ORDER BY c DESC LIMIT 5"),
      db.query("SELECT entity_type, COUNT(*) AS c FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY entity_type ORDER BY c DESC LIMIT 5"),
    ]);
    res.json({
      today: parseInt(today.rows[0].c),
      week: parseInt(week.rows[0].c),
      top_user: topUsers.rows[0] ? topUsers.rows[0].username : '—',
      top_users: topUsers.rows,
      top_actions: topActions.rows,
      top_entity: topEntities.rows[0] ? topEntities.rows[0].entity_type : '—',
      top_entities: topEntities.rows,
    });
  } catch (err) {
    console.error('[API] audit stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/audit/export', requireSuperAdmin, async (req, res) => {
  try {
    const { where, vals } = buildAuditFilters(req.query);
    const rows = await db.query(`SELECT timestamp, username, user_role, action, entity_type, entity_name, change_summary, result, ip_address, duration_ms FROM audit_log ${where} ORDER BY timestamp DESC LIMIT 50000`, vals);
    const cols = ['timestamp', 'username', 'user_role', 'action', 'entity_type', 'entity_name', 'change_summary', 'result', 'ip_address', 'duration_ms'];
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(','), ...rows.rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
    if (req.audit) req.audit({ action: 'export', entity_type: 'audit_log', change_summary: `Exported ${rows.rows.length} audit rows as CSV` });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[API] audit export error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/audit/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM audit_log WHERE id = $1', [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Audit entry not found' });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] audit detail error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════
// API KEYS (management for the Settings tab)
// ════════════════════════════════════════════════════════════
app.get('/api/api-keys', requireSuperAdmin, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, key_prefix, name, description, created_by, created_at, last_used_at,
              expires_at, is_active, permissions, allowed_ips, request_count
         FROM api_keys ORDER BY created_at DESC`);
    res.json({ data: r.rows.map(k => ({ ...k, key_masked: maskedDisplay(k.key_prefix) })) });
  } catch (err) {
    console.error('[API] api-keys list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/api-keys', requireSuperAdmin, async (req, res) => {
  try {
    const { name, description, permissions, allowed_ips, expires_at } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const gen = generateKey();
    const perms = {
      read:  permissions ? !!permissions.read  : true,
      write: permissions ? !!permissions.write : false,
      admin: permissions ? !!permissions.admin : false,
    };
    const ips = Array.isArray(allowed_ips) ? allowed_ips.filter(Boolean)
      : (typeof allowed_ips === 'string' && allowed_ips.trim() ? allowed_ips.split(',').map(s => s.trim()).filter(Boolean) : null);
    const actor = req.headers['x-ddi-actor'] || 'admin';
    const r = await db.query(
      `INSERT INTO api_keys (key_hash, key_prefix, name, description, created_by, permissions, allowed_ips, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [gen.key_hash, gen.key_prefix, name, description || null, actor, JSON.stringify(perms), ips, expires_at || null]);
    if (req.audit) req.audit({ action: 'create', entity_type: 'api_key', entity_id: r.rows[0].id, entity_name: name, new_value: { name, permissions: perms, allowed_ips: ips } });
    // Full key returned ONCE — never stored or shown again.
    res.json({ id: r.rows[0].id, key: gen.key, key_prefix: gen.key_prefix, permissions: perms });
  } catch (err) {
    console.error('[API] api-keys create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/api-keys/:id', requireSuperAdmin, async (req, res) => {
  try {
    const r = await db.query('UPDATE api_keys SET is_active = FALSE WHERE id = $1 RETURNING name', [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Key not found' });
    if (req.audit) req.audit({ action: 'delete', entity_type: 'api_key', entity_id: req.params.id, entity_name: r.rows[0].name, change_summary: `Revoked API key "${r.rows[0].name}"` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] api-keys revoke error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════
// INFRASTRUCTURE HEALTH (HA, failover, SOA sync)
// ════════════════════════════════════════════════════════════
app.get('/api/infrastructure/health', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `AND s.site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const servers = await db.query(
      `SELECT s.id, s.hostname, host(s.ip_address) AS ip, s.role, s.is_active, s.poll_status,
              s.last_polled, s.health_score, s.health_checked_at, s.query_ms, s.winrm_test_ok, s.site_id,
              (SELECT COUNT(*) FROM dhcp_scopes sc WHERE sc.server_id = s.id) AS scope_count,
              (SELECT COUNT(*) FROM dhcp_leases l WHERE l.server_id = s.id) AS lease_count,
              (SELECT COUNT(*) FROM dns_zones z WHERE z.server_id = s.id) AS zone_count,
              (SELECT COALESCE(SUM(z.record_count),0) FROM dns_zones z WHERE z.server_id = s.id) AS record_count
         FROM ddi_servers s WHERE s.is_active = TRUE ${siteFilter} ORDER BY s.hostname`,
      params);
    // overall status
    const scores = servers.rows.map(s => s.health_score).filter(v => v != null);
    const worst = scores.length ? Math.min(...scores) : null;
    let overall = 'healthy';
    if (worst != null && worst < 70) overall = 'critical';
    else if (worst != null && worst < 90) overall = 'warning';
    else if (servers.rows.some(s => s.poll_status === 'error' || s.winrm_test_ok === false)) overall = 'warning';
    res.json({ data: servers.rows, overall, worst_score: worst });
  } catch (err) {
    console.error('[API] infra health error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/infrastructure/failover', async (req, res) => {
  try {
    const pairs = await db.query(
      `SELECT f.*, p.hostname AS primary_name, sec.hostname AS secondary_name
         FROM dhcp_failover_pairs f
         LEFT JOIN ddi_servers p   ON p.id   = f.primary_server_id
         LEFT JOIN ddi_servers sec ON sec.id = f.secondary_server_id
        ORDER BY f.relationship_name`);
    const sync = await db.query(
      `SELECT s.*, sc.scope_id AS scope_label FROM dhcp_scope_sync_status s
         LEFT JOIN dhcp_scopes sc ON sc.id = s.scope_id
        WHERE s.checked_at > NOW() - INTERVAL '1 day' ORDER BY s.checked_at DESC LIMIT 200`);
    res.json({ data: pairs.rows, sync: sync.rows });
  } catch (err) {
    console.error('[API] failover error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/infrastructure/servers/:id/history', async (req, res) => {
  try {
    const hours = safeHours(req.query.hours, 720);
    const r = await db.query(
      `SELECT health_score, winrm_ok, query_ms, soa_in_sync, recorded_at
         FROM server_health_history
        WHERE server_id = $1 AND recorded_at > NOW() - ($2 || ' hours')::interval
        ORDER BY recorded_at ASC`, [parseInt(req.params.id), hours]);
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[API] server health history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Distribution of IPAM address statuses (for dashboard donut)
app.get('/api/dashboard/ip-distribution', async (req, res) => {
  try {
    const r = await db.query('SELECT status, COUNT(*) AS c FROM ipam_addresses GROUP BY status');
    const out = { available: 0, dhcp: 0, reserved: 0, unknown: 0, offline: 0 };
    r.rows.forEach(row => { out[row.status] = parseInt(row.c); });
    res.json({ data: out });
  } catch (err) {
    console.error('[API] ip-distribution error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Lease trend over last N days (for dashboard line chart)
app.get('/api/dashboard/lease-trend', async (req, res) => {
  try {
    const days = safeInt(req.query.days, 7, 90);
    const r = await db.query(
      `SELECT date_trunc('day', recorded_at) AS day, ROUND(AVG(in_use)) AS leases
         FROM dhcp_scope_history
        WHERE recorded_at > NOW() - ($1 || ' days')::interval
        GROUP BY day ORDER BY day ASC`, [days]);
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[API] lease-trend error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Reports router + public REST API v1 ───────────────────────
app.use('/api/reports', createReportsRouter(db));
app.use('/api/v1', createV1Router({ db, psWrite, getServerWithAuth }));

// ── Generic error handler ─────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[API Error]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Sync all active server IPs to WinRM TrustedHosts on startup ───
async function syncTrustedHosts() {
  try {
    const { addToTrustedHosts } = require('../collector/powershellRunner');
    const result = await db.query('SELECT ip_address::text FROM ddi_servers WHERE is_active = TRUE');
    for (const row of result.rows) {
      if (row.ip_address) addToTrustedHosts(row.ip_address);
    }
    console.log(`[TrustedHosts] Synced ${result.rows.length} server IPs on startup`);
  } catch (err) {
    console.error('[TrustedHosts] Startup sync failed:', err.message);
  }
}
syncTrustedHosts();
// One-time startup recovery: clear scans left stuck from a previous run/crash.
async function clearStuckScansOnStartup() {
  try {
    await db.query(`
      UPDATE ipam_subnets SET scan_status='error'
      WHERE scan_status='scanning' AND last_scanned < NOW() - INTERVAL '1 hour'`);
    await db.query(`
      UPDATE ipam_scan_jobs SET status='error', error_msg='Scan timed out - auto-cleared on restart'
      WHERE status='running' AND started_at < NOW() - INTERVAL '30 minutes'`);
  } catch (err) {
    console.error('[ScanExpiry] startup clear failed:', err.message);
  }
  await expireStuckScans();
}
clearStuckScansOnStartup();

// License: check on startup + refresh every 24h
getLicense(true).then(lic => {
  const state = getLicenseState(lic);
  if (state.disabled) console.warn('[License] DDIVault license expired — running in disabled mode');
  else console.log(`[License] Status: ${lic?.status || 'unreachable'}, mode: ${state.mode}`);
}).catch(() => {});
setInterval(() => getLicense(true).catch(() => {}), 24 * 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] DDIVault API running on http://127.0.0.1:${PORT}`);
});
