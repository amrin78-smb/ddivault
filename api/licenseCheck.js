'use strict';

let cachedLicense = null;
let lastChecked   = null;
const CACHE_TTL   = 24 * 60 * 60 * 1000; // 24 hours

async function fetchLicense() {
  const hubUrl = process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${hubUrl}/api/license`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // never block on network failure
  } finally {
    clearTimeout(t);
  }
}

async function getLicense(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedLicense && lastChecked && (now - lastChecked) < CACHE_TTL) {
    return cachedLicense;
  }
  const license = await fetchLicense();
  if (license) { cachedLicense = license; lastChecked = now; }
  return cachedLicense;
}

function getLicenseState(license) {
  if (!license) return { mode: 'unreachable', canWrite: true, canRead: true, disabled: false };
  const { status, daysRemaining } = license;
  // Per-app entitlement: hard-lock ONLY when an ACTIVE key explicitly lists modules
  // and omits ours. Trial / grace / hub-unreachable / empty-modules stay open
  // (fail-open) so trials and legacy keys are never bricked.
  if (status === 'active' && Array.isArray(license.modules) && license.modules.length > 0 && !license.modules.includes('ddivault')) {
    return { mode: 'unlicensed', canWrite: false, canRead: false, disabled: true };
  }
  if (status === 'active' || status === 'trial') {
    return { mode: status, canWrite: true, canRead: true, disabled: false };
  }
  if (status === 'expired' || status === 'grace') {
    const inGrace = daysRemaining > -30; // 30-day grace after expiry
    if (inGrace) return { mode: 'grace', canWrite: false, canRead: true, disabled: false };
    return { mode: 'disabled', canWrite: false, canRead: false, disabled: true };
  }
  return { mode: 'unknown', canWrite: true, canRead: true, disabled: false };
}

module.exports = { getLicense, getLicenseState, fetchLicense };
