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

-- Reserved IPs are tracked separately; total_ips counts only the dynamic pool (in_use + free).
ALTER TABLE dhcp_scopes ADD COLUMN IF NOT EXISTS reserved INT DEFAULT 0;

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
-- Per-server lease count (dashboard Infrastructure & Redundancy card) — without
-- this, COUNT(*) WHERE server_id = ? seq-scans the whole leases table per server.
CREATE INDEX IF NOT EXISTS idx_leases_server  ON dhcp_leases(server_id);

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

-- ── dns_records de-dup + unique constraint ─────────────────────
-- One-time cleanup: remove duplicate rows keeping only the latest last_seen
-- per (zone_id, hostname, record_type, record_data). Safe & idempotent — once
-- the unique constraint exists no duplicates can be created, so re-running is a no-op.
DELETE FROM dns_records
WHERE id NOT IN (
  SELECT DISTINCT ON (zone_id, hostname, record_type, record_data) id
  FROM dns_records
  ORDER BY zone_id, hostname, record_type, record_data, last_seen DESC
);

-- Add the unique constraint idempotently (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
-- The collector always writes a non-NULL record_data (String(...||'')), so NULL-vs-NULL
-- distinctness is not a concern in practice.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dns_records_unique'
  ) THEN
    ALTER TABLE dns_records
      ADD CONSTRAINT dns_records_unique
      UNIQUE (zone_id, hostname, record_type, record_data);
  END IF;
END$$;

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

-- ── Alert noise reduction: resolution tracking ───────────────
-- An alert is OPEN iff (acknowledged = FALSE AND resolved_at IS NULL);
-- RESOLVED iff resolved_at IS NOT NULL. Idempotent for existing installs.
-- Severity columns above are plain TEXT (no CHECK constraint), so the
-- 'critical'/'warning'/'info' tiers are all accepted without alteration.
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolved_at     TIMESTAMPTZ;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolved_reason TEXT;

-- Speeds the "open alerts" query (acknowledged = FALSE AND resolved_at IS NULL)
CREATE INDEX IF NOT EXISTS idx_alert_events_open ON alert_events(acknowledged, resolved_at)
  WHERE acknowledged = FALSE AND resolved_at IS NULL;

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

-- ════════════════════════════════════════════════════════════
-- ENTERPRISE FEATURES (audit, API keys, HA, infra health)
-- All IF NOT EXISTS — safe to re-run on existing installs.
-- ════════════════════════════════════════════════════════════

-- ── Audit Log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id         INTEGER,
  username        TEXT NOT NULL DEFAULT 'system',
  user_role       TEXT,
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT,
  entity_name     TEXT,
  old_value       JSONB,
  new_value       JSONB,
  change_summary  TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  session_id      TEXT,
  result          TEXT NOT NULL DEFAULT 'success',
  error_message   TEXT,
  duration_ms     INTEGER,
  site_id         INTEGER,
  server_id       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(username);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_log(site_id);

-- ── API Keys ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  permissions  JSONB DEFAULT '{"read": true, "write": false, "admin": false}',
  allowed_ips  TEXT[],
  request_count BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

-- ── DHCP Failover Pairs ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS dhcp_failover_pairs (
  id                  SERIAL PRIMARY KEY,
  primary_server_id   INTEGER REFERENCES ddi_servers(id) ON DELETE CASCADE,
  secondary_server_id INTEGER REFERENCES ddi_servers(id) ON DELETE CASCADE,
  relationship_name   TEXT,
  mode                TEXT, -- 'hot-standby' or 'load-balance'
  state               TEXT, -- 'normal','communication-interrupted','partner-down','recover'
  last_checked        TIMESTAMPTZ DEFAULT NOW(),
  mclt                INTEGER, -- maximum client lead time seconds
  split_ratio         INTEGER  -- for load-balance mode
);
CREATE INDEX IF NOT EXISTS idx_failover_primary ON dhcp_failover_pairs(primary_server_id);

CREATE TABLE IF NOT EXISTS dhcp_scope_sync_status (
  id               SERIAL PRIMARY KEY,
  scope_id         INTEGER REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  failover_pair_id INTEGER REFERENCES dhcp_failover_pairs(id) ON DELETE CASCADE,
  primary_leases   INTEGER,
  secondary_leases INTEGER,
  sync_delta       INTEGER, -- difference in lease counts
  sync_status      TEXT,    -- 'in-sync','out-of-sync','unknown'
  checked_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scope_sync_pair ON dhcp_scope_sync_status(failover_pair_id);

-- ── Server Health History (for uptime trend + health score) ──
CREATE TABLE IF NOT EXISTS server_health_history (
  id              BIGSERIAL PRIMARY KEY,
  server_id       INTEGER NOT NULL REFERENCES ddi_servers(id) ON DELETE CASCADE,
  health_score    INTEGER,        -- 0-100
  winrm_ok        BOOLEAN,
  scope_count     INTEGER,
  lease_count     INTEGER,
  zone_count      INTEGER,
  record_count    INTEGER,
  query_ms        INTEGER,        -- DNS query response time
  soa_in_sync     BOOLEAN,
  failover_state  TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_health_server_time ON server_health_history(server_id, recorded_at DESC);

-- ── DNS Zone SOA tracking (replication lag) ──────────────────
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS soa_serial      BIGINT;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS soa_checked_at  TIMESTAMPTZ;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS replication_lag BOOLEAN DEFAULT FALSE;

-- ── Per-server live health columns (latest snapshot) ─────────
ALTER TABLE ddi_servers ADD COLUMN IF NOT EXISTS health_score   INTEGER;
ALTER TABLE ddi_servers ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ;
ALTER TABLE ddi_servers ADD COLUMN IF NOT EXISTS query_ms       INTEGER;

-- ── IPAM scan job per-batch progress tracking ───────────────
-- (table is created in schema-ipam.sql which runs after this file on fresh
--  installs; guard so this ALTER is safe to run in any order)
DO $$
BEGIN
  IF to_regclass('public.ipam_scan_jobs') IS NOT NULL THEN
    ALTER TABLE ipam_scan_jobs ADD COLUMN IF NOT EXISTS progress_pct INT DEFAULT 0;
    ALTER TABLE ipam_scan_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════
-- INTELLIGENCE & ALERTING (Features 1-6)
-- ════════════════════════════════════════════════════════════

-- ── Feature 1: Email alerting ────────────────────────────────
CREATE TABLE IF NOT EXISTS smtp_config (
  id          SERIAL PRIMARY KEY,
  host        TEXT NOT NULL,
  port        INT NOT NULL DEFAULT 587,
  secure      BOOLEAN DEFAULT FALSE,
  username    TEXT,
  password    TEXT, -- AES-256-GCM encrypted via credStore.js pattern
  from_email  TEXT NOT NULL,
  from_name   TEXT DEFAULT 'DDIVault Alerts',
  enabled     BOOLEAN DEFAULT FALSE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_recipients (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  name        TEXT,
  role_filter TEXT, -- null=all, 'critical', 'warning', 'info'
  site_id     INT,  -- null=all sites, int=specific site only
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_rule_config (
  id              SERIAL PRIMARY KEY,
  rule_type       TEXT NOT NULL UNIQUE,
  is_enabled      BOOLEAN DEFAULT TRUE,
  threshold_value NUMERIC,
  threshold_unit  TEXT,
  severity        TEXT DEFAULT 'warning',
  cooldown_mins   INT DEFAULT 60,
  digest_mode     BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_email_log (
  id          BIGSERIAL PRIMARY KEY,
  alert_id    BIGINT REFERENCES alert_events(id),
  recipient   TEXT NOT NULL,
  subject     TEXT,
  sent_at     TIMESTAMPTZ DEFAULT NOW(),
  status      TEXT DEFAULT 'sent', -- sent, failed, skipped
  error_msg   TEXT
);

-- ── Seed default alert rule configs (noise-reduction mapping) ──
-- Idempotent: ON CONFLICT (rule_type) DO NOTHING leaves existing installs'
-- rows (including admin customizations) untouched. Fresh installs get the
-- canonical severity + default-enabled + cooldown + digest mapping below.
--   cooldown_mins: 60 for critical, 360 for warning/info (less re-fire churn).
--   digest_mode:   TRUE for info-tier rules (batched into the hourly digest).
-- NOTE: severity columns are plain TEXT (no CHECK constraint), so 'info' is
-- accepted as-is. Rule_type strings match the strings the collector/dnsMonitor
-- actually fire (see collector/anomalyDetector.js); none are renamed/invented.
INSERT INTO alert_rule_config
  (rule_type, threshold_value, threshold_unit, severity, is_enabled, cooldown_mins, digest_mode) VALUES
  -- critical, enabled (cooldown 60)
  ('scope_critical',             90,   'percent',    'critical', TRUE,  60,  FALSE),
  ('server_unreachable',         3,    'retries',    'critical', TRUE,  60,  FALSE),
  ('ip_conflict',                NULL, NULL,         'critical', TRUE,  60,  FALSE),
  ('dhcp_starvation',            50,   'per_minute', 'critical', TRUE,  60,  FALSE),
  ('dhcp_failover_broken',       NULL, NULL,         'critical', TRUE,  60,  FALSE),
  -- warning, enabled (cooldown 360)
  ('scope_warning',              80,   'percent',    'warning',  TRUE,  360, FALSE),
  ('scope_exhaustion_forecast',  14,   'days',       'warning',  TRUE,  360, FALSE),
  ('mac_spoofing',               NULL, NULL,         'warning',  TRUE,  360, FALSE),
  ('new_device_vip_subnet',      NULL, NULL,         'warning',  TRUE,  360, FALSE),
  ('dns_replication_lag',        NULL, NULL,         'warning',  TRUE,  360, FALSE),
  ('dns_forwarder_down',         NULL, NULL,         'warning',  TRUE,  360, FALSE),
  -- info, enabled, digested (cooldown 360)
  ('lease_spike',                20,   'percent',    'info',     TRUE,  360, TRUE),
  ('dns_record_count_drop',      NULL, NULL,         'info',     TRUE,  360, TRUE),
  ('dns_stale_records',          NULL, NULL,         'info',     TRUE,  360, TRUE),
  ('dns_scavenging_disabled',    NULL, NULL,         'info',     TRUE,  360, TRUE),
  -- info, DISABLED by default (noisy), digested (cooldown 360)
  ('after_hours_device',         NULL, NULL,         'info',     FALSE, 360, TRUE),
  ('subnet_jumping',             NULL, NULL,         'info',     FALSE, 360, TRUE),
  ('unknown_device',             NULL, NULL,         'info',     FALSE, 360, TRUE)
ON CONFLICT (rule_type) DO NOTHING;

-- ── Noise-reduction migration for EXISTING installs ──────────
-- The seed's ON CONFLICT DO NOTHING never updates existing rows, so the three
-- noisiest rules stay at their OLD shipped default (warning + enabled) forever.
-- These guarded UPDATEs flip ONLY rows still at that exact original default to
-- the new quiet state (info + disabled + digest). Because each is guarded on
-- the old default values, it is safe to re-run and will NOT clobber any admin
-- customization (a changed severity/is_enabled no longer matches the guard).
UPDATE alert_rule_config SET severity = 'info', is_enabled = FALSE, digest_mode = TRUE
  WHERE rule_type = 'after_hours_device' AND severity = 'warning' AND is_enabled = TRUE;
UPDATE alert_rule_config SET severity = 'info', is_enabled = FALSE, digest_mode = TRUE
  WHERE rule_type = 'subnet_jumping'     AND severity = 'warning' AND is_enabled = TRUE;
UPDATE alert_rule_config SET severity = 'info', is_enabled = FALSE, digest_mode = TRUE
  WHERE rule_type = 'unknown_device'     AND severity = 'warning' AND is_enabled = TRUE;

-- ── Backfill: drain the notification bell of stale resolved alerts ────
-- Auto-resolved alerts were historically left acknowledged=FALSE, inflating
-- the notification bell. Mark all resolved-but-unacknowledged alerts as
-- system-acknowledged (preserving any existing human ack metadata).
-- Idempotent: after the first run (and with the collector fix) this matches zero rows.
UPDATE alert_events
   SET acknowledged = TRUE,
       acknowledged_by = COALESCE(acknowledged_by, 'system'),
       acknowledged_at = COALESCE(acknowledged_at, NOW())
 WHERE acknowledged = FALSE
   AND resolved_at IS NOT NULL;

-- ── Feature 2: Capacity planning ─────────────────────────────
CREATE TABLE IF NOT EXISTS scope_forecasts (
  id                  SERIAL PRIMARY KEY,
  scope_id            INTEGER REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  calculated_at       TIMESTAMPTZ DEFAULT NOW(),
  current_pct         NUMERIC(5,2),
  growth_rate_per_day NUMERIC(8,4),
  days_to_80pct       INT,
  days_to_90pct       INT,
  days_to_full        INT,
  confidence          TEXT,
  recommendation      TEXT,
  data_points         INT,
  status              TEXT DEFAULT 'ok'   -- 'ok' | 'stable' | 'insufficient_data'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_forecasts_scope ON scope_forecasts(scope_id);
-- Forecast status classification (added later; idempotent for existing installs)
ALTER TABLE scope_forecasts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ok';

-- subnet_forecasts references ipam_subnets (created earlier in this file)
CREATE TABLE IF NOT EXISTS subnet_forecasts (
  id                  SERIAL PRIMARY KEY,
  subnet_id           INTEGER REFERENCES ipam_subnets(id) ON DELETE CASCADE,
  calculated_at       TIMESTAMPTZ DEFAULT NOW(),
  current_used        INT,
  total_hosts         INT,
  growth_rate_per_day NUMERIC(8,4),
  days_to_80pct       INT,
  days_to_full        INT,
  confidence          TEXT,
  recommendation      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subnet_forecasts_subnet ON subnet_forecasts(subnet_id);

-- ── Feature 3 + 6: Device fingerprinting / security (dhcp_leases columns) ──
ALTER TABLE dhcp_leases ADD COLUMN IF NOT EXISTS device_type TEXT;
ALTER TABLE dhcp_leases ADD COLUMN IF NOT EXISTS device_vendor TEXT;
ALTER TABLE dhcp_leases ADD COLUMN IF NOT EXISTS device_os TEXT;
ALTER TABLE dhcp_leases ADD COLUMN IF NOT EXISTS risk_level TEXT DEFAULT 'unknown';
ALTER TABLE dhcp_leases ADD COLUMN IF NOT EXISTS is_mac_randomized BOOLEAN DEFAULT FALSE;
ALTER TABLE dhcp_leases ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ;
ALTER TABLE dhcp_leases ADD COLUMN IF NOT EXISTS last_seen_subnet TEXT;

-- ipam_subnets columns (table created earlier in this file)
ALTER TABLE ipam_subnets ADD COLUMN IF NOT EXISTS is_sensitive BOOLEAN DEFAULT FALSE;

-- NOTE: ipam_addresses columns (device_type/device_vendor/risk_level/is_sensitive)
-- live in schema-ipam.sql since that table is created there (runs after this file).

-- ── Feature 4: Behavioral anomaly detection ──────────────────
CREATE TABLE IF NOT EXISTS device_baselines (
  id              BIGSERIAL PRIMARY KEY,
  scope_id        INTEGER REFERENCES dhcp_scopes(id) ON DELETE CASCADE,
  hour_of_day     INT,
  day_of_week     INT,
  avg_leases      NUMERIC(8,2),
  stddev_leases   NUMERIC(8,2),
  sample_count    INT,
  calculated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_baselines_key ON device_baselines(scope_id, hour_of_day, day_of_week);

CREATE TABLE IF NOT EXISTS anomaly_events (
  id              BIGSERIAL PRIMARY KEY,
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  anomaly_type    TEXT NOT NULL,
  severity        TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  description     TEXT,
  details         JSONB,
  acknowledged    BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_detected ON anomaly_events(detected_at DESC);

-- ── Feature 5: Site health scoring ───────────────────────────
CREATE TABLE IF NOT EXISTS site_health_scores (
  id              SERIAL PRIMARY KEY,
  site_id         INT NOT NULL,
  site_name       TEXT,
  calculated_at   TIMESTAMPTZ DEFAULT NOW(),
  overall_score   INT,
  dhcp_score      INT,
  ipam_score      INT,
  dns_score       INT,
  security_score  INT,
  details         JSONB
);
CREATE INDEX IF NOT EXISTS idx_site_health_site ON site_health_scores(site_id, calculated_at DESC);

-- ════════════════════════════════════════════════════════════
-- DNS Health & Intelligence (DNS topology, replication, hygiene)
-- ════════════════════════════════════════════════════════════

-- DNS server roles & AD relationships
CREATE TABLE IF NOT EXISTS dns_server_roles (
  id              SERIAL PRIMARY KEY,
  server_id       INTEGER REFERENCES ddi_servers(id) ON DELETE CASCADE,
  is_primary      BOOLEAN DEFAULT FALSE,
  is_pdc_emulator BOOLEAN DEFAULT FALSE,
  forest_root     TEXT,
  domain          TEXT,
  replication_type TEXT DEFAULT 'ad-integrated', -- 'ad-integrated', 'standard', 'stub'
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(server_id)
);
CREATE INDEX IF NOT EXISTS idx_dns_server_roles_server ON dns_server_roles(server_id);

-- Per-server zone SOA snapshots for replication-lag detection
CREATE TABLE IF NOT EXISTS dns_zone_sync (
  id              BIGSERIAL PRIMARY KEY,
  zone_name       TEXT NOT NULL,
  server_id       INTEGER REFERENCES ddi_servers(id) ON DELETE CASCADE,
  soa_serial      BIGINT,
  soa_primary     TEXT,
  soa_email       TEXT,
  soa_refresh     INTEGER,
  soa_retry       INTEGER,
  soa_expire      INTEGER,
  soa_ttl         INTEGER,
  record_count    INTEGER,
  is_in_sync      BOOLEAN,
  lag_seconds     INTEGER,
  checked_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(zone_name, server_id)
);
CREATE INDEX IF NOT EXISTS idx_dns_zone_sync_zone ON dns_zone_sync(zone_name);
CREATE INDEX IF NOT EXISTS idx_dns_zone_sync_server ON dns_zone_sync(server_id);

-- DNS query statistics history (per server)
CREATE TABLE IF NOT EXISTS dns_query_stats (
  id              BIGSERIAL PRIMARY KEY,
  server_id       INTEGER REFERENCES ddi_servers(id) ON DELETE CASCADE,
  recorded_at     TIMESTAMPTZ DEFAULT NOW(),
  total_queries   BIGINT,
  successful      BIGINT,
  failed          BIGINT,
  nxdomain_count  BIGINT,
  response_time_ms INTEGER,
  queries_per_sec  NUMERIC(10,2)
);
CREATE INDEX IF NOT EXISTS idx_dns_query_stats_server ON dns_query_stats(server_id, recorded_at DESC);

-- Stale DNS records (not refreshed within threshold)
CREATE TABLE IF NOT EXISTS dns_stale_records (
  id              BIGSERIAL PRIMARY KEY,
  zone_id         INTEGER REFERENCES dns_zones(id) ON DELETE CASCADE,
  hostname        TEXT,
  record_type     TEXT,
  record_data     TEXT,
  last_updated    TIMESTAMPTZ,
  days_stale      INTEGER,
  detected_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dns_stale_records_zone ON dns_stale_records(zone_id);

-- DNS forwarder reachability health
CREATE TABLE IF NOT EXISTS dns_forwarder_health (
  id              SERIAL PRIMARY KEY,
  server_id       INTEGER REFERENCES ddi_servers(id) ON DELETE CASCADE,
  forwarder_ip    TEXT NOT NULL,
  is_reachable    BOOLEAN,
  response_time_ms INTEGER,
  last_checked    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(server_id, forwarder_ip)
);
CREATE INDEX IF NOT EXISTS idx_dns_forwarder_health_server ON dns_forwarder_health(server_id);

-- Extra columns on dns_zones for record breakdown + scavenging/aging
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS soa_serial BIGINT;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS record_count_a INTEGER DEFAULT 0;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS record_count_ptr INTEGER DEFAULT 0;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS record_count_cname INTEGER DEFAULT 0;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS record_count_mx INTEGER DEFAULT 0;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS scavenging_enabled BOOLEAN;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS aging_enabled BOOLEAN;
ALTER TABLE dns_zones ADD COLUMN IF NOT EXISTS last_scavenged TIMESTAMPTZ;

-- DNS role/forwarder columns on ddi_servers
ALTER TABLE ddi_servers ADD COLUMN IF NOT EXISTS is_dns_primary BOOLEAN DEFAULT FALSE;
ALTER TABLE ddi_servers ADD COLUMN IF NOT EXISTS dns_forwarders TEXT[];

-- ── Hub cross-DB read role ───────────────────────────────────
-- The NocVault Hub reads across all suite DBs via the shared
-- `nocvault_readonly` role. The suite installer grants it SELECT once at
-- install time, but tables added by future releases (or created at runtime
-- by ddivault_user) are never covered by that one-time grant — and the
-- updater re-applies these schema files (as ddivault_user, which owns all
-- public objects after the ownership-reassign step) but not the installer's
-- grant. Re-granting here makes both installer and updater converge, and
-- ALTER DEFAULT PRIVILEGES auto-covers future ddivault_user-created tables.
-- SELECT-only (never more). No-op on a standalone DDIVault with no Hub role.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
    -- USAGE on schema public by a non-owner grantor (the updater applies this
    -- schema as ddivault_user, not the owner of schema public) is only a
    -- warning, but wrap it so a USAGE failure can NEVER abort the block before
    -- the critical SELECT grant below runs.
    BEGIN
      GRANT USAGE ON SCHEMA public TO nocvault_readonly;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'nocvault_readonly: USAGE on schema public skipped (grantor not owner)';
    END;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO nocvault_readonly;
    ALTER DEFAULT PRIVILEGES FOR ROLE ddivault_user IN SCHEMA public GRANT SELECT ON TABLES TO nocvault_readonly;
  END IF;
END
$$;

-- ── Secret-bearing table row/column-level exclusion (security pass, 2026-07) ─
-- The blanket grant above previously gave nocvault_readonly/claude_readonly
-- unrestricted table-level SELECT on `app_settings` (generic key/value —
-- currently holds no secret keys, but nothing stops a future one being added
-- without remembering to protect it) and `api_keys` (key_hash) — live-
-- verified readable. ALLOWLIST views: a newly added app_settings key or
-- api_keys column defaults to HIDDEN from these two roles until deliberately
-- added below, so a future secret can never leak by omission. Placed AFTER
-- the blanket grant block — order matters, the LAST statement touching a
-- privilege wins (see LogVault/SpanVault CLAUDE.md for the incident that
-- made this ordering rule explicit). smtp_config.password is already AES-
-- 256-GCM encrypted at rest (credStore.js) and is NOT granted to either role
-- at all (no *_public view for it) — ciphertext-with-no-read-access is safer
-- than any filtered view of it.
CREATE OR REPLACE VIEW app_settings_public AS
SELECT key, value, updated_at FROM app_settings
WHERE key IN ('app_name', 'app_subtitle', 'company_name', 'theme');

CREATE OR REPLACE VIEW api_keys_public AS
SELECT id, key_prefix, name, description, created_by, created_at,
       last_used_at, expires_at, is_active, permissions, allowed_ips, request_count
FROM api_keys;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
    REVOKE SELECT ON app_settings, api_keys FROM nocvault_readonly;
    GRANT SELECT ON app_settings_public, api_keys_public TO nocvault_readonly;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    REVOKE SELECT ON app_settings, api_keys FROM claude_readonly;
    GRANT SELECT ON app_settings_public, api_keys_public TO claude_readonly;
  END IF;
END
$$;

-- ═══════════════════════════════════════════════════════════════
-- Reporting Phase 4 — saved views, scheduled delivery, run history,
-- per-recipient email log. All idempotent (CREATE ... IF NOT EXISTS).
-- Driven by api/reportsScheduling.js (CRUD) and collector/reportScheduler.js
-- (the DDIVault-Collector process picks up due schedules — no OS task).
-- ═══════════════════════════════════════════════════════════════

-- Saved report "views": a report type + its filter/range params, named and reusable.
CREATE TABLE IF NOT EXISTS saved_reports (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  report_type  TEXT NOT NULL,
  params       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_reports_type ON saved_reports(report_type);

-- Scheduled report deliveries: generate a report on a cadence and email it.
CREATE TABLE IF NOT EXISTS report_schedules (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  report_type   TEXT NOT NULL,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  format        TEXT NOT NULL DEFAULT 'pdf',          -- 'pdf' | 'csv'
  cadence       TEXT NOT NULL DEFAULT 'weekly',       -- 'daily' | 'weekly' | 'monthly'
  hour          INT  NOT NULL DEFAULT 7,              -- 0-23, local server time
  day_of_week   INT,                                  -- 0(Sun)..6(Sat) for weekly
  day_of_month  INT,                                  -- 1..28 for monthly
  recipients    TEXT[] NOT NULL DEFAULT '{}',         -- email addresses
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  last_status   TEXT,
  next_run_at   TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_due ON report_schedules(enabled, next_run_at);

-- Server-side history of every report generation (manual export or scheduled run).
CREATE TABLE IF NOT EXISTS report_run_history (
  id            BIGSERIAL PRIMARY KEY,
  schedule_id   INT REFERENCES report_schedules(id) ON DELETE SET NULL,
  report_type   TEXT NOT NULL,
  format        TEXT NOT NULL DEFAULT 'pdf',
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count     INT,
  status        TEXT NOT NULL DEFAULT 'success',       -- 'success' | 'failed'
  error_msg     TEXT,
  trigger_type  TEXT NOT NULL DEFAULT 'manual',        -- 'manual' | 'scheduled'
  generated_by  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_run_history_time ON report_run_history(created_at DESC);

-- Per-recipient email delivery audit for scheduled reports (mirrors alert_email_log).
CREATE TABLE IF NOT EXISTS report_email_log (
  id            BIGSERIAL PRIMARY KEY,
  schedule_id   INT REFERENCES report_schedules(id) ON DELETE SET NULL,
  run_id        BIGINT REFERENCES report_run_history(id) ON DELETE SET NULL,
  recipient     TEXT NOT NULL,
  subject       TEXT,
  status        TEXT NOT NULL,                          -- 'sent' | 'failed' | 'skipped'
  error_msg     TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_email_log_time ON report_email_log(sent_at DESC);

-- ── Done ─────────────────────────────────────────────────────
-- Verify with:
--   \dt
--   SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
