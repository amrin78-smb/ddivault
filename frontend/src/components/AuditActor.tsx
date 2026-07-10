/**
 * AuditActor — historically patched window.fetch to stamp every outgoing
 * /api/* request with x-ddi-actor / x-ddi-actor-role / x-ddi-actor-id headers
 * read from the client-side NextAuth session.
 *
 * That was a confirmed authentication bypass: those headers were forwarded
 * unmodified by a next.config.js rewrite straight to the Express API, and
 * api/middleware/rbac.js trusted them verbatim with zero verification — any
 * client could set x-ddi-actor-role: super_admin itself via a bare curl
 * request and pass every RBAC check.
 *
 * Identity headers are now stamped exclusively by frontend/src/middleware.ts,
 * server-side, from a NextAuth JWT it verifies itself (getToken()) — a client
 * can no longer influence them at all. This component is now a deliberate
 * no-op, kept only so the existing <AuditActor /> import in app/layout.tsx
 * doesn't need touching. Safe to delete along with its import once nothing
 * else references it.
 */
export function AuditActor() {
  return null;
}
