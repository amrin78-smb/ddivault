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

// ── Servers ───────────────────────────────────────────────────
app.get('/api/servers', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM ddi_servers ORDER BY created_at DESC');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] servers error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/servers', async (req, res) => {
  try {
    const { hostname, ip_address, role, description } = req.body;
    if (!hostname && !ip_address) return res.status(400).json({ error: 'hostname or ip_address required' });
    const result = await db.query(
      `INSERT INTO ddi_servers (hostname, ip_address, role, description)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [hostname || null, ip_address || null, role || 'both', description || null]
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
    const { hostname, ip_address, role, description, is_active } = req.body;
    const result = await db.query(
      `UPDATE ddi_servers SET hostname=$1, ip_address=$2, role=$3,
              description=$4, is_active=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [hostname || null, ip_address || null, role || 'both',
       description || null, is_active !== false, id]
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
    const id = parseInt(req.params.id);
    await db.query('DELETE FROM ddi_servers WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] server delete error:', err.message);
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

// ── Generic error handler ─────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[API Error]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] DDIVault API running on http://127.0.0.1:${PORT}`);
});
