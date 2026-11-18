# DDIVault Gotchas — non-obvious behaviours a new session would get wrong

## Security history (fixed, but the pattern can recur — check for it elsewhere)
- ⛔ **EVERY `${...}` in a PowerShell script string goes through `psq()` or `psNum()` — there is no third option** (`collector/powershellRunner.js`). This closed a CONFIRMED remote-code-execution path: 18+ builders interpolated caller strings straight into single-quoted PS literals, and `runPS` escaped only `\` and `"` — never `'`. A value containing an apostrophe closed its own literal and the rest executed, inside `Invoke-Command -ScriptBlock { … }`, **on the customer's Windows DNS/DHCP server** as the WinRM identity (Kerberos: the service account; `credential`: the stored domain admin). Reachable from `POST /api/dns/records` and `POST /api/v1/dns/records` — and `api/middleware/rbac.js:68` maps a key holding only `write` to role `admin`, so an API key provisioned to create DNS records yielded code execution on domain infrastructure. Several numerics (`ttl`, `priority`, `weight`, `port`, `optionId`, the stale-records `cutoff`) sat in UNQUOTED positions, where any non-digit text is parsed as code and no quote is needed at all. The tell that it was an oversight rather than a convention: the credential path had always escaped its own username/password this way. `psq` doubles `'` (the only escape a PS single-quoted literal has); `psNum` can emit nothing but digits. Both are exported and unit-tested in `tests/powershellRunner.escaping.test.js`. Same class fixed in `collector/ipamScanner.js` (the `scan_dns_server` app_setting reached a generated `.ps1` unescaped).
- ⛔ **`runPS` uses `execFile`, NOT `exec` — do not reintroduce a shell.** It used to go through `child_process.exec`, i.e. cmd.exe, which added a second quoting layer that the `"`→`\"` escaping got WRONG in both directions (cmd toggles on the bare quote and does not honour backslash escapes), exposed `%VAR%` expansion, and capped the command at cmd's ~8191 characters. `execFile` with an argv array removes all of it. Two latent bugs disappeared with the shell, so expect these to start returning data: `getDnsQueryStats` was sending `'\\DNS\Total Query Received/sec'`, where a leading `\\` is *remote-computer* counter syntax, and `getDhcpAuditLog` was sending `System32\\dhcp\\<file>`.
- The **credential-mode password now reaches PowerShell via the child process's own environment** (`$env:DDI_PS_PASSWORD`), never the command line — a command line is world-readable through `Win32_Process.CommandLine` for the life of the process.
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
- **Authorization/disclosure sweep (2026-11-07) — the patterns, not just the
  routes.** Nine findings, every one a case of a guard that looked present:
  - ⛔ **`requireAuth` is an IDENTITY check, not an AUTHORIZATION check.**
    `GET /api/leases/export` had been revisited once purely to ADD `requireAuth`
    — and the query stayed `SELECT … FROM dhcp_leases ORDER BY ip_address`, no
    site filter, no pagination, so any signed-in `site_admin` downloaded every
    lease in every site. Same on `/api/leases` and `/api/leases/ip/:ip/history`.
    `/api/leases` is the sharpest tell: it ALREADY had
    `LEFT JOIN ddi_servers s ON s.id = l.server_id` for the hostname column. The
    join was there; only the predicate was missing. **When you see a join to a
    site-bearing table with no `site_id` predicate, assume the predicate was
    forgotten, not declined.**
  - ⛔ **A site predicate must go in the COUNT as well as the rows query** — and
    for `/api/alerts`, inside the GROUPED subquery of both, or the page and the
    total it paginates over describe different row sets (the same failure mode
    already recorded for this route's status grouping).
  - ⛔ **An in-code justification for leaving a route unscoped can go stale, and
    nothing re-checks it.** Three of these carried comments explaining why
    scoping was impossible. `/api/forecasts/summary` said `scope_forecasts` had
    "no join target" — both its own siblings reach the site through
    `scope_id -> dhcp_scopes -> ddi_servers.site_id`. `/api/search` left its six
    `dhcp_leases` sub-queries unfiltered *because `/api/leases` was unfiltered*,
    so fixing `/api/leases` alone would have left `vendor:apple` as the same leak
    through another door. `/api/ipam/vlans` said `ipam_vlans` has no site_id —
    true, but its `site` TEXT column is not free text: the only writer is the Add
    VLAN modal's `SiteSelect`, whose values are NetVault site NAMES, so ids
    translate to names via `netvault.sites`. **Re-derive the claim; a comment is
    not evidence.** (Still genuinely unscopable, and deliberately left alone:
    `/api/ipam/utilization-history`, `/api/dns/health`, `/api/anomalies*`,
    `/api/dashboard/stats`.)
  - ⛔ **403 on out-of-scope while 404 on absent is a disclosure.** It lets a
    caller walk small integer ids and map which rows exist.
    `api/reports.js`'s drill route did both in the same handler. Both branches now
    go through `queryScope.scopeGate`, which returns ONE object for the two cases
    so they cannot drift apart. Every other by-id read in the app was already
    404-both-ways.
  - ⛔ **`x-forwarded-for`'s FIRST entry is the CALLER's.** The header is built by
    appending, so only the entries a trusted proxy added are non-forgeable.
    `clientIp` (duplicated in `middleware/apiAuth.js` and `middleware/audit.js`)
    read `split(',')[0]`, so `X-Forwarded-For: <allowed-ip>` defeated
    `api_keys.allowed_ips` outright and every audit-log source IP was whatever the
    caller typed. Now one shared `api/clientIp.js` counting from the RIGHT. **The
    duplication was the structural bug** — it is how one call site stays broken
    after the other is fixed.
  - ⛔ **A request-derived origin is fine for a LINK and an SSRF primitive for a
    FETCH.** `resolveHubOrigin(req, …)` exists because `NEXTAUTH_URL` is baked to
    the install IP, and for a browser redirect that is correct. `/api/hub/settings`
    used it to choose a host to `fetch()` and returned the body — a bounded
    internal read plus a port-3000 oracle, live on any plain-HTTP install and on a
    TLS install with `TLS_PUBLIC_HOST` unset (the terminator then re-derives
    `x-forwarded-host` from the client's own `Host`). Server-side fetches now use
    `configuredHubOrigin()` (env only); `TRUST_PROXY_HEADERS` additionally gates
    forwarded-header trust for the link path, matching
    `net-vault/lib/publicUrl.ts`. **Split the two uses before hardening either.**
  - ⛔ **`e.message` from pg names your schema.** ~20 `catch` blocks in
    `api/v1.js` returned it to API-key holders, while `api/reports.js` had an
    explicit comment NOT to and `api/server.js` was already generic — the rule
    existed and one file never got it. All v1 500s now go through
    `v1-envelope.internalError`.
  - ⛔ **A route in `middleware.ts`'s `PUBLIC_API` cannot carry an RBAC guard**
    (no `x-ddi-actor*` headers get stamped, so even a super_admin 401s), so gate 1
    and gate 3 of the three-gate checklist must move TOGETHER.
    `/api/system/last-update-status` was public and spread the whole updater
    status file — stage, raw error text, rollback flag, commit hashes. It is now
    out of `PUBLIC_API` and `requireRole('admin')`. **`enforceLicense`'s exemption
    list is now deliberately NOT identical to `PUBLIC_API`** — the licence
    exemption stays (an admin must still see a failed update past grace) while the
    session exemption is gone. Don't re-sync those two lists on the assumption
    that they must match; both files say so.
  - **`/api/v1/*` has NO site model at all** (`rbac.js` collapses a key to
    `admin`/`viewer`, `getAllowedSiteIds` returns null for both, `api_keys` has no
    site column). That may be intended for machine credentials, but it means a
    `read` key is unscoped by construction — so `GET /api/v1/audit` on `read`
    outranked a `site_admin` session. Raised to `admin` as the nearest analogue of
    the session side's `requireSuperAdmin` export. The broader gap is a product
    decision, not a bug fix.

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
- **EVERY `collector/powershellRunner.js` export is `async` (since 1.28.0) —
  you MUST `await` it.** A missed `await` does not throw: a Promise is truthy,
  so `if (!ok) return fail(...)` silently passes and the caller reports success
  for a write that failed, or stores a Promise where a value belongs. When
  adding a call site, grep the whole repo (`api/server.js`, `api/v1.js`,
  `collector/*.js`) — `api/v1.js` receives the module by dependency injection
  (`const { db, psWrite } = deps`), so a `require('powershellRunner')` grep does
  NOT find it.
- Why it is async: it used `execSync`, which blocks the **entire Node event
  loop** for the whole call (up to `PS_DNS_TIMEOUT`, 60s). Nothing else in the
  process ran meanwhile — including pg's connection callbacks and its
  `connectionTimeoutMillis` timer, so a perfectly healthy local database
  reported `Connection terminated due to connection timeout` / `timeout
  exceeded when trying to connect` purely because the loop was frozen. This
  masqueraded for a long time as a DB/pool problem: raising `max` (5->10) and
  `connectionTimeoutMillis` (5s->10s) never fixed it because the pool was never
  actually saturated (only ~5 backends existed). The same freeze hit the API
  server, where one DNS write stalled every other HTTP request. **Never
  reintroduce `execSync` (or any sync I/O) into a path either long-running
  service can reach.**

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

## Shutdown / signals
- ⛔ **NSSM delivers SIGINT, not SIGTERM.** It stops a service with a console Ctrl-C event, which Node surfaces as `SIGINT`; `SIGTERM` is not a real Windows signal and a SIGTERM-only handler NEVER fires under NSSM. Register `SIGINT` + `SIGBREAK` + `SIGTERM`.
- ⛔ **`AppKillProcessTree` does not exist in NSSM 2.24** (verified against the production binary - it is rejected as an invalid parameter). Nothing reaps a service child process when the service stops. The forked IPAM `scanWorker` therefore can be, and before 1.31.0 was, ORPHANED by a hard stop: it keeps its own pg pool and keeps writing `ipam_addresses`/`ipam_scan_jobs` for up to `SCAN_TIMEOUT` (5 min), including flipping a row to `done` after the API restarted and after `clearStuckScansOnStartup` already cleared it. `scanningSubnets` is now a `Map<subnetId, ChildProcess>` precisely so shutdown can kill them.
- **The startup stuck-scan sweep is age-gated and cannot cover a restart.** `clearStuckScansOnStartup` only clears rows older than 30 min / 1 hour, so a service restart that takes ten seconds clears NOTHING and the UI shows a permanent "Scanning" spinner until the threshold passes. The shutdown handler therefore marks in-flight scans aborted UNCONDITIONALLY, by id, before closing the pool. Do not "simplify" that back to relying on the startup sweep.
- **The DDIVault collector shutdown deliberately waits for nothing.** Every poll it runs writes idempotent DHCP/DNS/IPAM data - an interrupted cycle costs one sample and the next corrects it. That is NOT true of SpanVault, whose collector must wait out an Aruba Central token rotation or permanently brick that integration. Do not copy this simpler shape across without checking what the in-flight write actually is.
- **`stopWsServer()` ordering matters.** Close the agent sockets FIRST so each connection close handler can write its `status=offline` row, and only then end the `ddi`/`nv` pools those writes need. Reversed, the writes fail silently and every agent stays "online" until the 90s sweep after the next restart.
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
- **After an `ON CONFLICT DO NOTHING` insert, everything downstream MUST be gated on `rowCount`.** `collector/writers.js`'s writeDhcpEvents re-reads the DHCP tail on every 5-min poll and IN FULL after any restart, so the same events arrive many times. dhcp_events ignores repeats via ON CONFLICT — but the lease_history write, the 1020/2019 alert checks, and the `inserted++` counter all used to run unconditionally afterwards. lease_history has NO unique constraint and no ON CONFLICT, so every re-read appended another copy: 2056 surplus rows out of 5561 live (37%), some lease events stored 6 times, skewing every per-IP history built on it. Fixed 1.28.3 with `const isNew = res.rowCount === 1` + `if (!isNew) continue`. `lastTime` is deliberately still advanced for duplicates — it is the high-water mark for what was SEEN, not stored. If you add any new side-effect to that loop, put it AFTER the isNew gate. Pre-1.28.3 duplicate rows were left in place (removing production history is a separate decision).
- Audit writes NEVER throw (`api/middleware/audit.js`) — a failed audit
  write must never break the underlying request/operation being audited.
- **Report METADATA is deliberately NOT site-scoped; report DATA is.** Saved
  views (`saved_reports`), run history (`report_run_history`) and schedules
  (`report_schedules`) are shared across all sites — any authenticated user
  sees them all (`requireAuth`/`requireWrite`; schedule mutations are
  `requireSuperAdmin`). The report CONTENT is fully scoped: `api/reports.js`
  filters every report type by `allowedSiteIds`. Confirmed as intended by the
  owner 2026-08-04 after being re-raised as a suspected bug for the second
  time, so it is recorded here to stop the next sweep re-flagging it. The
  reasoning: no report rows are exposed by the metadata — those tables hold
  the report type, the filter params, a `row_count`, `generated_by` and a
  timestamp, so the most a site_admin can infer is that someone ran a report
  for another site and roughly how large it was. Against that, shared saved
  views are the feature: a report template defined once is reusable by the
  whole organisation. If this is ever revisited, scoping run history alone
  (closing the `row_count` inference vector) while leaving saved views shared
  is the middle option that was considered.

## Suite SMTP (hub transport) — `api/suiteSmtp.js`, added 1.34.0

- **`api/emailer.js` is required by BOTH processes.** `api/server.js` loads it AND
  `collector/reportScheduler.js` loads it, so anything emailer pulls in runs in the
  DDIVault-Collector too. That is why the hub read has its OWN pg pool instead of
  reusing `api/server.js`'s `netvaultDb` — the collector has no such pool — and why
  every new failure mode in that path had to be made non-fatal.
- ⛔ **The hub read FAILS SOFT on everything, and that is the feature.** Missing
  `NEXTAUTH_SECRET`, Postgres `42P01 undefined_table`, a connection error, a revoked
  grant, an undecryptable password → fall back to this app's own `smtp_config` row and
  warn ONCE. `42P01` is not an edge case: a hub that has not yet shipped its own half is
  the NORMAL state during a staged rollout, and a satellite must not degrade because of
  it. Do not "tidy" any of these into a throw.
- ⛔ **`collector/credStore.js` throws at MODULE LOAD without a secret — on purpose.**
  That stays (it guards credential WRITES). `suiteSmtp.js` therefore requires it lazily,
  behind an explicit `process.env` guard, so the soft fallback cannot be turned into a
  dead collector by the require itself. Never hoist that require to the top of the file.
- **An idle-client error on a pg Pool with no `'error'` listener kills the process.**
  The hub pool registers one (same reason `collector/healthScorer.js` does).
- **The LOCAL read deliberately still propagates.** Only the HUB half is soft. A failure
  to read this app's own `smtp_config` is a real fault and has always thrown out of
  `getSmtpConfig` — making it soft would silently stop alert mail.
- **There is exactly ONE SMTP cache now** (5 min, in `suiteSmtp`, covering the hub row,
  the local row and the choice between them). `emailer.invalidateSmtpCache()` clears it;
  `POST /api/smtp` calls that after a save. If you add a second cache anywhere in this
  path, clear it from that same function or an admin's edit appears not to take.
- **`enabled` and the From identity do NOT come from the hub when a local row exists.**
  The hub owns host/port/secure/username/password ONLY. `from_email`/`from_name` stay
  local so recipients still see DDIVault (the hub's are used only when this app has no
  row at all — otherwise a fresh install would send with no From address). `enabled`
  stays local too: it answers "does DDIVault send mail", not "does a transport exist",
  so an admin who switched DDIVault's alert email off does not start receiving it again
  because the hub gained an SMTP server.
- ⛔ **TLS verification: ONE rule for both sources since 1.35.0 — the local exemption is
  GONE.** `buildTransport` verifies unless the resolved config's `allow_self_signed` is
  `=== true`, whether the transport is the hub's or this app's own. Until 1.35.0 the local
  path set `rejectUnauthorized: false` UNCONDITIONALLY: DDIVault silently accepted any
  certificate, forever, with nothing in the UI saying so, while the hub, LogVault and
  SpanVault all verified. 1.34.0 deliberately left that alone on a continuity argument
  (flipping a live alerting path to verify on a routine update is a silent "alerts stopped
  arriving"). **That argument was retired on EVIDENCE, not waved away** — measured on
  production 2026-11-13, `alert_email_log` held zero rows for all time, `smtp_config.enabled`
  was false with no active `alert_recipients`, and the other satellites' mail was off too.
  There was no working configuration anywhere to preserve, so the column ships
  `DEFAULT FALSE` with no backfill. If DDIVault is ever actually sending mail, changing this
  default again needs a migration, not a flag day.
- ⛔ **`allow_self_signed` is compared with `=== true`, never a truthy test.** The value
  can be NULL (a row written before the column existed) or, on the hub path, a JSON-ish
  value where the strings `'false'` and `'0'` are BOTH truthy: a loose cast would read
  "off" as "on" and silently stop verifying certificates. `suiteSmtp` normalizes on both
  paths and `buildTransport` tests `=== true` at the one place that actually decides.
  Keep both — two halves of one belt, not a duplicate. (`POST /api/smtp`'s own strict
  coercion is GONE with the field itself — see the section below.)
- ⛔ **A nodemailer error message is not safe to return.** It routinely embeds the host,
  the port, the configured username and the server's verbatim auth rejection.
  `POST /api/smtp/test` returned it verbatim until 1.34.0; it now goes through
  `emailer.mailErrorSummary()` (code/responseCode only) with the detail logged
  server-side. LogVault and SpanVault had both already fixed this exact class — DDIVault
  was the surviving instance, which is the "a fixed instance is not a fixed class" rule
  again. `sendReport`/`sendDigest` still keep the raw message, correctly: it lands in
  `report_email_log`/`alert_email_log`, server-side audit rows, never an HTTP response.
  Check that distinction before forwarding either.
- **No installer or env change was needed, and that was verified not assumed.** Both
  `DDIVault-API` and `DDIVault-Collector` already receive `NETVAULT_DB_HOST/PORT/NAME/
  USER/PASS` and `NEXTAUTH_SECRET` from `Install-NocVault-Suite.ps1`, and the pool uses
  the `netvault` role (the hub's own), so no grant changes either.

## SMTP page: the hub owns the transport, DDIVault owns the identity — 1.35.0

- ⛔ **`POST /api/smtp` no longer ACCEPTS the transport fields, and the UI no longer
  OFFERS them.** `host`, `port`, `secure`, `username`, `password`, `allow_self_signed` are
  not destructured by the route and are absent from its UPDATE SET list; the Settings page
  renders a read-only statement of the effective transport instead of inputs. Rationale:
  the hub is now the only place a mail server is configured, so a form here would own
  nothing — and the `allow_self_signed` tickbox added EARLIER IN THE SAME RELEASE went
  with the rest, because it only ever governed the local fallback. Measured on production
  2026-11-13 first: `alert_email_log` empty all time, `smtp_config.enabled=false`, zero
  active recipients — there was no working local configuration to protect.
- ⛔ **The COLUMNS stay and the FALLBACK still reads them.** `suiteSmtp.readLocalConfig`
  is unchanged: a customer mid-rollout may have satellites updated ahead of the hub, and
  this repo really does carry such a row (`smtp.office365.com`, delivery off). Do NOT
  "finish the job" by dropping the columns or blanking the row — and do not let the UI
  stop naming that row, because a transport that sends mail while the page says nothing
  about it is the exact failure this change removed. The page's 'legacy' state exists for
  precisely that.
- **With no row at all, POST INSERTs `host=''`** (`host` is `NOT NULL`). Every reader —
  `readLocalConfig`, the Settings page's state derivation, `sendTestEmail` — treats a
  blank host as "no local transport" rather than a server to dial, and `sendTestEmail`
  short-circuits with a message naming the hub instead of a bare DNS/socket code.
- **`enabled` takes a LENIENT coercion here, deliberately opposite to `allow_self_signed`'s
  strict one.** The direction of harm decides: a flag that only ever turns delivery ON must
  not read `'true'` as off and silently stop a customer's alert mail, whereas a flag that
  turns a security check OFF must not read `'false'` as on.
- **Consequence an admin can hit:** someone who had filled in a self-signed relay but never
  switched delivery on now finds Send Test Email refused (local configs verify since
  1.35.0) with no tickbox left to disable it. The ONLY route is to configure that relay
  centrally on the hub and tick Allow self-signed certificate there. This is named in the
  1.35.0 release notes on purpose — a removed control plus a tightened default is a dead
  end unless the notes say where the new door is.
- **The audit line no longer names the TLS state**, because this route can no longer change
  it; it names the delivery switch and says the mail server lives in NetVault. (The
  "a security flag belongs in the audit line" principle still holds — it now applies to the
  hub's own route, not this one.)

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

- ⛔ **Never derive a count from a page of rows.** The Events & Alerts tabs used to fetch `/alerts?limit=200` once and compute Open/Acknowledged/Resolved by filtering that array — so the labels meant "…among the newest 200", not "…in total". Live, that showed **Open (1) while 70 alerts were genuinely open**: only 1 of them had fired in the last 7 days, the other 70 were older than the 200-row window and were never fetched. The header bell was right the whole time because it reads the server's `total` for `?unacked=true`. The tell was the arithmetic — the three tabs summed to exactly 200. `/api/alerts` supports `status=open|acked|resolved` and returns a real COUNT; use it.
- `/api/alerts` groups repeated alerts by `(normalised message, server_id, acknowledged, resolved?, hour)`. `resolved_at` belongs in that key: without it one group could hold both resolved and unresolved rows and be counted under two status tabs at once, so the per-status counts summed to more than the total (16 over, live). The COUNT and the rows query must group IDENTICALLY, or a page and the total it paginates over describe different things.

- ⛔ **Alerts on a fluctuating metric MUST be sustained, and fire/clear must not share a threshold.** `haMonitor.js`'s health check fired on any single poll below 80 and cleared the instant one reached 80 — so a score oscillating around the line raised and resolved on every poll, and since `fireAlertDeduped` only dedupes against an OPEN alert, each cycle wrote a NEW row. Live: 462 health alerts in 7 days from 2 servers, 68% of the app's entire alert volume. Replaying real `server_health_history`: single-sample 462 → hysteresis alone 233 → 3-sample sustain **5**. The distribution showed why — across 9,935 samples NOTHING landed in 80-84; the score sits 90+ and dips to ~75 for one poll. Three knobs now: `HEALTH_SUSTAIN_SAMPLES` (the one that matters), `HEALTH_RECOVER_AT` (hysteresis gap), `REFIRE_COOLDOWN_MIN` (a condition that clears and returns within the hour is flapping, not recurring — applies to every `fireAlertDeduped` caller). Same lesson as SpanVault's wireless RF alerting. Tune these by REPLAYING history, never by guessing a number.
- **The Operations Center dashboard is split into 5 sections, and only the open one mounts — which also gates the 30s auto-refresh.** `DashboardTab` holds `section` (persisted to `localStorage['ddivault-dash-section']`). Its ~10 child widgets self-fetch on mount and re-fetch when `refreshNonce` ticks every 30s, so an unmounted section neither loads nor participates in the refresh — that is the main saving, and it is ongoing rather than first-paint-only. The inline loader was split in two: `load()` fetches `/dashboard/stats`, `/scopes/history/all` and `/dashboard/ip-distribution` ALWAYS, and `loadCapacity()` fetches `/scopes` + `/dashboard/lease-trend` only while Capacity is open. **Do not "tidy" scopeHistory or ipDist into the capacity-only loader** — they are only *charted* in Capacity but are also consumed by the always-visible KPI strip (`scopeHistory`→`trends()` drives the delta arrows, `ipDist` supplies the Unknown Devices tile), so gating either silently blanks part of the strip. The tab bar reuses the existing `.settings-tabs` container, and its buttons need `className="settings-tab"` (+` active`) — the CSS styles `.settings-tab`, NOT a bare `button`, so a bare button renders completely unstyled. **When adding a section, make sure it cannot render empty**: several widgets self-hide when they have nothing to show (`PillarScorecards` returns null with <2 data points), so a section containing only self-hiding widgets shows a blank page on a healthy system — the same mistake was shipped in SpanVault 1.103.0 and had to be fixed.

### The shared TLS front door must come back on EVERY path out of an update

`installer/Update-DDIVault.ps1` stops `NocVault-Tls` only when that service
actually declares a dependency on this app's service — but once stopped, it
fronts **all four** consoles, so failing to restart it is a suite-wide outage,
not an app-level one. Three real holes, all fixed 2026-11-07:

1. **The Stop/Start pair sat inside the main `try` with no `finally`.** An
   exception, an `exit`, or an early `return` from the rollback skipped the
   Start. (LogVault's rollback had exactly that shape: `return $false` on an
   un-revertable source, several lines above its own Start call.) The Start now
   runs from the script-level `finally`, and is idempotent — it returns at once
   unless THIS run stopped the service.
2. **The start's exit code was discarded, and nothing downstream could
   notice.** `Wait-Healthy` probes this app's API on `127.0.0.1`, which sits
   BEHIND the front door and answers whether or not it is up — so a terminator
   that failed to start still printed "health check passed", wrote
   `success:true` and exited 0 with every public port dead. The start now waits
   for `Running` and probes the PUBLIC port.
3. **The stop slept 2 seconds instead of waiting for `Stopped`.** The cutover
   sets `AppStopMethodConsole 15000` on that service deliberately, because it
   drains every live socket (upgraded WebSockets included) before exiting — so
   at t+2s it is routinely still `STOP_PENDING`, this app's own `sc stop` is
   then refused with **1051**, and the `npm install`/build that follows rewrites
   `node_modules` underneath a live process.

⛔ Only a parse gate on **PowerShell 5.1** can validate these scripts, and a
parse gate cannot catch an undefined function — check that every `Write-*`
helper a new line calls is actually defined in that same file.

### A leftover `.lastgood` snapshot can be the only path back

Each updater deletes any existing `.lastgood` directory before snapshotting the
live install, on the reasoning that it is debris from an interrupted run. It is
not always: if a PRIOR run failed **and its own rollback also failed**, that
snapshot is the last intact copy of a working install — and the next attempt
deleted all of it before snapshotting its own, already-broken tree.

All four updaters now refuse in that case, using the heuristic DDIVault's had
from the start: `last-update-status.json` recording `success:false` AND
`rolledBack:false` is exactly the "ROLLBACK ALSO FAILED" state. They restart the
services and the TLS front door first, so aborting does not also leave the app
down on top of the bad state being reported.

## ⛔ A link ON a tint panel cannot keep the colour it had on the card (1.35.2)

`HUB_LINK` in `SmtpSettings.tsx` used `var(--blue)`, which is correct on `--bg-card` and
fails on the `--tint-info`/`--tint-warn` washes the transport panel moved onto. Measured
in-browser against this stylesheet: **`--blue` 3.03:1** and **`--primary` 2.66:1** on the dark
warn tint, against the 4.5:1 body-text floor. The link now takes `color: inherit` — the panel's
own matched `--tint-*-fg` (8.89:1 info / 10.86:1 warn dark, 6.16 / 4.84 light) — and is marked
by **weight + underline** rather than hue.

This is the `--canvas-light` trap from the other direction: there, page-themed chrome was
dropped onto a permanently light canvas; here, a card-themed colour was dropped onto a tint.
**Same rule both ways — a colour is only correct against the background it was chosen for.**
Found by the SpanVault port, which hit it first and measured it; LogVault had the same defect.

⛔ The tempting "fix" later is to reach for a brand colour again so the link "looks like a
link". It will fail the same way. On a tinted surface, carry the affordance with weight and an
underline.

## ⛔ MAC vendor lookup: longest prefix first, or the richer feed makes it WORSE (1.36.0)

IEEE assigns MAC blocks at **three** lengths — MA-L /24 (40,497), MA-M /28 (6,688),
MA-S /36 (7,281) — and **443 blocks belong to "IEEE Registration Authority" itself**,
with **13,841** real assignments underneath them. `lookupMac` therefore tries **9, then
7, then 6** hex characters and stops at the first hit.

⛔ **THE OLD FAILURE AND THE NEW RISK ARE DIFFERENT FAILURES, AND THE DIFFERENCE IS THE
WHOLE POINT.** The old `data/oui.json` was built from Wireshark's `manuf`, which carries
**none** of the 442 registrar /24 rows (measured: 0 of 442 present), and `update-oui.js`
discarded every /28 and /36 row outright — `// skip /28, /36 longer assignments —
ambiguous for a 3-octet lookup`. So those 13,841 devices resolved to **"Unknown"**. A
miss: visibly nothing, and it invites a look.

The hub's feed **does** carry all 443. Reading it 24 bits at a time would turn every one
of those misses into a **confident wrong answer** — `001BC5000` is Converging Systems
Inc. and a /24 lookup reports "IEEE Registration Authority", which reads as a vendor and
gets believed. **Adopting a better catalogue with the old lookup would have been a
regression.** `is_registry_block` is checked on whatever row matched, at any length: 442
of those rows are /24 but **`70B3D59F3` is a /36**, so "registry blocks are /24" is false.

⛔ **FOUR IEEE OUTCOMES, FOUR STRINGS, PLUS A FIFTH THAT IS ABOUT US.** `known` /
`private` / `registry_block` / `unassigned`, and `unreadable`. They are not shades of
one answer: **"Private" is IEEE's own recorded value** (217 rows) meaning the assignee
asked to be withheld, so no amount of searching produces a name; **unassigned** on a live
device is itself a signal (randomised or spoofed MAC); a **registry block** means the
real owner is one of the longer blocks beneath, and the prefix travels in the label
because it is the evidence. Collapsing them into "Unknown" — which is what the old code
did — loses the only actionable one.

⛔ **"WE COULD NOT READ THE CATALOGUE" IS NOT A PROPERTY OF THE DEVICE.** If both the
synced feed and the bundled seed are unreadable, `risk_level` is **`unknown`**, never
`high`. Rating it as an unidentified vendor would re-rate the entire estate upward at
once — thousands of identical findings produced by our own outage, with no bad device
anywhere. For the same reason the catalogue never loads as an **empty** table: that would
answer every MAC "unassigned", which is a claim about what IEEE has issued that we have
no basis for.

⛔ **A SHORT READ PARSES PERFECTLY.** A download truncated at a row boundary is still
valid JSON and yields a catalogue that is merely *smaller* — every lookup past the cut
reads as a quiet network full of unknown devices rather than as a failure. Both the
loader and the fetch assert `entries.length === row_count`. (This is not hypothetical:
building the fixture for this feature, an IEEE CSV arrived truncated at 2,277,116 of
3,875,121 bytes and produced a plausible 37,847-row catalogue.)

⛔ **THE CACHE CANNOT LIVE IN THE REPO.** `Update-DDIVault.ps1` runs `git clean -fd` with
only `.env.local`, `node_modules` and `*.lastgood` excluded, so **every other untracked
file is deleted on every deploy**. The synced catalogue lives at
`C:\ProgramData\NocVault\ddivault\oui-feed.json` (override: `DDIVAULT_OUI_CACHE`), beside
the agent TLS pins and `secrets.env`. `data/oui-seed.json` is the committed floor — a new
install resolves vendors before it has ever reached the network, and an install that can
never reach the hub keeps working.

⛔ **THE COMMITTED SEED SHIPS WITH ITS DETACHED SIGNATURE** (`data/oui-seed.json.sig`) and
`tests/oui.test.js` re-verifies it on every run. 54,466 rows is far past what anyone
reviews in a diff, so "it looked fine" is not available as a check. Regenerate **both**
with `node scripts/build-oui-seed.js`; editing the JSON by hand fails the suite.

⛔ **`match_version` IS A COMPATIBILITY GATE, NOT A LABEL.** The hub publishes it so a
consumer can tell the ALGORITHM no longer matches the data. A mismatch **refuses** the
feed and falls back to the seed rather than "mostly working", because running fixed
[9,7,6] steps against a feed built for different ones produces wrong vendors silently.
If it ever bumps, `api/ouiLookup.js` must be updated in the same change.

⛔ **THE SYNC RUNS IN THE API PROCESS; THE COLLECTOR IS A DIFFERENT PROCESS.** Both read
the same cache file, so the loader re-`stat`s it at most once a minute and reloads on an
mtime change. Without that the collector — the component doing the actual scanning —
would hold its start-up catalogue for as long as it runs, which is weeks, and a refresh
would appear to have no effect on exactly the thing that matters.

⛔ **THE FEED IS UNLICENSED ON PURPOSE AND THE 401 WAS REAL.** It shipped metered by the
hub's `CVE_FEED_KEYS` and the first thing the suite's own apps got from it was a 401;
the hub ungated it (`ab9d77e`) because "the consumer was never a paying customer". A key
is sent only if `NOCVAULT_EOL_LICENSE_KEY` is set, so re-gating upstream needs no change
here. ⛔ Do not go hunting for a key: there isn't one, and the response header
`X-Feed-License: not-required` is the authority on that, not any code that mentions
licences.

⛔ **MEASURED ON THE REAL ESTATE, THE WIN IS CORRECTED NAMES — NOT MORE DEVICES.**
Verified against production after the 1.36.0 deploy (2026-11-16), over the 2,467 distinct
MACs DHCP has actually seen: **1,513 named by the new catalogue and 1,513 by the old
file — identical coverage. 0 newly identified, 0 registry-block wrong answers prevented,
1,513 vendor strings corrected** (the core router reads `Hewlett Packard Enterprise`, not
`HP`). The 954 unresolved are *correct*: 953 are locally-administered randomised MACs,
which have no IEEE owner by definition, and one is a 36-character string that is not a
MAC. So the catalogue-wide figures — 15,293 newly resolvable prefixes, 13,841 shadowed
assignments — are properties of the **feed**, not of this network, and quoting them as
deployment impact overstates it. The longest-prefix and registry-block machinery did not
fire once here. **It is still a precondition, not an optimisation:** it is what makes the
richer feed safe to adopt the day a /28 or /36 device does appear. Keep both facts
together — the safety argument is load-bearing, the impact claim is not.

## ⛔ Linux / third-party DNS: protocol-first, and what that costs (1.37.0)

DDIVault can now collect a **BIND 9** or **PowerDNS** server. The obvious design — SSH in
and parse `named.conf` — was rejected. Records come from **AXFR**, serials from **SOA
queries**, both vendor-neutral; a vendor channel is used only for what the protocol cannot
express (BIND's statistics-channel, PowerDNS's REST API). The customer grants one thing
(`allow-transfer { key "ddivault"; };`) and no shell account, no root and no agent lands on
their DNS server.

⛔ **THE COST IS HONEST GAPS, AND THEY MUST STAY HONEST.** Anything that lives only in
`named.conf` — forwarders, most of all — is reported `not_available`, **not** `not_applicable`
and never as an empty list. BIND absolutely has forwarders; we simply decline to read them.
Rendering "no forwarders" would be a statement about the customer's configuration that we
have no basis for. `scavenging` / `ad_integration` / `stale_records` ARE `not_applicable` —
BIND and PowerDNS have no such concept, and showing "Scavenging: Disabled" on a BIND server
invites an engineer to go and enable a feature that does not exist. Four answers, four
renderings: see `collector/dns/capabilities.js`.

⛔ **`dns-packet` HAS NO TSIG SUPPORT, AND LOOKS LIKE IT DOES.** `dnsPacket.record('TSIG')`
returns a codec, so a quick check reads as "supported". It is the generic opaque-rdata
fallback that `record()` returns for **any** unknown type — the object is identical to the
one for a made-up type name. TSIG is implemented in `collector/dns/wire.js` to RFC 8945.

⛔ **DO NOT LOCATE THE TSIG RR BY SCANNING BACKWARDS FOR SOMETHING THAT PARSES.** The first
implementation did, and it is subtly wrong: a key name's terminating `0` byte is itself a
valid (root) name and sits LATER in the buffer than the name's real first byte, so the scan
matches the root interpretation first and returns a TSIG whose key name is `""`. Every other
field decodes correctly, so it survives a smoke test and surfaces only as the server
rejecting a signature you believe you computed over the right key. Locate it structurally:
the TSIG is the last additional, and its encoded length is exactly name + 10 + rdlength.

⛔ **SIGNING THE REQUEST ONLY AUTHENTICATES US TO THE SERVER.** Responses are verified too
(first envelope chains over the request MAC; later ones over the previous MAC with
timers-only variables), or anything on the path could hand us a fabricated zone that we
would write into `dns_records` as fact.

⛔ **THE SOA GATE IS NOT AN OPTIMISATION.** Production holds **339 zones / 256,951 records**.
Transferring every zone every cycle moves hundreds of MB to learn that nothing changed, and
spends the customer's DNS server to do it. A zone's serial must change when its contents do,
so `sync.js` compares against the stored `dns_zones.soa_serial` and transfers only what moved.

⛔ **BIND REPORTS FOUR ZONES THAT ARE NOT ZONES.** `authors.bind`, `hostname.bind`,
`version.bind` and `id.server` are builtin CHAOS pseudo-zones on every BIND server — a
2-zone server lists 6. Unfiltered, each BIND server grows four phantom zones that then fail
to transfer on every cycle.

⛔ **AN RRSET IS NOT A RECORD.** PowerDNS's API returns one rrset per (name, type) with an
array of contents, so three A records on one host arrive as ONE rrset. Writing rrsets
through under-counts every round-robin host in the estate. Both fixtures carry a
two-address `web` for exactly this.

⛔ **`dns_platform` DEFAULTS TO 'windows' AND THAT DEFAULT IS LOAD-BEARING.** Every row that
existed before this feature is a Windows DNS server; a NULL or a different default would
route live production servers down the new path on the first cycle after an upgrade. An
unrecognised value is rejected with 400 rather than defaulted — falling back to 'windows'
would poll a Linux host over WinRM forever and report the auth errors as a network fault.

⛔ **WINDOWS DNS STAYS ON POWERSHELL.** It speaks AXFR, so folding it in would look like a
tidy unification — and would silently drop scavenging, aging and AD-integration, which only
the cmdlets expose. `providerFor('windows')` returns null on purpose.

## ⛔ An empty secret means UNCHANGED, not "clear it" (1.37.0)

`ServersTab` initialises every secret field to `''` and PUTs the **whole form** on save, so
editing a description submits `ps_password: ''`. The pre-existing route handled this with
`if (ps_password && ps_password !== '<mask>')`; the rewrite nearly lost it. Reading `''` as an
explicit clear would silently destroy the stored WinRM credential — and now the TSIG secret
and PowerDNS API key — of any server whose description someone tidied up, with no error, and
discovered only at the next poll. There is deliberately **no** clear-the-secret path: the UI
offers none, so adding one to the API would make destruction reachable without making it
visible. The rule lives in `api/serverFields.js` with a test, precisely because it fails
silently.

## ⛔ The DNS test lab, and the tool that lies about it

`tests/dnslab/lab.sh up` starts BIND 9 and PowerDNS in rootless podman; `tests/dnsProviders.test.js`
and `tests/dnsSync.test.js` **skip** (never fail) without it, the same "could not measure here"
rule the PowerShell checks follow.

⛔ **Port 5354/5355, not 53.** Rootless podman cannot bind below
`net.ipv4.ip_unprivileged_port_start` (1024), and on a dev box 53 is already held by
systemd-resolved and a bridge dnsmasq. This is why `dns_port` is configurable — a hardcoded
53 would make the feature untestable AND reject legitimate split-horizon deployments.

⛔ **BIND's zone directory must be WRITABLE** or RFC 2136 updates fail `SERVFAIL` — it needs
to write its journal. That looks exactly like a protocol problem and is not.

⛔ **WINDOWS `nslookup` FAKES A NETWORK FAULT ON A NON-53 PORT.** It reported
"DNS request timed out" three times and `Server: UnKnown` while a raw UDP query from the same
box, same port, same second returned `rcode=0` with a valid answer — it reverse-resolves the
server first and misbehaves off 53. Chasing it cost several rounds of blaming the firewall
and podman, both innocent. Diagnose with a raw query or the app's own client.

⛔ **A retry loop with no delay is not a wait.** A refused connection returns instantly, so
`for i in 1..30; do probe; done` burns every attempt in milliseconds and reports a server
"not ready" that had simply not finished booting. This bit twice. `lab.sh` paces with
`dig +timeout=1 +tries=1`.

⛔ **THE TWO PROVIDERS MUST SPELL A RECORD THE SAME WAY, NOT JUST SHAPE IT THE SAME
(1.37.1).** AXFR yields parsed values (`ns1.lab.example`, `v=spf1 -all`); PowerDNS's API
yields zone-file text (`ns1.pdns.example.`, `"v=spf1 -all"`). The original unit test
compared `Object.keys()` — the row *shape* — which matched, so it passed while the values
differed. `dns_records`' unique key includes `record_data`, so two spellings of one record
**duplicate instead of colliding**, and a zone migrated from BIND to PowerDNS silently
doubles. `records.js` `normalisePresentation()` now canonicalises the API path, and the
fixtures are deliberate MIRRORS of each other (same records, same values, only the zone
name differs) so the parity assertion means something. **This was caught by the staging
run, not by the unit tests** — which is the argument for doing the staging run.

⛔ **PowerDNS takes SRV and MX priority from the `prio` COLUMN, not from `content`.** A
seed row with the priority in both (`'10 20 5060 target'` + `prio=10`) makes pdns throw
`trailing data was not parsed` and **500 the whole zone endpoint** — the zone list still
works, so it looks like a provider bug rather than bad fixture data. Content carries
`weight port target` for SRV and just the exchange for MX.

## ⛔ A Linux DNS server was scored by whether it answers WinRM (fixed 1.38.0)

`haMonitor.pollHealth()` starts every server at 100 and subtracts 50 when
`testWinRM` fails. A BIND or PowerDNS host has no WinRM and never will, so a server
whose zones and records we were **successfully transferring** scored 50 and rendered
DEGRADED — and OFFLINE outright once anyone pressed Test Connection, because that
writes `winrm_test_ok=false` and `dnsServerStatus()` treats that as decisive
(`if (winrmOk === false) return 'offline'`).

Three products, three weeks, the same mistake: judging a thing by a measurement that
does not apply to it (MAC vendors, AP "offline vs gone", and now this). **The fix is
never to soften the threshold — it is to measure what health means for THIS thing.**
`collector/dns/health.js` scores on the DNS protocol: does it answer a SOA for a zone
we know it serves, how fast, is the management channel still up, did the last
collection error, are its zones replication-lagged.

⛔ **`winrm_ok` IS WRITTEN AS NULL FOR THESE SERVERS, NOT false.** NULL is "we never
asked"; false is a fault report about a question that does not apply — and the UI
treats false as decisive. Same rule in the Test Connection route: it does not touch
`winrm_test_ok` for a protocol platform.

⛔ **PROBE A ZONE WE KNOW THE SERVER SERVES, NOT ITS OWN HOSTNAME.** A BIND server
authoritative for `example.com` has no reason to resolve its own A record and usually
has recursion off, so a generic lookup reports a perfectly healthy server as dead.
And a server with NO zones yet is not penalised — that means "not collected yet", not
"sick", and scoring it down would make every newly added server look unhealthy on its
first cycle.

⛔ **THE POWERSHELL DNS PASSES MUST BE FILTERED, NOT JUST THE SYNC.** 1.37.0 routed
`syncDns` by platform and stopped there. `dnsMonitor.runDnsMonitor`,
`detectStaleRecords` and `haMonitor.pollDnsSoa` had **zero** platform awareness and
kept driving `Get-DnsServer*` at Linux hosts — roughly eight WinRM calls per server
per 20-minute cycle, each waiting out `PS_TIMEOUT_MS`, every one guaranteed to fail.
Fixing one caller is not fixing the class; grep for every pass that iterates
`getActiveServers()`.

## ⛔ "Test Connection" was a WinRM test for every platform (fixed 1.38.0)

It is the first button anyone presses after adding a server, and on a Linux DNS server
it failed AND wrote `winrm_test_ok=false` — one click from a correctly configured BIND
server looking broken.

⛔ **A BOOLEAN IS NOT A USEFUL ANSWER FOR THESE.** Windows has one thing to check.
BIND needs three configured by hand in `named.conf`: the service reachable, a
statistics-channel we may query, and `allow-transfer` keyed to a TSIG secret matching
ours. Any one missing has a different fix, so `collector/dns/readiness.js` returns a
per-check breakdown where each failure carries **the literal configuration that fixes
it**. The aim is that the person adding the server can finish without reading our docs.

⛔ **THE SUMMARY REPORTS THE FIRST FAILURE, NOT A COUNT.** The checks are
dependency-ordered — the statistics channel cannot be reached if the host is
unreachable — so "3 checks failed" is one problem reported three times.

⛔ **TSIG ERROR CODES ARE TRANSLATED.** "TSIG error 16" sends the operator to a search
engine at exactly the moment this check exists to help them. 16 is a wrong *secret*,
17 is a wrong key *name* — two different one-line fixes.

## ⛔ dns_query_stats was READ by two places and WRITTEN by nothing (1.38.0)

`GET /api/dns/query-stats` and the DNS report both select from it; production held
**zero rows**. The panel has always been empty — for Windows too. `collector/dns/stats.js`
now populates it for the protocol platforms.

⛔ **BIND AND POWERDNS REPORT TOTALS SINCE BOOT, NOT RATES**, while the table's columns
describe an interval. Stored raw, a server up for a year reads as impossibly busy and
the number only ever climbs. Each sample is a delta against the previous raw reading,
which is why `cumulative_*` columns sit beside the interval ones.

⛔ **A COUNTER THAT WENT DOWN IS A RESTART, NOT NEGATIVE TRAFFIC.** `12 - 1500` is
`-1488`; clamping it to 0 claims no traffic, and taking 12 as the interval is a
different lie. That row's interval columns are NULL — the interval across a restart
genuinely cannot be computed — and the new baseline is stored so the next sample
recovers normally.

⛔ **WINDOWS STILL HAS NO QUERY STATS, DELIBERATELY.** `powershellRunner.getDnsQueryStats()`
exists and nothing calls it. Wiring it means writing untested code into the
production-critical Windows path, and there is no Windows DNS server available to test
against (staging is Windows 11 **Home**, which cannot run the DNS Server role). Left as
a known gap rather than shipped unverified.

## ⛔ Knot and NSD do not need their own providers (1.39.0)

Verified against real daemons, not documentation. Knot 3.6.2 collects **with zero code
changes**: AXFR refused without a key (NOTAUTH), 12 records transferred with TSIG and the
response verified, SOA probe clean, a wrong key rejected as BADSIG — and the normalised
rows are byte-identical to BIND's (there is a test asserting exactly that, because a
spelling that matched across only two implementations could be coincidence).

What they lack is a remote way to **enumerate** zones. BIND has its statistics-channel and
PowerDNS its REST API; Knot's control interface is a **UNIX socket** (`knotc -s <path>`)
and NSD's needs `nsd-control` over TLS with client certificates. Requiring shell access on
a customer's DNS server is the dependency this whole design exists to avoid.

So there is one `generic` platform, and the operator supplies the zone list
(`ddi_servers.dns_zone_list`). That covers Knot, NSD, appliances and managed services —
a better answer than a vendor list that is always one name out of date.

⛔ **A CONFIGURED ZONE THAT DOES NOT ANSWER IS NAMED, NOT DROPPED.** Silently omitting it
is indistinguishable from the operator never having typed it, and a typo in that very
field is the likeliest cause. `listZones` throws with `isPartial` + `partial`, and
`sync.js` collects what answered while reporting what did not — one typo must not cost the
other fifty zones.

⛔ **`getQueryStats()` THROWS RATHER THAN RETURNING ZEROES.** There is no vendor-neutral
counter interface, and a zeroed sample written into `dns_query_stats` renders as "this
server served no queries" — a measurement never made. The capability matrix says
`query_stats: not_available`.

⛔ **`zone_type` IS not_available HERE, NOT GUESSED.** Primary vs Secondary is not
discoverable over the protocol. Every zone we can transfer is one the server answers
authoritatively for, which is what the rest of the app means by Primary — but claiming to
*know* the distinction would be a guess dressed as a fact.

## ⛔ `podman rm -f a b c` removes NOTHING if one name is absent

`lab.sh down()` reported "lab down" over a lab that was still running: podman validates
every name first and aborts the whole command when one container does not exist, and the
`|| true` turned that into apparent success. Fixed with `--ignore`. General shape: a
cleanup that swallows its own failure will eventually report success over a mess.
