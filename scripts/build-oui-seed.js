#!/usr/bin/env node
'use strict';
/**
 * build-oui-seed.js — refresh the BUNDLED OUI catalogue, data/oui-seed.json.
 *
 * Replaces scripts/update-oui.js and scripts/expand-oui.js.
 *
 * ⛔ THIS IS NOT HOW THE CATALOGUE STAYS CURRENT ANY MORE, AND THAT IS THE
 * POINT. DDIVault used to depend on a human remembering to run a script:
 * measured 2026-11-16, data/oui.json held 39,267 entries last rebuilt
 * 2026-06-05 — over five months stale. The running app now pulls the hub's
 * signed feed on a schedule (api/ouiFeed.js). This script only refreshes the
 * copy COMMITTED to the repo, which exists so a brand-new install resolves MAC
 * vendors before it has ever reached the network, and so an install that can
 * never reach the hub still works.
 *
 * ⛔ THE SEED AND THE SYNC ARE THE SAME BYTES IN THE SAME FORMAT. One parser
 * reads both (api/ouiLookup.js); a seed in its own shape would be a second
 * format to keep in step, and it would be exercised only on the code path that
 * runs when something has already gone wrong.
 *
 * ⛔ WHY THE IEEE REGISTRY IS NOT READ DIRECTLY HERE. update-oui.js said IEEE
 * "actively blocks scripted clients (HTTP 418)" and took Wireshark's
 * republished `manuf` instead. That reason was stale — all three IEEE CSVs
 * answer HTTP 200 — but reading them here would still be wrong: it would make
 * this app a second, unsigned, differently-parsed implementation of what the
 * hub already publishes with a signature. One parser, one publisher.
 *
 *   node scripts/build-oui-seed.js
 */

const fs = require('fs');
const path = require('path');

const { fetchVerifiedFeed, sigPathFor } = require('../api/ouiFeed');
const { seedPath } = require('../api/ouiLookup');

function summarise(feed) {
  const T = {};
  feed.tuple.forEach((name, i) => { T[name] = i; });

  const byBits = {};
  let registryBlocks = 0;
  let privateRows = 0;
  for (const e of feed.entries) {
    byBits[e[T.prefix_bits]] = (byBits[e[T.prefix_bits]] || 0) + 1;
    if (e[T.is_registry_block]) registryBlocks++;
    if (/^private$/i.test(String(e[T.org]).trim())) privateRows++;
  }
  return { byBits, registryBlocks, privateRows };
}

async function main() {
  const SEED = seedPath();
  let previous = 0;
  try {
    previous = JSON.parse(fs.readFileSync(SEED, 'utf8')).entries.length;
  } catch (_) { /* first run */ }

  console.log('[oui-seed] fetching the signed catalogue from the hub...');
  const { body, feed, signature } = await fetchVerifiedFeed();

  const { byBits, registryBlocks, privateRows } = summarise(feed);

  fs.mkdirSync(path.dirname(SEED), { recursive: true });
  fs.writeFileSync(SEED, body, 'utf8');

  // ⛔ THE SIGNATURE SHIPS WITH THE SEED. Without it the committed catalogue is
  // just a large JSON file that nobody can tell apart from an edited one, and
  // 54,466 rows is far past the size anyone reviews in a diff. With it, the
  // test suite re-verifies on every run that these bytes are the hub's.
  fs.writeFileSync(sigPathFor(SEED), signature + '\n', 'utf8');

  console.log(`[oui-seed] wrote ${SEED}`);
  console.log(`[oui-seed] wrote ${sigPathFor(SEED)}`);
  console.log(`[oui-seed]   feed_version   ${feed.feed_version}  (match_version ${feed.match_version})`);
  console.log(`[oui-seed]   assignments    ${feed.entries.length}` + (previous ? `  (was ${previous})` : ''));
  console.log(`[oui-seed]   by prefix bits ${JSON.stringify(byBits)}`);
  console.log(`[oui-seed]   registry blocks ${registryBlocks} — rendered as UNKNOWN, never as the registrar`);
  console.log(`[oui-seed]   "Private" rows  ${privateRows} — IEEE's own answer, distinct from unassigned`);
  console.log(`[oui-seed]   bytes          ${Buffer.byteLength(body, 'utf8')}`);
}

main().catch((e) => {
  // ⛔ A FAILED BUILD MUST NOT LEAVE A SHORTER SEED BEHIND. Nothing is written
  // before verification succeeds, so the committed copy is untouched here.
  console.error('[oui-seed] FAILED, seed left unchanged:', e && e.message ? e.message : e);
  process.exit(1);
});
