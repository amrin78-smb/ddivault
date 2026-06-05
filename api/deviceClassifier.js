'use strict';
const { lookupOUI } = require('./ouiLookup');

/**
 * classifyDevice — best-effort device classification from MAC OUI + hostname.
 *
 * Order of precedence:
 *   1. Hostname patterns (highest confidence — covers corporate naming conventions
 *      like Thai Union's TH-SMTO-POR-xxx / 1EX0-xxx even when the OUI is unknown).
 *   2. Vendor (OUI) — Apple, computer makers, network/printer/VoIP brands, mobile.
 *   3. Coarse OUI type hint as a last resort.
 *
 * Returns { type, os?, icon, vendor, risk_level }.
 *   type ∈ mobile | workstation | network | printer | voip | iot | unknown
 */
function classifyDevice(mac, hostname) {
  const info = lookupOUI(mac);
  const vendor = info.vendor || 'Unknown';
  const ouiType = info.type || 'unknown';
  const v = vendor.toLowerCase();
  const h = hostname ? String(hostname).trim() : '';

  let result = null;

  // ── 1. Hostname-driven classification ──────────────────────────────────────
  if (h) {
    if (/iphone|ipad|ipod/i.test(h)) {
      result = { type: 'mobile', os: 'iOS', icon: '📱' };
    } else if (/android|galaxy|pixel|-mb-|\bmobile\b/i.test(h)) {
      result = { type: 'mobile', os: 'Android', icon: '📱' };
    } else if (/macbook|imac|\bmac\b/i.test(h)) {
      result = { type: 'workstation', os: 'macOS', icon: '💻' };
    } else if (/-por-|portable|laptop|notebook|\bnb\d/i.test(h)) {
      // e.g. TH-SMTO-POR-xxx → Windows portable/laptop
      result = { type: 'workstation', os: 'Windows', icon: '💻' };
    } else if (/-dsk-|desktop|\bwks\b|workstation/i.test(h)) {
      // e.g. TH-SMTO-DSK-xxx → Windows desktop
      result = { type: 'workstation', os: 'Windows', icon: '🖥️' };
    } else if (/-srv-|server|\bdc\d|\bsql\b|\bvm-/i.test(h)) {
      result = { type: 'workstation', os: 'Windows', icon: '🖥️' };
    } else if (/^th-[a-z]{2,5}-/i.test(h) || /^\d[a-z0-9]{3}-/i.test(h) || /\d{2}[a-z]{2}-\d{3}/i.test(h)) {
      // Corporate naming conventions: TH-SMTO-xxx, 1EX0-xxx, 2GCF-xxx → Windows workstation
      result = { type: 'workstation', os: 'Windows', icon: '🖥️' };
    } else if (/voip|sip|\bphone\b|polycom|yealink/i.test(h)) {
      result = { type: 'voip', icon: '📞' };
    } else if (/printer|print-|\bmfp\b|copier/i.test(h)) {
      result = { type: 'printer', icon: '🖨️' };
    } else if (/\bap-|-ap\d|access-?point|wifi|wlan|switch|router|\bfw-|firewall/i.test(h)) {
      result = { type: 'network', icon: '🔌' };
    }
  }

  // ── 2. Vendor (OUI) driven classification ──────────────────────────────────
  if (!result) {
    if (v.includes('apple')) {
      result = { type: 'workstation', os: 'macOS', icon: '💻' };
    } else if (
      ouiType === 'network' ||
      /cisco|juniper|aruba|arista|fortinet|palo alto|ubiquiti|meraki|netgear|tp-?link|d-?link|mikrotik|ruckus|extreme network|zyxel|brocade|\bh3c\b|sonicwall|watchguard|hewlett packard enterprise|ruijie|cambium|aerohive/.test(v)
    ) {
      result = { type: 'network', icon: '🔌' };
    } else if (
      ouiType === 'voip' ||
      /polycom|yealink|grandstream|avaya|mitel|\bsnom\b|audiocodes|sangoma|spectralink|gigaset/.test(v)
    ) {
      result = { type: 'voip', icon: '📞' };
    } else if (
      ouiType === 'printer' ||
      /canon|epson|xerox|ricoh|konica|brother|lexmark|kyocera|\bsharp\b|\boki\b|zebra|honeywell|datalogic|intermec/.test(v)
    ) {
      result = { type: 'printer', icon: '🖨️' };
    } else if (
      ouiType === 'computer' ||
      /dell|lenovo|hewlett-packard|\bhp inc\b|asustek|\bacer\b|micro-star|\bmsi\b|gigabyte|super ?micro|vmware|intel corp|microsoft corp|fujitsu|toshiba|pegatron|wistron|compal|quanta|clevo|hon hai|framework computer/.test(v)
    ) {
      result = { type: 'workstation', os: 'Windows', icon: '🖥️' };
    } else if (
      ouiType === 'mobile' ||
      /samsung|huawei|xiaomi|oppo|vivo mobile|oneplus|\bgoogle\b|motorola|lg electronics|sony mobile|\bhtc\b|nokia|realme|\btcl\b/.test(v)
    ) {
      result = { type: 'mobile', os: 'Android', icon: '📱' };
    } else if (ouiType === 'iot') {
      result = { type: 'iot', icon: '📟' };
    } else {
      result = { type: 'unknown', icon: '❓' };
    }
  }

  result.vendor = vendor;

  // ── Risk level — known vendor + known hostname is lowest risk ───────────────
  const ouiKnown = vendor !== 'Unknown';
  const hasHostname = h.length > 0;
  let risk_level;
  if (ouiKnown && hasHostname) {
    risk_level = 'low';
  } else if ((ouiKnown && !hasHostname) || (!ouiKnown && hasHostname)) {
    risk_level = 'medium';
  } else {
    risk_level = 'high';
  }
  result.risk_level = risk_level;

  return result;
}

function isMacRandomized(mac) {
  try {
    if (!mac) return false;
    const firstOctet = String(mac).split(/[:\-]/)[0];
    const val = parseInt(firstOctet, 16);
    if (isNaN(val)) return false;
    return (val & 0x02) !== 0;
  } catch (_) {
    return false;
  }
}

module.exports = { classifyDevice, isMacRandomized };
