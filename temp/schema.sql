-- ============================================================
-- DDIVault Database Schema
-- Database: ddivault
-- Run as: psql -U postgres -c "CREATE DATABASE ddivault OWNER ddivault_user;"
--         psql -U ddivault_user -d ddivault -f schema.sql
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── DDI Servers ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ddi_servers (
  id           SERIAL PRIMARY KEY,
  hostname     TEXT NOT NULL,
  ip_address   INET,
  role         TEXT NOT NULL DEFAULT 'both', -- 'dhcp', 'dns', 'both'
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  last_polled  TIMESTAMPTZ,
  poll_status  TEXT DEFAULT 'pending',       -- 'ok', 'error', 'pending'
  poll_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── DHCP Scopes ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dhcp_scopes (
  id              SERIAL PRIMARY KEY,
  server_id       INT NOT NULL REFERENCES ddi_servers(id) ON DELETE CASCADE,
  scope_id        TEXT NOT NULL,             -- e.g. "192.168.1.0"
  name            TEXT,
  start_range     INET,
  end_range       INET,
  subnet_mask     TEXT,
  state           TEXT DEFAULT 'Active',     -- 'Active', 'InActive'
  lease_duration  TEXT,                      -- e.g. "8.00:00:00"
  total_ips       INT DEFAULT 0,
  in_use          INT DEFAULT 0,
  free            INT DEFAULT 0,
  reserved        INT DEFAULT 0,
  pending         INT DEFAULT 0,
  percent_used    NUMERIC(5,2) DEFAULT 0,
  description     TEXT,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(server_id, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_dhcp_scopes_server ON dhcp_scopes(server_id);
CREATE INDEX IF NOT EXISTS idx_dhcp_scopes_percent ON dhcp_scopes(percent_used DESC);

-- ── Scope Utilization History ────────────────────────────────
CREATE TABLE IF NOT EXISTS dhcp_scope_history (
  id           BIGSERIAL PRIMARY KEY,
  scope_id     INT NOT NULL REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  in_use       INT,
  free         INT,
  reserved     INT,
  percent_used NUMERIC(5,2),
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scope_history_scope_time
  ON dhcp_scope_history(scope_id, recorded_at DESC);

-- ── Active DHCP Leases ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS dhcp_leases (
  id             BIGSERIAL PRIMARY KEY,
  server_id      INT NOT NULL REFERENCES ddi_servers(id) ON DELETE CASCADE,
  scope_id       TEXT,
  ip_address     INET NOT NULL,
  hostname       TEXT,
  mac_address    TEXT,
  client_id      TEXT,
  address_state  TEXT DEFAULT 'Active',      -- 'Active', 'Expired', 'Declined', 'Reservation'
  lease_start    TIMESTAMPTZ,
  lease_expiry   TIMESTAMPTZ,
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(server_id, ip_address)
);

CREATE INDEX IF NOT EXISTS idx_leases_ip      ON dhcp_leases(ip_address);
CREATE INDEX IF NOT EXISTS idx_leases_mac     ON dhcp_leases(mac_address);
CREATE INDEX IF NOT EXISTS idx_leases_scope   ON dhcp_leases(scope_id);
CREATE INDEX IF NOT EXISTS idx_leases_state   ON dhcp_leases(address_state);
CREATE INDEX IF NOT EXISTS idx_leases_expiry  ON dhcp_leases(lease_expiry);

-- ── Lease History ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lease_history (
  id           BIGSERIAL PRIMARY KEY,
  server_id    INT REFERENCES ddi_servers(id),
  ip_address   INET NOT NULL,
  hostname     TEXT,
  mac_address  TEXT,
  scope_id     TEXT,
  event_type   TEXT,   -- 'assign', 'renew', 'release', 'expire', 'conflict', 'decline', 'nack'
  event_time   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lease_hist_ip   ON lease_history(ip_address);
CREATE INDEX IF NOT EXISTS idx_lease_hist_mac  ON lease_history(mac_address);
CREATE INDEX IF NOT EXISTS idx_lease_hist_time ON lease_history(event_time DESC);

-- ── DHCP Events (from log files) ─────────────────────────────
CREATE TABLE IF NOT EXISTS dhcp_events (
  id           BIGSERIAL PRIMARY KEY,
  server_id    INT REFERENCES ddi_servers(id),
  event_id     INT,        -- Windows DHCP event ID (10=assign,11=renew,12=release,13=conflict,etc.)
  event_type   TEXT,       -- human label: 'Assign', 'Renew', 'Release', 'Conflict', 'ScopeFull'
  ip_address   TEXT,
  hostname     TEXT,
  mac_address  TEXT,
  scope_id     TEXT,
  description  TEXT,
  raw_line     TEXT,
  event_time   TIMESTAMPTZ NOT NULL,
  inserted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_time    ON dhcp_events(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_type    ON dhcp_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_eventid ON dhcp_events(event_id);
CREATE INDEX IF NOT EXISTS idx_events_ip      ON dhcp_events(ip_address);

-- Prevent duplicate log lines
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup
  ON dhcp_events(server_id, event_time, ip_address, event_id)
  WHERE ip_address IS NOT NULL;

-- ── IPAM Subnets ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ipam_subnets (
  id             SERIAL PRIMARY KEY,
  network        INET NOT NULL,
  prefix_length  INT NOT NULL,
  name           TEXT,
  description    TEXT,
  gateway        INET,
  vlan_id        INT,
  site           TEXT,
  owner          TEXT,
  is_managed     BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(network, prefix_length)
);

-- ── DNS Zones ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dns_zones (
  id             SERIAL PRIMARY KEY,
  server_id      INT NOT NULL REFERENCES ddi_servers(id) ON DELETE CASCADE,
  zone_name      TEXT NOT NULL,
  zone_type      TEXT,   -- 'Primary', 'Secondary', 'Stub', 'Forwarder'
  is_reverse     BOOLEAN DEFAULT FALSE,
  is_ds_integrated BOOLEAN DEFAULT FALSE,
  is_auto_created  BOOLEAN DEFAULT FALSE,
  record_count   INT DEFAULT 0,
  last_updated   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(server_id, zone_name)
);

CREATE INDEX IF NOT EXISTS idx_dns_zones_server ON dns_zones(server_id);

-- ── DNS Records ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dns_records (
  id           BIGSERIAL PRIMARY KEY,
  zone_id      INT NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
  hostname     TEXT NOT NULL,
  record_type  TEXT NOT NULL,   -- 'A', 'AAAA', 'CNAME', 'MX', 'PTR', 'SRV', 'TXT', 'NS'
  record_data  TEXT,
  ttl          INT,
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dns_records_hostname ON dns_records(hostname);
CREATE INDEX IF NOT EXISTS idx_dns_records_type     ON dns_records(record_type);
CREATE INDEX IF NOT EXISTS idx_dns_records_zone     ON dns_records(zone_id);

-- ── Alert Rules ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  rule_type        TEXT NOT NULL,  -- 'scope_threshold', 'scope_full', 'rogue_dhcp', 'conflict'
  threshold_value  NUMERIC,        -- e.g. 80 for 80%
  severity         TEXT DEFAULT 'warning',  -- 'warning', 'critical'
  is_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Alert Events ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_events (
  id               BIGSERIAL PRIMARY KEY,
  rule_id          INT REFERENCES alert_rules(id),
  server_id        INT REFERENCES ddi_servers(id),
  scope_id         TEXT,
  message          TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'warning',
  acknowledged     BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by  TEXT,
  acknowledged_at  TIMESTAMPTZ,
  fired_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_fired  ON alert_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_unacked ON alert_events(acknowledged)
  WHERE acknowledged = FALSE;

-- ── App Settings ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Seed: Default Alert Rules ────────────────────────────────
INSERT INTO alert_rules (name, description, rule_type, threshold_value, severity) VALUES
  ('Scope Warning',  'Alert when DHCP scope reaches 80% utilization',  'scope_threshold', 80,  'warning'),
  ('Scope Critical', 'Alert when DHCP scope reaches 90% utilization',  'scope_threshold', 90,  'critical'),
  ('Scope Full',     'Alert when DHCP scope is 100% full',             'scope_full',      100, 'critical'),
  ('IP Conflict',    'Alert on DHCP IP address conflict detected',      'conflict',        NULL,'critical')
ON CONFLICT DO NOTHING;

-- ── Seed: Default App Settings ───────────────────────────────
INSERT INTO app_settings (key, value) VALUES
  ('app_name',        'DDIVault'),
  ('app_subtitle',    'DNS · DHCP · IPAM'),
  ('company_name',    ''),
  ('theme',           'light'),
  ('retention_days',  '90')
ON CONFLICT DO NOTHING;

-- ── Helper: updated_at trigger ───────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ddi_servers_updated
  BEFORE UPDATE ON ddi_servers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_ipam_subnets_updated
  BEFORE UPDATE ON ipam_subnets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Done ─────────────────────────────────────────────────────
-- Verify with:
--   \dt
--   SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
