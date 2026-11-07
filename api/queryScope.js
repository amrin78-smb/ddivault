'use strict';

/**
 * queryScope.js — the site-scoping primitives, in one dependency-free place.
 *
 * `req.allowedSiteIds` (set by `attachSiteFilter`, api/middleware/rbac.js) is
 * tri-state:
 *   null  → no restriction (super_admin / admin / viewer)
 *   []    → restricted to nothing
 *   [...] → restricted to those site ids (site_admin)
 *
 * Everything here exists so that scoping decisions can be unit tested without a
 * database — see `tests/siteScoping.test.js`. Keep it free of `require`s.
 */

/**
 * May this row's site be shown to this caller?
 *
 * A row whose site is NULL is NOT visible to a site-restricted caller — fail
 * closed. (A DHCP lease with no `server_id`, for instance, cannot be attributed
 * to a site, so a site_admin must not see it.)
 */
function siteAllowed(allowedSiteIds, siteId) {
  if (allowedSiteIds === null || allowedSiteIds === undefined) return true;
  if (siteId == null) return false;
  return allowedSiteIds.includes(siteId);
}

/**
 * Build the site predicate for a query, pushing its bind parameter onto `params`.
 * Returns '' when the caller is unrestricted.
 *
 *   const params = [];
 *   const site = siteScopeSql(req.allowedSiteIds, 's.site_id', params);
 *   // → 's.site_id = ANY($1::int[])', params === [[3, 7]]
 *
 * `= ANY($n::int[])` is the established shape throughout this codebase — and an
 * empty array renders as `= ANY('{}')`, which matches nothing. So a caller
 * scoped to no sites sees no rows rather than all of them.
 */
function siteScopeSql(allowedSiteIds, column, params) {
  if (allowedSiteIds === null || allowedSiteIds === undefined) return '';
  params.push(allowedSiteIds);
  return `${column} = ANY($${params.length}::int[])`;
}

/**
 * The by-id read gate.
 *
 * ⛔ ABSENT AND OUT-OF-SCOPE MUST ANSWER IDENTICALLY. A 403 on out-of-scope
 * while absent answers 404 tells a caller which ids exist, so scope can be
 * mapped by walking small integers. Returns null when the row may be served,
 * otherwise the exact `{ status, body }` to send — one object for both cases, so
 * the two branches cannot drift apart.
 *
 * @param row   the fetched row, or undefined/null when there was none
 * @param allowedSiteIds  req.allowedSiteIds
 * @param message         the not-found message (e.g. 'Scope not found')
 * @param siteKey         the row property holding the site id (default 'site_id')
 */
function scopeGate(row, allowedSiteIds, message, siteKey) {
  const deny = { status: 404, body: { error: message } };
  if (!row) return deny;
  if (!siteAllowed(allowedSiteIds, row[siteKey || 'site_id'])) return deny;
  return null;
}

/**
 * WHERE clause for `GET /api/leases`.
 *
 * `dhcp_leases` carries no site column; its site is `server_id -> ddi_servers.
 * site_id`, so both the row query and the COUNT must join `ddi_servers s`.
 * (`ddi_servers.id` is the PK, so a LEFT JOIN cannot multiply rows and the COUNT
 * stays exact.)
 *
 * Returns `{ whereClause, params }`; the caller appends LIMIT/OFFSET params.
 */
function buildLeaseWhere(q, allowedSiteIds) {
  const params = [];
  const where = [];

  const search     = String((q && q.search) || '').trim();
  const scopeId    = String((q && q.scope) || '').trim();
  const state      = String((q && q.state) || '').trim();
  const deviceType = String((q && q.device_type) || '').trim();

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
  if (deviceType) {
    // 'unknown' also covers leases with no classification (NULL / empty).
    if (deviceType.toLowerCase() === 'unknown') {
      where.push(`(l.device_type IS NULL OR l.device_type = '' OR LOWER(l.device_type) = 'unknown')`);
    } else {
      params.push(deviceType);
      where.push(`LOWER(l.device_type) = LOWER($${params.length})`);
    }
  }

  const site = siteScopeSql(allowedSiteIds, 's.site_id', params);
  if (site) where.push(site);

  return { whereClause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

/**
 * `GET /api/leases/export` — the CSV of every lease.
 *
 * This had no filters of ANY kind (`SELECT … FROM dhcp_leases ORDER BY
 * ip_address`), so a site_admin scoped to one site downloaded every lease in
 * every site: IP, hostname, MAC, scope, state and lease window. Not even
 * pagination bounded it.
 */
function buildLeaseExportQuery(allowedSiteIds) {
  const params = [];
  const site = siteScopeSql(allowedSiteIds, 's.site_id', params);
  const sql =
    `SELECT l.ip_address, l.hostname, l.mac_address, l.scope_id, l.address_state,
            l.lease_start, l.lease_expiry, l.last_seen
       FROM dhcp_leases l
       LEFT JOIN ddi_servers s ON s.id = l.server_id
     ${site ? `WHERE ${site}` : ''}
      ORDER BY l.ip_address`;
  return { sql, params };
}

/** `GET /api/leases/ip/:ip/history` — `lease_history.server_id -> ddi_servers.site_id`. */
function buildLeaseHistoryQuery(ip, allowedSiteIds) {
  const params = [ip];
  const site = siteScopeSql(allowedSiteIds, 's.site_id', params);
  const sql =
    `SELECT h.*
       FROM lease_history h
       LEFT JOIN ddi_servers s ON s.id = h.server_id
      WHERE h.ip_address = $1${site ? ` AND ${site}` : ''}
      ORDER BY h.event_time DESC
      LIMIT 200`;
  return { sql, params };
}

module.exports = {
  siteAllowed,
  siteScopeSql,
  scopeGate,
  buildLeaseWhere,
  buildLeaseExportQuery,
  buildLeaseHistoryQuery,
};
