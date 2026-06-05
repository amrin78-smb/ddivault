#!/usr/bin/env node
'use strict';
/**
 * update-oui.js — rebuild data/oui.json from the authoritative IEEE OUI registry.
 *
 * The IEEE publishes the OUI/MA-L registry at https://standards-oui.ieee.org/oui/oui.csv
 * but actively blocks scripted clients (HTTP 418). The Wireshark project republishes the
 * same IEEE data as a clean, well-maintained `manuf` file, which we use as the primary
 * source. Both formats are supported below.
 *
 * Usage:
 *   node scripts/update-oui.js                 # download + rebuild data/oui.json
 *   node scripts/update-oui.js /path/to/manuf  # build from a local manuf/oui.csv file
 *
 * Output: data/oui.json  →  { "AABBCC": { "vendor": "...", "type": "..." }, ... }
 *   key   = first 3 octets (6 hex chars, uppercase, no separators) — matches ouiLookup.js
 *   type  = coarse device class derived from the vendor name (see vendorType())
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = path.join(__dirname, '..', 'data', 'oui.json');

// Mirrors of the IEEE registry, tried in order. The Wireshark manuf file is the
// most reliable for scripted access; the IEEE CSV is kept as a documented fallback.
const SOURCES = [
  'https://www.wireshark.org/download/automated/data/manuf',
  'https://standards-oui.ieee.org/oui/oui.csv',
];

// ── Vendor name → coarse device type ─────────────────────────────────────────
// Heuristic only. The device classifier (api/deviceClassifier.js) refines this
// further using hostname patterns; the key value here is knowing the vendor at all.
function vendorType(name) {
  const n = (name || '').toLowerCase();
  if (!n) return 'consumer';
  if (/polycom|yealink|grandstream|avaya|mitel|\bsnom\b|audiocodes|sangoma|cisco systems.*phone|gigaset/.test(n)) return 'voip';
  if (/cisco|juniper|aruba|arista|fortinet|palo alto|ubiquiti|meraki|netgear|tp-?link|d-?link|mikrotik|ruckus|extreme network|zyxel|brocade|\bh3c\b|sonicwall|watchguard|hewlett packard enterprise|ruijie|cambium|aerohive|huawei techn/.test(n)) return 'network';
  if (/canon|epson|xerox|ricoh|konica|brother|lexmark|kyocera|\bsharp\b|\boki\b|toshiba tec|zebra|honeywell|datalogic|\bsato\b|primera|dymo/.test(n)) return 'printer';
  if (/apple/.test(n)) return 'mobile';
  if (/samsung|xiaomi|oppo|vivo mobile|oneplus|\bgoogle\b|motorola|lg electronics|sony mobile|\bhtc\b|nokia|realme|\btcl\b|guangdong|transsion/.test(n)) return 'mobile';
  if (/dell|lenovo|hewlett-packard|\bhp inc\b|asustek|\basus\b|\bacer\b|micro-star|\bmsi\b|gigabyte|super ?micro|vmware|intel|microsoft|fujitsu|toshiba|framework computer|pegatron|wistron|compal|quanta|clevo|biostar|parallels|xensource|qemu|virtualbox/.test(n)) return 'computer';
  if (/hikvision|dahua|axis communications|amazon tech|\bnest\b|\bring\b|espressif|raspberry|tuya|sonoff|signify|philips lighting|bosch|hanwha|uniview|reolink|ubiqu500|tp-link.*camera/.test(n)) return 'iot';
  return 'consumer';
}

// ── Parsers ──────────────────────────────────────────────────────────────────
const OUI_RE = /^[0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}$/;

function parseManuf(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const parts = line.split('\t').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const oui = parts[0];
    if (!OUI_RE.test(oui)) continue; // skip /28, /36 longer assignments — ambiguous for a 3-octet lookup
    const prefix = oui.replace(/[:-]/g, '').toUpperCase();
    const vendor = (parts[2] || parts[1] || '').replace(/\s+/g, ' ').trim();
    if (!vendor) continue;
    out[prefix] = { vendor, type: vendorType(vendor) };
  }
  return out;
}

function parseCsv(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Registry,Assignment,Organization Name,Organization Address — quoted CSV
    const m = line.match(/^("?)(MA-L|MA-M|MA-S|IAB)\1,("?)([0-9A-Fa-f]{6})\3,("?)(.*?)\5,/);
    if (!m) continue;
    const prefix = m[4].toUpperCase();
    const vendor = m[6].replace(/""/g, '"').replace(/\s+/g, ' ').trim();
    if (!vendor) continue;
    out[prefix] = { vendor, type: vendorType(vendor) };
  }
  return out;
}

function parse(text) {
  // manuf lines are tab-separated and start with an OUI; CSV starts with a registry token.
  if (/^\s*("?)(MA-L|MA-M|MA-S|IAB)\b/m.test(text) && text.includes(',')) {
    const csv = parseCsv(text);
    if (Object.keys(csv).length > 100) return csv;
  }
  return parseManuf(text);
}

// ── Download (follows redirects) ─────────────────────────────────────────────
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (DDIVault OUI updater)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

async function getSource() {
  const local = process.argv[2];
  if (local) {
    console.log(`[update-oui] reading local file: ${local}`);
    return fs.readFileSync(local, 'utf8');
  }
  for (const url of SOURCES) {
    try {
      console.log(`[update-oui] downloading ${url} ...`);
      const text = await download(url);
      if (text && text.length > 10000) return text;
    } catch (e) {
      console.warn(`[update-oui] source failed (${url}): ${e.message}`);
    }
  }
  throw new Error('all OUI sources failed — pass a local manuf/oui.csv path as an argument');
}

(async () => {
  try {
    const text = await getSource();
    const table = parse(text);
    const keys = Object.keys(table);
    if (keys.length < 1000) throw new Error(`parsed only ${keys.length} OUIs — source format unexpected`);
    // Write sorted for stable diffs.
    const sorted = {};
    for (const k of keys.sort()) sorted[k] = table[k];
    fs.writeFileSync(OUT, JSON.stringify(sorted) + '\n');
    const sizeKb = Math.round(fs.statSync(OUT).size / 1024);
    console.log(`[update-oui] wrote ${keys.length} OUI entries to ${OUT} (${sizeKb} KB)`);
  } catch (e) {
    console.error(`[update-oui] FAILED: ${e.message}`);
    process.exit(1);
  }
})();
