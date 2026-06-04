'use strict';

/**
 * rbac.js — Role-Based Access Control middleware for the DDIVault API
 *
 * Role hierarchy (from NetVault SSO — the single source of truth for roles):
 *   super_admin > admin > site_admin > viewer
 *
 * NetVault is authoritative for users AND roles. DDIVault never stores or
 * mutates roles — it only enforces them.
 *
 * Actor identity reaches this localhost-only API one of two ways:
 *   1. Web UI  — the Next.js frontend stamps every /api/* request with
 *                x-ddi-actor / x-ddi-actor-role / x-ddi-actor-id headers
 *                (see frontend/src/components/AuditActor.tsx). The role in
 *                that header originates from the signed NextAuth session,
 *                which in turn came from NetVault SSO.
 *   2. API key — the public /api/v1/* surface authenticates with an API key
 *                whose permissions (read/write/admin) map onto a role here.
 *
 * Site scoping: site_admin users may only see/modify objects belonging to the
 * sites listed for them in NetVault's user_sites table. super_admin / admin /
 * viewer are never site-restricted (viewer is read-only but global).
 */

const { Pool } = require('pg');

const netvaultDb = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432'),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  max: 3,
});

const ROLE_LEVELS = {
  super_admin: 4,
  admin:       3,
  site_admin:  2,
  viewer:      1,
};

function getRoleLevel(role) {
  return ROLE_LEVELS[role] || 0;
}

/**
 * Extract the acting user from a request.
 * Supports API-key auth (set by apiAuth) and header-based session auth.
 * Returns null when no identity is present.
 */
function getRequestUser(req) {
  // API key auth (set by apiAuth middleware on /api/v1/*)
  if (req.apiKey) {
    const perms = req.apiKey.permissions || {};
    return {
      id:   null,
      role: perms.admin ? 'admin' : perms.write ? 'admin' : 'viewer',
      name: `API Key: ${req.apiKey.name}`,
      isApiKey: true,
    };
  }

  // Session auth (web UI) — actor injected as request headers by the frontend.
  // Fall back to the audit middleware's parsed actor if present.
  const actor = req._auditActor || {};
  const role = req.headers['x-ddi-actor-role'] || actor.user_role || null;
  const id   = req.headers['x-ddi-actor-id']   || actor.user_id   || null;
  const name = req.headers['x-ddi-actor']       || actor.username  || null;

  // No identifying header at all → unauthenticated.
  if (!role && !id && (!name || name === 'system')) return null;

  return {
    id,
    role: role || 'viewer',
    name: name || 'user',
    isApiKey: false,
  };
}

/**
 * Require a minimum role level.
 * Usage: app.post('/api/servers', requireRole('admin'), handler)
 */
function requireRole(minRole) {
  return (req, res, next) => {
    const user = getRequestUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (getRoleLevel(user.role) < getRoleLevel(minRole)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: minRole,
        current: user.role,
      });
    }
    req.currentUser = user;
    next();
  };
}

/** Require write access (admin or super_admin). */
function requireWrite(req, res, next) {
  return requireRole('admin')(req, res, next);
}

/** Require super_admin only. */
function requireSuperAdmin(req, res, next) {
  return requireRole('super_admin')(req, res, next);
}

/** Allow read for all authenticated users (viewer and above). */
function requireAuth(req, res, next) {
  return requireRole('viewer')(req, res, next);
}

/**
 * Resolve the site IDs a user is allowed to see.
 * Returns null to mean "all sites" (no restriction).
 *   super_admin / admin → null  (all sites)
 *   viewer             → null  (sees all, but write is blocked elsewhere)
 *   site_admin         → array of site_ids from NetVault user_sites
 * Any other / unknown role is treated as unrestricted-read (null) so we never
 * accidentally hide all data from a legitimately authenticated user.
 */
async function getAllowedSiteIds(userId, role) {
  if (role === 'site_admin') {
    if (!userId) return [];
    try {
      const result = await netvaultDb.query(
        'SELECT site_id FROM user_sites WHERE user_id = $1',
        [parseInt(userId)]
      );
      return result.rows.map(r => r.site_id);
    } catch (err) {
      console.error('[RBAC] Failed to fetch user sites:', err.message);
      return [];
    }
  }
  // super_admin, admin, viewer, and anything else → no site restriction.
  return null;
}

/**
 * Middleware that attaches the allowed site IDs to the request.
 * Use on any read endpoint that should be site-scoped for site_admins.
 *   req.allowedSiteIds === null → no restriction (show everything)
 *   req.allowedSiteIds === []   → restricted to nothing
 *   req.allowedSiteIds === [..] → restricted to those site IDs
 */
async function attachSiteFilter(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.currentUser = user;
  req.allowedSiteIds = await getAllowedSiteIds(user.id, user.role);
  next();
}

module.exports = {
  requireRole,
  requireWrite,
  requireSuperAdmin,
  requireAuth,
  attachSiteFilter,
  getAllowedSiteIds,
  getRequestUser,
  getRoleLevel,
};
