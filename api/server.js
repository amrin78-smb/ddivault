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

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: 'http://localhost:3006' }));
app.use(express.json());

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
app.get('/api/scopes', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT sc.*, srv.hostname as server_hostname, srv.ip_address as server_ip
       FROM dhcp_scopes sc
       LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       ORDER BY sc.percent_used DESC, sc.scope_id`
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

app.post('/api/subnets', async (req, res) => {
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

app.put('/api/subnets/:id', async (req, res) => {
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

app.delete('/api/subnets/:id', async (req, res) => {
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
app.get('/api/dns/zones', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT z.*, s.hostname as server_hostname
       FROM dns_zones z
       LEFT JOIN ddi_servers s ON s.id = z.server_id
       ORDER BY z.is_reverse ASC, z.zone_name`
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

app.post('/api/alerts/:id/acknowledge', async (req, res) => {
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

app.post('/api/alerts/acknowledge-all', async (req, res) => {
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

app.put('/api/alert-rules/:id', async (req, res) => {
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

// ── Servers (enhanced with auth) ──────────────────────────────
app.get('/api/servers', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, hostname, ip_address::text as ip_address, role, description,
              is_active, last_polled, poll_status, poll_error,
              auth_mode, ps_username, winrm_port, winrm_https,
              winrm_test_ok, winrm_tested_at, notes, site_id,
              created_at, updated_at
       FROM ddi_servers ORDER BY created_at DESC`
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

app.post('/api/servers', async (req, res) => {
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
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] server create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/servers/:id', async (req, res) => {
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
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] server update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/servers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM ddi_servers WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] server delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test WinRM connection for a server
app.post('/api/servers/:id/test-connection', async (req, res) => {
  try {
    const id  = parseInt(req.params.id);
    const serverData = await getServerWithAuth(id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    console.log(`[API] Testing WinRM connection to ${ip} (mode=${auth.auth_mode})...`);
    const result = psWrite.testWinRM(ip, auth);

    // Update test result in DB
    await db.query(
      `UPDATE ddi_servers SET winrm_test_ok=$2, winrm_tested_at=NOW(), poll_error=$3 WHERE id=$1`,
      [id, result.ok, result.error || null]
    );

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

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, value || '']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] settings update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Supernets ─────────────────────────────────────────
app.get('/api/ipam/supernets', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT s.*,
         COUNT(sub.id) as subnet_count,
         COALESCE(SUM(sub.total_hosts),0) as total_hosts,
         COALESCE(SUM(sub.used_hosts),0)  as used_hosts,
         COALESCE(SUM(sub.free_hosts),0)  as free_hosts
       FROM ipam_supernets s
       LEFT JOIN ipam_subnets sub ON sub.supernet_id = s.id
       GROUP BY s.id
       ORDER BY s.network`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] supernets error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/supernets', async (req, res) => {
  try {
    const { network, prefix_length, name, description, site } = req.body;
    if (!network || !prefix_length) return res.status(400).json({ error: 'network and prefix_length required' });
    const result = await db.query(
      `INSERT INTO ipam_supernets (network, prefix_length, name, description, site)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (network, prefix_length) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, site=EXCLUDED.site, updated_at=NOW()
       RETURNING *`,
      [network, parseInt(prefix_length), name||null, description||null, site||null]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] supernet create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ipam/supernets/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM ipam_supernets WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] supernet delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Subnets (enhanced) ────────────────────────────────
app.get('/api/ipam/subnets', async (req, res) => {
  try {
    const supernet_id = req.query.supernet_id;
    const params = [];
    let where = '';
    if (supernet_id) {
      params.push(parseInt(supernet_id));
      where = 'WHERE s.supernet_id = $1';
    }
    const rows = await db.query(
      `SELECT s.*,
         sn.name as supernet_name,
         sn.network::text as supernet_network,
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

app.post('/api/ipam/subnets', async (req, res) => {
  try {
    const { network, prefix_length, name, description, gateway, vlan_id,
            site, owner, supernet_id, location, notes } = req.body;
    if (!network || !prefix_length) return res.status(400).json({ error: 'network and prefix_length required' });
    const totalHosts = Math.max(0, Math.pow(2, 32 - parseInt(prefix_length)) - 2);
    const result = await db.query(
      `INSERT INTO ipam_subnets
         (network, prefix_length, name, description, gateway, vlan_id, site, owner,
          supernet_id, location, notes, is_managed, total_hosts, free_hosts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12,$12)
       ON CONFLICT (network, prefix_length) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         gateway=EXCLUDED.gateway, vlan_id=EXCLUDED.vlan_id,
         site=EXCLUDED.site, owner=EXCLUDED.owner,
         supernet_id=EXCLUDED.supernet_id, location=EXCLUDED.location,
         notes=EXCLUDED.notes, updated_at=NOW()
       RETURNING *`,
      [network, parseInt(prefix_length), name||null, description||null,
       gateway||null, vlan_id?parseInt(vlan_id):null, site||null, owner||null,
       supernet_id?parseInt(supernet_id):null, location||null, notes||null, totalHosts]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] ipam subnet create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/ipam/subnets/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, gateway, vlan_id, site, owner, supernet_id, location, notes } = req.body;
    const result = await db.query(
      `UPDATE ipam_subnets SET
         name=$2, description=$3, gateway=$4, vlan_id=$5, site=$6, owner=$7,
         supernet_id=$8, location=$9, notes=$10, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id, name||null, description||null, gateway||null,
       vlan_id?parseInt(vlan_id):null, site||null, owner||null,
       supernet_id?parseInt(supernet_id):null, location||null, notes||null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] ipam subnet update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ipam/subnets/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM ipam_subnets WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] ipam subnet delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — IP Addresses ───────────────────────────────────────
app.get('/api/ipam/subnets/:id/addresses', async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const status = req.query.status || '';
    const params = [id];
    let where = 'WHERE a.subnet_id = $1';
    if (status) { params.push(status); where += ` AND a.status = $${params.length}`; }
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
app.post('/api/ipam/subnets/:id/addresses/:ip/reserve', async (req, res) => {
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
    res.json({ success: true });
  } catch (err) {
    console.error('[API] reserve ip error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Release a reserved IP
app.post('/api/ipam/subnets/:id/addresses/:ip/release', async (req, res) => {
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
    res.json({ success: true });
  } catch (err) {
    console.error('[API] release ip error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Scan ───────────────────────────────────────────────
const { scanAllSubnets } = require('../collector/ipamScanner');
const scanningSubnets = new Set(); // prevent concurrent scans of same subnet

app.post('/api/ipam/subnets/:id/scan', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (scanningSubnets.has(id)) {
      return res.status(409).json({ error: 'Scan already in progress for this subnet' });
    }
    const subnetRes = await db.query(
      'SELECT id, network::text, prefix_length, name FROM ipam_subnets WHERE id=$1', [id]
    );
    if (!subnetRes.rows.length) return res.status(404).json({ error: 'Subnet not found' });
    const subnet = subnetRes.rows[0];

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

app.post('/api/ipam/scan-all', async (req, res) => {
  try {
    res.json({ success: true, message: 'Full IPAM scan started' });
    scanAllSubnets().catch(err => console.error('[API] scan-all error:', err.message));
  } catch (err) {
    console.error('[API] scan-all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/ipam/subnets/:id/scan-status', async (req, res) => {
  try {
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
    const scanning = [...scanningSubnets];
    const jobs = scanning.length > 0 ? await db.query(
      `SELECT j.*, s.network::text, s.prefix_length, s.name, s.total_hosts
       FROM ipam_scan_jobs j
       JOIN ipam_subnets s ON s.id = j.subnet_id
       WHERE j.subnet_id = ANY($1) AND j.status = 'running'
       ORDER BY j.started_at DESC`,
      [scanning]
    ) : { rows: [] };
    // Also get all subnet scan states
    const allSubnets = await db.query(
      `SELECT id, network::text, prefix_length, name, scan_status, last_scanned,
              total_hosts, used_hosts, free_hosts, unknown_hosts
       FROM ipam_subnets WHERE is_managed=TRUE ORDER BY network`
    );
    res.json({
      active_scans: scanning.length,
      scanning_ids: scanning,
      jobs: jobs.rows,
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

app.post('/api/ipam/vlans', async (req, res) => {
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

app.delete('/api/ipam/vlans/:id', async (req, res) => {
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
app.post('/api/dns/records', async (req, res) => {
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

    res.json({ success: true, message: `${record_type} record created: ${hostname} → ${record_data}` });
  } catch (err) {
    console.error('[API] dns add record error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete DNS record
app.delete('/api/dns/records', async (req, res) => {
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

    res.json({ success: true });
  } catch (err) {
    console.error('[API] dns delete record error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add DNS zone
app.post('/api/dns/zones', async (req, res) => {
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

    res.json({ success: true, message: `Zone ${zone_name} created` });
  } catch (err) {
    console.error('[API] dns add zone error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete DNS zone
app.delete('/api/dns/zones/:id', async (req, res) => {
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
app.post('/api/dhcp/reservations', async (req, res) => {
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

    res.json({ success: true, message: `Reservation created: ${ip_address} → ${mac_address}` });
  } catch (err) {
    console.error('[API] dhcp reservation error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove DHCP reservation
app.delete('/api/dhcp/reservations', async (req, res) => {
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
app.post('/api/ipam/import', async (req, res) => {
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

    res.json({ success: true, imported, skipped, errors });
  } catch (err) {
    console.error('[API] ipam import error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Generic error handler ─────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[API Error]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] DDIVault API running on http://127.0.0.1:${PORT}`);
});
