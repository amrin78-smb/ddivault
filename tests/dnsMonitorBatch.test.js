'use strict';
/**
 * dnsMonitorBatch.test.js — the per-zone loops must stay BATCHED.
 *
 * Why this file exists: on 2026-11-25 a firewall flagged a brute-force attempt from
 * the NocVault server on port 5985. It was this collector. dnsMonitor.js had four
 * per-zone loops, each issuing one WinRM call per zone, and with 339 production zones
 * a 20-minute tick was ~1,017 `Invoke-Command -Credential` calls per server — a
 * measured 95-173 domain logons per minute against four DCs.
 *
 * ⛔ THE REGRESSION THIS PINS is "N zones became N calls again". Hence every test
 * asserts the CALL COUNT, not just the data. A reviewer tempted to put a `for (const
 * z of zones)` back around a single-zone reader will fail these.
 *
 * The second thing it pins is per-zone failure isolation. The old loops used
 * `continue` so one bad zone cost nothing; batching collapses N failure domains into
 * ceil(N/40), and these tests are what keep one unreadable zone from losing the rest.
 *
 * Uses node:test with a fake db and a fake ps — both are passed in explicitly by the
 * (db, ps, ...) signatures, so nothing here touches PowerShell or a database. There is
 * no Windows DNS server available to this project (staging is Windows 11 Home, which
 * cannot run the DNS Server role), so string-level and behavioural tests plus live
 * production measurement are the verification for this path.
 *
 * Regression suite: node --test tests/dnsMonitorBatch.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const dm = require('../collector/dnsMonitor');

const IP = '10.0.0.1';
const AUTH = { auth_mode: 'kerberos' };
const SERVER = { id: 7, hostname: 'dc01', ip_address: IP };

/** Records every query; returns no rows. */
function fakeDb() {
  const queries = [];
  return {
    queries,
    query(sql, params) { queries.push({ sql, params }); return Promise.resolve({ rows: [] }); },
    /** How many recorded queries contain `needle`. */
    count(needle) { return queries.filter(q => q.sql.includes(needle)).length; },
    /** Params of the nth query containing `needle`. */
    paramsFor(needle) { return queries.filter(q => q.sql.includes(needle)).map(q => q.params); },
  };
}

/** A ps whose batch readers return canned maps and count their invocations. */
function fakePs(maps) {
  const n = { soa: 0, counts: 0, scav: 0, stale: 0 };
  const give = (key) => (map) => {
    if (map instanceof Error) return Promise.reject(map);
    return Promise.resolve(map);
  };
  return {
    n,
    getDnsZoneSoaDetailBatch(ip, auth, zones) { n.soa++; return give()(maps.soa); },
    getDnsZoneRecordCountsBatch(ip, auth, zones) { n.counts++; return give()(maps.counts); },
    getDnsZoneScavengingBatch(ip, auth, zones) { n.scav++; return give()(maps.scav); },
    getDnsStaleRecordsBatch(ip, auth, zones, days) { n.stale++; return give()(maps.stale); },
    // ⛔ Deliberately absent: the single-zone readers. If a loop is ever reverted to
    // per-zone calls, it will throw "is not a function" here rather than quietly pass.
  };
}

const zonesOf = (...names) => names.map((zone_name, i) => ({ id: i + 1, zone_name }));

// Keep the collector's own logging out of the test output.
const realLog = console.log, realWarn = console.warn, realErr = console.error;
test.before(() => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
test.after(() => { console.log = realLog; console.warn = realWarn; console.error = realErr; });

const SOA_OK = (serial) => ({
  ok: true, Serial: serial, PrimaryServer: 'dc01.example', AdminEmail: 'hostmaster.example',
  Refresh: 900, Retry: 600, Expire: 86400, MinTTL: 3600,
});

// ════════════════════════════════════════════════════════════════════════════
// 1. SOA
// ════════════════════════════════════════════════════════════════════════════

test('SOA: 85 zones make ONE batch call, not 85', async () => {
  const zones = zonesOf(...Array.from({ length: 85 }, (_, i) => `z${i}.example`));
  const soa = {};
  for (const z of zones) soa[z.zone_name] = SOA_OK(100);
  const ps = fakePs({ soa });
  await dm.pollZoneSyncStatus(fakeDb(), ps, SERVER, IP, AUTH, zones);
  assert.strictEqual(ps.n.soa, 1, 'the whole zone list must be read in one batch call');
});

test('SOA: one unreadable zone does not cost the others', async () => {
  const zones = zonesOf('a.example', 'bad.example', 'c.example');
  const db = fakeDb();
  const ps = fakePs({ soa: {
    'a.example': SOA_OK(10),
    'bad.example': { ok: false, error: 'zone not found' },
    'c.example': SOA_OK(12),
  } });
  await dm.pollZoneSyncStatus(db, ps, SERVER, IP, AUTH, zones);
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 2,
    'the two readable zones must still be upserted');
  const serials = db.paramsFor('INSERT INTO dns_zone_sync').map(p => p[2]);
  assert.deepStrictEqual(serials, [10, 12]);
});

test('SOA: a zone missing from the map is skipped, not written as null', async () => {
  const zones = zonesOf('present.example', 'absent.example');
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: { 'present.example': SOA_OK(5) } }),
    SERVER, IP, AUTH, zones);
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 1);
});

test('SOA: the cross-server recompute runs exactly once, after the pass', async () => {
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: { 'a.example': SOA_OK(1) } }),
    SERVER, IP, AUTH, zonesOf('a.example'));
  assert.strictEqual(db.count('UPDATE dns_zone_sync s SET'), 1,
    'is_in_sync / lag_seconds must be recomputed once per pass');
  const last = db.queries[db.queries.length - 1];
  assert.ok(last.sql.includes('UPDATE dns_zone_sync s SET'), 'recompute must be the final query');
});

test('SOA: a thrown batch does not throw out, and still recomputes', async () => {
  const db = fakeDb();
  const ps = fakePs({ soa: new Error('WinRM unreachable') });
  await dm.pollZoneSyncStatus(db, ps, SERVER, IP, AUTH, zonesOf('a.example', 'b.example'));
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 0, 'nothing is known, so nothing is written');
  assert.strictEqual(db.count('UPDATE dns_zone_sync s SET'), 1,
    'a total batch failure must still recompute, as the old per-zone loop did');
});

test('SOA: a null batch is treated as "nothing readable", not a crash', async () => {
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: null }), SERVER, IP, AUTH, zonesOf('a.example'));
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 0);
});

test('SOA: an unparseable serial is skipped', async () => {
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: {
    'a.example': { ok: true, Serial: 'not-a-number' },
  } }), SERVER, IP, AUTH, zonesOf('a.example'));
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Record counts
// ════════════════════════════════════════════════════════════════════════════

test('counts: 60 zones make ONE batch call', async () => {
  const zones = zonesOf(...Array.from({ length: 60 }, (_, i) => `z${i}.example`));
  const counts = {};
  for (const z of zones) counts[z.zone_name] = { ok: true, Total: 1, A: 1, PTR: 0, CNAME: 0, MX: 0 };
  const ps = fakePs({ counts });
  await dm.pollZoneRecordCounts(fakeDb(), ps, IP, AUTH, zones);
  assert.strictEqual(ps.n.counts, 1);
});

test('counts: an unreadable zone is skipped, readable ones written', async () => {
  const db = fakeDb();
  await dm.pollZoneRecordCounts(db, fakePs({ counts: {
    'a.example': { ok: true, Total: 9, A: 4, PTR: 2, CNAME: 1, MX: 2 },
    'bad.example': { ok: false, error: 'access denied' },
  } }), IP, AUTH, zonesOf('a.example', 'bad.example'));
  assert.strictEqual(db.count('record_count_a'), 1);
  assert.deepStrictEqual(db.paramsFor('record_count_a')[0], [1, 4, 2, 1, 2, 9]);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Scavenging
// ════════════════════════════════════════════════════════════════════════════

test('scavenging: one batch call, and aging is persisted per zone', async () => {
  const db = fakeDb();
  const ps = fakePs({ scav: {
    'on.example': { ok: true, AgingEnabled: true },
    'off.example': { ok: true, AgingEnabled: false },
    'bad.example': { ok: false, error: 'rpc failure' },
  } });
  await dm.pollScavenging(db, ps, IP, AUTH, zonesOf('on.example', 'off.example', 'bad.example'));
  assert.strictEqual(ps.n.scav, 1);
  assert.strictEqual(db.count('scavenging_enabled'), 2, 'only the two readable zones are written');
  assert.deepStrictEqual(db.paramsFor('scavenging_enabled'), [[1, true, true], [2, false, false]]);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Stale records — the snapshot-deleting one
// ════════════════════════════════════════════════════════════════════════════

test('stale: an unreadable zone KEEPS its prior snapshot (no DELETE)', async () => {
  // ⛔ This is the sharp one. detectStaleRecords DELETEs a zone's rows before
  // inserting the fresh set, so treating "could not read" as "no stale records"
  // silently wipes real data and reports zero.
  const db = fakeDb();
  db.query = (sql, params) => {
    db.queries.push({ sql, params });
    if (sql.includes('FROM dns_zones WHERE server_id')) {
      return Promise.resolve({ rows: zonesOf('empty.example', 'broken.example') });
    }
    return Promise.resolve({ rows: [] });
  };
  const ps = fakePs({ stale: {
    'empty.example': { ok: true, Records: [] },
    'broken.example': { ok: false, error: 'access denied' },
  } });
  await dm.detectStaleRecords(db, ps, [SERVER], () => AUTH);

  assert.strictEqual(ps.n.stale, 1, 'one batch call for the whole server');
  const deletes = db.queries.filter(q => q.sql.includes('DELETE FROM dns_stale_records'));
  assert.strictEqual(deletes.length, 1,
    'exactly one zone was readable, so exactly one snapshot may be cleared');
  assert.strictEqual(deletes[0].params[0], 1,
    'the DELETE must target the READABLE zone (id 1), never the unreadable one');
});

test('stale: records from a readable zone are inserted', async () => {
  const db = fakeDb();
  db.query = (sql, params) => {
    db.queries.push({ sql, params });
    if (sql.includes('FROM dns_zones WHERE server_id')) {
      return Promise.resolve({ rows: zonesOf('a.example') });
    }
    return Promise.resolve({ rows: [] });
  };
  await dm.detectStaleRecords(db, fakePs({ stale: {
    'a.example': { ok: true, Records: [
      { HostName: 'old1', RecordType: 'A', TimeStamp: '/Date(1700000000000)/' },
      { HostName: 'old2', RecordType: 'A', TimeStamp: null },
    ] },
  } }), [SERVER], () => AUTH);
  assert.strictEqual(db.count('INSERT INTO dns_stale_records'), 2);
});
