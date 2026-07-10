/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  // NOTE: /api/* is proxied to the Express API (127.0.0.1:3007) by
  // frontend/src/middleware.ts, NOT by a next.config.js rewrites() table.
  // A config-level rewrite is a dumb URL-level forward with no code-execution
  // point — it cannot verify a session or strip/stamp identity headers, which
  // is exactly what let a client set x-ddi-actor-role itself via a bare curl
  // request and bypass every RBAC check. middleware.ts now owns all /api/*
  // routing: it verifies the NextAuth JWT, overwrites x-ddi-actor* from the
  // verified token, and rewrites to Express itself. Do not reintroduce a
  // rewrites() table here — see middleware.ts for the real routing table.
};

module.exports = nextConfig;
