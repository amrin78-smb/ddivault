# DDIVault Database Schema Index

Raw PostgreSQL, no ORM. 4 schema files applied in order (all `IF NOT EXISTS` / idempotent):
1. `scripts/schema.sql` (807 lines) — core tables, triggers, functions, seed data
2. `scripts/schema-ipam.sql` (137 lines) — IPAM tables + columns on existing tables
3. `scripts/schema-server-auth.sql` (26 lines) — per-server auth columns on `ddi_servers`
4. `scripts/schema-sites.sql` (19 lines) — `site_id` columns on `ddi_servers`/`ipam_supernets`/`ipam_subnets`

Legend: `PK` primary key, `FK ->` foreign key, `UQ` unique (constraint/index), `IDX` indexed column.

---

## scripts/schema.sql

`ddi_servers`  id(PK,SERIAL) | hostname TEXT NOT NULL | ip_address INET | role TEXT DEFAULT 'both' | description TEXT | is_active BOOLEAN | last_polled TIMESTAMPTZ | poll_status TEXT | poll_error TEXT | created_at/updated_at TIMESTAMPTZ (trigger `trg_ddi_servers_updated`) | health_score INT | health_checked_at TIMESTAMPTZ | query_ms INT | is_dns_primary BOOLEAN | dns_forwarders TEXT[] | **(+ auth_mode, ps_username, ps_password [AES-256-GCM encrypted], winrm_port, winrm_https, winrm_test_ok, winrm_tested_at, notes from schema-server-auth.sql)** | **(+ site_id INT from schema-sites.sql, references netvault.sites.id cross-DB, no FK)**

`dhcp_scopes`  id(PK,SERIAL) | server_id INT NOT NULL — FK -> ddi_servers ON DELETE CASCADE | scope_id TEXT NOT NULL | name TEXT | start_range/end_range INET | subnet_mask TEXT | state TEXT | lease_duration TEXT | total_ips/in_use/free/reserved/pending INT | percent_used NUMERIC(5,2) | description TEXT | last_updated TIMESTAMPTZ | UQ(server_id, scope_id)

`dhcp_scope_history`  id(PK,BIGSERIAL) | scope_id INT NOT NULL — FK -> dhcp_scopes ON DELETE CASCADE | in_use/free/reserved INT | percent_used NUMERIC(5,2) | recorded_at TIMESTAMPTZ

`dhcp_leases`  id(PK,BIGSERIAL) | server_id INT NOT NULL — FK -> ddi_servers ON DELETE CASCADE | scope_id TEXT | ip_address INET NOT NULL | hostname TEXT | mac_address TEXT | client_id TEXT | address_state TEXT DEFAULT 'Active' | lease_start/lease_expiry TIMESTAMPTZ | last_seen TIMESTAMPTZ | UQ(server_id, ip_address) | **(+ device_type, device_vendor, device_os, risk_level DEFAULT 'unknown', is_mac_randomized BOOLEAN, first_seen TIMESTAMPTZ, last_seen_subnet TEXT — Feature 3/6 fingerprinting, added later in same file)**

`lease_history`  id(PK,BIGSERIAL) | server_id INT — FK -> ddi_servers (no ON DELETE) | ip_address INET NOT NULL | hostname TEXT | mac_address TEXT | scope_id TEXT | event_type TEXT ('assign'/'renew'/'release'/'expire'/'conflict'/'decline'/'nack') | event_time TIMESTAMPTZ

`dhcp_events`  id(PK,BIGSERIAL) | server_id INT — FK -> ddi_servers | event_id INT (Windows DHCP event ID) | event_type TEXT | ip_address TEXT (plain TEXT, not INET) | hostname TEXT | mac_address TEXT | scope_id TEXT | description TEXT | raw_line TEXT | event_time TIMESTAMPTZ NOT NULL | inserted_at TIMESTAMPTZ | UQ idx `idx_events_dedup`(server_id, event_time, ip_address, event_id) WHERE ip_address IS NOT NULL

`ipam_subnets`  id(PK,SERIAL) | network INET NOT NULL | prefix_length INT NOT NULL | name TEXT | description TEXT | gateway INET | vlan_id INT | site TEXT | owner TEXT | is_managed BOOLEAN | created_at/updated_at TIMESTAMPTZ (trigger `trg_ipam_subnets_updated`) | UQ(network, prefix_length) | **(+ is_sensitive BOOLEAN DEFAULT FALSE, added later in schema.sql — Feature 3/6)** | **(+ supernet_id INT FK -> ipam_supernets ON DELETE SET NULL, location, notes, last_scanned, scan_status, total_hosts, used_hosts, free_hosts, unknown_hosts from schema-ipam.sql)** | **(+ site_id INT from schema-sites.sql; table also already had `site TEXT` — both coexist)**

`dns_zones`  id(PK,SERIAL) | server_id INT NOT NULL — FK -> ddi_servers ON DELETE CASCADE | zone_name TEXT NOT NULL | zone_type TEXT | is_reverse/is_ds_integrated/is_auto_created BOOLEAN | record_count INT | last_updated TIMESTAMPTZ | UQ(server_id, zone_name) | **(+ soa_serial BIGINT, soa_checked_at TIMESTAMPTZ, replication_lag BOOLEAN — HA section)** | **(+ soa_serial BIGINT dup-declared, record_count_a/ptr/cname/mx INT, scavenging_enabled BOOLEAN, aging_enabled BOOLEAN, last_scavenged TIMESTAMPTZ — DNS Health section, all later in same file)**

`dns_records`  id(PK,BIGSERIAL) | zone_id INT NOT NULL — FK -> dns_zones ON DELETE CASCADE | hostname TEXT NOT NULL | record_type TEXT NOT NULL | record_data TEXT | ttl INT | last_seen TIMESTAMPTZ | UQ constraint `dns_records_unique`(zone_id, hostname, record_type, record_data) added idempotently via DO block after a one-time de-dup DELETE

`alert_rules`  id(PK,SERIAL) | name TEXT NOT NULL | description TEXT | rule_type TEXT NOT NULL | threshold_value NUMERIC | severity TEXT DEFAULT 'warning' (plain TEXT, no CHECK) | is_enabled BOOLEAN | created_at TIMESTAMPTZ | seeded with 4 default rules

`alert_events`  id(PK,BIGSERIAL) | rule_id INT — FK -> alert_rules | server_id INT — FK -> ddi_servers | scope_id TEXT | message TEXT NOT NULL | severity TEXT NOT NULL | acknowledged BOOLEAN | acknowledged_by TEXT | acknowledged_at TIMESTAMPTZ | fired_at TIMESTAMPTZ | **(+ resolved_at TIMESTAMPTZ, resolved_reason TEXT — added later, critical: collector errors without these, see CLAUDE.md upgrade note)**

`app_settings`  key(PK,TEXT) | value TEXT | updated_at TIMESTAMPTZ | seeded with app_name/app_subtitle/company_name/theme/retention_days

`audit_log`  id(PK,BIGSERIAL) | timestamp TIMESTAMPTZ | user_id INTEGER | username TEXT NOT NULL DEFAULT 'system' | user_role TEXT | action TEXT NOT NULL | entity_type TEXT NOT NULL | entity_id TEXT | entity_name TEXT | old_value/new_value JSONB | change_summary TEXT | ip_address TEXT | user_agent TEXT | session_id TEXT | result TEXT DEFAULT 'success' | error_message TEXT | duration_ms INTEGER | site_id INTEGER | server_id INTEGER

`api_keys`  id(PK,SERIAL) | key_hash TEXT NOT NULL UNIQUE (SHA-256 hash — SECRET, never expose) | key_prefix TEXT NOT NULL | name TEXT NOT NULL | description TEXT | created_by TEXT | created_at TIMESTAMPTZ | last_used_at TIMESTAMPTZ | expires_at TIMESTAMPTZ | is_active BOOLEAN | permissions JSONB DEFAULT '{"read":true,"write":false,"admin":false}' | allowed_ips TEXT[] | request_count BIGINT

`dhcp_failover_pairs`  id(PK,SERIAL) | primary_server_id/secondary_server_id INTEGER — FK -> ddi_servers ON DELETE CASCADE | relationship_name TEXT | mode TEXT | state TEXT | last_checked TIMESTAMPTZ | mclt INTEGER | split_ratio INTEGER

`dhcp_scope_sync_status`  id(PK,SERIAL) | scope_id INTEGER — FK -> dhcp_scopes ON DELETE CASCADE | failover_pair_id INTEGER — FK -> dhcp_failover_pairs ON DELETE CASCADE | primary_leases/secondary_leases INTEGER | sync_delta INTEGER | sync_status TEXT | checked_at TIMESTAMPTZ

`server_health_history`  id(PK,BIGSERIAL) | server_id INTEGER NOT NULL — FK -> ddi_servers ON DELETE CASCADE | health_score INTEGER (0-100) | winrm_ok BOOLEAN | scope_count/lease_count/zone_count/record_count INTEGER | query_ms INTEGER | soa_in_sync BOOLEAN | failover_state TEXT | recorded_at TIMESTAMPTZ

`smtp_config`  id(PK,SERIAL) | host TEXT NOT NULL | port INT DEFAULT 587 | secure BOOLEAN | username TEXT | **password TEXT — AES-256-GCM encrypted via credStore.js (SECRET column)** | from_email TEXT NOT NULL | from_name TEXT | enabled BOOLEAN | updated_at TIMESTAMPTZ

`alert_recipients`  id(PK,SERIAL) | email TEXT NOT NULL | name TEXT | role_filter TEXT (null=all/'critical'/'warning'/'info') | site_id INT (null=all sites, no FK — cross-DB) | is_active BOOLEAN | created_at TIMESTAMPTZ

`alert_rule_config`  id(PK,SERIAL) | rule_type TEXT NOT NULL UNIQUE | is_enabled BOOLEAN | threshold_value NUMERIC | threshold_unit TEXT | severity TEXT DEFAULT 'warning' | cooldown_mins INT DEFAULT 60 | digest_mode BOOLEAN | created_at/updated_at TIMESTAMPTZ | seeded with 18 rule-type rows (ON CONFLICT (rule_type) DO NOTHING) + guarded migration UPDATEs for 3 rules

`alert_email_log`  id(PK,BIGSERIAL) | alert_id BIGINT — FK -> alert_events | recipient TEXT NOT NULL | subject TEXT | sent_at TIMESTAMPTZ | status TEXT DEFAULT 'sent' | error_msg TEXT

`scope_forecasts`  id(PK,SERIAL) | scope_id INTEGER — FK -> dhcp_scopes ON DELETE CASCADE | calculated_at TIMESTAMPTZ | current_pct NUMERIC(5,2) | growth_rate_per_day NUMERIC(8,4) | days_to_80pct/90pct/full INT | confidence TEXT | recommendation TEXT | data_points INT | status TEXT DEFAULT 'ok' | UQ idx on scope_id

`subnet_forecasts`  id(PK,SERIAL) | subnet_id INTEGER — FK -> ipam_subnets ON DELETE CASCADE | calculated_at TIMESTAMPTZ | current_used/total_hosts INT | growth_rate_per_day NUMERIC(8,4) | days_to_80pct/full INT | confidence TEXT | recommendation TEXT | UQ idx on subnet_id (CLAUDE.md notes: "reserved; no history source yet")

`device_baselines`  id(PK,BIGSERIAL) | scope_id INTEGER — FK -> dhcp_scopes ON DELETE CASCADE | hour_of_day INT | day_of_week INT | avg_leases/stddev_leases NUMERIC(8,2) | sample_count INT | calculated_at TIMESTAMPTZ | UQ idx (scope_id, hour_of_day, day_of_week)

`anomaly_events`  id(PK,BIGSERIAL) | detected_at TIMESTAMPTZ | anomaly_type TEXT NOT NULL | severity TEXT NOT NULL | entity_type TEXT | entity_id TEXT | description TEXT | details JSONB | acknowledged BOOLEAN | acknowledged_at TIMESTAMPTZ | acknowledged_by TEXT

`site_health_scores`  id(PK,SERIAL) | site_id INT NOT NULL (no FK — cross-DB) | site_name TEXT | calculated_at TIMESTAMPTZ | overall_score/dhcp_score/ipam_score/dns_score/security_score INT | details JSONB

`dns_server_roles`  id(PK,SERIAL) | server_id INTEGER — FK -> ddi_servers ON DELETE CASCADE | is_primary/is_pdc_emulator BOOLEAN | forest_root TEXT | domain TEXT | replication_type TEXT DEFAULT 'ad-integrated' | detected_at/updated_at TIMESTAMPTZ | UQ(server_id)

`dns_zone_sync`  id(PK,BIGSERIAL) | zone_name TEXT NOT NULL | server_id INTEGER — FK -> ddi_servers ON DELETE CASCADE | soa_serial BIGINT | soa_primary/soa_email TEXT | soa_refresh/soa_retry/soa_expire/soa_ttl INTEGER | record_count INTEGER | is_in_sync BOOLEAN | lag_seconds INTEGER | checked_at TIMESTAMPTZ | UQ(zone_name, server_id)

`dns_query_stats`  id(PK,BIGSERIAL) | server_id INTEGER — FK -> ddi_servers ON DELETE CASCADE | recorded_at TIMESTAMPTZ | total_queries/successful/failed/nxdomain_count BIGINT | response_time_ms INTEGER | queries_per_sec NUMERIC(10,2)

`dns_stale_records`  id(PK,BIGSERIAL) | zone_id INTEGER — FK -> dns_zones ON DELETE CASCADE | hostname TEXT | record_type TEXT | record_data TEXT | last_updated TIMESTAMPTZ | days_stale INTEGER | detected_at TIMESTAMPTZ

`dns_forwarder_health`  id(PK,SERIAL) | server_id INTEGER — FK -> ddi_servers ON DELETE CASCADE | forwarder_ip TEXT NOT NULL | is_reachable BOOLEAN | response_time_ms INTEGER | last_checked TIMESTAMPTZ | UQ(server_id, forwarder_ip)

`saved_reports`  id(PK,SERIAL) | name TEXT NOT NULL | report_type TEXT NOT NULL | params JSONB DEFAULT '{}' | created_by TEXT | created_at/updated_at TIMESTAMPTZ

`report_schedules`  id(PK,SERIAL) | name TEXT NOT NULL | report_type TEXT NOT NULL | params JSONB DEFAULT '{}' | format TEXT DEFAULT 'pdf' ('pdf'/'csv') | cadence TEXT DEFAULT 'weekly' | hour INT DEFAULT 7 | day_of_week INT | day_of_month INT | recipients TEXT[] DEFAULT '{}' | enabled BOOLEAN | last_run_at TIMESTAMPTZ | last_status TEXT | next_run_at TIMESTAMPTZ | created_by TEXT | created_at/updated_at TIMESTAMPTZ

`report_run_history`  id(PK,BIGSERIAL) | schedule_id INT — FK -> report_schedules ON DELETE SET NULL | report_type TEXT NOT NULL | format TEXT DEFAULT 'pdf' | params JSONB DEFAULT '{}' | row_count INT | status TEXT DEFAULT 'success' | error_msg TEXT | trigger_type TEXT DEFAULT 'manual' | generated_by TEXT | created_at TIMESTAMPTZ

`report_email_log`  id(PK,BIGSERIAL) | schedule_id INT — FK -> report_schedules ON DELETE SET NULL | run_id BIGINT — FK -> report_run_history ON DELETE SET NULL | recipient TEXT NOT NULL | subject TEXT | status TEXT NOT NULL | error_msg TEXT | sent_at TIMESTAMPTZ

Also in this file: `update_updated_at()` trigger function (used by `ddi_servers`, `ipam_subnets`, `ipam_supernets`, `ipam_addresses`); a `nocvault_readonly` cross-DB grant DO-block (GRANT SELECT ON ALL TABLES + ALTER DEFAULT PRIVILEGES, no-op if role absent — see Privilege notes).

---

## scripts/schema-ipam.sql

`ipam_supernets`  id(PK,SERIAL) | network INET NOT NULL | prefix_length INT NOT NULL | name TEXT | description TEXT | site TEXT | created_at/updated_at TIMESTAMPTZ (trigger `trg_ipam_supernets_updated`) | UQ(network, prefix_length) | **(+ site_id INT from schema-sites.sql)**

`ipam_addresses`  id(PK,BIGSERIAL) | subnet_id INT NOT NULL — FK -> ipam_subnets ON DELETE CASCADE | ip_address INET NOT NULL | status TEXT DEFAULT 'unknown' ('available'/'dhcp'/'reserved'/'unknown'/'offline') | hostname TEXT | mac_address TEXT | description TEXT | owner TEXT | last_seen/last_ping TIMESTAMPTZ | ping_ms INT | dhcp_lease_id BIGINT — FK -> dhcp_leases ON DELETE SET NULL | is_reserved BOOLEAN | reserved_by TEXT | reserved_at TIMESTAMPTZ | created_at/updated_at TIMESTAMPTZ (trigger `trg_ipam_addresses_updated`) | UQ(subnet_id, ip_address) | **(+ device_type, device_vendor, risk_level DEFAULT 'unknown', is_sensitive BOOLEAN DEFAULT FALSE — added later in same file)**

`ipam_vlans`  id(PK,SERIAL) | vlan_id INT NOT NULL UNIQUE | name TEXT | description TEXT | site TEXT | created_at TIMESTAMPTZ

`ipam_scan_jobs`  id(PK,BIGSERIAL) | subnet_id INT NOT NULL — FK -> ipam_subnets ON DELETE CASCADE | started_at TIMESTAMPTZ | completed_at TIMESTAMPTZ | status TEXT DEFAULT 'running' | hosts_scanned/hosts_up/hosts_unknown INT | error_msg TEXT | **(+ progress_pct INT, updated_at TIMESTAMPTZ — added later in same file; schema.sql also has a defensive DO-block guarding these same ALTERs in case schema.sql runs after this file)**

`ipam_audit`  id(PK,BIGSERIAL) | ip_address INET NOT NULL | subnet_id INT — FK -> ipam_subnets (no ON DELETE) | action TEXT NOT NULL ('discovered'/'reserved'/'released'/'status_change'/'scan') | old_status/new_status TEXT | hostname TEXT | mac_address TEXT | performed_by TEXT DEFAULT 'system' | notes TEXT | created_at TIMESTAMPTZ

`ipam_utilization_history`  id(PK,BIGSERIAL) | recorded_at TIMESTAMPTZ | total_ips/used_ips/free_ips INTEGER | utilization_pct NUMERIC(5,2)

Also alters `ipam_subnets` (added: supernet_id, location, notes, last_scanned, scan_status, total_hosts, used_hosts, free_hosts, unknown_hosts — see schema.sql section above for the full column list).

---

## scripts/schema-server-auth.sql

Adds columns to `ddi_servers` (table created in schema.sql):
- `auth_mode TEXT DEFAULT 'kerberos'` — 'kerberos' (domain SSO) / 'credential' (stored creds) / 'local' (run PS locally)
- `ps_username TEXT`
- **`ps_password TEXT`** — AES-256-GCM encrypted (Node crypto, key = `NEXTAUTH_SECRET`/`DDI_CRED_SECRET`) — SECRET, never expose
- `winrm_port INT DEFAULT 5985`
- `winrm_https BOOLEAN DEFAULT FALSE`
- `winrm_test_ok BOOLEAN`
- `winrm_tested_at TIMESTAMPTZ`
- `notes TEXT`

Index: `idx_ddi_servers_active ON ddi_servers(is_active) WHERE is_active = TRUE`. Column comments document the auth flow and note the AES-256 encryption + key source.

No new tables.

---

## scripts/schema-sites.sql

Adds `site_id INT` (no FK — id references `netvault.sites.id` in a **different database**, resolved live via cross-DB read, never joined in-DB) to three existing tables:
- `ddi_servers.site_id`
- `ipam_supernets.site_id`
- `ipam_subnets.site_id` (coexists with the pre-existing `ipam_subnets.site TEXT` free-text column)

No new tables, no indexes.

---

## Table count

**41 tables total**: 35 created in `schema.sql`, 6 created in `schema-ipam.sql`
(`ipam_supernets`, `ipam_addresses`, `ipam_vlans`, `ipam_scan_jobs`, `ipam_audit`,
`ipam_utilization_history`). `schema-server-auth.sql` and `schema-sites.sql` add
columns only — 0 new tables from either.

The 35 in `schema.sql`: ddi_servers, dhcp_scopes, dhcp_scope_history, dhcp_leases,
lease_history, dhcp_events, ipam_subnets, dns_zones, dns_records, alert_rules,
alert_events, app_settings, audit_log, api_keys, dhcp_failover_pairs,
dhcp_scope_sync_status, server_health_history, smtp_config, alert_recipients,
alert_rule_config, alert_email_log, scope_forecasts, subnet_forecasts,
device_baselines, anomaly_events, site_health_scores, dns_server_roles,
dns_zone_sync, dns_query_stats, dns_stale_records, dns_forwarder_health,
saved_reports, report_schedules, report_run_history, report_email_log.

---

## Known schema debt

- **`ipam_addresses.is_sensitive`** (schema-ipam.sql line 125, `BOOLEAN DEFAULT FALSE`) is declared but appears **unused by any application code**. Grepped `api/`, `collector/` for `is_sensitive` — every read/write hit is against `ipam_subnets.is_sensitive` instead (`api/server.js` lines 2630/2635/2641 read/write the subnet-level flag via the subnet update route; `collector/anomalyDetector.js` line 418 filters `ipam_subnets s WHERE s.is_sensitive = TRUE` for the `new_device_vip_subnet` rule). The per-address sensitivity flag on `ipam_addresses` looks like a leftover from an earlier design that moved to subnet-level granularity — column is harmless (defaults FALSE) but dead weight; confirm before building anything that assumes it's populated.
- **`dhcp_events.ip_address` is plain `TEXT`**, not `INET` like every sibling table (`dhcp_leases.ip_address`, `lease_history.ip_address`, `ipam_addresses.ip_address` are all `INET`). Not necessarily a bug (event log lines may arrive with malformed/partial IP strings that wouldn't cast), but it's an inconsistency worth knowing before writing a query that does `INET`-typed comparisons/joins against this column — it will need an explicit `::inet` cast and may fail on dirty input that the other tables would reject at write time.
- **No JSON.parse/JSONB type mismatches found.** Checked `audit_log.old_value/new_value`, `anomaly_events.details`, `site_health_scores.details`, `saved_reports.params`, `report_schedules.params`, `report_run_history.params`, `api_keys.permissions` — all declared `JSONB` in schema and all written via `JSON.stringify(...)` (e.g. `api/server.js:4459` for `api_keys.permissions`) or passed as plain JS objects to `pg`, which is the correct pattern; no evidence of manual `JSON.parse` being applied to a non-JSONB column.
- **`smtp_config.password` and `ddi_servers.ps_password` are correctly encrypted TEXT**, not a mismatch — confirmed both are only ever written via `encryptCred()`/`credStore.js` `encrypt()` (AES-256-GCM) and read back via `decryptCred()`/`decrypt()`; the schema comments (`schema.sql:420`, `schema-server-auth.sql:12,25-26`) match actual usage in `api/server.js` (lines 1824-1827, 2321, 2364-2365, 3021, 3179) and `collector/credStore.js`.
- **Device-fingerprint columns** (`dhcp_leases.{device_type,device_vendor,device_os,risk_level,is_mac_randomized,first_seen,last_seen_subnet}`, `ipam_addresses.{device_type,device_vendor,risk_level}`) are all present in schema and all actively written by `collector/collector.js` (lines 364-367, dhcp_leases) and `collector/ipamScanner.js` (lines 359-378, ipam_addresses) with matching column lists in the `INSERT`/`UPDATE` statements — no drift found. `dhcp_leases.last_seen_subnet` was not found written anywhere in a targeted grep of `collector/`/`api/` — likely reserved/future column; low-confidence finding, worth a follow-up grep before relying on it being populated.

## Privilege notes

**(a) Credential/secret columns — must never be exposed to a readonly role or a view:**
- `smtp_config.password` — AES-256-GCM encrypted TEXT (schema.sql:420)
- `ddi_servers.ps_password` — AES-256-GCM encrypted TEXT (schema-server-auth.sql:12; comment at line 25-26 confirms encryption + key source)
- `api_keys.key_hash` — SHA-256 hash of the public API key (schema.sql:329) — not reversible, but still shouldn't be casually exposed (hash + prefix together aid brute-force/enumeration)
- `app_settings.value` — generic key/value table; holds no secret keys as of this audit (`app_name`/`app_subtitle`/`company_name`/`retention_days`/`scan_dns_server`/`theme` only), but nothing stops a future secret-shaped key being added without remembering to protect it — treated as sensitive-by-default anyway (see FIXED note below).
- No separate HMAC secret column exists in the DB — the one-click alert-ack HMAC token (`api/emailer.js`, referenced in CLAUDE.md) is signed with an in-memory/env secret, not a stored DB column.

Both encrypted-password columns derive their key from `NEXTAUTH_SECRET` (or `DDI_CRED_SECRET`) — `collector/credStore.js` throws at module load if neither env var is set (no weak hardcoded fallback), so the encryption key itself lives outside the DB entirely (env var), which is correct defense-in-depth even if the DB were exposed.

**FIXED 2026-07:** `nocvault_readonly`/`claude_readonly` no longer get table-level SELECT on `app_settings` or `api_keys` at all — they read `app_settings_public` (an ALLOWLIST view: only `app_name`/`app_subtitle`/`company_name`/`theme`) and `api_keys_public` (every column except `key_hash`) instead. `smtp_config`/`ddi_servers.ps_password` are NOT given any `*_public` view — ciphertext-with-no-read-access is safer than any filtered view of it, and neither role has a legitimate need to read it. A REVOKE+view-GRANT block runs immediately after the blanket grant in `schema.sql`, every time it runs, so this can't be silently re-opened by a future deploy.

**(b) No dedicated readonly DB role/grant script ships in this repo's `scripts/` or `installer/`.** Confirmed: `scripts/` contains only the 4 schema files + `seed-smoke-test.sql`/`clean-smoke-test.sql` (no `schema-grants.sql`); `installer/` contains only `Update-DDIVault.ps1`. There IS a `nocvault_readonly` role grant, but it lives in two places, both OUTSIDE a dedicated grants file:
  1. **`scripts/schema.sql` itself** — a DO-block that, if the `nocvault_readonly` role already exists (created elsewhere), grants it `USAGE` on schema public + `SELECT` on all tables + sets `ALTER DEFAULT PRIVILEGES` so future `ddivault_user`-created tables are auto-covered — followed immediately (2026-07) by the `app_settings_public`/`api_keys_public` narrowing block above. No-op on a standalone install with no Hub role.
  2. **The suite installer** `../netvault/installer/Install-NocVault-Suite.ps1` does the DDIVault-specific provisioning via a shared helper, `GrantNocRoRead "ddivault"` — an unconditional `GRANT CONNECT`/`USAGE`/`SELECT ON ALL TABLES`/`ALTER DEFAULT PRIVILEGES` to `nocvault_readonly` (never `claude_readonly`). **Reordered 2026-07**: this now runs BEFORE the 4 schema files apply, not after — it used to run after, which meant its own blanket grant executed AFTER `schema.sql`'s narrowing fix and silently undid it on every fresh suite install (whichever grant runs last wins in Postgres). Running it before any table exists is safe: `GRANT SELECT ON ALL TABLES` on zero tables is a no-op, and the `ALTER DEFAULT PRIVILEGES` it sets only auto-grants SELECT on tables about to be created, which `schema.sql`'s own later REVOKE still correctly narrows regardless of how the grant first landed.

  The separate **`claude_readonly`** Postgres user (mentioned in this app's `CLAUDE.md` "Database Access (Read-Only Diagnostics)" section, password out-of-repo in Claude project memory) was previously entirely outside any schema file — confirmed as of 2026-07 it now IS covered by `scripts/schema.sql`'s narrowing block above (same `app_settings_public`/`api_keys_public` views), but its INITIAL blanket grant (however it originally got table-level access) is still not something any file in this repo creates — it was set up manually, out-of-band. If `claude_readonly` doesn't exist on a given server, the `IF EXISTS` guard makes the narrowing block a safe no-op there too.

**(c) Cross-DB grant direction — `ddivault_user` → `netvault.sites`/`netvault.countries`:**
  - Documented in this app's `CLAUDE.md` under "Cross-DB access (NetVault sites)" as a manual `GRANT CONNECT`/`GRANT USAGE`/`GRANT SELECT` run against the `netvault` DB.
  - **Not captured in any ddivault schema file** (by design — ddivault's own schema files only touch the `ddivault` DB, never `netvault`).
  - **Is captured in the suite installer**: `Install-NocVault-Suite.ps1` lines 640-642 run exactly this grant (`GRANT CONNECT ON DATABASE netvault TO ddivault_user`, `GRANT USAGE ON SCHEMA public TO ddivault_user`, `GRANT SELECT ON sites, countries TO ddivault_user`) as part of the DDIVault install block — so fresh installs get it automatically; it is not a manual step an admin must remember.
  - This is the opposite direction from the `nocvault_readonly` grant in (b) — that one is `ddivault`'s own tables being read BY the Hub; this one is `ddivault_user` reading two specific `netvault` tables. Both directions are provisioned by the same installer script but via different mechanisms (installer-issued GRANT vs. schema-file DO-block).
