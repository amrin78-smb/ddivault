'use strict';
/**
 * ouiLookup.js — resolve a MAC address to the organisation IEEE assigned it to.
 *
 * The catalogue comes from the NocVault EOL hub's signed OUI feed
 * (`api/ouiFeed.js` fetches and verifies it). This module only READS a
 * catalogue — it never fetches, so a lookup can never block on the network.
 *
 * ⛔ LONGEST PREFIX FIRST, AND IT IS A PRECONDITION OF USING THIS FEED AT ALL.
 * IEEE assigns at THREE lengths — MA-L /24 (40,497), MA-M /28 (6,688) and MA-S
 * /36 (7,281) — and 443 of those blocks belong to "IEEE Registration Authority"
 * itself, with 13,841 MA-M/MA-S assignments underneath them.
 *
 * ⛔ THE OLD BEHAVIOUR AND THE NEW RISK ARE NOT THE SAME FAILURE, AND THE
 * DIFFERENCE IS WHY THIS COMMENT EXISTS. The previous implementation read 6 hex
 * characters and stopped, against a catalogue built from Wireshark's `manuf` —
 * which does not carry the registrar's own /24 rows, and whose /28 and /36 rows
 * the parser discarded ("skip /28, /36 longer assignments — ambiguous"). So all
 * 13,841 of those devices came out as "Unknown". A miss: visibly nothing, and
 * it invites a look.
 *
 * The hub's feed DOES carry all 443 registrar rows. Pointing a 24-bit-only
 * lookup at it would turn every one of those misses into a CONFIDENT WRONG
 * ANSWER — `001BC5000` is Converging Systems Inc. and it would report "IEEE
 * Registration Authority", which reads as a vendor and gets acted on. Adopting
 * a richer catalogue with the old lookup would have made the product worse.
 * Try 9, then 7, then 6.
 *
 * ⛔ FOUR OUTCOMES, AND COLLAPSING ANY TWO LOSES THE ONLY ACTIONABLE ONE:
 *   known          — IEEE named an organisation. The only case with a vendor.
 *   private        — IEEE's record literally says "Private" (217 rows today).
 *                    The assignee exists and withheld their name ON PURPOSE.
 *   registry_block — the only match is a registrar block. The correct answer is
 *                    "unknown vendor", NEVER "IEEE Registration Authority".
 *   unassigned     — no row at any length. IEEE has not handed this prefix out.
 * and separately `unreadable`, which means WE failed, not that IEEE said
 * anything. "Nobody owns this", "the owner is withheld" and "we could not read
 * the catalogue" are three different facts about the network.
 *
 * ⛔ `match_version` IS A COMPATIBILITY GATE, NOT A LABEL. The hub publishes it
 * so a consumer can tell that the ALGORITHM below no longer matches the data.
 * Running these fixed [9,7,6] steps against a feed built for different ones
 * would produce wrong vendors silently, so a mismatch REFUSES the feed and
 * falls back rather than "mostly working".
 */

const fs = require('fs');
const path = require('path');

/** The matching contract this file implements. See the header. */
const MATCH_VERSION = 1;

/** Prefix lengths in hex characters: MA-S /36, MA-M /28, MA-L /24. */
const PREFIX_STEPS = [9, 7, 6];

/**
 * The catalogue that ships in the repo. Overridable only so the tests can
 * force the "no catalogue at all" branch, which is otherwise unreachable while
 * a seed is committed — and that branch is the one that must not be guessed at.
 */
function seedPath() {
  return process.env.DDIVAULT_OUI_SEED || path.join(__dirname, '..', 'data', 'oui-seed.json');
}

/**
 * ⛔ THE CACHE CANNOT LIVE IN THE REPO. `Update-DDIVault.ps1` runs
 * `git clean -fd` with only `.env.local`, `node_modules` and `*.lastgood`
 * excluded, so anything else untracked is deleted on every single deploy. A
 * cache under `data/` would be wiped each release and silently re-downloaded;
 * worse, it would look like it was working. `C:\ProgramData\NocVault` is where
 * this suite already keeps per-machine state that outlives a release (the agent
 * TLS pins and secrets.env both live there).
 */
function cachePath() {
  if (process.env.DDIVAULT_OUI_CACHE) return process.env.DDIVAULT_OUI_CACHE;
  if (process.platform === 'win32') {
    const base = process.env.ProgramData || 'C:\\ProgramData';
    return path.join(base, 'NocVault', 'ddivault', 'oui-feed.json');
  }
  return path.join(__dirname, '..', 'data', 'cache', 'oui-feed.json');
}

// ── device type, derived from the vendor NAME ────────────────────────────────
// The feed is a verbatim copy of the IEEE registry and carries no device type —
// IEEE does not record one. These are the heuristics that used to be baked into
// data/oui.json by scripts/update-oui.js + scripts/expand-oui.js, moved here so
// the type is derived from whatever vendor name the live feed carries rather
// than frozen at the moment a file was generated.
//
// ⛔ RECLASSIFICATION ONLY, NEVER FABRICATION. expand-oui.js carried the reason
// and it still holds: an audit of hand-recalled OUI prefixes against the real
// IEEE data found a ~25% misattribution rate, so no prefix is ever hand-added
// and no vendor name is ever invented. Every answer here is a function of a
// name IEEE published.

/** First match wins. Corrections for classes the broad heuristic gets wrong. */
const TYPE_OVERRIDES = [
  { type: 'voip',     re: /polycom|yealink|grandstream|avaya|mitel|\bsnom\b|audiocodes|sangoma|spectralink|gigaset/i },
  { type: 'printer',  re: /\bzebra\b|honeywell|datalogic|\bsato\b|\bintermec\b|primera|dymo|brady/i },
  { type: 'printer',  re: /canon|epson|xerox|ricoh|konica|brother|lexmark|kyocera|\bsharp\b|\boki\b|pantum/i },
  { type: 'network',  re: /cisco|juniper|aruba|arista|fortinet|palo alto|ubiquiti|meraki|netgear|tp-?link|d-?link|mikrotik|ruckus|extreme network|zyxel|brocade|\bh3c\b|sonicwall|watchguard|hewlett packard enterprise|ruijie|cambium|aerohive/i },
  { type: 'mobile',   re: /apple|samsung|xiaomi|guangdong oppo|vivo mobile|oneplus|motorola mobility|lg electronics|sony mobile|\bhtc\b|realme|transsion/i },
  { type: 'computer', re: /dell|lenovo|hewlett-packard|\bhp inc\b|asustek|\bacer\b|micro-star|\bmsi\b|gigabyte|super ?micro|vmware|intel corp|microsoft corp|fujitsu|toshiba|pegatron|wistron|compal|quanta|clevo|hon hai|framework computer/i },
];

/** The broader fallback, for names no override claims. */
function baseVendorType(name) {
  const n = (name || '').toLowerCase();
  if (!n) return 'consumer';
  if (/polycom|yealink|grandstream|avaya|mitel|\bsnom\b|audiocodes|sangoma|cisco systems.*phone|gigaset/.test(n)) return 'voip';
  if (/cisco|juniper|aruba|arista|fortinet|palo alto|ubiquiti|meraki|netgear|tp-?link|d-?link|mikrotik|ruckus|extreme network|zyxel|brocade|\bh3c\b|sonicwall|watchguard|hewlett packard enterprise|ruijie|cambium|aerohive|huawei techn/.test(n)) return 'network';
  if (/canon|epson|xerox|ricoh|konica|brother|lexmark|kyocera|\bsharp\b|\boki\b|toshiba tec|zebra|honeywell|datalogic|\bsato\b|primera|dymo/.test(n)) return 'printer';
  if (/apple/.test(n)) return 'mobile';
  if (/samsung|xiaomi|oppo|vivo mobile|oneplus|\bgoogle\b|motorola|lg electronics|sony mobile|\bhtc\b|nokia|realme|\btcl\b|guangdong|transsion/.test(n)) return 'mobile';
  if (/dell|lenovo|hewlett-packard|\bhp inc\b|asustek|\basus\b|\bacer\b|micro-star|\bmsi\b|gigabyte|super ?micro|vmware|intel|microsoft|fujitsu|toshiba|framework computer|pegatron|wistron|compal|quanta|clevo|biostar|parallels|xensource|qemu|virtualbox/.test(n)) return 'computer';
  if (/hikvision|dahua|axis communications|amazon tech|\bnest\b|\bring\b|espressif|raspberry|tuya|sonoff|signify|philips lighting|bosch|hanwha|uniview|reolink/.test(n)) return 'iot';
  return 'consumer';
}

/**
 * ⛔ DERIVED LAZILY AND MEMOISED, not precomputed over the whole catalogue.
 * Running seven regexes across 54,466 rows at every process start costs real
 * time for answers almost none of which are ever asked for — a scan sees a few
 * hundred distinct prefixes, not fifty thousand.
 */
const _typeCache = new Map();
function deviceTypeFor(vendor) {
  if (!vendor) return 'unknown';
  const hit = _typeCache.get(vendor);
  if (hit) return hit;
  let type = null;
  for (const ov of TYPE_OVERRIDES) {
    if (ov.re.test(vendor)) { type = ov.type; break; }
  }
  if (!type) type = baseVendorType(vendor);
  _typeCache.set(vendor, type);
  return type;
}

// ── catalogue loading ────────────────────────────────────────────────────────

let _table = null;          // Map<prefix, row>
let _tuple = null;          // { prefix, prefix_bits, org, is_registry_block }
let _status = null;         // provenance, for diagnostics
let _checkedAt = 0;         // last time we stat()ed the cache
let _cacheMtime = 0;        // mtime of the cache we loaded, if any

/** How often a loaded catalogue re-checks the cache file for a newer sync. */
const RELOAD_CHECK_MS = 60 * 1000;

/**
 * Parse and VALIDATE a feed body. Throws on anything that would make the
 * catalogue quietly wrong rather than obviously broken.
 */
function parseCatalogue(raw) {
  const feed = JSON.parse(raw);

  if (!Array.isArray(feed.tuple)) throw new Error('feed has no tuple field');
  const T = {};
  feed.tuple.forEach((name, i) => { T[name] = i; });
  for (const field of ['prefix', 'prefix_bits', 'org', 'is_registry_block']) {
    if (typeof T[field] !== 'number') throw new Error(`tuple does not name ${field}`);
  }
  if (!Array.isArray(feed.entries)) throw new Error('feed has no entries array');

  // ⛔ A SHORT READ PARSES PERFECTLY. A truncated download is still valid JSON
  // if it is cut at a row boundary, and it yields a catalogue that is merely
  // SMALLER — every lookup past the cut returns "unassigned", which reads as a
  // quiet network full of unknown devices rather than as a failure. The hub
  // ships row_count precisely so this is checkable.
  if (typeof feed.row_count === 'number' && feed.entries.length !== feed.row_count) {
    throw new Error(`row_count mismatch: ${feed.entries.length} entries, header says ${feed.row_count}`);
  }

  // ⛔ See the header: a feed built for a different matching contract must be
  // refused, not approximated.
  if (feed.match_version !== MATCH_VERSION) {
    throw new Error(
      `match_version ${feed.match_version} but this build implements ${MATCH_VERSION} — ` +
      'the lookup algorithm in api/ouiLookup.js must be updated to match the hub'
    );
  }

  const table = new Map();
  for (const e of feed.entries) {
    const prefix = e[T.prefix];
    // First assignment wins: IEEE's own registry contains duplicate prefixes
    // (080030 is assigned to three organisations), and last-write-wins would
    // make the answer depend on row order.
    if (!table.has(prefix)) table.set(prefix, e);
  }

  return {
    table,
    tuple: T,
    meta: {
      feed_version: feed.feed_version || null,
      generated_at: feed.generated_at || null,
      match_version: feed.match_version,
      row_count: table.size,
    },
  };
}

function tryLoad(file, source) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parseCatalogue(raw);
  return { ...parsed, source, file };
}

/**
 * Load the best catalogue available: a verified sync first, the bundled seed
 * as the floor.
 *
 * ⛔ THE SEED IS A FLOOR, NOT A FALLBACK OF LAST RESORT. If the hub is
 * unreachable, or returns something that fails verification, DDIVault keeps
 * resolving MAC vendors from the copy it shipped with. Emptying the catalogue
 * on a failed refresh would turn one bad fetch into a total loss of vendor
 * resolution across every lease and every IPAM row.
 */
function load() {
  const cache = cachePath();
  const attempts = [];

  try {
    const st = fs.statSync(cache);
    const loaded = tryLoad(cache, 'hub-feed');
    _cacheMtime = st.mtimeMs;
    _table = loaded.table;
    _tuple = loaded.tuple;
    _status = { state: 'ok', ...loaded.meta, source: 'hub-feed', path: cache, errors: [] };
    return;
  } catch (e) {
    _cacheMtime = 0;
    if (e && e.code !== 'ENOENT') attempts.push(`cache (${cache}): ${e.message}`);
  }

  const seed = seedPath();
  try {
    const loaded = tryLoad(seed, 'bundled-seed');
    _table = loaded.table;
    _tuple = loaded.tuple;
    _status = { state: 'ok', ...loaded.meta, source: 'bundled-seed', path: seed, errors: attempts };
    return;
  } catch (e) {
    attempts.push(`seed (${seed}): ${e.message}`);
  }

  // ⛔ An empty Map would make every MAC "unassigned" — a claim about IEEE we
  // have no basis for. The state says WE failed.
  _table = null;
  _tuple = null;
  _status = { state: 'unreadable', source: null, path: null, errors: attempts, row_count: 0 };
  if (attempts.length) {
    console.error('[oui] no usable catalogue:', attempts.join('; '));
  }
}

function ensureLoaded() {
  const now = Date.now();
  if (_status && now - _checkedAt < RELOAD_CHECK_MS) return;
  _checkedAt = now;

  if (!_status) { load(); return; }

  // ⛔ THE SYNC RUNS IN THE API PROCESS; THE COLLECTOR IS A DIFFERENT PROCESS.
  // Without this, the collector would hold whatever catalogue it read at start
  // for as long as it runs — which is weeks — and a refresh would appear to
  // have no effect on exactly the component doing the scanning.
  try {
    const st = fs.statSync(cachePath());
    if (st.mtimeMs !== _cacheMtime) load();
  } catch (_) {
    if (_cacheMtime !== 0) load(); // the cache we were using went away
  }
}

// ── the matching contract ────────────────────────────────────────────────────

/** Strip every non-hex character, uppercase. */
function normalize(s) {
  return String(s == null ? '' : s).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/**
 * The raw contract: a MAC in, the matching feed row or null out.
 *
 * ⛔ A PREFIX IS NOT A MAC. "00:00:0C" normalises to six hex characters, which
 * would match the /24 row exactly and report Cisco — turning a caller's partial
 * input into a confident answer about a device that was never identified. A MAC
 * is 12 hex characters; anything shorter is refused.
 */
function lookupMac(mac) {
  ensureLoaded();
  if (!_table) return null;
  const hex = normalize(mac);
  if (hex.length < 12) return null;
  for (const n of PREFIX_STEPS) {
    const row = _table.get(hex.slice(0, n));
    if (row) return row;
  }
  return null;
}

/**
 * Resolve a MAC to a display-ready answer.
 *
 * @returns {{state: string, vendor: string|null, prefix: string|null,
 *            bits: number|null, type: string}}
 */
function lookupOUI(mac) {
  ensureLoaded();

  if (!_table) {
    return { state: 'unreadable', vendor: null, prefix: null, bits: null, type: 'unknown' };
  }
  if (!mac) {
    return { state: 'unassigned', vendor: null, prefix: null, bits: null, type: 'unknown' };
  }

  const row = lookupMac(mac);
  if (!row) {
    return { state: 'unassigned', vendor: null, prefix: null, bits: null, type: 'unknown' };
  }

  const prefix = row[_tuple.prefix];
  const bits = row[_tuple.prefix_bits];
  const org = row[_tuple.org];

  // ⛔ THE REGISTRAR IS NOT A VENDOR. Checked on whatever row MATCHED, at any
  // length — the flag is not a /24-only property. 443 rows carry it today and
  // one of them, 70B3D59F3, is a /36.
  if (row[_tuple.is_registry_block]) {
    return { state: 'registry_block', vendor: null, prefix, bits, type: 'unknown' };
  }

  // ⛔ "Private" is IEEE'S ANSWER, not a missing one.
  if (/^private$/i.test(String(org).trim())) {
    return { state: 'private', vendor: null, prefix, bits, type: 'unknown' };
  }

  return { state: 'known', vendor: org, prefix, bits, type: deviceTypeFor(org) };
}

/** Provenance for diagnostics and the health endpoint. */
function catalogueStatus() {
  ensureLoaded();
  return { ..._status, match_version_implemented: MATCH_VERSION };
}

/** Drop the cached catalogue so the next call re-reads from disk. For tests. */
function reload() {
  _table = null;
  _tuple = null;
  _status = null;
  _checkedAt = 0;
  _cacheMtime = 0;
  _typeCache.clear();
}

module.exports = {
  lookupOUI,
  lookupMac,
  normalize,
  catalogueStatus,
  deviceTypeFor,
  reload,
  cachePath,
  seedPath,
  MATCH_VERSION,
};
