'use strict';
/**
 * dnsCollectionBatch.test.js — the LAST two per-zone WinRM loops must stay batched.
 *
 * Why this file exists, and why it is separate from dnsMonitorBatch.test.js:
 * 1.41.0/1.42.0 batched the four per-zone loops in collector/dnsMonitor.js and were
 * believed to have closed the 2026-11-25 DC auth flood. They had not. Measured against
 * the live database on 2026-11-27, two loops of the same shape survived in two OTHER
 * files, and between them they still issued ~472 credentialed WinRM calls an hour:
 *
 *   collector/haMonitor.js  pollDnsSoa -> ps.getDnsZoneSoa    every 15 min, 258 zones
 *   collector/collector.js  syncDns    -> ps.getDnsRecords    every 60 min, 214 zones
 *
 * That is the documented trap in .ai-codex/gotchas.md ("fixing one pass is not fixing
 * the class") landing on the very change that quoted it — the first fix covered one
 * FILE's class, not the codebase's.
 *
 * ⛔ THE REGRESSION THIS PINS is "N zones became N calls again", so the assertions are
 * on CALL COUNTS, not only on data. The fake `ps` objects here deliberately DO NOT
 * define the single-zone readers (`getDnsZoneSoa`, `getDnsRecords`): reverting either
 * loop makes these tests throw rather than quietly pass.
 *
 * Nothing here touches PowerShell, a database or a network. There is no Windows DNS
 * server available to this project, so string-level and behavioural tests plus live
 * production measurement are the verification for this path.
 *
 * Run: node --test tests/dnsCollectionBatch.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');

// ── execFile seam, installed BEFORE powershellRunner is required ─────────────
const calls = [];
let impl = (file, args, opts, cb) => { process.nextTick(() => cb(null, '', '')); };
childProcess.execFile = function fakeExecFile(file, args, opts, cb) {
  calls.push({ file, args, opts });
  impl(file, args, opts, cb);
  return { pid: -1 };
};

const ps = require('../collector/powershellRunner');
const writers = require('../collector/writers');
const ha = require('../collector/haMonitor');

const IP = '10.0.0.9';
const KERB = { auth_mode: 'kerberos' };

function reset() { calls.length = 0; impl = (f, a, o, cb) => process.nextTick(() => cb(null, '', '')); }
function cmdOf(c) {
  const i = c.args.indexOf('-Command');
  assert.ok(i >= 0 && c.args.length === i + 2, `expected one -Command arg, got ${JSON.stringify(c.args)}`);
  return c.args[i + 1];
}
const zones = (n, p = 'z') => Array.from({ length: n }, (_, i) => `${p}${i}.example.test`);

// ════════════════════════════════════════════════════════════════════════════
// A. getDnsRecordsBatch — the replacement for syncDns's per-zone reader
// ════════════════════════════════════════════════════════════════════════════

test('45 zones cost 3 calls, not 45, and every zone appears exactly once', async () => {
  reset();
  const names = zones(45);
  await ps.getDnsRecordsBatch(IP, KERB, names);
  assert.strictEqual(calls.length, 3, `expected ceil(45/20)=3 spawns, got ${calls.length}`);
  const joined = calls.map(cmdOf).join('\n');
  for (const n of names) {
    const hits = joined.split(`'${n}'`).length - 1;
    assert.strictEqual(hits, 1, `${n} appeared ${hits} times, expected exactly 1`);
  }
});

test('records use a SMALLER chunk than the aggregate readers (20, not 40)', async () => {
  reset();
  await ps.getDnsRecordsBatch(IP, KERB, zones(20));
  assert.strictEqual(calls.length, 1, 'exactly 20 zones must fit one chunk');
  reset();
  await ps.getDnsRecordsBatch(IP, KERB, zones(21));
  assert.strictEqual(calls.length, 2, '21 zones must split — a chunk of 40 would not');
});

test('zero zones spawns nothing at all', async () => {
  reset();
  const r = await ps.getDnsRecordsBatch(IP, KERB, []);
  assert.strictEqual(calls.length, 0, 'an empty zone list must not spawn powershell');
  assert.deepStrictEqual(r, {});
});

/**
 * Decode the single-quoted literals of a PowerShell fragment the way the PARSER does:
 * inside '...' the one and only escape is a doubled quote. A substring match is not
 * good enough here — correctly-escaped output ('') still CONTAINS the dangerous-looking
 * ('), which is exactly the false alarm the first version of this test raised.
 */
function psLiterals(fragment) {
  const out = [];
  let i = 0;
  while (i < fragment.length) {
    if (fragment[i] !== "'") { i++; continue; }
    i++;
    let buf = '';
    for (;;) {
      if (i >= fragment.length) throw new Error('unterminated literal — the quote escaped');
      if (fragment[i] === "'") {
        if (fragment[i + 1] === "'") { buf += "'"; i += 2; continue; }
        i++; break;
      }
      buf += fragment[i++];
    }
    out.push(buf);
  }
  return out;
}

test('a hostile zone name stays ONE inert literal and cannot break out', async () => {
  reset();
  const attack = "x'; Remove-Item C:\\ -Recurse; $(whoami) #";
  await ps.getDnsRecordsBatch(IP, KERB, [attack, 'ok.test']);
  const cmd = cmdOf(calls[0]);
  const zoneArray = cmd.match(/\$zones = @\((.*?)\); \$out/);
  assert.ok(zoneArray, 'could not locate the zone array literal');
  const decoded = psLiterals(zoneArray[1]);
  assert.deepStrictEqual(decoded, [attack, 'ok.test'],
    'the payload must survive as a single literal, neither split nor executable');
  assert.strictEqual((cmd.match(/'/g) || []).length % 2, 0, 'unbalanced single quotes');
});

test('the generated script respects all five documented PowerShell traps', async () => {
  reset();
  await ps.getDnsRecordsBatch(IP, KERB, zones(2));
  const cmd = cmdOf(calls[0]);
  assert.ok(/\$out = @\(\)/.test(cmd), 'trap 3: $out must be seeded as an array');
  assert.ok(/ConvertTo-Json -InputObject \$out/.test(cmd), 'trap 3: must use -InputObject, not a pipe');
  assert.ok(/-Depth 5/.test(cmd), 'trap 2: -Depth 5 is mandatory for the nested Records array');
  assert.ok(!/\}\s*\|\s*ConvertTo-Json/.test(cmd), 'trap 1: try/catch must not head a pipeline');
  assert.ok(!/-Parallel/.test(cmd), 'trap 5: PS 5.1 has no ForEach-Object -Parallel');
  assert.ok(/foreach \(\$z in \$zones\)/.test(cmd), 'must iterate server-side in one call');
});

test('the batch timeout is the long one — a 20-zone records read cannot fit 60s', async () => {
  reset();
  await ps.getDnsRecordsBatch(IP, KERB, zones(1));
  assert.strictEqual(calls[0].opts.timeout, 240000);
  assert.ok(calls[0].opts.maxBuffer >= 32 * 1024 * 1024, 'records need the 32MB buffer');
});

test('credential mode keeps the password out of argv', async () => {
  reset();
  const secret = 'S3cr3t-NotInArgv';
  await ps.getDnsRecordsBatch(IP, { auth_mode: 'credential', ps_username: 'd\\u', ps_password: secret }, zones(1));
  assert.ok(!JSON.stringify(calls[0].args).includes(secret), 'password must never reach the command line');
  assert.ok(cmdOf(calls[0]).includes('$env:DDI_PS_PASSWORD'), 'password must arrive via the child environment');
});

test('a wholly failed chunk marks every zone in it unreadable, never empty', async () => {
  reset();
  impl = (f, a, o, cb) => process.nextTick(() => cb(null, '', '')); // empty stdout => runPS null
  const r = await ps.getDnsRecordsBatch(IP, KERB, zones(3));
  for (const n of zones(3)) {
    assert.strictEqual(r[n].ok, false, `${n} must report ok:false`);
    assert.ok(r[n].error, `${n} must carry a reason`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// B. recordsByZoneFromBatch — omission is the contract
// ════════════════════════════════════════════════════════════════════════════

test('a zone that was READ and is EMPTY is omitted, and is not counted unread', () => {
  const { recordsByZone, unread } = writers.recordsByZoneFromBatch(
    { 'a.test': { ok: true, Records: [] } }, ['a.test']);
  assert.deepStrictEqual(recordsByZone, {});
  assert.strictEqual(unread, 0, 'empty is not the same as unreadable');
});

test('a zone that could NOT be read is omitted and counted — its stored records survive', () => {
  const { recordsByZone, unread } = writers.recordsByZoneFromBatch(
    { 'big.test': { ok: false, error: 'batch read failed' } }, ['big.test']);
  assert.ok(!('big.test' in recordsByZone),
    'an unread zone must be ABSENT: writeDnsZones only inserts for present zones, so [] would read as "emptied"');
  assert.strictEqual(unread, 1);
});

test('a zone missing entirely from the response is treated as unread, not empty', () => {
  const { recordsByZone, unread } = writers.recordsByZoneFromBatch({}, ['gone.test']);
  assert.deepStrictEqual(recordsByZone, {});
  assert.strictEqual(unread, 1);
});

test('one failed zone does not cost the others', () => {
  const { recordsByZone, unread } = writers.recordsByZoneFromBatch({
    'bad.test': { ok: false, error: 'x' },
    'good.test': { ok: true, Records: [{ HostName: 'www', RecordType: 'A', TTL: 3600, RecordData: '10.0.0.1' }] },
  }, ['bad.test', 'good.test']);
  assert.strictEqual(unread, 1);
  assert.strictEqual(recordsByZone['good.test'].length, 1);
  assert.ok(!('bad.test' in recordsByZone));
});

test('a single-record zone survives JSON object/array collapse', () => {
  const one = { HostName: 'solo', RecordType: 'A', TTL: 60, RecordData: '10.0.0.2' };
  const { recordsByZone } = writers.recordsByZoneFromBatch(
    { 'one.test': { ok: true, Records: one } }, ['one.test']);
  assert.deepStrictEqual(recordsByZone['one.test'], [one],
    'ConvertTo-Json may emit a lone record as an object, not an array');
});

test('a null batch (total failure) loses nothing', () => {
  const { recordsByZone, unread } = writers.recordsByZoneFromBatch(null, ['a.test', 'b.test']);
  assert.deepStrictEqual(recordsByZone, {});
  assert.strictEqual(unread, 2);
});

// ════════════════════════════════════════════════════════════════════════════
// C. pollDnsSoa — protocol first, zero WinRM on the happy path
// ════════════════════════════════════════════════════════════════════════════

const SERVER = { id: 3, hostname: 'dc01', ip_address: IP, role: 'dns', dns_platform: 'windows' };

function fakeDb(zoneRows, peerMax = null) {
  const queries = [];
  return {
    queries,
    count: (needle) => queries.filter(q => q.sql.includes(needle)).length,
    paramsFor: (needle) => queries.filter(q => q.sql.includes(needle)).map(q => q.params),
    query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM dns_zones WHERE server_id')) return Promise.resolve({ rows: zoneRows });
      if (sql.includes('maxserial')) return Promise.resolve({ rows: [{ maxserial: peerMax }] });
      return Promise.resolve({ rows: [{}] });
    },
  };
}

/** ⛔ getDnsZoneSoa is deliberately ABSENT — a reverted per-zone loop must throw. */
function fakePs() {
  const n = { soaBatch: 0 };
  return { n, getDnsZoneSoaDetailBatch(ip, auth, zs) { n.soaBatch++; return Promise.resolve({}); } };
}

const soaUp = (serial) => ({
  querySoa: () => Promise.resolve({ serial, primary: 'ns1', email: 'a@b', refresh: 900, retry: 600, expire: 86400, minimum: 3600, ttl: 3600 }),
});
const SOA_DOWN = { querySoa: () => Promise.reject(new Error('ETIMEDOUT')) };

test('when port 53 answers, 40 zones cost ZERO WinRM calls', async () => {
  const rows = zones(40).map((zn, i) => ({ id: i + 1, zone_name: zn }));
  const db = fakeDb(rows);
  const p = fakePs();
  await ha.pollDnsSoa(db, p, SERVER, KERB, { soa: soaUp(99) });
  assert.strictEqual(p.n.soaBatch, 0, 'protocol SOA must make no WinRM call at all');
  assert.strictEqual(db.count('UPDATE dns_zones SET soa_serial'), 40, 'every zone must still be written');
});

test('when port 53 is dead, 40 zones cost ONE batched call, not 40', async () => {
  const rows = zones(40).map((zn, i) => ({ id: i + 1, zone_name: zn }));
  const p = fakePs();
  await ha.pollDnsSoa(fakeDb(rows), p, SERVER, KERB, { soa: SOA_DOWN });
  assert.strictEqual(p.n.soaBatch, 1, 'the fallback must be ONE batched call for all zones');
});

test('the circuit breaker probes a handful, not every zone, when port 53 is dead', async () => {
  let asked = 0;
  const rows = zones(40).map((zn, i) => ({ id: i + 1, zone_name: zn }));
  const soa = { querySoa: () => { asked++; return Promise.reject(new Error('ETIMEDOUT')); } };
  await ha.pollDnsSoa(fakeDb(rows), fakePs(), SERVER, KERB, { soa });
  assert.ok(asked <= 3, `breaker must stop after the probe, asked ${asked} of 40`);
});

test('an unreadable zone is skipped and never written with a null serial', async () => {
  const rows = [{ id: 1, zone_name: 'good.test' }, { id: 2, zone_name: 'bad.test' }];
  const soa = { querySoa: (h, p, zone) => zone === 'bad.test'
    ? Promise.reject(new Error('NXDOMAIN'))
    : Promise.resolve({ serial: 5, primary: 'ns1', email: 'a@b', refresh: 1, retry: 1, expire: 1, minimum: 1, ttl: 1 }) };
  const db = fakeDb(rows);
  const p = fakePs();
  await ha.pollDnsSoa(db, p, SERVER, KERB, { soa });
  const written = db.paramsFor('UPDATE dns_zones SET soa_serial');
  assert.strictEqual(written.length, 1, 'only the readable zone may be written');
  assert.strictEqual(written[0][0], 1, 'and it must be the good zone');
});

test('no zones means no reads of any kind', async () => {
  let asked = 0;
  const p = fakePs();
  await ha.pollDnsSoa(fakeDb([]), p, SERVER, KERB, { soa: { querySoa: () => { asked++; return Promise.reject(new Error('x')); } } });
  assert.strictEqual(asked, 0);
  assert.strictEqual(p.n.soaBatch, 0, 'a quiet tick must cost nothing');
});

test('a protocol-platform server is left entirely alone', async () => {
  const p = fakePs();
  let asked = 0;
  await ha.pollDnsSoa(fakeDb([{ id: 1, zone_name: 'a.test' }]), p,
    Object.assign({}, SERVER, { dns_platform: 'bind' }), KERB,
    { soa: { querySoa: () => { asked++; return Promise.resolve({ serial: 1 }); } } });
  assert.strictEqual(asked, 0);
  assert.strictEqual(p.n.soaBatch, 0);
});
