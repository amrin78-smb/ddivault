'use strict';

/**
 * dhcpReader.js
 * Reads and parses Windows DHCP Server audit log files.
 *
 * Log format: CSV with header rows starting with "ID,Date,Time,Description,..."
 * Log path: \\SERVER\DHCPLogs\DhcpSrvLog-Mon.log  (or local path)
 *
 * Event IDs reference:
 *   10  = Assign          (new lease)
 *   11  = Renew           (lease renewed)
 *   12  = Release         (client released)
 *   13  = DNS Update (A)
 *   14  = DNS Update (PTR)
 *   15  = NACK            (server refused)
 *   16  = DNS Delete (A)
 *   17  = DNS Delete (PTR)
 *   20  = Expired
 *   21  = Database cleanup
 *   30  = DNS Update failed
 *   31  = DNS Update failed PTR
 *   32  = DNS Update succeeded
 *   33  = PTR Update succeeded
 *   34  = Lease deleted on conflict
 *   35  = DNS Update failed (generic)
 *   36  = Packet dropped (class mismatch)
 *  1000 = Service started
 *  1001 = Service stopped
 *  1002 = Service paused
 *  1003 = Service continued
 *  1004 = Service initialized
 *  1005 = Service already running
 *  1008 = DB backup started
 *  1009 = DB backup done
 *  1010 = DB restore started
 *  1011 = DB restore done
 *  1012 = DHCPv4 log created
 *  1013 = Scope activation
 *  1014 = Scope deactivation
 *  1016 = Scope 80% full (WARNING)
 *  1020 = Scope 100% full (CRITICAL)
 *  2019 = Rogue DHCP server detected (CRITICAL)
 */

const fs   = require('fs');
const path = require('path');

const DHCP_LOG_UNC      = process.env.DHCP_LOG_UNC      || '';
const DHCP_LOG_LOCAL    = process.env.DHCP_LOG_LOCAL    || '';

// Map event IDs to human labels and severity
const EVENT_MAP = {
  10:   { type: 'Assign',        severity: 'info' },
  11:   { type: 'Renew',         severity: 'info' },
  12:   { type: 'Release',       severity: 'info' },
  13:   { type: 'DNSUpdate',     severity: 'info' },
  14:   { type: 'DNSUpdate',     severity: 'info' },
  15:   { type: 'NACK',          severity: 'warning' },
  16:   { type: 'DNSDelete',     severity: 'info' },
  20:   { type: 'Expired',       severity: 'info' },
  30:   { type: 'DNSFailed',     severity: 'warning' },
  34:   { type: 'Conflict',      severity: 'critical' },
  1013: { type: 'ScopeActive',   severity: 'info' },
  1014: { type: 'ScopeInactive', severity: 'warning' },
  1016: { type: 'ScopeWarning',  severity: 'warning' },
  1020: { type: 'ScopeFull',     severity: 'critical' },
  2019: { type: 'RogueDHCP',     severity: 'critical' },
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
  if (DHCP_LOG_UNC) {
    return `${DHCP_LOG_UNC}\\${fileName}`;
  }
  if (DHCP_LOG_LOCAL) {
    return path.join(DHCP_LOG_LOCAL, fileName);
  }
  // Default Windows DHCP log location (if running on DHCP server)
  return path.join('C:\\Windows\\System32\\dhcp', fileName);
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
    if (err.code === 'ENOENT') {
      console.warn(`[DHCP Reader] Log file not found: ${filePath}`);
    } else {
      console.error(`[DHCP Reader] Error reading ${filePath}:`, err.message);
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
  readRecentLogs,
  extractAlertEvents,
  parseLine,
  logFilePath,
  dayFileName,
  EVENT_MAP,
};
