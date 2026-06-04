# DDIVault — Claude Code Reference

## Project Overview
DDIVault is the DNS, DHCP, and IP Address Management (DDI) monitoring product in the NocVault suite.
It monitors Windows DHCP/DNS servers via PowerShell remoting (WinRM), provides IPAM subnet management,
and integrates with NetVault for SSO and site data.

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
│   └── server.js              # Express API server (port 3007)
├── collector/
│   ├── collector.js           # Background polling service
│   ├── ipamScanner.js         # IPAM subnet scanner (PS5 compatible)
│   ├── scanWorker.js          # Child process for non-blocking scans
│   ├── powershellRunner.js    # WinRM PowerShell execution
│   ├── dhcpReader.js          # DHCP log reader
│   └── credStore.js           # AES-256-GCM credential encryption
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
│   │   │   └── ErrorBoundary.tsx  # Error boundaries per tab
│   │   ├── lib/
│   │   │   └── auth.ts            # NextAuth config + NocVault SSO
│   │   └── middleware.ts          # Auth redirect to NocVault login
│   ├── public/
│   │   └── logo.png
│   ├── next.config.js             # API proxy rewrites to port 3007
│   ├── package.json
│   └── tsconfig.json
├── logs/                          # Created manually on server
├── .env.local                     # Root env (API + Collector)
└── package.json                   # Root dependencies

## Development Workflow

### ⚠️ IMPORTANT — Never edit files directly on the server
All changes must follow this workflow:
1. Edit in GitHub Codespaces
2. Test/verify in Codespaces
3. Commit and push to GitHub
4. Run update script on server

### Deploy to server
```powershell
& "C:\Apps\ddivault\installer\Update-DDIVault.ps1"
```

### Commit from Codespaces
```bash
git add -A && git commit -m "feat/fix: description" && git push
```

## Environment Variables

### Root `.env.local` (used by API + Collector)
```env
DB_HOST=localhost
DB_PORT=5432
DDI_DB_NAME=ddivault
DDI_DB_USER=ddivault_user
DDI_DB_PASS=NVAdmin@2026
DDI_API_PORT=3007
DDI_APP_PORT=3006
NEXTAUTH_SECRET=bue3VdWszntJ24GMhfKg1QkPIEaZYC95
NOCVAULT_HUB_URL=http://192.168.6.111:3000
NEXT_PUBLIC_NOCVAULT_HUB_URL=http://192.168.6.111:3000
NETVAULT_DB_HOST=localhost
NETVAULT_DB_PORT=5432
NETVAULT_DB_NAME=netvault
NETVAULT_DB_USER=netvault
NETVAULT_DB_PASS=PgAdmin@2026!
PS_AUTH_MODE=kerberos
PS_TIMEOUT_MS=30000
SCOPE_WARNING_PCT=80
SCOPE_CRITICAL_PCT=90
RETENTION_DAYS=90
```

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

Existing installations must update their `.env.local` manually — this is a one-time rename.

## Database

### Connection
- Host: `localhost:5432`
- Database: `ddivault`
- User: `ddivault_user` / Password: `NVAdmin@2026`

### Schema migration order (must run in this order)
```bash
psql -U ddivault_user -d ddivault -f scripts/schema.sql
psql -U ddivault_user -d ddivault -f scripts/schema-ipam.sql
psql -U ddivault_user -d ddivault -f scripts/schema-server-auth.sql
psql -U ddivault_user -d ddivault -f scripts/schema-sites.sql
```

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

New columns: `dhcp_leases.{device_type,device_vendor,device_os,risk_level,is_mac_randomized,first_seen,last_seen_subnet}`, `ipam_addresses.{device_type,device_vendor,risk_level,is_sensitive}`, `ipam_subnets.is_sensitive`.

## Intelligence & Alerting (Features 1-6) — all on-premises, no external calls
- **Email alerting** — `api/emailer.js` (nodemailer, HTML templates, HMAC ack tokens), `api/alertDispatcher.js` (cooldown, site/severity recipient filtering, hourly digest). SMTP/rule config is super-admin only.
- **Capacity planning** — `collector/forecastEngine.js` (least-squares regression on `dhcp_scope_history`), runs every 6h, fires `scope_exhaustion_forecast` alerts.
- **Device fingerprinting** — `api/ouiLookup.js` + bundled `data/oui.json` (curated real OUIs) + `api/deviceClassifier.js`; applied in `syncLeases`/`syncReservations`/`ipamScanner`.
- **Anomaly detection** — `collector/anomalyDetector.js` (lease spikes vs baselines, after-hours, MAC spoofing, subnet jumping, IP conflict, sensitive-subnet new device, DHCP starvation), every 30m; nightly baseline builder at 02:00.
- **Site health scoring** — `collector/healthScorer.js` (DHCP 40% / IPAM 20% / DNS 20% / Security 20%), every 15m.
- **Smart search** — `GET /api/search` parses `type:`, `vendor:`, `subnet:`, `scope:>N`, `site:`, `new:today|7days`, `risk:`, `anomaly:today`, `status:` structured queries.
- **Frontend** — Intelligence tab (anomaly console), Settings sections (SMTP/Recipients/Rules), Dashboard widgets (Capacity Forecast, Site Health, Security Overview, Device Donut), DHCP device+forecast columns, IPAM device icons + sensitive toggle.

### New API endpoints
- SMTP: `GET/POST /api/smtp`, `POST /api/smtp/test`
- Recipients: `GET/POST /api/alert-recipients`, `PUT/DELETE /api/alert-recipients/:id`
- Rules: `GET /api/alert-rule-config`, `PUT /api/alert-rule-config/:type`
- One-click ack from email: `GET /api/alerts/:id/acknowledge?token=`
- Forecasts: `GET /api/forecasts/scopes`, `/api/forecasts/scopes/:id`, `/api/forecasts/summary`
- Anomalies: `GET /api/anomalies`, `/api/anomalies/summary`, `POST /api/anomalies/:id/ack`
- Site health: `GET /api/site-health`, `/api/site-health/:siteId`

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
- `GET /api/ipam/vlans` — VLANs

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

## Frontend Architecture

### Tab routing
Tabs are managed in `page.tsx` with `useState<Tab>`. Tab types:
`dashboard | scopes | ipam | dns | events | servers | settings`

### API proxy
All `/api/*` calls from Next.js are proxied to Express port 3007 via `next.config.js` rewrites.
`/api/auth/*` and `/api/sso/*` are handled by Next.js natively (NOT proxied).

### SSO flow
1. Unauthenticated user → middleware redirects to `NOCVAULT_HUB_URL/login?callbackUrl=/api/sso/ddivault`
2. User logs in at NocVault hub
3. NocVault redirects to `/api/sso/ddivault` with SSO token
4. SSO route verifies token server-side → creates NextAuth session
5. User lands on DDIVault dashboard

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

### Key design rules
- Inter font (Google Fonts)
- Rounded sidebar items (not full-width highlight)
- Red left indicator on active sidebar item
- Cards: `border-radius: 12px`, subtle shadow
- Tables: zebra hover, sticky headers
- No bullet points in UI copy

## NocVault Suite Context
DDIVault is one of several products:
- **NetVault** — IT Asset Management / CMDB (port 3000)
- **SpanVault** — Network monitoring
- **DDIVault** — DNS/DHCP/IPAM (port 3006)
- **LogVault** — Syslog analyzer (port 3002)

All products share:
- Same NocVault hub for SSO (`netvault` DB, `users` table)
- Same sites data (`netvault.sites` table)
- Same NSSM-based Windows service management
- Same update script pattern

## GitHub
- Repo: `https://github.com/amrin78-smb/ddivault`
- Branch: `main`
- Always work from Codespaces, never edit on server directly

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
$env:PGPASSWORD = "NVAdmin@2026"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U ddivault_user -h localhost -p 5432 -d ddivault -c "\d table_name"
```

```bash
# In Codespaces — check what's in schema files
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

### ⚠️ Always add new routes to next.config.js
Every new Express API route must be added to `frontend/next.config.js` rewrites or the frontend will get a 404.

```js
// frontend/next.config.js
{ source: '/api/your-new-route/:path*', destination: 'http://127.0.0.1:3007/api/your-new-route/:path*' },
```

Routes already proxied: health, dashboard, scopes, leases, events, alerts, alert-rules, servers, settings, subnets, dns, dhcp, ipam, sites, search.

---

## Code Editing Rules

### Never use PowerShell heredoc for Node.js/JSX files
PowerShell heredoc corrupts JSX syntax. Always use Python scripts or `node -e` with a file:
```bash
# Correct — write script to file first
cat > /tmp/fix.js << 'ENDOFFILE'
// your Node.js script

## Adding New API Routes

### ⚠️ Always add new routes to next.config.js
Every new Express API route must be added to `frontend/next.config.js` rewrites or the frontend will get a 404.

```js
// frontend/next.config.js
{ source: '/api/your-new-route/:path*', destination: 'http://127.0.0.1:3007/api/your-new-route/:path*' },
```

Routes already proxied: health, dashboard, scopes, leases, events, alerts, alert-rules, servers, settings, subnets, dns, dhcp, ipam, sites, search.

---

## Code Editing Rules

### Never use PowerShell heredoc for Node.js/JSX files
PowerShell heredoc corrupts JSX syntax. Always use Python scripts or `node -e` with a file:
```bash
# Correct — write script to file first
cat > /tmp/fix.js << 'ENDOFFILE'
// your Node.js script

## Adding New API Routes

### Always add new routes to next.config.js
Every new Express API route must be added to `frontend/next.config.js` rewrites or the frontend will get a 404.

Routes already proxied: health, dashboard, scopes, leases, events, alerts, alert-rules, servers, settings, subnets, dns, dhcp, ipam, sites, search.

---

## Code Editing Rules

### Never use PowerShell heredoc for Node.js/JSX files
PowerShell heredoc corrupts JSX syntax. Always write to a temp file first then run with node.

### Making file edits in Codespaces
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
