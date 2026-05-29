'use strict';
/**
 * scanWorker.js — runs as a child_process.fork()
 * Completely isolated from the API process.
 * Receives subnet via process.argv, runs scan, exits.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { scanSubnet } = require('./ipamScanner');

const subnetId     = parseInt(process.argv[2]);
const network      = process.argv[3];
const prefixLength = parseInt(process.argv[4]);
const name         = process.argv[5] || '';

if (!subnetId || !network || !prefixLength) {
  console.error('[ScanWorker] Missing args: subnetId network prefixLength');
  process.exit(1);
}

console.log(`[ScanWorker] Starting scan for ${network}/${prefixLength} (id=${subnetId})`);

scanSubnet({ id: subnetId, network, prefix_length: prefixLength, name })
  .then(() => {
    console.log(`[ScanWorker] Scan complete for ${network}/${prefixLength}`);
    process.exit(0);
  })
  .catch(err => {
    console.error(`[ScanWorker] Scan failed: ${err.message}`);
    process.exit(1);
  });
