-- ============================================================
-- DDIVault — Intelligence/Alerting SMOKE-TEST SEED
-- ============================================================
-- Populates clearly-labelled DEMO data so every new feature's UI lights up
-- without waiting for real history to accumulate:
--   • 30 days of dhcp_scope_history + a scope_forecast (Capacity Forecast widget,
--     DHCP "Forecast" column)
--   • device_baselines (feeds anomaly lease-spike detection)
--   • demo leases tagged with device fingerprints (DHCP Device column, Device Donut)
--   • a demo IPAM supernet/subnet (one SENSITIVE) + classified addresses
--   • a variety of anomaly_events (Intelligence tab, Security Overview)
--   • a site_health_scores row (Site Health widget)
--   • an INACTIVE demo alert recipient (visible, will NOT send email)
--
-- Usage (idempotent / re-runnable — cleans its own prior demo data first):
--   psql -U ddivault_user -d ddivault -f scripts/seed-smoke-test.sql
-- Remove everything it created:
--   psql -U ddivault_user -d ddivault -f scripts/clean-smoke-test.sql
--
-- Markers used for cleanup: ddi_servers.hostname='DEMO-SMOKE-TEST', site_id=9999,
--   anomaly_events.details->>'demo'='true', alert_recipients.email LIKE '%@demo.smoketest'.
-- NOTE: no real emails are sent — the demo recipient is inactive and SMTP is untouched.
-- ============================================================

BEGIN;

-- ── 1. Clean any prior demo data (dependency order; safe if absent) ──
DELETE FROM scope_forecasts    WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE server_id IN (SELECT id FROM ddi_servers WHERE hostname='DEMO-SMOKE-TEST'));
DELETE FROM dhcp_scope_history WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE server_id IN (SELECT id FROM ddi_servers WHERE hostname='DEMO-SMOKE-TEST'));
DELETE FROM device_baselines   WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE server_id IN (SELECT id FROM ddi_servers WHERE hostname='DEMO-SMOKE-TEST'));
DELETE FROM dhcp_leases        WHERE server_id IN (SELECT id FROM ddi_servers WHERE hostname='DEMO-SMOKE-TEST');
DELETE FROM dhcp_scopes        WHERE server_id IN (SELECT id FROM ddi_servers WHERE hostname='DEMO-SMOKE-TEST');
DELETE FROM ddi_servers        WHERE hostname='DEMO-SMOKE-TEST';
DELETE FROM ipam_addresses     WHERE subnet_id IN (SELECT id FROM ipam_subnets WHERE site_id=9999);
DELETE FROM ipam_subnets       WHERE site_id=9999;
DELETE FROM ipam_supernets     WHERE site_id=9999;
DELETE FROM anomaly_events     WHERE details->>'demo'='true';
DELETE FROM site_health_scores WHERE site_id=9999;
DELETE FROM alert_email_log    WHERE recipient LIKE '%@demo.smoketest';
DELETE FROM alert_recipients   WHERE email LIKE '%@demo.smoketest';

-- ── 2. Seed (single transaction-scoped block so we can chain IDs) ──
DO $$
DECLARE
  v_server_id   INT;
  v_scope_id    INT;
  v_supernet_id INT;
  v_subnet_id   INT;
  v_scope_cidr  TEXT := '10.255.0.0';
BEGIN
  -- Demo DHCP/DNS server (site 9999)
  INSERT INTO ddi_servers (hostname, ip_address, role, poll_status, is_active, site_id)
  VALUES ('DEMO-SMOKE-TEST', '10.255.255.1', 'both', 'ok', TRUE, 9999)
  RETURNING id INTO v_server_id;

  -- Demo scope: 254 hosts, ~90% used and climbing → forecast goes red
  INSERT INTO dhcp_scopes
    (server_id, scope_id, name, start_range, end_range, subnet_mask, state,
     total_ips, in_use, free, reserved, pending, percent_used, last_updated)
  VALUES
    (v_server_id, v_scope_cidr, 'DEMO Office LAN', '10.255.0.1', '10.255.0.254',
     '255.255.255.0', 'Active', 254, 231, 23, 0, 0, 90.94, NOW())
  RETURNING id INTO v_scope_id;

  -- 30 days of utilisation history every 6h with an upward trend + weekday/hour shape
  INSERT INTO dhcp_scope_history (scope_id, in_use, free, reserved, percent_used, recorded_at)
  SELECT v_scope_id,
         u.inuse,
         254 - u.inuse,
         0,
         ROUND(u.inuse::numeric / 254 * 100, 2),
         u.ts
  FROM (
    SELECT gs AS ts,
           GREATEST(0, LEAST(254,
             ROUND(
               150
               + 2.7 * (30 - EXTRACT(DAY FROM (date_trunc('day', NOW()) - date_trunc('day', gs))))
               + CASE WHEN EXTRACT(DOW FROM gs) IN (0, 6) THEN -15 ELSE 0 END
               + CASE WHEN EXTRACT(HOUR FROM gs) BETWEEN 8 AND 18 THEN 6 ELSE 0 END
             )
           ))::int AS inuse
    FROM generate_series(NOW() - INTERVAL '30 days', NOW(), INTERVAL '6 hours') gs
  ) u;

  -- Pre-computed forecast so the widget/column show immediately (engine will refresh on its 6h tick)
  INSERT INTO scope_forecasts
    (scope_id, calculated_at, current_pct, growth_rate_per_day,
     days_to_80pct, days_to_90pct, days_to_full, confidence, recommendation, data_points)
  VALUES
    (v_scope_id, NOW(), 90.94, 2.7, NULL, 0, 9, 'high',
     'Critical — expand scope immediately', 120)
  ON CONFLICT (scope_id) DO UPDATE SET
    current_pct=EXCLUDED.current_pct, growth_rate_per_day=EXCLUDED.growth_rate_per_day,
    days_to_80pct=EXCLUDED.days_to_80pct, days_to_90pct=EXCLUDED.days_to_90pct,
    days_to_full=EXCLUDED.days_to_full, confidence=EXCLUDED.confidence,
    recommendation=EXCLUDED.recommendation, data_points=EXCLUDED.data_points,
    calculated_at=NOW();

  -- Behavioural baselines for the demo scope (all hours × all days-of-week)
  INSERT INTO device_baselines (scope_id, hour_of_day, day_of_week, avg_leases, stddev_leases, sample_count)
  SELECT v_scope_id, h, d,
         200 + (CASE WHEN h BETWEEN 8 AND 18 THEN 12 ELSE 0 END),
         9.0, 14
  FROM generate_series(0, 23) h, generate_series(0, 6) d
  ON CONFLICT (scope_id, hour_of_day, day_of_week) DO UPDATE SET
    avg_leases=EXCLUDED.avg_leases, stddev_leases=EXCLUDED.stddev_leases,
    sample_count=EXCLUDED.sample_count, calculated_at=NOW();

  -- Demo leases with device fingerprints (drives DHCP Device column + Device Donut)
  INSERT INTO dhcp_leases
    (server_id, scope_id, ip_address, hostname, mac_address, address_state,
     device_type, device_vendor, device_os, risk_level, is_mac_randomized,
     first_seen, last_seen, last_seen_subnet)
  VALUES
    (v_server_id, v_scope_cidr, '10.255.0.21', 'demo-iphone',     '00:17:AB:01:02:03', 'Active', 'mobile',      'Apple',  'iOS',     'low',    FALSE, NOW()-INTERVAL '20 days', NOW(), v_scope_cidr),
    (v_server_id, v_scope_cidr, '10.255.0.22', 'demo-laptop-01',  '00:1B:21:04:05:06', 'Active', 'workstation', 'Intel',  'Windows', 'low',    FALSE, NOW()-INTERVAL '40 days', NOW(), v_scope_cidr),
    (v_server_id, v_scope_cidr, '10.255.0.23', 'demo-printer',    '00:21:5A:07:08:09', 'Active', 'printer',     'HP',     NULL,      'low',    FALSE, NOW()-INTERVAL '60 days', NOW(), v_scope_cidr),
    (v_server_id, v_scope_cidr, '10.255.0.24', 'demo-voip-12',    '00:04:F2:0A:0B:0C', 'Active', 'voip',        'Polycom',NULL,      'low',    FALSE, NOW()-INTERVAL '10 days', NOW(), v_scope_cidr),
    (v_server_id, v_scope_cidr, '10.255.0.25', 'demo-switch',     '00:1B:54:0D:0E:0F', 'Active', 'network',     'Cisco',  NULL,      'low',    FALSE, NOW()-INTERVAL '90 days', NOW(), v_scope_cidr),
    (v_server_id, v_scope_cidr, '10.255.0.26', NULL,              '02:AA:BB:CC:DD:EE', 'Active', 'unknown',     'Unknown',NULL,      'high',   TRUE,  NOW()-INTERVAL '2 hours',  NOW(), v_scope_cidr);

  -- Demo IPAM supernet + a SENSITIVE subnet + classified addresses
  INSERT INTO ipam_supernets (network, prefix_length, name, description, site_id)
  VALUES ('10.255.0.0', 16, 'DEMO Supernet', 'smoke-test', 9999)
  RETURNING id INTO v_supernet_id;

  INSERT INTO ipam_subnets
    (network, prefix_length, name, description, supernet_id, is_managed, site_id,
     is_sensitive, total_hosts, used_hosts, free_hosts, unknown_hosts, scan_status, last_scanned)
  VALUES
    ('10.255.0.0', 24, 'DEMO Sensitive Subnet', 'smoke-test', v_supernet_id, TRUE, 9999,
     TRUE, 254, 62, 187, 5, 'done', NOW()-INTERVAL '2 days')
  RETURNING id INTO v_subnet_id;

  INSERT INTO ipam_addresses (subnet_id, ip_address, status, hostname, mac_address, device_type, device_vendor, risk_level, last_seen, updated_at)
  VALUES
    (v_subnet_id, '10.255.0.21', 'dhcp',    'demo-iphone',    '00:17:AB:01:02:03', 'mobile',      'Apple', 'low',  NOW(), NOW()),
    (v_subnet_id, '10.255.0.23', 'dhcp',    'demo-printer',   '00:21:5A:07:08:09', 'printer',     'HP',    'low',  NOW(), NOW()),
    (v_subnet_id, '10.255.0.99', 'unknown', NULL,             '02:AA:BB:CC:DD:EE', 'unknown',     'Unknown','high', NOW(), NOW());

  -- Variety of anomalies (Intelligence tab + Security Overview); all marked demo:true
  INSERT INTO anomaly_events (detected_at, anomaly_type, severity, entity_type, entity_id, description, details, acknowledged)
  VALUES
    (NOW()-INTERVAL '20 minutes', 'lease_spike',           'warning',  'scope',  v_scope_cidr,   'Lease count on DEMO Office LAN exceeded baseline (+2.4σ)', '{"demo":true,"current":248,"avg":206,"stddev":9}'::jsonb, FALSE),
    (NOW()-INTERVAL '2 hours',    'mac_spoofing',          'critical', 'device', '10.255.0.26',  'IP 10.255.0.26 seen with 2 different MACs within 30 minutes', '{"demo":true,"macs":["02:AA:BB:CC:DD:EE","02:11:22:33:44:55"]}'::jsonb, FALSE),
    (NOW()-INTERVAL '5 hours',    'new_device_vip_subnet', 'critical', 'device', '10.255.0.99',  'New unknown device appeared on SENSITIVE subnet 10.255.0.0/24', '{"demo":true,"subnet":"10.255.0.0/24"}'::jsonb, FALSE),
    (NOW()-INTERVAL '1 day',      'after_hours_device',    'warning',  'device', '10.255.0.26',  'New device first seen outside business hours', '{"demo":true}'::jsonb, FALSE),
    (NOW()-INTERVAL '3 days',     'dhcp_starvation',       'critical', 'server', v_server_id::text, 'Burst of DHCP DISCOVERs from many MACs (possible starvation)', '{"demo":true,"discovers":74,"distinct_macs":61}'::jsonb, TRUE);

  -- Site health score for the demo site (overall 72 → "warning" band)
  INSERT INTO site_health_scores
    (site_id, site_name, calculated_at, overall_score, dhcp_score, ipam_score, dns_score, security_score, details)
  VALUES
    (9999, 'DEMO Site', NOW(), 72, 60, 80, 100, 70,
     '{"demo":true,"dhcp":{"worstScopePct":90.94},"ipam":{"unknownRatio":0.08},"dns":{"maxQueryMs":40},"security":{"warnings":2,"criticals":2}}'::jsonb);

  -- Inactive demo recipient (shows in the table; will NOT receive email)
  INSERT INTO alert_recipients (email, name, role_filter, site_id, is_active)
  VALUES ('netops@demo.smoketest', 'DEMO NetOps (inactive)', 'warning', 9999, FALSE);

  RAISE NOTICE 'Smoke-test demo data seeded (server id=%, scope id=%, subnet id=%).', v_server_id, v_scope_id, v_subnet_id;
END $$;

COMMIT;

-- Verify:
--   SELECT * FROM scope_forecasts;
--   SELECT anomaly_type, severity, acknowledged FROM anomaly_events WHERE details->>'demo'='true';
--   SELECT * FROM site_health_scores WHERE site_id=9999;
