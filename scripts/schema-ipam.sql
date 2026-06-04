-- ============================================================
-- DDIVault IPAM Phase A + B — Schema Migration
-- Run: psql -U ddivault_user -d ddivault -f schema-ipam.sql
-- ============================================================

-- ── Supernets (top-level network blocks) ─────────────────────
CREATE TABLE IF NOT EXISTS ipam_supernets (
  id           SERIAL PRIMARY KEY,
  network      INET NOT NULL,
  prefix_length INT NOT NULL,
  name         TEXT,
  description  TEXT,
  site         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(network, prefix_length)
);

-- ── Enhance ipam_subnets with supernet parent + scan fields ──
ALTER TABLE ipam_subnets
  ADD COLUMN IF NOT EXISTS supernet_id    INT REFERENCES ipam_supernets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location       TEXT,
  ADD COLUMN IF NOT EXISTS notes          TEXT,
  ADD COLUMN IF NOT EXISTS last_scanned   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scan_status    TEXT DEFAULT 'never',  -- 'never','scanning','done','error'
  ADD COLUMN IF NOT EXISTS total_hosts    INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS used_hosts     INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS free_hosts     INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unknown_hosts  INT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ipam_subnets_supernet ON ipam_subnets(supernet_id);

-- ── IP Address inventory ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ipam_addresses (
  id           BIGSERIAL PRIMARY KEY,
  subnet_id    INT NOT NULL REFERENCES ipam_subnets(id) ON DELETE CASCADE,
  ip_address   INET NOT NULL,
  status       TEXT NOT NULL DEFAULT 'unknown',
  -- 'available'  = ping no response, no DHCP lease
  -- 'dhcp'       = has active DHCP lease
  -- 'reserved'   = manually reserved
  -- 'unknown'    = ping responds but no DHCP lease (rogue/unmanaged)
  -- 'offline'    = was seen before, now unreachable
  hostname     TEXT,
  mac_address  TEXT,
  description  TEXT,          -- for reserved IPs: purpose/owner notes
  owner        TEXT,
  last_seen    TIMESTAMPTZ,
  last_ping    TIMESTAMPTZ,
  ping_ms      INT,           -- response time in ms
  dhcp_lease_id BIGINT REFERENCES dhcp_leases(id) ON DELETE SET NULL,
  is_reserved  BOOLEAN DEFAULT FALSE,
  reserved_by  TEXT,
  reserved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(subnet_id, ip_address)
);

CREATE INDEX IF NOT EXISTS idx_ipam_addr_subnet  ON ipam_addresses(subnet_id);
CREATE INDEX IF NOT EXISTS idx_ipam_addr_ip      ON ipam_addresses(ip_address);
CREATE INDEX IF NOT EXISTS idx_ipam_addr_status  ON ipam_addresses(status);
CREATE INDEX IF NOT EXISTS idx_ipam_addr_mac     ON ipam_addresses(mac_address);

-- ── VLAN table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ipam_vlans (
  id           SERIAL PRIMARY KEY,
  vlan_id      INT NOT NULL UNIQUE,
  name         TEXT,
  description  TEXT,
  site         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Scan jobs log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ipam_scan_jobs (
  id           BIGSERIAL PRIMARY KEY,
  subnet_id    INT NOT NULL REFERENCES ipam_subnets(id) ON DELETE CASCADE,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status       TEXT DEFAULT 'running',  -- 'running', 'done', 'error'
  hosts_scanned INT DEFAULT 0,
  hosts_up      INT DEFAULT 0,
  hosts_unknown INT DEFAULT 0,
  error_msg     TEXT
);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_subnet ON ipam_scan_jobs(subnet_id);

-- Per-batch scan progress tracking
ALTER TABLE ipam_scan_jobs ADD COLUMN IF NOT EXISTS progress_pct INT DEFAULT 0;
ALTER TABLE ipam_scan_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ── IP audit trail ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ipam_audit (
  id           BIGSERIAL PRIMARY KEY,
  ip_address   INET NOT NULL,
  subnet_id    INT REFERENCES ipam_subnets(id),
  action       TEXT NOT NULL,  -- 'discovered','reserved','released','status_change','scan'
  old_status   TEXT,
  new_status   TEXT,
  hostname     TEXT,
  mac_address  TEXT,
  performed_by TEXT DEFAULT 'system',
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ipam_audit_ip   ON ipam_audit(ip_address);
CREATE INDEX IF NOT EXISTS idx_ipam_audit_time ON ipam_audit(created_at DESC);

-- ── Updated_at triggers ───────────────────────────────────────
CREATE OR REPLACE TRIGGER trg_ipam_supernets_updated
  BEFORE UPDATE ON ipam_supernets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_ipam_addresses_updated
  BEFORE UPDATE ON ipam_addresses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
