# DDIVault Page Tree

Real Next.js page routes are minimal — DDIVault is mostly ONE page (`/`) with
client-side tab switching (`useState<Tab>` in page.tsx), not per-tab routes.
Do not go looking for `/app/dashboard/page.tsx` etc — they don't exist.

## frontend/src/app/ (page routes)

[client] / — page.tsx (RootLayout wraps it) — single-page app shell; renders
  `<Tab>` content via internal `useState<Tab>` switch, NOT nested routes.
  `type Tab = 'dashboard' | 'scopes' | 'ipam' | 'dns' | 'events' | 'servers' | 'infra' | 'reports' | 'audit' | 'settings'`
  (1842 lines). Composes: Header, ErrorBoundary, Toast, RBACContext,
  LicenseGuard (useLicense/LicenseDisabledScreen/LicenseBanner), UpdateNotifier,
  IPAMTab, DHCPTab, DNSTab, ServersTab, AuditTab, ReportsTab, InfraHealthTab,
  SmtpSettings, AlertRecipients, AlertRules, CapacityForecast, SiteHealth,
  SecurityOverview, DeviceDonut, dashboard/{CommandBar,PriorityActionCenter,
  PillarScorecards,InfraRedundancy,DnsAnalyticsCard,ActivityFeed}, ApiKeysSection.

[server] /layout.tsx — RootLayout — html/body shell; provider nesting order
  (outer→inner): AuthProvider -> RBACProvider -> AuditActor + IdleTimeout ->
  ThemeProvider -> ToastProvider -> FetchInterceptor -> LicenseProvider ->
  LicenseGate(children). LicenseGate hard-blocks EVERY route (incl. /sso) with
  a full-screen lock when license disabled/unlicensed, not just a banner.

[client] /sso — SSOPage (wraps SSOHandler in Suspense) — SSO landing page;
  reads `?token=` from hub, POSTs to `/api/sso` (server-side verify, avoids
  CORS), then calls NextAuth `signIn('credentials', {email, token})`, then
  `router.replace('/')`. On any failure redirects to
  `${hub}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault` after a delay.

## frontend/src/app/api/ (NextAuth-related Next.js API routes — see routes.md for full detail)

/api/auth/[...nextauth]/route.ts — NextAuth handler (GET+POST), config from
  `frontend/src/lib/auth.ts` `authOptions`.
/api/sso/route.ts — POST — server-side proxy to hub's
  `/api/auth/sso-verify` (avoids browser CORS); origin resolved per-request
  via `resolveOrigin()` from `frontend/src/lib/publicUrl.ts`.

## Middleware (not a page, but gates every page/api route)

frontend/src/middleware.ts — verifies NextAuth JWT, strips/stamps
  `x-ddi-actor*` headers, proxies `/api/*` to Express (127.0.0.1:3007),
  enforces per-user app-access claim. See routes.md and gotchas.md.

## Total: 2 real page routes (`/`, `/sso`), 1 root layout, 2 Next.js API routes.
