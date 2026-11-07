'use strict';

/**
 * v1.js — Public, versioned REST API for DDIVault (/api/v1/*)
 *
 * Authenticated with API keys (see middleware/apiAuth.js). Every response uses
 * the consistent envelope:
 *   { success, data, meta, timestamp, request_id }
 * Errors:
 *   { success: false, error: { code, message, details }, timestamp, request_id }
 *
 * Built as a factory so it can share the API's db pool / PowerShell helpers.
 */

const express = require('express');
const { apiAuth } = require('./middleware/apiAuth');
// Envelope + the generic 500. `internalError` logs the real error and returns a
// fixed message — never `e.message`, which carries raw Postgres text (table,
// column and constraint names) straight to an API-key holder.
const { reqId, ok, fail, pageMeta, internalError } = require('./v1-envelope');

// Validate a value that will land in an UNQUOTED numeric position inside a generated
// PowerShell script (see psq/psNum in collector/powershellRunner.js). psNum there is the
// backstop that guarantees only digits reach the DNS server; this is the guard that tells
// an API caller their input was wrong instead of silently substituting a default.
// Returns the integer, or null when the value is unusable.
function intInRange(v, min, max) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

const TTL_MIN = 1;
const TTL_MAX = 2147483647;

function createV1Router(deps) {
  const { db, psWrite, getServerWithAuth } = deps;
  const router = express.Router();

  // Assign a request id to every v1 request (used in envelope + audit)
  router.use((req, _res, next) => { req.requestId = reqId(); next(); });

  // ── Unauthenticated meta endpoints ──────────────────────────
  router.get('/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      ok(res, { status: 'ok', db: 'connected' });
    } catch {
      fail(res, 503, 'DB_UNAVAILABLE', 'Database is not reachable');
    }
  });
  router.get('/version', (req, res) => {
    ok(res, { product: 'DDIVault', api_version: 'v1', version: '1.0.0' });
  });

  const read = apiAuth(db, 'read');
  const write = apiAuth(db, 'write');
  // `admin` is NOT just "write + a bit" here — apiAuth satisfies any required
  // permission when the key holds `admin`, so this is the only gate a key cannot
  // reach by holding `read` or `write`. Reserved for the whole-instance audit
  // dump; see the comment on GET /audit below.
  const admin = apiAuth(db, 'admin');

  // helper for pagination params
  const pg = (req) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
    return { page, limit, offset: (page - 1) * limit };
  };

  // ════════════════════ IPAM ════════════════════
  router.get('/subnets', read, async (req, res) => {
    try {
      const { page, limit, offset } = pg(req);
      const total = parseInt((await db.query('SELECT COUNT(*) c FROM ipam_subnets')).rows[0].c);
      const r = await db.query(
        `SELECT id, host(network) AS network, prefix_length, name, description, host(gateway) AS gateway,
                vlan_id, site, owner, total_hosts, used_hosts, free_hosts, unknown_hosts, last_scanned
           FROM ipam_subnets ORDER BY network LIMIT $1 OFFSET $2`, [limit, offset]);
      ok(res, r.rows, pageMeta(total, page, limit));
    } catch (e) { internalError(res, 'GET /subnets', e); }
  });

  router.get('/subnets/:id', read, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, host(network) AS network, prefix_length, name, description, host(gateway) AS gateway,
                vlan_id, site, owner, total_hosts, used_hosts, free_hosts, unknown_hosts, last_scanned
           FROM ipam_subnets WHERE id=$1`, [parseInt(req.params.id)]);
      if (!r.rows.length) return fail(res, 404, 'SUBNET_NOT_FOUND', `Subnet with ID ${req.params.id} was not found`);
      ok(res, r.rows[0]);
    } catch (e) { internalError(res, 'GET /subnets/:id', e); }
  });

  router.post('/subnets', write, async (req, res) => {
    try {
      const { network, prefix_length, name, description, gateway, vlan_id, site, owner } = req.body;
      if (!network || !prefix_length) return fail(res, 400, 'VALIDATION_ERROR', 'network and prefix_length are required');
      const r = await db.query(
        `INSERT INTO ipam_subnets (network, prefix_length, name, description, gateway, vlan_id, site, owner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [network, parseInt(prefix_length), name || null, description || null, gateway || null, vlan_id || null, site || null, owner || null]);
      if (req.audit) req.audit({ action: 'create', entity_type: 'subnet', entity_id: r.rows[0].id, entity_name: `${network}/${prefix_length}`, new_value: req.body, username: `apikey:${req.apiKey.name}` });
      ok(res, { id: r.rows[0].id });
    } catch (e) {
      if (e.code === '23505') return fail(res, 409, 'SUBNET_EXISTS', 'A subnet with this network/prefix already exists');
      internalError(res, 'POST /subnets', e);
    }
  });

  router.put('/subnets/:id', write, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const fields = ['name', 'description', 'gateway', 'vlan_id', 'site', 'owner'];
      const sets = [], vals = [];
      fields.forEach(f => { if (f in req.body) { vals.push(req.body[f]); sets.push(`${f}=$${vals.length}`); } });
      if (!sets.length) return fail(res, 400, 'VALIDATION_ERROR', 'No updatable fields provided');
      vals.push(id);
      const r = await db.query(`UPDATE ipam_subnets SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING id`, vals);
      if (!r.rows.length) return fail(res, 404, 'SUBNET_NOT_FOUND', `Subnet ${id} not found`);
      if (req.audit) req.audit({ action: 'modify', entity_type: 'subnet', entity_id: id, new_value: req.body, username: `apikey:${req.apiKey.name}` });
      ok(res, { id });
    } catch (e) { internalError(res, 'PUT /subnets/:id', e); }
  });

  router.delete('/subnets/:id', write, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const r = await db.query('DELETE FROM ipam_subnets WHERE id=$1 RETURNING host(network) AS network, prefix_length', [id]);
      if (!r.rows.length) return fail(res, 404, 'SUBNET_NOT_FOUND', `Subnet ${id} not found`);
      if (req.audit) req.audit({ action: 'delete', entity_type: 'subnet', entity_id: id, entity_name: `${r.rows[0].network}/${r.rows[0].prefix_length}`, username: `apikey:${req.apiKey.name}` });
      ok(res, { id });
    } catch (e) { internalError(res, 'DELETE /subnets/:id', e); }
  });

  router.get('/subnets/:id/addresses', read, async (req, res) => {
    try {
      const { page, limit, offset } = pg(req);
      const id = parseInt(req.params.id);
      const total = parseInt((await db.query('SELECT COUNT(*) c FROM ipam_addresses WHERE subnet_id=$1', [id])).rows[0].c);
      const r = await db.query(
        `SELECT host(ip_address) AS ip_address, status, hostname, mac_address, last_seen, ping_ms
           FROM ipam_addresses WHERE subnet_id=$1 ORDER BY ip_address LIMIT $2 OFFSET $3`, [id, limit, offset]);
      ok(res, r.rows, pageMeta(total, page, limit));
    } catch (e) { internalError(res, 'GET /subnets/:id/addresses', e); }
  });

  router.get('/subnets/:id/next-ip', read, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const r = await db.query(
        `SELECT host(a.ip_address) AS ip FROM ipam_addresses a
          WHERE a.subnet_id=$1 AND a.status='available' ORDER BY a.ip_address LIMIT 1`, [id]);
      if (!r.rows.length) return fail(res, 404, 'NO_FREE_IP', 'No available IP found in this subnet (run a scan first)');
      ok(res, { next_ip: r.rows[0].ip });
    } catch (e) { internalError(res, 'GET /subnets/:id/next-ip', e); }
  });

  router.get('/supernets', read, async (req, res) => {
    try {
      const r = await db.query('SELECT id, host(network) AS network, prefix_length, name, description, site FROM ipam_supernets ORDER BY network');
      ok(res, r.rows, { total: r.rows.length });
    } catch (e) { internalError(res, 'GET /supernets', e); }
  });

  router.get('/supernets/:id/next-subnet', read, async (req, res) => {
    try {
      const prefix = parseInt(req.query.prefix || '24');
      const r = await db.query('SELECT host(network) AS network, prefix_length FROM ipam_supernets WHERE id=$1', [parseInt(req.params.id)]);
      if (!r.rows.length) return fail(res, 404, 'SUPERNET_NOT_FOUND', 'Supernet not found');
      // delegate detailed allocation to internal helper if present; otherwise advisory
      ok(res, { supernet: `${r.rows[0].network}/${r.rows[0].prefix_length}`, requested_prefix: prefix, hint: 'Use the internal allocation endpoint for an exact free block.' });
    } catch (e) { internalError(res, 'GET /supernets/:id/next-subnet', e); }
  });

  // ════════════════════ DNS ════════════════════
  router.get('/dns/zones', read, async (req, res) => {
    try {
      const r = await db.query('SELECT z.id, z.zone_name, z.zone_type, z.is_reverse, z.record_count, srv.hostname AS server FROM dns_zones z JOIN ddi_servers srv ON srv.id=z.server_id ORDER BY z.zone_name');
      ok(res, r.rows, { total: r.rows.length });
    } catch (e) { internalError(res, 'GET /dns/zones', e); }
  });

  router.post('/dns/zones', write, async (req, res) => {
    try {
      const { server_id, zone_name, zone_type, replication_scope } = req.body;
      if (!server_id || !zone_name) return fail(res, 400, 'VALIDATION_ERROR', 'server_id and zone_name are required');
      const srv = await getServerWithAuth(server_id);
      if (!srv) return fail(res, 404, 'SERVER_NOT_FOUND', 'DNS server not found');
      const okp = await psWrite.addDnsZone(srv.ip, zone_name, zone_type || 'Primary', replication_scope || 'Forest', srv.auth);
      if (!okp) return fail(res, 502, 'DNS_OP_FAILED', 'Zone creation failed on the DNS server');
      if (req.audit) req.audit({ action: 'create', entity_type: 'dns_zone', entity_name: zone_name, server_id, new_value: req.body, username: `apikey:${req.apiKey.name}` });
      ok(res, { zone_name });
    } catch (e) { internalError(res, 'POST /dns/zones', e); }
  });

  router.delete('/dns/zones/:id', write, async (req, res) => {
    try {
      const z = await db.query('SELECT z.zone_name, z.server_id FROM dns_zones z WHERE z.id=$1', [parseInt(req.params.id)]);
      if (!z.rows.length) return fail(res, 404, 'ZONE_NOT_FOUND', 'Zone not found');
      const srv = await getServerWithAuth(z.rows[0].server_id);
      if (!srv) return fail(res, 404, 'SERVER_NOT_FOUND', 'DNS server not found');
      const okp = await psWrite.removeDnsZone(srv.ip, z.rows[0].zone_name, srv.auth);
      if (!okp) return fail(res, 502, 'DNS_OP_FAILED', 'Zone deletion failed on the DNS server');
      await db.query('DELETE FROM dns_zones WHERE id=$1', [parseInt(req.params.id)]).catch(() => {});
      if (req.audit) req.audit({ action: 'delete', entity_type: 'dns_zone', entity_name: z.rows[0].zone_name, username: `apikey:${req.apiKey.name}` });
      ok(res, { id: parseInt(req.params.id) });
    } catch (e) { internalError(res, 'DELETE /dns/zones/:id', e); }
  });

  router.get('/dns/records', read, async (req, res) => {
    try {
      const { page, limit, offset } = pg(req);
      const conds = [], vals = [];
      if (req.query.zone_id) { vals.push(parseInt(req.query.zone_id)); conds.push(`r.zone_id=$${vals.length}`); }
      if (req.query.type) { vals.push(req.query.type); conds.push(`r.record_type=$${vals.length}`); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = parseInt((await db.query(`SELECT COUNT(*) c FROM dns_records r ${where}`, vals)).rows[0].c);
      vals.push(limit, offset);
      const r = await db.query(
        `SELECT r.id, r.hostname, r.record_type, r.record_data, r.ttl, z.zone_name
           FROM dns_records r JOIN dns_zones z ON z.id=r.zone_id ${where}
          ORDER BY r.hostname LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
      ok(res, r.rows, pageMeta(total, page, limit));
    } catch (e) { internalError(res, 'GET /dns/records', e); }
  });

  router.post('/dns/records', write, async (req, res) => {
    try {
      const { server_id, zone_name, hostname, record_type, record_data, ttl } = req.body;
      if (!server_id || !zone_name || !hostname || !record_type || !record_data)
        return fail(res, 400, 'VALIDATION_ERROR', 'server_id, zone_name, hostname, record_type and record_data are required');
      const srv = await getServerWithAuth(server_id);
      if (!srv) return fail(res, 404, 'SERVER_NOT_FOUND', 'DNS server not found');
      // ttl is interpolated into an unquoted `New-TimeSpan -Seconds N` position by the
      // PowerShell builder — validate it here rather than passing it through raw
      // (server.js's equivalent route does the same).
      const ttlSec = (ttl === null || ttl === undefined || ttl === '')
        ? 3600
        : intInRange(ttl, TTL_MIN, TTL_MAX);
      if (ttlSec === null)
        return fail(res, 400, 'VALIDATION_ERROR', `ttl must be an integer between ${TTL_MIN} and ${TTL_MAX} seconds`);
      let okp = false;
      const t = String(record_type).toUpperCase();
      if (t === 'A') okp = await psWrite.addDnsARecord(srv.ip, zone_name, hostname, record_data, ttlSec, srv.auth);
      else if (t === 'CNAME') okp = await psWrite.addDnsCNameRecord(srv.ip, zone_name, hostname, record_data, ttlSec, srv.auth);
      else if (t === 'TXT') okp = await psWrite.addDnsTxtRecord(srv.ip, zone_name, hostname, record_data, ttlSec, srv.auth);
      else return fail(res, 400, 'UNSUPPORTED_TYPE', `Record type ${t} is not supported via the API`);
      if (!okp) return fail(res, 502, 'DNS_OP_FAILED', 'Record creation failed on the DNS server');
      if (req.audit) req.audit({ action: 'create', entity_type: 'dns_record', entity_name: `${hostname} ${t}`, server_id, new_value: req.body, username: `apikey:${req.apiKey.name}` });
      ok(res, { hostname, record_type: t });
    } catch (e) { internalError(res, 'POST /dns/records', e); }
  });

  router.delete('/dns/records/:id', write, async (req, res) => {
    try {
      const r = await db.query('SELECT r.hostname, r.record_type, r.record_data, z.zone_name, z.server_id FROM dns_records r JOIN dns_zones z ON z.id=r.zone_id WHERE r.id=$1', [parseInt(req.params.id)]);
      if (!r.rows.length) return fail(res, 404, 'RECORD_NOT_FOUND', 'Record not found');
      const rec = r.rows[0];
      const srv = await getServerWithAuth(rec.server_id);
      if (!srv) return fail(res, 404, 'SERVER_NOT_FOUND', 'DNS server not found');
      const okp = await psWrite.removeDnsRecord(srv.ip, rec.zone_name, rec.hostname, rec.record_type, rec.record_data, srv.auth);
      if (!okp) return fail(res, 502, 'DNS_OP_FAILED', 'Record deletion failed on the DNS server');
      await db.query('DELETE FROM dns_records WHERE id=$1', [parseInt(req.params.id)]).catch(() => {});
      if (req.audit) req.audit({ action: 'delete', entity_type: 'dns_record', entity_name: `${rec.hostname} ${rec.record_type}`, username: `apikey:${req.apiKey.name}` });
      ok(res, { id: parseInt(req.params.id) });
    } catch (e) { internalError(res, 'DELETE /dns/records/:id', e); }
  });

  // ════════════════════ DHCP ════════════════════
  router.get('/scopes', read, async (req, res) => {
    try {
      const r = await db.query('SELECT sc.id, sc.scope_id, sc.name, sc.in_use, sc.total_ips, sc.free, sc.percent_used, sc.state, srv.hostname AS server FROM dhcp_scopes sc JOIN ddi_servers srv ON srv.id=sc.server_id ORDER BY sc.percent_used DESC');
      ok(res, r.rows, { total: r.rows.length });
    } catch (e) { internalError(res, 'GET /scopes', e); }
  });

  router.get('/leases', read, async (req, res) => {
    try {
      const { page, limit, offset } = pg(req);
      const conds = [], vals = [];
      if (req.query.ip) { vals.push(req.query.ip); conds.push(`host(ip_address)=$${vals.length}`); }
      if (req.query.mac) { vals.push(req.query.mac); conds.push(`mac_address ILIKE $${vals.length}`); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = parseInt((await db.query(`SELECT COUNT(*) c FROM dhcp_leases ${where}`, vals)).rows[0].c);
      vals.push(limit, offset);
      const r = await db.query(
        `SELECT id, host(ip_address) AS ip_address, hostname, mac_address, scope_id, address_state, lease_expiry
           FROM dhcp_leases ${where} ORDER BY ip_address LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
      ok(res, r.rows, pageMeta(total, page, limit));
    } catch (e) { internalError(res, 'GET /leases', e); }
  });

  router.post('/dhcp/reservations', write, async (req, res) => {
    try {
      const { server_id, scope_id, ip_address, mac_address, name } = req.body;
      if (!server_id || !scope_id || !ip_address || !mac_address)
        return fail(res, 400, 'VALIDATION_ERROR', 'server_id, scope_id, ip_address and mac_address are required');
      const srv = await getServerWithAuth(server_id);
      if (!srv) return fail(res, 404, 'SERVER_NOT_FOUND', 'DHCP server not found');
      const okp = await psWrite.addDhcpReservation(srv.ip, scope_id, ip_address, mac_address, name || ip_address, srv.auth);
      if (!okp) return fail(res, 502, 'DHCP_OP_FAILED', 'Reservation creation failed on the DHCP server');
      if (req.audit) req.audit({ action: 'reserve', entity_type: 'dhcp_reservation', entity_name: ip_address, server_id, new_value: req.body, username: `apikey:${req.apiKey.name}` });
      ok(res, { ip_address, mac_address });
    } catch (e) { internalError(res, 'POST /dhcp/reservations', e); }
  });

  router.delete('/dhcp/reservations/:id', write, async (req, res) => {
    try {
      // :id is the dhcp_leases row id (reservation)
      const r = await db.query('SELECT host(ip_address) AS ip, scope_id, server_id FROM dhcp_leases WHERE id=$1', [parseInt(req.params.id)]);
      if (!r.rows.length) return fail(res, 404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
      const lease = r.rows[0];
      const srv = await getServerWithAuth(lease.server_id);
      if (!srv) return fail(res, 404, 'SERVER_NOT_FOUND', 'DHCP server not found');
      const okp = await psWrite.removeDhcpReservation(srv.ip, lease.scope_id, lease.ip, srv.auth);
      if (!okp) return fail(res, 502, 'DHCP_OP_FAILED', 'Reservation removal failed on the DHCP server');
      if (req.audit) req.audit({ action: 'release', entity_type: 'dhcp_reservation', entity_name: lease.ip, username: `apikey:${req.apiKey.name}` });
      ok(res, { id: parseInt(req.params.id) });
    } catch (e) { internalError(res, 'DELETE /dhcp/reservations/:id', e); }
  });

  // ════════════════════ Search ════════════════════
  router.get('/search', read, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) return ok(res, []);
      const like = `%${q}%`;
      const [subnets, leases, records] = await Promise.all([
        db.query(`SELECT 'subnet' AS type, id, host(network)||'/'||prefix_length AS label, name FROM ipam_subnets WHERE host(network) ILIKE $1 OR name ILIKE $1 LIMIT 20`, [like]),
        db.query(`SELECT 'lease' AS type, id, host(ip_address) AS label, hostname AS name FROM dhcp_leases WHERE host(ip_address) ILIKE $1 OR hostname ILIKE $1 OR mac_address ILIKE $1 LIMIT 20`, [like]),
        db.query(`SELECT 'dns_record' AS type, id, hostname AS label, record_type AS name FROM dns_records WHERE hostname ILIKE $1 OR record_data ILIKE $1 LIMIT 20`, [like]),
      ]);
      ok(res, [...subnets.rows, ...leases.rows, ...records.rows]);
    } catch (e) { internalError(res, 'GET /search', e); }
  });

  // ════════════════════ Audit ════════════════════
  // ⛔ `admin`, not `read`. This returns the ENTIRE audit_log — username,
  // action, entity_type, entity_name, change_summary — for every site, and no
  // v1 route is site-scoped (api/middleware/rbac.js collapses a key to
  // 'admin'/'viewer' and `getAllowedSiteIds` returns null for both, and
  // `api_keys` has no site column). So on `read` a key provisioned to list
  // subnets also got more than any session user can obtain: the session-side
  // equivalents are stricter — `GET /api/audit` is `attachSiteFilter`
  // (site-scoped) and the comparable whole-table dump `GET /api/audit/export`
  // is `requireSuperAdmin`. `admin` is this surface's nearest analogue of
  // super_admin.
  router.get('/audit', admin, async (req, res) => {
    try {
      const { page, limit, offset } = pg(req);
      const total = parseInt((await db.query('SELECT COUNT(*) c FROM audit_log')).rows[0].c);
      const r = await db.query(
        `SELECT id, timestamp, username, action, entity_type, entity_name, change_summary, result
           FROM audit_log ORDER BY timestamp DESC LIMIT $1 OFFSET $2`, [limit, offset]);
      ok(res, r.rows, pageMeta(total, page, limit));
    } catch (e) { internalError(res, 'GET /audit', e); }
  });

  // catch-all 404 inside v1
  router.use((req, res) => fail(res, 404, 'NOT_FOUND', `No such endpoint: ${req.method} ${req.originalUrl}`));

  return router;
}

module.exports = { createV1Router };
