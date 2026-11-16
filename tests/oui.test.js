'use strict';

/**
 * oui.test.js — the MAC vendor catalogue.
 *
 * ⛔ PRE-FIX BEHAVIOUR BEING PINNED DOWN HERE. api/ouiLookup.js used to be:
 *
 *     const prefix = String(mac).replace(/[:\-\.]/g, '').toUpperCase().slice(0, 6);
 *     return oui[prefix] || { vendor: 'Unknown', type: 'unknown' };
 *
 * i.e. 24 bits and stop. IEEE assigns at three lengths, and 443 blocks belong
 * to the registrar itself with 13,841 real assignments underneath them.
 *
 * ⛔ MEASURED, NOT ASSUMED: against the OLD data/oui.json those 13,841 came out
 * as "Unknown", not as the registrar — Wireshark's `manuf` carries none of the
 * 442 registrar /24 rows (checked: 0 of 442 present) and the old parser
 * discarded every /28 and /36 row. The old failure was a MISS.
 *
 * The hub's feed carries all 443. Reading it 24 bits at a time would convert
 * every one of those misses into a confident wrong answer, so longest-prefix
 * matching is what makes the richer catalogue safe to adopt rather than a
 * regression. Every assertion below marked LONGEST-PREFIX fails against a
 * 24-bit lookup over this feed.
 *
 * It also could not tell apart the four things IEEE actually says — a named
 * org, a deliberately withheld one ("Private", 217 rows), a registrar block,
 * and a prefix assigned to nobody — nor those from "we could not read the
 * catalogue at all". All five collapsed into the string "Unknown".
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHash, createPublicKey, verify: cryptoVerify } = require('crypto');

const oui = require('../api/ouiLookup');
const ouiFeed = require('../api/ouiFeed');
const { classifyDevice } = require('../api/deviceClassifier');

const SEED = path.join(__dirname, '..', 'data', 'oui-seed.json');
const SEED_SIG = `${SEED}.sig`;

/** Point the module at specific files and force a fresh load. */
function useCatalogue({ cache, seed }) {
  if (cache === null) delete process.env.DDIVAULT_OUI_CACHE;
  else if (cache !== undefined) process.env.DDIVAULT_OUI_CACHE = cache;
  if (seed === null) delete process.env.DDIVAULT_OUI_SEED;
  else if (seed !== undefined) process.env.DDIVAULT_OUI_SEED = seed;
  oui.reload();
}

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ddivault-oui-${label}-`));
}

/** A one-request feed server. Returns { url, close }. */
async function feedServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Default for every test that does not say otherwise: the shipped seed, no cache.
test.beforeEach(() => {
  useCatalogue({ cache: path.join(tmpdir('nocache'), 'absent.json'), seed: null });
});

// ───────────────────────────── A. the bundled seed ──────────────────────────

test('the committed seed is provably the hub\'s bytes, not an edited copy', () => {
  // ⛔ 54,466 rows is far past what anyone reviews in a diff, so "looks fine"
  // is not available as a check. The detached signature is.
  const body = fs.readFileSync(SEED, 'utf8');
  const sig = fs.readFileSync(SEED_SIG, 'utf8').trim();
  const pub = createPublicKey({
    key: Buffer.from(ouiFeed.FEED_PUBLIC_KEY_B64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  assert.ok(
    cryptoVerify(null, Buffer.from(body, 'utf8'), pub, Buffer.from(sig, 'base64')),
    'data/oui-seed.json does not match data/oui-seed.json.sig — regenerate with scripts/build-oui-seed.js'
  );
});

test('the seed carries all three IEEE registries, not just MA-L', () => {
  const feed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const T = {};
  feed.tuple.forEach((n, i) => { T[n] = i; });

  const byBits = {};
  for (const e of feed.entries) byBits[e[T.prefix_bits]] = (byBits[e[T.prefix_bits]] || 0) + 1;

  // The old update-oui.js skipped these two outright:
  //   if (!OUI_RE.test(oui)) continue; // skip /28, /36 ... ambiguous
  assert.ok(byBits[28] > 6000, `expected thousands of MA-M /28 rows, got ${byBits[28]}`);
  assert.ok(byBits[36] > 7000, `expected thousands of MA-S /36 rows, got ${byBits[36]}`);
  assert.strictEqual(feed.entries.length, feed.row_count);
});

test('registry blocks are NOT a 24-bit-only property', () => {
  // The brief said "443 of the 24-bit blocks". Measured against the live feed:
  // 442 are /24 and one — 70B3D59F3 — is /36. Code that checks the flag only
  // on a /24 match would miss it, so the check is on whatever row matched.
  const feed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const T = {};
  feed.tuple.forEach((n, i) => { T[n] = i; });
  const regs = feed.entries.filter((e) => e[T.is_registry_block]);
  const nonL = regs.filter((e) => e[T.prefix_bits] !== 24);
  assert.strictEqual(regs.length, 443);
  assert.deepStrictEqual(nonL.map((e) => e[T.prefix]), ['70B3D59F3']);
});

// ───────────────────────── B. the matching contract ─────────────────────────

test('a named assignment resolves to the organisation IEEE recorded', () => {
  assert.strictEqual(oui.lookupOUI('00:00:0C:11:22:33').vendor, 'Cisco Systems, Inc');
  assert.strictEqual(oui.lookupOUI('00:00:0C:11:22:33').state, 'known');
  assert.match(oui.lookupOUI('00:09:0F:11:22:33').vendor, /^Fortinet/);
});

test('LONGEST-PREFIX: a /28 assignment beats its registrar parent', () => {
  // B84C87 is a registrar block; B84C879 is Airgain's MA-M inside it.
  const r = oui.lookupOUI('B8:4C:87:9A:BB:CC');
  assert.strictEqual(r.state, 'known');
  assert.match(r.vendor, /Airgain/);
  assert.strictEqual(r.bits, 28);
  assert.doesNotMatch(r.vendor, /IEEE Registration Authority/);
});

test('LONGEST-PREFIX: the brief\'s own registry-block vector is a real company', () => {
  // The brief asserted B8:4C:87:0A:BB:CC is a registry block. It is not —
  // nibbles 0..E under B84C87 are all assigned. Recorded so the next reader
  // does not "fix" the corrected vector back to the broken one.
  const r = oui.lookupOUI('B8:4C:87:0A:BB:CC');
  assert.strictEqual(r.state, 'known');
  assert.strictEqual(r.vendor, 'Annapurna labs');
});

test('a registrar block answers UNKNOWN and never names the registrar', () => {
  // F is the only nibble under B84C87 with no /28 child, so it falls back to
  // the /24 — which is the registrar's own block.
  const r = oui.lookupOUI('B8:4C:87:FA:BB:CC');
  assert.strictEqual(r.state, 'registry_block');
  assert.strictEqual(r.vendor, null, 'a registrar is not a vendor');
  assert.strictEqual(r.prefix, 'B84C87');

  const shown = classifyDevice('B8:4C:87:FA:BB:CC', '').vendor;
  assert.match(shown, /Unknown/);
  assert.match(shown, /B84C87/, 'the prefix is the evidence and must travel');
  assert.doesNotMatch(shown, /IEEE Registration Authority/i);
});

test('no MAC anywhere in the catalogue can render as the registrar\'s name', () => {
  // The failure was systemic, so the guard is too: sample every registrar
  // block and assert none of them produces the registrar as a vendor.
  const feed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const T = {};
  feed.tuple.forEach((n, i) => { T[n] = i; });
  const regs = feed.entries.filter((e) => e[T.is_registry_block]);

  let checked = 0;
  for (const e of regs) {
    const prefix = e[T.prefix];
    const mac = (prefix + 'FFFFFFFFFFFF').slice(0, 12);
    const r = oui.lookupOUI(mac);
    assert.notStrictEqual(r.state, 'known', `${mac} resolved as a named vendor`);
    if (r.vendor) assert.doesNotMatch(r.vendor, /IEEE Registration Authority/i);
    const shown = classifyDevice(mac, '').vendor;
    assert.doesNotMatch(shown, /IEEE Registration Authority/i, `${mac} displayed the registrar`);
    checked++;
  }
  assert.strictEqual(checked, 443);
});

test('"Private" is IEEE\'s answer and is distinct from unassigned', () => {
  const feed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const T = {};
  feed.tuple.forEach((n, i) => { T[n] = i; });
  const priv = feed.entries.find((e) => /^private$/i.test(String(e[T.org]).trim()));
  assert.ok(priv, 'the registry should contain Private rows');

  const mac = (priv[T.prefix] + '111111111111').slice(0, 12);
  const r = oui.lookupOUI(mac);
  assert.strictEqual(r.state, 'private');
  assert.strictEqual(r.vendor, null);

  const shownPrivate = classifyDevice(mac, '').vendor;
  const shownUnassigned = classifyDevice('FF:FF:FF:11:22:33', '').vendor;
  assert.notStrictEqual(
    shownPrivate, shownUnassigned,
    'a withheld owner and an unassigned prefix must not read the same'
  );
  assert.match(shownPrivate, /Private/);
});

test('an unassigned prefix is unassigned, not a vendor', () => {
  const r = oui.lookupOUI('FF:FF:FF:11:22:33');
  assert.strictEqual(r.state, 'unassigned');
  assert.strictEqual(r.vendor, null);
});

test('a PREFIX is not a MAC', () => {
  // "00:00:0C" normalises to exactly the Cisco /24 key. Accepting it would
  // turn a caller's partial input into a confident answer about a device that
  // was never identified.
  for (const partial of ['00:00:0C', '00000C', '00:00:0C:11', 'B8:4C:87']) {
    assert.strictEqual(oui.lookupMac(partial), null, `${partial} must not match`);
    assert.strictEqual(oui.lookupOUI(partial).state, 'unassigned');
  }
});

test('separators and case do not change the answer', () => {
  const expect = 'Cisco Systems, Inc';
  for (const form of [
    '00:00:0c:11:22:33', '00-00-0C-11-22-33', '0000.0c11.2233',
    '00000C112233', ' 00:00:0C:11:22:33 ', '00 00 0c 11 22 33',
  ]) {
    assert.strictEqual(oui.lookupOUI(form).vendor, expect, `failed on ${form}`);
  }
  assert.strictEqual(oui.normalize('00:00:0c!!'), '00000C');
});

test('a null or empty MAC is handled without throwing', () => {
  for (const bad of [null, undefined, '', '   ', 'not-a-mac', 'ZZ:ZZ:ZZ:ZZ:ZZ:ZZ']) {
    const r = oui.lookupOUI(bad);
    assert.ok(['unassigned', 'unreadable'].includes(r.state));
    assert.strictEqual(r.vendor, null);
  }
});

// ─────────────────────── C. what the operator is shown ──────────────────────

test('the four IEEE outcomes render as four different strings', () => {
  const feed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const T = {};
  feed.tuple.forEach((n, i) => { T[n] = i; });
  const priv = feed.entries.find((e) => /^private$/i.test(String(e[T.org]).trim()));

  const labels = [
    classifyDevice('00:00:0C:11:22:33', '').vendor,                               // known
    classifyDevice((priv[T.prefix] + '111111111111').slice(0, 12), '').vendor,    // private
    classifyDevice('B8:4C:87:FA:BB:CC', '').vendor,                               // registry block
    classifyDevice('FF:FF:FF:11:22:33', '').vendor,                               // unassigned
  ];
  assert.strictEqual(new Set(labels).size, 4, `collapsed: ${JSON.stringify(labels)}`);
});

test('classification still works, and type comes from the live vendor name', () => {
  const c = classifyDevice('00:00:0C:11:22:33', '');
  assert.strictEqual(c.type, 'network');
  assert.strictEqual(c.vendor_state, 'known');
  assert.strictEqual(c.oui_prefix, '00000C');

  // Hostname still outranks the OUI.
  assert.strictEqual(classifyDevice('00:00:0C:11:22:33', 'TH-X-PRINTER-01').type, 'printer');
});

test('only a NAMED vendor lowers risk', () => {
  assert.strictEqual(classifyDevice('00:00:0C:11:22:33', 'some-host').risk_level, 'low');
  // A registrar block with no hostname identifies nothing at all.
  assert.strictEqual(classifyDevice('B8:4C:87:FA:BB:CC', '').risk_level, 'high');
});

// ──────────────── D. the catalogue's own failure branches ───────────────────

test('a truncated cache is REFUSED and the seed keeps serving', () => {
  // ⛔ A short read is still valid JSON if it is cut at a row boundary, and it
  // yields a catalogue that is merely smaller — every lookup past the cut
  // reads as "unassigned", i.e. a quiet network, not a failure.
  const dir = tmpdir('truncated');
  const cache = path.join(dir, 'oui-feed.json');
  const feed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  feed.entries = feed.entries.slice(0, 100); // row_count still says 54466
  fs.writeFileSync(cache, JSON.stringify(feed));

  useCatalogue({ cache });
  const status = oui.catalogueStatus();
  assert.strictEqual(status.source, 'bundled-seed', 'must not adopt a short read');
  assert.ok(status.errors.some((e) => /row_count mismatch/.test(e)));
  // and the app still resolves vendors
  assert.strictEqual(oui.lookupOUI('00:00:0C:11:22:33').vendor, 'Cisco Systems, Inc');
});

test('a feed built for a different matching contract is REFUSED', () => {
  const dir = tmpdir('matchver');
  const cache = path.join(dir, 'oui-feed.json');
  const feed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  feed.match_version = 2;
  fs.writeFileSync(cache, JSON.stringify(feed));

  useCatalogue({ cache });
  const status = oui.catalogueStatus();
  assert.strictEqual(status.source, 'bundled-seed');
  assert.ok(status.errors.some((e) => /match_version/.test(e)));
});

test('a corrupt cache falls back rather than taking the app down', () => {
  const dir = tmpdir('corrupt');
  const cache = path.join(dir, 'oui-feed.json');
  fs.writeFileSync(cache, '<!DOCTYPE html><html>captive portal</html>');

  useCatalogue({ cache });
  assert.strictEqual(oui.catalogueStatus().source, 'bundled-seed');
  assert.strictEqual(oui.lookupOUI('00:00:0C:11:22:33').vendor, 'Cisco Systems, Inc');
});

test('NO catalogue at all reports unreadable — never "unassigned"', () => {
  // ⛔ THE DANGEROUS COLLAPSE. An empty table would answer every MAC
  // "unassigned", which is a claim about what IEEE has handed out. We have no
  // basis for that claim; the truthful statement is that WE failed.
  const dir = tmpdir('nothing');
  useCatalogue({
    cache: path.join(dir, 'absent.json'),
    seed: path.join(dir, 'absent-seed.json'),
  });

  assert.strictEqual(oui.catalogueStatus().state, 'unreadable');
  const r = oui.lookupOUI('00:00:0C:11:22:33');
  assert.strictEqual(r.state, 'unreadable');
  assert.notStrictEqual(r.state, 'unassigned');

  const c = classifyDevice('00:00:0C:11:22:33', 'some-host');
  assert.match(c.vendor, /catalogue unavailable/i);

  // ⛔ AND IT MUST NOT RE-RATE THE ESTATE. Treating "we could not read it" as
  // "unidentifiable vendor" would raise risk on every device on the network at
  // once — thousands of findings from our own outage, with no bad device
  // anywhere. The honest answer is that risk is not known.
  assert.strictEqual(c.risk_level, 'unknown');

  useCatalogue({ seed: null });
});

test('a newer sync is picked up without restarting the process', () => {
  // The sync runs in the API process; the collector is a different long-lived
  // process and would otherwise hold its start-up catalogue for weeks.
  const dir = tmpdir('reload');
  const cache = path.join(dir, 'oui-feed.json');
  fs.copyFileSync(SEED, cache);
  useCatalogue({ cache });
  assert.strictEqual(oui.catalogueStatus().source, 'hub-feed');

  const feed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const T = {};
  feed.tuple.forEach((n, i) => { T[n] = i; });
  feed.entries = feed.entries.map((e) =>
    e[T.prefix] === '00000C' ? [e[0], e[1], 'Renamed In A Later Feed', e[3]] : e);
  feed.feed_version = '2099-01-01.1';
  fs.writeFileSync(cache, JSON.stringify(feed));
  fs.utimesSync(cache, new Date(), new Date(Date.now() + 5000));

  oui.reload(); // stands in for the 60s mtime re-check
  assert.strictEqual(oui.lookupOUI('00:00:0C:11:22:33').vendor, 'Renamed In A Later Feed');
});

// ───────────────────────── E. the feed client ───────────────────────────────

test('a VALID signed body verifies end to end', async () => {
  const body = fs.readFileSync(SEED, 'utf8');
  const sig = fs.readFileSync(SEED_SIG, 'utf8').trim();
  const sha = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');

  const srv = await feedServer((req, res) => {
    res.setHeader('x-feed-signature', sig);
    res.setHeader('x-feed-sha256', sha);
    res.end(body);
  });
  const prev = process.env.NOCVAULT_EOL_FEED_URL;
  process.env.NOCVAULT_EOL_FEED_URL = srv.url;
  try {
    const { feed } = await ouiFeed.fetchVerifiedFeed();
    assert.strictEqual(feed.row_count, 54466);
  } finally {
    if (prev === undefined) delete process.env.NOCVAULT_EOL_FEED_URL;
    else process.env.NOCVAULT_EOL_FEED_URL = prev;
    await srv.close();
  }
});

test('a TAMPERED body fails verification and is never written', async () => {
  const body = fs.readFileSync(SEED, 'utf8').replace('Cisco Systems, Inc', 'Cisco Systems, Ina');
  const sig = fs.readFileSync(SEED_SIG, 'utf8').trim();

  const dir = tmpdir('tampered');
  const cache = path.join(dir, 'oui-feed.json');
  fs.copyFileSync(SEED, cache);
  const before = fs.readFileSync(cache, 'utf8');

  const srv = await feedServer((req, res) => {
    res.setHeader('x-feed-signature', sig);
    // sha256 recomputed over the tampered bytes, so the hash check PASSES and
    // only the signature can catch it — which is the realistic attack shape.
    res.setHeader('x-feed-sha256',
      createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'));
    res.end(body);
  });
  const prev = process.env.NOCVAULT_EOL_FEED_URL;
  process.env.NOCVAULT_EOL_FEED_URL = srv.url;
  process.env.DDIVAULT_OUI_CACHE = cache;
  try {
    await assert.rejects(() => ouiFeed.fetchVerifiedFeed(), /signature verification failed/);

    const result = await ouiFeed.syncOuiFeed({ force: true });
    assert.strictEqual(result.action, 'failed');
    assert.match(result.reason, /signature verification failed/);
    assert.strictEqual(fs.readFileSync(cache, 'utf8'), before, 'cache must be untouched');
  } finally {
    if (prev === undefined) delete process.env.NOCVAULT_EOL_FEED_URL;
    else process.env.NOCVAULT_EOL_FEED_URL = prev;
    await srv.close();
  }
});

test('an UNREACHABLE hub leaves the existing catalogue intact', async () => {
  const dir = tmpdir('unreachable');
  const cache = path.join(dir, 'oui-feed.json');
  fs.copyFileSync(SEED, cache);
  const before = fs.readFileSync(cache, 'utf8');

  // A port nothing is listening on.
  const srv = await feedServer((_req, res) => res.end('{}'));
  const deadUrl = srv.url;
  await srv.close();

  const prev = process.env.NOCVAULT_EOL_FEED_URL;
  process.env.NOCVAULT_EOL_FEED_URL = deadUrl;
  process.env.DDIVAULT_OUI_CACHE = cache;
  try {
    const result = await ouiFeed.syncOuiFeed({ force: true });
    assert.strictEqual(result.action, 'failed');
    assert.strictEqual(fs.readFileSync(cache, 'utf8'), before);

    // ⛔ and the app still resolves vendors afterwards
    useCatalogue({ cache });
    assert.strictEqual(oui.lookupOUI('00:00:0C:11:22:33').vendor, 'Cisco Systems, Inc');
  } finally {
    if (prev === undefined) delete process.env.NOCVAULT_EOL_FEED_URL;
    else process.env.NOCVAULT_EOL_FEED_URL = prev;
  }
});

test('a 200 that is not the feed is refused', async () => {
  // A captive portal, a login page and a moved endpoint all answer 200 with
  // bytes. This repo's most-repeated failure shape.
  const dir = tmpdir('html200');
  const cache = path.join(dir, 'oui-feed.json');
  fs.copyFileSync(SEED, cache);
  const before = fs.readFileSync(cache, 'utf8');

  const srv = await feedServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!DOCTYPE html><html><body>Sign in to the network</body></html>');
  });
  const prev = process.env.NOCVAULT_EOL_FEED_URL;
  process.env.NOCVAULT_EOL_FEED_URL = srv.url;
  process.env.DDIVAULT_OUI_CACHE = cache;
  try {
    const result = await ouiFeed.syncOuiFeed({ force: true });
    assert.strictEqual(result.action, 'failed');
    assert.strictEqual(fs.readFileSync(cache, 'utf8'), before);
  } finally {
    if (prev === undefined) delete process.env.NOCVAULT_EOL_FEED_URL;
    else process.env.NOCVAULT_EOL_FEED_URL = prev;
    await srv.close();
  }
});

test('an unchanged feed_version skips the 2.2 MB download', async () => {
  const dir = tmpdir('unchanged');
  const cache = path.join(dir, 'oui-feed.json');
  fs.copyFileSync(SEED, cache);
  const local = JSON.parse(fs.readFileSync(cache, 'utf8'));

  let bigDownloads = 0;
  const srv = await feedServer((req, res) => {
    if (req.url.endsWith('/latest')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ feed_version: local.feed_version, row_count: local.row_count }));
    }
    bigDownloads++;
    res.end('{}');
  });
  const prev = process.env.NOCVAULT_EOL_FEED_URL;
  process.env.NOCVAULT_EOL_FEED_URL = srv.url;
  process.env.DDIVAULT_OUI_CACHE = cache;
  try {
    const result = await ouiFeed.syncOuiFeed();
    assert.strictEqual(result.action, 'unchanged');
    assert.strictEqual(bigDownloads, 0, 'the full feed must not be fetched when unchanged');
  } finally {
    if (prev === undefined) delete process.env.NOCVAULT_EOL_FEED_URL;
    else process.env.NOCVAULT_EOL_FEED_URL = prev;
    await srv.close();
  }
});
