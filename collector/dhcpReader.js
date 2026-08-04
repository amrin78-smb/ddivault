'use strict';

/**
 * dhcpReader.js
 * Reads and parses Windows DHCP Server audit log files.
 *
 * Log format: CSV with header rows starting with "ID,Date,Time,Description,..."
 * Log path: \\SERVER\DHCPLogs\DhcpSrvLog-Mon.log  (or local path)
 *
 * Event IDs: see EVENT_MAP below — it is the single source of truth and was
 * corrected against Microsoft's published table on 2026-08-04. This header used
 * to carry its own (contradictory, largely wrong) id list; don't reintroduce one.
 *
 * TRANSPORT: the log can be read either from a file path (UNC share or local dir,
 * via readDhcpLog) or pulled over the server's existing WinRM channel and handed
 * to parseLines(). WinRM is the default because it needs no share, no extra ACL
 * and no particular service-account identity — see collector.js syncDhcpLogs().
 */

const fs   = require('fs');
const path = require('path');

// ⛔ Read these from process.env at CALL time, never capture them in a module
// const. collector.js rewrites DHCP_LOG_UNC per server (substituting the
// 192.168.x.x token for that server's IP) AFTER this module is required — a
// captured const silently ignores every one of those rewrites, which is why the
// override path only ever tried the literal token and never worked on any
// install. Proven 2026-08-04: env correctly became \\172.24.0.10\DHCPLogs while
// the reader still used \\192.168.x.x\.
const dhcpLogUnc   = () => (process.env.DHCP_LOG_UNC   || '').trim();
const dhcpLogLocal = () => (process.env.DHCP_LOG_LOCAL || '').trim();

// Distinct read failures already reported this run — see readDhcpLog(). Without
// this the reader logs the same line every poll cycle forever.
const loggedReadFailures = new Set();

// Map event IDs to human labels and severity
const EVENT_MAP = {
  // ── Windows DHCP server AUDIT LOG ids (the DhcpSrvLog-<Day>.log files) ──
  // ⛔ CONTRACT: this map is duplicated in ddivault/collector/dhcpReader.js and
  // netvault/agent/modules/ddi/dhcplog.js. Central and agent collection write to
  // the SAME dhcp_events table, so a difference here means the same event is
  // classified two ways depending on who collected it. Change both together.
  //
  // Verified against Microsoft's published id table using a live 300-line sample
  // (2026-08-04). Several entries were previously WRONG, not merely missing:
  // id 30 is a DNS update REQUEST but was reported as 'DNSFailed' (64 of 300
  // lines), while the genuine failures (31/35) fell through to 'Unknown' — so
  // DNS failures were simultaneously over- and under-counted. 13/14/16/20/34
  // were mislabelled too, and 68% of the sample parsed as 'Unknown'.
  0:    { type: 'LogStarted',         severity: 'info' },
  1:    { type: 'LogStopped',         severity: 'info' },
  2:    { type: 'LogPaused',          severity: 'warning' },   // low disk space
  10:   { type: 'Assign',             severity: 'info' },
  11:   { type: 'Renew',              severity: 'info' },
  12:   { type: 'Release',            severity: 'info' },
  13:   { type: 'AddressInUse',       severity: 'warning' },   // conflict seen on the wire
  14:   { type: 'PoolExhausted',      severity: 'critical' },
  15:   { type: 'NACK',               severity: 'warning' },   // lease denied
  16:   { type: 'LeaseDeleted',       severity: 'info' },
  17:   { type: 'Expired',            severity: 'info' },      // DNS records retained
  18:   { type: 'Expired',            severity: 'info' },      // DNS records deleted
  20:   { type: 'BootpAssign',        severity: 'info' },
  21:   { type: 'BootpAssign',        severity: 'info' },      // dynamic BOOTP
  22:   { type: 'BootpPoolExhausted', severity: 'critical' },
  23:   { type: 'BootpDeleted',       severity: 'info' },
  24:   { type: 'CleanupBegin',       severity: 'info' },
  25:   { type: 'CleanupStats',       severity: 'info' },
  30:   { type: 'DNSUpdate',          severity: 'info' },      // request issued
  31:   { type: 'DNSFailed',          severity: 'warning' },
  32:   { type: 'DNSUpdateOk',        severity: 'info' },
  33:   { type: 'PacketDropped',      severity: 'warning' },   // NAP policy
  34:   { type: 'DNSQueueLimit',      severity: 'warning' },
  35:   { type: 'DNSFailed',          severity: 'warning' },
  36:   { type: 'PacketDropped',      severity: 'warning' },   // failover standby
  // ── Windows EVENT LOG ids (not audit-log) — consumed by extractAlertEvents ──
  1013: { type: 'ScopeActive',        severity: 'info' },
  1014: { type: 'ScopeInactive',      severity: 'warning' },
  1016: { type: 'ScopeWarning',       severity: 'warning' },
  1020: { type: 'ScopeFull',          severity: 'critical' },
  2019: { type: 'RogueDHCP',          severity: 'critical' },
};

/**
 * Returns the Windows day-of-week name for a given Date.
 * Windows DHCP logs rotate daily: DhcpSrvLog-Mon.log, ..., DhcpSrvLog-Sun.log
 */
function dayFileName(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `DhcpSrvLog-${days[date.getDay()]}.log`;
}

/**
 * Build the log file path for a given date.
 * Uses UNC path if set, otherwise local path.
 */
function logFilePath(date) {
  const fileName = dayFileName(date);
  const unc = dhcpLogUnc();
  if (unc) {
    return `${unc.replace(/\\+$/, '')}\\${fileName}`;
  }
  const local = dhcpLogLocal();
  if (local) {
    return path.join(local, fileName);
  }
  // Default Windows DHCP log location (only correct when running ON the DHCP server)
  return path.join('C:\\Windows\\System32\\dhcp', fileName);
}

/**
 * Parse raw log TEXT into events. Transport-agnostic: the same parser serves a
 * file read and a WinRM `Get-Content` pull, so both routes classify identically.
 * @param {string} text
 * @returns {Array<object>}
 */
function parseLines(text) {
  if (!text) return [];
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parsed = parseLine(line.trim());
    if (parsed) events.push(parsed);
  }
  return events;
}

/**
 * Parse a single line from a DHCP log file.
 * Windows DHCP log CSV columns:
 *   ID, Date, Time, Description, IP Address, Host Name, MAC Address, User Name, TransactionID, QResult, Probationtime, CorrelationID, Dhcid
 *
 * @param {string} line
 * @returns {object|null}
 */
function parseLine(line) {
  if (!line || line.startsWith('ID') || line.startsWith('Microsoft') ||
      line.startsWith('QResult') || line.trim() === '') {
    return null;
  }

  const parts = line.split(',');
  if (parts.length < 7) return null;

  const eventId = parseInt(parts[0]);
  if (isNaN(eventId)) return null;

  const dateStr = (parts[1] || '').trim();
  const timeStr = (parts[2] || '').trim();
  const desc    = (parts[3] || '').trim();
  const ip      = (parts[4] || '').trim() || null;
  const host    = (parts[5] || '').trim() || null;
  const mac     = (parts[6] || '').trim() || null;

  // Parse event time — Windows DHCP log format: MM/DD/YY, HH:MM:SS
  let eventTime = null;
  try {
    const [m, d, y] = dateStr.split('/');
    const fullYear = parseInt(y) < 100 ? `20${y}` : y;
    eventTime = new Date(`${fullYear}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${timeStr}`);
    if (isNaN(eventTime.getTime())) eventTime = null;
  } catch (_) {
    eventTime = null;
  }

  const meta = EVENT_MAP[eventId] || { type: 'Unknown', severity: 'info' };

  return {
    event_id:    eventId,
    event_type:  meta.type,
    severity:    meta.severity,
    ip_address:  ip || null,
    hostname:    host || null,
    mac_address: mac || null,
    description: desc || null,
    event_time:  eventTime ? eventTime.toISOString() : null,
    raw_line:    line,
  };
}

/**
 * Read and parse a DHCP log file.
 * @param {Date}   date      - which day's log to read (default: today)
 * @param {number} maxLines  - max lines to read from end (for tailing)
 * @returns {Array<object>}  - array of parsed event objects
 */
function readDhcpLog(date, maxLines) {
  const filePath = logFilePath(date || new Date());

  let content;
  try {
    content = fs.readFileSync(filePath, { encoding: 'utf8' });
  } catch (err) {
    // Log each distinct failure ONCE per process, not once per poll. This runs on
    // a ~50s cadence, so an unreachable or misconfigured share produced an endless
    // identical stream — 3,593 lines on the production box, which buries every
    // other collector error and tells the operator nothing new after the first.
    // Keyed by path+code so a genuinely NEW problem still surfaces immediately.
    const key = `${filePath}|${err.code || 'ERR'}`;
    if (!loggedReadFailures.has(key)) {
      loggedReadFailures.add(key);
      if (err.code === 'ENOENT') {
        console.warn(`[DHCP Reader] Log file not found: ${filePath} (further occurrences suppressed)`);
      } else {
        // Windows reports an unreachable share as an opaque "UNKNOWN: unknown
        // error", which sends people hunting for a network fault. Say what it
        // actually means.
        //
        // NOTE: an unsubstituted 192.168.x.x here is NOT an operator mistake —
        // it is a TOKEN collector.js rewrites per server. Seeing it means the
        // substitution did not reach this reader, which is a code bug, not a
        // config one. (The previous version of this hint told operators to
        // hardcode a real IP over the token, which would have broken multi-server
        // support.) Reaching this path at all is now unusual: the override is
        // only used when DHCP_LOG_UNC/LOCAL is set — otherwise the log is pulled
        // over WinRM and never touches SMB.
        const unsubstituted = /\bx\.x\b/i.test(filePath);
        const hint = unsubstituted
          ? ' — the 192.168.x.x token was not substituted for this server; that is an internal bug, not a setting to edit. Clear DHCP_LOG_UNC to fall back to WinRM collection, which needs no share.'
          : ' — check the share exists and that the account the DDIVault collector service runs as (LocalSystem = this machine account) can read it; clearing DHCP_LOG_UNC falls back to WinRM collection, which needs neither';
        console.error(`[DHCP Reader] Error reading ${filePath}: ${err.message}${hint} (further occurrences suppressed)`);
      }
    }
    return [];
  }

  let lines = content.split('\n');

  // If maxLines set, only process tail
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(-maxLines);
  }

  const events = [];
  for (const line of lines) {
    const parsed = parseLine(line.trim());
    if (parsed) events.push(parsed);
  }

  return events;
}

/**
 * Read only events since a given timestamp (for incremental polling).
 * @param {Date} since  - only return events after this time
 * @param {Date} date   - which log file to read (default: today)
 * @returns {Array}
 */
function readDhcpLogSince(since, date) {
  const all = readDhcpLog(date || new Date());
  if (!since) return all;
  return all.filter(e => e.event_time && new Date(e.event_time) > since);
}

/**
 * Read today's + yesterday's logs and return all events.
 * Useful at midnight rollover to not miss events.
 */
function readRecentLogs() {
  const today     = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const todayEvents     = readDhcpLog(today);
  const yesterdayEvents = readDhcpLog(yesterday);

  return [...yesterdayEvents, ...todayEvents];
}

/**
 * Extract scope-full and scope-warning events from a list of events.
 * Used to fire alerts immediately.
 */
function extractAlertEvents(events) {
  return events.filter(e =>
    e.event_id === 1020 ||   // scope full
    e.event_id === 1016 ||   // scope 80% warning
    e.event_id === 2019 ||   // rogue DHCP
    e.event_id === 34         // conflict
  );
}

module.exports = {
  readDhcpLog,
  readDhcpLogSince,
  parseLines,
  readRecentLogs,
  extractAlertEvents,
  parseLine,
  logFilePath,
  dayFileName,
  EVENT_MAP,
};
