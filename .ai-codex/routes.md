Express routes: no force-dynamic concept applies.

Total routes found: 165 (162 Express + 3 Next.js route handlers)
- api/server.js: 125 routes (app.get/post/put/patch/delete)
- api/v1.js: 23 routes (mounted at /api/v1)
- api/reports.js: 3 routes (mounted at /api/reports, registered AFTER reportsScheduling.js)
- api/reportsScheduling.js: 11 routes (mounted at /api/reports, registered BEFORE reports.js)
- frontend Next.js route handlers: 3 (GET+POST /api/auth/[...nextauth], POST /api/sso)

Auth-tag legend: `public` = reachable with no NextAuth session per middleware.ts
PUBLIC_API/ACK_LINK_API allowlist; `auth` = requireAuth (any signed-in role, viewer+);
`write` = requireWrite (admin+); `super-admin` = requireSuperAdmin; `apikey` =
api/v1.js routes gated by apiAuth.js (read/write permission on the key);
`auth+site-filter` = requireAuth/attachSiteFilter (attachSiteFilter itself calls
getRequestUser and 401s with no identity, so it enforces auth even when used alone).

---

## Health & System (api/server.js)

GET /api/health public db — DB connectivity + version check, `{status,db,version}`
GET /api/stats public db — no-auth summary counts (dns_servers/dhcp_clusters/ip_utilized) for hub tiles; never 500s
GET /api/license-status public external — current NocVault hub license + derived enforcement state (getLicense/getLicenseState, 5-min cache)
GET /api/hub/settings auth external — server-side proxy to NocVault hub `/api/settings` (avoids browser CORS)
GET /api/system/update-status auth external — git ls-remote/fetch HEAD vs local HEAD commit, release notes for the offered version
GET /api/system/update-available public external — cached (24h-refreshed) update-availability flag, no live I/O at request time
GET /api/system/last-update-status public — reads logs/last-update-status.json written by Update-DDIVault.ps1 (stage/error code/rollback outcome of the last update run); {exists:false} if none yet
POST /api/system/update super-admin external — schedules a SYSTEM `schtasks` task running Update-DDIVault.ps1; license-gated

## DHCP (api/server.js)

GET /api/scopes auth+site-filter db — all DHCP scopes w/ server hostname/IP join
GET /api/scopes/:scopeId/history auth+site-filter db — utilization history for one scope (dhcp_scope_history)
GET /api/scopes/:scopeId/leases auth+site-filter db — paginated leases for a scope
POST /api/scopes write db+external — create DHCP scope via WinRM (psWrite.createDhcpScope) + upsert dhcp_scopes
PUT /api/scopes/:scopeId write db+external — edit scope via WinRM + update dhcp_scopes
PATCH /api/scopes/:scopeId/state write db+external — set Active/InActive via WinRM + update state
DELETE /api/scopes/:scopeId write db+external — delete scope via WinRM + delete leases/scope rows
GET /api/scopes/:scopeId/options auth+site-filter db+external — read DHCP scope options via WinRM
POST /api/scopes/:scopeId/options write db+external — set a DHCP scope option via WinRM
GET /api/scopes/:scopeId/exclusions auth+site-filter db+external — read DHCP exclusions via WinRM
POST /api/scopes/:scopeId/exclusions write db+external — add a DHCP exclusion range via WinRM
GET /api/leases auth db — paginated/filterable lease list (search/scope/state/device_type)
GET /api/leases/ip/:ip/history auth db — lease_history for one IP
GET /api/leases/export auth db — CSV export of all leases (formula-injection-safe via escapeCsvCell)
GET /api/events auth+site-filter db — DHCP log events, filterable by hours/type/severity
POST /api/dhcp/reservations write db+external — create DHCP reservation via WinRM
DELETE /api/dhcp/reservations write db+external — remove DHCP reservation via WinRM
GET /api/dhcp/reservations/:serverId/:scopeId auth+site-filter db+external — list reservations for a scope via WinRM
GET /api/subnets auth+site-filter db — legacy simple subnets table (distinct from ipam_subnets), used-IP count via dhcp_leases join
POST /api/subnets write db — create/upsert legacy subnet row
PUT /api/subnets/:id write db — update legacy subnet row
DELETE /api/subnets/:id write db — delete legacy subnet row
GET /api/scopes/history/all auth+site-filter db — utilization history for all scopes, grouped (sparklines)

## DNS (api/server.js)

GET /api/dns/zones auth+site-filter db — all DNS zones w/ server hostname
GET /api/dns/records auth+site-filter db — paginated/filterable DNS records (search/type/zone_id)
GET /api/dns/record-type-breakdown auth+site-filter db — record count grouped by type (for donut chart)
GET /api/dns/servers auth+site-filter db — DNS-capable servers from ddi_servers
POST /api/dns/records write db+external — add A/AAAA/CNAME/PTR/MX/TXT/SRV record via WinRM, upsert dns_records
DELETE /api/dns/records write db+external — remove a DNS record via WinRM + delete dns_records row
POST /api/dns/zones write db+external — create zone (Primary/Secondary/Forwarder) via WinRM, insert dns_zones
DELETE /api/dns/zones/:id write db+external — remove zone via WinRM + delete dns_zones row
GET /api/dns/stats/:serverId auth+site-filter db+external — live DNS server stats via WinRM (psWrite.getDnsServerStats)
GET /api/dns/health auth db — aggregate DNS health summary (10 parallel count queries: zones/servers/sync/forwarders/stale/scavenging)
GET /api/dns/topology auth+site-filter db — servers with roles, zone/record counts (topology diagram data)
GET /api/dns/zones/sync auth+site-filter db — SOA serial comparison matrix across all zones/servers
GET /api/dns/zones/:name/sync auth+site-filter db — SOA sync detail for one zone (must be registered after /zones/sync)
GET /api/dns/forwarders auth+site-filter db — forwarder health list (dns_forwarder_health)
GET /api/dns/stale-records auth+site-filter db — stale DNS records, filterable by zone_id/min_days
GET /api/dns/query-stats auth+site-filter db — 24h DNS query stats history per server
GET /api/dns/scavenging auth+site-filter db — scavenging/aging config per zone
POST /api/dns/forwarders/test write db+external — live forwarder reachability probe via WinRM, upserts dns_forwarder_health
POST /api/dns/scavenging/enable write db+external — enable/disable zone scavenging via WinRM (psWrite.setDnsZoneAging)
POST /api/dns/stale-records/cleanup write db+external — bulk-delete stale records via WinRM across servers

## IPAM (api/server.js)

GET /api/ipam/supernets auth+site-filter db — supernets w/ aggregated subnet/host counts
POST /api/ipam/supernets write db — create/upsert supernet
PUT /api/ipam/supernets/:id write db — update supernet
DELETE /api/ipam/supernets/:id write db — delete supernet
GET /api/ipam/subnets auth+site-filter db — subnets w/ supernet join + per-status IP counts; also runs expireStuckScans()
POST /api/ipam/subnets write db — create/upsert subnet
PUT /api/ipam/subnets/:id write db — update subnet (incl. is_sensitive toggle)
DELETE /api/ipam/subnets/:id write db — delete subnet
GET /api/ipam/subnets/:id/addresses auth+site-filter db — IP addresses in a subnet, joined to dhcp_leases
POST /api/ipam/subnets/:id/addresses/:ip/reserve write db — reserve an IP (upsert ipam_addresses + ipam_audit)
POST /api/ipam/subnets/:id/addresses/:ip/release write db — release a reserved IP
POST /api/ipam/subnets/:id/scan write db+external — trigger async subnet scan (child_process.fork scanWorker.js, live ping/probe)
POST /api/ipam/scan-all write db+external — trigger a scan of every managed subnet
POST /api/ipam/sync-from-dhcp write db+external — reconcile IPAM from live DHCP scopes across all active servers via WinRM
GET /api/ipam/subnets/:id/scan-status auth+site-filter db — single-subnet scan/job status + live IP counts
GET /api/ipam/scan-status auth+site-filter db — global scan status (all running jobs + all managed subnets)
GET /api/ipam/vlans auth db — VLAN list (ipam_vlans has no site_id column, so no site-filter precedent)
POST /api/ipam/vlans write db — create/upsert VLAN
DELETE /api/ipam/vlans/:id write db — delete VLAN
GET /api/ipam/audit auth+site-filter db — IPAM change audit trail, filterable by ip, site-scoped via subnet_id EXISTS subquery
GET /api/ipam/subnets/:id/next-ip auth+site-filter db — compute first available host IP in a subnet (in-process, no external probe)
GET /api/ipam/supernets/:id/next-subnet auth+site-filter db — compute next available subnet block within a supernet
GET /api/ipam/conflicts auth+site-filter db — overlapping-subnet detection (inet && operator), OR-scoped on either side's site
GET /api/ipam/utilization-history auth db — whole-system hourly utilization snapshots (no site_id column, global aggregate)
POST /api/ipam/import write db — bulk CSV/Excel subnet import (upsert loop)
GET /api/search auth+site-filter db — smart search: `type:`/`vendor:`/`subnet:`/`scope:`/`site:`/`new:`/`risk:`/`anomaly:`/`status:` structured queries + free-text fallback across leases/subnets/dns

## Servers (api/server.js)

GET /api/servers auth+site-filter db — known DHCP/DNS servers, enriched with NetVault site names (netvaultDb query), password stripped
POST /api/servers write db+external — add server (encrypts ps_password) + fire-and-forget addToTrustedHosts (WinRM)
PUT /api/servers/:id write db — update server row (re-encrypts password only if changed)
DELETE /api/servers/:id write db — delete server
POST /api/servers/:id/test-connection write db+external — live WinRM connectivity test (psWrite.testWinRM), records result

## Alerts / Alert Rules / Recipients (api/server.js)

GET /api/alerts auth db — paginated alerts, grouped/deduplicated by hour+shape, enriched with plain-English explanation
POST /api/alerts/:id/acknowledge write db — ack an alert (and its grouped siblings within the same hour)
POST /api/alerts/acknowledge-all write db — bulk-ack all open alerts, optional severity filter
GET /api/alert-rules auth db — list alert_rules
PUT /api/alert-rules/:id write db — update threshold_value/is_enabled on a rule
GET /api/smtp super-admin db — SMTP config (password masked)
POST /api/smtp super-admin db — upsert SMTP config (encrypts password), invalidates emailer cache
POST /api/smtp/test super-admin external — send a live test email (emailer.sendTestEmail, SMTP)
GET /api/alert-recipients auth db — list alert_recipients
POST /api/alert-recipients write db — add recipient
PUT /api/alert-recipients/:id write db — update recipient
DELETE /api/alert-recipients/:id write db — delete recipient
GET /api/alert-rule-config auth db — per-rule-type config (enable/threshold/severity/cooldown/digest)
PUT /api/alert-rule-config/:type super-admin db — update a rule-type's config
GET /api/alerts/:id/acknowledge public db — one-click email ack link; HMAC-token-guarded (emailer.verifyAckToken), not session-guarded — matches middleware.ts ACK_LINK_API allowlist (GET + `?token=` only)

## Forecasts (api/server.js)

GET /api/forecasts/scopes auth+site-filter db — DHCP scope capacity forecasts (scope_forecasts join dhcp_scopes/ddi_servers), 42P01-safe
GET /api/forecasts/scopes/:id auth+site-filter db — forecast for one scope
GET /api/forecasts/summary auth db — critical/warning/healthy counts (scope_forecasts has no site_id, global aggregate)

## Anomalies (api/server.js)

GET /api/anomalies auth db — filterable anomaly_events list (type/severity/acknowledged/since); polymorphic entity, no site_id
GET /api/anomalies/summary auth db — 7-day counts by type/severity + today/week totals
GET /api/anomalies/grouped auth db — root-cause rollup: groups by (anomaly_type, entity), ranked severity, per-entity drill-down JSON
POST /api/anomalies/group/ack write db — bulk-ack a whole root-cause group (by anomaly_type, optional entity_id); ack-exempt from license write-block

## Site Health (api/server.js)

GET /api/site-health auth+site-filter db — latest score per site (site_health_scores), names resolved via netvaultDb
GET /api/site-health/:siteId auth+site-filter db — score history for one site (100 rows)

## Audit (api/server.js)

GET /api/audit auth+site-filter db — paginated audit_log, filterable (action/entity_type/username/result/site_id/from/to/q)
GET /api/audit/stats auth+site-filter db — today/week counts + top users/actions/entities (7d), site-scoped
GET /api/audit/export super-admin db — CSV export of audit_log (up to 50k rows, formula-injection-safe)
GET /api/audit/:id auth+site-filter db — single audit_log row, site-checked against its site_id

## API Keys (api/server.js)

GET /api/api-keys super-admin db — list keys (masked display, no hash/plaintext)
POST /api/api-keys super-admin db — generate + store a new key (SHA-256 hash); plaintext returned once
DELETE /api/api-keys/:id super-admin db — revoke (soft-delete via is_active=FALSE)

## Reports (api/reports.js + api/reportsScheduling.js)

Mount order at /api/reports: reportsScheduling.js router FIRST, then reports.js router — so
`/saved`, `/schedules`, `/history`, `/pack` win over reports.js's catch-all `/:type`.

api/reportsScheduling.js:
GET /api/reports/saved auth db — list saved report views
POST /api/reports/saved write db — save a named report view (type + filters/range JSONB)
PUT /api/reports/saved/:id write db — update a saved view
DELETE /api/reports/saved/:id write db — delete a saved view
GET /api/reports/schedules auth db — list scheduled report deliveries
POST /api/reports/schedules super-admin db — create a schedule (validates recipients/cadence/format), computes next_run_at
PUT /api/reports/schedules/:id super-admin db — update a schedule, recomputes next_run_at when scheduling fields change
DELETE /api/reports/schedules/:id super-admin db — delete a schedule
POST /api/reports/schedules/:id/run super-admin db+external — run a schedule now (generate + email via scheduler.deliverSchedule/emailer, SMTP); 409 if already in-flight; does not shift cadence
GET /api/reports/history auth db — server-side run history (report_run_history), limit 1-200
GET /api/reports/pack auth+site-filter db — compliance pack: combines several report types into one downloadable PDF (generatePack)

api/reports.js:
GET /api/reports/ auth* db — list available report types/titles for UI cards (no explicit Express guard on this specific handler — reachable only via middleware.ts's session-requiring proxy since it isn't in PUBLIC_API)
GET /api/reports/drill/:entity/:id auth+site-filter db — drill-down detail (scope/subnet/zone) with history chart honoring the report's date range; registered before `/:type` to avoid shadowing
GET /api/reports/:type auth+site-filter db — generate one report; `?format=json|csv|pdf`; CSV/PDF paths log to report_run_history and req.audit; PDF rendered in-process via pdfkit (no external service)

## Infrastructure / HA (api/server.js)

GET /api/infrastructure/health auth+site-filter db — per-server health (scope/lease/zone/record counts) + overall status rollup
GET /api/infrastructure/failover auth+site-filter db — DHCP failover pairs + scope sync status, OR-scoped on either paired server's site
GET /api/infrastructure/servers/:id/history auth+site-filter db — server_health_history for one server
GET /api/infrastructure/health-history auth+site-filter db — per-server uptime%/avg-query-ms/score sparkline points

## Search / Settings / Dashboard (api/server.js)

GET /api/search — see IPAM section above (also covers DHCP/DNS/anomaly search)
GET /api/settings auth db — key/value app_settings as an object
POST /api/settings super-admin db — upsert one setting
GET /api/sites auth+site-filter db — active sites from NetVault DB (netvaultDb), site-scoped for site_admin
GET /api/dashboard/stats auth db — see Health & System-adjacent; ~9 subqueries across scopes/leases/zones/alerts + DNS health block
GET /api/dashboard/recent-events auth+site-filter db — recent DHCP events widget
GET /api/dashboard/ip-distribution auth+site-filter db — IPAM address-status donut data
GET /api/dashboard/lease-trend auth+site-filter db — daily avg lease count over N days
GET /api/dashboard/collector-status auth db — collector heartbeat derived from MAX(ddi_servers.last_polled)
GET /api/dashboard/pillars auth+site-filter db — DHCP/DNS/IPAM/Security pillar scores + 24h hourly trend (site_health_scores)

## Public API v1 (api/v1.js)

Mounted at /api/v1; entire prefix is in middleware.ts's public passthrough (self-authenticates
via API key, `read`/`write` permission checked by apiAuth.js against `api_keys.permissions`).
Envelope: `{success,data,meta,timestamp,request_id}` / `{success:false,error:{code,message,details}}`.

GET /api/v1/health public db — DB connectivity check (no API key required — meta endpoint)
GET /api/v1/version public — static product/version info, no I/O (no API key required)
GET /api/v1/subnets apikey(read) db — paginated subnets
GET /api/v1/subnets/:id apikey(read) db — one subnet
POST /api/v1/subnets apikey(write) db — create subnet
PUT /api/v1/subnets/:id apikey(write) db — update subnet fields
DELETE /api/v1/subnets/:id apikey(write) db — delete subnet
GET /api/v1/subnets/:id/addresses apikey(read) db — paginated IP addresses in a subnet
GET /api/v1/subnets/:id/next-ip apikey(read) db — first available IP (pre-scanned only, no live probe)
GET /api/v1/supernets apikey(read) db — list supernets
GET /api/v1/supernets/:id/next-subnet apikey(read) db — advisory only; points to the internal allocation endpoint for an exact block
GET /api/v1/dns/zones apikey(read) db — list DNS zones
POST /api/v1/dns/zones apikey(write) db+external — create zone via WinRM
DELETE /api/v1/dns/zones/:id apikey(write) db+external — delete zone via WinRM
GET /api/v1/dns/records apikey(read) db — paginated DNS records, filterable by zone_id/type
POST /api/v1/dns/records apikey(write) db+external — add A/CNAME/TXT record via WinRM (subset of server.js's record-type support)
DELETE /api/v1/dns/records/:id apikey(write) db+external — remove a record via WinRM
GET /api/v1/scopes apikey(read) db — list DHCP scopes
GET /api/v1/leases apikey(read) db — paginated leases, filterable by ip/mac
POST /api/v1/dhcp/reservations apikey(write) db+external — create reservation via WinRM
DELETE /api/v1/dhcp/reservations/:id apikey(write) db+external — remove reservation via WinRM (id = dhcp_leases row id)
GET /api/v1/search apikey(read) db — cross-entity search (subnets/leases/dns_records)
GET /api/v1/audit apikey(read) db — paginated audit_log

## Next.js API routes (frontend/src/app/api/)

ALL /api/auth/[...nextauth] public db+external — NextAuth handler (GET+POST); CredentialsProvider
  either calls the NocVault hub `POST /api/auth/sso-verify` (SSO token path, external) or queries
  netvaultDb.users directly with bcrypt (direct-credentials fallback path, db); excluded from
  middleware.ts's session-gate matcher entirely (NextAuth handles its own cookie/session logic)
POST /api/sso public external — server-side proxy: forwards `{token}` to NocVault hub
  `POST /api/auth/sso-verify`, returns the hub's JSON verbatim; exists to avoid a browser-side
  CORS call from the SSO callback page; excluded from middleware.ts's matcher (native route handler)

## Needs force-dynamic

Neither Next.js route needs an explicit `export const dynamic = 'force-dynamic'`.

- `frontend/src/app/api/auth/[...nextauth]/route.ts` — thin `NextAuth(authOptions)` handler
  exporting GET/POST. Next.js's App Router only attempts static optimization for GET route
  handlers with no dynamic data access; NextAuth internally reads the incoming request's
  cookies/headers (session token, CSRF) on every call, which is itself a use of dynamic
  request data and opts the route out of static rendering automatically — no manual export
  needed. It also has no direct DB/hub call of its own outside the CredentialsProvider
  `authorize()` path (see auth.ts), which only runs on an actual sign-in POST.
- `frontend/src/app/api/sso/route.ts` — exports only `POST`. Route handlers only support
  static generation for `GET`; a `POST` handler is never a candidate for static/cached
  rendering regardless of what it does internally, so `force-dynamic` is a no-op here too.
  It does per-request work (reads `req.json()`, calls out to the hub) but that's moot given
  it's POST-only.

Both files were read in full to verify neither currently declares `dynamic`, and that nothing
about their behavior (session cookies, per-request hub calls, request body parsing) would be
silently cached if they did need it — confirms the omission is correct, not an oversight.
