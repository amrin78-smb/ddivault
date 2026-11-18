'use strict';
/**
 * dnsWire.test.js — TSIG + record normalisation. No network: these are the
 * parts that must be right before any server is contacted, and the parts whose
 * bugs are silent (a mis-signed request is refused with a code that says
 * nothing; a mis-relativised name DOUBLES rows instead of erroring).
 */
const test = require('node:test');
const assert = require('node:assert');
const W = require('../collector/dns/wire');
const R = require('../collector/dns/records');
const dnsPacket = require('dns-packet');

test('nameToWire produces canonical form', () => {
  // ⛔ Canonical form is load-bearing for TSIG: the MAC covers these bytes, so a
  // trailing dot or an uppercase label yields BADSIG with no other diagnostic.
  const a = W.nameToWire('Lab.Example.');
  const b = W.nameToWire('lab.example');
  assert.deepStrictEqual(a, b, 'case and trailing dot must not change the bytes');
  assert.strictEqual(a[0], 3, 'first label length');
  assert.strictEqual(a[a.length - 1], 0, 'root-terminated');
});

test('nameToWire rejects malformed labels', () => {
  assert.throws(() => W.nameToWire('a..b'), /invalid DNS label/);
  assert.throws(() => W.nameToWire('x'.repeat(64) + '.example'), /invalid DNS label/);
});

test('signMessage appends a TSIG RR and increments ARCOUNT', () => {
  const msg = dnsPacket.encode({ id: 1234, type: 'query', flags: 0, questions: [{ type: 'AXFR', name: 'lab.example' }] });
  assert.strictEqual(msg.readUInt16BE(10), 0, 'unsigned message has ARCOUNT 0');
  const { packet, mac } = W.signMessage(msg, { keyName: 'k', algorithm: 'hmac-sha256', secret: Buffer.from('s').toString('base64') });
  assert.strictEqual(packet.readUInt16BE(10), 1, 'ARCOUNT incremented for the TSIG RR');
  assert.strictEqual(mac.length, 32, 'hmac-sha256 MAC is 32 bytes');
  assert.ok(packet.length > msg.length, 'TSIG RR appended');
});

test('splitTsig recovers the TSIG and restores the original header', () => {
  const msg = dnsPacket.encode({ id: 4321, type: 'query', flags: 0, questions: [{ type: 'SOA', name: 'lab.example' }] });
  const { packet } = W.signMessage(msg, { keyName: 'mykey', algorithm: 'hmac-sha256', secret: Buffer.from('s').toString('base64') });
  const { body, tsig } = W.splitTsig(packet);
  assert.ok(tsig, 'TSIG found');
  assert.strictEqual(tsig.keyName, 'mykey');
  assert.strictEqual(tsig.algorithm, 'hmac-sha256');
  assert.strictEqual(body.readUInt16BE(10), 0, 'ARCOUNT restored on the body the MAC was taken over');
  assert.deepStrictEqual(body, msg, 'body is byte-identical to the pre-signing message');
});

test('an unsupported TSIG algorithm is refused, not silently downgraded', () => {
  const msg = dnsPacket.encode({ id: 1, type: 'query', flags: 0, questions: [{ type: 'SOA', name: 'x.test' }] });
  assert.throws(
    () => W.signMessage(msg, { keyName: 'k', algorithm: 'hmac-whirlpool', secret: 'AAAA' }),
    /unsupported TSIG algorithm/);
});

test('an empty secret is refused', () => {
  const msg = dnsPacket.encode({ id: 1, type: 'query', flags: 0, questions: [{ type: 'SOA', name: 'x.test' }] });
  assert.throws(() => W.signMessage(msg, { keyName: 'k', algorithm: 'hmac-sha256', secret: '' }), /secret is empty/);
});

// ── record normalisation ─────────────────────────────────────────────────────

test('names are relativised to match what the Windows collector stores', () => {
  // ⛔ The unique key is (zone_id, hostname, record_type, record_data). An FQDN
  // here would not collide with the Windows row for the same record — it would
  // DOUBLE it.
  assert.strictEqual(R.relativise('web.lab.example', 'lab.example'), 'web');
  assert.strictEqual(R.relativise('web.lab.example.', 'lab.example.'), 'web');
  assert.strictEqual(R.relativise('lab.example', 'lab.example'), '@', 'apex is @');
  assert.strictEqual(R.relativise('_sip._tcp.lab.example', 'lab.example'), '_sip._tcp');
  assert.strictEqual(R.relativise('a.b.lab.example', 'lab.example'), 'a.b', 'multi-label left intact');
  assert.strictEqual(R.relativise('elsewhere.test', 'lab.example'), 'elsewhere.test',
    'out-of-zone glue is kept whole rather than mangled');
});

test('zone-level and DNSSEC types are skipped, not stored as junk', () => {
  for (const t of ['SOA', 'RRSIG', 'NSEC3', 'DNSKEY']) {
    assert.strictEqual(R.normaliseRecord({ name: 'lab.example', type: t, ttl: 1, data: {} }, 'lab.example'), null, t);
  }
});

test('record data is formatted per type', () => {
  const z = 'lab.example';
  const mx = R.normaliseRecord({ name: z, type: 'MX', ttl: 300, data: { preference: 10, exchange: 'mail.lab.example.' } }, z);
  assert.strictEqual(mx.record_data, '10 mail.lab.example');
  const srv = R.normaliseRecord({ name: '_sip._tcp.' + z, type: 'SRV', ttl: 300, data: { priority: 10, weight: 20, port: 5060, target: 'sip.lab.example.' } }, z);
  assert.strictEqual(srv.record_data, '10 20 5060 sip.lab.example');
  const txt = R.normaliseRecord({ name: z, type: 'TXT', ttl: 300, data: [Buffer.from('v=spf1 '), Buffer.from('-all')] }, z);
  assert.strictEqual(txt.record_data, 'v=spf1 -all', 'TXT chunks are joined, not stringified as Buffers');
  const a = R.normaliseRecord({ name: 'web.' + z, type: 'A', ttl: 60, data: '10.0.0.1' }, z);
  assert.deepStrictEqual(a, { hostname: 'web', record_type: 'A', record_data: '10.0.0.1', ttl: 60 });
});

test('an unknown record type is kept legibly, never "[object Object]"', () => {
  const r = R.normaliseRecord({ name: 'x.lab.example', type: 'HTTPS', ttl: 60, data: { priority: 1, target: '.' } }, 'lab.example');
  assert.ok(r, 'kept');
  assert.ok(!/\[object Object\]/.test(r.record_data), 'legible: ' + r.record_data);
});

test('reverse zones are recognised by name', () => {
  assert.ok(R.isReverseZone('10.in-addr.arpa'));
  assert.ok(R.isReverseZone('8.b.d.0.1.0.0.2.ip6.arpa.'));
  assert.ok(!R.isReverseZone('lab.example'));
});
