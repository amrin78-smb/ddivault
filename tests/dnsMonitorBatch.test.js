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

/**
 * ⛔ pollZoneSyncStatus now tries a real DNS SOA query first. Every test MUST inject a
 * fake client or it opens sockets to a fictional address and waits out the timeout.
 */
const SOA_DOWN = { querySoa: () => Promise.reject(new Error('ECONNREFUSED')) };
/** Answers every zone, with a per-zone serial from `serials` (default 100). */
function soaUp(serials = {}) {
  const asked = [];
  return {
    asked,
    querySoa(host, port, zone) {
      asked.push({ host, port, zone });
      const serial = serials[zone];
      if (serial === 'fail') return Promise.reject(new Error('no SOA in response'));
      return Promise.resolve({
        serial: serial == null ? 100 : serial,
        primary: 'dc01.example', email: 'hostmaster.example',
        refresh: 900, retry: 600, expire: 86400, minimum: 3600, ttl: 3600,
      });
    },
  };
}

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
  await dm.pollZoneSyncStatus(fakeDb(), ps, SERVER, IP, AUTH, zones, SOA_DOWN);
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
  await dm.pollZoneSyncStatus(db, ps, SERVER, IP, AUTH, zones, SOA_DOWN);
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 2,
    'the two readable zones must still be upserted');
  const serials = db.paramsFor('INSERT INTO dns_zone_sync').map(p => p[2]);
  assert.deepStrictEqual(serials, [10, 12]);
});

test('SOA: a zone missing from the map is skipped, not written as null', async () => {
  const zones = zonesOf('present.example', 'absent.example');
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: { 'present.example': SOA_OK(5) } }),
    SERVER, IP, AUTH, zones, SOA_DOWN);
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 1);
});

test('SOA: the cross-server recompute runs exactly once, after the pass', async () => {
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: { 'a.example': SOA_OK(1) } }),
    SERVER, IP, AUTH, zonesOf('a.example'), SOA_DOWN);
  assert.strictEqual(db.count('UPDATE dns_zone_sync s SET'), 1,
    'is_in_sync / lag_seconds must be recomputed once per pass');
  const last = db.queries[db.queries.length - 1];
  assert.ok(last.sql.includes('UPDATE dns_zone_sync s SET'), 'recompute must be the final query');
});

test('SOA: a thrown batch does not throw out, and still recomputes', async () => {
  const db = fakeDb();
  const ps = fakePs({ soa: new Error('WinRM unreachable') });
  await dm.pollZoneSyncStatus(db, ps, SERVER, IP, AUTH, zonesOf('a.example', 'b.example'), SOA_DOWN);
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 0, 'nothing is known, so nothing is written');
  assert.strictEqual(db.count('UPDATE dns_zone_sync s SET'), 1,
    'a total batch failure must still recompute, as the old per-zone loop did');
});

test('SOA: a null batch is treated as "nothing readable", not a crash', async () => {
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: null }), SERVER, IP, AUTH, zonesOf('a.example'), SOA_DOWN);
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 0);
});

test('SOA: an unparseable serial is skipped', async () => {
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: {
    'a.example': { ok: true, Serial: 'not-a-number' },
  } }), SERVER, IP, AUTH, zonesOf('a.example'), SOA_DOWN);
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


// ════════════════════════════════════════════════════════════════════════════
// 5. Protocol SOA — the pass that leaves WinRM entirely
// ════════════════════════════════════════════════════════════════════════════

test('protocol SOA: when DNS answers, ZERO WinRM calls are made', async () => {
  const zones = zonesOf(...Array.from({ length: 50 }, (_, i) => `z${i}.example`));
  const soa = soaUp();
  const ps = fakePs({ soa: {} });
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, ps, SERVER, IP, AUTH, zones, { soa });
  assert.strictEqual(ps.n.soa, 0, 'no WinRM batch should be needed when DNS answers');
  assert.strictEqual(soa.asked.length, 50, 'every zone should be asked over DNS');
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 50, 'all 50 upserted from the DNS read');
});

test('protocol SOA: the full SOA record is mapped onto the cmdlet field names', async () => {
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, fakePs({ soa: {} }), SERVER, IP, AUTH,
    zonesOf('a.example'), { soa: soaUp({ 'a.example': 4242 }) });
  const p = db.paramsFor('INSERT INTO dns_zone_sync')[0];
  // zone_name, server_id, serial, primary, email, refresh, retry, expire, ttl
  assert.deepStrictEqual(p, ['a.example', 7, 4242, 'dc01.example', 'hostmaster.example',
    900, 600, 86400, 3600]);
});

test('protocol SOA: it asks the configured dns_host and dns_port, not just the IP', async () => {
  const soa = soaUp();
  await dm.pollZoneSyncStatus(fakeDb(), fakePs({ soa: {} }),
    { id: 7, ip_address: IP, dns_host: '10.9.9.9', dns_port: 5353 },
    IP, AUTH, zonesOf('a.example'), { soa });
  assert.strictEqual(soa.asked[0].host, '10.9.9.9');
  assert.strictEqual(soa.asked[0].port, 5353);
});

test('protocol SOA: falls back to ip_address and 53 when no dns_host is set', async () => {
  const soa = soaUp();
  await dm.pollZoneSyncStatus(fakeDb(), fakePs({ soa: {} }), SERVER, IP, AUTH,
    zonesOf('a.example'), { soa });
  assert.strictEqual(soa.asked[0].host, IP);
  assert.strictEqual(soa.asked[0].port, 53);
});

test('protocol SOA: circuit breaker — a dead port 53 probes 3 zones, not 339', async () => {
  // ⛔ Without the breaker, 339 zones x one timeout each is ~17 minutes of dead waiting
  // per tick before we learn port 53 is unusable.
  const zones = zonesOf(...Array.from({ length: 339 }, (_, i) => `z${i}.example`));
  let asked = 0;
  const soa = { querySoa: () => { asked++; return Promise.reject(new Error('timeout')); } };
  const ps = fakePs({ soa: {} });
  await dm.pollZoneSyncStatus(fakeDb(), ps, SERVER, IP, AUTH, zones, { soa });
  assert.strictEqual(asked, 3, `the breaker must stop after DDI_SOA_PROBE_LIMIT probes, got ${asked}`);
  assert.strictEqual(ps.n.soa, 1, 'and hand the whole server to ONE batched WinRM read');
});

test('protocol SOA: a partial failure sends only the stragglers to WinRM', async () => {
  const zones = zonesOf('ok1.example', 'ok2.example', 'bad.example', 'ok3.example');
  const soa = soaUp({ 'bad.example': 'fail' });
  const ps = fakePs({ soa: { 'bad.example': { ok: true, Serial: 77 } } });
  const db = fakeDb();
  await dm.pollZoneSyncStatus(db, ps, SERVER, IP, AUTH, zones, { soa });
  assert.strictEqual(ps.n.soa, 1, 'one WinRM batch for the remainder');
  assert.strictEqual(db.count('INSERT INTO dns_zone_sync'), 4, 'all four zones still land');
  const serials = db.paramsFor('INSERT INTO dns_zone_sync').map(p => p[2]);
  assert.deepStrictEqual(serials, [100, 100, 77, 100], 'the WinRM serial is used for the straggler');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. The serial gate — an unchanged zone must cost nothing
// ════════════════════════════════════════════════════════════════════════════

/** A db whose dns_zones rows report the given prior state. */
function dbWithPrior(rows) {
  const db = fakeDb();
  const base = db.query;
  db.query = (sql, params) => {
    if (sql.includes('SELECT zone_name, soa_serial, record_count FROM dns_zones')) {
      db.queries.push({ sql, params });
      return Promise.resolve({ rows });
    }
    return base(sql, params);
  };
  return db;
}

test('gate: an unchanged serial with records already held is NOT reported changed', async () => {
  const db = dbWithPrior([{ zone_name: 'same.example', soa_serial: 100, record_count: 12 }]);
  const r = await dm.pollZoneSyncStatus(db, fakePs({ soa: {} }), SERVER, IP, AUTH,
    zonesOf('same.example'), { soa: soaUp({ 'same.example': 100 }) });
  assert.strictEqual(r.changed.size, 0, 'nothing moved, so nothing needs a record count');
});

test('gate: a MOVED serial is reported changed', async () => {
  const db = dbWithPrior([{ zone_name: 'moved.example', soa_serial: 100, record_count: 12 }]);
  const r = await dm.pollZoneSyncStatus(db, fakePs({ soa: {} }), SERVER, IP, AUTH,
    zonesOf('moved.example'), { soa: soaUp({ 'moved.example': 101 }) });
  assert.deepStrictEqual([...r.changed], ['moved.example']);
});

test('gate: an unchanged serial with NO records yet is still changed', async () => {
  // Otherwise a zone we have never counted would never be counted.
  const db = dbWithPrior([{ zone_name: 'fresh.example', soa_serial: 100, record_count: 0 }]);
  const r = await dm.pollZoneSyncStatus(db, fakePs({ soa: {} }), SERVER, IP, AUTH,
    zonesOf('fresh.example'), { soa: soaUp({ 'fresh.example': 100 }) });
  assert.deepStrictEqual([...r.changed], ['fresh.example']);
});

test('gate: a zone with no prior row at all is changed', async () => {
  const db = dbWithPrior([]);
  const r = await dm.pollZoneSyncStatus(db, fakePs({ soa: {} }), SERVER, IP, AUTH,
    zonesOf('new.example'), { soa: soaUp() });
  assert.deepStrictEqual([...r.changed], ['new.example']);
});

test('gate: an unreadable zone is not reported changed (a count would fail too)', async () => {
  const db = dbWithPrior([]);
  const ps = fakePs({ soa: { 'dead.example': { ok: false, error: 'rpc failure' } } });
  const r = await dm.pollZoneSyncStatus(db, ps, SERVER, IP, AUTH,
    zonesOf('dead.example'), { soa: SOA_DOWN });
  assert.strictEqual(r.changed.size, 0);
});

test('gate: pollZoneRecordCounts makes NO call for an empty zone list', async () => {
  const ps = fakePs({ counts: {} });
  await dm.pollZoneRecordCounts(fakeDb(), ps, IP, AUTH, []);
  assert.strictEqual(ps.n.counts, 0, 'a quiet tick must cost zero WinRM calls');
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Scavenging is time-gated, not serial-gated
// ════════════════════════════════════════════════════════════════════════════

test('scavenging: due on first sight, not due again immediately', async () => {
  // ⛔ Aging config is zone metadata and does NOT move the SOA serial, so it cannot be
  // serial-gated — a slow independent interval is the only correct gate.
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  assert.strictEqual(dm.scavengingDue(9001, now), true, 'never polled -> due');
});

test('scavenging: storedZoneState survives an un-migrated column', async () => {
  const db = { query: () => Promise.reject(new Error('column "soa_serial" does not exist')) };
  const m = await dm.storedZoneState(db, 7);
  assert.strictEqual(m.size, 0, 'a missing column means no prior state, not a crash');
});
