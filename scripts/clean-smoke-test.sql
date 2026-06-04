-- ============================================================
-- DDIVault — remove all SMOKE-TEST demo data seeded by seed-smoke-test.sql
-- Usage: psql -U ddivault_user -d ddivault -f scripts/clean-smoke-test.sql
-- Safe to run even if nothing was seeded.
-- ============================================================

BEGIN;

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

COMMIT;
