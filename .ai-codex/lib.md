## Backend (api/)

alertDispatcher.js
  dispatchAlert(db, alert, ruleType) — route one alert to filtered recipients (rule/cooldown/severity/site), sends via emailer or defers to digest
  sendHourlyDigest(db) — gather last-60min un-emailed alerts, send one digest per recipient matching their filters

clientIp.js
  clientIp(req, env?) — the caller's IP for an API behind a proxy [SENSITIVE]. Counts trusted
    hops from the RIGHT of x-forwarded-for (`hops[len - DDI_TRUSTED_PROXY_HOPS]`, default 1 =
    the Next.js frontend proxy), because the LEFTMOST entries are whatever the caller sent.
    `DDI_TRUSTED_PROXY_HOPS=0` ignores the header entirely. Fails closed (socket peer) when the
    header carries fewer hops than declared. Used by middleware/apiAuth.js (api_keys.allowed_ips)
    and middleware/audit.js (audit_log.ip_address) — both used to read `split(',')[0]`, so an
    IP-restricted key was bypassable and audit source IPs were forgeable.
  normalizeIp(v) — trim, strip [brackets]/`:port`, reduce `::ffff:a.b.c.d` to IPv4
  trustedHops(env) — parsed DDI_TRUSTED_PROXY_HOPS (default 1; junk/negative ⇒ default)
  DEFAULT_TRUSTED_HOPS — const 1

csv.js
  escapeCsvCell(v) — RFC-4180 quote + formula-injection guard for a single CSV cell

queryScope.js
  siteAllowed(allowedSiteIds, siteId) — tri-state scope test; NULL site ⇒ false (fail closed)
  siteScopeSql(allowedSiteIds, column, params) — '' when unrestricted, else
    `<column> = ANY($n::int[])`, pushing the bind param onto `params`. `[]` still emits the
    predicate (matches nothing) rather than '' (would mean "see everything")
  scopeGate(row, allowedSiteIds, message, siteKey?) — null to serve, else ONE
    `{status:404, body:{error:message}}` for BOTH absent and out-of-scope, so the two answers
    cannot be told apart (a 403 on out-of-scope lets a caller map which ids exist)
  buildLeaseWhere(query, allowedSiteIds) — `{whereClause, params}` for GET /api/leases
  buildLeaseExportQuery(allowedSiteIds) — `{sql, params}` for GET /api/leases/export
  buildLeaseHistoryQuery(ip, allowedSiteIds) — `{sql, params}` for GET /api/leases/ip/:ip/history
  Unit tested in tests/siteScoping.test.js (no DB required).

deviceClassifier.js
  classifyDevice(mac, hostname) — best-effort {type,os,icon,vendor,vendor_state,oui_prefix,risk_level} from OUI + hostname pattern
  isMacRandomized(mac) — checks locally-administered bit on MAC first octet
  vendorLabel(info) — the display string for a lookupOUI() result; four IEEE outcomes must render as four
    different strings. ⛔ A registry block renders "Unknown (IEEE block <prefix>)", NEVER the registrar's name.
    ⛔ vendor_state='unreadable' means WE could not read the catalogue; risk_level is then 'unknown', never
    'high' — rating it as an unidentifiable vendor would re-rate the whole estate upward on our own outage.

emailer.js
  getSmtpConfig(db) — THE single SMTP resolution point for every sender below. Delegates to
    suiteSmtp.resolveSmtp(db) (hub transport or this app's own row) and returns `.cfg`.
    Shape unchanged since 1.33: {host,port,secure,username,password,from_email,from_name,enabled}
    plus `source` ('hub'|'local') and `allow_self_signed` for buildTransport [SENSITIVE]
  invalidateSmtpCache() — clears suiteSmtp's cache (the only SMTP cache; emailer has none of
    its own since 1.34.0). Called by POST /api/smtp after a save
  mailErrorSummary(err) — code/responseCode-only summary of a nodemailer error [SENSITIVE].
    A raw nodemailer message embeds host, port, username and the server's auth rejection;
    this is what may be returned to an HTTP caller. Mirrors spanvault api/rbacScope.js
  sendTestEmail(db, toEmail) — send a one-off SMTP test message via nodemailer [SENSITIVE].
    Returns {ok:false, error:<mailErrorSummary>} — never the raw message (fixed 1.34.0)
  sendAlert(db, alert, recipients) — send alert email to each recipient via SMTP, success-gated audit log [SENSITIVE]
  sendDigest(db, alerts, recipient) — send hourly digest email via SMTP, success-gated audit log [SENSITIVE]
  sendReport(db, toEmail, subject, html, attachments) — send scheduled report email w/ attachments via SMTP [SENSITIVE]
  renderReportHtml(reportTitle, intro, meta) — build branded HTML body for a report email
  ackToken(alertId) — HMAC-SHA256(NEXTAUTH_SECRET) token for one-click alert acknowledge links [SENSITIVE]
  verifyAckToken(alertId, token) — timing-safe compare of an ack token against the expected HMAC [SENSITIVE]
  (module throws at load if NEXTAUTH_SECRET unset — no weak fallback secret; deliberate fail-loud)
  (buildTransport has ONE TLS rule for BOTH transports since 1.35.0: verify, unless the
   resolved config's `allow_self_signed === true`. The LOCAL path's historic UNCONDITIONAL
   `rejectUnauthorized:false` is GONE. Since the same release nothing in DDIVault can SET
   that flag locally — POST /api/smtp refuses the field and the Settings page has no control
   — so a local row's value is whatever it held, i.e. FALSE everywhere. The only remaining
   way to disable certificate checking is the hub's own tickbox, which arrives on the hub path)
  (sendTestEmail short-circuits with a plain "No mail server is configured. Set up the suite
   mail server in NetVault (Settings → Notifications)." when cfg is null OR cfg.host is
   blank — since 1.35.0 a row can legitimately exist with an empty host)
  (root dependency `nodemailer` is on ^9.1.1 since 1.35.0; mailErrorSummary's `e.code` /
   `e.responseCode` are both still set by v9's smtp-connection)

suiteSmtp.js  (added 1.34.0 — Phase 2 of the suite SMTP centralization)
  resolveSmtp(db) — {source:'hub'|'local', cfg, hub?}. Reads the NetVault hub's suite-wide
    smtp_config over its OWN pg pool (NETVAULT_DB_*, the `netvault` role — same shape as
    middleware/rbac.js; NOT api/server.js's netvaultDb, because the COLLECTOR process also
    loads emailer and has no such pool), decrypts the password with collector/credStore
    (same ivHex:authTagHex:cipherHex / sha256(NEXTAUTH_SECRET) format), and falls back to
    this app's own smtp_config row. Caches the whole resolution 5 min. `hub` is a
    password-free summary for the Settings UI [SENSITIVE]
  invalidateSuiteSmtpCache() — clear that cache (reached via emailer.invalidateSmtpCache)
  closeSuiteSmtpPool() — end the hub pool on shutdown; no-op if never created
  ⛔ EVERY hub-side failure is SOFT (fall back to local + warn once): missing
    NEXTAUTH_SECRET, Postgres 42P01 (hub not yet updated — expected mid-rollout), any other
    query/connection error, an undecryptable password, no row, enabled=false, blank host.
    The LOCAL read deliberately still propagates — a failure to read this app's own DB is a
    real fault and has always thrown.
  (credStore is required LAZILY behind a secret guard: it throws at module load without
   NEXTAUTH_SECRET by design, and this module must not add a new way for the collector to die)

licenseCheck.js
  fetchLicense() — GET {NOCVAULT_HUB_URL}/api/license with 10s abort timeout, no auth [SENSITIVE]
  getLicense(forceRefresh=false) — 5-minute in-memory cache wrapper around fetchLicense [SENSITIVE]
  getLicenseState(license) — pure mapping of license status -> {mode,canWrite,canRead,disabled}; no I/O
  (hubUrl fallback 'http://localhost:3000' is a URL default, not a secret — no weak-fallback-secret pattern found)

ouiLookup.js
  lookupOUI(mac) — {state,vendor,prefix,bits,type}; state ∈ known|private|registry_block|unassigned|unreadable.
    ⛔ vendor is non-null ONLY for state='known'. ⛔ LONGEST PREFIX FIRST (9, then 7, then 6 hex chars): IEEE
    assigns at /24, /28 and /36, and 443 blocks are the registrar's own with 13,841 real assignments beneath.
  lookupMac(mac) — the raw contract; the matching feed row or null. ⛔ <12 hex chars returns null (a prefix is
    not a MAC: "00:00:0C" would otherwise match the Cisco /24 exactly and answer confidently)
  normalize(s) — strip every non-hex character, uppercase
  catalogueStatus() — provenance {state, source: hub-feed|bundled-seed, feed_version, row_count, errors[]}
  deviceTypeFor(vendor) — coarse device type derived from the vendor NAME (the feed carries none); memoised
  cachePath() / seedPath() — env-overridable (DDIVAULT_OUI_CACHE / DDIVAULT_OUI_SEED), for tests
  reload() — drop cached catalogue state; MATCH_VERSION — the contract this build implements
  Unit tested in tests/oui.test.js (26 assertions, no DB and no network required).

ouiFeed.js
  syncOuiFeed({force}) — fetch+verify the hub's signed OUI catalogue; resolves {action: updated|unchanged|failed}
    and NEVER throws. ⛔ A failed sync leaves the existing catalogue byte-identical; it never clears or truncates.
    ⛔ Skips the 2.2 MB body when /latest reports the feed_version already held.
  fetchVerifiedFeed() — {body,feed,sha256,signature}; throws unless sha256 + Ed25519 + row_count + match_version
    all pass. Mirrors net-vault/lib/eolFeed.ts — same host, same signing key, same headers.
  fetchLatest() / localPointer() / sigPathFor(seed) / FEED_PUBLIC_KEY_B64 / DEFAULT_FEED_URL

pdfCharts.js
  renderTrendChart(doc, opts) — draw a utilization-over-time line/area chart into a pdfkit doc within a given box

api/middleware/rbac.js
  requireRole(minRole) — middleware factory: 401 if no user, 403 if role level < minRole
  requireWrite(req, res, next) — requireRole('admin') shortcut
  requireSuperAdmin(req, res, next) — requireRole('super_admin') shortcut
  requireAuth(req, res, next) — requireRole('viewer') shortcut (any authenticated user)
  attachSiteFilter(req, res, next) — sets req.currentUser + req.allowedSiteIds (site_admin scoping)
  getAllowedSiteIds(userId, role) — queries NetVault user_sites for a site_admin's allowed site_ids (null = unrestricted)
  getRequestUser(req) — resolve acting user from req.apiKey or x-ddi-actor* headers (trusts headers verbatim — verified upstream)
  getRoleLevel(role) — map role name to numeric hierarchy level (super_admin=4..viewer=1)

api/middleware/audit.js
  auditContext(db) — middleware factory: attaches req._auditActor + req.audit(), auto-logs unaudited mutating routes on response finish
  writeAudit(db, entry) — low-level INSERT into audit_log; swallows all errors, returns id or null
  ACTIONS — frozen enum object of audit action names (create/modify/delete/scan/import/export/test/login/logout/reserve/release/acknowledge)

v1-envelope.js
  ok(res, data, meta) / fail(res, status, code, message, details) / pageMeta(total, page, limit) /
    reqId() — the /api/v1/* response envelope (extracted from v1.js so the error path is testable)
  internalError(res, scope, err) — logs the real error, returns a FIXED 500 message. Every v1
    catch uses this; never `e.message`, which carries raw Postgres text (table/column/constraint
    names) to an API-key holder. Unit tested in tests/v1Envelope.test.js.
  GENERIC_500 — the one message every v1 500 returns

api/middleware/apiAuth.js
  apiAuth(db, requiredPerm) — middleware factory: extracts+SHA-256-hashes API key, looks up api_keys, checks active/expiry/IP-allowlist/permission/rate-limit [SENSITIVE]
  generateKey() — generates a new plaintext API key + its key_prefix + SHA-256 key_hash [SENSITIVE]
  sha256(str) — SHA-256 hex digest helper used for API key hashing [SENSITIVE]
  maskedDisplay(prefix) — cosmetic masked key display string, e.g. "ddiv_live_a8f3k2****"
  KEY_PREFIX — const 'ddiv_live_', the required API key prefix

## Frontend (frontend/src/lib/)

auth.ts
  authOptions — NextAuthOptions config: CredentialsProvider w/ SSO-token path (fetches {HUB_URL}/api/auth/sso-verify) and direct email/password path (bcrypt.compare against netvault users.password_hash), jwt/session callbacks persisting role+id+apps claim, secret: NEXTAUTH_SECRET, 8h JWT session [SENSITIVE]
  (internal, not exported: ssoApps(token) — decodes apps[] claim from an already-hub-verified JWT payload, no signature check by design)
  (no weak-fallback-secret pattern found — `secret: process.env.NEXTAUTH_SECRET` has no `|| 'default'`; NETVAULT_DB_PASS falls back to '' not a guessable literal)

hubUrl.ts
  getHubUrl() — client-side hub origin from window.location (falls back to NEXT_PUBLIC_NOCVAULT_HUB_URL env when no window)

publicUrl.ts
  resolveOrigin(req, port, legacyFallback) — server-side hub/app origin derived from request's x-forwarded-host/host + x-forwarded-proto, validated against a hostname regex; falls back to legacyFallback

settingsFormStyles.ts
  INPUT — shared inline-style object for Settings form text inputs
  LABEL — shared inline-style object for Settings form field labels
  INPUT_SM — INPUT variant capped maxWidth:140 (short values)
  INPUT_MD — INPUT variant capped maxWidth:220 (medium values)
  FORM_ROW — flex-wrap container style replacing CSS grid for form rows
  FIELD_GROW — flex:'1 1 220px', field grows to fill remaining row space
  FIELD_FIXED — flex:'0 0 auto', field sizes to content
  FIELD_FULL — flexBasis:'100%', forces a full-row line break in a flex-wrap row

(lib) frontend/src/lib/corners.ts — rounded/square corner switch. getCorners/applyCorners/toggleCorners/CORNERS_INIT_SCRIPT. Key ddivault-corners, event ddivault:corners, attribute data-corners="square" on <html> (rounded = ABSENCE of the attribute, there is no [data-corners="rounded"] rule). Works by overriding --radius/--radius-sm/--radius-pill only, so ANY hardcoded numeric borderRadius opts that component out SILENTLY — always use the token.

## collector/dns/ — Linux & third-party DNS providers (1.37.0)
Protocol-first: records come from the DNS protocol itself, vendor channels only for what the protocol cannot
express. No SSH, no agent and no config parsing on the customer's DNS server.
- `wire.js` — RFC 8945 TSIG (sign/verify) + canonical name encoding. ⛔ `dns-packet` has NO TSIG support;
  `dnsPacket.record('TSIG')` returns the generic opaque-rdata fallback, which looks like support and is not.
  Exports `nameToWire, signMessage, splitTsig, verifyEnvelope, normaliseAlgo, hmacAlgoFor`.
- `client.js` — `querySoa()` (UDP, TCP fallback) and `axfr()` (TCP, TSIG-verified, bounded). Pure Node because
  **DDIVault runs on Windows, where `dig` does not exist.**
- `records.js` — `relativise/normaliseRecord/normaliseZone/isReverseZone`. ⛔ Relativises FQDNs to the zone
  because dns_records' unique key is (zone_id, hostname, record_type, record_data): an FQDN would not collide
  with the Windows row for the same record, it would DOUBLE it.
- `capabilities.js` — `supported` / `not_applicable` / `not_available` / `unknown` + the per-platform MATRIX.
- `providers/bind.js` — AXFR + statistics-channel. ⛔ Filters BIND's four builtin pseudo-zones.
- `providers/powerdns.js` — REST API (not AXFR, deliberately: one credential, one path). ⛔ Expands rrsets.
- `sync.js` — `syncProtocolDns()`; adapts to writers.js rather than changing it, and gates transfers on the
  SOA serial (339 zones / 256,951 records in production — transferring all of them every cycle is the
  difference between a feature and an outage).
- `index.js` — `providerFor/isProtocolPlatform/serverContext`. ⛔ 'windows' returns null ON PURPOSE: that is
  the signal to use the existing PowerShell path, which exposes scavenging/aging/AD data AXFR cannot.

## api/serverFields.js (1.37.0)
`normaliseDnsPlatform()` (unknown -> null -> HTTP 400, never defaulted) and `shouldReplaceSecret()`
(empty/mask -> false). Extracted from server.js purely so both can be unit-tested: each fails silently and
destructively.

### collector/dns/ additions (1.38.0)
- `health.js` — `probeProtocolHealth(db, server)`. ⛔ Exists because scoring every server
  by `testWinRM` is a category error: a BIND host has no WinRM, so a server we were
  successfully collecting scored 50 and rendered DEGRADED. Scores on the DNS protocol
  instead. A server with no zones yet is NOT penalised.
- `readiness.js` — `testProtocolServer(server)`. The platform-aware "Test Connection".
  Returns a per-check breakdown; every failure carries the literal `named.conf`/`pdns.conf`
  that fixes it. ⛔ The summary names the FIRST failure — the checks are
  dependency-ordered, so a count reports one problem several times.
- `stats.js` — `recordQueryStats(db, server, sample)`. Turns cumulative counters into the
  interval rows `dns_query_stats` expects. ⛔ A counter that went DOWN is a restart: the
  interval is recorded as NULL (unknowable), never negative, 0, or the raw new value.
- `wire.js` — gained `tsigErrorText()`: "TSIG error 16" is a wrong secret and 17 a wrong
  key name, two different one-line fixes.

### collector/dns/providers/generic.js (1.39.0)
Knot, NSD and anything else that speaks AXFR. ⛔ NOT a lesser provider — verified against
Knot 3.6.2, records/SOA/TSIG behave identically to BIND with zero code changes. The only
thing missing is zone ENUMERATION: Knot's control interface is a UNIX socket and NSD's
needs client certificates, so the operator supplies the list (`ddi_servers.dns_zone_list`,
parsed tolerantly by `parseZoneList()`). A configured zone that does not answer is named
in an `isPartial` error carrying `partial` — sync keeps what worked.
