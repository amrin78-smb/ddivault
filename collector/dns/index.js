'use strict';
/**
 * index.js — DNS provider registry.
 *
 * ⛔ 'windows' IS NOT REGISTERED HERE ON PURPOSE. Windows DNS is collected by
 * the existing PowerShell path (collector/dnsMonitor.js + powershellRunner.js)
 * and that path is deliberately left alone. Windows DNS does speak AXFR, so
 * folding it in here would look like a tidy unification — and it would silently
 * drop scavenging, aging and AD-integration data, which only the PowerShell
 * cmdlets expose and which the Windows half of the product is built around.
 * `providerFor()` returning null for Windows is the signal to use the old path.
 */

const bind = require('./providers/bind');
const powerdns = require('./providers/powerdns');
const capabilities = require('./capabilities');

const PROVIDERS = { bind, powerdns };

/** Platforms this build can collect over the DNS-protocol path. */
const PROTOCOL_PLATFORMS = Object.keys(PROVIDERS);

/** @returns {object|null} null = not a protocol-collected platform */
function providerFor(platform) {
  return PROVIDERS[String(platform || '').toLowerCase()] || null;
}

function isProtocolPlatform(platform) {
  return !!providerFor(platform);
}

/**
 * Normalise a ddi_servers row into what the providers expect.
 * Keeps the column names out of the providers, so a schema rename is one edit.
 */
function serverContext(row) {
  const host = String(row.dns_host || row.ip_address || row.hostname || '').replace(/\/\d+$/, '').trim();
  return {
    id: row.id,
    hostname: row.hostname,
    dns_platform: row.dns_platform,
    dns_host: host,
    dns_port: Number(row.dns_port) || 53,
    tsig_key_name: row.tsig_key_name || null,
    tsig_algorithm: row.tsig_algorithm || 'hmac-sha256',
    tsig_secret: row.tsig_secret || null,     // already decrypted by the caller
    dns_stats_url: row.dns_stats_url || null,
    dns_api_url: row.dns_api_url || null,
    dns_api_key: row.dns_api_key || null,     // already decrypted by the caller
    dns_api_server_id: row.dns_api_server_id || 'localhost',
  };
}

module.exports = { providerFor, isProtocolPlatform, serverContext, PROVIDERS, PROTOCOL_PLATFORMS, capabilities };
