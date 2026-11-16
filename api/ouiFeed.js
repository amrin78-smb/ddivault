'use strict';
/**
 * ouiFeed.js — pull the signed OUI catalogue from the NocVault EOL hub.
 *
 * ⛔ THIS IS NetVault's `lib/eolFeed.ts` PATTERN, DELIBERATELY NOT A NEW ONE.
 * Same host, same Ed25519 signing key, same `X-Feed-Signature` /
 * `X-Feed-Sha256` detached-signature headers, same bundled public key. A second
 * way of verifying the same publisher's bytes would be a second thing to get
 * wrong, and the one that is already in production is the one that works.
 *
 * ⛔ THE FEED IS UNLICENSED ON PURPOSE. It shipped metered by `CVE_FEED_KEYS`
 * and the first thing the suite's own apps got from it was a 401 — the hub's
 * own note calls that out: "the consumer was never a paying customer; it is
 * this operator's own infrastructure", and the payload is the IEEE registry
 * that anyone may download. A key is sent only if one is configured, so that
 * re-gating the route upstream does not require a code change here.
 *
 * ⛔ NOTHING IS WRITTEN THAT HAS NOT VERIFIED. The catalogue on disk is the one
 * every lease and every IPAM row is named from; overwriting it with unverified
 * bytes would be worse than not refreshing at all.
 */

const fs = require('fs');
const path = require('path');
const { createHash, createPublicKey, verify: cryptoVerify } = require('crypto');

const { cachePath, MATCH_VERSION } = require('./ouiLookup');

/** The detached signature is stored beside the seed, as `<seed>.sig`. */
function sigPathFor(seedFile) {
  return `${seedFile}.sig`;
}

/**
 * The hub's Ed25519 public key (base64 SPKI DER). Bundled, not fetched — a key
 * retrieved from the same host it authenticates proves nothing.
 */
const FEED_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAI+nk9JoWunzPTASALa5PLWwcLe9NNWRrZ72tMY8ZU2k=';

const DEFAULT_FEED_URL = 'https://nocvault-eol.netlify.app';

/** The full feed is ~2.2 MB; the pointer is a few hundred bytes. */
const LATEST_TIMEOUT_MS = 15000;
const FEED_TIMEOUT_MS = 60000;

function feedBase() {
  return (process.env.NOCVAULT_EOL_FEED_URL || DEFAULT_FEED_URL).replace(/\/+$/, '');
}

function requestHeaders() {
  const headers = { accept: 'application/json' };
  const key = process.env.NOCVAULT_EOL_LICENSE_KEY;
  if (key && key.trim()) headers['x-license-key'] = key.trim();
  return headers;
}

/** What the local catalogue currently is, read straight off disk. */
function localPointer() {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const feed = JSON.parse(raw);
    return {
      feed_version: feed.feed_version || null,
      row_count: feed.row_count || (Array.isArray(feed.entries) ? feed.entries.length : 0),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Read the cheap version pointer.
 *
 * ⛔ THIS IS WHY THE 2.2 MB BODY IS USUALLY NOT DOWNLOADED. IEEE assigns a few
 * blocks a week against a catalogue of 54,466, so on almost every run the
 * answer is "you already have this".
 */
async function fetchLatest() {
  const res = await fetch(`${feedBase()}/api/v1/oui-feed/latest`, {
    headers: requestHeaders(),
    cache: 'no-store',
    signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`latest pointer failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch and fully verify the feed. Returns the raw body only if every check
 * passes; throws otherwise.
 */
async function fetchVerifiedFeed() {
  const res = await fetch(`${feedBase()}/api/v1/oui-feed`, {
    headers: requestHeaders(),
    cache: 'no-store',
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`);

  const body = await res.text();
  const sig = res.headers.get('x-feed-signature');
  const shaHeader = res.headers.get('x-feed-sha256');
  if (!sig) throw new Error('feed response missing X-Feed-Signature');

  const sha256 = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
  if (shaHeader && shaHeader !== sha256) {
    throw new Error(`feed sha256 mismatch: computed ${sha256}, header ${shaHeader}`);
  }

  const pub = createPublicKey({
    key: Buffer.from(FEED_PUBLIC_KEY_B64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const ok = cryptoVerify(null, Buffer.from(body, 'utf8'), pub, Buffer.from(sig, 'base64'));
  if (!ok) throw new Error('feed signature verification failed');

  // ⛔ THE SIGNATURE PROVES THE PUBLISHER, NOT THE SHAPE. A correctly signed
  // feed we cannot match against is still unusable, and finding that out at
  // lookup time would mean finding it out silently.
  const feed = JSON.parse(body);
  if (!Array.isArray(feed.entries) || !Array.isArray(feed.tuple)) {
    throw new Error('verified feed has no entries/tuple');
  }
  if (typeof feed.row_count === 'number' && feed.entries.length !== feed.row_count) {
    throw new Error(`row_count mismatch: ${feed.entries.length} entries, feed says ${feed.row_count}`);
  }
  if (feed.match_version !== MATCH_VERSION) {
    throw new Error(
      `match_version ${feed.match_version} but this build implements ${MATCH_VERSION} — ` +
      'refusing a feed whose matching contract this code does not implement'
    );
  }

  return { body, feed, sha256, signature: sig };
}

/**
 * ⛔ WRITTEN VIA A TEMP FILE AND RENAMED. `writeFileSync` truncates first, so a
 * crash mid-write leaves a half-catalogue that parses as far as the cut — the
 * exact silent-truncation failure the row_count check exists to catch, except
 * self-inflicted. rename(2) is atomic: a reader sees the old file or the new
 * one, never a partial.
 */
function writeCache(body) {
  const target = cachePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
    throw e;
  }
  return target;
}

/**
 * Refresh the local catalogue if the hub has something newer.
 *
 * ⛔ A FAILED SYNC LEAVES THE CATALOGUE EXACTLY AS IT WAS and reports why. It
 * never clears, never truncates and never half-writes, because the failure
 * modes it is guarding against (an unreachable hub, a captive portal answering
 * 200 with HTML, a short read) all look like success from the inside.
 *
 * @param {{force?: boolean}} [opts] force skips the version-pointer shortcut.
 * @returns {Promise<{action: string, feed_version?: string, row_count?: number, reason?: string}>}
 */
async function syncOuiFeed(opts) {
  const force = !!(opts && opts.force);
  const local = localPointer();

  try {
    if (!force && local && local.feed_version) {
      const latest = await fetchLatest();
      if (latest && latest.feed_version && latest.feed_version === local.feed_version) {
        return {
          action: 'unchanged',
          feed_version: local.feed_version,
          row_count: local.row_count,
        };
      }
    }

    const { body, feed } = await fetchVerifiedFeed();
    const written = writeCache(body);
    console.log(
      `[oui] catalogue updated: ${feed.row_count} assignments, feed_version ${feed.feed_version} -> ${written}`
    );
    return {
      action: 'updated',
      feed_version: feed.feed_version,
      row_count: feed.row_count,
      path: written,
    };
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    console.error(`[oui] sync failed, keeping existing catalogue: ${reason}`);
    return {
      action: 'failed',
      reason,
      feed_version: local ? local.feed_version : null,
      row_count: local ? local.row_count : null,
    };
  }
}

module.exports = {
  sigPathFor,
  syncOuiFeed,
  fetchVerifiedFeed,
  fetchLatest,
  localPointer,
  FEED_PUBLIC_KEY_B64,
  DEFAULT_FEED_URL,
};
