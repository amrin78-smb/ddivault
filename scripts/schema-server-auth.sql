-- ============================================================
-- DDIVault — Per-server authentication schema migration
-- Run: psql -U ddivault_user -d ddivault -f schema-server-auth.sql
-- ============================================================

ALTER TABLE ddi_servers
  ADD COLUMN IF NOT EXISTS auth_mode      TEXT DEFAULT 'kerberos',
  -- 'kerberos'   = domain-joined, use NocVault server's own identity (no creds needed)
  -- 'credential' = explicit username + password
  -- 'local'      = DHCP server IS the NocVault server, run PS locally
  ADD COLUMN IF NOT EXISTS ps_username    TEXT,
  ADD COLUMN IF NOT EXISTS ps_password    TEXT,   -- stored encrypted (AES via Node crypto)
  ADD COLUMN IF NOT EXISTS winrm_port     INT DEFAULT 5985,
  ADD COLUMN IF NOT EXISTS winrm_https    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS winrm_test_ok  BOOLEAN,
  ADD COLUMN IF NOT EXISTS winrm_tested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes          TEXT;

-- Index for active servers with auth
CREATE INDEX IF NOT EXISTS idx_ddi_servers_active ON ddi_servers(is_active) WHERE is_active = TRUE;

-- Comment describing the auth flow
COMMENT ON COLUMN ddi_servers.auth_mode IS
  'kerberos=domain SSO, credential=stored username+password, local=run PS on this machine';
COMMENT ON COLUMN ddi_servers.ps_password IS
  'AES-256 encrypted password. Key = NEXTAUTH_SECRET env var.';
