#!/usr/bin/env node
'use strict';
/**
 * expand-oui.js — refine device-type classification in data/oui.json.
 *
 * Prefix coverage comes from `node scripts/update-oui.js`, which rebuilds the full
 * authoritative IEEE registry (~39k real entries). We deliberately do NOT hand-add
 * OUI prefixes here: an audit of recalled prefixes against the IEEE data showed a
 * ~25% misattribution rate, and asserting a wrong vendor in a NOC tool is worse than
 * leaving a device "Unknown". So this script only does the part that is safe and
 * additive: re-deriving the coarse `type` from each entry's *real* vendor name, with
 * brand-specific overrides for classes that the generic heuristic gets wrong
 * (VoIP handsets, printers/scanners, network gear).
 *
 * Idempotent — safe to re-run after every `update-oui.js`.
 *
 *   node scripts/update-oui.js && node scripts/expand-oui.js
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'oui.json');

// Brand → type overrides, evaluated in order; first match wins. Applied against the
// real vendor name so there is no fabrication — only reclassification.
const TYPE_OVERRIDES = [
  { type: 'voip',     re: /polycom|yealink|grandstream|avaya|mitel|\bsnom\b|audiocodes|sangoma|spectralink|\bsnom\b|gigaset/i },
  { type: 'printer',  re: /\bzebra\b|honeywell|datalogic|\bsato\b|\bintermec\b|primera|dymo|brady/i },
  { type: 'printer',  re: /canon|epson|xerox|ricoh|konica|brother|lexmark|kyocera|\bsharp\b|\boki\b|pantum/i },
  { type: 'network',  re: /cisco|juniper|aruba|arista|fortinet|palo alto|ubiquiti|meraki|netgear|tp-?link|d-?link|mikrotik|ruckus|extreme network|zyxel|brocade|\bh3c\b|sonicwall|watchguard|hewlett packard enterprise|ruijie|cambium|aerohive/i },
  { type: 'mobile',   re: /apple|samsung|xiaomi|guangdong oppo|vivo mobile|oneplus|motorola mobility|lg electronics|sony mobile|\bhtc\b|realme|transsion/i },
  { type: 'computer', re: /dell|lenovo|hewlett-packard|\bhp inc\b|asustek|\bacer\b|micro-star|\bmsi\b|gigabyte|super ?micro|vmware|intel corp|microsoft corp|fujitsu|toshiba|pegatron|wistron|compal|quanta|clevo|hon hai|framework computer/i },
];

function main() {
  let oui;
  try {
    oui = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('[expand-oui] cannot read data/oui.json — run scripts/update-oui.js first');
    process.exit(1);
  }

  let corrected = 0;
  for (const key of Object.keys(oui)) {
    const vendor = oui[key].vendor || '';
    for (const ov of TYPE_OVERRIDES) {
      if (ov.re.test(vendor)) {
        if (oui[key].type !== ov.type) { oui[key].type = ov.type; corrected++; }
        break;
      }
    }
  }

  const sorted = {};
  for (const k of Object.keys(oui).sort()) sorted[k] = oui[k];
  fs.writeFileSync(FILE, JSON.stringify(sorted) + '\n');

  console.log(`[expand-oui] ${Object.keys(sorted).length} entries; ${corrected} device types corrected from vendor names`);
}

main();
