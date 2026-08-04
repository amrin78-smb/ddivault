# DDIVault Gotchas — non-obvious behaviours a new session would get wrong

## Security history (fixed, but the pattern can recur — check for it elsewhere)
- **DHCP audit logs are read over WinRM, not SMB** (1.27.0). `powershellRunner.getDhcpAuditLog()` tails the log on the server via the per-server stored credential, exactly like every other DHCP call; `dhcpReader.parseLines()` is the shared transport-agnostic parser. The old SMB route needed a share on each DHCP server AND filesystem ACLs for the collector service identity (LocalSystem = the machine account) — it never worked on any install. `DHCP_LOG_UNC`/`DHCP_LOG_LOCAL` remain an override only.
- ⛔ **Never capture `DHCP_LOG_UNC`/`DHCP_LOG_LOCAL` in a module const.** `collector.js` rewrites them PER SERVER (substituting the `192.168.x.x` TOKEN — it is a token, not a placeholder an operator should edit) after the reader is required. A captured const ignores every rewrite, which is why the override path only ever tried the literal token. Read them inside `logFilePath()`.
- ⛔ **`EVENT_MAP` is a cross-repo contract** with `netvault/agent/modules/ddi/dhcplog.js`. Central and agent collection write the SAME `dhcp_events` table, so a divergence classifies identical events two ways. Corrected 2026-08-04 against Microsoft's table after a live sample parsed 68% as 'Unknown' and id 30 (DNS update REQUEST) was mislabelled 'DNSFailed'. Change both copies together.
- ⛔ **The agent heartbeat's liveness write must be its OWN statement.** `last_seen_at`/`status`/`version` go first and unconditionally; the hostname adoption (added 1.25.0) runs separately in its own try/catch. Folding them together means an un-migrated `ddi_agents.hostname` throws, the message handler's catch swallows it, `last_seen_at` never advances, and the 90s monitor marks a perfectly healthy agent Offline — with it still collecting. That exact shape cost SpanVault 16,665 dead heartbeats, and the schema step is deliberately NON-FATAL in the updater, so a failed apply is a realistic way to get there (1.26.1).
- `useRBAC()` exposes `ready` (false until the NextAuth session resolves). Until then `role` is the **'viewer' default**, not the user's real role — so anything that HIDES or RESETS UI on a capability must wait for it. `page.tsx`'s "reset to dashboard if this tab isn't permitted" effect did not, which is why `/?tab=agents` (gated on `canWrite`) always bounced to the Dashboard while clicking the sidebar worked (fixed 1.26.0).
- Weak fallback secrets were a recurring bug class here. Fixed instances:
  - `api/emailer.js` — alert-ack HMAC token signing used to fall back to a
    hardcoded literal if `NEXTAUTH_SECRET` was unset; now **fails loud at
    startup** instead (refuses to start). `verifyAckToken` now uses
    `crypto.timingSafeEqual` with a length guard (was non-constant-time
    compare — timing attack). Fixed 1.22.3 (`4f53641`).
  - `collector/credStore.js` — AES-256-GCM key derivation for DHCP/DNS
    server admin passwords + SMTP password used to fall back to a weak
    hardcoded literal; now refuses to start unless `NEXTAUTH_SECRET` or
    `DDI_CRED_SECRET` is set. Fixed 1.22.5 (`ffa09c9`).
  - **Rule going forward**: any new code deriving a crypto key or signing
    secret from an env var must NOT do `process.env.X || 'literal'` —
    fail loud at startup instead. Grep for this pattern when adding new
    HMAC/encryption code.
- SSO role fallback bug: `frontend/src/lib/auth.ts` used to fall back to
  role `'user'` when the SSO token carried no role claim — `'user'` is not
  in the role hierarchy (`super_admin > admin > site_admin > viewer`) and
  effectively ranked below `viewer`, silently locking out an otherwise-valid
  session. Now falls back to `'viewer'`, matching the other NocVault suite
  apps. Fixed 1.22.3 (`4f53641`). If you touch role-resolution logic,
  verify the fallback role is a REAL member of the hierarchy.
- `api/server.js`'s in-app "Update" button (SYSTEM-account scheduled task)
  used to fail silently with no record of what happened (git refuses to
  operate in a repo it doesn't "own" as SYSTEM). Fixed 1.22.4 (`d03230d`):
  registers `git config safe.directory`, writes a transcript to
  `installer\logs\`.
- **Update-DDIVault.ps1 self-updating resilience (added alongside NetVault's
  equivalent).** A failed update used to just leave the app stopped (a bare
  `exit 1`) — worse, a failed ROOT npm install didn't even stop the script,
  it just warned and kept going into the frontend build/deploy against
  possibly-broken API/Collector deps. The script now snapshots (via
  `Rename-Item` — a metadata-only operation regardless of directory size, so
  this is cheap even for a large `node_modules`) the pre-update git commit
  PLUS three directories before touching anything: root `node_modules`
  (API/Collector are plain JS with no build step, so a broken install can
  break them directly), `frontend\.next`, and `frontend\node_modules`. DDIVault
  has no `output: 'standalone'` build (unlike NetVault), so there's no single
  self-contained bundle to snapshot — these three together are the
  equivalent. Every failure path funnels through a `Fail-Update` helper that
  reverts git + restores all three snapshots + restarts all 3 services +
  re-verifies `/api/health` before giving up, and writes a structured
  `logs\last-update-status.json` (stage/error code/rolled-back/health-check
  flags) that `GET /api/system/last-update-status` (public, same access level
  as `/api/system/update-available`) surfaces to `UpdateFailureBanner.tsx`
  (admin-only). **A schema migration failure now also triggers this rollback**
  instead of the old hard-stop-and-leave-down behavior — but this only rolls
  back CODE, not the database: each of the 4 `scripts/schema*.sql` files runs
  with `--single-transaction` (verified none of the 4 use a statement that
  can't run in a transaction block — no `CREATE INDEX CONCURRENTLY`,
  `ALTER TYPE ... ADD VALUE`, `VACUUM`, or `CREATE DATABASE`), so a failure
  partway through any ONE file cleanly rolls back just that file — but the 4
  files are still not one combined transaction, so a code-level rollback still
  cannot undo migrations from files that fully applied before a LATER file
  failed. The script still refuses to deploy the NEW code against a DB it
  failed to migrate (same reasoning as before); it now also gets the OLD code
  back up and running instead of leaving the install fully down. The final
  service-status + `/api/health` check (STEP 8) is now a MANDATORY gate — it
  used to only set `$allOk=$false` and print "completed with warnings" while
  still exiting 0; a health-check failure now triggers the same rollback path
  as any other stage failure. **Don't revert any of these back to
  warn-and-continue** — that's the exact bug class this exists to close.
  **Further hardening (2026-07-24, following a real production incident):**
  - The `DDI_DB_PASS`/`DDI_DB_USER`/`DDI_DB_NAME` extraction in STEP 4.5 is now
    wrapped in try/catch routing through `Fail-Update` — it used to be
    unguarded, so a missing/renamed env var threw an uncaught null-reference
    error AFTER services were stopped and node_modules/.next already renamed
    to `.lastgood`, with no rollback attempt at all (the same bug class
    already fixed for STEP 2.5's own `Rename-Item` calls, just not applied
    here until now).
  - **`Stop-LingeringCollector`** (command-line-matched, scoped to
    `$AppDir` + `'collector'` — mirrors NetVault's own command-line-matching
    lingering-process fix) now runs in STEP 1 and inside `Invoke-Rollback`.
    `DDIVault-Collector` has no listening port (unlike App/API on
    3006/3007), so the port-based kill loop couldn't see it at all — this was
    the exact mechanism (a live process still `require()`-ing from a shared
    `node_modules` being renamed underneath it) behind a real production
    incident.
  - The pre-flight `.lastgood` cleanup no longer blindly deletes a leftover
    snapshot: if `last-update-status.json` shows the last run's outcome was
    `success:false, rolledBack:false` (rollback itself also failed), the
    leftover snapshot may be the ONLY remaining path back to a working
    install — the script now aborts loudly (restarting services first, so the
    abort itself doesn't cause an outage) instead of overwriting it.
  - `Wait-Healthy` takes an optional `-ExpectedVersion` and only declares
    healthy once `/api/health`'s own `version` field matches too — the main
    flow gates on the post-pull version, `Invoke-Rollback` gates on the
    pre-update version — so "something answered" and "the RIGHT version
    answered" are no longer conflated.
  - `Invoke-Rollback`'s own health check now retries once more (a ~10s pause,
    then a shorter second window) before declaring "ROLLBACK ALSO FAILED" —
    a single transient failure (concurrent Postgres restart, DB saturation on
    this shared server) used to be reported identically to a genuinely broken
    rollback.
  - **Concurrency guard**: a PID-checked `logs\update.lock` file (script
    start, released in a `finally` wrapping the whole run) stops two
    overlapping runs from racing on the same node_modules/.next
    rename-to-`.lastgood` dance. `POST /api/system/update` in `api/server.js`
    checks the same lock file and returns `409` instead of scheduling a
    second run; the frontend surfaces that 409 distinctly.
  - **Frontend `UpdatingOverlay` (`page.tsx`)** no longer declares success
    purely from a health-poll transition — a rolled-back failure makes the
    OLD version answer `/api/health` just as confidently as a genuine
    success. It now confirms the real outcome via
    `/api/system/last-update-status` first, with distinct states for
    "failed and rolled back" (warning) and "rollback also failed" (most
    urgent — no auto-reload); only a confirmed real success ever navigates to
    `/?updated=true` (the green toast), so it can no longer show at the same
    time as `UpdateFailureBanner`'s red banner for the same failed run.
- Critical auth bypass (1.22.0, `24e886e`): `next.config.js` rewrites (a
  dumb URL-level forward) let a client set `x-ddi-actor-role` itself via a
  bare curl request and bypass RBAC. Fixed by moving all `/api/*` proxying
  into `frontend/src/middleware.ts`, which strips client-supplied
  `x-ddi-actor*` headers and only stamps them from a verified NextAuth JWT.
  **Do not reintroduce a `next.config.js` rewrites table** — see comment at
  top of that file.
- Per-user app-access gate initially (1.21.0) only blocked page navigation;
  a denied user's still-valid session could hit `/api/*` directly and get
  full data. Fixed 1.22.1 (`29e9f26`) by adding the same `appAllowed()`
  check to the proxy branch of `middleware.ts`. **Rule**: any new
  access-control gate must be verified against BOTH the page-render branch
  AND the `/api/*` proxy branch in `middleware.ts` — a gate that only
  blocks the UI is not a security control.
- ~40 routes were found missing `attachSiteFilter`/`requireAuth`/
  `requireWrite` in ONE audit pass (not found incrementally). **Rule**: a
  site-scope/auth fix is a CLASS fix, not an instance fix — when you fix
  one route's guard, grep `api/server.js` + `api/v1.js` for every other
  route on the same resource/table/URL-prefix and confirm they all carry
  the equivalent guard.

## Architecture / routing
- This is NOT a Next.js-monolith app. The real API is a separate Express
  server (`api/server.js`, port 3007, localhost-only). Next.js
  (`frontend/`, port 3006) only owns 2 real page routes (`/`, `/sso`) and 2
  API routes (`/api/auth/[...nextauth]`, `/api/sso`) — everything else
  under `/api/*` is proxied to Express by `frontend/src/middleware.ts`.
- No `next.config.js` rewrites table (removed v1.22.0, `24e886e`) — adding
  a new Express route needs ZERO frontend routing changes; it's reachable
  immediately via the middleware proxy. Only touch `middleware.ts` if the
  new route must work with **no session at all** (add to `PUBLIC_API` or
  `ACK_LINK_API` regex allowlists).
- A route reachable with no session needs THREE independent gates updated
  together, or it silently 401/402s: (1) `middleware.ts` PUBLIC_API/
  ACK_LINK_API/`/api/v1/` allowlist, (2) `api/server.js`'s `enforceLicense`
  — two separate inline `req.path.startsWith(...)` checks, not one named
  exemption array, (3) the route handler itself must NOT be wrapped in
  `requireAuth`/`requireWrite`/`requireSuperAdmin` (a request that came
  through the public allowlist never gets `x-ddi-actor*` headers stamped,
  so `getRequestUser()` returns null and any RBAC guard 401s it anyway).
  Verify with a real `curl` with no cookies — don't just read the allowlist.
- `api/reportsScheduling.js`'s router is mounted at `/api/reports` BEFORE
  `api/reports.js`'s router, so `/saved`, `/schedules`, `/history`, `/pack`
  win over the `reports.js` catch-all `/:type` route. Mount order matters.
- Tabs in the frontend are NOT separate Next.js routes — `page.tsx` is a
  single page with `useState<Tab>` client-side switching. Don't look for
  `app/dashboard/page.tsx` etc.

## PowerShell / WinRM
- `$PID` is reserved in PowerShell — use `$procPid` instead.
- No `-TimeoutSeconds` on `Test-Connection`, no `-Parallel` on
  `ForEach-Object` — target servers run PS 5.1, not PS7. Use `-Quiet` for
  ping; background jobs for parallelism.
- Write multi-line scripts to temp `.ps1` files — never `-Command` with
  embedded newlines. Run with `-ExecutionPolicy Bypass -File`.
- Square-bracket folder names (`[...nextauth]`) require `-LiteralPath` for
  ALL PowerShell file operations on them.
- Never use PowerShell heredoc (`@'...'@`) to write Node.js/JSX files — it
  corrupts JSX syntax. Write to a temp file first, then run with node.

## Database / schema
- Schema files MUST run in order: `schema.sql` -> `schema-ipam.sql` ->
  `schema-server-auth.sql` -> `schema-sites.sql`. All use
  `IF NOT EXISTS` so re-running is safe, but order still matters (later
  files ALTER tables the earlier ones create).
- `uuid-ossp` extension requires superuser to install.
- Any DB change (new table/column/index) MUST update the matching schema
  file in the SAME commit — fresh installs use these files directly, no
  separate migration runner.
- v1.11.0 upgrade landmine: `alert_events.resolved_at`/`resolved_reason`
  were added to `schema.sql`; if the collector starts before that schema
  file is applied, every poll errors with `column "resolved_at" does not
  exist`. The installer's STEP 4.5 re-runs all four schema files
  (idempotent) before restarting services, so this only bites manual
  deploys that restart services before re-running `schema.sql`.
- No dedicated readonly DB role/grant script ships in this repo's
  scripts/installer — the `claude_readonly` Postgres user (SELECT-only,
  used for live-DB diagnostics from Claude Code) is a manually created role
  outside the schema-provisioning flow. See schema.md "Privilege notes".

## License enforcement
- License cache TTL is **5 minutes** (`CACHE_TTL` in `api/licenseCheck.js`,
  in-memory), NOT 24h. The 24h `setInterval` in `api/server.js` is a
  SEPARATE, much-less-frequent background refresh purely for a
  startup/health-check log line — it does not govern how fast a license
  change takes effect.
- License checks fail OPEN on network failure (unreachable hub = full
  access) — this is intentional, not a bug to "fix".
- Past-grace license disables ALL routes except `/api/health`,
  `/api/stats`, `/api/license-status`, `/api/system/update-available` (402
  everything else). Acknowledge endpoints are exempt from the read-only
  writes-402 during grace period specifically (isAck path check).

## Frontend / React
- Never define a component inside another component's function body —
  causes remount + lost focus on every parent re-render/keystroke. Several
  files have an explicit comment flagging this
  (`ApiKeysSection.tsx`, `AlertRecipients.tsx`, `ServersTab.tsx`,
  `ReportsCatalog.tsx`, `PriorityActionCenter.tsx`, `IdleTimeout.tsx`,
  `ui.tsx` all say "module scope — never nested"). See components.md
  Violations section for whether any file actually breaks this rule.
- `next.cmd` not `node next.js` for NSSM — must point at `next.cmd`.
- Always stop the `DDIVault-App` service before `npm run build` — a running
  service locks `.next` files.
- Client-side hub-URL resolution uses `getHubUrl()`
  (`frontend/src/lib/hubUrl.ts`, `window.location`-derived) — never read
  `NEXT_PUBLIC_NOCVAULT_HUB_URL` directly in client code, it's a
  last-resort fallback only (added 2026-07). Server-side call sites use
  `resolveOrigin(req, ...)` from `frontend/src/lib/publicUrl.ts` instead,
  which derives origin from the current request's
  `x-forwarded-host`/`host` + `x-forwarded-proto`.
- Sign-out does NOT use next-auth's `signOut()` (it appends a callbackUrl
  that causes an auto-SSO loop back into DDIVault). Instead: fetch CSRF
  token -> POST `/api/auth/signout` -> `window.location.replace(hub +
  '/launcher')`.
- `.env.local` hub-URL vars must be named `NOCVAULT_HUB_URL` /
  `NEXT_PUBLIC_NOCVAULT_HUB_URL` — NOT `NETVAULT_HUB_URL` (old name, SSO
  fails silently falling back to `localhost:3000` if used).

## NSSM / deployment
- Use backtick-n (`` `n ``) to separate env vars in `AppEnvironmentExtra`
  — plain spaces concatenate into one hostname string.
- Use `sc.exe`, not `Stop-Service`/`Start-Service` — avoids terminal hangs.
- `SERVER_IP` env var is required by the update-from-UI route in
  `api/server.js` (used to build the `Update-DDIVault.ps1` scheduled-task
  invocation) — returns 400 if unset, even though it doesn't affect normal
  app operation otherwise.
- This app is provisioned TWO ways that must stay in sync:
  `installer/Update-DDIVault.ps1` (per-app updater) AND the suite installer
  `../netvault/installer/Install-NocVault-Suite.ps1` (fresh install, lives
  in the sibling `netvault` repo). Any provisioning-affecting change (new
  env var, scheduled task, schema file, NSSM service, port, cross-DB grant,
  build step) must update BOTH in the same change.

## Deliberate design choices (do not "fix")
- Alert acknowledge endpoints stay reachable during read-only license grace
  — writes 402 everywhere else, acks are exempted on purpose.
- `GET /api/dashboard/collector-status`-style health/status endpoints never
  500 — on any error they return zeros with HTTP 200 so a polling consumer
  is never broken by a transient DB hiccup. Don't "fix" a 200-with-zeros
  response into a 500.
- IPAM subnet forecasting is intentionally NOT implemented (`forecastEngine.js`
  comment) — there's no per-subnet history table yet; `subnet_forecasts`
  table exists but is reserved/unused.
- CSV export escaping: a shared CSV escaper closes a formula-injection gap
  (leases + audit exports) — don't bypass it when adding new CSV exports;
  reuse `api/csv.js`.
- Audit writes NEVER throw (`api/middleware/audit.js`) — a failed audit
  write must never break the underlying request/operation being audited.

## Remote agent data plane (Phase 4b — `api/ws-server.js` + `collector/writers.js`)
- The DB-write half of the collector lives in `collector/writers.js`
  (`writeScopeStats`/`writeLeases`/`writeReservations`/`writeDhcpEvents`/
  `writeDnsZones`/`writeScanResult`). It is the SINGLE source of truth for
  "given already-collected raw PS output for a server, UPSERT it". BOTH
  `collector/collector.js` (central WinRM polling) and `api/ws-server.js`
  (remote-agent ingest) call it — so an agent-written scope/lease/zone is
  byte-identical to a centrally-polled one. When you change any DHCP/DNS write
  logic, change it in `writers.js`, NOT in collector.js (collector.js now only
  COLLECTS via powershellRunner, then delegates the write). Do NOT `require`
  collector.js from anywhere — it runs `main()` at load and would start a 2nd
  collector; the shared helpers/coercions are re-exported from `writers.js`.
- `getActiveServers()` (collector.js) filters `agent_hub_id IS NULL` — the
  central collector NEVER polls agent-owned servers. Config push does the
  opposite (`agent_hub_id = <agent>`). If a server "stopped polling centrally",
  check whether it got an `agent_hub_id` assigned.
- `ws-server.js` runs IN the API process (started from `api/server.js`), bound
  to all interfaces on `DDI_WS_PORT` (3011) while the REST API stays loopback.
  It DECRYPTS `ps_password` (credStore) into the `ddi_config` frame so the agent
  has usable WinRM creds — that frame carries plaintext creds, so wss:// (set
  `DDI_WS_TLS_CERT`/`DDI_WS_TLS_KEY`) is strongly recommended in production.
- The hub-JWT revocation cross-check queries `netvault.agents` over the SAME
  cross-DB pool `api/server.js` uses (ddivault_user → netvault). ddivault_user
  therefore needs `SELECT ON netvault.agents` (a NEW cross-DB grant beyond the
  existing sites/countries grant) or every agent connect fails closed (4003).
- Inner `data` shapes per `ddi_result` kind are defined in ws-server.js's header
  comment (scope_stats→{stats,scopes}, dns_zones→{zones,recordsByZone}, etc.).
  The netvault agent module is built to those exact shapes — keep them in sync.
  `scope_options`/`dns_health`/`failover` are accepted but NOT yet persisted
  agent-side (central dnsMonitor/haMonitor still cover local servers).
- **Agent writes are OWNERSHIP-SCOPED — fail closed.** `handleResult` scopes a
  `ddi_result` to `ddi_servers WHERE id=? AND agent_hub_id=?` (`ownedServer`), and
  `handleScanResult` scopes a `ddi_scan_result` subnet through SITE — a `subnet_id`
  is accepted ONLY if its `site_id` is a site of a `ddi_servers` row owned by that
  `hubAgentId` (exactly the subnet set `pushConfigToAgent` advertised). Subnets have
  no `agent_hub_id`, so ownership goes via site. Without this an authenticated agent
  could write scan data + fire "unknown device" alerts for ANY subnet in the instance
  (cross-tenant IPAM write). Any NEW agent→server ingest frame must fail closed the
  same way — resolve ownership before writing, drop with a warn otherwise.
- **Central IPAM scans SKIP agent-owned subnets.** A subnet whose `site_id` has a
  `ddi_servers` row with `agent_hub_id IS NOT NULL` is scanned by that remote agent
  from its LAN. The central host usually can't reach that LAN, so a central sweep
  races the agent and overwrites its real results with all-'available'. Both scan
  paths enforce this: `POST /api/ipam/subnets/:id/scan` returns `409 {reason:'agent_owned'}`,
  and `ipamScanner.scanAllSubnets()` filters agent-owned sites out of its query.
  Keep both in sync if you add another central-scan entry point.
- **ws-server refuses cleartext on a public bind.** With no `DDI_WS_TLS_CERT/KEY`,
  binding a NON-loopback interface THROWS at startup unless `DDI_WS_ALLOW_PLAINTEXT=1`
  is set — because the `ddi_config` frame pushes DECRYPTED WinRM passwords, and plain
  ws:// on 0.0.0.0 leaks them. Loopback-only binds are always allowed. An operator on
  a trusted segment must consciously opt into cleartext via that env var. Also: the
  `WebSocketServer` sets `maxPayload` (default 8 MB, `DDI_WS_MAX_PAYLOAD`) and a simple
  per-connection message-rate guard (`DDI_WS_MSG_RATE`, closes 4008) — don't drop these.
- **Agent-offline blind spot is alerted.** When the heartbeat monitor flips an agent
  to `status='offline'`, its assigned servers are collected by nobody (central skips
  `agent_hub_id`, dead agent can't poll). If the agent HAS assigned servers, the monitor
  marks them `poll_status='stale'` and fires ONE `alert_events` warning (idempotent: the
  monitor only re-selects `status='online'` rows + a 24h `NOT EXISTS` message guard).
  Servers self-heal to `poll_status='ok'` on the agent's next write via `writers.js`.
- **SETTINGS key names are a wire contract with the agent module.** The `ddi_config`
  `settings` object uses the agent module's canonical reader keys — e.g. DHCP-event
  cadence is `dhcp_events_interval_s` (NOT `dhcp_log_interval_s`). A key the agent
  doesn't read is silently ignored (polls fall back to the module default). Match the
  agent module's exact key names when adding/renaming a setting.
