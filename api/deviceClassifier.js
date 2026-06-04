'use strict';
const { lookupOUI } = require('./ouiLookup');

function classifyDevice(mac, hostname) {
  const info = lookupOUI(mac);
  const vendor = info.vendor || 'Unknown';
  const ouiType = info.type || 'unknown';
  const v = vendor.toLowerCase();
  const h = hostname ? String(hostname) : '';

  let result;

  if (vendor === 'Apple' && /iphone|ipad/i.test(h)) {
    result = { type: 'mobile', os: 'iOS', icon: '📱' };
  } else if (vendor === 'Apple' && (/macbook|imac|\bmac\b/i.test(h) || true)) {
    // Apple OUI with mac-like hostname, or Apple OUI with no mobile hint
    result = { type: 'workstation', os: 'macOS', icon: '💻' };
  } else if (/\d{2}[A-Z]{2}-\d{3}/.test(h)) {
    result = { type: 'workstation', os: 'Windows', icon: '🖥️' };
  } else if (
    ouiType === 'network' &&
    (v.includes('cisco') || v.includes('juniper') || v.includes('aruba') ||
     v.includes('fortinet') || v.includes('palo alto') || v.includes('ubiquiti'))
  ) {
    result = { type: 'network', icon: '🔌' };
  } else if (
    ouiType === 'printer' &&
    (v.includes('hp') || v.includes('canon') || v.includes('epson') ||
     v.includes('xerox') || v.includes('ricoh') || v.includes('konica') ||
     v.includes('brother'))
  ) {
    result = { type: 'printer', icon: '🖨️' };
  } else if (
    v.includes('polycom') || v.includes('yealink') || v.includes('grandstream') ||
    /polycom|voip|phone/i.test(h)
  ) {
    result = { type: 'voip', icon: '📞' };
  } else if (
    (v.includes('samsung') || v.includes('huawei') || v.includes('google') ||
     v.includes('xiaomi')) &&
    ouiType === 'consumer' &&
    /phone|android|galaxy|pixel|mobile/i.test(h)
  ) {
    result = { type: 'mobile', os: 'Android', icon: '📱' };
  } else {
    result = { type: 'unknown', icon: '❓' };
  }

  result.vendor = vendor;

  const ouiKnown = vendor !== 'Unknown';
  const hasHostname = h.trim().length > 0;
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
