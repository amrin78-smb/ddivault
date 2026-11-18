'use strict';
/**
 * dnsProviders.test.js — BIND and PowerDNS providers against REAL servers.
 *
 * ⛔ THESE BRANCHES CANNOT BE PROVEN BY READING. A zone transfer that is refused,
 * a signature that does not verify, a statistics channel that is switched off —
 * each returns something plausible, and a mock would return whatever the author
 * assumed. The servers here are the actual implementations the feature claims to
 * support.
 *
 * Needs the container lab:  tests/dnslab/lab.sh up
 * Skipped (not failed) when it is not running, so the suite still runs on a box
 * without podman — the same "could not measure here" rule the PowerShell checks
 * follow.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const dns = require('../collector/dns');
const caps = require('../collector/dns/capabilities');
const client = require('../collector/dns/client');

const BIND = dns.serverContext({
  id: 1, hostname: 'bind-lab', dns_platform: 'bind',
  dns_host: '127.0.0.1', dns_port: 5354,
  tsig_key_name: 'ddivault', tsig_algorithm: 'hmac-sha256',
  tsig_secret: 'c3BhbnZhdWx0LXRlc3Qta2V5LWRvLW5vdC11c2U9PQ==',
  dns_stats_url: 'http://127.0.0.1:8653',
});
const PDNS = dns.serverContext({
  id: 2, hostname: 'pdns-lab', dns_platform: 'powerdns',
  dns_host: '127.0.0.1', dns_port: 5355,
  dns_api_url: 'http://127.0.0.1:8081', dns_api_key: process.env.DDI_LAB_PDNS_KEY || 'ddivault-lab-api-key',
});

function reachable(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} res(v); };
    s.setTimeout(1500, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
let LAB = null;
const PORT_UP = new Map();
async function labUp(port) {
  if (port !== undefined) {
    if (!PORT_UP.has(port)) PORT_UP.set(port, await reachable(port));
    return PORT_UP.get(port);
  }
  if (LAB === null) LAB = (await reachable(5354)) && (await reachable(5355)) && (await reachable(8653)) && (await reachable(8081));
  if (!LAB) console.log('    (lab not running — start it with tests/dnslab/lab.sh up)');
  return LAB;
}

test('BIND: statistics channel identifies the server', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await dns.providerFor('bind').testConnection(BIND);
  assert.strictEqual(r.ok, true, r.detail);
  assert.match(String(r.version), /^9\./, 'BIND 9 version string');
});

test('BIND: built-in pseudo-zones are filtered out', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const zones = await dns.providerFor('bind').listZones(BIND);
  const names = zones.map((z) => z.zone_name);
  // ⛔ A stock BIND reports authors.bind / hostname.bind / version.bind /
  // id.server as zones. Left in, every BIND server grows four phantom zones
  // that then fail to transfer on every cycle.
  for (const b of ['authors.bind', 'hostname.bind', 'version.bind', 'id.server']) {
    assert.ok(!names.includes(b), `${b} must not be reported as a zone`);
  }
  assert.ok(names.includes('lab.example'), 'real zone present');
  assert.ok(names.includes('10.in-addr.arpa'), 'reverse zone present');
  assert.strictEqual(zones.find((z) => z.zone_name === '10.in-addr.arpa').is_reverse, true);
});

test('BIND: AXFR is refused without the TSIG key', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  await assert.rejects(
    client.axfr({ host: '127.0.0.1', port: 5354, zone: 'lab.example' }),
    /REFUSED/, 'an unauthenticated transfer must not succeed');
});

test('BIND: AXFR with TSIG returns records AND verifies the response', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await dns.providerFor('bind').getZoneRecords(BIND, 'lab.example');
  assert.strictEqual(r.verified, true,
    'the response must be TSIG-verified — signing only the request proves nothing about the responder');
  assert.ok(r.records.length >= 9, 'records transferred: ' + r.records.length);
  const web = r.records.filter((x) => x.hostname === 'web' && x.record_type === 'A');
  // ⛔ Round-robin: two A records on one name are TWO rows, not one.
  assert.strictEqual(web.length, 2, 'both A records for web are kept');
  assert.ok(r.records.every((x) => x.record_type !== 'SOA'), 'SOA is zone-level, not a record row');
  assert.ok(r.records.some((x) => x.hostname === '@'), 'apex records relativised to @');
});

test('BIND: a wrong TSIG key is rejected, never silently accepted', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  await assert.rejects(
    client.axfr({
      host: '127.0.0.1', port: 5354, zone: 'lab.example',
      tsig: { keyName: 'ddivault', algorithm: 'hmac-sha256', secret: Buffer.from('not-the-key').toString('base64') },
    }),
    /verification failed|BADSIG|TSIG/, 'a bad key must fail loudly');
});

test('BIND: SOA serial is readable (this is what gates transfers)', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const soa = await dns.providerFor('bind').getSoa(BIND, 'lab.example');
  assert.ok(Number.isFinite(soa.serial) && soa.serial > 0, 'serial: ' + soa.serial);
  assert.ok(soa.primary, 'primary nameserver present');
});

test('BIND: query statistics are cumulative and labelled as such', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const s = await dns.providerFor('bind').getQueryStats(BIND);
  assert.strictEqual(s.cumulative, true, 'counters are since-boot, not per-interval');
  assert.ok(Number.isFinite(s.total_queries));
  assert.ok(s.boot_time, 'boot_time present so a restart is distinguishable from a quiet period');
});

test('PowerDNS: API identifies the daemon, and a bad key is refused', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const p = dns.providerFor('powerdns');
  const ok = await p.testConnection(PDNS);
  assert.strictEqual(ok.ok, true, ok.detail);
  const bad = await p.testConnection({ ...PDNS, dns_api_key: 'definitely-wrong' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.detail, /rejected the API key/, 'a 401 must say "key", not a generic failure');
});

test('PowerDNS: rrsets are expanded into individual records', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await dns.providerFor('powerdns').getZoneRecords(PDNS, 'pdns.example');
  const web = r.records.filter((x) => x.hostname === 'web' && x.record_type === 'A');
  // ⛔ The API returns ONE rrset carrying two contents. Writing rrsets through
  // would under-count every round-robin host in the estate.
  assert.strictEqual(web.length, 2, 'the two-address rrset became two rows');
  assert.ok(r.records.some((x) => x.hostname === '@' && x.record_type === 'MX'));
  assert.ok(r.records.every((x) => x.record_type !== 'SOA'));
});

test('PowerDNS: zone kinds map onto the existing vocabulary', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const zones = await dns.providerFor('powerdns').listZones(PDNS);
  assert.ok(zones.length >= 2);
  assert.ok(zones.every((z) => ['Primary', 'Secondary', 'Forwarder'].includes(z.zone_type)),
    'kinds: ' + zones.map((z) => z.zone_type).join(','));
  assert.strictEqual(zones.find((z) => z.zone_name === '1.10.in-addr.arpa').is_reverse, true);
});

test('PowerDNS: a counter the server does not report is null, never 0', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const s = await dns.providerFor('powerdns').getQueryStats(PDNS);
  // ⛔ PowerDNS authoritative has no NXDOMAIN counter. A 0 would read as "this
  // server never returns NXDOMAIN", which is a measurement we never made.
  assert.strictEqual(s.nxdomain_count, null, 'unreported counter must be null');
  assert.ok(Number.isFinite(s.total_queries));
});

test('both providers produce the same ROW SHAPE', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const b = await dns.providerFor('bind').getZoneRecords(BIND, 'lab.example');
  const p = await dns.providerFor('powerdns').getZoneRecords(PDNS, 'pdns.example');
  const keys = (r) => Object.keys(r).sort().join(',');
  assert.strictEqual(keys(b.records[0]), keys(p.records[0]),
    'a BIND row and a PowerDNS row must be indistinguishable to writers.js');
  assert.strictEqual(keys(b.records[0]), 'hostname,record_data,record_type,ttl');
});

test('both providers spell the same record the SAME WAY', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  // ⛔ THE SHAPE TEST ABOVE WAS NOT ENOUGH, AND THIS IS THE TEST THAT CAUGHT IT.
  // It compared Object.keys(), which matched, while the VALUES differed: AXFR
  // gave `ns1.lab.example` and `v=spf1 -all`, the PowerDNS API gave
  // `ns1.pdns.example.` and `"v=spf1 -all"`. dns_records' unique key includes
  // record_data, so two spellings of one record DUPLICATE instead of colliding,
  // and a zone migrated between platforms silently doubles. Found on a real
  // staging run, not here — hence this test.
  const b = await dns.providerFor('bind').getZoneRecords(BIND, 'lab.example');
  const p = await dns.providerFor('powerdns').getZoneRecords(PDNS, 'pdns.example');

  // The fixtures are deliberately the same zone with a different name, so after
  // swapping the zone name the two sets must be byte-identical.
  const canon = (rows, zone) => rows
    .map((r) => `${r.hostname}|${r.record_type}|${r.record_data.split(zone).join('<ZONE>')}`)
    .sort();
  assert.deepStrictEqual(canon(b.records, 'lab.example'), canon(p.records, 'pdns.example'));
});

test('no record_data carries a trailing dot or surrounding quotes', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  for (const [name, srv, zone] of [['bind', BIND, 'lab.example'], ['powerdns', PDNS, 'pdns.example']]) {
    const r = await dns.providerFor(name).getZoneRecords(srv, zone);
    for (const row of r.records) {
      assert.ok(!/\.$/.test(row.record_data),
        `${name} ${row.hostname} ${row.record_type} has a trailing dot: ${row.record_data}`);
      assert.ok(!/^".*"$/.test(row.record_data),
        `${name} ${row.hostname} ${row.record_type} is quoted: ${row.record_data}`);
    }
  }
});

// ── readiness ("Test Connection") ────────────────────────────────────────────

const { testProtocolServer } = require('../collector/dns/readiness');

test('a correctly configured BIND server passes every check', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await testProtocolServer(BIND);
  assert.strictEqual(r.ok, true, r.summary);
  const names = r.checks.map((c) => c.name);
  assert.ok(names.includes('Statistics channel'));
  assert.ok(names.includes('Zone transfer (AXFR)'));
  const axfr = r.checks.find((c) => c.name === 'Zone transfer (AXFR)');
  assert.match(axfr.detail, /TSIG verified/, 'the transfer is authenticated: ' + axfr.detail);
});

test('a missing TSIG key reports the named.conf that fixes it', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await testProtocolServer({ ...BIND, tsig_key_name: null, tsig_secret: null });
  assert.strictEqual(r.ok, false);
  const axfr = r.checks.find((c) => c.name === 'Zone transfer (AXFR)');
  assert.ok(axfr && !axfr.ok, 'the transfer check failed');
  // ⛔ The whole point: the operator can finish the job from this message,
  // without reading our documentation.
  assert.match(axfr.fix, /allow-transfer \{ key/, 'fix names allow-transfer: ' + axfr.fix);
  assert.match(axfr.fix, /key "ddivault"/, 'fix uses the key name they configured');
});

test('a wrong TSIG secret says BADSIG in words, not a number', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await testProtocolServer({ ...BIND, tsig_secret: Buffer.from('nope').toString('base64') });
  assert.strictEqual(r.ok, false);
  // ⛔ "TSIG error 16" is what a search engine is for. 16 is a wrong SECRET and
  // 17 is a wrong key NAME — two different one-line fixes.
  assert.match(r.summary, /BADSIG/, r.summary);
  assert.match(r.summary, /secret does not match/, r.summary);
  assert.ok(!/error 16/.test(r.summary), 'the raw code is not what is shown');
});

test('a missing statistics channel is reported as its own fix', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await testProtocolServer({ ...BIND, dns_stats_url: null });
  assert.strictEqual(r.ok, false);
  const c = r.checks.find((x) => x.name === 'Statistics channel');
  assert.ok(c && !c.ok);
  assert.match(c.fix, /statistics-channels/, c.fix);
});

test('the summary reports the FIRST failure, not a count', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  // With no statistics channel, everything downstream of it is unavailable too.
  const r = await testProtocolServer({ ...BIND, dns_stats_url: null });
  assert.ok(!/\d+ checks? failed/.test(r.summary),
    'the checks are dependency-ordered; a count reports one problem several times');
  assert.match(r.summary, /statistics channel/i, r.summary);
});

test('PowerDNS: a rejected API key is named as a key problem', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await testProtocolServer({ ...PDNS, dns_api_key: 'definitely-wrong' });
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /rejected the API key/, r.summary);
  const c = r.checks.find((x) => x.name === 'API');
  assert.match(c.fix, /api-key=/, 'fix points at the right pdns.conf line: ' + c.fix);
});

test('PowerDNS: a correct config passes and reads records', async (t) => {
  if (!await labUp()) return t.skip('lab down');
  const r = await testProtocolServer(PDNS);
  assert.strictEqual(r.ok, true, r.summary);
  const rec = r.checks.find((c) => c.name === 'Records');
  assert.ok(rec && rec.ok, 'records readable');
});

test('a server with no DNS host is rejected before any network call', async (t) => {
  const r = await testProtocolServer({ dns_platform: 'bind', dns_host: '' });
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /No DNS host/);
});

// ── the generic platform: Knot, NSD, anything that speaks AXFR ───────────────

const KNOT = dns.serverContext({
  id: 3, hostname: 'knot-lab', dns_platform: 'generic',
  dns_host: '127.0.0.1', dns_port: 5356,
  tsig_key_name: 'ddivault', tsig_algorithm: 'hmac-sha256',
  tsig_secret: 'c3BhbnZhdWx0LXRlc3Qta2V5LWRvLW5vdC11c2U9PQ==',
  dns_zone_list: 'knot.example',
});

test('Knot is collected by the generic provider with no vendor code', async (t) => {
  if (!await labUp(5356)) return t.skip('knot not running');
  const p = dns.providerFor('generic');
  const zones = await p.listZones(KNOT);
  assert.strictEqual(zones.length, 1);
  assert.strictEqual(zones[0].zone_name, 'knot.example');
  assert.ok(Number.isFinite(zones[0].serial), 'serial confirmed by a live SOA query');

  const r = await p.getZoneRecords(KNOT, 'knot.example');
  assert.strictEqual(r.verified, true, 'TSIG-verified against Knot');
  assert.strictEqual(r.records.filter((x) => x.hostname === 'web' && x.record_type === 'A').length, 2);
});

test('Knot records are spelt exactly like BIND records', async (t) => {
  if (!await labUp(5356) || !await labUp()) return t.skip('lab down');
  // ⛔ A third implementation is the real test of the normalisation: if the
  // spelling only matched between two, it could be coincidence.
  const b = await dns.providerFor('bind').getZoneRecords(BIND, 'lab.example');
  const k = await dns.providerFor('generic').getZoneRecords(KNOT, 'knot.example');
  const canon = (rows, zone) => rows
    .map((r) => `${r.hostname}|${r.record_type}|${r.record_data.split(zone).join('<ZONE>')}`)
    .sort();
  assert.deepStrictEqual(canon(b.records, 'lab.example'), canon(k.records, 'knot.example'));
});

test('generic: AXFR without the key is refused by Knot too', async (t) => {
  if (!await labUp(5356)) return t.skip('knot not running');
  await assert.rejects(
    client.axfr({ host: '127.0.0.1', port: 5356, zone: 'knot.example' }),
    /NOTAUTH|REFUSED/);
});

test('generic: a zone in the list that does not answer is NAMED, not dropped', async (t) => {
  if (!await labUp(5356)) return t.skip('knot not running');
  const p = dns.providerFor('generic');
  const typo = { ...KNOT, dns_zone_list: 'knot.example\nknott.example' };
  // ⛔ Silently omitting it would look identical to the operator never having
  // typed it — and a typo in this very field is the likeliest cause.
  await assert.rejects(
    async () => { await p.listZones(typo); },
    (e) => {
      assert.match(e.message, /knott\.example/, 'the bad name is in the message');
      assert.ok(e.isPartial, 'flagged as partial so the sync keeps the good ones');
      assert.strictEqual(e.partial.length, 1, 'the zone that DID answer is preserved');
      return true;
    });
});

test('generic: no zones configured is a clear refusal, not an empty success', async (t) => {
  const p = dns.providerFor('generic');
  await assert.rejects(async () => { await p.listZones({ ...KNOT, dns_zone_list: '' }); },
    /No zones configured/);
  const t2 = await p.testConnection({ ...KNOT, dns_zone_list: '' });
  assert.strictEqual(t2.ok, false);
  assert.match(t2.detail, /cannot discover them/);
});

test('generic: the zone list is parsed tolerantly', () => {
  const { parseZoneList } = require('../collector/dns/providers/generic');
  // Hand-typed into a textarea: trailing dots, blank lines, comments, commas.
  assert.deepStrictEqual(
    parseZoneList('Example.COM.\n\n10.in-addr.arpa  # reverse\n,foo.test,\n'),
    ['example.com', '10.in-addr.arpa', 'foo.test']);
  assert.deepStrictEqual(parseZoneList(''), []);
  assert.deepStrictEqual(parseZoneList('bad zone name!'), [], 'nonsense is dropped, not passed to the wire');
});

test('generic: query stats throw rather than returning zeroes', async () => {
  // ⛔ A zeroed sample would be written into dns_query_stats and render as
  // "this server served no queries" — a measurement we never made.
  await assert.rejects(async () => { await dns.providerFor('generic').getQueryStats(KNOT); },
    /not available/);
  const c = require('../collector/dns/capabilities');
  assert.strictEqual(c.capabilityFor({ dns_platform: 'generic', dns_zone_list: 'x.test' }, 'query_stats'),
    c.NOT_AVAILABLE);
});

test('generic: with no zone list, zones/records report not_available', () => {
  const c = require('../collector/dns/capabilities');
  for (const cap of ['zones', 'records', 'soa']) {
    assert.strictEqual(c.capabilityFor({ dns_platform: 'generic' }, cap), c.NOT_AVAILABLE, cap);
    assert.strictEqual(c.capabilityFor({ dns_platform: 'generic', dns_zone_list: 'a.test' }, cap),
      c.SUPPORTED, cap + ' with a list');
  }
});

// ── capability honesty ───────────────────────────────────────────────────────

test('a platform that lacks a concept reports not_applicable, not false', () => {
  for (const cap of ['scavenging', 'ad_integration', 'stale_records']) {
    assert.strictEqual(caps.capabilityFor({ dns_platform: 'bind', dns_stats_url: 'x' }, cap),
      caps.NOT_APPLICABLE, `bind ${cap}`);
    assert.strictEqual(caps.capabilityFor({ dns_platform: 'powerdns', dns_api_url: 'x' }, cap),
      caps.NOT_APPLICABLE, `powerdns ${cap}`);
    assert.strictEqual(caps.capabilityFor({ dns_platform: 'windows' }, cap),
      caps.SUPPORTED, `windows ${cap}`);
  }
});

test('BIND forwarders are not_available (they exist; we cannot read them)', () => {
  // ⛔ NOT not_applicable. BIND absolutely has forwarders — they live in
  // named.conf, which this design deliberately never reads. Reporting "none"
  // would be a false statement about the server's configuration.
  assert.strictEqual(caps.capabilityFor({ dns_platform: 'bind', dns_stats_url: 'x' }, 'forwarders'),
    caps.NOT_AVAILABLE);
  // PowerDNS authoritative genuinely has no forwarding — that IS not_applicable.
  assert.strictEqual(caps.capabilityFor({ dns_platform: 'powerdns', dns_api_url: 'x' }, 'forwarders'),
    caps.NOT_APPLICABLE);
});

test('a capability degrades to not_available when the channel is unconfigured', () => {
  assert.strictEqual(caps.capabilityFor({ dns_platform: 'bind' }, 'query_stats'), caps.NOT_AVAILABLE,
    'no statistics URL -> cannot report stats, even though BIND supports them');
  assert.strictEqual(caps.capabilityFor({ dns_platform: 'powerdns' }, 'zones'), caps.NOT_AVAILABLE,
    'no API URL -> cannot list zones');
});

test('an unknown platform is unknown, not silently treated as windows', () => {
  assert.strictEqual(caps.capabilityFor({ dns_platform: 'knot' }, 'zones'), caps.UNKNOWN);
  assert.strictEqual(dns.providerFor('knot'), null);
  assert.strictEqual(dns.providerFor('windows'), null, 'windows stays on the PowerShell path');
});
