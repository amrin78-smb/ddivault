# DDIVault Gotchas — non-obvious behaviours a new session would get wrong

## Security history (fixed, but the pattern can recur — check for it elsewhere)
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
