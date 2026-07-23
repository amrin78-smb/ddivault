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
(c) SmtpSettings  (no props) — default export
(c) ThemeProvider  children
(c) ToastProvider  children
(c) TrendChart  chart, height
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

### DHCPTab.tsx (1553 lines — skimmed structurally)
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

- Exported components in root `components/` (35 files, including LicenseGuard's 4
  exports, RBACContext's 3, ui.tsx's 10 UI primitives, IdleTimeout counted once despite
  two export forms, and DHCPTab/DNSTab/IPAMTab): **48**
- Exported components in `components/dashboard/` (6 files): **6**
- Exported components in `components/ipam/` (4 files): **4**
- **Grand total: 58 exported components across 45 files.**
- (`pctColor` (ui.tsx), `useRefreshKey`/`useEscape` (ui.tsx), and `scoreColor`/
  `forecastColor`/`severityColor`/`severityBadgeClass` (palette.tsx) are utility
  functions / hooks, not components — excluded from the count above.)
- Violations: **0**.
