# DDIVault Component Index

Dense lookup table for `frontend/src/components/`. One line per exported component:
`(c|s) ComponentName  prop1, prop2, ...`. `(c)` = client component (`'use client'` at
top of file, applies to every component in that file). `(s)` = no `'use client'`
directive found (server component / plain export). Only components actually
`export`ed are listed — internal (non-exported) module-scope helper components used
only within the same file are omitted, except where noted.

## components/ (root)

(c) AlertRecipients  (no props) — default export; file also defines module-scope `RecipientModal` (not exported)
(c) AlertRules  (no props) — default export
(c) ApiKeysSection  (no props) — named export; file also defines module-scope `CreateModal`, `RevealModal`, `PermBadges` (not exported)
(s) AuditActor  (no props) — deliberate no-op (returns null); NO `'use client'` directive in this file — the only file in components/ without one. Kept only for a stale `<AuditActor />` import in app/layout.tsx; safe to delete.
(c) AgentsTab  (no props) — default export (Remote Agents, Phase 4b); file also defines module-scope `AssignModal`, `AgentCard` (not exported) + helpers `isOnline`, `relTime`. Admin+ surface: lists ddi_agents roster (hostname/status/last-seen/version/#servers — title falls back name → hostname → hub id) + a per-agent server multi-select (grouped by site) that assigns/unassigns ddi_servers to the agent via POST /api/ddi-agents/:hubId/servers
(c) AuditTab  (no props) — default export
(c) AuthProvider  children
(c) CapacityForecast  onViewAll, onRowClick — default export
(c) DateRangePicker  value, onChange, maxDays
(c) DeviceDonut  (no props) — default export; file also defines module-scope `DeviceSlideOver` (not exported)
(c) ErrorBoundary  children, name — class component (Props/State typed)
(c) FetchInterceptor  (no props)
(c) GlobalSearch  onNavigate — default export
(c) Header  onNavigate, collectorOnline — file also defines module-scope `DDIVaultLogo`, `SunIcon`, `MoonIcon` (not exported)
(c) IPAMImport  onDone — default export
(c) IdleTimeout  (no props) — named export `IdleTimeout` + `export default IdleTimeout` (same component, two export forms); file also defines module-scope `WarningModal` (not exported)
(c) InfraHealthTab  (no props) — default export; file also defines module-scope `Gauge` (not exported)
(c) LicenseProvider  children
(c) LicenseGate  children
(c) LicenseBanner  (no props)
(c) LicenseDisabledScreen  (no props)
(c) RBACProvider  children
(c) ReadOnlyBanner  show, label
(c) RequireRole  role, children, fallback
(c) ReportDrillDrawer  open, entity, id, range, onClose
(c) ReportScheduleModal  open, initial, reports, defaults, onClose, onSaved
(c) ReportsCatalog  reports, activeKey, onSelect
(c) ReportsManagePanel  reports, currentContext, refreshKey, onLoadSaved, onOpenSchedule
(c) ReportsTab  (no props) — default export; imports DateRangePicker/ReportDrillDrawer/ReportScheduleModal/ReportsManagePanel/ReportsCatalog/TrendChart
(c) SecurityOverview  onViewAll, onTypeClick — default export
(c) ServersTab  (no props) — default export; file also defines module-scope `ServerModal`, `ServerCard` (not exported)
(c) SiteHealth  onSiteClick — default export; file also defines module-scope `ScoreBar`, `SiteTile` (not exported)
(c) SmtpSettings  (no props) — default export. ⛔ **1.35.0 REMOVED every transport field
    from this page**: SMTP Host, Port, "Use TLS / SSL", Username, Password AND the
    "Allow self-signed certificate" checkbox that 1.35.0's own earlier pass had just added.
    The NetVault hub is now the only place a mail server is configured, so offering those
    controls here would be offering a form that owns nothing. The COLUMNS and the backend
    fallback are untouched — only the controls are gone.
    STILL EDITABLE (genuinely per-app): From Email (required), From Name, "Enable email
    alert delivery". Send Test Email stays and tests whichever transport resolved.
    In place of the removed fields the card renders a READ-ONLY statement of the EFFECTIVE
    transport, in one of three states derived from `GET /api/smtp`'s `source` + the local
    row's `host`:
      'hub'    — `source === 'hub'` and a `hub` summary: names `hub.host:hub.port`, the
                 connection mode, the username, and whether certificate checking is
                 enforced (`hub.allow_self_signed`), on the `--tint-info` panel.
      'legacy' — no hub transport but this app's own row has a NON-EMPTY host: names it the
                 same way, on `--tint-warn`, and says it is no longer editable here. ⛔ This
                 state exists because `api/suiteSmtp.js` STILL READS that row as the
                 fallback — a row that silently sends mail while the UI never mentions it is
                 exactly what this change ends.
      'none'   — neither: says plainly that nothing will be delivered and that DDIVault
                 cannot be pointed at a mail server from this page.
    All three link to the hub's Settings → Notifications, built from `getHubUrl()`
    (`src/lib/hubUrl.ts`) — ⛔ NEVER a hardcoded host.
    ⛔ **Division of labour with the settings rail (1.35.1).** The rail's standing hub
    pointer ("Users, sign-on, licence and mail are managed in NetVault →", see pages.md)
    now says WHERE mail is configured, so this panel says only WHICH server is carrying
    mail right now and where to change it — the 'hub' title and the 'none' branch's
    closing line were tightened so the two do not state the same fact in two voices on
    one screen. Keep that split when editing this copy.
    Module-scope only: styles (`NOTE`, `NOTE_WARN`, `FACTS`, …), the `Fact` row component,
    `certText()` and `EffectiveTransport` — no component is defined inside a component.
(c) ThemeProvider  children
(c) ToastProvider  children
(c) TrendChart  chart, height
(c) UpdateFailureBanner  onGoToSettings — admin-only (useRBAC), polls /api/system/last-update-status every 5min, red banner on a failed Update-DDIVault.ps1 run (stage/error code/rolled-back state) — default export
(c) UpdateNotifier  onGoToSettings — default export
(c) pctColor(pct)  — utility function (returns a color string, not JSX) — not a component, listed for completeness since it's exported from ui.tsx
(c) scoreColor(score)/forecastColor(days)/severityColor(severity)/severityBadgeClass(severity)  — utility functions, from palette.tsx (canonical health-score/capacity-forecast/alert-severity color palettes, replacing ~10 per-file duplicates)
(c) Skeleton  width, height, radius, style
(c) TableSkeleton  rows, cols
(c) CardSkeleton  count, height
(c) EmptyState  icon, title, message, actionLabel, onAction
(c) PageHeader  title, subtitle, children
(c) Breadcrumb  items, light
(c) UtilBar  pct, showLabel, width
(c) Trend  delta, invert
(c) Spinner  size, color
(c) useRefreshKey(cb) / useEscape(cb) — hooks exported from ui.tsx, not components (listed for completeness, not counted in component total)

### DHCPTab.tsx (1546 lines — skimmed structurally)
(c) DHCPTab  focusScope — default export (sole export)
Internal module-scope (not exported, never nested): `ReserveModal`, `CreateScopeModal`, `EditScopeModal`, `ScopeDetail`, `ScopeRow`, plus plain helper functions (`isIp`, `optionValueToString`, `formatDuration`, `ipFromRange`, `pctNum`, `isEmptyScope`, `stateBadge`, `fmtDate`, `deviceIcon`, `forecastColor`). All defined at column 0 (module top level) — none nested inside DHCPTab's function body.

### DNSTab.tsx (2495 lines — skimmed structurally)
(c) DNSTab  onNavigate — default export (sole export)
Internal module-scope (not exported, never nested): `TypeBadge`, `RecordModal`, `AddZoneModal`, `ServerPill`, `SubTabButton`, `ZoneRow`, `ZoneSection`, `SectionHead`, `KpiTile`, `ScoreGauge`, `ForwarderPill`, `ServerHealthCard`, `TopologyDiagram`, `HealthOverviewPanel`, `ZonesRecordsPanel`, `DnsManagementConsole`, `Sparkline`, `InsightKpi`, `CardLink`, `InsightCard`, `LockedCard`, `InsightsPanel`, plus helper functions (`shortTime`, `scoreColor`, `dnsServerStatus`, `dnsStatusColor`, `compactNum`, `sevBadgeClass`). CLAUDE.md describes DNSTab as a 4-sub-tab console (Health Overview, Zones & Records, Intelligence, Analytics) — confirmed: `HealthOverviewPanel`, `ZonesRecordsPanel`, `DnsManagementConsole`/`InsightsPanel` are all defined at module top level (column 0, sibling functions), NOT nested inside DNSTab's function body. No violation.

### IPAMTab.tsx (1612 lines — skimmed structurally)
(c) IPAMTab  (no props) — default export (sole export)
Internal module-scope (not exported, never nested): `ScanProgressBar`, `RowMenu`, `Field`, `SiteSelect`, `SiteIdSelect`, `ModalShell`, `ModalFooter`, `AddSupernetModal`, `AddSubnetModal`, `AddVlanModal`, `EditSupernetModal`, `EditSubnetModal`, `ReserveModal`, `SubnetDetail`, `TreeView`, `FlatView`, `VlanView`, plus helper functions (`totalHosts`, `utilPct`, `fmtDate`, `fmtDay`, `scanLabel`, `cleanNetwork`, `deviceIcon`, `scanEta`, `siteName`, `ipToInt`, `intToIp`, `ipRange`, `utilStatus`, `relTime`, `ipToNum`). All at module top level. One local render-helper closure worth noting: inside `FlatView` (~line 1506), `const SH = (k, label) => (<th ...>...)` is defined mid-render and called directly as `SH('network','Network')` — a plain function call, not rendered as a JSX tag (`<SH/>`). Since it's never used as a JSX component type, it does not create a separate React element identity and does NOT cause remounts — not the anti-pattern CLAUDE.md warns about, just a minor local helper.

## components/dashboard/

(c) ActivityFeed  refreshNonce, onNavigate — default export; file also defines module-scope `EventTypeBadge`, `ActionBadge`, `SegButton` (not exported)
(c) CommandBar  timeRange, onTimeRange, lastUpdated, onRefresh, paused, onTogglePause, refreshNonce, onNavigate — default export
(c) DnsAnalyticsCard  refreshNonce, onNavigate — default export; file also defines module-scope `Sparkline`, `MiniStat` (not exported)
(c) InfraRedundancy  timeRange, refreshNonce, onNavigate — default export; file also defines module-scope `Sparkline` (not exported)
(c) PillarScorecards  timeRange, refreshNonce, onNavigate — default export; file also defines module-scope `Sparkline` (not exported)
(c) PriorityActionCenter  refreshNonce, onNavigate, onFocusScope — default export; file also defines module-scope `Row` (not exported)

## components/ipam/

(c) IpamDonut  used, free, total
(c) IpamKpiTiles  supernetCount, subnetCount, totalIps, usedIps, freeIps, unknownHosts, loading
(c) IpamTopSubnets  subnets, onViewAll
(c) IpamTrendChart  data, granularity, onGranularityChange, loading

## Violations

**None found.** Every file checked — including the three large ones (DHCPTab.tsx,
DNSTab.tsx, IPAMTab.tsx) flagged for extra scrutiny — defines all of its sub-components
(modals, rows, panels, badges, sparklines, etc.) at module scope (column 0, sibling
functions/consts), never nested inside another component's function body. This matches
the CLAUDE.md rule "Never define components inside other React components" and several
files have explicit comments calling this out (e.g. AlertRecipients.tsx: "Recipient
Modal — MODULE SCOPE (never nested)"; ServersTab.tsx: "Server Form Modal — MODULE SCOPE
(never nested)"; IdleTimeout.tsx: "Sub-component defined at module scope — never inside
the main component").

One borderline case investigated and cleared: `IPAMTab.tsx`'s `FlatView` (~line 1506)
defines a local `const SH = (k, label) => (<th>...)` inside its render body and calls it
as a plain function (`SH('network','Network')`), not as a JSX component tag (`<SH/>`).
Because it's never instantiated via JSX, React never gives it a separate component
identity, so it cannot cause the remount-on-every-render bug the rule exists to prevent.
Not counted as a violation.

## Totals

- Exported components in root `components/` (36 files, including LicenseGuard's 4
  exports, RBACContext's 3, ui.tsx's 10 UI primitives, IdleTimeout counted once despite
  two export forms, AgentsTab, and DHCPTab/DNSTab/IPAMTab): **49**
- Exported components in `components/dashboard/` (6 files): **6**
- Exported components in `components/ipam/` (4 files): **4**
- **Grand total: 59 exported components across 46 files.**
- (`pctColor` (ui.tsx), `useRefreshKey`/`useEscape` (ui.tsx), and `scoreColor`/
  `forecastColor`/`severityColor`/`severityBadgeClass` (palette.tsx) are utility
  functions / hooks, not components — excluded from the count above.)
- Violations: **0**.

(c) CornersToggle — Rounded/Square segmented ROW rendered inside the avatar dropdown in Header.tsx (moved out of the top bar in 1.29.2 — it looked wrong there). Deliberately NOT in Settings: that tab is gated behind canManageSystem, and this is a per-browser preference every role must be able to set. Reads its value in useEffect (never at render — the <html> attribute does not exist during SSR, so reading at render is a hydration mismatch).

## DNS platform UI (1.37.0)
- `ServersTab.tsx` — new **DNS Platform** selector (Windows DNS / BIND 9 / PowerDNS) above the auth section.
  The PowerShell/WinRM blocks are hidden entirely for non-Windows platforms rather than greyed out (there is
  nothing a BIND operator could usefully put in them). BIND shows TSIG key/algorithm/secret + statistics-channel
  URL and a copyable named.conf snippet; PowerDNS shows API URL/key/server-id. Secret inputs start blank and
  send '' when untouched, which the API reads as "unchanged".
- `DNSTab.tsx` — `PlatformBadge` (renders nothing for Windows, the default) and `CapabilityNotes`, which states
  gaps as what they are: *not applicable on this platform* (grey) vs *not readable from this server* (amber).
  ⛔ These must stay visually distinct — collapsing them is how a missing config step hides behind a feature
  that was never going to exist.
