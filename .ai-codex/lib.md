## Backend (api/)

alertDispatcher.js
  dispatchAlert(db, alert, ruleType) — route one alert to filtered recipients (rule/cooldown/severity/site), sends via emailer or defers to digest
  sendHourlyDigest(db) — gather last-60min un-emailed alerts, send one digest per recipient matching their filters

csv.js
  escapeCsvCell(v) — RFC-4180 quote + formula-injection guard for a single CSV cell

deviceClassifier.js
  classifyDevice(mac, hostname) — best-effort device type/os/icon/vendor/risk from OUI + hostname pattern
  isMacRandomized(mac) — checks locally-administered bit on MAC first octet

emailer.js
  getSmtpConfig(db) — load+cache (5min) SMTP config row, decrypts stored password via collector/credStore.decrypt [SENSITIVE]
  invalidateSmtpCache() — clear the in-memory SMTP config cache
  sendTestEmail(db, toEmail) — send a one-off SMTP test message via nodemailer [SENSITIVE]
  sendAlert(db, alert, recipients) — send alert email to each recipient via SMTP, success-gated audit log [SENSITIVE]
  sendDigest(db, alerts, recipient) — send hourly digest email via SMTP, success-gated audit log [SENSITIVE]
  sendReport(db, toEmail, subject, html, attachments) — send scheduled report email w/ attachments via SMTP [SENSITIVE]
  renderReportHtml(reportTitle, intro, meta) — build branded HTML body for a report email
  ackToken(alertId) — HMAC-SHA256(NEXTAUTH_SECRET) token for one-click alert acknowledge links [SENSITIVE]
  verifyAckToken(alertId, token) — timing-safe compare of an ack token against the expected HMAC [SENSITIVE]
  (module throws at load if NEXTAUTH_SECRET unset — no weak fallback secret; deliberate fail-loud)
  (imports decrypt from ../collector/credStore — AES-256-GCM cred decryption, out of scope here, see collector/credStore.js)

licenseCheck.js
  fetchLicense() — GET {NOCVAULT_HUB_URL}/api/license with 10s abort timeout, no auth [SENSITIVE]
  getLicense(forceRefresh=false) — 5-minute in-memory cache wrapper around fetchLicense [SENSITIVE]
  getLicenseState(license) — pure mapping of license status -> {mode,canWrite,canRead,disabled}; no I/O
  (hubUrl fallback 'http://localhost:3000' is a URL default, not a secret — no weak-fallback-secret pattern found)

ouiLookup.js
  lookupOUI(mac) — look up vendor/type by MAC OUI prefix in bundled data/oui.json

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
