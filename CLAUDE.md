# DDIVault — Claude Code Reference

## Codebase Index — READ FIRST

Pre-built index files live in `.ai-codex/`. Read these BEFORE exploring the codebase:
- `.ai-codex/routes.md`      — all API routes
- `.ai-codex/pages.md`       — page tree
- `.ai-codex/lib.md`         — library exports
- `.ai-codex/schema.md`      — database schema + known debt
- `.ai-codex/components.md`  — component index
- `.ai-codex/gotchas.md`     — non-obvious behaviours

### Maintaining the index — MANDATORY

The index is only useful if it is accurate. A stale index is worse than none: it
sends sessions confidently to the wrong place.

Any commit that changes the shape of the codebase MUST update the matching index
file in the SAME commit. Specifically:
- Add / remove / rename an API route, or change its method or auth   -> routes.md
- Add / remove / rename a page, or flip client<->server              -> pages.md
- Add / remove / rename a lib export, or change a signature          -> lib.md
- Any change to schema.sql or a migration script                     -> schema.md
- Add / remove a component, or change its props                      -> components.md
- Discover a new non-obvious behaviour or footgun                    -> gotchas.md

This runs at the same point as the version bump. If you are bumping the version,
check whether the index needs updating. Do not defer it to "later" — later never
comes and the index rots.

## Project Overview
DDIVault is the DNS, DHCP, and IP Address Management (DDI) monitoring product in the NocVault suite.
It monitors Windows DHCP/DNS servers via PowerShell remoting (WinRM), provides IPAM subnet management,
and integrates with NetVault for SSO and site data.

## Installer parity (IMPORTANT — read before any deploy-affecting change)

This app is provisioned two ways that BOTH must stay in sync: the per-app updater
`installer/Update-DDIVault.ps1` (upgrades) and the shared **suite installer**
`../netvault/installer/Install-NocVault-Suite.ps1` (fresh install of the whole NocVault
suite — it lives in the **netvault** repo, a sibling of this one). Any change — even a
small one — that affects how the app is provisioned MUST be reflected in BOTH, in the
same change, or fresh installs silently break. This includes: a new/renamed env var the
app reads, a new scheduled task, a new or changed schema file (or required DB
extension/grant), a new NSSM service or changed entrypoint/port, a new firewall port, a
new cross-DB grant, or a new build step. Update and commit the suite installer in the
netvault repo too; if you can't, flag it explicitly so it isn't missed.

**Post-install test script (keep in sync too):** the suite ships a fresh-install smoke
tester at `../netvault/installer/Test-NocVault-Suite.ps1` (it lives in the netvault repo and
verifies services, ports, health/versions, schema, the collectors end-to-end, the tamper
model and cross-DB grants). If you build a feature that a fresh install should be verified
for — a new NSSM service or port, a new DB table/column/seed/extension/grant, a new collector
data path, a new scheduled task, or a new health/endpoint contract — update BOTH the suite
installer AND this test script (both in the netvault repo) in the same change, so fresh
installs stay verifiable.

**Graphical installer/uninstaller/tester (GUI `.exe` wrappers) — IMPORTANT.** The suite ships
Windows GUI wrappers in the netvault repo (`../netvault/installer/`:
`Install-`/`Uninstall-`/`Test-NocVault-Suite-GUI.ps1`, compiled to `NocVault-Suite-Setup.exe` /
`-Uninstall.exe` / `-Test.exe` via `Build-Setup-Exe.ps1` with ps2exe). **These `.exe`s are thin
GUI shells only — all the real logic lives in the `.ps1` scripts they drive**
(`Install-`/`Uninstall-`/`Test-NocVault-Suite.ps1`, launched with `-Unattended`/`-Force`). So for
normal install/uninstall/test changes (a new step, schema, service, grant, env var, port, task)
you just edit the `.ps1` — **no exe rebuild needed**. The ONE exception: if you add or rename a
`param()` on one of those `.ps1` scripts, the matching `*-GUI.ps1` must be updated to pass the
new argument AND the exe rebuilt (`Build-Setup-Exe.ps1`). Always check the parameter surface
when editing an installer script.

## Known Security Debt (scheduled, not yet done)

Tracked npm-audit findings deliberately deferred (triaged 2026-06-26). NOT fixable with a
safe `npm audit fix` — each needs a breaking change, so schedule as deliberate, tested
work. **NEVER run `npm audit fix --force`.**

- **nodemailer → v9 (root).** The current v8 line carries a high advisory
  (GHSA-p6gq-j5cr-w38f: the message-level `raw` option bypasses
  `disableFileAccess`/`disableUrlAccess` → file-read/SSRF). The only fix is the breaking
  major **9.0.1**. Not currently reachable — SMTP config is super-admin-only and
  `api/emailer.js` never uses the `raw` option — so low risk on the internal LAN. Upgrade
  to nodemailer 9.x in a maintenance window and re-test the alert email path
  (`createTransport`/`sendMail` in `api/alertDispatcher.js`).
- **Next.js 14 → 15 (frontend).** The frontend is on the latest 14.2.x patch (14.2.35),
  but the remaining `next` advisories (RSC/image-optimizer DoS, rewrites request-smuggling,
  CSP-nonce XSS, middleware cache-poisoning) are only patched in the 15.x/16.x line — there
  is no 14.x backport. Exposure is reduced (firewalled, SSO-gated, authenticated internal
  users only). Plan a tested **Next.js 14→15 migration for DDIVault and SpanVault together**
  (App Router / runtime breaking changes) rather than a forced bump.

## Architecture

### Services (3 NSSM Windows services)
- **DDIVault-API** — Express.js REST API on port 3007 (localhost only)
- **DDIVault-App** — Next.js 14 frontend on port 3006 (public)
- **DDIVault-Collector** — Background polling service (no port)

### Stack
- **Backend**: Node.js 20, Express.js
- **Frontend**: Next.js 14, TypeScript, React
- **Database**: PostgreSQL 16 (standard, no TimescaleDB)
- **Auth**: NextAuth.js with SSO to NocVault hub
- **Windows integration**: PowerShell 5.1 via WinRM

### File Structure
ddivault/
├── api/
│   ├── server.js              # Express API server (port 3007)
│   ├── licenseCheck.js        # getLicense()/getLicenseState() — hub license fetch + cache
│   ├── emailer.js             # Alert/report email templates + HMAC ack tokens
│   ├── alertDispatcher.js     # Cooldown + recipient filtering + digest
│   ├── ouiLookup.js / deviceClassifier.js  # Device fingerprinting
│   ├── reports.js / reportsScheduling.js   # Report generation + scheduling/saved views
│   ├── v1.js                  # Public REST API (API-key authenticated), mounted /api/v1
│   └── middleware/
│       ├── rbac.js            # Role + site-scope resolution, attachSiteFilter/requireSuperAdmin
│       ├── audit.js           # auditContext / writeAudit
│       └── apiAuth.js         # Public API key auth (SHA-256 hash lookup)
├── collector/
│   ├── collector.js           # Background polling service
│   ├── ipamScanner.js         # IPAM subnet scanner (PS5 compatible)
│   ├── scanWorker.js          # Child process for non-blocking scans
│   ├── powershellRunner.js    # WinRM PowerShell execution
│   ├── dhcpReader.js          # DHCP log reader
│   ├── credStore.js           # AES-256-GCM credential encryption
│   ├── forecastEngine.js      # Capacity planning (least-squares regression)
│   ├── anomalyDetector.js     # Behavioral/security + DNS anomaly detection
│   ├── dnsMonitor.js          # DNS health & intelligence (roles, sync, forwarders, stale records)
│   ├── haMonitor.js           # DHCP failover / DNS replication monitoring
│   ├── healthScorer.js        # Per-site health scoring
│   ├── ipamSync.js            # IPAM↔DHCP reconciliation
│   └── reportScheduler.js     # Scheduled report delivery (runDueReports/deliverSchedule)
├── scripts/
│   ├── schema.sql             # Main schema (run first)
│   ├── schema-ipam.sql        # IPAM tables (run second)
│   ├── schema-server-auth.sql # Per-server auth columns (run third)
│   └── schema-sites.sql       # Sites integration columns (run fourth)
├── installer/
│   └── Update-DDIVault.ps1    # Windows update/deploy script
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx           # Main app (Dashboard, Events, Settings tabs)
│   │   │   ├── layout.tsx
│   │   │   ├── globals.css        # Design system CSS
│   │   │   ├── sso/page.tsx       # SSO callback page
│   │   │   └── api/
│   │   │       ├── auth/[...nextauth]/route.ts  # NextAuth handler
│   │   │       └── sso/route.ts                 # SSO proxy
│   │   ├── components/
│   │   │   ├── Header.tsx         # Top bar with global search + avatar dropdown
│   │   │   ├── GlobalSearch.tsx   # Global search bar (press / to focus)
│   │   │   ├── DHCPTab.tsx        # DHCP scopes + leases + reservations
│   │   │   ├── DNSTab.tsx         # DNS zones + records management
│   │   │   ├── IPAMTab.tsx        # IPAM supernets/subnets/addresses
│   │   │   ├── IPAMImport.tsx     # CSV import for subnets
│   │   │   ├── ServersTab.tsx     # Known servers + per-server auth config
│   │   │   ├── AuthProvider.tsx   # NextAuth session provider
│   │   │   ├── ThemeContext.tsx   # Dark/light mode
│   │   │   ├── Toast.tsx          # Toast notifications
│   │   │   ├── ErrorBoundary.tsx  # Error boundaries per tab
│   │   │   ├── LicenseGuard.tsx   # LicenseProvider/useLicense/LicenseBanner/LicenseDisabledScreen
│   │   │   ├── RBACContext.tsx    # Client-side role/site-scope context
│   │   │   ├── AuditTab.tsx / ReportsTab.tsx  # Audit trail + Reports consoles
│   │   │   ├── dashboard/         # Dashboard widgets: CommandBar, PriorityActionCenter,
│   │   │   │                      # PillarScorecards, InfraRedundancy, ActivityFeed,
│   │   │   │                      # DnsAnalyticsCard
│   │   │   └── ipam/              # IPAM widgets: IpamDonut, IpamKpiTiles, IpamTopSubnets,
│   │   │                          # IpamTrendChart
│   │   ├── lib/
│   │   │   ├── auth.ts            # NextAuth config + NocVault SSO
│   │   │   ├── publicUrl.ts       # resolveOrigin() — per-request hub origin (server-side)
│   │   │   └── hubUrl.ts          # getHubUrl() — window.location-derived hub origin (client-side)
│   │   └── middleware.ts          # Session gate for all pages + /api/*: verifies NextAuth JWT,
│   │                              # strips/stamps x-ddi-actor* headers, rewrites to Express
│   │                              # (127.0.0.1:3007), enforces the per-user app-access claim
│   ├── public/
│   │   └── logo.png
│   ├── next.config.js             # No rewrites — just images config + a comment pointing at
│   │                              # middleware.ts (see "Adding New API Routes" below)
│   ├── package.json
│   └── tsconfig.json
├── logs/                          # Created manually on server
├── .env.local                     # Root env (API + Collector)
└── package.json                   # Root dependencies

## Development Workflow

### ⚠️ IMPORTANT — Never edit files directly on the server
All development happens here in Claude Code. Follow this workflow:
1. Edit and verify in Claude Code (build locally to confirm no errors)
2. Commit and push to GitHub
3. Run update script on server

### Deploy to server
```powershell
& "C:\Apps\ddivault\installer\Update-DDIVault.ps1"
```

### Commit and push
```bash
git add -A && git commit -m "feat/fix: description" && git push
```

### ⚙️ Default — use multiple sub-agents to work faster and produce better output
By default, where it helps and is possible, fan out work across multiple sub-agents
rather than doing everything sequentially in one thread.

When to fan out (default to it):
- The work touches several independent files/components (e.g. multiple frontend tabs,
  separate API modules) → one sub-agent per file/area, run in parallel.
- A task splits into independent research + implementation + verification streams.
- Broad searches/audits across the codebase → use Explore/general-purpose sub-agents.

When NOT to fan out (do it directly):
- A single small edit in one file, or tightly-coupled sequential steps where parallelism
  adds orchestration overhead without real concurrency.

Rules when fanning out:
- Give each sub-agent a precise, self-contained spec (files, exact changes, constraints).
- Sub-agents must NOT run `npm run build`, commit, or push — run ONE build at the end and
  do a single commit/push after all sub-agents return (avoids `.next` lock + race conflicts).
- Assign non-overlapping files to avoid edit conflicts; coordinate shared integration points
  (e.g. props passed between files) explicitly in each prompt.
- After sub-agents finish: run `npm run build`, fix any TypeScript errors, then commit/push.

## Environment Variables

### Root `.env.local` (used by API + Collector)
```env
DB_HOST=localhost
DB_PORT=5432
DDI_DB_NAME=ddivault
DDI_DB_USER=ddivault_user
DDI_DB_PASS=<set-in-NSSM-env>
DDI_API_PORT=3007
DDI_APP_PORT=3006
NEXTAUTH_SECRET=<set-in-NSSM-env>
NOCVAULT_HUB_URL=http://192.168.6.111:3000
NEXT_PUBLIC_NOCVAULT_HUB_URL=http://192.168.6.111:3000
NETVAULT_DB_HOST=localhost
NETVAULT_DB_PORT=5432
NETVAULT_DB_NAME=netvault
NETVAULT_DB_USER=netvault
NETVAULT_DB_PASS=<set-in-NSSM-env>
PS_AUTH_MODE=kerberos
PS_TIMEOUT_MS=30000
SCOPE_WARNING_PCT=80
SCOPE_CRITICAL_PCT=90
RETENTION_DAYS=90
SERVER_IP=192.168.6.111
```

`SERVER_IP` is required by the update-from-UI route in `api/server.js` (used to build the
`Update-DDIVault.ps1` scheduled-task invocation) — the route returns `400 SERVER_IP not
configured in .env.local` if it's unset, so it's not optional despite not affecting normal
app operation.

### Frontend `.env.local` — copy of root (required at build time)
```bash
cp .env.local frontend/.env.local
```

### ⚠️ Important — .env.local variable names
The hub URL variables MUST be:
```env
NOCVAULT_HUB_URL=http://YOUR-SERVER:3000
NEXT_PUBLIC_NOCVAULT_HUB_URL=http://YOUR-SERVER:3000
```

Do NOT use `NETVAULT_HUB_URL` or `NEXT_PUBLIC_NETVAULT_HUB_URL` — those are the old names and will cause SSO to fail silently by falling back to `localhost:3000`.

**These vars are now the LAST-RESORT fallback only, not the primary source**
(added 2026-07). Server-side hub-redirect call sites (`frontend/src/middleware.ts`,
`frontend/src/app/api/sso/route.ts`, `api/server.js`'s license/hub-settings
routes) call `resolveOrigin(req, 3000, <the env-var fallback chain>)` from
`frontend/src/lib/publicUrl.ts` instead — it derives the hub's origin from the
CURRENT request's `x-forwarded-host`/`host` + `x-forwarded-proto` (validated
against a hostname-shape regex), so hub links keep working when the suite is
reached via a hostname different from the install-time server IP. Client-side
call sites use `getHubUrl()` (`frontend/src/lib/hubUrl.ts`, `window.location`-
derived) instead of reading `NEXT_PUBLIC_NOCVAULT_HUB_URL` directly.

Existing installations must update their `.env.local` manually — this is a one-time rename.

## Database

### Connection
- Host: `localhost:5432`
- Database: `ddivault`
- User: `ddivault_user` / Password: <set-in-NSSM-env>

### Schema migration order (must run in this order)
```bash
psql -U ddivault_user -d ddivault -f scripts/schema.sql
psql -U ddivault_user -d ddivault -f scripts/schema-ipam.sql
psql -U ddivault_user -d ddivault -f scripts/schema-server-auth.sql
psql -U ddivault_user -d ddivault -f scripts/schema-sites.sql
```

### ⚠️ Upgrade note — alert auto-resolve (v1.11.0+)
The alerting overhaul added `alert_events.resolved_at` / `resolved_reason` (in `scripts/schema.sql`). The collector's auto-resolve and open-condition dedup queries reference these columns, so **`schema.sql` must be applied before the new Collector starts**, or the collector will error on every poll with `column "resolved_at" does not exist`.
- **Normal deploy:** `installer/Update-DDIVault.ps1` already re-runs all four schema files (STEP 4.5, idempotent) before restarting services — no manual action needed.
- **Manual deploy:** re-run `scripts/schema.sql` first, then restart `DDIVault-Collector` and `DDIVault-API`.
- The seed also reclassifies noisy behavioral rules (`after_hours_device`, `subnet_jumping`, `unknown_device`) to the `info` tier and disables them by default; the guarded migration only flips rows still at the original shipped default, so prior admin customizations are preserved.

### Cross-DB access (NetVault sites)
```sql
-- Run as postgres superuser on netvault DB
GRANT CONNECT ON DATABASE netvault TO ddivault_user;
GRANT USAGE ON SCHEMA public TO ddivault_user;
GRANT SELECT ON sites, countries TO ddivault_user;
```

### Key tables
| Table | Purpose |
|---|---|
| `ddi_servers` | DHCP/DNS servers to monitor (with per-server auth) |
| `dhcp_scopes` | DHCP scopes polled from servers |
| `dhcp_leases` | Active DHCP leases |
| `dhcp_events` | DHCP log events (assign, renew, release) |
| `dhcp_scope_history` | Utilization snapshots for trend charts |
| `dns_zones` | DNS zones polled from servers |
| `dns_records` | DNS records |
| `ipam_supernets` | Top-level network blocks |
| `ipam_subnets` | Individual subnets within supernets |
| `ipam_addresses` | Per-IP scan results |
| `ipam_scan_jobs` | Scan job history |
| `ipam_audit` | IPAM change audit trail |
| `ipam_vlans` | VLAN definitions (`GET/POST /api/ipam/vlans`, `DELETE /api/ipam/vlans/:id`) |
| `ipam_utilization_history` | Whole-system IPAM utilization snapshots for the trend chart (`GET /api/ipam/utilization-history`) |
| `alert_events` | Fired alerts |
| `alert_rules` | Alert thresholds |
| `app_settings` | Key-value app configuration |
| `lease_history` | Historical lease events per IP |
| `smtp_config` | SMTP server config (password AES-256-GCM encrypted) |
| `alert_recipients` | Email recipients (site + severity filtered) |
| `alert_rule_config` | Per-rule-type enable/threshold/severity/cooldown/digest |
| `alert_email_log` | Sent/failed/skipped alert email audit |
| `scope_forecasts` | DHCP scope capacity forecasts (regression) |
| `subnet_forecasts` | IPAM subnet forecasts (reserved; no history source yet) |
| `device_baselines` | Per-scope lease baselines (hour × day-of-week) |
| `anomaly_events` | Behavioral/security anomalies detected |
| `site_health_scores` | Per-site health score history (DHCP/IPAM/DNS/Security) |
| `audit_log` | Full change/audit trail (user, action, entity, old/new value, result) |
| `api_keys` | Public REST API keys (SHA-256 hash, prefix, permissions JSONB, allowed IPs) |
| `dhcp_failover_pairs` | DHCP failover/HA relationships between servers |
| `dhcp_scope_sync_status` | Per-scope sync state for a failover pair |
| `server_health_history` | Per-server health/query-latency snapshots |
| `dns_server_roles` | DNS server role + AD relationship (PDC emulator, domain, replication type) |
| `dns_zone_sync` | Per-server zone SOA snapshots for replication-lag / sync matrix |
| `dns_query_stats` | DNS query statistics history per server (qps, response time, NXDOMAIN) |
| `dns_stale_records` | Stale DNS records (not refreshed within threshold) per zone |
| `dns_forwarder_health` | DNS forwarder reachability + response time |
| `saved_reports` | Named saved report "views" (report type + filter/range params JSONB) |
| `report_schedules` | Scheduled report deliveries (cadence/hour/day, recipients TEXT[], next_run_at) |
| `report_run_history` | Server-side history of every report generation (manual export + scheduled run) |
| `report_email_log` | Per-recipient email delivery audit for scheduled reports (mirrors `alert_email_log`) |

New columns: `dhcp_leases.{device_type,device_vendor,device_os,risk_level,is_mac_randomized,first_seen,last_seen_subnet}`, `ipam_addresses.{device_type,device_vendor,risk_level,is_sensitive}`, `ipam_subnets.is_sensitive`, `dns_zones.{soa_serial,soa_checked_at,replication_lag,record_count_a,record_count_ptr,record_count_cname,record_count_mx,scavenging_enabled,aging_enabled,last_scavenged}`, `ddi_servers.{health_score,health_checked_at,query_ms,is_dns_primary,dns_forwarders}`.

## Intelligence & Alerting (Features 1-6) — all on-premises, no external calls
- **Email alerting** — `api/emailer.js` (nodemailer, HTML templates, HMAC ack tokens), `api/alertDispatcher.js` (cooldown, site/severity recipient filtering, hourly digest). SMTP/rule config is super-admin only.
- **Capacity planning** — `collector/forecastEngine.js` (least-squares regression on `dhcp_scope_history`), runs every 6h, fires `scope_exhaustion_forecast` alerts.
- **Device fingerprinting** — `api/ouiLookup.js` + bundled `data/oui.json` (full IEEE OUI registry, ~39k vendors) + `api/deviceClassifier.js`; applied in `syncLeases`/`syncReservations`/`ipamScanner`. Rebuild the OUI table with `node scripts/update-oui.js` (downloads the authoritative IEEE/Wireshark registry) then `node scripts/expand-oui.js` (re-derives device types from vendor names). The classifier matches generic hostname conventions first (e.g. `iphone`/`ipad`, `android`, `-POR-`/`-DSK-`/`-MB-`, `macbook`, `surface`, `printer`, `voip`, `switch`/`router`/`ap-`) so common devices classify even when the OUI is unknown; vendor identity otherwise comes from the OUI registry.
  - **⚠️ Rule — never add customer-specific patterns to `api/deviceClassifier.js`.** This is a commercial product. Hostname patterns must be generic and universally applicable to any enterprise. Do not encode any single customer's naming convention (site codes, asset-tag prefixes, org-specific abbreviations) — those belong nowhere in the shipped classifier.
- **Anomaly detection** — `collector/anomalyDetector.js` (lease spikes vs baselines, after-hours, MAC spoofing, subnet jumping, IP conflict, sensitive-subnet new device, DHCP starvation), every 30m; nightly baseline builder at 02:00. Also exports `detectDnsAnomalies(db)` (called by the DNS monitor): `dns_replication_lag`, `dns_forwarder_down`, `dns_record_count_drop`, `dns_stale_records`, `dns_scavenging_disabled`.
- **DNS Health & Intelligence** — `collector/dnsMonitor.js` (runs every 15m via `runDnsMonitor`): detects DNS server roles (PDC emulator → primary, `dns_server_roles` + `ddi_servers.is_dns_primary`/`dns_forwarders`), polls zone SOA serials → replication sync matrix (`dns_zone_sync`), polls record counts by type (`dns_zones.record_count_*`), tests forwarder reachability (`dns_forwarder_health`), reads scavenging/aging state, then runs `detectDnsAnomalies`. Nightly (02:00) `detectStaleRecords` snapshots stale records (>90d, `dns_stale_records`). New PowerShell readers in `collector/powershellRunner.js`: `getDnsServerRole`, `getDnsZoneSoaDetail`, `getDnsZoneRecordCounts`, `getDnsForwarders`, `getDnsZoneScavenging`, `getDnsStaleRecords`, `testDnsForwarder`, `getDnsQueryStats`; writer `setDnsZoneAging`.
- **Site health scoring** — `collector/healthScorer.js` (DHCP 40% / IPAM 20% / DNS 20% / Security 20%), every 15m.
- **Smart search** — `GET /api/search` parses `type:`, `vendor:`, `subnet:`, `scope:>N`, `site:`, `new:today|7days`, `risk:`, `anomaly:today`, `status:` structured queries.
- **Frontend** — Intelligence tab (anomaly console), Settings sections (SMTP/Recipients/Rules), Dashboard widgets (Capacity Forecast, Site Health, Security Overview, Device Donut, DNS Health card), DHCP device+forecast columns, IPAM device icons + sensitive toggle. DNS tab (`components/DNSTab.tsx`) is a 4 sub-tab console: Health Overview (server cards, SVG topology diagram, zone-sync matrix), Zones & Records (existing master-detail), Intelligence (stale records cleanup, forwarder health tests, scavenging enable), Analytics (record-type donut, top zones, query-rate sparklines, NXDOMAIN rate).

## Platform & Integration modules
- **Audit trail** — `api/middleware/audit.js` (`auditContext` attaches per-request user/IP context, `writeAudit` records changes); writes to `audit_log`. Exposed via `GET /api/audit`, `/api/audit/stats`, `/api/audit/:id`, and `/api/audit/export` (super-admin, CSV).
- **RBAC** — `api/middleware/rbac.js` resolves role (`super_admin`/`admin`/`site_admin`/`viewer`) and site scope from NetVault `user_sites`; `attachSiteFilter`, `requireAuth`, `requireWrite`, `requireSuperAdmin` guards.
  - **⚠️ Rule — a site-scope/auth fix is a class fix, not an instance fix.** This
    codebase has had ~40 routes missing `attachSiteFilter`/`requireAuth`/`requireWrite`
    found in one pass, only because a full audit was run instead of fixing routes
    one at a time as each was reported — and the same "fixed the reported one, missed
    the identical sibling" pattern has bitten other apps in this suite on
    site-scoping fixes. When you add or fix `attachSiteFilter`/`requireAuth`/
    `requireWrite`/`requireSuperAdmin` on one route, grep `api/server.js` (and
    `api/v1.js`) for every other route on the same resource (same table/entity,
    same URL prefix) and confirm they ALL carry the equivalent guard. Do not assume
    fixing the reported instance closes the whole class of bug.
- **Public REST API (v1)** — `api/v1.js` mounted at `/api/v1`, authenticated by API keys via `api/middleware/apiAuth.js` (SHA-256 hash lookup in `api_keys`, `read`/`write` permission gates, rate-limit headers, allowed-IP check, `request_count`/`last_used_at` tracking). Key management: `GET/POST /api/api-keys`, `DELETE /api/api-keys/:id` (super-admin).
- **Reports** — `api/reports.js` mounted at `/api/reports`; generates PDF (via `pdfkit`) and CSV reports for IPAM/DHCP/DNS/audit. `GET /api/reports` lists types; `GET /api/reports/:type`. Trend reports include SVG charts drawn into the PDF; `renderPdf` is split into `buildPdfDoc`/`renderPdfToBuffer` so the renderer is reusable off-request. Exports `generateReport(db,opts)` and `generatePack(db,opts)` (multi-report "compliance pack" PDF) for the scheduler and the pack route.
- **Report scheduling / saved views / history** — `api/reportsScheduling.js` (`createReportsSchedulingRouter`, mounted at `/api/reports` BEFORE the main reports router so `/saved`, `/schedules`, `/history`, `/pack` win over the catch-all `/:type`). Saved views + run history are open to any authenticated user (`requireAuth`/`requireWrite`); schedule create/edit/delete/run-now are `requireSuperAdmin`. Rolling date windows (`24h`/`7d`/`30d`/`90d`) persist as `range_preset` (re-resolved each run via `expandRangePreset` at the generation boundary), NOT frozen `from`/`to`. Delivery runs on the collector — see `collector/reportScheduler.js` (`runDueReports`/`deliverSchedule`/`computeNextRun`), wired into `collector.js` on a 5-min `setInterval` (re-entrancy-guarded); it generates via `generateReport` and emails via `emailer.sendReport` (attachments). **No new NSSM service or OS scheduled task** — piggybacks the existing `DDIVault-Collector`. New tables live in `scripts/schema.sql` so neither installer needs a schema edit; only `../netvault/installer/Test-NocVault-Suite.ps1` was updated (role-scoped SELECT check for the 4 new tables + version min).
- **HA / failover monitoring** — `collector/haMonitor.js` polls DHCP failover pairs (`dhcp_failover_pairs`, `dhcp_scope_sync_status`) and DNS replication (SOA serial vs `dns_zones.soa_serial`), records `server_health_history`, fires alerts. Exposed via `GET /api/infrastructure/failover`.
- **IPAM↔DHCP sync** — `collector/ipamSync.js` reconciles discovered DHCP scopes into IPAM supernets/subnets.
- **Dependencies** — beyond `nodemailer` (email): `pdfkit` (+ `@types/pdfkit`) for report generation.

### Smoke-test seed (exercise the UI without real data)
- `psql -U ddivault_user -d ddivault -f scripts/seed-smoke-test.sql` — seeds clearly-labelled DEMO data (30d scope history + forecast, baselines, fingerprinted leases, a SENSITIVE IPAM subnet, varied anomalies, a site health score, an inactive demo recipient). Re-runnable; sends no email.
- `psql ... -f scripts/clean-smoke-test.sql` — removes all demo data (markers: hostname `DEMO-SMOKE-TEST`, `site_id=9999`, `details->>'demo'='true'`).

### New API endpoints
- SMTP: `GET/POST /api/smtp`, `POST /api/smtp/test`
- Recipients: `GET/POST /api/alert-recipients`, `PUT/DELETE /api/alert-recipients/:id`
- Rules: `GET /api/alert-rule-config`, `PUT /api/alert-rule-config/:type`
- One-click ack from email: `GET /api/alerts/:id/acknowledge?token=`
- Forecasts: `GET /api/forecasts/scopes`, `/api/forecasts/scopes/:id`, `/api/forecasts/summary`
- Anomalies: `GET /api/anomalies`, `/api/anomalies/summary`, `GET /api/anomalies/grouped`
  (root-cause rollup: groups by `anomaly_type` + entity), `POST /api/anomalies/group/ack`
  (bulk-ack a whole root cause). The old per-row `POST /api/anomalies/:id/ack` was removed
  in v1.13.0 in favor of this grouped-rollup pattern.
- Site health: `GET /api/site-health`, `/api/site-health/:siteId`
- Audit: `GET /api/audit`, `/api/audit/stats`, `/api/audit/:id`, `/api/audit/export` (super-admin CSV)
- API keys: `GET/POST /api/api-keys`, `DELETE /api/api-keys/:id` (super-admin)
- Reports: `GET /api/reports`, `GET /api/reports/:type` (PDF/CSV/JSON preview)
- Report saved views: `GET/POST /api/reports/saved`, `PUT/DELETE /api/reports/saved/:id`
- Report schedules: `GET /api/reports/schedules`, `POST /api/reports/schedules`, `PUT/DELETE /api/reports/schedules/:id`, `POST /api/reports/schedules/:id/run` (mutations super-admin)
- Report history: `GET /api/reports/history?limit=` ; Compliance pack: `GET /api/reports/pack?types=a,b,c` (PDF)
- Infrastructure: `GET /api/infrastructure/failover`
- DNS health: `GET /api/dns/health`, `/api/dns/topology`, `/api/dns/zones/sync`, `/api/dns/zones/:name/sync`, `/api/dns/forwarders`, `/api/dns/stale-records`, `/api/dns/query-stats`, `/api/dns/scavenging`; writes `POST /api/dns/forwarders/test`, `POST /api/dns/scavenging/enable`, `POST /api/dns/stale-records/cleanup` (all under the already-proxied `/api/dns/*`)
- Public API v1: `/api/v1/*` (API-key authenticated — subnets, supernets, dns, scopes, leases, dhcp/reservations, search, audit, health, version)

## API Endpoints

### Health
- `GET /api/health` — returns `{"status":"ok","db":"connected"}`

### DHCP
- `GET /api/scopes` — all DHCP scopes
- `GET /api/scopes/:scopeId/leases` — leases for a scope
- `GET /api/scopes/:scopeId/history` — utilization history
- `GET /api/scopes/history/all` — all scopes history (sparklines)
- `GET /api/leases` — all leases with pagination
- `POST /api/dhcp/reservations` — create reservation via PowerShell
- `DELETE /api/dhcp/reservations` — remove reservation

### DNS
- `GET /api/dns/zones` — all DNS zones
- `GET /api/dns/records` — DNS records with filters
- `GET /api/dns/servers` — DNS-capable servers
- `POST /api/dns/records` — add record via PowerShell
- `DELETE /api/dns/records` — delete record
- `POST /api/dns/zones` — create zone
- `DELETE /api/dns/zones/:id` — delete zone

### IPAM
- `GET /api/ipam/supernets` — all supernets
- `POST /api/ipam/supernets` — create supernet
- `GET /api/ipam/subnets` — all subnets
- `POST /api/ipam/subnets` — create subnet
- `GET /api/ipam/subnets/:id/addresses` — IP addresses in subnet
- `POST /api/ipam/subnets/:id/scan` — trigger subnet scan (async child process)
- `GET /api/ipam/scan-status` — current scan status
- `GET /api/ipam/subnets/:id/next-ip` — next available IP
- `GET /api/ipam/supernets/:id/next-subnet?prefix=24` — next available subnet
- `GET /api/ipam/conflicts` — overlapping subnet detection
- `POST /api/ipam/import` — bulk import subnets from CSV
- `GET/POST /api/ipam/vlans`, `DELETE /api/ipam/vlans/:id` — VLANs
- `POST /api/ipam/subnets/:id/addresses/:ip/reserve` / `.../release` — reserve/release an IP
- `POST /api/ipam/scan-all` — trigger a scan of every subnet; `POST /api/ipam/sync-from-dhcp` — reconcile from DHCP
- `GET /api/ipam/audit` — IPAM change audit trail
- `GET /api/ipam/utilization-history?days=` — whole-system utilization trend

### Servers
- `GET /api/servers` — all known servers
- `POST /api/servers` — add server
- `PUT /api/servers/:id` — update server
- `DELETE /api/servers/:id` — remove server
- `POST /api/servers/:id/test-connection` — test WinRM connectivity

### Other
- `GET /api/sites` — sites from NetVault DB
- `GET /api/search?q=` — global search across all entities
- `GET /api/settings` — app settings
- `POST /api/settings` — update setting
- `GET /api/alerts` — alert events
- `POST /api/alerts/:id/acknowledge` — acknowledge alert
- `GET /api/events` — DHCP events
- `GET /api/dashboard/stats` — dashboard KPIs
- `GET /api/dashboard/recent-events`, `/api/dashboard/ip-distribution`, `/api/dashboard/lease-trend`, `/api/dashboard/collector-status`, `/api/dashboard/pillars` — dashboard widget data
- `GET /api/hub/settings` — server-side proxy to the NocVault hub's `/api/settings` (avoids browser CORS)

This list is not exhaustive (the app has ~120 real routes) — see "New API endpoints" above
for the newer feature-area routes (SMTP, recipients, forecasts, anomalies, audit, reports,
API keys, infrastructure, DNS health, public v1 API).

## Frontend Architecture

### Tab routing
Tabs are managed in `page.tsx` with `useState<Tab>`. Tab types:
`dashboard | scopes | ipam | dns | events | servers | settings`

### API proxy
All `/api/*` calls from Next.js are proxied to Express port 3007 by `frontend/src/middleware.ts`
(session-verifying code, NOT `next.config.js` rewrites — that mechanism was removed in
v1.22.0; see "Adding New API Routes" above for the full mechanism). `/api/auth/*` and
`/api/sso` are handled by Next.js natively (excluded from the middleware matcher, NOT
proxied).

### SSO flow
1. Unauthenticated user → middleware redirects to `NOCVAULT_HUB_URL/login?callbackUrl=/api/sso/ddivault`
2. User logs in at NocVault hub
3. NocVault redirects to `/api/sso/ddivault` with SSO token
4. SSO route verifies token server-side → creates NextAuth session
5. User lands on DDIVault dashboard

### Per-user app-access gate (shipped across 1.21.0/1.22.0/1.22.1)
The NocVault hub can restrict which suite apps a given user may open. The allowed-apps
list travels as an `apps: string[]` claim inside the SSO token; `frontend/src/lib/auth.ts`
reads it (`ssoApps()`, a read-only JWT-payload decode — no signature check needed there
because the hub's `sso-verify` call already cryptographically validated the token a few
lines earlier) and persists it onto DDIVault's own NextAuth JWT (`jwt`/`session` callbacks).
`middleware.ts`'s `appAllowed(apps, 'ddivault')` then enforces it in two places:
- **Page routes** — a denied user (valid session, `apps` array present and excluding
  `ddivault`) is redirected to `${hubUrl}/launcher?denied=ddivault` (never loops inside
  DDIVault).
- **`/api/*` routes** — the same check runs in the proxy branch; a denied user gets
  `403 { error: 'forbidden', reason: 'app_access_denied' }` instead of being proxied to
  Express. This closes a gap fixed in 1.22.1 (`29e9f26`) where the page-nav gate alone
  left the API reachable directly.

**Fails open by design**: no claim, an empty array, or a malformed token ⇒ default-allow,
so tokens minted before this feature (or a decode failure) never lock anyone out.
`netvault` (the hub itself) is always allowed regardless of the claim.

**⚠️ Rule for any future access-control gate:** this feature originally shipped in 1.21.0
with only the page-nav redirect wired up — a denied user's still-valid session could hit
`/api/*` directly and get full data, since only the page branch of `middleware.ts` called
`appAllowed()`. Fixed in 1.22.1 (`29e9f26`) by adding the same check to the proxy branch.
Any new access-control gate (a new claim, a new role check, a new per-feature entitlement)
must be verified against BOTH paths that share the same session — the page-rendering
branch AND the `/api/*` proxy branch in `middleware.ts` — not just the one the feature
request describes. A gate that only blocks the UI is not a security control.

### Sign out flow
1. Fetch CSRF token from `/api/auth/csrf`
2. POST to `/api/auth/signout` with CSRF token
3. `window.location.replace(NOCVAULT_HUB_URL + '/launcher')` — clean redirect, no callbackUrl

## PowerShell / WinRM Integration

### Per-server auth modes
| Mode | When to use |
|---|---|
| `kerberos` | Same AD domain as DDIVault server (`thaiunion.co.th`) |
| `credential` | Different domain (`mwbrands.net`) or explicit admin needed |
| `local` | Only if DDIVault server IS the DHCP/DNS server |

### Credential encryption
Passwords stored AES-256-GCM encrypted via `credStore.js`.
Key derived from `NEXTAUTH_SECRET`. Never stored in plaintext.

### PS5 compatibility rules
- No `-TimeoutSeconds` on `Test-Connection` (PS7 only)
- No `-Parallel` on `ForEach-Object` (PS7 only)
- Use `-Quiet` flag for ping
- Use background jobs for parallelism
- Write multi-line scripts to temp `.ps1` files — never use `-Command` with newlines
- Use `-ExecutionPolicy Bypass -File` to run temp scripts

### IPAM scan architecture
Scans run as child processes via `child_process.fork(scanWorker.js)` to avoid blocking the API.
The API responds immediately and the scan runs in background.
Progress is written to DB every 50 IPs — frontend polls `/api/ipam/scan-status`.

## Known Issues & Gotchas

### PowerShell
- `$PID` is a reserved variable in PowerShell — use `$procPid` instead
- Square brackets `[` `]` in folder names (e.g. `[...nextauth]`) require `-LiteralPath` in PowerShell
- WinRM must be enabled on target servers: `Enable-PSRemoting -Force`

### Next.js
- Never define components inside other React components — causes remount on every keystroke
- The `[...nextauth]` folder requires `-LiteralPath` for all PowerShell file operations
- `next.cmd` not `node next.js` — NSSM must point to `next.cmd`
- Always stop DDIVault-App before `npm run build` — running service locks `.next` files

### Database
- Schema must run in order: `schema.sql` → `schema-ipam.sql` → `schema-server-auth.sql` → `schema-sites.sql`
- All schema files use `IF NOT EXISTS` — safe to re-run
- `uuid-ossp` extension requires superuser to install

### NSSM
- Use backtick-n (`` `n ``) to separate env vars in `AppEnvironmentExtra` — spaces concatenate into hostname
- Use `sc.exe` not `Stop-Service`/`Start-Service` — avoids terminal hanging
- `DependOnService = postgresql-x64-16`

## Design System

### Colors
- Primary red: `#C8102E`
- Navy sidebar: `#1a2744`
- Background: `#f4f6f9`
- Card: `#ffffff`

### CSS variables (globals.css)
```css
--primary: #C8102E
--navy: #1a2744
--bg-primary: #f4f6f9
--bg-card: #ffffff
--border: #e2e8f0
--radius: 12px
--sidebar-width: 240px
--header-height: 72px
```

### Suite-standard shell chrome (shared across the NocVault suite)
- **Sidebar nav** uses colored icon CHIPS: each nav icon sits in a 28×28 rounded (radius 8) chip with a per-route color tint. Only the ACTIVE item is colored (per-route color from `ROUTE_CHIP` in `page.tsx`); inactive items show a neutral faint-white chip. Icons inherit chip color via `currentColor`.
- **Header avatar** is a circular 34px badge on solid `var(--primary)`.
- **Theme toggle** uses module-level SVG sun/moon icons (`Header.tsx`), not emoji.
- **Sidebar collapse** state persists to `localStorage` key `ddivault-sidebar-collapsed`.

### Key design rules
- Inter font (Google Fonts)
- Rounded sidebar items (not full-width highlight)
- Red left indicator on active sidebar item
- Cards: `border-radius: 12px`, subtle shadow
- Tables: zebra hover, sticky headers
- No bullet points in UI copy

## Typography & design tokens (suite standard)
Styling is a custom CSS design system in `frontend/src/app/globals.css` (CSS custom
properties in `:root` + `[data-theme="dark"]`) — NOT Tailwind.

- **Body font:** Inter (loaded via Google Fonts in globals.css). Base body size is `var(--text-md)` (14px).
- **Monospace:** `var(--font-mono)` = `'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace`. One mono stack everywhere — never hardcode a mono font-family. (The Rubik logo SVG font is the only exception and is left alone.)

**7-step type scale** (defined once in `:root`; sizes do NOT change per theme):

| Token         | px   | Use |
|---------------|------|-----|
| `--text-xs`   | 11px | table headers, badges, micro-labels |
| `--text-sm`   | 12px | secondary labels, captions |
| `--text-base` | 13px | buttons, inputs, table body |
| `--text-md`   | 14px | body text, card titles (base body size) |
| `--text-lg`   | 16px | section / panel headings |
| `--text-xl`   | 20px | page titles |
| `--text-2xl`  | 28px | stat numbers / display |

**Rule:** NEVER hardcode font sizes or colors that duplicate a token. Always use
`var(--text-*)` for type and the color tokens (`--text-primary/-secondary/-muted`,
`--bg-primary/-card`, `--border`, `--border-light`, `--primary`, `--primary-dark`, etc.).
Hardcoded hex that duplicates a token breaks dark mode (hex doesn't flip themes).
Display/hero sizes >= 34px (e.g. the connection-lost glyphs ~44px, the big countdown
number ~40px, the license-disabled 🔒 ~64px, the IPAM import success ✅ ~48px) may stay
literal — they are intentional display sizes, not body type.

**Dark-mode rule — selected/active row backgrounds:** tile/row/selected-item
BACKGROUNDS sitting behind tokenized text must adapt to the theme — use a `var(--bg-*)`
token or a semi-transparent brand tint (e.g. `rgba(200,16,46,0.18)` / `var(--primary-light)`,
which is overridden per-theme in `[data-theme="dark"]`). Never a hardcoded light hex
(`#fef2f4`, `#f1f5f9`, `#eff6ff`, …) behind text, and never a dark text literal as the
selected color — in dark mode that yields white-on-white / dark-on-dark and the text
becomes unreadable.

This is the **NocVault SUITE-WIDE standard** — the same scale and rule apply to
spanvault, logvault, and netvault. SpanVault is the reference implementation; this
scale matches it exactly.

### Adaptive surface & semantic tint tokens (suite standard)
Tinted and neutral surfaces sitting behind text MUST use these tokens — never a
hardcoded light hex (which does not flip in dark mode and yields unreadable
light-on-light / dark-on-dark). The same tokens exist in **logvault + spanvault**.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--surface-subtle` | `#f8fafc` | `rgba(255,255,255,0.04)` | neutral near-white surfaces: selected rows, dropdown/menu hover |
| `--tint-info` / `-fg` | `#eff6ff` / `#1d4ed8` | `rgba(59,130,246,0.13)` / `#93c5fd` | info boxes/badges |
| `--tint-success` / `-fg` | `#f0fdf4` / `#15803d` | `rgba(34,197,94,0.13)` / `#86efac` | success boxes/tiles |
| `--tint-warn` / `-fg` | `#fffbeb` / `#b45309` | `rgba(217,119,6,0.15)` / `#fcd34d` | warning boxes, read-only banner |
| `--tint-danger` / `-fg` | `#fef2f2` / `#b91c1c` | `rgba(220,38,38,0.13)` / `#fca5a5` | error boxes, destructive/dismiss hover |
| `--tint-purple` / `-fg` | `#f5f3ff` / `#6d28d9` | `rgba(139,92,246,0.15)` / `#c4b5fd` | purple badges/surfaces (site/scan/import tags) |

Rules:
- **Self-contained boxes** (hardcoded bg + hardcoded dark text together) → swap BOTH:
  bg → `--tint-*`, text → matching `--tint-*-fg`.
- **Surfaces holding already-tokenized text** → swap just the bg.
- **Dynamic hover backgrounds** (`onMouseEnter`/`onMouseLeave` setting
  `element.style.background`) must use a token, never a literal hex — neutral hovers
  use `var(--surface-subtle)`, destructive/dismiss hovers use `var(--tint-danger)`,
  and the mouseLeave must reset to the real base (`transparent` / `var(--bg-card)`),
  not a hardcoded color.
- The brand-red selected-row tint `var(--primary-light)` (dark override
  `rgba(200,16,46,0.18)`) is also adaptive — fine to keep.
- **STICKY headers/toolbars (anything content scrolls BENEATH)** — sticky table
  headers (`thead`/header rows), pinned toolbars/filter bars, pinned first columns,
  sticky section headers — MUST use an OPAQUE background token (`var(--bg-card)` for
  card-level tables, `var(--bg-primary)` when sitting on the page background) plus a
  sufficient `z-index` (5+). NEVER a semi-transparent tint (`var(--surface-subtle)`,
  any `rgba(...)` with alpha < 1, or no background at all) — scrolled rows bleed
  through and garble the text, most visibly in dark mode. This is the **suite-wide
  standard** (matches the logvault/spanvault/netvault fix).

### Dropdowns / selects — dark-mode readability (suite standard)
- **Native form controls** (`<select>` option popups, native scrollbars, date pickers)
  follow `color-scheme`: `:root` declares `color-scheme: light`, `[data-theme="dark"]`
  declares `color-scheme: dark`. Without this the OS-rendered option list stays
  light/white in dark mode regardless of the `<select>` element's own background.
  A base rule also sets `select`/`option` to `var(--bg-card)` + `var(--text-primary)`.
- **Custom dropdown / menu / combobox / results panels** use `var(--bg-card)` for the
  panel surface + `border: 1px solid var(--border)`; hover/selected rows use
  `var(--surface-subtle)` (or an appropriate `--tint-*`); option text uses
  `var(--text-primary)`/`--text-secondary`. NEVER a hardcoded light hex
  (`#fff`/`#f8fafc`/`#eff6ff`/…) as a menu surface or hover row behind text — it
  doesn't flip in dark mode and yields white-on-white. Mouse-leave resets to the real
  base (`var(--bg-card)` / `transparent`), not a literal.

## License Enforcement
DDIVault enforces a NocVault license fetched from `GET {NOCVAULT_HUB_URL}/api/license` (no auth).
- **Backend** (`api/licenseCheck.js`): `getLicense()` caches the hub response for **5 minutes** (`CACHE_TTL`, in-memory) — NOT 24h; `getLicenseState()` maps status → `{ mode, canWrite, canRead, disabled }`. Uses global `fetch` + AbortController (10s); **never blocks on network failure** (unreachable ⇒ full access). Separately, `api/server.js` force-refreshes the license on startup and again every 24h (`setInterval(() => getLicense(true)..., 24h)`) purely for the startup/health-check log line — that background refresh interval is independent of, and much less frequent than, the 5-minute in-memory cache TTL that actually governs how quickly a license change takes effect. Exposes `GET /api/license-status` and applies `enforceLicense` middleware (registered before all business routes).
- **Enforcement**: `trial`/`active` ⇒ full access. `active` with ≤30 days ⇒ expiry warning banner. `expired`/`grace` within 30-day grace ⇒ **read-only** (writes return HTTP 402; acknowledge endpoints exempt). Past grace (`daysRemaining ≤ -30`) ⇒ **disabled** (all routes 402 except `/api/health`, `/api/stats`, `/api/license-status`, `/api/system/update-available`).
- **Per-app module entitlement**: independent of the trial/expired/grace logic above, an
  **active** license whose `modules` array is non-empty and omits `ddivault` hard-locks the
  app (`mode: 'unlicensed'`, `canWrite: false`, `canRead: false`, `disabled: true`) —
  same disabled-screen treatment as a fully expired license. Fails open: trial licenses,
  licenses in grace, an unreachable hub, and legacy keys with no `modules` list all keep
  full access, so no existing install is bricked by this check.
- **Frontend** (`components/LicenseGuard.tsx`): `LicenseProvider` polls `/api/license-status` every 6h; `useLicense()` hook; `LicenseBanner` (trial/expiring/grace/disabled/unreachable); `LicenseDisabledScreen` full-screen lock. Wired in `layout.tsx`; `page.tsx` shows the disabled screen when `state.disabled`. Frontend reads only `/api/license-status` (never the hub directly — avoids CORS).

## NocVault Suite Context
DDIVault is one of several products:
- **NetVault** — IT Asset Management / CMDB (port 3000)
- **SpanVault** — Network monitoring
- **DDIVault** — DNS/DHCP/IPAM (port 3006)
- **LogVault** — Syslog analyzer (port 3004)

All products share:
- Same NocVault hub for SSO (`netvault` DB, `users` table)
- Same sites data (`netvault.sites` table)
- Same NSSM-based Windows service management
- Same update script pattern

## GitHub
- Repo: `https://github.com/amrin78-smb/ddivault`
- Branch: `main`
- Never edit on the server directly — all development is done in Claude Code

## Schema Maintenance Rule

### ⚠️ CRITICAL — Always keep schema.sql in sync with live DB

Any time you make a database change (new table, new column, new index), you MUST update the appropriate schema file in the same commit. Fresh installs use these files — if they're out of sync, new installs will be missing columns and will fail.

### Rules
1. **New table** → add to `scripts/schema.sql`
2. **New column on existing table** → add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to the most relevant migration file, OR to `schema.sql` if it's a core column
3. **New index** → add `CREATE INDEX IF NOT EXISTS` to the relevant schema file
4. **Never run `ALTER TABLE` directly on the server** — always add it to a schema file first, commit, then deploy via update script

### Pattern to follow
```sql
-- Always use IF NOT EXISTS so schema files are idempotent (safe to re-run)
ALTER TABLE ddi_servers ADD COLUMN IF NOT EXISTS new_column TEXT;
CREATE INDEX IF NOT EXISTS idx_name ON table_name(column_name);
```

### Verify schema is in sync
```powershell
# On server — check a table's actual columns
$env:PGPASSWORD = "<postgres-password>"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U ddivault_user -h localhost -p 5432 -d ddivault -c "\d table_name"
```

```bash
# In Claude Code — check what's in schema files
grep -n "column_name" scripts/schema.sql scripts/schema-ipam.sql scripts/schema-server-auth.sql scripts/schema-sites.sql
```

### Current schema file responsibilities
| File | Contains |
|---|---|
| `scripts/schema.sql` | Core tables, triggers, functions, seed data |
| `scripts/schema-ipam.sql` | IPAM Phase A+B tables + columns added to existing tables |
| `scripts/schema-server-auth.sql` | Per-server auth columns on `ddi_servers` |
| `scripts/schema-sites.sql` | `site_id` columns on `ddi_servers`, `ipam_supernets`, `ipam_subnets` |

## Adding New API Routes

### No next.config.js registration needed — middleware.ts owns /api/* routing
As of v1.22.0 (commit `24e886e`), `frontend/next.config.js` has **no rewrites table**.
A new Express route needs **zero frontend routing changes** — `frontend/src/middleware.ts`
proxies every `/api/*` request to Express (`127.0.0.1:3007`) itself, so any route you add
to `api/server.js` is reachable immediately.

The reason the old rewrites-table approach was removed: a config-level `rewrites()` entry
is a dumb URL-level forward with no code-execution point — it can't verify a session or
strip/stamp identity headers. That gap let a client set `x-ddi-actor-role` itself via a
bare curl request and bypass every RBAC check. `middleware.ts` now does this instead, for
every `/api/*` path (matcher excludes `/api/auth/*` and `/api/sso`, which are native
Next.js route handlers):
1. Strips any client-supplied `x-ddi-actor`/`x-ddi-actor-role`/`x-ddi-actor-id` headers.
2. Lets a narrow public allow-list through with no session: `PUBLIC_API` (regex
   `/^\/api\/(health|stats|license-status|system\/update-available)$/` — kept identical to
   the `enforceLicense` exemption list in `api/server.js`), `/api/v1/*` (self-authenticates
   via API key), and `ACK_LINK_API` (`GET /api/alerts/:id/acknowledge?token=` only — the
   one-click email ack link, guarded server-side by its own HMAC token instead of a
   session).
3. Every other `/api/*` route requires a verified NextAuth JWT (`getToken`) — no token ⇒
   `401`. It also re-checks the per-user app-access claim (see below) ⇒ `403` if denied.
4. Only then does it stamp `x-ddi-actor`/`x-ddi-actor-role`/`x-ddi-actor-id` from the
   verified token and rewrite to Express — `api/middleware/rbac.js` trusts those headers
   verbatim, so they must only ever come from here.

**Practical implication for adding a route:** just add it to `api/server.js` under
`requireAuth`/`requireWrite`/`requireSuperAdmin` as usual. Only touch `middleware.ts` if
the new route must be reachable with **no session at all** (add it to `PUBLIC_API`) — do
that sparingly, matching the existing `enforceLicense` exemption list so the two stay in
sync.

**Do not reintroduce a `next.config.js` rewrites table** — see the comment at the top of
that file. This pattern does not necessarily transfer to sibling apps as-is; SpanVault's
own `/api/*` routing architecture previously defaulted the opposite way (deny-list) and
needed its own fix — check each app's own routing file before reusing a pattern across the
suite.

### ⚠️ Checklist — new route that must work with NO session at all

SpanVault shipped an SSO-verify proxy route that needed exactly this, and it took **three
separate broken releases** to land — each fix only exposed the next gate, because a
middleware allowlist, a global RBAC write-gate, and a license-enforcement exemption list
all had to be updated independently before the route actually worked end-to-end. DDIVault
has the same layered shape, so any new route that must respond with **no NextAuth session**
(a webhook, a health/status probe, a token-guarded one-click link, etc.) needs ALL of the
following in the same change — missing one won't fail loudly, it'll just 401/402 in
whichever gate you forgot:

1. **`frontend/src/middleware.ts`** — the request never reaches Express unless it's let
   through here first. Add the path to the `PUBLIC_API` regex (currently
   `/^\/api\/(health|stats|license-status|system\/update-available)$/`) if it should work
   with literally no session; match the `ACK_LINK_API` pattern
   (`/^\/api\/alerts\/[^/]+\/acknowledge$/`, scoped to `GET` + a `token` query param) if it's
   a token-guarded link instead of a session; or put it under the `/api/v1/` prefix if it
   should self-authenticate via API key (`api/middleware/apiAuth.js`).
2. **`api/server.js`'s `enforceLicense`** — this app has no single named exemption array;
   it's two separate inline `req.path.startsWith(...)` checks. The **fully-disabled block**
   (guards `/api/health`, `/api/stats`, `/api/license-status`,
   `/api/system/update-available`) must list the new path too, or an expired-past-grace
   license 402s it even though `middleware.ts` let it through. The **write-block isAck
   check** (`req.path` starts with `/api/alerts` or `/api/anomalies` AND contains
   `acknowledge`/`/ack`) only matters if the new route is a write that must succeed during
   the read-only grace period.
3. **The route handler itself, in `api/server.js`** — must NOT be wrapped in
   `requireAuth`/`requireWrite`/`requireSuperAdmin` (`api/middleware/rbac.js`). A request that
   came through the `PUBLIC_API`/`ACK_LINK_API` allowlist never gets `x-ddi-actor*` headers
   stamped (see `middleware.ts` step 4 above), so `getRequestUser()` returns `null` and any
   RBAC guard 401s it regardless of what steps 1-2 allowed.

Verify all three by hitting the route with `curl` and no cookies/session — not just reading
the middleware allowlist and assuming it's done.

---

## Code Editing Rules

### Never use PowerShell heredoc for Node.js/JSX files
PowerShell heredoc corrupts JSX syntax. Always write to a temp file first then run with node.

### Making file edits
- Prefer targeted replacements over full file rewrites
- Use node script for complex replacements
- Use sed only for simple single-line changes
- Always verify with grep after editing
- Always read current file state before editing to avoid stale replacements

---

## Troubleshooting

### Check service logs
- API errors: `Get-Content C:\Apps\ddivault\logs\api-err.log -Tail 30`
- App errors: `Get-Content C:\Apps\ddivault\logs\app-err.log -Tail 30`
- Collector errors: `Get-Content C:\Apps\ddivault\logs\collector-err.log -Tail 30`

### API returns 500
- Run health check: `Invoke-WebRequest -Uri "http://localhost:3007/api/health" -UseBasicParsing`
- Should return: `{"status":"ok","db":"connected"}`

### Build fails
- Always stop DDIVault-App before building — running service locks .next files
- Check build log: `Get-Content C:\Apps\ddivault\logs\npm-build.log -Tail 30`

### NSSM env vars not taking effect
- Verify vars use backtick-n separators not spaces: `nssm get DDIVault-API AppEnvironmentExtra`

### Collector crashes with column does not exist
- A schema migration was not run — check which column is missing and run the appropriate schema file

### WinRM connection fails
- Test: `Test-WSMan -ComputerName TARGET_IP`
- Enable on target: `Enable-PSRemoting -Force`

---

## Environment — Thai Union Production

### Server
- IP: 192.168.6.111
- Domain: thaiunion.co.th
- PostgreSQL service name: postgresql-x64-16
- Node.js: v20.19.0
- PowerShell: 5.1 (NOT PS7 — all PS code must be PS5 compatible)

### Network
- Thailand servers: thaiunion.co.th domain — use Kerberos auth
- EMEA servers: mwbrands.net domain — use Stored Credentials
- Devices: Fortinet, Sangfor, Aruba, Cisco, Palo Alto

### Install paths
- App: C:\Apps\ddivault
- NSSM: C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe
- PostgreSQL: C:\Program Files\PostgreSQL\16\bin
- Logs: C:\Apps\ddivault\logs

---

## Versioning Policy

This app follows semantic versioning. Baseline: 1.2.0 (Jun 2026)

Every commit must include a version bump:
- Bug fix, UI tweak, copy change, config fix → PATCH (x.x.+1)
  Run: npm version patch --no-git-tag-version
- New feature, new page, new API, new chart → MINOR (x.+1.0)
  Run: npm version minor --no-git-tag-version
- Breaking change, DB migration, architecture overhaul → MAJOR (+1.0.0)
  Run: npm version major --no-git-tag-version

Examples of what counts as each type:
- Login page overhaul → Minor
- New dashboard with charts → Minor
- Health score tracking → Minor
- Bug fix (hardcoded IP, broken link, wrong email) → Patch
- New EOL intelligence integration → Minor
- Schema breaking change → Major

Rules:
- ALWAYS bump version as part of the same commit as the changes
- NEVER skip the version bump
- **Exception — documentation-only changes.** A commit that touches ONLY `CLAUDE.md` (or
  adds/edits code comments with no logic change) does NOT require a version bump — it has
  zero runtime/user-facing effect, and bumping would misleadingly imply a functional change
  shipped. Anything else — any change to actual runtime behavior, however small (a copy
  string, a default value, a log message users see) — still requires one.
- Run npm version BEFORE npm run build
- The app reads version from package.json via /api/health
- NocVault suite itself has no version number — only the 4 apps
- When bumping version, also update the releaseNotes object in the update status API with 3-5 bullets describing what changed. No CHANGELOG.md — release notes live in the update status API only.

## Database Access (Read-Only Diagnostics)

A read-only PostgreSQL user exists for Claude Code to query the live production
database directly during development. No psql installation needed — use the
Node.js `pg` module directly.

Connection details:

```
Host:      192.168.6.111
Port:      5432
User:      claude_readonly
Password:  [stored in Claude project memory — ask Amrin]
Databases: logvault, netvault, ddivault, spanvault
```

Usage in Claude Code:

```js
const { Client } = require('pg');
const client = new Client({
  host: '192.168.6.111',
  port: 5432,
  user: 'claude_readonly',
  password: process.env.DB_READONLY_PASS,
  database: 'ddivault',  // change per app
  ssl: false
});
await client.connect();
const { rows } = await client.query('SELECT ...');
await client.end();
```

Permissions: SELECT only — cannot INSERT, UPDATE, DELETE, or modify schema.

Use it to:
- Check actual DB schema before writing queries
- Verify data exists before writing display code
- Diagnose query performance issues
- Confirm migrations worked correctly
- Inspect app_settings, known_hosts, alert_rules, etc.

The password is **never** stored in this repo — it lives in Claude Code's project
memory and is provided at the start of each session. Never log it or commit it to
any repo.

## Live Server Verification (Diagnostics)

The suite runs on the production server **192.168.6.111**. Verify the *running*
deployment directly from the dev host over HTTP — no SSH needed — using `curl`
(Bash tool) or `Invoke-WebRequest` (PowerShell). Pair this with the read-only DB
access above: **curl answers "is it up / what version / what HTTP status", the DB
answers "is the data correct".**

**Health / deployed version** (unauthenticated — safe to hit anytime; use it to
confirm a deploy actually landed):

```bash
curl http://192.168.6.111:3006/api/health        # -> { status, db, version, ... }
```
```powershell
Invoke-WebRequest -Uri "http://192.168.6.111:3006/api/health" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Use each app's **frontend** port (it also serves `/api/*`). The separate backend
API ports (3005/3007/3009) are internal/proxied and not reliably reachable from
outside, so verify via the frontend port:

| App | Health URL |
|---|---|
| netvault  | http://192.168.6.111:3000/api/health |
| logvault  | http://192.168.6.111:3004/api/health |
| ddivault  | http://192.168.6.111:3006/api/health |
| spanvault | http://192.168.6.111:3008/api/health |

**This app: ddivault → frontend port 3006 (backend API 3007 is proxied).**

**Verifying behaviour & data:**
- Most endpoints require an authenticated session + RBAC. An unauthenticated
  `curl` of them returns empty / 401 / a login redirect — that does **not** prove
  the endpoint is broken. To check the DATA an endpoint should return, query the
  read-only DB (above) or use the logged-in browser UI.
- Use `curl` for: `/api/health` (status/db/version), any explicitly public
  endpoint, and HTTP-status sanity (200 vs 500, e.g.
  `curl -s -o /dev/null -w "%{http_code}" http://192.168.6.111:3006/api/health`).
- Deploys are **manual** — Amrin runs the app's updater script; Claude never
  deploys. Always verify **after** the deploy: confirm `/api/health` shows the new
  version, then confirm data via the read-only DB, then eyeball the UI.
