'use strict';

/**
 * server.js — DDIVault REST API
 * Port: 3007 (internal, localhost only — frontend proxies /api/* here)
 *
 * CRITICAL: This is plain JavaScript. NO TypeScript syntax allowed.
 * No "as string", no ": string[]", no type annotations.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const { execSync } = require('child_process');
const path = require('path');

// App version — single source of truth is the root package.json.
const { version } = require('../package.json');
// Raw GitHub base for remote version checks (no auth, public repo).
const GH_RAW = 'https://raw.githubusercontent.com/amrin78-smb/ddivault/main';

// Structured release notes keyed by version. When bumping the version, add a new
// entry here with 3-5 bullets describing what changed. There is no CHANGELOG.md —
// release notes live here and are surfaced by the update-status endpoint.
const releaseNotes = {
  '1.15.6': [
    'Fixed the "Go to Settings" link in the update-available banner — it now switches to Settings in-app instead of doing a full page reload, and opens the Updates section directly',
    'The reload was the bug: it re-loaded the session from scratch, and the role-based tab guard bounced you back to the Dashboard before your admin role finished loading. The in-app switch avoids that race entirely',
  ],
  '1.15.5': [
    'The schema re-apply now self-heals the NocVault Hub cross-DB read grant: schema.sql re-grants SELECT (and USAGE on schema public) to the shared nocvault_readonly role on every updater run, so tables added by future releases or created at runtime stay visible to the Hub',
    'Adds ALTER DEFAULT PRIVILEGES FOR ROLE ddivault_user so any table ddivault_user creates later is auto-readable by nocvault_readonly — no more invisible-to-Hub tables after an upgrade',
    'Role-guarded and SELECT-only: the whole block no-ops on a standalone DDIVault with no Hub role, and never grants more than SELECT. Installer and tester parity is handled in the suite installer (GrantNocRoRead) and smoke tester separately',
  ],
  '1.15.4': [
    'The updater now self-heals table ownership before applying schema migrations: on fresh installs the tables were owned by postgres while migrations run as ddivault_user, so the updater now reassigns ownership of all public tables, sequences, views, and functions to ddivault_user (as the postgres superuser) first',
    'Fixes silent "must be owner" migration skips on freshly-installed boxes, where CREATE OR REPLACE TRIGGER/FUNCTION and ALTER TABLE/CREATE INDEX statements failed without error and migrations never landed',
    'Self-heal is idempotent and non-fatal: it reads POSTGRES_PASSWORD from .env.local and soft-skips with a warning on pre-existing installs where that value is absent. No schema or data changes',
  ],
  '1.15.3': [
    'Security: upgraded Next.js to 14.2.35, the patched release addressing the December 2025 Next.js security advisory. No functional or UI changes',
  ],
  '1.15.2': [
    'The full-screen license lock now covers every route, including the SSO landing — the lock is hoisted to the root layout so no entry path can bypass it',
    'License changes are reflected in the UI within ~5 minutes: the frontend re-checks the license status every 5 minutes to match the backend cache TTL',
    'A 402 (license-disabled) response from any API call now immediately surfaces the lock instead of waiting for the next poll',
  ],
  '1.15.1': [
    'License changes now take effect within ~5 minutes instead of up to 24 hours: the hub-license cache TTL was cut from 24h to 5m, so a reduced or removed entitlement blocks the app promptly',
    'Verified the full-screen license lock hard-blocks every entry path: when a license is disabled or DDIVault is not entitled, the lock screen fully replaces the app on both the main page and the SSO landing (no app left usable behind a banner)',
    'Enforcement-only change — no database, schema, or data changes',
  ],
  '1.15.0': [
    'Per-app license entitlement: DDIVault now honors the modules list on a NocVault license key — if an active key explicitly lists its entitled apps and DDIVault is not among them, the app locks to a clear "not included in this license" screen',
    'Fail-open by design: trial keys, licenses in their grace period, an unreachable hub, and legacy keys with no modules list all keep full access, so no existing install is ever bricked by this check',
    'The license-disabled screen now distinguishes "not licensed for this app" from "license expired", pointing you to your NocVault representative instead of a renewal prompt',
    'Access-control only — no database, schema, or data changes',
  ],
  '1.14.1': [
    'Fixed the notification bell that never cleared: it now counts only open alerts (acknowledged=FALSE AND resolved_at IS NULL), matching the Events page "Open" tab, instead of including alerts the collector had already auto-resolved',
    'The collector now marks auto-resolved alerts as acknowledged (by "system"), so cleared conditions no longer pile up unacknowledged behind the bell',
    'The bell now refreshes instantly when you acknowledge alerts on the Events page, instead of lagging up to 30s for the next poll',
    'One-time backfill drains ~686 historical resolved-but-unacknowledged alerts so the bell reflects the true open count',
  ],
  '1.14.0': [
    'New Anomaly Root Causes card on the Operations Center dashboard: grouped anomalies with an expandable per-entity drill-down and one-click bulk-acknowledge per root cause',
    'Per-entity anomaly drill-down now ranks severity correctly (critical over warning over info) instead of alphabetically, so a critical entity no longer mislabels as a lower severity',
    'Fixed the nightly anomaly/baseline job timezone mismatch: the 02:00 hour gate and the once-per-day guard now both use local time, so the job runs in the intended quiet window instead of ~07:00 local and can no longer double-run on first start',
  ],
  '1.13.0': [
    'Anomaly console root-cause rollup — anomalies are now grouped by type and affected entity (e.g. "10 zones: DNS scavenging disabled") instead of thousands of repeated rows, with expandable drill-down to the underlying items',
    'Bulk-acknowledge a whole anomaly group in one click, so a single root cause can be cleared at once',
    'Fixed the nightly DNS stale-record snapshot (and baseline build) silently skipping days: the 02:00 job gate could be missed when the collector tick drifted past the hour — it now runs on the first tick at or after 02:00, with clearer run logging',
  ],
  '1.12.20': [
    'Fixed sticky table headers bleeding through when scrolling: thead now uses an opaque background instead of the semi-transparent dark-mode tint',
    'Rows no longer garble/overlap the column headers while scrolling, most visibly in dark mode',
  ],
  '1.12.19': [
    'Added the missing dark-mode override for the teal badge (.badge-teal) so it matches its sibling badges',
  ],
  '1.12.18': [
    'Fixed dark-mode dropdowns: native <select> option popups now render dark instead of a light/white list via color-scheme (light in :root, dark in dark theme)',
    'Added base select/option theming so option text stays readable in both themes',
    'Verified custom dropdown/menu panels (header avatar + alerts, global search) use adaptive surface tokens',
  ],
  '1.12.17': [
    'Added the suite-standard purple tint token (--tint-purple) for cross-app parity',
    'Purple badges (site/scan/import tags) now adapt to dark mode instead of staying a fixed light surface',
  ],
  '1.12.16': [
    'Dark-mode polish: adaptive surface and semantic tint tokens replace hardcoded light backgrounds across the app',
    'Fixed invisible dropdown/menu hover states in the header (alerts, NocVault Hub, theme toggle, sign out)',
    'Info, success, warning and error boxes (IPAM import, DNS, error banners, read-only notice) now adapt to dark mode',
    'Global search selected row and idle-timeout dialog now use theme-aware surfaces',
  ],
  '1.12.15': [
    'Fixed unreadable text on the selected DNS server/zone in dark mode',
    'Selected/active rows now use a dark-adapting brand tint instead of a near-white highlight',
  ],
  '1.12.14': [
    'Update-available and license banners now appear within the content area instead of above the top bar — matching the rest of the NocVault suite',
  ],
  '1.12.13': [
    'Suite-standard colored nav icon chips in the sidebar (only the active item is colored)',
    'Header avatar is now a circular 34px badge on solid primary',
    'Replaced the emoji dark-mode toggle with matched SVG sun/moon icons',
    'Sidebar collapse state is now remembered across sessions',
  ],
  '1.2.0': [
    'Enterprise dashboard with health score and charts',
    'Animated login page redesign',
    'Server status monitoring',
    'Automatic versioning across suite',
  ],
  '1.2.1': [
    'More reliable auto-reload after applying an update',
    'Extended the update recovery window so slower builds finish cleanly',
    'Cleaner update screen with structured release notes',
    'Removed the legacy CHANGELOG file',
  ],
  '1.2.2': [
    'Fixed DNS records duplicating on every collection cycle',
    'Added a unique constraint and upsert so records refresh in place',
    'One-time cleanup removes existing duplicate DNS records on deploy',
    'DNS records list now shows a correct Last Updated value',
  ],
  '1.3.0': [
    'More accurate DHCP capacity forecasts using daily peak utilization',
    'Anomalous days (collector outages, just-added scopes) excluded from the trend',
    'Requires 7+ days of data before forecasting — shows a dash until then',
    'Flat scopes now read Stable instead of an alarmist exhaustion date',
    'Forecasts weight the most recent 14 days of growth',
  ],
  '1.4.0': [
    'DNS zone list hides noisy forwarder zones by default, with a one-click toggle',
    'Forward and Reverse zone groups are now collapsible',
    'New zone type filter pills (All / Primary / Secondary / Forwarder)',
    'Sort zones by records, name, or last updated — defaults to busiest first',
    'Prominent colored record-count badges and more compact zone rows',
  ],
  '1.4.1': [
    'DHCP scopes with no dynamic pool now show a gray "Empty" badge instead of red "Full"',
    'Empty scopes display a dash for forecast — no exhaustion projection without a pool',
    'Empty scopes are no longer counted toward Critical or Warning scope KPIs',
    'Collector marks pool-less scopes as "empty" instead of trusting the Windows state',
  ],
  '1.5.0': [
    'Create DNS Zone now supports Forwarder (conditional forwarder) zones',
    'New "Forward to (DNS server IPs)" field for comma-separated upstream resolvers',
    'Forwarder zones are created via Add-DnsServerConditionalForwarderZone over WinRM',
  ],
  '1.6.0': [
    'IPAM "Sync from DHCP" now populates IP addresses from existing DHCP leases',
    'Subnets show live hosts immediately — no manual scan required to see addresses',
    'Active leases map to "dhcp" status; prior leases map to "offline"',
    'Hostname, MAC, and device fingerprint carry over from leases into IPAM',
    'Address sync runs on every collector poll and on the manual sync button',
  ],
  '1.7.0': [
    'Redesigned IPAM page with an enterprise layout — 6 KPI tiles (incl. Used/Free IP utilization)',
    'New IP Address Utilization donut and a Utilization Over Time chart (Daily/Weekly)',
    'Top Subnets by Utilization panel and a search / supernet / status filter bar',
    'Tree view is now a full table — Type, IP Range, Status (Healthy/Warning/Critical), Last Scanned, and a ··· actions menu',
    'Hourly IPAM utilization snapshots recorded for trend history; VLANs tab marked Coming Soon',
  ],
  '1.7.1': [
    'IPAM donut now shows the Used/Free legend beside the chart instead of below',
    'Compact middle row — smaller donut and trend chart, tighter card padding',
    'Middle row height capped so the dashboard reads in one glance',
  ],
  '1.8.0': [
    'Sub-tab bars (DHCP, DNS, Events & Alerts, Settings) now stay sticky while scrolling',
    'Single-line compact page headers — title and subtitle on one row',
    'Shorter sub-tab pills (32px) and tighter page header padding across all pages',
    'Compact KPI tiles everywhere — smaller numbers/labels and reduced height',
    'Tighter section spacing on every page for more content above the fold',
  ],
  '1.9.0': [
    'New DNS Insights sub-tab combines the old Intelligence and Analytics views into one compact dashboard',
    'KPI strip (Avg Health, Query Success Rate, Total Queries 24h, Active Servers, Zones In Sync, Open Alerts)',
    'Forwarder health, record-type distribution, security anomalies, DNS hygiene, scavenging, query rate, and top zones on one screen',
    'Inline forwarder Test and scavenging Enable actions; stale-record bulk cleanup via the Manage console',
    'Locked placeholders for Top Queried Domains and Zone Growth Trend (require future DNS query-log collection)',
  ],
  '1.10.0': [
    'Operations Center redesigned as a triage-first enterprise dashboard',
    'New Command Bar: global time range (24h/7d/30d), live/pause, manual refresh, and a collector heartbeat',
    'New Priority Action Center — one ranked queue merging critical scopes, exhaustion forecasts, open alerts, security anomalies, replication/forwarder issues, and failover health',
    'New four-pillar scorecards (DHCP/DNS/IPAM/Security) with trend sparklines, infrastructure health trends + HA/failover, DNS query analytics, and a unified activity feed',
    'New read APIs: /api/dashboard/collector-status, /api/dashboard/pillars, /api/infrastructure/health-history',
  ],
  '1.10.1': [
    'Operations Center reordered — KPI tiles and pillar scorecards now sit at the top as the at-a-glance overview',
    'Priority Action Center demoted below the overview and made collapsible (state remembered)',
    'It auto-expands only when critical items exist, otherwise stays a one-line severity summary — less scrolling on a calm day',
  ],
  '1.11.0': [
    'Alerts now auto-resolve when the condition clears (e.g. a scope drops back below threshold) instead of piling up until acknowledged',
    'Scope alerts use hysteresis (fire 90/clear 85, fire 80/clear 75) and one-open-alert-per-condition dedup — no more flapping or hourly re-fires',
    'New Info severity tier; noisy behavioral rules (after-hours device, subnet jumping, unknown device) demoted to Info and off by default; lease-spike, MAC-spoofing, subnet-jump, starvation, stale/record-drop thresholds retuned to cut false positives',
    'Alerts page defaults to Open, adds a Resolved view, and Info-tier items are kept out of the Priority Action Center so managers see only meaningful alerts',
    'Capacity forecast alerts require high confidence and a 30-day horizon; hourly digest emails are now retried on send failure instead of being silently dropped',
  ],
  '1.12.0': [
    'Server health, DHCP failover, and DNS replication-lag alerts now auto-resolve when the condition clears (server recovers, failover returns to normal, zone catches up)',
    'These alerts use one-open-alert-per-condition dedup instead of an hourly re-fire window — no more repeats while an issue persists',
    'Documented the schema deploy order for alert auto-resolve (resolved_at columns) in the upgrade runbook',
  ],
  '1.12.1': [
    'Removed the standalone Intelligence tab — its anomaly insights now surface directly in the Dashboard (Security Overview, Pillar Scorecards, Priority Action Center) and the DNS Insights view',
    'Anomaly detection continues running in the background collector and feeds alerts as before — no monitoring capability was removed',
    'Security cards and anomaly items on the Dashboard now link to Events & Alerts instead of the retired tab',
  ],
  '1.12.2': [
    'Compacted the Dashboard DHCP / DNS / IPAM / Security scorecards — about a third shorter',
    'Score number and its sub-metrics now sit side by side instead of stacked',
    'Trend sparkline moved to a faint area fill behind the score, removing its own row',
  ],
  '1.12.3': [
    'Fixed the Infrastructure & Redundancy card intermittently showing "No servers" on first load',
    'Added a dhcp_leases(server_id) index so per-server lease counts no longer scan the whole table',
    'The card now keeps its data on a transient fetch hiccup and retries instead of flashing empty',
  ],
  '1.12.4': [
    'Standardized Settings page styling to match NocVault suite',
    'Settings sub-tabs now use the shared underline tab style',
    'Section headers and form inputs aligned to the suite spec',
  ],
  '1.12.5': [
    'Standardized Settings menu (dissolved System; added Updates and About tabs; Notifications→Email Alerts)',
    'Data Retention moved into the General tab',
    'System Updates now lives in its own Updates tab (with the update-available indicator)',
    'System Information and About combined under a new About tab',
  ],
  '1.12.6': [
    'Removed Branding section from Settings (no longer needed)',
  ],
  '1.12.7': [
    'Standardized the Updates and About tabs to the NocVault suite spec',
    'Updates tab renamed to "Software Updates" with unified restart/license wording',
    'About tab now shows the standard product/tech-specs table (removed live API/DB status badges)',
    'Removed the Security tab — user management lives in the NocVault hub (Integrations)',
  ],
  '1.12.8': [
    'About tab rows now use the same left-aligned two-column layout as the other suite apps',
  ],
  '1.12.9': [
    'Removed the redundant Appearance/theme card from Settings (dark mode toggle lives in the top bar)',
  ],
  '1.12.10': [
    'Tightened card and panel corners for a cleaner operations-console look',
    'Dialed elevation back to a subtle border-plus-shadow style, removing heavy floating drop shadows',
    'Standardized control corners (buttons, inputs, dropdowns, search) to a crisp 6px radius',
    'Calibrated the UI toward an enterprise network-operations console while keeping the modern aesthetic',
  ],
  '1.12.11': [
    'Standardized typography on a shared 7-step type scale (--text-xs through --text-2xl)',
    'Snapped all ad-hoc font sizes across the app onto the scale for consistent, predictable text',
    'Unified every monospace font to a single --font-mono token',
    'Replaced hardcoded colors that duplicated theme tokens, fixing several dark-mode rendering issues',
    'Aligned the design tokens with the NocVault suite-wide standard shared across all apps',
  ],
  '1.12.12': [
    'Fixed KPI/stat values that were unreadable in dark mode (navy text on dark cards)',
    'Top Subnets list now scrolls within its panel instead of clipping long lists',
  ],
  'default': [
    'Bug fixes and performance improvements',
  ],
};

// ── Crash resilience ─────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const app  = express();
const PORT = parseInt(process.env.DDI_API_PORT || '3007');

// ── Database ─────────────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DDI_DB_NAME || 'ddivault',
  user:     process.env.DDI_DB_USER || 'ddivault_user',
  password: process.env.DDI_DB_PASS || '',
  max: 10,
  idleTimeoutMillis: 30000,
});

db.on('error', (err) => console.error('[DB] Pool error:', err.message));

// ── Enterprise modules ────────────────────────────────────────
const { auditContext } = require('./middleware/audit');
const { generateKey, maskedDisplay } = require('./middleware/apiAuth');
const { requireWrite, requireSuperAdmin, attachSiteFilter } = require('./middleware/rbac');
const { createReportsRouter } = require('./reports');
const { createV1Router } = require('./v1');
const { getLicense, getLicenseState } = require('./licenseCheck');
const emailer = require('./emailer');
const alertDispatcher = require('./alertDispatcher');

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: 'http://localhost:3006', exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'] }));
app.use(express.json());

// Audit context — attaches req.audit() + auto-fallback for mutating routes
app.use(auditContext(db));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Input validation helpers ──────────────────────────────────
function safeInt(val, def, max) {
  const n = parseInt(val || def);
  if (isNaN(n) || n <= 0) return def;
  return max ? Math.min(n, max) : n;
}

function safeHours(val, max) {
  return safeInt(val, 24, max || 720);
}

function safePage(val) {
  return safeInt(val, 1);
}

function safeLimit(val) {
  return safeInt(val, 50, 500);
}

// ── License enforcement ───────────────────────────────────────
async function enforceLicense(req, res, next) {
  const license = await getLicense();
  const state   = getLicenseState(license);
  req.licenseState = state;
  req.license      = license;

  // Block writes during grace/disabled (except acknowledge endpoints)
  if (!state.canWrite && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const isAck = req.method === 'POST'
      && (req.path.startsWith('/api/alerts') || req.path.startsWith('/api/anomalies'))
      && (req.path.includes('acknowledge') || req.path.includes('/ack'));
    if (!isAck) {
      return res.status(402).json({
        error: 'License expired — write operations disabled',
        license_status: license?.status,
        days_remaining: license?.daysRemaining,
        renew_url: `${process.env.NOCVAULT_HUB_URL || ''}/settings/license`,
      });
    }
  }

  // Block all access when fully disabled (health + license-status always allowed)
  if (state.disabled
      && !req.path.startsWith('/api/health')
      && !req.path.startsWith('/api/stats')
      && !req.path.startsWith('/api/license-status')
      && !req.path.startsWith('/api/system/update-available')) {
    return res.status(402).json({
      error: 'DDIVault license has expired. Please renew your NocVault license.',
      license_status: license?.status,
      renew_url: `${process.env.NOCVAULT_HUB_URL || ''}/settings/license`,
    });
  }
  next();
}

app.get('/api/license-status', async (req, res) => {
  const license = await getLicense();
  const state   = getLicenseState(license);
  res.json({ license, state });
});

// ── NocVault hub proxy (avoids browser CORS to the hub) ───────
app.get('/api/hub/settings', async (_req, res) => {
  const hub = (process.env.NOCVAULT_HUB_URL || 'http://localhost:3000').replace(/\/+$/, '');
  try {
    const r = await fetch(`${hub}/api/settings`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return res.status(502).json({ error: `Hub returned ${r.status}` });
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e && e.message ? e.message : 'Hub unreachable' });
  }
});

app.use(enforceLicense);

// ── Health ────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW() as ts');
    res.json({ status: 'ok', db: 'connected', time: result.rows[0].ts, version });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// ── Public Stats ──────────────────────────────────────────────
// Read-only, no-auth summary counts for external dashboards (e.g. NocVault hub
// tiles). Same public access level as /api/health: exempt from license gating
// and CORS-open to any origin. Never 500s — on any error it returns zeros with
// HTTP 200 so a polling consumer is never broken by a transient DB hiccup.
//   dns_servers   = monitored DNS servers (ddi_servers, role dns/both, active)
//   dhcp_clusters = DHCP scopes (dhcp_scopes)
//   ip_utilized   = sum of in-use IPs across all scopes (dhcp_scopes.in_use)
app.get('/api/stats', async (req, res) => {
  // Permissive CORS — this endpoint is intentionally public.
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const [dnsServers, dhcpClusters, ipUtilized] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS n FROM ddi_servers WHERE role IN ('dns','both') AND is_active = TRUE"),
      db.query('SELECT COUNT(*)::int AS n FROM dhcp_scopes'),
      db.query('SELECT COALESCE(SUM(in_use), 0)::int AS n FROM dhcp_scopes'),
    ]);
    res.json({
      dns_servers:   dnsServers.rows[0].n   || 0,
      dhcp_clusters: dhcpClusters.rows[0].n || 0,
      ip_utilized:   ipUtilized.rows[0].n   || 0,
    });
  } catch (err) {
    console.error('[API] stats error:', err.message);
    res.json({ dns_servers: 0, dhcp_clusters: 0, ip_utilized: 0 });
  }
});

// ── System Updates (self-update via Windows Task Scheduler) ───
// SYSTEM scheduled task is mandatory: spawning the updater directly from this
// Node process would kill it when NSSM stops the service mid-update. The task
// scheduler runs independently and survives the service restart.

// Short (7-char) hash of the local HEAD commit in the app root, or null if git
// is unavailable. The repo root is one level up from this api/ directory.
const APP_ROOT = path.join(__dirname, '..');
function localCommitHash() {
  try {
    return execSync('git rev-parse HEAD', { cwd: APP_ROOT })
      .toString().trim().slice(0, 7);
  } catch {
    return null;
  }
}

// Compares the local HEAD commit against the latest commit on GitHub's main
// branch. Any new commit — even one without a version bump — counts as an
// update available, so pushes that ship fixes without bumping package.json are
// never missed. Never 500s the Settings page — a fetch failure degrades to
// "up to date" with an error string.
app.get('/api/system/update-status', async (_req, res) => {
  const localVersion = version;
  const localHash = localCommitHash();
  try {
    // Cache-bust: raw.githubusercontent.com is fronted by a CDN that edge-caches
    // files for ~5min regardless of request headers (`cache: 'no-store'` only
    // touches the local HTTP cache). A unique query param forces a fresh origin
    // fetch on every call so a just-pushed version is reflected immediately.
    const bust = Date.now();
    const [commitRes, pkgRes] = await Promise.all([
      fetch('https://api.github.com/repos/amrin78-smb/ddivault/commits/main', {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store',
      }),
      fetch(`${GH_RAW}/package.json?cb=${bust}`, { cache: 'no-store' }),
    ]);
    const commit = await commitRes.json();
    const remoteHash = commit && commit.sha ? String(commit.sha).slice(0, 7) : null;
    const remotePkg = await pkgRes.json();
    const remoteVersion = remotePkg.version;

    // Release notes keyed by the latest (offered) version so "What's new in
    // v{latest}" matches its bullets. Falls back to a generic message.
    const release_notes = releaseNotes[remoteVersion] || releaseNotes['default'];

    // Any new commit = update available. If either hash is unavailable, degrade
    // to "up to date" so we never show a false update-available state.
    const updateAvail = !!remoteHash && !!localHash && remoteHash !== localHash;
    console.log('[UpdateStatus] local:', localVersion, localHash, 'remote:', remoteVersion, remoteHash, 'update:', updateAvail);
    res.json({
      current_version: localVersion,
      latest_version: remoteVersion,
      current_commit: localHash,
      latest_commit: remoteHash,
      current_hash: localHash,   // alias for the requested response shape
      latest_hash: remoteHash,   // alias
      up_to_date: !updateAvail,
      update_available: updateAvail,
      release_notes,
      release_date: new Date().toISOString().slice(0, 10),
    });
  } catch (e) {
    console.error('[update-status] version check failed:', e.message);
    res.json({ up_to_date: true, error: 'Could not check for updates' });
  }
});

// Background update check: cached so the notifier banner can poll cheaply
// without each page hitting GitHub. Refreshed on startup + every 24h.
let updateAvailable = null; // { current, latest } when an update exists, else null

async function checkForUpdates() {
  try {
    const localHash = localCommitHash();
    const [commitRes, pkgRes] = await Promise.all([
      fetch('https://api.github.com/repos/amrin78-smb/ddivault/commits/main', {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store',
      }),
      fetch(`${GH_RAW}/package.json?cb=${Date.now()}`, { cache: 'no-store' }),
    ]);
    const commit = await commitRes.json();
    const remoteHash = commit && commit.sha ? String(commit.sha).slice(0, 7) : null;
    const remotePkg = await pkgRes.json();
    const remoteVersion = remotePkg.version;

    updateAvailable = (localHash && remoteHash && remoteHash !== localHash)
      ? { current: version, latest: remoteVersion }
      : null;
  } catch {
    // never block on network failure — keep the last known state
  }
}

// Cached update availability for the notifier banner (no auth required).
app.get('/api/system/update-available', (_req, res) => {
  if (updateAvailable) {
    res.json({ available: true, current: updateAvailable.current, latest: updateAvailable.latest });
  } else {
    res.json({ available: false });
  }
});

checkForUpdates();
setInterval(checkForUpdates, 24 * 60 * 60 * 1000);

app.post('/api/system/update', async (_req, res) => {
  // Check license before allowing update
  const license = await getLicense();
  const licenseState = getLicenseState(license);

  if (licenseState.disabled) {
    return res.status(402).json({
      error: 'License expired — updates disabled. Please renew your NocVault license.',
      license_status: license?.status
    });
  }

  if (!license) {
    return res.status(402).json({
      error: 'Cannot verify license — updates disabled. Ensure NetVault hub is reachable.',
      license_status: 'unreachable'
    });
  }

  // Only allow update for active, trial, or grace period licenses
  const allowedStates = ['active', 'trial', 'grace'];
  if (!allowedStates.includes(licenseState.mode)) {
    return res.status(402).json({
      error: `License status "${licenseState.mode}" — updates not permitted.`,
      license_status: license?.status
    });
  }

  const serverIp = process.env.SERVER_IP || '';
  if (!serverIp) {
    return res.status(400).json({ error: 'SERVER_IP not configured in .env.local' });
  }
  const scriptPath = path.join(__dirname, '..', 'installer', 'Update-DDIVault.ps1').replace(/\//g, '\\');
  try {
    try { execSync('schtasks /delete /tn "DDIVaultUpdate" /f', { stdio: 'ignore' }); } catch (_e) { /* none */ }

    const taskCmd =
      `schtasks /create /tn "DDIVaultUpdate" ` +
      `/tr "powershell.exe -NonInteractive -ExecutionPolicy Bypass ` +
      `-File \\"${scriptPath}\\" -ServerIp \\"${serverIp}\\"" ` +
      `/sc once /st 00:00 /f /ru SYSTEM`;
    console.log('[Update] Running:', taskCmd);
    execSync(taskCmd, { stdio: 'pipe' });

    execSync('schtasks /run /tn "DDIVaultUpdate"', { stdio: 'pipe' });

    console.log('[Update] Task scheduled under SYSTEM, ServerIp:', serverIp);
    res.json({ started: true });
  } catch (err) {
    console.error('[Update] schtasks error:', err.message);
    res.status(500).json({ error: 'Failed to schedule update: ' + err.message });
  }
});

// ── Dashboard Stats ───────────────────────────────────────────
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [scopes, leases, zones, alerts] = await Promise.all([
      db.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE percent_used >= 90 AND total_ips > 0) as critical, COUNT(*) FILTER (WHERE percent_used >= 80 AND percent_used < 90 AND total_ips > 0) as warning FROM dhcp_scopes'),
      db.query("SELECT COUNT(*) as total FROM dhcp_leases WHERE address_state = 'Active'"),
      db.query('SELECT COUNT(*) as total FROM dns_zones'),
      db.query("SELECT COUNT(*) as total FROM alert_events WHERE acknowledged = FALSE AND resolved_at IS NULL"),
    ]);

    const scopeRow   = scopes.rows[0];
    const totalIPs   = await db.query('SELECT COALESCE(SUM(total_ips),0) as total, COALESCE(SUM(free),0) as free, COALESCE(SUM(in_use),0) as in_use FROM dhcp_scopes');
    const ipRow      = totalIPs.rows[0];

    // DNS health summary — defensive: never break the dashboard if these tables/columns are missing
    let dnsHealth = {
      zones_total: 0, servers_total: 0, servers_online: 0,
      zones_in_sync: 0, zones_out_of_sync: 0, replication_issues: 0,
    };
    try {
      const [dnsZonesTotal, dnsServers, dnsSync, dnsRepl] = await Promise.all([
        db.query('SELECT COUNT(*) AS n FROM dns_zones'),
        db.query("SELECT COUNT(*) FILTER (WHERE health_score >= 70 AND winrm_test_ok IS NOT FALSE) AS online, COUNT(*) AS total FROM ddi_servers WHERE role IN ('dns','both') AND is_active=TRUE"),
        db.query("SELECT COUNT(DISTINCT zone_name) FILTER (WHERE is_in_sync=TRUE) AS in_sync, COUNT(DISTINCT zone_name) FILTER (WHERE is_in_sync=FALSE) AS out_of_sync FROM dns_zone_sync"),
        db.query('SELECT COUNT(*) AS n FROM dns_zones WHERE replication_lag=TRUE'),
      ]);
      dnsHealth = {
        zones_total:       parseInt(dnsZonesTotal.rows[0].n) || 0,
        servers_total:     parseInt(dnsServers.rows[0].total) || 0,
        servers_online:    parseInt(dnsServers.rows[0].online) || 0,
        zones_in_sync:     parseInt(dnsSync.rows[0].in_sync) || 0,
        zones_out_of_sync: parseInt(dnsSync.rows[0].out_of_sync) || 0,
        replication_issues: parseInt(dnsRepl.rows[0].n) || 0,
      };
    } catch (e) {
      console.error('[API] dashboard/stats dns_health error:', e.message);
    }

    res.json({
      scopes: {
        total:    parseInt(scopeRow.total),
        critical: parseInt(scopeRow.critical),
        warning:  parseInt(scopeRow.warning),
      },
      ips: {
        total:  parseInt(ipRow.total),
        in_use: parseInt(ipRow.in_use),
        free:   parseInt(ipRow.free),
      },
      active_leases:    parseInt(leases.rows[0].total),
      dns_zones:        parseInt(zones.rows[0].total),
      unacked_alerts:   parseInt(alerts.rows[0].total),
      dns_health:       dnsHealth,
    });
  } catch (err) {
    console.error('[API] dashboard/stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Recent DHCP events for dashboard widget
app.get('/api/dashboard/recent-events', async (req, res) => {
  try {
    const limit = safeLimit(req.query.limit);
    const rows = await db.query(
      `SELECT e.id, e.event_id, e.event_type, e.ip_address, e.hostname,
              e.mac_address, e.description, e.event_time,
              s.hostname as server_hostname
       FROM dhcp_events e
       LEFT JOIN ddi_servers s ON s.id = e.server_id
       ORDER BY e.event_time DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] recent-events error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DHCP Scopes ───────────────────────────────────────────────
app.get('/api/scopes', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `WHERE srv.site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const rows = await db.query(
      `SELECT sc.*, srv.hostname as server_hostname, srv.ip_address as server_ip
       FROM dhcp_scopes sc
       LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       ${siteFilter}
       ORDER BY sc.percent_used DESC, sc.scope_id`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] scopes error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/scopes/:scopeId/history', async (req, res) => {
  try {
    const { scopeId } = req.params;
    const hours = safeHours(req.query.hours);

    const scope = await db.query('SELECT id FROM dhcp_scopes WHERE scope_id = $1 LIMIT 1', [scopeId]);
    if (!scope.rows.length) return res.status(404).json({ error: 'Scope not found' });

    const rows = await db.query(
      `SELECT in_use, free, percent_used, recorded_at
       FROM dhcp_scope_history
       WHERE scope_id = $1
         AND recorded_at > NOW() - make_interval(hours => $2)
       ORDER BY recorded_at ASC`,
      [scope.rows[0].id, hours]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] scope history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/scopes/:scopeId/leases', async (req, res) => {
  try {
    const { scopeId } = req.params;
    const page  = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const offset = (page - 1) * limit;

    const count = await db.query(
      'SELECT COUNT(*) as total FROM dhcp_leases WHERE scope_id = $1',
      [scopeId]
    );
    const rows = await db.query(
      `SELECT * FROM dhcp_leases
       WHERE scope_id = $1
       ORDER BY ip_address
       LIMIT $2 OFFSET $3`,
      [scopeId, limit, offset]
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] scope leases error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DHCP Scope Management (write operations) ──────────────────
// Helpers
const okCheck = r => typeof r === 'string' && r.includes('ok');
const scopeIdStr = v => v == null ? '' : (typeof v === 'object' ? String(v.IPAddressToString || v.Address || '') : String(v));

async function getScopeRow(scopeId, serverId) {
  const q = serverId
    ? await db.query('SELECT * FROM dhcp_scopes WHERE scope_id=$1 AND server_id=$2 LIMIT 1', [scopeId, parseInt(serverId)])
    : await db.query('SELECT * FROM dhcp_scopes WHERE scope_id=$1 LIMIT 1', [scopeId]);
  return q.rows[0] || null;
}

// 1. Create a DHCP scope
app.post('/api/scopes', requireWrite, async (req, res) => {
  try {
    const { server_id, name, startRange, endRange, subnetMask, description, leaseDuration, state, dnsServers, gateway, domainName } = req.body;
    if (!server_id || !name || !startRange || !endRange || !subnetMask) {
      return res.status(400).json({ error: 'server_id, name, startRange, endRange, subnetMask required' });
    }

    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const created = psWrite.createDhcpScope(ip, auth, { name, startRange, endRange, subnetMask, description, leaseDuration, state });
    if (!created) {
      return res.status(500).json({ error: 'Scope creation failed — check WinRM/DHCP role' });
    }

    let scopeId = scopeIdStr(created.ScopeId);
    if (!scopeId) scopeId = scopeIdStr(created);
    if (!scopeId) scopeId = String(startRange);

    // Apply scope options (best-effort — failures don't fail the create)
    if (dnsServers) {
      try {
        const dnsArray = String(dnsServers).split(',').map(s => s.trim()).filter(Boolean);
        if (dnsArray.length) psWrite.setDhcpScopeOption(ip, auth, scopeId, 6, dnsArray);
      } catch (e) { console.error('[API] scope option DNS error:', e.message); }
    }
    if (gateway) {
      try { psWrite.setDhcpScopeOption(ip, auth, scopeId, 3, [gateway]); }
      catch (e) { console.error('[API] scope option gateway error:', e.message); }
    }
    if (domainName) {
      try { psWrite.setDhcpScopeOption(ip, auth, scopeId, 15, [domainName]); }
      catch (e) { console.error('[API] scope option domain error:', e.message); }
    }

    const stateStr = state === 'InActive' ? 'InActive' : 'Active';
    await db.query(
      `INSERT INTO dhcp_scopes (server_id, scope_id, name, start_range, end_range, subnet_mask, state, lease_duration, total_ips, in_use, free, reserved, pending, percent_used, description, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,0,0,0,0,$9,NOW())
       ON CONFLICT (server_id, scope_id) DO UPDATE SET name=EXCLUDED.name, start_range=EXCLUDED.start_range, end_range=EXCLUDED.end_range, subnet_mask=EXCLUDED.subnet_mask, state=EXCLUDED.state, lease_duration=EXCLUDED.lease_duration, description=EXCLUDED.description, last_updated=NOW()`,
      [parseInt(server_id), scopeId, name, startRange, endRange, subnetMask, stateStr, leaseDuration || null, description || null]
    );

    if (req.audit) req.audit({ action: 'create', entity_type: 'dhcp_scope', entity_name: name, server_id: parseInt(server_id), change_summary: `Created DHCP scope ${name} (${scopeId})` });

    res.json({ success: true, data: { scope_id: scopeId, server_id: parseInt(server_id), name, start_range: startRange, end_range: endRange, subnet_mask: subnetMask, state: stateStr } });
  } catch (err) {
    console.error('[API] create scope error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Edit a DHCP scope
app.put('/api/scopes/:scopeId', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const { server_id, name, description, leaseDuration, state } = req.body;

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.editDhcpScope(ip, auth, scopeId, { name, description, leaseDuration, state });
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Scope update failed — check WinRM/DHCP role' });
    }

    const sets = [];
    const vals = [];
    if (name !== undefined)          { vals.push(name);          sets.push(`name=$${vals.length}`); }
    if (description !== undefined)    { vals.push(description);   sets.push(`description=$${vals.length}`); }
    if (leaseDuration !== undefined) { vals.push(leaseDuration); sets.push(`lease_duration=$${vals.length}`); }
    if (state !== undefined)         { vals.push(state);         sets.push(`state=$${vals.length}`); }
    if (sets.length) {
      sets.push('last_updated=NOW()');
      vals.push(scopeRow.id);
      await db.query(`UPDATE dhcp_scopes SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    }

    if (req.audit) req.audit({ action: 'modify', entity_type: 'dhcp_scope', entity_name: name || scopeRow.name, server_id: scopeRow.server_id, change_summary: `Edited DHCP scope ${scopeId}` });

    res.json({ success: true });
  } catch (err) {
    console.error('[API] edit scope error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Set scope state (Active / InActive)
app.patch('/api/scopes/:scopeId/state', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const { state, server_id } = req.body;
    if (state !== 'Active' && state !== 'InActive') {
      return res.status(400).json({ error: "state must be 'Active' or 'InActive'" });
    }

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.setScopeState(ip, auth, scopeId, state);
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Scope state change failed — check WinRM/DHCP role' });
    }

    await db.query('UPDATE dhcp_scopes SET state=$1, last_updated=NOW() WHERE id=$2', [state, scopeRow.id]);

    if (req.audit) req.audit({ action: 'modify', entity_type: 'dhcp_scope', entity_name: scopeRow.name, server_id: scopeRow.server_id, change_summary: `Set DHCP scope ${scopeId} state to ${state}` });

    res.json({ success: true, state });
  } catch (err) {
    console.error('[API] scope state error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Delete a DHCP scope
app.delete('/api/scopes/:scopeId', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const server_id = req.body.server_id || req.query.server_id;

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.deleteDhcpScope(ip, auth, scopeId);
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Scope deletion failed — check WinRM/DHCP role' });
    }

    await db.query('DELETE FROM dhcp_leases WHERE server_id=$1 AND scope_id=$2', [scopeRow.server_id, scopeId]);
    await db.query('DELETE FROM dhcp_scopes WHERE id=$1', [scopeRow.id]);

    if (req.audit) req.audit({ action: 'delete', entity_type: 'dhcp_scope', entity_name: scopeRow.name, server_id: scopeRow.server_id, change_summary: `Deleted DHCP scope ${scopeId}` });

    res.json({ success: true });
  } catch (err) {
    console.error('[API] delete scope error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Get scope options (read)
app.get('/api/scopes/:scopeId/options', async (req, res) => {
  try {
    const { scopeId } = req.params;
    const scopeRow = await getScopeRow(scopeId, req.query.server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const opts = psWrite.getDhcpScopeOptions(ip, auth, scopeId);
    res.json({ data: Array.isArray(opts) ? opts : (opts ? [opts] : []) });
  } catch (err) {
    console.error('[API] scope options get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. Set a scope option
app.post('/api/scopes/:scopeId/options', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const { optionId, values, server_id } = req.body;
    if (optionId === undefined || optionId === null || isNaN(parseInt(optionId))) {
      return res.status(400).json({ error: 'optionId (number) required' });
    }
    if (!Array.isArray(values) || values.length === 0) {
      return res.status(400).json({ error: 'values must be a non-empty array' });
    }

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.setDhcpScopeOption(ip, auth, scopeId, parseInt(optionId), values);
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Setting scope option failed — check WinRM/DHCP role' });
    }

    if (req.audit) req.audit({ action: 'modify', entity_type: 'dhcp_scope', entity_name: scopeRow.name, server_id: scopeRow.server_id, change_summary: `Set option ${optionId} on DHCP scope ${scopeId}` });

    res.json({ success: true });
  } catch (err) {
    console.error('[API] set scope option error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. Get scope exclusions (read)
app.get('/api/scopes/:scopeId/exclusions', async (req, res) => {
  try {
    const { scopeId } = req.params;
    const scopeRow = await getScopeRow(scopeId, req.query.server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const ex = psWrite.getDhcpExclusions(ip, auth, scopeId);
    res.json({ data: Array.isArray(ex) ? ex : (ex ? [ex] : []) });
  } catch (err) {
    console.error('[API] scope exclusions get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 8. Add a scope exclusion
app.post('/api/scopes/:scopeId/exclusions', requireWrite, async (req, res) => {
  try {
    const { scopeId } = req.params;
    const { startRange, endRange, server_id } = req.body;
    if (!startRange || !endRange) {
      return res.status(400).json({ error: 'startRange and endRange required' });
    }

    const scopeRow = await getScopeRow(scopeId, server_id);
    if (!scopeRow) return res.status(404).json({ error: 'Scope not found' });

    const serverData = await getServerWithAuth(scopeRow.server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    const result = psWrite.addDhcpExclusion(ip, auth, scopeId, startRange, endRange);
    if (!okCheck(result)) {
      return res.status(500).json({ error: 'Adding exclusion failed — check WinRM/DHCP role' });
    }

    if (req.audit) req.audit({ action: 'create', entity_type: 'dhcp_scope', entity_name: scopeRow.name, server_id: scopeRow.server_id, change_summary: `Added exclusion ${startRange}-${endRange} on DHCP scope ${scopeId}` });

    res.json({ success: true });
  } catch (err) {
    console.error('[API] add exclusion error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Leases ────────────────────────────────────────────────────
app.get('/api/leases', async (req, res) => {
  try {
    const page    = safePage(req.query.page);
    const limit   = safeLimit(req.query.limit);
    const offset  = (page - 1) * limit;
    const search  = (req.query.search || '').trim();
    const scopeId = (req.query.scope  || '').trim();
    const state   = (req.query.state  || '').trim();
    const deviceType = (req.query.device_type || '').trim();

    const params  = [];
    const where   = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(l.ip_address::text ILIKE $${params.length} OR l.hostname ILIKE $${params.length} OR l.mac_address ILIKE $${params.length})`);
    }
    if (scopeId) {
      params.push(scopeId);
      where.push(`l.scope_id = $${params.length}`);
    }
    if (state) {
      params.push(state);
      where.push(`l.address_state = $${params.length}`);
    }
    if (deviceType) {
      // 'unknown' also covers leases with no classification (NULL / empty).
      if (deviceType.toLowerCase() === 'unknown') {
        where.push(`(l.device_type IS NULL OR l.device_type = '' OR LOWER(l.device_type) = 'unknown')`);
      } else {
        params.push(deviceType);
        where.push(`LOWER(l.device_type) = LOWER($${params.length})`);
      }
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countParams = [...params];
    const count = await db.query(
      `SELECT COUNT(*) as total FROM dhcp_leases l ${whereClause}`,
      countParams
    );

    params.push(limit, offset);
    const rows = await db.query(
      `SELECT l.*, s.hostname as server_hostname
       FROM dhcp_leases l
       LEFT JOIN ddi_servers s ON s.id = l.server_id
       ${whereClause}
       ORDER BY l.ip_address
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] leases error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/leases/ip/:ip/history', async (req, res) => {
  try {
    const ip = req.params.ip;
    const rows = await db.query(
      `SELECT * FROM lease_history
       WHERE ip_address = $1
       ORDER BY event_time DESC
       LIMIT 200`,
      [ip]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] lease IP history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export leases as CSV
app.get('/api/leases/export', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT ip_address, hostname, mac_address, scope_id, address_state,
              lease_start, lease_expiry, last_seen
       FROM dhcp_leases
       ORDER BY ip_address`
    );

    const header = 'IP Address,Hostname,MAC Address,Scope,State,Lease Start,Lease Expiry,Last Seen\n';
    const csv = rows.rows.map(r =>
      [r.ip_address, r.hostname || '', r.mac_address || '', r.scope_id || '',
       r.address_state || '', r.lease_start || '', r.lease_expiry || '', r.last_seen || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leases.csv"');
    res.send(header + csv);
  } catch (err) {
    console.error('[API] leases export error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DHCP Events ───────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    const page      = safePage(req.query.page);
    const limit     = safeLimit(req.query.limit);
    const offset    = (page - 1) * limit;
    const hours     = safeHours(req.query.hours);
    const eventType = (req.query.type || '').trim();
    const severity  = (req.query.severity || '').trim();

    const params  = [hours];
    const where   = [`e.event_time > NOW() - make_interval(hours => $1)`];

    if (eventType) {
      params.push(eventType);
      where.push(`e.event_type = $${params.length}`);
    }
    if (severity) {
      const sevMap = {
        critical: [1020, 2019, 34],
        warning:  [1016, 15, 30],
        info:     [10, 11, 12],
      };
      const ids = sevMap[severity];
      if (ids) {
        params.push(ids);
        where.push(`e.event_id = ANY($${params.length})`);
      }
    }

    const whereClause = 'WHERE ' + where.join(' AND ');

    const countParams = [...params];
    const count = await db.query(
      `SELECT COUNT(*) as total FROM dhcp_events e ${whereClause}`,
      countParams
    );

    params.push(limit, offset);
    const rows = await db.query(
      `SELECT e.*, s.hostname as server_hostname
       FROM dhcp_events e
       LEFT JOIN ddi_servers s ON s.id = e.server_id
       ${whereClause}
       ORDER BY e.event_time DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] events error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM Subnets ──────────────────────────────────────────────
app.get('/api/subnets', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT s.*,
         (SELECT COUNT(*) FROM dhcp_leases l
          WHERE l.ip_address << (s.network || '/' || s.prefix_length)::inet) as used_ips
       FROM ipam_subnets s
       ORDER BY s.network`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] subnets error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/subnets', requireWrite, async (req, res) => {
  try {
    const { network, prefix_length, name, description, gateway, vlan_id, site, owner } = req.body;
    if (!network || !prefix_length) return res.status(400).json({ error: 'network and prefix_length required' });

    const result = await db.query(
      `INSERT INTO ipam_subnets (network, prefix_length, name, description, gateway, vlan_id, site, owner, is_managed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
       ON CONFLICT (network, prefix_length) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         gateway = EXCLUDED.gateway, vlan_id = EXCLUDED.vlan_id,
         site = EXCLUDED.site, owner = EXCLUDED.owner, updated_at = NOW()
       RETURNING *`,
      [network, parseInt(prefix_length), name || null, description || null,
       gateway || null, vlan_id ? parseInt(vlan_id) : null, site || null, owner || null]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] subnet create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/subnets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, gateway, vlan_id, site, owner } = req.body;
    const result = await db.query(
      `UPDATE ipam_subnets SET name=$1, description=$2, gateway=$3, vlan_id=$4,
              site=$5, owner=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [name || null, description || null, gateway || null,
       vlan_id ? parseInt(vlan_id) : null, site || null, owner || null, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] subnet update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/subnets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.query('DELETE FROM ipam_subnets WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] subnet delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DNS ───────────────────────────────────────────────────────
app.get('/api/dns/zones', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `WHERE s.site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const rows = await db.query(
      `SELECT z.*, s.hostname as server_hostname
       FROM dns_zones z
       LEFT JOIN ddi_servers s ON s.id = z.server_id
       ${siteFilter}
       ORDER BY z.is_reverse ASC, z.zone_name`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] dns zones error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dns/records', async (req, res) => {
  try {
    const page   = safePage(req.query.page);
    const limit  = safeLimit(req.query.limit);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const type   = (req.query.type || '').trim();
    const zoneId = req.query.zone_id;

    const params = [];
    const where  = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(r.hostname ILIKE $${params.length} OR r.record_data ILIKE $${params.length})`);
    }
    if (type) {
      params.push(type);
      where.push(`r.record_type = $${params.length}`);
    }
    if (zoneId) {
      params.push(parseInt(zoneId));
      where.push(`r.zone_id = $${params.length}`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const count = await db.query(
      `SELECT COUNT(*) as total FROM dns_records r ${whereClause}`,
      [...params]
    );

    params.push(limit, offset);
    const rows = await db.query(
      `SELECT r.*, r.last_seen as last_updated, z.zone_name
       FROM dns_records r
       JOIN dns_zones z ON z.id = r.zone_id
       ${whereClause}
       ORDER BY r.hostname, r.record_type
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows.rows, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] dns records error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dns/record-type-breakdown', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT record_type, COUNT(*)::int as count
       FROM dns_records
       GROUP BY record_type
       ORDER BY count DESC`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] dns breakdown error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Alerts ────────────────────────────────────────────────────

/**
 * buildAlertExplanation — plain-English summary of why an alert fired, parsed
 * from the alert message and enriched with the server's current health data.
 * Returns null when no specific explanation applies (the message stands alone).
 */
function buildAlertExplanation(a) {
  const msg = a.message || '';
  const host = a.server_hostname || 'the server';

  // Health score drop — "...health score dropped to 75/100 — ..."
  let m = msg.match(/health score dropped to (\d+)\/100/i);
  if (m) {
    const score = parseInt(m[1], 10);
    const parts = [`${host} is at ${score}/100, below the healthy threshold of 80.`];
    if (a.cur_winrm === false) {
      parts.push('WinRM is currently unreachable, so the server cannot be fully polled.');
    }
    if (a.cur_query_ms != null) {
      const q = Number(a.cur_query_ms);
      if (q > 1000) parts.push(`DNS query latency is ${q}ms (critical).`);
      else if (q > 500) parts.push(`DNS query latency is ${q}ms (slow).`);
    }
    if (a.cur_health != null && Number(a.cur_health) >= 80) {
      parts.push(`It has since recovered to ${Number(a.cur_health)}/100.`);
    }
    return parts.join(' ');
  }

  // DNS replication lag — "...is behind (serial X < Y)..." or "SOA serials diverge by N"
  if (/is behind \(serial/i.test(msg) || /SOA serials diverge by/i.test(msg)) {
    const rev = msg.match(/(\d+)\s+revisions?\s+behind/i);
    const revTxt = rev ? `${rev[1]} revision${rev[1] === '1' ? '' : 's'} ` : '';
    return `Changes on the primary DNS server have not yet replicated to ${host}; this zone is ${revTxt}out of date. Sustained lag usually means a replication or connectivity problem between the domain controllers.`;
  }

  // DHCP failover state change
  if (/failover/i.test(msg) && /changed state/i.test(msg)) {
    return `The DHCP failover relationship is no longer in its normal state. While degraded, lease redundancy is reduced and the partner server may be down or unreachable.`;
  }

  return null;
}

app.get('/api/alerts', async (req, res) => {
  try {
    const page   = safePage(req.query.page);
    const limit  = safeLimit(req.query.limit);
    const offset = (page - 1) * limit;
    const unackedOnly = req.query.unacked === 'true';
    const status = (req.query.status || 'all').toString();

    // Build the WHERE clause from the status filter (and legacy unacked param).
    // open     → acknowledged=FALSE AND resolved_at IS NULL
    // resolved → resolved_at IS NOT NULL
    // all      → no filter (default; preserves prior behaviour)
    const conds = [];
    if (status === 'open') {
      conds.push('ae.acknowledged = FALSE', 'ae.resolved_at IS NULL');
    } else if (status === 'resolved') {
      conds.push('ae.resolved_at IS NOT NULL');
    } else if (unackedOnly) {
      conds.push('ae.acknowledged = FALSE', 'ae.resolved_at IS NULL');
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    // Group identical alerts (same server + same alert shape) within the same
    // hour into one representative row so a storm of 384 near-identical fires
    // collapses to a single entry annotated with its occurrence count. The
    // "alert shape" is the message with all digits normalised away.
    const count = await db.query(
      `SELECT COUNT(*) AS total FROM (
         SELECT 1 FROM alert_events ae ${where}
         GROUP BY regexp_replace(ae.message, '[0-9]+', '#', 'g'),
                  ae.server_id, ae.acknowledged, date_trunc('hour', ae.fired_at)
       ) g`
    );

    const rows = await db.query(
      `WITH grouped AS (
         SELECT regexp_replace(ae.message, '[0-9]+', '#', 'g') AS norm,
                ae.server_id, ae.acknowledged,
                date_trunc('hour', ae.fired_at) AS hr,
                COUNT(*)::int        AS occurrence_count,
                MIN(ae.fired_at)     AS first_fired_at,
                MAX(ae.fired_at)     AS fired_at,
                MAX(ae.id)           AS rep_id
           FROM alert_events ae
           ${where}
           GROUP BY 1, 2, 3, 4
       )
       SELECT ae.*, g.occurrence_count, g.first_fired_at,
              ar.name AS rule_name, s.hostname AS server_hostname,
              s.health_score AS cur_health, s.query_ms AS cur_query_ms,
              s.winrm_test_ok AS cur_winrm
         FROM grouped g
         JOIN alert_events ae ON ae.id = g.rep_id
         LEFT JOIN alert_rules ar ON ar.id = ae.rule_id
         LEFT JOIN ddi_servers s ON s.id = g.server_id
        ORDER BY g.fired_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const data = rows.rows.map((a) => {
      const explanation = buildAlertExplanation(a);
      // Strip the internal enrichment columns from the response payload.
      const { cur_health, cur_query_ms, cur_winrm, ...rest } = a;
      return { ...rest, explanation };
    });

    res.json({ data, total: parseInt(count.rows[0].total), page, limit });
  } catch (err) {
    console.error('[API] alerts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alerts/:id/acknowledge', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.body.user || 'admin';
    // Acknowledge the entire group this alert represents (same server + same
    // normalised message within the same hour), so acking a grouped "fired N×"
    // row clears all of its underlying members — not just the representative.
    await db.query(
      `UPDATE alert_events tgt
          SET acknowledged = TRUE, acknowledged_by = $2, acknowledged_at = NOW()
         FROM alert_events rep
        WHERE rep.id = $1
          AND tgt.acknowledged = FALSE
          AND COALESCE(tgt.server_id, -1) = COALESCE(rep.server_id, -1)
          AND date_trunc('hour', tgt.fired_at) = date_trunc('hour', rep.fired_at)
          AND regexp_replace(tgt.message, '[0-9]+', '#', 'g')
              = regexp_replace(rep.message, '[0-9]+', '#', 'g')`,
      [id, user]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] ack alert error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alerts/acknowledge-all', requireWrite, async (req, res) => {
  try {
    const user = req.body.user || 'admin';
    const severity = req.body.severity;
    const status = (req.body.status || 'open').toString();

    // Only OPEN rows are ever ack-able (acknowledged=FALSE AND resolved_at IS NULL).
    // Optional filters let the UI ack only what it is currently viewing.
    const conds = ['acknowledged = FALSE', 'resolved_at IS NULL'];
    const params = [user];
    if (severity) {
      params.push(severity);
      conds.push(`severity = $${params.length}`);
    }
    // status is accepted for API symmetry; anything other than 'open' still only
    // affects open rows (resolved rows cannot be acknowledged).
    await db.query(
      `UPDATE alert_events SET acknowledged = TRUE, acknowledged_by = $1, acknowledged_at = NOW()
       WHERE ${conds.join(' AND ')}`,
      params
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] ack all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alert-rules', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM alert_rules ORDER BY id');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] alert rules error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/alert-rules/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { threshold_value, is_enabled } = req.body;
    await db.query(
      'UPDATE alert_rules SET threshold_value=$1, is_enabled=$2 WHERE id=$3',
      [threshold_value, is_enabled, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[API] update rule error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════
// Intelligence & Alerting
// ════════════════════════════════════════════════════════════════

// ── Feature 1: Email alerting ─────────────────────────────────
app.get('/api/smtp', requireSuperAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM smtp_config ORDER BY id LIMIT 1');
    if (!r.rows.length) return res.json({ data: null });
    const row = { ...r.rows[0] };
    row.password = row.password ? '********' : '';
    res.json({ data: row });
  } catch (err) {
    console.error('[API] smtp get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/smtp', requireSuperAdmin, async (req, res) => {
  try {
    const { host, port, secure, username, password, from_email, from_name, enabled } = req.body;
    const existing = await db.query('SELECT * FROM smtp_config ORDER BY id LIMIT 1');

    let encryptedPass;
    if (password && password !== '********') {
      encryptedPass = encryptCred(password);
    } else if (existing.rows.length) {
      encryptedPass = existing.rows[0].password; // preserve existing
    } else {
      encryptedPass = null;
    }

    if (existing.rows.length) {
      await db.query(
        `UPDATE smtp_config SET host=$1, port=$2, secure=$3, username=$4,
           password=$5, from_email=$6, from_name=$7, enabled=$8, updated_at=NOW()
         WHERE id=$9`,
        [host, port, secure, username, encryptedPass, from_email, from_name, enabled, existing.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO smtp_config (host, port, secure, username, password, from_email, from_name, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [host, port, secure, username, encryptedPass, from_email, from_name, enabled]
      );
    }
    emailer.invalidateSmtpCache();
    if (req.audit) req.audit({ action: 'modify', entity_type: 'smtp_config', entity_name: 'SMTP configuration', change_summary: 'Updated SMTP configuration' });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] smtp post error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/smtp/test', requireSuperAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    const r = await emailer.sendTestEmail(db, to);
    res.json(r);
  } catch (err) {
    console.error('[API] smtp test error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alert-recipients', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM alert_recipients ORDER BY created_at DESC');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] alert-recipients get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alert-recipients', requireWrite, async (req, res) => {
  try {
    const { email, name, role_filter, site_id, is_active } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const r = await db.query(
      `INSERT INTO alert_recipients (email, name, role_filter, site_id, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [email, name || null, role_filter || null, site_id || null, is_active !== false]
    );
    if (req.audit) req.audit({ action: 'create', entity_type: 'alert_recipient', entity_id: r.rows[0].id, entity_name: email, change_summary: `Added alert recipient ${email}` });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] alert-recipients post error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/alert-recipients/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { email, name, role_filter, site_id, is_active } = req.body;
    const r = await db.query(
      `UPDATE alert_recipients SET email=$1, name=$2, role_filter=$3, site_id=$4, is_active=$5
       WHERE id=$6 RETURNING *`,
      [email, name || null, role_filter || null, site_id || null, is_active !== false, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Recipient not found' });
    if (req.audit) req.audit({ action: 'modify', entity_type: 'alert_recipient', entity_id: id, entity_name: r.rows[0].email, change_summary: `Updated alert recipient ${r.rows[0].email}` });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] alert-recipients put error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/alert-recipients/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const prev = await db.query('SELECT email FROM alert_recipients WHERE id=$1', [id]);
    await db.query('DELETE FROM alert_recipients WHERE id=$1', [id]);
    if (req.audit) req.audit({ action: 'delete', entity_type: 'alert_recipient', entity_id: id, entity_name: prev.rows[0] ? prev.rows[0].email : String(id), change_summary: 'Removed alert recipient' });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] alert-recipients delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alert-rule-config', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM alert_rule_config ORDER BY rule_type');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] alert-rule-config get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/alert-rule-config/:type', requireSuperAdmin, async (req, res) => {
  try {
    const type = req.params.type;
    const { is_enabled, threshold_value, severity, cooldown_mins, digest_mode } = req.body;
    // Valid severities are 'critical', 'warning', 'info'. Reject anything else
    // (but allow null/undefined to pass through and keep the existing value).
    const VALID_SEVERITIES = ['critical', 'warning', 'info'];
    if (severity != null && !VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity (must be critical, warning, or info)' });
    }
    const r = await db.query(
      `UPDATE alert_rule_config
         SET is_enabled=$2, threshold_value=$3, severity=$4, cooldown_mins=$5, digest_mode=$6, updated_at=NOW()
       WHERE rule_type=$1 RETURNING *`,
      [type, is_enabled, threshold_value, severity, cooldown_mins, digest_mode]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Rule config not found' });
    if (req.audit) req.audit({ action: 'modify', entity_type: 'alert_rule_config', entity_name: type, change_summary: `Updated alert rule config ${type}` });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] alert-rule-config put error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// One-click email acknowledgement (token-guarded GET that mutates)
app.get('/api/alerts/:id/acknowledge', async (req, res) => {
  try {
    if (!emailer.verifyAckToken(req.params.id, req.query.token)) {
      return res.status(403).send('Invalid or expired link');
    }
    await db.query(
      `UPDATE alert_events SET acknowledged=TRUE, acknowledged_by='email-link', acknowledged_at=NOW()
       WHERE id=$1`,
      [parseInt(req.params.id)]
    );
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✓ Alert acknowledged</h2><p>You can close this window.</p></body></html>');
  } catch (err) {
    console.error('[API] email ack error:', err.message);
    res.status(500).send('Error acknowledging alert');
  }
});

// ── Feature 2: Forecasts ──────────────────────────────────────
app.get('/api/forecasts/scopes', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT f.*, sc.scope_id as scope_cidr, sc.name as scope_name, sc.percent_used,
              srv.hostname as server_hostname, srv.site_id
       FROM scope_forecasts f
       JOIN dhcp_scopes sc ON sc.id = f.scope_id
       LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       ORDER BY (f.days_to_full IS NULL), f.days_to_full ASC`
    );
    if (rows.rows.length === 0) {
      return res.json({ data: [], message: 'Forecasts will appear after 7 days of scope history data' });
    }
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] forecasts scopes error:', err.code, err.message);
    // 42P01 = undefined_table — schema migration not run yet
    if (err.code === '42P01') {
      return res.json({ data: [], message: 'Forecast tables not migrated yet — run scripts/schema.sql' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/forecasts/scopes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db.query(
      `SELECT f.*, sc.scope_id as scope_cidr, sc.name as scope_name, sc.percent_used,
              srv.hostname as server_hostname, srv.site_id
       FROM scope_forecasts f
       JOIN dhcp_scopes sc ON sc.id = f.scope_id
       LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       WHERE f.scope_id=$1
       ORDER BY (f.days_to_full IS NULL), f.days_to_full ASC`,
      [id]
    );
    res.json({ data: rows.rows[0] || null });
  } catch (err) {
    console.error('[API] forecast scope error:', err.code, err.message);
    if (err.code === '42P01') return res.json({ data: null, message: 'Forecast tables not migrated yet' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/forecasts/summary', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE days_to_full IS NOT NULL AND days_to_full < 14) as critical,
         COUNT(*) FILTER (WHERE days_to_full >= 14 AND days_to_full <= 30) as warning,
         COUNT(*) FILTER (WHERE days_to_full IS NULL OR days_to_full > 30) as healthy
       FROM scope_forecasts`
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] forecasts summary error:', err.code, err.message);
    if (err.code === '42P01') return res.json({ data: { critical: 0, warning: 0, healthy: 0 }, message: 'Forecast tables not migrated yet' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Feature 4: Anomalies ──────────────────────────────────────
app.get('/api/anomalies', async (req, res) => {
  try {
    const { type, severity, acknowledged, since } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const conditions = [];
    const params = [];
    if (type) { params.push(type); conditions.push(`anomaly_type = $${params.length}`); }
    if (severity) { params.push(severity); conditions.push(`severity = $${params.length}`); }
    if (acknowledged === 'true') conditions.push('acknowledged = TRUE');
    else if (acknowledged === 'false') conditions.push('acknowledged = FALSE');
    if (since) { params.push(since); conditions.push(`detected_at > NOW() - $${params.length}::interval`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const rows = await db.query(
      `SELECT * FROM anomaly_events ${where} ORDER BY detected_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] anomalies error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/anomalies/summary', async (req, res) => {
  try {
    const byType = await db.query(
      `SELECT anomaly_type, severity, COUNT(*) as count
       FROM anomaly_events
       WHERE detected_at > NOW() - INTERVAL '7 days'
       GROUP BY anomaly_type, severity`
    );
    const counts = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE detected_at > date_trunc('day', NOW())) as today,
         COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '7 days') as week
       FROM anomaly_events`
    );
    res.json({ data: { byType: byType.rows, today: parseInt(counts.rows[0].today), week: parseInt(counts.rows[0].week) } });
  } catch (err) {
    console.error('[API] anomalies summary error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Note: the original per-anomaly acknowledge routes were removed with the
// Intelligence tab (v1.12.1). The grouped/rollup acknowledge route below
// (POST /api/anomalies/group/ack) replaces them — the anomaly console now
// works on root-cause GROUPS, not individual rows. The read endpoints
// GET /api/anomalies and GET /api/anomalies/summary feed the Dashboard
// (Priority Action Center, Security Overview, Pillar Scorecards) and the
// DNS Insights view. Anomaly detection continues in the collector.

// ── Anomaly root-cause rollup (signal-to-noise) ───────────────
// The console is dominated by a handful of root causes repeated once per
// affected entity (e.g. ~9k `dns_scavenging_disabled`, one per zone). This
// groups anomalies by (anomaly_type, entity) so the UI shows ~dozens of root
// causes with a count + latest occurrence + an expandable list of the affected
// entities, instead of ~13k flat rows.
app.get('/api/anomalies/grouped', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    // Default to unacknowledged (the actionable backlog); ?acknowledged=all|true|false.
    const ack = (req.query.acknowledged || 'false').toString();
    if (ack === 'false') conditions.push('acknowledged = FALSE');
    else if (ack === 'true') conditions.push('acknowledged = TRUE');
    // 'all' → no acknowledged filter
    if (req.query.severity) { params.push(req.query.severity); conditions.push(`severity = $${params.length}`); }
    if (req.query.type) { params.push(req.query.type); conditions.push(`anomaly_type = $${params.length}`); }
    if (req.query.since) { params.push(req.query.since); conditions.push(`detected_at > NOW() - $${params.length}::interval`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Two-level rollup. Inner: one row per (anomaly_type, entity_type, entity_id)
    // with that entity's event count, latest occurrence and a sample description.
    // Outer (returned `groups`): one row per anomaly_type with total event count,
    // distinct-entity count, max severity rank and the latest occurrence. The
    // per-entity list rides along as JSON for drill-down (capped to keep payload
    // bounded — full per-event detail is still reachable via GET /api/anomalies).
    const sql = `
      WITH filtered AS (
        SELECT id, anomaly_type, severity, entity_type, entity_id, description, detected_at
          FROM anomaly_events
          ${where}
      ),
      per_entity AS (
        SELECT anomaly_type,
               entity_type,
               entity_id,
               COUNT(*)              AS event_count,
               MAX(detected_at)      AS latest_at,
               MIN(detected_at)      AS first_at,
               -- highest severity present for this entity (ranked, not alphabetical)
               (ARRAY_AGG(severity ORDER BY
                  CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2
                                WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC))[1] AS severity,
               (ARRAY_AGG(description ORDER BY detected_at DESC))[1] AS sample_description
          FROM filtered
         GROUP BY anomaly_type, entity_type, entity_id
      )
      SELECT pe.anomaly_type,
             SUM(pe.event_count)::bigint                       AS total_count,
             COUNT(*)::int                                     AS entity_count,
             MAX(pe.latest_at)                                 AS latest_at,
             MIN(pe.first_at)                                  AS first_at,
             -- highest severity present in the group (critical > warning > info)
             (ARRAY_AGG(pe.severity ORDER BY
                CASE pe.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2
                                 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC))[1] AS severity,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'entity_type', pe.entity_type,
                   'entity_id',   pe.entity_id,
                   'event_count', pe.event_count,
                   'latest_at',   pe.latest_at,
                   'severity',    pe.severity,
                   'description', pe.sample_description
                 ) ORDER BY pe.latest_at DESC
               ) FILTER (WHERE pe.entity_id IS NOT NULL OR pe.entity_type IS NOT NULL),
               '[]'::jsonb
             ) AS entities
        FROM per_entity pe
       GROUP BY pe.anomaly_type
       ORDER BY total_count DESC`;
    const rows = await db.query(sql, params);
    const groups = rows.rows.map(g => ({
      anomaly_type: g.anomaly_type,
      total_count: parseInt(g.total_count, 10),
      entity_count: g.entity_count,
      latest_at: g.latest_at,
      first_at: g.first_at,
      severity: g.severity,
      // Cap the drill-down list per group to keep the payload bounded.
      entities: Array.isArray(g.entities) ? g.entities.slice(0, 200) : [],
    }));
    res.json({ data: { groups, group_count: groups.length } });
  } catch (err) {
    console.error('[API] anomalies grouped error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk-acknowledge an entire root-cause group. Body: { anomaly_type, entity_id? }.
// With entity_id → acks just that entity within the type; without → acks the whole
// type. Ack-exempt from license write-blocking (see enforceLicense). Acks only
// currently-unacknowledged rows so the operation is idempotent and auditable.
app.post('/api/anomalies/group/ack', requireWrite, async (req, res) => {
  try {
    const anomalyType = (req.body.anomaly_type || '').toString();
    if (!anomalyType) return res.status(400).json({ error: 'anomaly_type is required' });
    const user = (req.body.user || 'admin').toString();
    const conds = ['acknowledged = FALSE', 'anomaly_type = $2'];
    const params = [user, anomalyType];
    // entity_id is optional; null/absent means "whole type". Match NULL entity_id too.
    if (req.body.entity_id !== undefined && req.body.entity_id !== null) {
      params.push(req.body.entity_id.toString());
      conds.push(`entity_id = $${params.length}`);
    }
    const r = await db.query(
      `UPDATE anomaly_events
          SET acknowledged = TRUE, acknowledged_by = $1, acknowledged_at = NOW()
        WHERE ${conds.join(' AND ')}`,
      params
    );
    res.json({ success: true, acknowledged: r.rowCount });
  } catch (err) {
    console.error('[API] anomalies group ack error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Feature 5: Site health ────────────────────────────────────
app.get('/api/site-health', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT DISTINCT ON (site_id) * FROM site_health_scores
       ORDER BY site_id, calculated_at DESC`
    );
    // Resolve real site names from NetVault (best-effort; falls back to stored name / Site <id>)
    let names = {};
    try {
      const s = await netvaultDb.query('SELECT id, name FROM sites');
      names = Object.fromEntries(s.rows.map(r => [r.id, r.name]));
    } catch (e) {
      console.error('[API] site-health name resolve failed:', e.message);
    }
    const data = rows.rows.map(r => ({
      ...r,
      site_name: names[r.site_id] || r.site_name || `Site ${r.site_id}`,
    }));
    res.json({ data });
  } catch (err) {
    console.error('[API] site-health error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/site-health/:siteId', async (req, res) => {
  try {
    const siteId = parseInt(req.params.siteId);
    const rows = await db.query(
      `SELECT * FROM site_health_scores WHERE site_id=$1 ORDER BY calculated_at DESC LIMIT 100`,
      [siteId]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] site-health history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Servers (enhanced with auth) ──────────────────────────────
app.get('/api/servers', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `WHERE site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const rows = await db.query(
      `SELECT id, hostname, ip_address::text as ip_address, role, description,
              is_active, last_polled, poll_status, poll_error,
              auth_mode, ps_username, winrm_port, winrm_https,
              winrm_test_ok, winrm_tested_at, notes, site_id,
              created_at, updated_at
       FROM ddi_servers ${siteFilter} ORDER BY created_at DESC`,
      params
    );
    // Enrich with site names from NetVault if any site_ids present
    const siteIds = [...new Set(rows.rows.map(r => r.site_id).filter(Boolean))];
    let siteMap = {};
    if (siteIds.length) {
      const sites = await netvaultDb.query(
        `SELECT id, name FROM sites WHERE id = ANY($1)`, [siteIds]
      ).catch(() => ({ rows: [] }));
      for (const s of sites.rows) siteMap[s.id] = s.name;
    }
    const data = rows.rows.map(r => ({
      ...r,
      ps_password: undefined, // never return password
      site_name: r.site_id ? siteMap[r.site_id] || null : null,
    }));
    res.json({ data });
  } catch (err) {
    console.error('[API] servers error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/servers', requireWrite, async (req, res) => {
  try {
    const {
      hostname, ip_address, role, description,
      auth_mode, ps_username, ps_password,
      winrm_port, winrm_https, notes, site_id,
    } = req.body;
    if (!hostname && !ip_address) return res.status(400).json({ error: 'hostname or ip_address required' });

    const encryptedPass = ps_password ? encryptCred(ps_password) : null;

    const result = await db.query(
      `INSERT INTO ddi_servers
         (hostname, ip_address, role, description, auth_mode, ps_username, ps_password,
          winrm_port, winrm_https, notes, site_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, hostname, ip_address::text, role, description,
                 auth_mode, ps_username, winrm_port, winrm_https, notes, site_id, is_active, created_at`,
      [
        // hostname is NOT NULL in the schema — fall back to ip_address when a
        // server is added by IP only (validation above guarantees one is present).
        hostname || ip_address || null, ip_address || null, role || 'both', description || null,
        auth_mode || 'kerberos', ps_username || null, encryptedPass,
        parseInt(winrm_port || '5985'), winrm_https === true,
        notes || null, site_id ? parseInt(site_id) : null,
      ]
    );
    if (req.audit) req.audit({ action: 'create', entity_type: 'server', entity_id: result.rows[0].id, entity_name: hostname || ip_address, server_id: result.rows[0].id, new_value: { hostname, ip_address, role, auth_mode } });

    // Fire and forget — add the new server IP to WinRM TrustedHosts so stored-credential
    // auth can connect. Don't block the response.
    const { addToTrustedHosts } = require('../collector/powershellRunner');
    setImmediate(() => addToTrustedHosts(ip_address));

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] server create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/servers/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const {
      hostname, ip_address, role, description, is_active,
      auth_mode, ps_username, ps_password,
      winrm_port, winrm_https, notes, site_id,
    } = req.body;

    // Only re-encrypt password if a new one was provided
    let encryptedPass = undefined;
    if (ps_password && ps_password !== '••••••••') {
      encryptedPass = encryptCred(ps_password);
    }

    const result = await db.query(
      `UPDATE ddi_servers SET
         hostname=$2, ip_address=$3, role=$4, description=$5,
         is_active=$6, auth_mode=$7, ps_username=$8,
         ${encryptedPass !== undefined ? 'ps_password=$9,' : ''}
         winrm_port=${encryptedPass !== undefined ? '$10' : '$9'},
         winrm_https=${encryptedPass !== undefined ? '$11' : '$10'},
         notes=${encryptedPass !== undefined ? '$12' : '$11'},
         site_id=${encryptedPass !== undefined ? '$13' : '$12'},
         updated_at=NOW()
       WHERE id=$1
       RETURNING id, hostname, ip_address::text, role, description,
                 auth_mode, ps_username, winrm_port, winrm_https,
                 winrm_test_ok, winrm_tested_at, notes, is_active, site_id`,
      encryptedPass !== undefined
        ? [id, hostname||ip_address||null, ip_address||null, role||'both', description||null,
           is_active !== false, auth_mode||'kerberos', ps_username||null,
           encryptedPass, parseInt(winrm_port||'5985'), winrm_https===true, notes||null,
           site_id ? parseInt(site_id) : null]
        : [id, hostname||ip_address||null, ip_address||null, role||'both', description||null,
           is_active !== false, auth_mode||'kerberos', ps_username||null,
           parseInt(winrm_port||'5985'), winrm_https===true, notes||null,
           site_id ? parseInt(site_id) : null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.audit) req.audit({ action: 'modify', entity_type: 'server', entity_id: id, entity_name: result.rows[0].hostname, server_id: id, new_value: { hostname, role, auth_mode, is_active: is_active !== false } });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] server update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/servers/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const prev = await db.query('SELECT hostname FROM ddi_servers WHERE id=$1', [id]);
    await db.query('DELETE FROM ddi_servers WHERE id=$1', [id]);
    if (req.audit) req.audit({ action: 'delete', entity_type: 'server', entity_id: id, entity_name: prev.rows[0] ? prev.rows[0].hostname : String(id), server_id: id });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] server delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test WinRM connection for a server
app.post('/api/servers/:id/test-connection', requireWrite, async (req, res) => {
  try {
    const id  = parseInt(req.params.id);
    const serverData = await getServerWithAuth(id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip, auth } = serverData;

    // Add to TrustedHosts before testing — ensures the test can succeed for stored creds.
    psWrite.addToTrustedHosts(ip);

    console.log(`[API] Testing WinRM connection to ${ip} (mode=${auth.auth_mode})...`);
    const result = psWrite.testWinRM(ip, auth);

    // Update test result in DB
    await db.query(
      `UPDATE ddi_servers SET winrm_test_ok=$2, winrm_tested_at=NOW(), poll_error=$3 WHERE id=$1`,
      [id, result.ok, result.error || null]
    );

    if (req.audit) req.audit({ action: 'test', entity_type: 'server', entity_id: id, entity_name: ip, server_id: id, result: result.ok ? 'success' : 'failure', error_message: result.error || null, change_summary: `WinRM test ${result.ok ? 'succeeded' : 'failed'} for ${ip}` });
    res.json({
      ok:         result.ok,
      latency_ms: result.latencyMs,
      error:      result.error,
      server_ip:  ip,
      auth_mode:  auth.auth_mode,
    });
  } catch (err) {
    console.error('[API] test connection error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Settings ─────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await db.query('SELECT key, value FROM app_settings');
    const settings = {};
    for (const r of rows.rows) settings[r.key] = r.value;
    res.json({ data: settings });
  } catch (err) {
    console.error('[API] settings error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/settings', requireSuperAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    const prev = await db.query('SELECT value FROM app_settings WHERE key=$1', [key]);
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, value || '']
    );
    if (req.audit) req.audit({ action: 'modify', entity_type: 'setting', entity_id: key, entity_name: key, old_value: prev.rows[0] ? { value: prev.rows[0].value } : null, new_value: { value: value || '' }, change_summary: `Setting "${key}" changed` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] settings update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Supernets ─────────────────────────────────────────
app.get('/api/ipam/supernets', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `WHERE s.site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const rows = await db.query(
      `SELECT s.*,
         COUNT(sub.id) as subnet_count,
         COALESCE(SUM(sub.total_hosts),0) as total_hosts,
         COALESCE(SUM(sub.used_hosts),0)  as used_hosts,
         COALESCE(SUM(sub.free_hosts),0)  as free_hosts
       FROM ipam_supernets s
       LEFT JOIN ipam_subnets sub ON sub.supernet_id = s.id
       ${siteFilter}
       GROUP BY s.id
       ORDER BY s.network`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] supernets error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/supernets', requireWrite, async (req, res) => {
  try {
    const { network, prefix_length, name, description, site, site_id } = req.body;
    if (!network || !prefix_length) return res.status(400).json({ error: 'network and prefix_length required' });
    const siteIdVal = site_id != null && site_id !== '' ? parseInt(site_id) : null;
    const result = await db.query(
      `INSERT INTO ipam_supernets (network, prefix_length, name, description, site, site_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (network, prefix_length) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, site=EXCLUDED.site,
         site_id=EXCLUDED.site_id, updated_at=NOW()
       RETURNING *`,
      [network, parseInt(prefix_length), name||null, description||null, site||null, siteIdVal]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] supernet create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/ipam/supernets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, site_id } = req.body;
    const result = await db.query(
      `UPDATE ipam_supernets SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         site_id = $4,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, name ?? null, description ?? null, site_id != null && site_id !== '' ? parseInt(site_id) : null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.audit) req.audit({ action: 'modify', entity_type: 'supernet', entity_id: id, entity_name: result.rows[0].name || String(id), new_value: { name, site_id } });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[API] supernet update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ipam/supernets/:id', requireWrite, async (req, res) => {
  try {
    await db.query('DELETE FROM ipam_supernets WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] supernet delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Subnets (enhanced) ────────────────────────────────
app.get('/api/ipam/subnets', attachSiteFilter, async (req, res) => {
  try {
    await expireStuckScans();
    const supernet_id = req.query.supernet_id;
    const params = [];
    const conds = [];
    if (supernet_id) {
      params.push(parseInt(supernet_id));
      conds.push(`s.supernet_id = $${params.length}`);
    }
    if (req.allowedSiteIds !== null) {
      params.push(req.allowedSiteIds);
      conds.push(`s.site_id = ANY($${params.length}::int[])`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await db.query(
      `SELECT s.*,
         sn.name as supernet_name,
         host(sn.network) as supernet_network,
         sn.prefix_length as supernet_prefix,
         (SELECT COUNT(*) FROM ipam_addresses a WHERE a.subnet_id = s.id) as ip_count,
         (SELECT COUNT(*) FROM ipam_addresses a WHERE a.subnet_id = s.id AND a.status = 'dhcp') as dhcp_count,
         (SELECT COUNT(*) FROM ipam_addresses a WHERE a.subnet_id = s.id AND a.status = 'unknown') as unknown_count,
         (SELECT COUNT(*) FROM ipam_addresses a WHERE a.subnet_id = s.id AND a.status = 'reserved') as reserved_count
       FROM ipam_subnets s
       LEFT JOIN ipam_supernets sn ON sn.id = s.supernet_id
       ${where}
       ORDER BY s.network`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] ipam subnets error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/subnets', requireWrite, async (req, res) => {
  try {
    const { network, prefix_length, name, description, gateway, vlan_id,
            site, site_id, owner, supernet_id, location, notes } = req.body;
    if (!network || !prefix_length) return res.status(400).json({ error: 'network and prefix_length required' });
    const totalHosts = Math.max(0, Math.pow(2, 32 - parseInt(prefix_length)) - 2);
    const siteIdVal = site_id != null && site_id !== '' ? parseInt(site_id) : null;
    const result = await db.query(
      `INSERT INTO ipam_subnets
         (network, prefix_length, name, description, gateway, vlan_id, site, owner,
          supernet_id, location, notes, site_id, is_managed, total_hosts, free_hosts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,TRUE,$12,$12)
       ON CONFLICT (network, prefix_length) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         gateway=EXCLUDED.gateway, vlan_id=EXCLUDED.vlan_id,
         site=EXCLUDED.site, owner=EXCLUDED.owner,
         supernet_id=EXCLUDED.supernet_id, location=EXCLUDED.location,
         notes=EXCLUDED.notes, site_id=EXCLUDED.site_id, updated_at=NOW()
       RETURNING *`,
      [network, parseInt(prefix_length), name||null, description||null,
       gateway||null, vlan_id?parseInt(vlan_id):null, site||null, owner||null,
       supernet_id?parseInt(supernet_id):null, location||null, notes||null, totalHosts, siteIdVal]
    );
    if (req.audit) req.audit({ action: 'create', entity_type: 'subnet', entity_id: result.rows[0].id, entity_name: `${network}/${prefix_length}`, new_value: { network, prefix_length, name, site, vlan_id } });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] ipam subnet create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/ipam/subnets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, gateway, vlan_id, site, owner, supernet_id, location, notes, site_id, is_sensitive } = req.body;
    const result = await db.query(
      `UPDATE ipam_subnets SET
         name=$2, description=$3, gateway=$4, vlan_id=$5, site=$6, owner=$7,
         supernet_id=$8, location=$9, notes=$10, site_id=$11,
         is_sensitive=COALESCE($12, is_sensitive), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id, name||null, description||null, gateway||null,
       vlan_id?parseInt(vlan_id):null, site||null, owner||null,
       supernet_id?parseInt(supernet_id):null, location||null, notes||null,
       site_id != null && site_id !== '' ? parseInt(site_id) : null,
       typeof is_sensitive === 'boolean' ? is_sensitive : null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] ipam subnet update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ipam/subnets/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const prev = await db.query('SELECT host(network) AS network, prefix_length FROM ipam_subnets WHERE id=$1', [id]);
    await db.query('DELETE FROM ipam_subnets WHERE id=$1', [id]);
    if (req.audit) req.audit({ action: 'delete', entity_type: 'subnet', entity_id: id, entity_name: prev.rows[0] ? `${prev.rows[0].network}/${prev.rows[0].prefix_length}` : String(id) });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] ipam subnet delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — IP Addresses ───────────────────────────────────────
app.get('/api/ipam/subnets/:id/addresses', attachSiteFilter, async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const status = req.query.status || '';
    const params = [id];
    let where = 'WHERE a.subnet_id = $1';
    if (status) { params.push(status); where += ` AND a.status = $${params.length}`; }
    if (req.allowedSiteIds !== null) {
      params.push(req.allowedSiteIds);
      where += ` AND EXISTS (SELECT 1 FROM ipam_subnets sn WHERE sn.id = a.subnet_id AND sn.site_id = ANY($${params.length}::int[]))`;
    }
    const rows = await db.query(
      `SELECT a.*, l.lease_expiry, l.address_state
       FROM ipam_addresses a
       LEFT JOIN dhcp_leases l ON l.id = a.dhcp_lease_id
       ${where}
       ORDER BY a.ip_address`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] ip addresses error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reserve an IP
app.post('/api/ipam/subnets/:id/addresses/:ip/reserve', requireWrite, async (req, res) => {
  try {
    const subnetId  = parseInt(req.params.id);
    const ip        = req.params.ip;
    const { description, owner, reserved_by } = req.body;
    await db.query(
      `INSERT INTO ipam_addresses
         (subnet_id, ip_address, status, description, owner, is_reserved, reserved_by, reserved_at)
       VALUES ($1,$2,'reserved',$3,$4,TRUE,$5,NOW())
       ON CONFLICT (subnet_id, ip_address) DO UPDATE SET
         status='reserved', description=EXCLUDED.description, owner=EXCLUDED.owner,
         is_reserved=TRUE, reserved_by=EXCLUDED.reserved_by, reserved_at=NOW(), updated_at=NOW()`,
      [subnetId, ip, description||null, owner||null, reserved_by||'admin']
    );
    await db.query(
      `INSERT INTO ipam_audit (ip_address, subnet_id, action, new_status, performed_by, notes)
       VALUES ($1,$2,'reserved','reserved',$3,$4)`,
      [ip, subnetId, reserved_by||'admin', description||null]
    );
    if (req.audit) req.audit({ action: 'reserve', entity_type: 'ip_address', entity_id: ip, entity_name: ip, new_value: { description, owner }, change_summary: `Reserved IP ${ip}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] reserve ip error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Release a reserved IP
app.post('/api/ipam/subnets/:id/addresses/:ip/release', requireWrite, async (req, res) => {
  try {
    const subnetId = parseInt(req.params.id);
    const ip       = req.params.ip;
    await db.query(
      `UPDATE ipam_addresses SET
         status='available', is_reserved=FALSE, reserved_by=NULL, reserved_at=NULL, updated_at=NOW()
       WHERE subnet_id=$1 AND ip_address=$2`,
      [subnetId, ip]
    );
    await db.query(
      `INSERT INTO ipam_audit (ip_address, subnet_id, action, old_status, new_status, performed_by)
       VALUES ($1,$2,'released','reserved','available','admin')`,
      [ip, subnetId]
    );
    if (req.audit) req.audit({ action: 'release', entity_type: 'ip_address', entity_id: ip, entity_name: ip, change_summary: `Released IP ${ip}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] release ip error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Scan ───────────────────────────────────────────────
const { scanAllSubnets } = require('../collector/ipamScanner');
const scanningSubnets = new Set(); // prevent concurrent scans of same subnet

// Auto-expire scans stuck in 'running'/'scanning' for >30 min (covers process
// crashes/restarts where the in-memory scanningSubnets set was lost). Runs on
// startup and on every scan-status poll so the UI never shows a permanent "Scanning".
async function expireStuckScans() {
  try {
    await db.query(`
      UPDATE ipam_scan_jobs SET status='error', error_msg='Scan timed out'
      WHERE status='running' AND started_at < NOW() - INTERVAL '30 minutes'`);
    await db.query(`
      UPDATE ipam_subnets s SET scan_status='error'
      WHERE s.scan_status='scanning'
        AND NOT EXISTS (
          SELECT 1 FROM ipam_scan_jobs j
          WHERE j.subnet_id = s.id AND j.status='running'
            AND j.started_at > NOW() - INTERVAL '30 minutes'
        )`);
  } catch (err) {
    console.error('[ScanExpiry] error:', err.message);
  }
}

app.post('/api/ipam/subnets/:id/scan', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (scanningSubnets.has(id)) {
      return res.status(409).json({ error: 'Scan already in progress for this subnet' });
    }
    const subnetRes = await db.query(
      'SELECT id, host(network) as network, prefix_length, name FROM ipam_subnets WHERE id=$1', [id]
    );
    if (!subnetRes.rows.length) return res.status(404).json({ error: 'Subnet not found' });
    const subnet = subnetRes.rows[0];

    if (req.audit) req.audit({ action: 'scan', entity_type: 'subnet', entity_id: id, entity_name: `${subnet.network}/${subnet.prefix_length}`, change_summary: `Started scan of ${subnet.network}/${subnet.prefix_length}` });
    res.json({ success: true, message: `Scan started for ${subnet.network}/${subnet.prefix_length}` });

    // Run scan in a completely separate child process — does NOT block the API
    scanningSubnets.add(id);
    const { fork } = require('child_process');
    const worker = fork(
      require('path').join(__dirname, '..', 'collector', 'scanWorker.js'),
      [String(id), subnet.network, String(subnet.prefix_length), subnet.name || ''],
      { silent: false, env: process.env }
    );
    worker.on('exit', (code) => {
      scanningSubnets.delete(id);
      console.log(`[API] Scan worker exited for subnet ${id} with code ${code}`);
    });
    worker.on('error', (err) => {
      scanningSubnets.delete(id);
      console.error(`[API] Scan worker error for subnet ${id}: ${err.message}`);
    });
  } catch (err) {
    console.error('[API] scan start error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/scan-all', requireWrite, async (req, res) => {
  try {
    res.json({ success: true, message: 'Full IPAM scan started' });
    scanAllSubnets().catch(err => console.error('[API] scan-all error:', err.message));
  } catch (err) {
    console.error('[API] scan-all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manually trigger IPAM sync from ALL DHCP scopes across all active DHCP-capable servers
app.post('/api/ipam/sync-from-dhcp', requireWrite, async (req, res) => {
  try {
    const ipamSync = require('../collector/ipamSync');
    const totals = { created: 0, updated: 0, supernetsCreated: 0, addressesSynced: 0 };
    const servers = await db.query(
      "SELECT id FROM ddi_servers WHERE is_active = TRUE AND role IN ('dhcp','both')"
    );
    for (const server of servers.rows) {
      try {
        const sd = await getServerWithAuth(server.id);
        if (!sd) continue;
        const rawScopes = psWrite.getDhcpScopes(sd.ip, sd.auth);
        const scopes = (rawScopes || []).map(s => ({
          scopeId: scopeIdStr(s.ScopeId),
          subnetMask: scopeIdStr(s.SubnetMask),
          name: s.Name || null,
        }));
        const getGateway = async (scopeId) => {
          try {
            const opts = psWrite.getDhcpScopeOptions(sd.ip, sd.auth, scopeId);
            const arr = Array.isArray(opts) ? opts : (opts ? [opts] : []);
            const o = arr.find(x => Number(x.OptionId) === 3);
            if (!o) return null;
            const v = Array.isArray(o.Value) ? o.Value[0] : o.Value;
            return scopeIdStr(v) || null;
          } catch (_) { return null; }
        };
        const r = await ipamSync.syncScopesToIpam(db, scopes, { log: (m) => console.log(m), getGateway });
        totals.created += r.created;
        totals.updated += r.updated;
        totals.supernetsCreated += r.supernetsCreated;
        totals.addressesSynced += (r.addressesSynced || 0);
      } catch (serverErr) {
        console.error(`[API] sync-from-dhcp server ${server.id} error:`, serverErr.message);
      }
    }
    if (req.audit) req.audit({
      action: 'sync',
      entity_type: 'ipam',
      entity_name: 'dhcp-sync',
      change_summary: `IPAM sync from DHCP: ${totals.created} created, ${totals.updated} updated, ${totals.addressesSynced} addresses`,
    });
    res.json({ success: true, created: totals.created, updated: totals.updated, supernetsCreated: totals.supernetsCreated, addressesSynced: totals.addressesSynced });
  } catch (err) {
    console.error('[API] sync-from-dhcp error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/ipam/subnets/:id/scan-status', async (req, res) => {
  try {
    await expireStuckScans();
    const id = parseInt(req.params.id);
    const subnet = await db.query(
      'SELECT scan_status, last_scanned, total_hosts, used_hosts, free_hosts, unknown_hosts FROM ipam_subnets WHERE id=$1',
      [id]
    );
    const lastJob = await db.query(
      `SELECT * FROM ipam_scan_jobs WHERE subnet_id=$1 ORDER BY started_at DESC LIMIT 1`, [id]
    );
    // Live IP counts from ipam_addresses
    const counts = await db.query(
      `SELECT status, COUNT(*) as count FROM ipam_addresses WHERE subnet_id=$1 GROUP BY status`, [id]
    );
    const countMap = {};
    for (const r of counts.rows) countMap[r.status] = parseInt(r.count);
    res.json({
      scanning:   scanningSubnets.has(id),
      subnet:     subnet.rows[0] || {},
      last_job:   lastJob.rows[0] || null,
      ip_counts:  countMap,
      scanned_so_far: Object.values(countMap).reduce((a, b) => a + b, 0),
    });
  } catch (err) {
    console.error('[API] scan status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Global scan status — all subnets currently scanning
app.get('/api/ipam/scan-status', async (req, res) => {
  try {
    await expireStuckScans();
    const jobsQ = await db.query(`
      SELECT
        j.subnet_id, j.status, j.hosts_scanned, j.hosts_up, j.hosts_unknown,
        j.started_at, j.error_msg, s.total_hosts,
        host(s.network) as network, s.prefix_length, s.name,
        ROUND((j.hosts_scanned::numeric / NULLIF(s.total_hosts, 0)) * 100) as progress_pct,
        EXTRACT(EPOCH FROM (NOW() - j.started_at))::int as elapsed_seconds
      FROM ipam_scan_jobs j
      JOIN ipam_subnets s ON s.id = j.subnet_id
      WHERE j.status = 'running' AND j.started_at > NOW() - INTERVAL '30 minutes'
      ORDER BY j.started_at DESC`);
    const allSubnets = await db.query(
      `SELECT id, host(network) as network, prefix_length, name, scan_status, last_scanned,
              total_hosts, used_hosts, free_hosts, unknown_hosts
       FROM ipam_subnets WHERE is_managed=TRUE ORDER BY network`
    );
    const ids = jobsQ.rows.map(r => r.subnet_id);
    res.json({
      scanning: ids,            // new: subnet ids with a live running job
      scanning_ids: ids,        // backward-compat
      active_scans: ids.length, // backward-compat
      jobs: jobsQ.rows,         // enriched: progress_pct, elapsed_seconds, network, name, totals
      subnets: allSubnets.rows,
    });
  } catch (err) {
    console.error('[API] global scan status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — VLANs ─────────────────────────────────────────────
app.get('/api/ipam/vlans', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM ipam_vlans ORDER BY vlan_id');
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] vlans error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/ipam/vlans', requireWrite, async (req, res) => {
  try {
    const { vlan_id, name, description, site } = req.body;
    if (!vlan_id) return res.status(400).json({ error: 'vlan_id required' });
    const result = await db.query(
      `INSERT INTO ipam_vlans (vlan_id, name, description, site)
       VALUES ($1,$2,$3,$4) ON CONFLICT (vlan_id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, site=EXCLUDED.site
       RETURNING *`,
      [parseInt(vlan_id), name||null, description||null, site||null]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[API] vlan create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ipam/vlans/:id', requireWrite, async (req, res) => {
  try {
    await db.query('DELETE FROM ipam_vlans WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] vlan delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — Audit ─────────────────────────────────────────────
app.get('/api/ipam/audit', async (req, res) => {
  try {
    const limit = safeLimit(req.query.limit);
    const ip    = (req.query.ip || '').trim();
    const params = [limit];
    let where = '';
    if (ip) { params.push(ip); where = `WHERE ip_address = $${params.length}`; }
    const rows = await db.query(
      `SELECT * FROM ipam_audit ${where} ORDER BY created_at DESC LIMIT $1`,
      params
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] ipam audit error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DNS Management (write operations) ────────────────────────
const psWrite = require('../collector/powershellRunner');
const { encrypt: encryptCred, decrypt: decryptCred } = require('../collector/credStore');

/**
 * Load a server row and build auth object for PS runner.
 */
async function getServerWithAuth(serverId) {
  const result = await db.query('SELECT * FROM ddi_servers WHERE id=$1', [parseInt(serverId)]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    ip:   row.ip_address,
    auth: {
      auth_mode:   row.auth_mode   || 'kerberos',
      ps_username: row.ps_username || null,
      ps_password: row.ps_password ? decryptCred(row.ps_password) : null,
      winrm_port:  row.winrm_port  || 5985,
      winrm_https: row.winrm_https || false,
    },
    row,
  };
}

// Get DNS server list from ddi_servers
app.get('/api/dns/servers', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, hostname, ip_address::text as ip_address, role, poll_status, last_polled,
              health_score, winrm_test_ok
       FROM ddi_servers WHERE role IN ('dns','both') AND is_active=TRUE ORDER BY hostname`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] dns servers error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add DNS record — runs PowerShell on the actual DNS server
app.post('/api/dns/records', requireWrite, async (req, res) => {
  try {
    const { server_id, zone_name, hostname, record_type, record_data, ttl, preference } = req.body;
    if (!server_id || !zone_name || !hostname || !record_type || !record_data) {
      return res.status(400).json({ error: 'server_id, zone_name, hostname, record_type, record_data required' });
    }

    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    const { ip: serverIp, auth } = serverData;

    let ok = false;
    const ttlSec = parseInt(ttl || '3600');

    switch (record_type.toUpperCase()) {
      case 'A':     ok = psWrite.addDnsARecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      case 'AAAA':  ok = psWrite.addDnsAaaaRecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      case 'CNAME': ok = psWrite.addDnsCNameRecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      case 'PTR':   ok = psWrite.addDnsPtrRecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      case 'MX':    ok = psWrite.addDnsMxRecord(serverIp, zone_name, hostname, record_data, parseInt(preference||'10'), ttlSec, auth); break;
      case 'TXT':   ok = psWrite.addDnsTxtRecord(serverIp, zone_name, hostname, record_data, ttlSec, auth); break;
      case 'SRV': {
        // record_data format: "priority weight port target"
        const [priority, weight, port, target] = String(record_data).trim().split(/\s+/);
        if (!target) return res.status(400).json({ error: 'SRV record_data must be "priority weight port target"' });
        ok = psWrite.addDnsSrvRecord(serverIp, zone_name, hostname, priority, weight, port, target, ttlSec, auth);
        break;
      }
      case 'NS':
        return res.status(400).json({ error: 'NS records must be managed via the DNS server console (requires domain admin delegation)' });
      default: return res.status(400).json({ error: `Unsupported record type: ${record_type}` });
    }

    if (!ok) return res.status(500).json({ error: 'PowerShell command failed — check WinRM and DNS server role' });

    // Store in our DB too
    const zoneRes = await db.query('SELECT id FROM dns_zones WHERE zone_name=$1 AND server_id=$2', [zone_name, parseInt(server_id)]);
    if (zoneRes.rows.length) {
      await db.query(
        `INSERT INTO dns_records (zone_id, hostname, record_type, record_data, ttl, last_seen)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (zone_id, hostname, record_type, record_data)
         DO UPDATE SET ttl = EXCLUDED.ttl, last_seen = NOW()`,
        [zoneRes.rows[0].id, hostname, record_type.toUpperCase(), record_data, ttlSec]
      );
    }

    if (req.audit) req.audit({ action: 'create', entity_type: 'dns_record', entity_name: `${hostname} ${record_type.toUpperCase()}`, server_id, new_value: { hostname, record_type, record_data, zone_name }, change_summary: `Added ${record_type.toUpperCase()} record ${hostname} → ${record_data}` });
    res.json({ success: true, message: `${record_type} record created: ${hostname} → ${record_data}` });
  } catch (err) {
    console.error('[API] dns add record error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete DNS record
app.delete('/api/dns/records', requireWrite, async (req, res) => {
  try {
    const { server_id, zone_name, hostname, record_type, record_data } = req.body;
    if (!server_id || !zone_name || !hostname || !record_type) {
      return res.status(400).json({ error: 'server_id, zone_name, hostname, record_type required' });
    }
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const ok = psWrite.removeDnsRecord(serverData.ip, zone_name, hostname, record_type, record_data, serverData.auth);
    if (!ok) return res.status(500).json({ error: 'PowerShell delete failed — check WinRM permissions' });

    // Remove from DB
    await db.query(
      `DELETE FROM dns_records WHERE hostname=$1 AND record_type=$2 AND record_data=$3
       AND zone_id IN (SELECT id FROM dns_zones WHERE zone_name=$4 AND server_id=$5)`,
      [hostname, record_type, record_data||'', zone_name, parseInt(server_id)]
    ).catch(() => {});

    if (req.audit) req.audit({ action: 'delete', entity_type: 'dns_record', entity_name: `${hostname} ${record_type}`, server_id, old_value: { hostname, record_type, record_data, zone_name }, change_summary: `Deleted ${record_type} record ${hostname}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] dns delete record error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add DNS zone
app.post('/api/dns/zones', requireWrite, async (req, res) => {
  try {
    const { server_id, zone_name, zone_type, replication_scope, forwarder_ips } = req.body;
    if (!server_id || !zone_name) return res.status(400).json({ error: 'server_id and zone_name required' });
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const isForwarder = String(zone_type || '').toLowerCase() === 'forwarder';
    let forwarderIps = [];
    if (isForwarder) {
      forwarderIps = String(forwarder_ips || '').split(',').map(s => s.trim()).filter(Boolean);
      if (forwarderIps.length === 0) return res.status(400).json({ error: 'forwarder_ips required for a forwarder zone' });
    }

    const ok = isForwarder
      ? psWrite.addDnsForwarderZone(serverData.ip, zone_name, forwarderIps, serverData.auth)
      : psWrite.addDnsZone(serverData.ip, zone_name, zone_type || 'Primary', replication_scope || 'Domain', serverData.auth);
    if (!ok) return res.status(500).json({ error: 'Zone creation failed — check WinRM and DNS server role' });

    await db.query(
      `INSERT INTO dns_zones (server_id, zone_name, zone_type, is_reverse, is_ds_integrated)
       VALUES ($1,$2,$3,FALSE,TRUE) ON CONFLICT (server_id, zone_name) DO NOTHING`,
      [parseInt(server_id), zone_name, zone_type || 'Primary']
    );

    if (req.audit) req.audit({ action: 'create', entity_type: 'dns_zone', entity_name: zone_name, server_id, new_value: { zone_name, zone_type: zone_type || 'Primary' }, change_summary: `Created zone ${zone_name}` });
    res.json({ success: true, message: `Zone ${zone_name} created` });
  } catch (err) {
    console.error('[API] dns add zone error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete DNS zone
app.delete('/api/dns/zones/:id', requireWrite, async (req, res) => {
  try {
    const zoneRes = await db.query(
      `SELECT z.*, s.ip_address::text as server_ip, s.auth_mode, s.ps_username,
              s.ps_password, s.winrm_port, s.winrm_https
       FROM dns_zones z JOIN ddi_servers s ON s.id = z.server_id WHERE z.id=$1`,
      [parseInt(req.params.id)]
    );
    if (!zoneRes.rows.length) return res.status(404).json({ error: 'Zone not found' });
    const zone = zoneRes.rows[0];
    const auth = {
      auth_mode: zone.auth_mode || 'kerberos',
      ps_username: zone.ps_username || null,
      ps_password: zone.ps_password ? decryptCred(zone.ps_password) : null,
      winrm_port: zone.winrm_port || 5985,
      winrm_https: zone.winrm_https || false,
    };

    const ok = psWrite.removeDnsZone(zone.server_ip, zone.zone_name, auth);
    if (!ok) return res.status(500).json({ error: 'Zone deletion failed on DNS server' });

    await db.query('DELETE FROM dns_zones WHERE id=$1', [zone.id]);
    if (req.audit) req.audit({ action: 'delete', entity_type: 'dns_zone', entity_id: zone.id, entity_name: zone.zone_name, server_id: zone.server_id, change_summary: `Deleted zone ${zone.zone_name}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] dns delete zone error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS server stats
app.get('/api/dns/stats/:serverId', async (req, res) => {
  try {
    const serverRes = await db.query('SELECT ip_address::text as ip FROM ddi_servers WHERE id=$1', [parseInt(req.params.serverId)]);
    if (!serverRes.rows.length) return res.status(404).json({ error: 'Server not found' });
    const stats = psWrite.getDnsServerStats(serverRes.rows[0].ip);
    res.json({ data: stats || {} });
  } catch (err) {
    console.error('[API] dns stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DNS Health / Topology / Sync / Forwarders / Scavenging ────

// Aggregate DNS health summary
app.get('/api/dns/health', async (req, res) => {
  try {
    const [
      zonesTotal, serversTotal, serversOnline, zonesInSync, zonesOutOfSync,
      replicationIssues, forwardersTotal, forwardersDown, staleRecords, scavengingDisabled,
    ] = await Promise.all([
      db.query('SELECT COUNT(*) AS n FROM dns_zones'),
      db.query("SELECT COUNT(*) AS n FROM ddi_servers WHERE role IN ('dns','both') AND is_active=TRUE"),
      db.query("SELECT COUNT(*) AS n FROM ddi_servers WHERE role IN ('dns','both') AND is_active=TRUE AND health_score >= 70 AND winrm_test_ok IS NOT FALSE"),
      db.query('SELECT COUNT(DISTINCT zone_name) AS n FROM dns_zone_sync WHERE is_in_sync=TRUE'),
      db.query('SELECT COUNT(DISTINCT zone_name) AS n FROM dns_zone_sync WHERE is_in_sync=FALSE'),
      db.query('SELECT COUNT(*) AS n FROM dns_zones WHERE replication_lag=TRUE'),
      db.query('SELECT COUNT(*) AS n FROM dns_forwarder_health'),
      db.query("SELECT COUNT(*) AS n FROM dns_forwarder_health WHERE is_reachable=FALSE AND last_checked > NOW() - INTERVAL '30 minutes'"),
      db.query('SELECT COUNT(*) AS n FROM dns_stale_records'),
      db.query('SELECT COUNT(*) AS n FROM dns_zones WHERE is_reverse=FALSE AND is_auto_created=FALSE AND scavenging_enabled=FALSE'),
    ]);
    res.json({
      zones_total:               parseInt(zonesTotal.rows[0].n) || 0,
      servers_total:             parseInt(serversTotal.rows[0].n) || 0,
      servers_online:            parseInt(serversOnline.rows[0].n) || 0,
      zones_in_sync:             parseInt(zonesInSync.rows[0].n) || 0,
      zones_out_of_sync:         parseInt(zonesOutOfSync.rows[0].n) || 0,
      replication_issues:        parseInt(replicationIssues.rows[0].n) || 0,
      forwarders_total:          parseInt(forwardersTotal.rows[0].n) || 0,
      forwarders_down:           parseInt(forwardersDown.rows[0].n) || 0,
      stale_records:             parseInt(staleRecords.rows[0].n) || 0,
      scavenging_disabled_zones: parseInt(scavengingDisabled.rows[0].n) || 0,
    });
  } catch (err) {
    console.error('[API] dns health error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS topology — servers with roles, zone + record counts
app.get('/api/dns/topology', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT s.id, s.hostname, host(s.ip_address) AS ip, s.role, s.health_score,
              s.query_ms, s.poll_status, s.winrm_test_ok, s.is_dns_primary, s.dns_forwarders,
              r.is_pdc_emulator, r.domain, r.replication_type,
              (SELECT COUNT(*) FROM dns_zones z WHERE z.server_id = s.id) AS zone_count,
              (SELECT COALESCE(SUM(record_count),0) FROM dns_zones z WHERE z.server_id = s.id) AS record_count
       FROM ddi_servers s
       LEFT JOIN dns_server_roles r ON r.server_id = s.id
       WHERE s.role IN ('dns','both') AND s.is_active=TRUE
       ORDER BY s.is_dns_primary DESC, s.hostname`
    );
    res.json({ servers: rows.rows });
  } catch (err) {
    console.error('[API] dns topology error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS zones SOA serial comparison matrix (all zones)
app.get('/api/dns/zones/sync', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT zs.zone_name, zs.server_id, zs.soa_serial, zs.lag_seconds,
              zs.is_in_sync, zs.checked_at, s.hostname
       FROM dns_zone_sync zs
       JOIN ddi_servers s ON s.id = zs.server_id
       ORDER BY zs.zone_name`
    );

    const serverMap = new Map();
    const zoneMap   = new Map();
    for (const row of rows.rows) {
      if (!serverMap.has(row.server_id)) {
        serverMap.set(row.server_id, { id: row.server_id, hostname: row.hostname });
      }
      let z = zoneMap.get(row.zone_name);
      if (!z) {
        z = { zone_name: row.zone_name, max_serial: 0, in_sync: true, serials: {} };
        zoneMap.set(row.zone_name, z);
      }
      const serial = parseInt(row.soa_serial) || 0;
      z.serials[row.server_id] = {
        soa_serial: row.soa_serial,
        lag_seconds: row.lag_seconds,
        checked_at: row.checked_at,
        is_in_sync: row.is_in_sync,
      };
      if (serial > z.max_serial) z.max_serial = serial;
    }
    // Compute in_sync = all serials equal per zone
    for (const z of zoneMap.values()) {
      const serials = Object.values(z.serials).map((s) => String(s.soa_serial));
      z.in_sync = new Set(serials).size <= 1;
    }

    res.json({ zones: Array.from(zoneMap.values()), servers: Array.from(serverMap.values()) });
  } catch (err) {
    console.error('[API] dns zones sync error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS sync detail for a single zone (must come after /zones/sync)
app.get('/api/dns/zones/:name/sync', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT zs.server_id, zs.soa_serial, zs.lag_seconds, zs.is_in_sync, zs.checked_at, s.hostname
       FROM dns_zone_sync zs
       JOIN ddi_servers s ON s.id = zs.server_id
       WHERE zs.zone_name=$1
       ORDER BY s.hostname`,
      [req.params.name]
    );
    let maxSerial = 0;
    const serverRows = rows.rows.map((row) => {
      const serial = parseInt(row.soa_serial) || 0;
      if (serial > maxSerial) maxSerial = serial;
      return {
        server_id:  row.server_id,
        hostname:   row.hostname,
        soa_serial: row.soa_serial,
        lag_seconds: row.lag_seconds,
        is_in_sync: row.is_in_sync,
        checked_at: row.checked_at,
      };
    });
    const inSync = new Set(serverRows.map((r) => String(r.soa_serial))).size <= 1;
    res.json({ zone_name: req.params.name, max_serial: maxSerial, in_sync: inSync, servers: serverRows });
  } catch (err) {
    console.error('[API] dns zone sync detail error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS forwarder health list
app.get('/api/dns/forwarders', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT fh.*, s.hostname, host(s.ip_address) AS server_ip
       FROM dns_forwarder_health fh
       JOIN ddi_servers s ON s.id = fh.server_id
       ORDER BY s.hostname, fh.forwarder_ip`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] dns forwarders error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS stale records (optional zone_id + min_days filters)
app.get('/api/dns/stale-records', async (req, res) => {
  try {
    const params = [];
    const where  = [];
    if (req.query.zone_id) {
      params.push(parseInt(req.query.zone_id));
      where.push(`sr.zone_id = $${params.length}`);
    }
    const minDays = parseInt(req.query.min_days) || 0;
    params.push(minDays);
    where.push(`sr.days_stale >= $${params.length}`);

    const whereClause = 'WHERE ' + where.join(' AND ');
    const rows = await db.query(
      `SELECT sr.*, z.zone_name
       FROM dns_stale_records sr
       JOIN dns_zones z ON z.id = sr.zone_id
       ${whereClause}
       ORDER BY sr.days_stale DESC
       LIMIT 1000`,
      params
    );
    res.json({ data: rows.rows, total: rows.rows.length });
  } catch (err) {
    console.error('[API] dns stale records error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS query statistics — latest + 24h history per server
app.get('/api/dns/query-stats', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT qs.server_id, qs.recorded_at, qs.total_queries, qs.successful, qs.failed,
              qs.nxdomain_count, qs.response_time_ms, qs.queries_per_sec, s.hostname
       FROM dns_query_stats qs
       JOIN ddi_servers s ON s.id = qs.server_id
       WHERE qs.recorded_at >= NOW() - INTERVAL '24 hours'
       ORDER BY qs.server_id, qs.recorded_at ASC`
    );
    if (!rows.rows.length) return res.json({ data: [] });

    const byServer = new Map();
    for (const row of rows.rows) {
      let entry = byServer.get(row.server_id);
      if (!entry) {
        entry = { server_id: row.server_id, hostname: row.hostname, latest: null, history: [] };
        byServer.set(row.server_id, entry);
      }
      const point = {
        recorded_at: row.recorded_at,
        total_queries: row.total_queries,
        successful: row.successful,
        failed: row.failed,
        nxdomain_count: row.nxdomain_count,
        response_time_ms: row.response_time_ms,
        queries_per_sec: row.queries_per_sec,
      };
      entry.history.push(point);
      entry.latest = point; // rows are ordered ascending, so last wins
    }
    res.json({ data: Array.from(byServer.values()) });
  } catch (err) {
    console.error('[API] dns query stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DNS scavenging / aging configuration per zone
app.get('/api/dns/scavenging', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT z.id, z.zone_name, z.server_id, s.hostname, z.scavenging_enabled,
              z.aging_enabled, z.last_scavenged, z.is_reverse
       FROM dns_zones z
       LEFT JOIN ddi_servers s ON s.id = z.server_id
       WHERE z.is_auto_created=FALSE
       ORDER BY z.scavenging_enabled NULLS FIRST, z.zone_name`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] dns scavenging error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test a DNS forwarder (diagnostic) — records result in dns_forwarder_health
app.post('/api/dns/forwarders/test', async (req, res) => {
  try {
    const { server_id, forwarder_ip } = req.body;
    if (!server_id || !forwarder_ip) {
      return res.status(400).json({ error: 'server_id and forwarder_ip required' });
    }
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const r = psWrite.testDnsForwarder(serverData.ip, serverData.auth, forwarder_ip);
    if (r) {
      await db.query(
        `INSERT INTO dns_forwarder_health (server_id, forwarder_ip, is_reachable, response_time_ms, last_checked)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (server_id, forwarder_ip)
         DO UPDATE SET is_reachable=EXCLUDED.is_reachable,
                       response_time_ms=EXCLUDED.response_time_ms,
                       last_checked=NOW()`,
        [parseInt(server_id), forwarder_ip, r.Reachable, r.ResponseMs]
      ).catch((e) => console.error('[API] forwarder upsert error:', e.message));
    }
    res.json({ success: true, result: r });
  } catch (err) {
    console.error('[API] dns forwarder test error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enable / disable scavenging (aging) on a zone via PowerShell
app.post('/api/dns/scavenging/enable', requireWrite, async (req, res) => {
  try {
    const { server_id, zone_name, enabled } = req.body;
    if (!server_id || !zone_name) {
      return res.status(400).json({ error: 'server_id and zone_name required' });
    }
    const en = enabled !== false;
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const ok = psWrite.setDnsZoneAging(serverData.ip, serverData.auth, zone_name, en);
    if (!ok) return res.status(500).json({ error: 'PowerShell command failed — check WinRM and DNS server role' });

    await db.query(
      `UPDATE dns_zones SET scavenging_enabled=$1, aging_enabled=$1 WHERE zone_name=$2 AND server_id=$3`,
      [en, zone_name, parseInt(server_id)]
    );

    if (req.audit) req.audit({ action: 'update', entity_type: 'dns_zone', entity_name: zone_name, server_id, change_summary: `${en ? 'Enabled' : 'Disabled'} scavenging on ${zone_name}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] dns scavenging enable error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cleanup stale DNS records via PowerShell
app.post('/api/dns/stale-records/cleanup', requireWrite, async (req, res) => {
  try {
    const { records } = req.body;
    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ error: 'records array required' });
    }

    const serverCache = new Map();
    let deleted = 0;
    let failed  = 0;

    for (const rec of records) {
      const { server_id, zone_name, hostname, record_type, record_data } = rec;
      if (!server_id || !zone_name || !hostname || !record_type) { failed++; continue; }

      let serverData = serverCache.get(server_id);
      if (serverData === undefined) {
        serverData = await getServerWithAuth(server_id);
        serverCache.set(server_id, serverData);
      }
      if (!serverData) { failed++; continue; }

      const ok = psWrite.removeDnsRecord(serverData.ip, zone_name, hostname, record_type, record_data, serverData.auth);
      if (!ok) { failed++; continue; }

      deleted++;
      await db.query(
        `DELETE FROM dns_stale_records
         WHERE zone_id IN (SELECT id FROM dns_zones WHERE zone_name=$1 AND server_id=$2)
           AND hostname=$3 AND record_type=$4`,
        [zone_name, parseInt(server_id), hostname, record_type]
      ).catch(() => {});
    }

    if (req.audit) req.audit({ action: 'delete', entity_type: 'dns_record', entity_name: 'stale-records-cleanup', change_summary: `Stale record cleanup: ${deleted} deleted, ${failed} failed` });
    res.json({ success: true, deleted, failed });
  } catch (err) {
    console.error('[API] dns stale records cleanup error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DHCP Reservation — write via PowerShell ───────────────────
app.post('/api/dhcp/reservations', requireWrite, async (req, res) => {
  try {
    const { server_id, scope_id, ip_address, mac_address, name, description } = req.body;
    if (!server_id || !scope_id || !ip_address || !mac_address) {
      return res.status(400).json({ error: 'server_id, scope_id, ip_address, mac_address required' });
    }
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const ok = psWrite.addDhcpReservation(serverData.ip, scope_id, ip_address, mac_address, name || ip_address, serverData.auth);
    if (!ok) return res.status(500).json({ error: 'DHCP reservation failed — check WinRM and DHCP server role' });

    // Update lease record to show it is now reserved
    await db.query(
      `UPDATE dhcp_leases SET address_state='Reservation', hostname=COALESCE($3, hostname)
       WHERE server_id=$1 AND ip_address=$2`,
      [parseInt(server_id), ip_address, name || null]
    ).catch(() => {});

    // Log to audit
    await db.query(
      `INSERT INTO ipam_audit (ip_address, action, new_status, hostname, mac_address, performed_by, notes)
       VALUES ($1,'reserved','reserved',$2,$3,'admin',$4)`,
      [ip_address, name||null, mac_address, description||null]
    ).catch(() => {});

    if (req.audit) req.audit({ action: 'reserve', entity_type: 'dhcp_reservation', entity_name: ip_address, server_id, new_value: { ip_address, mac_address, name }, change_summary: `Created reservation ${ip_address} → ${mac_address}` });
    res.json({ success: true, message: `Reservation created: ${ip_address} → ${mac_address}` });
  } catch (err) {
    console.error('[API] dhcp reservation error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove DHCP reservation
app.delete('/api/dhcp/reservations', requireWrite, async (req, res) => {
  try {
    const { server_id, scope_id, ip_address } = req.body;
    if (!server_id || !scope_id || !ip_address) {
      return res.status(400).json({ error: 'server_id, scope_id, ip_address required' });
    }
    const serverData = await getServerWithAuth(server_id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });

    const ok = psWrite.removeDhcpReservation(serverData.ip, scope_id, ip_address, serverData.auth);
    if (!ok) return res.status(500).json({ error: 'Removal failed on DHCP server' });

    await db.query(
      `UPDATE dhcp_leases SET address_state='Active' WHERE server_id=$1 AND ip_address=$2`,
      [parseInt(server_id), ip_address]
    ).catch(() => {});

    if (req.audit) req.audit({ action: 'release', entity_type: 'dhcp_reservation', entity_name: ip_address, server_id, change_summary: `Removed reservation ${ip_address}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] dhcp remove reservation error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all reservations for a scope
app.get('/api/dhcp/reservations/:serverId/:scopeId', async (req, res) => {
  try {
    const serverRes = await db.query('SELECT ip_address::text as ip FROM ddi_servers WHERE id=$1', [parseInt(req.params.serverId)]);
    if (!serverRes.rows.length) return res.status(404).json({ error: 'Server not found' });
    const reservations = psWrite.getDhcpReservations(serverRes.rows[0].ip, req.params.scopeId);
    res.json({ data: reservations || [] });
  } catch (err) {
    console.error('[API] dhcp reservations error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Sites (from NetVault DB) ──────────────────────────────────
const netvaultDb = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432'),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.DDI_DB_USER      || 'ddivault_user',
  password: process.env.DDI_DB_PASS      || '',
  max: 3,
  ssl: false,
});

app.get('/api/sites', async (req, res) => {
  try {
    const rows = await netvaultDb.query(
      `SELECT s.id, s.name, s.code, s.city, s.site_type, s.site_status,
              c.name as country_name
       FROM sites s
       LEFT JOIN countries c ON c.id = s.country_id
       WHERE s.site_status = 'Active'
       ORDER BY s.name`
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] sites error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — CSV/Excel Import ───────────────────────────────────
app.post('/api/ipam/import', requireWrite, async (req, res) => {
  try {
    const { rows } = req.body; // array of subnet objects from parsed CSV
    if (!rows || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'No rows provided' });
    }

    let imported = 0, skipped = 0, errors = [];

    for (const row of rows) {
      const network      = (row.network      || '').trim();
      const prefix       = parseInt(row.prefix_length || row.prefix || '24');
      const name         = (row.name         || '').trim() || null;
      const gateway      = (row.gateway      || '').trim() || null;
      const vlan_id      = row.vlan_id ? parseInt(row.vlan_id) : null;
      const site         = (row.site         || '').trim() || null;
      const description  = (row.description  || '').trim() || null;
      const owner        = (row.owner        || '').trim() || null;
      const location     = (row.location     || '').trim() || null;
      const supernetRef  = (row.supernet     || '').trim() || null;

      if (!network || isNaN(prefix)) {
        errors.push(`Row skipped — missing network or prefix: ${JSON.stringify(row)}`);
        skipped++;
        continue;
      }

      // Look up supernet if provided
      let supernet_id = null;
      if (supernetRef) {
        const [snet, spfx] = supernetRef.split('/');
        const snRes = await db.query(
          `SELECT id FROM ipam_supernets WHERE network::text = $1 AND prefix_length = $2 LIMIT 1`,
          [snet, parseInt(spfx)]
        ).catch(() => ({ rows: [] }));
        if (snRes.rows.length) supernet_id = snRes.rows[0].id;
      }

      const totalHosts = Math.max(0, Math.pow(2, 32 - prefix) - 2);

      await db.query(
        `INSERT INTO ipam_subnets
           (network, prefix_length, name, description, gateway, vlan_id, site, owner,
            supernet_id, location, is_managed, total_hosts, free_hosts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$11)
         ON CONFLICT (network, prefix_length) DO UPDATE SET
           name=COALESCE(EXCLUDED.name, ipam_subnets.name),
           description=COALESCE(EXCLUDED.description, ipam_subnets.description),
           gateway=COALESCE(EXCLUDED.gateway, ipam_subnets.gateway),
           vlan_id=COALESCE(EXCLUDED.vlan_id, ipam_subnets.vlan_id),
           site=COALESCE(EXCLUDED.site, ipam_subnets.site),
           owner=COALESCE(EXCLUDED.owner, ipam_subnets.owner),
           supernet_id=COALESCE(EXCLUDED.supernet_id, ipam_subnets.supernet_id),
           location=COALESCE(EXCLUDED.location, ipam_subnets.location),
           updated_at=NOW()`,
        [network, prefix, name, description, gateway, vlan_id, site, owner,
         supernet_id, location, totalHosts]
      );
      imported++;
    }

    if (req.audit) req.audit({ action: 'import', entity_type: 'subnet', entity_name: `${imported} subnets`, change_summary: `Imported ${imported} subnets (${skipped} skipped)`, new_value: { imported, skipped, errors: errors.length } });
    res.json({ success: true, imported, skipped, errors });
  } catch (err) {
    console.error('[API] ipam import error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ── Global Search ─────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ data: [] });

    // ── Structured query parsing (key:value) ──────────────────
    const m = q.match(/^(\w+):(.+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      const known = ['type', 'vendor', 'subnet', 'scope', 'site', 'new', 'risk', 'anomaly', 'status'];
      if (known.includes(key)) {
        try {
          let rows = [];
          if (key === 'type') {
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, device_vendor, address_state, scope_id
               FROM dhcp_leases
               WHERE device_type ILIKE $1 LIMIT 100`,
              [`%${val}%`]
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_type, x.device_vendor, x.mac_address].filter(Boolean).join(' · '),
              status: x.address_state, meta: { device_type: x.device_type, device_vendor: x.device_vendor },
            }));
          } else if (key === 'vendor') {
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, device_vendor, address_state
               FROM dhcp_leases WHERE device_vendor ILIKE $1 LIMIT 100`,
              [`%${val}%`]
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_vendor, x.device_type, x.mac_address].filter(Boolean).join(' · '),
              status: x.address_state, meta: { device_vendor: x.device_vendor },
            }));
          } else if (key === 'subnet') {
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, address_state, scope_id
               FROM dhcp_leases WHERE host(ip_address) LIKE $1 LIMIT 100`,
              [`${val}%`]
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_type, x.mac_address, 'Scope: ' + x.scope_id].filter(Boolean).join(' · '),
              status: x.address_state, meta: {},
            }));
          } else if (key === 'scope') {
            let op = '>=', numStr = val;
            if (val[0] === '>') { op = '>'; numStr = val.slice(1); }
            else if (val[0] === '<') { op = '<'; numStr = val.slice(1); }
            const num = parseFloat(numStr);
            const r = await db.query(
              `SELECT sc.scope_id, sc.name, sc.start_range::text, sc.end_range::text, sc.percent_used,
                      srv.hostname AS server_hostname
               FROM dhcp_scopes sc LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
               WHERE sc.percent_used ${op} $1 ORDER BY sc.percent_used DESC LIMIT 100`,
              [isNaN(num) ? 0 : num]
            );
            rows = r.rows.map(x => ({
              type: 'scope', title: x.scope_id,
              subtitle: [x.name, x.server_hostname, x.percent_used + '% used'].filter(Boolean).join(' · '),
              status: null, meta: { percent_used: x.percent_used },
            }));
          } else if (key === 'site') {
            const srv = await db.query(
              `SELECT hostname, ip_address::text, role FROM ddi_servers
               WHERE hostname ILIKE $1 OR site_id::text = $2 LIMIT 50`,
              [`%${val}%`, val]
            );
            for (const x of srv.rows) {
              rows.push({
                type: 'server', title: x.hostname,
                subtitle: [x.ip_address, x.role].filter(Boolean).join(' · '),
                status: null, meta: {},
              });
            }
            const sub = await db.query(
              `SELECT host(network) as network, prefix_length, name, site FROM ipam_subnets
               WHERE site ILIKE $1 LIMIT 50`,
              [`%${val}%`]
            );
            for (const x of sub.rows) {
              rows.push({
                type: 'subnet', title: x.network + '/' + x.prefix_length,
                subtitle: [x.name, x.site].filter(Boolean).join(' · '),
                status: null, meta: {},
              });
            }
            rows = rows.slice(0, 100);
          } else if (key === 'new') {
            const cutoff = val.toLowerCase() === 'today'
              ? `date_trunc('day', NOW())`
              : `NOW() - INTERVAL '7 days'`;
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, address_state, first_seen
               FROM dhcp_leases WHERE first_seen > ${cutoff} ORDER BY first_seen DESC LIMIT 100`
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_type, x.mac_address].filter(Boolean).join(' · '),
              status: x.address_state, meta: { first_seen: x.first_seen },
            }));
          } else if (key === 'risk') {
            const r = await db.query(
              `SELECT ip_address::text, hostname, mac_address, device_type, risk_level, address_state
               FROM dhcp_leases WHERE risk_level = $1 LIMIT 100`,
              [val.toLowerCase()]
            );
            rows = r.rows.map(x => ({
              type: 'lease', title: x.ip_address,
              subtitle: [x.hostname, x.device_type, x.risk_level, x.mac_address].filter(Boolean).join(' · '),
              status: x.address_state, meta: { risk_level: x.risk_level },
            }));
          } else if (key === 'anomaly') {
            const r = await db.query(
              `SELECT id, anomaly_type, severity, description, detected_at
               FROM anomaly_events WHERE detected_at > date_trunc('day', NOW())
               ORDER BY detected_at DESC LIMIT 100`
            );
            rows = r.rows.map(x => ({
              type: 'anomaly', title: x.anomaly_type,
              subtitle: [x.severity, x.description].filter(Boolean).join(' · '),
              status: x.severity, meta: { id: x.id, detected_at: x.detected_at },
            }));
          } else if (key === 'status') {
            const r = await db.query(
              `SELECT a.ip_address::text, a.hostname, a.mac_address, a.status,
                      s.name as subnet_name
               FROM ipam_addresses a
               LEFT JOIN ipam_subnets s ON s.id = a.subnet_id
               WHERE a.status = $1 LIMIT 100`,
              [val.toLowerCase()]
            );
            rows = r.rows.map(x => ({
              type: 'ip', title: x.ip_address,
              subtitle: [x.hostname, x.mac_address, x.subnet_name].filter(Boolean).join(' · '),
              status: x.status, meta: {},
            }));
          }
          return res.json({ data: rows, structured: true, query: q });
        } catch (e) {
          console.error('[API] structured search error:', e.message);
          return res.json({ data: [], structured: true, query: q });
        }
      }
    }

    const results = [];

    // Search IPAM addresses (IP, hostname, MAC)
    const ipam = await db.query(
      `SELECT
         a.ip_address::text, a.hostname, a.mac_address, a.status,
         host(s.network) as subnet, s.prefix_length, s.name as subnet_name,
         sn.name as supernet_name
       FROM ipam_addresses a
       JOIN ipam_subnets s ON s.id = a.subnet_id
       LEFT JOIN ipam_supernets sn ON sn.id = s.supernet_id
       WHERE
         a.ip_address::text ILIKE $1 OR
         a.hostname ILIKE $1 OR
         a.mac_address ILIKE $1
       LIMIT 20`,
      [`%${q}%`]
    );
    for (const r of ipam.rows) {
      results.push({
        type: 'ip',
        title: r.ip_address,
        subtitle: [r.hostname, r.mac_address, r.subnet + '/' + r.prefix_length].filter(Boolean).join(' · '),
        status: r.status,
        meta: { subnet: r.subnet, prefix: r.prefix_length, subnet_name: r.subnet_name },
      });
    }

    // Search subnets (network, name, description, site)
    const subnets = await db.query(
      `SELECT host(network) as network, prefix_length, name, description, site, gateway::text
       FROM ipam_subnets
       WHERE
         network::text ILIKE $1 OR
         name ILIKE $1 OR
         site ILIKE $1 OR
         description ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    for (const r of subnets.rows) {
      results.push({
        type: 'subnet',
        title: r.network + '/' + r.prefix_length,
        subtitle: [r.name, r.site, r.description].filter(Boolean).join(' · '),
        status: null,
        meta: { network: r.network, prefix: r.prefix_length },
      });
    }

    // Search supernets
    const supernets = await db.query(
      `SELECT host(network) as network, prefix_length, name, site
       FROM ipam_supernets
       WHERE network::text ILIKE $1 OR name ILIKE $1 OR site ILIKE $1
       LIMIT 5`,
      [`%${q}%`]
    );
    for (const r of supernets.rows) {
      results.push({
        type: 'supernet',
        title: r.network + '/' + r.prefix_length,
        subtitle: [r.name, r.site].filter(Boolean).join(' · '),
        status: null,
        meta: {},
      });
    }

    // Search DHCP scopes (scope_id like 172.24.215.0, or name like "TU-WiFi4")
    const scopes = await db.query(
      `SELECT sc.scope_id, sc.name, sc.start_range::text, sc.end_range::text,
              sc.percent_used, srv.hostname AS server_hostname
       FROM dhcp_scopes sc LEFT JOIN ddi_servers srv ON srv.id = sc.server_id
       WHERE sc.scope_id ILIKE $1 OR sc.name ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    for (const r of scopes.rows) {
      results.push({
        type: 'scope',
        title: r.scope_id,
        subtitle: [r.name, r.server_hostname, r.start_range + ' - ' + r.end_range].filter(Boolean).join(' · '),
        status: null,
        meta: { percent_used: r.percent_used },
      });
    }

    // Search DHCP leases
    const leases = await db.query(
      `SELECT ip_address::text, hostname, mac_address, address_state, scope_id
       FROM dhcp_leases
       WHERE
         ip_address::text ILIKE $1 OR
         hostname ILIKE $1 OR
         mac_address ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    for (const r of leases.rows) {
      results.push({
        type: 'lease',
        title: r.ip_address,
        subtitle: [r.hostname, r.mac_address, 'Scope: ' + r.scope_id].filter(Boolean).join(' · '),
        status: r.address_state,
        meta: {},
      });
    }

    // Search DNS records
    const dns = await db.query(
      `SELECT r.hostname, r.record_type, r.record_data, z.zone_name
       FROM dns_records r
       JOIN dns_zones z ON z.id = r.zone_id
       WHERE r.hostname ILIKE $1 OR r.record_data ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );
    for (const r of dns.rows) {
      results.push({
        type: 'dns',
        title: r.hostname + '.' + r.zone_name,
        subtitle: r.record_type + ' → ' + r.record_data,
        status: null,
        meta: {},
      });
    }

    res.json({ data: results, query: q, total: results.length });
  } catch (err) {
    console.error('[API] search error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Next available IP in a subnet ─────────────────────────────
app.get('/api/ipam/subnets/:id/next-ip', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const subnetRes = await db.query(
      'SELECT id, host(network) as network, prefix_length FROM ipam_subnets WHERE id=$1', [id]
    );
    if (!subnetRes.rows.length) return res.status(404).json({ error: 'Subnet not found' });
    const { network, prefix_length } = subnetRes.rows[0];

    // Get all used/reserved IPs in this subnet
    const usedRes = await db.query(
      `SELECT ip_address::text FROM ipam_addresses
       WHERE subnet_id=$1 AND status != 'available'
       ORDER BY ip_address`,
      [id]
    );
    const usedSet = new Set(usedRes.rows.map(r => r.ip_address));

    // Generate host IPs and find first available
    const parts  = network.split('.').map(Number);
    const hostCount = Math.pow(2, 32 - parseInt(prefix_length)) - 2;
    let base = (parts[0]<<24)|(parts[1]<<16)|(parts[2]<<8)|parts[3];
    base = base & (~0 << (32 - parseInt(prefix_length)));

    let nextIp = null;
    for (let i = 2; i <= hostCount; i++) { // start from .2 (skip gateway .1)
      const ip = base + i;
      const ipStr = `${(ip>>>24)&255}.${(ip>>>16)&255}.${(ip>>>8)&255}.${ip&255}`;
      if (!usedSet.has(ipStr)) { nextIp = ipStr; break; }
    }

    if (!nextIp) return res.json({ available: false, message: 'Subnet is full' });
    res.json({ available: true, ip: nextIp, subnet: network + '/' + prefix_length });
  } catch (err) {
    console.error('[API] next-ip error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Next available subnet in a supernet ───────────────────────
app.get('/api/ipam/supernets/:id/next-subnet', async (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const prefix = parseInt(req.query.prefix || '24');

    const snRes = await db.query(
      'SELECT id, host(network) as network, prefix_length, site FROM ipam_supernets WHERE id=$1', [id]
    );
    if (!snRes.rows.length) return res.status(404).json({ error: 'Supernet not found' });
    const supernet = snRes.rows[0];

    // Get all existing subnets within this supernet
    const existingRes = await db.query(
      `SELECT host(network) as network, prefix_length FROM ipam_subnets
       WHERE network << ($1 || '/' || $2)::inet
       ORDER BY network`,
      [supernet.network, supernet.prefix_length]
    );

    // Get all OTHER supernets assigned to different sites (must not overlap)
    const otherSupernetsRes = await db.query(
      `SELECT host(network) as network, prefix_length, site FROM ipam_supernets
       WHERE id != $1 AND site IS NOT NULL AND site != $2`,
      [id, supernet.site || '']
    );

    const existingSet = new Set(
      existingRes.rows.map(r => r.network + '/' + r.prefix_length)
    );

    // Generate candidate subnets
    const snParts   = supernet.network.split('.').map(Number);
    const snBase    = (snParts[0]<<24)|(snParts[1]<<16)|(snParts[2]<<8)|snParts[3];
    const snMask    = ~0 << (32 - supernet.prefix_length);
    const snEnd     = (snBase & snMask) + (Math.pow(2, 32 - supernet.prefix_length)) - 1;
    const blockSize = Math.pow(2, 32 - prefix);

    let nextSubnet = null;
    for (let addr = (snBase & snMask); addr + blockSize - 1 <= snEnd; addr += blockSize) {
      const candidate = `${(addr>>>24)&255}.${(addr>>>16)&255}.${(addr>>>8)&255}.${addr&255}/${prefix}`;
      const candidateNet = candidate.split('/')[0];

      // Skip if already used
      if (existingSet.has(candidate)) continue;

      // Skip if overlaps with another site's supernet
      let blocked = false;
      for (const other of otherSupernetsRes.rows) {
        const otherParts = other.network.split('.').map(Number);
        const otherBase  = (otherParts[0]<<24)|(otherParts[1]<<16)|(otherParts[2]<<8)|otherParts[3];
        const otherMask  = ~0 << (32 - other.prefix_length);
        const otherEnd   = (otherBase & otherMask) + Math.pow(2, 32 - other.prefix_length) - 1;
        if (addr >= (otherBase & otherMask) && addr <= otherEnd) {
          blocked = true; break;
        }
      }
      if (blocked) continue;

      nextSubnet = candidate;
      break;
    }

    if (!nextSubnet) return res.json({ available: false, message: 'No available subnet blocks' });
    res.json({
      available: true,
      subnet: nextSubnet,
      prefix,
      supernet: supernet.network + '/' + supernet.prefix_length,
      site: supernet.site,
    });
  } catch (err) {
    console.error('[API] next-subnet error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Conflict detection ────────────────────────────────────────
app.get('/api/ipam/conflicts', async (req, res) => {
  try {
    const conflicts = await db.query(
      `SELECT
         a.id as id_a, host(a.network) as network_a, a.prefix_length as prefix_a, a.name as name_a, a.site as site_a,
         b.id as id_b, host(b.network) as network_b, b.prefix_length as prefix_b, b.name as name_b, b.site as site_b
       FROM ipam_subnets a
       JOIN ipam_subnets b ON a.id < b.id
       WHERE a.network::inet && b.network::inet`
    );
    res.json({ data: conflicts.rows, count: conflicts.rows.length });
  } catch (err) {
    console.error('[API] conflicts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── IPAM — utilization history (hourly snapshots for the trend chart) ──
app.get('/api/ipam/utilization-history', async (req, res) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (!Number.isFinite(days) || days <= 0) days = 7;
    if (days > 365) days = 365;
    const rows = await db.query(
      `SELECT id, recorded_at, total_ips, used_ips, free_ips, utilization_pct
         FROM ipam_utilization_history
        WHERE recorded_at > NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY recorded_at ASC`,
      [days]
    );
    res.json({ data: rows.rows });
  } catch (err) {
    console.error('[API] ipam utilization-history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Utilization history for all scopes (sparklines)
app.get('/api/scopes/history/all', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours || '168'); // default 7 days
    const rows = await db.query(
      `SELECT
         h.scope_id,
         s.scope_id as scope_network,
         s.name,
         h.percent_used,
         h.in_use,
         h.free,
         h.recorded_at
       FROM dhcp_scope_history h
       JOIN dhcp_scopes s ON s.id = h.scope_id
       WHERE h.recorded_at > NOW() - make_interval(hours => $1)
       ORDER BY h.scope_id, h.recorded_at ASC`,
      [hours]
    );

    // Group by scope
    const grouped = {};
    for (const row of rows.rows) {
      const key = row.scope_network;
      if (!grouped[key]) grouped[key] = { scope_id: row.scope_network, name: row.name, history: [] };
      grouped[key].history.push({
        percent_used: parseFloat(row.percent_used),
        in_use: row.in_use,
        recorded_at: row.recorded_at,
      });
    }
    res.json({ data: Object.values(grouped) });
  } catch (err) {
    console.error('[API] scope history all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════
// AUDIT LOG (internal API for the Audit Log tab)
// ════════════════════════════════════════════════════════════
function buildAuditFilters(q, allowedSiteIds) {
  const conds = [], vals = [];
  if (q.action)      { vals.push(q.action);             conds.push(`action = $${vals.length}`); }
  if (q.entity_type) { vals.push(q.entity_type);        conds.push(`entity_type = $${vals.length}`); }
  if (q.username)    { vals.push(q.username);           conds.push(`username = $${vals.length}`); }
  if (q.result)      { vals.push(q.result);             conds.push(`result = $${vals.length}`); }
  if (q.site_id)     { vals.push(parseInt(q.site_id));  conds.push(`site_id = $${vals.length}`); }
  if (q.from)        { vals.push(q.from);               conds.push(`timestamp >= $${vals.length}`); }
  if (q.to)          { vals.push(q.to);                 conds.push(`timestamp <= $${vals.length}`); }
  if (q.q) { vals.push(`%${q.q}%`); conds.push(`(entity_name ILIKE $${vals.length} OR change_summary ILIKE $${vals.length})`); }
  // Site-scope restriction for site_admin (null = unrestricted)
  if (allowedSiteIds != null) { vals.push(allowedSiteIds); conds.push(`site_id = ANY($${vals.length}::int[])`); }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', vals };
}

app.get('/api/audit', attachSiteFilter, async (req, res) => {
  try {
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const { where, vals } = buildAuditFilters(req.query, req.allowedSiteIds);
    const totalRes = await db.query(`SELECT COUNT(*) AS c FROM audit_log ${where}`, vals);
    const total = parseInt(totalRes.rows[0].c);
    const rows = await db.query(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limit, (page - 1) * limit]);
    res.json({ data: rows.rows, total, page, limit });
  } catch (err) {
    console.error('[API] audit list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/audit/stats', async (req, res) => {
  try {
    const [today, week, topUsers, topActions, topEntities] = await Promise.all([
      db.query("SELECT COUNT(*) AS c FROM audit_log WHERE timestamp >= date_trunc('day', NOW())"),
      db.query("SELECT COUNT(*) AS c FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days'"),
      db.query("SELECT username, COUNT(*) AS c FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY username ORDER BY c DESC LIMIT 5"),
      db.query("SELECT action, COUNT(*) AS c FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY action ORDER BY c DESC LIMIT 5"),
      db.query("SELECT entity_type, COUNT(*) AS c FROM audit_log WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY entity_type ORDER BY c DESC LIMIT 5"),
    ]);
    res.json({
      today: parseInt(today.rows[0].c),
      week: parseInt(week.rows[0].c),
      top_user: topUsers.rows[0] ? topUsers.rows[0].username : '—',
      top_users: topUsers.rows,
      top_actions: topActions.rows,
      top_entity: topEntities.rows[0] ? topEntities.rows[0].entity_type : '—',
      top_entities: topEntities.rows,
    });
  } catch (err) {
    console.error('[API] audit stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/audit/export', requireSuperAdmin, async (req, res) => {
  try {
    const { where, vals } = buildAuditFilters(req.query);
    const rows = await db.query(`SELECT timestamp, username, user_role, action, entity_type, entity_name, change_summary, result, ip_address, duration_ms FROM audit_log ${where} ORDER BY timestamp DESC LIMIT 50000`, vals);
    const cols = ['timestamp', 'username', 'user_role', 'action', 'entity_type', 'entity_name', 'change_summary', 'result', 'ip_address', 'duration_ms'];
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(','), ...rows.rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
    if (req.audit) req.audit({ action: 'export', entity_type: 'audit_log', change_summary: `Exported ${rows.rows.length} audit rows as CSV` });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[API] audit export error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/audit/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM audit_log WHERE id = $1', [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Audit entry not found' });
    res.json({ data: r.rows[0] });
  } catch (err) {
    console.error('[API] audit detail error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════
// API KEYS (management for the Settings tab)
// ════════════════════════════════════════════════════════════
app.get('/api/api-keys', requireSuperAdmin, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, key_prefix, name, description, created_by, created_at, last_used_at,
              expires_at, is_active, permissions, allowed_ips, request_count
         FROM api_keys ORDER BY created_at DESC`);
    res.json({ data: r.rows.map(k => ({ ...k, key_masked: maskedDisplay(k.key_prefix) })) });
  } catch (err) {
    console.error('[API] api-keys list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/api-keys', requireSuperAdmin, async (req, res) => {
  try {
    const { name, description, permissions, allowed_ips, expires_at } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const gen = generateKey();
    const perms = {
      read:  permissions ? !!permissions.read  : true,
      write: permissions ? !!permissions.write : false,
      admin: permissions ? !!permissions.admin : false,
    };
    const ips = Array.isArray(allowed_ips) ? allowed_ips.filter(Boolean)
      : (typeof allowed_ips === 'string' && allowed_ips.trim() ? allowed_ips.split(',').map(s => s.trim()).filter(Boolean) : null);
    const actor = req.headers['x-ddi-actor'] || 'admin';
    const r = await db.query(
      `INSERT INTO api_keys (key_hash, key_prefix, name, description, created_by, permissions, allowed_ips, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [gen.key_hash, gen.key_prefix, name, description || null, actor, JSON.stringify(perms), ips, expires_at || null]);
    if (req.audit) req.audit({ action: 'create', entity_type: 'api_key', entity_id: r.rows[0].id, entity_name: name, new_value: { name, permissions: perms, allowed_ips: ips } });
    // Full key returned ONCE — never stored or shown again.
    res.json({ id: r.rows[0].id, key: gen.key, key_prefix: gen.key_prefix, permissions: perms });
  } catch (err) {
    console.error('[API] api-keys create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/api-keys/:id', requireSuperAdmin, async (req, res) => {
  try {
    const r = await db.query('UPDATE api_keys SET is_active = FALSE WHERE id = $1 RETURNING name', [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Key not found' });
    if (req.audit) req.audit({ action: 'delete', entity_type: 'api_key', entity_id: req.params.id, entity_name: r.rows[0].name, change_summary: `Revoked API key "${r.rows[0].name}"` });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] api-keys revoke error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════
// INFRASTRUCTURE HEALTH (HA, failover, SOA sync)
// ════════════════════════════════════════════════════════════
app.get('/api/infrastructure/health', attachSiteFilter, async (req, res) => {
  try {
    const siteFilter = req.allowedSiteIds !== null ? `AND s.site_id = ANY($1::int[])` : '';
    const params = req.allowedSiteIds !== null ? [req.allowedSiteIds] : [];
    const servers = await db.query(
      `SELECT s.id, s.hostname, host(s.ip_address) AS ip, s.role, s.is_active, s.poll_status,
              s.last_polled, s.health_score, s.health_checked_at, s.query_ms, s.winrm_test_ok, s.site_id,
              (SELECT COUNT(*) FROM dhcp_scopes sc WHERE sc.server_id = s.id) AS scope_count,
              (SELECT COUNT(*) FROM dhcp_leases l WHERE l.server_id = s.id) AS lease_count,
              (SELECT COUNT(*) FROM dns_zones z WHERE z.server_id = s.id) AS zone_count,
              (SELECT COALESCE(SUM(z.record_count),0) FROM dns_zones z WHERE z.server_id = s.id) AS record_count
         FROM ddi_servers s WHERE s.is_active = TRUE ${siteFilter} ORDER BY s.hostname`,
      params);
    // overall status
    const scores = servers.rows.map(s => s.health_score).filter(v => v != null);
    const worst = scores.length ? Math.min(...scores) : null;
    let overall = 'healthy';
    if (worst != null && worst < 70) overall = 'critical';
    else if (worst != null && worst < 90) overall = 'warning';
    else if (servers.rows.some(s => s.poll_status === 'error' || s.winrm_test_ok === false)) overall = 'warning';
    res.json({ data: servers.rows, overall, worst_score: worst });
  } catch (err) {
    console.error('[API] infra health error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/infrastructure/failover', async (req, res) => {
  try {
    const pairs = await db.query(
      `SELECT f.*, p.hostname AS primary_name, sec.hostname AS secondary_name
         FROM dhcp_failover_pairs f
         LEFT JOIN ddi_servers p   ON p.id   = f.primary_server_id
         LEFT JOIN ddi_servers sec ON sec.id = f.secondary_server_id
        ORDER BY f.relationship_name`);
    const sync = await db.query(
      `SELECT s.*, sc.scope_id AS scope_label FROM dhcp_scope_sync_status s
         LEFT JOIN dhcp_scopes sc ON sc.id = s.scope_id
        WHERE s.checked_at > NOW() - INTERVAL '1 day' ORDER BY s.checked_at DESC LIMIT 200`);
    res.json({ data: pairs.rows, sync: sync.rows });
  } catch (err) {
    console.error('[API] failover error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/infrastructure/servers/:id/history', async (req, res) => {
  try {
    const hours = safeHours(req.query.hours, 720);
    const r = await db.query(
      `SELECT health_score, winrm_ok, query_ms, soa_in_sync, recorded_at
         FROM server_health_history
        WHERE server_id = $1 AND recorded_at > NOW() - ($2 || ' hours')::interval
        ORDER BY recorded_at ASC`, [parseInt(req.params.id), hours]);
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[API] server health history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Distribution of IPAM address statuses (for dashboard donut)
app.get('/api/dashboard/ip-distribution', async (req, res) => {
  try {
    const r = await db.query('SELECT status, COUNT(*) AS c FROM ipam_addresses GROUP BY status');
    const out = { available: 0, dhcp: 0, reserved: 0, unknown: 0, offline: 0 };
    r.rows.forEach(row => { out[row.status] = parseInt(row.c); });
    res.json({ data: out });
  } catch (err) {
    console.error('[API] ip-distribution error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Lease trend over last N days (for dashboard line chart)
app.get('/api/dashboard/lease-trend', async (req, res) => {
  try {
    const days = safeInt(req.query.days, 7, 90);
    const r = await db.query(
      `SELECT date_trunc('day', recorded_at) AS day, ROUND(AVG(in_use)) AS leases
         FROM dhcp_scope_history
        WHERE recorded_at > NOW() - ($1 || ' days')::interval
        GROUP BY day ORDER BY day ASC`, [days]);
    res.json({ data: r.rows });
  } catch (err) {
    console.error('[API] lease-trend error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Collector liveness derived from ddi_servers.last_polled
app.get('/api/dashboard/collector-status', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT
         MAX(last_polled) AS last_poll,
         COUNT(*) AS servers_total,
         COUNT(*) FILTER (WHERE last_polled > NOW() - INTERVAL '15 minutes') AS servers_recent,
         EXTRACT(EPOCH FROM (NOW() - MAX(last_polled))) AS seconds_since
       FROM ddi_servers
       WHERE is_active = TRUE`);
    const row = r.rows[0] || {};
    const lastPoll = row.last_poll ? new Date(row.last_poll).toISOString() : null;
    const secondsSince = row.seconds_since != null ? Math.round(parseFloat(row.seconds_since)) : null;
    let status;
    if (lastPoll == null || secondsSince == null) status = 'down';
    else if (secondsSince <= 900) status = 'active';
    else if (secondsSince <= 3600) status = 'stale';
    else status = 'down';
    res.json({
      data: {
        last_poll: lastPoll,
        seconds_since: secondsSince,
        servers_total: parseInt(row.servers_total) || 0,
        servers_recent: parseInt(row.servers_recent) || 0,
        status,
      },
    });
  } catch (err) {
    console.error('[API] collector-status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Per-server health history sparklines (uptime, avg query, score points)
app.get('/api/infrastructure/health-history', async (req, res) => {
  try {
    const hours = safeInt(req.query.hours, 168, 2160);
    const r = await db.query(
      `SELECT h.server_id, s.hostname, h.health_score, h.winrm_ok, h.query_ms, h.recorded_at
         FROM server_health_history h
         JOIN ddi_servers s ON s.id = h.server_id
        WHERE h.recorded_at > NOW() - ($1 || ' hours')::interval
        ORDER BY h.server_id, h.recorded_at ASC`, [hours]);
    const byServer = new Map();
    for (const row of r.rows) {
      let entry = byServer.get(row.server_id);
      if (!entry) {
        entry = { server_id: row.server_id, hostname: row.hostname, _all: [] };
        byServer.set(row.server_id, entry);
      }
      entry._all.push(row);
    }
    const data = [];
    for (const entry of byServer.values()) {
      const all = entry._all;
      const total = all.length;
      // uptime: prefer winrm_ok boolean when present, else health_score >= 50
      const upCount = all.filter(x =>
        x.winrm_ok != null ? x.winrm_ok === true : (x.health_score != null && x.health_score >= 50)
      ).length;
      const uptime_pct = total ? Math.round((100 * upCount) / total) : null;
      const qmsVals = all.map(x => x.query_ms).filter(v => v != null);
      const avg_query_ms = qmsVals.length
        ? Math.round(qmsVals.reduce((a, b) => a + b, 0) / qmsVals.length)
        : null;
      // most recent ~200 points, ascending
      const recent = all.slice(-200);
      const points = recent
        .filter(x => x.health_score != null)
        .map(x => ({ t: new Date(x.recorded_at).toISOString(), score: parseInt(x.health_score) }));
      data.push({
        server_id: entry.server_id,
        hostname: entry.hostname,
        uptime_pct,
        avg_query_ms,
        points,
      });
    }
    res.json({ data });
  } catch (err) {
    console.error('[API] infra health-history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard pillar scores (overall + DHCP/DNS/IPAM/Security) with hourly trend
app.get('/api/dashboard/pillars', async (req, res) => {
  try {
    // Latest row per site, averaged across sites
    const latest = await db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (site_id) site_id, calculated_at,
                overall_score, dhcp_score, ipam_score, dns_score, security_score
           FROM site_health_scores
          ORDER BY site_id, calculated_at DESC
       )
       SELECT
         ROUND(AVG(overall_score))  AS overall,
         ROUND(AVG(dhcp_score))     AS dhcp,
         ROUND(AVG(ipam_score))     AS ipam,
         ROUND(AVG(dns_score))      AS dns,
         ROUND(AVG(security_score)) AS security,
         MAX(calculated_at)         AS as_of,
         COUNT(*)                   AS sites
       FROM latest`);
    const row = latest.rows[0] || {};
    const sites = parseInt(row.sites) || 0;

    // Hourly trend across all sites — last ~24 buckets, ascending
    const trendRows = await db.query(
      `SELECT bucket,
              ROUND(AVG(dhcp_score))     AS dhcp,
              ROUND(AVG(ipam_score))     AS ipam,
              ROUND(AVG(dns_score))      AS dns,
              ROUND(AVG(security_score)) AS security
         FROM (
           SELECT date_trunc('hour', calculated_at) AS bucket,
                  dhcp_score, ipam_score, dns_score, security_score
             FROM site_health_scores
            WHERE calculated_at > NOW() - INTERVAL '24 hours'
         ) t
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 24`);
    const trend = (col) =>
      trendRows.rows.map(r => (r[col] != null ? parseInt(r[col]) : 0));
    const num = (v) => (v != null ? parseInt(v) : null);

    res.json({
      data: {
        overall: num(row.overall),
        dhcp:     { score: num(row.dhcp),     trend: sites ? trend('dhcp') : [] },
        dns:      { score: num(row.dns),      trend: sites ? trend('dns') : [] },
        ipam:     { score: num(row.ipam),     trend: sites ? trend('ipam') : [] },
        security: { score: num(row.security), trend: sites ? trend('security') : [] },
        as_of: row.as_of ? new Date(row.as_of).toISOString() : null,
        sites,
      },
    });
  } catch (err) {
    console.error('[API] dashboard/pillars error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Reports router + public REST API v1 ───────────────────────
app.use('/api/reports', createReportsRouter(db));
app.use('/api/v1', createV1Router({ db, psWrite, getServerWithAuth }));

// ── Generic error handler ─────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[API Error]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Sync all active server IPs to WinRM TrustedHosts on startup ───
async function syncTrustedHosts() {
  try {
    const { addToTrustedHosts } = require('../collector/powershellRunner');
    const result = await db.query('SELECT ip_address::text FROM ddi_servers WHERE is_active = TRUE');
    for (const row of result.rows) {
      if (row.ip_address) addToTrustedHosts(row.ip_address);
    }
    console.log(`[TrustedHosts] Synced ${result.rows.length} server IPs on startup`);
  } catch (err) {
    console.error('[TrustedHosts] Startup sync failed:', err.message);
  }
}
syncTrustedHosts();
// One-time startup recovery: clear scans left stuck from a previous run/crash.
async function clearStuckScansOnStartup() {
  try {
    await db.query(`
      UPDATE ipam_subnets SET scan_status='error'
      WHERE scan_status='scanning' AND last_scanned < NOW() - INTERVAL '1 hour'`);
    await db.query(`
      UPDATE ipam_scan_jobs SET status='error', error_msg='Scan timed out - auto-cleared on restart'
      WHERE status='running' AND started_at < NOW() - INTERVAL '30 minutes'`);
  } catch (err) {
    console.error('[ScanExpiry] startup clear failed:', err.message);
  }
  await expireStuckScans();
}
clearStuckScansOnStartup();

// License: check on startup + refresh every 24h
getLicense(true).then(lic => {
  const state = getLicenseState(lic);
  if (state.disabled) console.warn('[License] DDIVault license expired — running in disabled mode');
  else console.log(`[License] Status: ${lic?.status || 'unreachable'}, mode: ${state.mode}`);
}).catch(() => {});
setInterval(() => getLicense(true).catch(() => {}), 24 * 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] DDIVault API running on http://127.0.0.1:${PORT}`);
});
