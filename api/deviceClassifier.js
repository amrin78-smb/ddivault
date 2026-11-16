'use strict';
const { lookupOUI } = require('./ouiLookup');

/**
 * How each IEEE outcome is shown to an operator.
 *
 * ⛔ FOUR OUTCOMES, FOUR DIFFERENT STRINGS, AND THE DIFFERENCES ARE THE WHOLE
 * VALUE. They send someone to four different places:
 *   known          — IEEE named the organisation. Act on it.
 *   Private        — IEEE'S OWN RECORDED VALUE, not a gap. The assignee asked
 *                    to be withheld, so no amount of looking will produce a
 *                    name and nobody should go searching for one.
 *   registry_block — the prefix resolves only to a registrar, so the real
 *                    assignee is one of the longer blocks underneath. The
 *                    prefix travels in the label because it is the evidence.
 *                    ⛔ NEVER the registrar's name: "IEEE Registration
 *                    Authority" reads as a vendor and is believed as one.
 *   unassigned     — IEEE has handed this prefix to nobody. On a live device
 *                    that is itself interesting: a randomised or spoofed MAC.
 * and `unreadable`, which is a statement about US, not about the device.
 */
const VENDOR_LABEL = {
  private: 'Private (IEEE-withheld)',
  unassigned: 'Unknown',
  unreadable: 'Unknown (vendor catalogue unavailable)',
};

function vendorLabel(info) {
  if (info.state === 'known') return info.vendor;
  if (info.state === 'registry_block') {
    return `Unknown (IEEE block ${info.prefix})`;
  }
  return VENDOR_LABEL[info.state] || 'Unknown';
}

/**
 * classifyDevice — best-effort device classification from MAC OUI + hostname.
 *
 * Order of precedence:
 *   1. Hostname patterns (highest confidence — covers corporate naming
 *      conventions even when the OUI is unknown).
 *   2. Vendor (OUI) — Apple, computer makers, network/printer/VoIP brands, mobile.
 *   3. Coarse OUI type hint as a last resort.
 *
 * Returns { type, os?, icon, vendor, vendor_state, oui_prefix, risk_level }.
 *   type ∈ mobile | workstation | network | printer | voip | iot | unknown
 */
function classifyDevice(mac, hostname) {
  const info = lookupOUI(mac);
  const vendor = vendorLabel(info);
  const ouiType = info.type || 'unknown';
  // ⛔ Only a NAMED vendor may drive brand matching. The labels above are our
  // prose, not IEEE's, and matching them would let "Private (IEEE-withheld)"
  // or a prefix string fall through a brand regex by accident.
  const v = info.state === 'known' ? String(info.vendor).toLowerCase() : '';
  const h = hostname ? String(hostname).trim() : '';

  let result = null;

  // ── 1. Hostname-driven classification ──────────────────────────────────────
  // IMPORTANT: only GENERIC, universally-recognizable conventions belong here.
  // Never add customer-specific naming schemes — vendor identity comes from the
  // OUI registry, not from any one organization's hostname convention.
  if (h) {
    if (/iphone|ipad|ipod/i.test(h)) {
      result = { type: 'mobile', os: 'iOS', icon: '📱' };
    } else if (/android|galaxy|pixel|-mb-|\bmobile\b/i.test(h)) {
      result = { type: 'mobile', os: 'Android', icon: '📱' };
    } else if (/macbook|imac|\bmac\b|mac-/i.test(h)) {
      result = { type: 'workstation', os: 'macOS', icon: '💻' };
    } else if (/surface/i.test(h)) {
      result = { type: 'workstation', os: 'Windows', icon: '💻' };
    } else if (/-por-|\bpor\b|portable|laptop|notebook|\bnb\d/i.test(h)) {
      result = { type: 'workstation', os: 'Windows', icon: '💻' };
    } else if (/-dsk-|\bdsk\b|desktop|\bwks\b|workstation/i.test(h)) {
      result = { type: 'workstation', os: 'Windows', icon: '🖥️' };
    } else if (/-srv-|server|\bdc\d|\bsql\b|\bvm-/i.test(h)) {
      result = { type: 'workstation', os: 'Windows', icon: '🖥️' };
    } else if (/voip|sip|\bphone\b|polycom|yealink/i.test(h)) {
      result = { type: 'voip', icon: '📞' };
    } else if (/printer|print-|\bmfp\b|copier/i.test(h)) {
      result = { type: 'printer', icon: '🖨️' };
    } else if (/\bap-|-ap\d|\bwap-|access-?point|wifi|wlan|switch|router|\bfw-|firewall/i.test(h)) {
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
  result.vendor_state = info.state;
  result.oui_prefix = info.prefix || null;

  // ── Risk level — known vendor + known hostname is lowest risk ───────────────
  //
  // ⛔ "WE COULD NOT READ THE CATALOGUE" IS NOT A PROPERTY OF THE DEVICE. If the
  // hub is unreachable AND the bundled seed is unreadable, treating every MAC as
  // an unidentifiable vendor would re-rate the entire estate upward at once — a
  // fleet-wide risk spike caused by our own outage, arriving as thousands of
  // identical findings with no bad device anywhere. The honest answer is that
  // the risk is not known.
  if (info.state === 'unreadable') {
    result.risk_level = 'unknown';
    return result;
  }

  // ⛔ A NAMED VENDOR IS THE ONLY ONE THAT LOWERS RISK. "Private" and a registry
  // block both mean the owner is NOT identified — rating them as known would
  // quietly mark the least identifiable devices on the network as lowest risk,
  // which is backwards.
  const ouiKnown = info.state === 'known';
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

module.exports = { classifyDevice, isMacRandomized, vendorLabel };
