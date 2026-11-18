-- ============================================================
-- DDIVault — Linux/third-party DNS platform support (1.37.0)
-- Run AFTER schema-sites.sql. Registered in installer/Update-DDIVault.ps1
-- and ../net-vault/installer/Install-NocVault-Suite.ps1.
-- ============================================================
--
-- Until now every DNS server DDIVault polled was Windows DNS reached over
-- WinRM/PowerShell. These columns let a server instead be collected over the
-- DNS protocol itself (AXFR + SOA, RFC 8945 TSIG) with an optional vendor
-- channel for the things the protocol cannot express — BIND's
-- statistics-channel, PowerDNS's REST API.
--
-- ⛔ `dns_platform` DEFAULTS TO 'windows' AND THAT DEFAULT IS LOAD-BEARING.
-- Every existing row is a Windows DNS server; a NULL or a new default would
-- route live production servers down the new, unproven code path on the first
-- collector cycle after an upgrade.

ALTER TABLE ddi_servers
  ADD COLUMN IF NOT EXISTS dns_platform       TEXT DEFAULT 'windows',
  -- 'windows'  = Get-DnsServer* over WinRM (the existing path, unchanged)
  -- 'bind'     = AXFR + BIND statistics-channel
  -- 'powerdns' = PowerDNS Authoritative REST API
  ADD COLUMN IF NOT EXISTS dns_host           TEXT,
  -- Where the DNS service answers, when that differs from ip_address.
  ADD COLUMN IF NOT EXISTS dns_port           INT DEFAULT 53,
  -- ⛔ CONFIGURABLE ON PURPOSE, not just for tests. Rootless containers cannot
  -- bind 53 and split-horizon setups routinely do not use it, so a hardcoded
  -- 53 would make the feature untestable AND reject legitimate deployments.
  ADD COLUMN IF NOT EXISTS tsig_key_name      TEXT,
  ADD COLUMN IF NOT EXISTS tsig_algorithm     TEXT DEFAULT 'hmac-sha256',
  ADD COLUMN IF NOT EXISTS tsig_secret        TEXT,   -- SECRET: AES-256-GCM, credStore.js
  ADD COLUMN IF NOT EXISTS dns_stats_url      TEXT,   -- BIND statistics-channel base URL
  ADD COLUMN IF NOT EXISTS dns_api_url        TEXT,   -- PowerDNS API base URL
  ADD COLUMN IF NOT EXISTS dns_api_key        TEXT,   -- SECRET: AES-256-GCM, credStore.js
  ADD COLUMN IF NOT EXISTS dns_api_server_id  TEXT DEFAULT 'localhost',
  ADD COLUMN IF NOT EXISTS dns_last_error     TEXT,
  ADD COLUMN IF NOT EXISTS dns_capabilities   JSONB;
  -- The capability verdict last computed for this server (see
  -- collector/dns/capabilities.js). Persisted so the UI can render
  -- "not applicable on this platform" without re-deriving the matrix, and so a
  -- capability that DEGRADED (supported -> not_available, e.g. someone turned
  -- the statistics channel off) is visible rather than silently becoming blank.

CREATE INDEX IF NOT EXISTS idx_ddi_servers_dns_platform
  ON ddi_servers(dns_platform) WHERE dns_platform <> 'windows';

COMMENT ON COLUMN ddi_servers.dns_platform IS
  'windows=PowerShell/WinRM (default), bind=AXFR+statistics-channel, powerdns=REST API';
COMMENT ON COLUMN ddi_servers.tsig_secret IS
  'AES-256-GCM encrypted TSIG shared secret (base64 plaintext). Key = NEXTAUTH_SECRET.';
COMMENT ON COLUMN ddi_servers.dns_api_key IS
  'AES-256-GCM encrypted vendor API key (PowerDNS X-API-Key). Key = NEXTAUTH_SECRET.';

-- ── ddi_servers readonly column grant — RELOCATED HERE from schema-sites.sql ──
--
-- ⛔ THIS MUST BE THE LAST STATEMENT TOUCHING THESE ROLES' PRIVILEGES ON
-- ddi_servers, which is the only reason it moves. A table-level GRANT anywhere
-- after it silently re-widens access to the credential columns, and the block
-- has already been relocated once for exactly this reason (schema.sql ->
-- schema-sites.sql, 2026-07-25) when a later file started adding columns. This
-- file is now the last of the FIVE applied by both the per-app updater and the
-- suite installer, so the block belongs here. schema-sites.sql keeps a pointer.
--
-- ⛔ `tsig_secret` AND `dns_api_key` ARE DELIBERATELY ABSENT FROM THE LIST.
-- A column-level grant fails closed: a column left out is simply invisible to
-- the readonly roles. That is the correct trade — a diagnostic query missing a
-- column is a far smaller problem than a newly-added secret becoming readable
-- by every readonly role. Add NON-secret columns here; never add a secret.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
    REVOKE SELECT ON ddi_servers FROM nocvault_readonly;
    GRANT SELECT (id, hostname, ip_address, role, description, is_active,
      last_polled, poll_status, poll_error, created_at, updated_at, site_id,
      auth_mode, winrm_port, winrm_https, winrm_test_ok, winrm_tested_at, notes,
      health_score, health_checked_at, query_ms, is_dns_primary, dns_forwarders,
      agent_hub_id,
      dns_platform, dns_host, dns_port, tsig_key_name, tsig_algorithm,
      dns_stats_url, dns_api_url, dns_api_server_id, dns_last_error,
      dns_capabilities)
      ON ddi_servers TO nocvault_readonly;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    REVOKE SELECT ON ddi_servers FROM claude_readonly;
    GRANT SELECT (id, hostname, ip_address, role, description, is_active,
      last_polled, poll_status, poll_error, created_at, updated_at, site_id,
      auth_mode, winrm_port, winrm_https, winrm_test_ok, winrm_tested_at, notes,
      health_score, health_checked_at, query_ms, is_dns_primary, dns_forwarders,
      agent_hub_id,
      dns_platform, dns_host, dns_port, tsig_key_name, tsig_algorithm,
      dns_stats_url, dns_api_url, dns_api_server_id, dns_last_error,
      dns_capabilities)
      ON ddi_servers TO claude_readonly;
  END IF;
END
$$;
