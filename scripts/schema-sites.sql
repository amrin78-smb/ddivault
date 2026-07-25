-- DDIVault — Sites integration migration
-- Run: psql -U ddivault_user -d ddivault -f schema-sites.sql

-- Add site_id to ddi_servers (references NetVault sites table via cross-DB read)
-- We store just the ID — name is always fetched live from NetVault
ALTER TABLE ddi_servers
  ADD COLUMN IF NOT EXISTS site_id INT;

-- Add site_id to ipam_supernets
ALTER TABLE ipam_supernets
  ADD COLUMN IF NOT EXISTS site_id INT;

-- ipam_subnets already has site TEXT — add site_id alongside it
ALTER TABLE ipam_subnets
  ADD COLUMN IF NOT EXISTS site_id INT;

COMMENT ON COLUMN ddi_servers.site_id    IS 'References sites.id in netvault database';
COMMENT ON COLUMN ipam_supernets.site_id IS 'References sites.id in netvault database';
COMMENT ON COLUMN ipam_subnets.site_id   IS 'References sites.id in netvault database';

-- ── ddi_servers: exclude WinRM/PowerShell credential columns from readonly roles ──
-- (2026-07-23; RELOCATED here from scripts/schema.sql on 2026-07-25 — see the
-- pointer comment there for the full reason.) ps_username/ps_password
-- (schema-server-auth.sql) are the per-server WinRM credential, ps_password
-- AES-256-GCM encrypted via collector/credStore.js. The suite's blanket
-- `GRANT SELECT ON ALL TABLES` (and schema.sql's own default-privileges grant)
-- gives nocvault_readonly/claude_readonly full table-level SELECT on
-- ddi_servers INCLUDING both secret columns; this REVOKE-then-column-GRANT
-- narrows that to every OTHER column instead. Unlike app_settings, ddi_servers
-- has no secret/non-secret mix packed into one generic column, so a plain
-- column-level GRANT (excluding only ps_username/ps_password) is sufficient —
-- no separate view needed.
--
-- WHY THIS LIVES IN schema-sites.sql, NOT schema.sql: the column list below
-- names auth_mode/winrm_*/notes (added by schema-server-auth.sql, the 3rd file)
-- and site_id (added just above, the 4th file). This is the LAST of the 4
-- schema files applied by both the per-app updater and the suite installer, so
-- by the time it runs, all 25 ddi_servers columns exist AND this is the final
-- statement touching these roles' privileges on the table — exactly the two
-- properties the column-level exclusion needs. Keep it here. If a NEW
-- secret-bearing column is added to ddi_servers, exclude it by leaving it OUT
-- of the list below (a column-level grant fails closed — a new column is simply
-- invisible to the readonly roles until explicitly added here).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
    REVOKE SELECT ON ddi_servers FROM nocvault_readonly;
    GRANT SELECT (id, hostname, ip_address, role, description, is_active,
      last_polled, poll_status, poll_error, created_at, updated_at, site_id,
      auth_mode, winrm_port, winrm_https, winrm_test_ok, winrm_tested_at, notes,
      health_score, health_checked_at, query_ms, is_dns_primary, dns_forwarders)
      ON ddi_servers TO nocvault_readonly;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    REVOKE SELECT ON ddi_servers FROM claude_readonly;
    GRANT SELECT (id, hostname, ip_address, role, description, is_active,
      last_polled, poll_status, poll_error, created_at, updated_at, site_id,
      auth_mode, winrm_port, winrm_https, winrm_test_ok, winrm_tested_at, notes,
      health_score, health_checked_at, query_ms, is_dns_primary, dns_forwarders)
      ON ddi_servers TO claude_readonly;
  END IF;
END
$$;
