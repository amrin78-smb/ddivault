'use strict';
/**
 * serverStatus.test.js — the two wrong answers the old single `poll_status`
 * gave, and the not-applicable rule that stops them coming back.
 */
const test = require('node:test');
const assert = require('node:assert');
const st = require('../api/serverStatus');

// ── the original symptom ─────────────────────────────────────────────────────

test('a DNS-only server collecting on schedule is NOT pending', () => {
  // ⛔ THE BUG. poll_status/last_polled are written only by the DHCP scope
  // writer, and collectScopeStats returns early for role='dns' — so these two
  // columns keep their INSERT default forever on a server whose zones are being
  // read every cycle. It read "pending" / "Never polled".
  const s = {
    role: 'dns',
    poll_status: 'pending', last_polled: null, poll_error: null,
    dns_poll_status: 'ok', dns_polled_at: '2026-11-18T13:36:08Z',
  };
  const r = st.collectionStatus(s);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(st.lastCollectedAt(s).toISOString(), '2026-11-18T13:36:08.000Z',
    'the DNS timestamp is the one that applies');
});

test("a DNS-only server's stale DHCP error is not a fault — the poll never runs", () => {
  // Production had a role='dns' server stuck at poll_status='error' since June,
  // with poll_error NULL, which made /api/infrastructure/health report 'warning'
  // indefinitely for a poll that cannot run on this server at all.
  const s = {
    role: 'dns',
    poll_status: 'error', last_polled: '2026-06-05T07:07:24Z', poll_error: null,
    dns_poll_status: 'ok', dns_polled_at: '2026-11-18T13:36:08Z',
  };
  assert.strictEqual(st.collectionStatus(s).status, 'ok');
  assert.strictEqual(st.dhcpPart(s).status, 'not_applicable',
    'DHCP is not applicable here, so its stored value must not be read as a verdict');
});

// ── the dangerous direction ─────────────────────────────────────────────────

test('a both-role server whose DNS collection fails is NOT ok', () => {
  // ⛔ THE FALSE ALL-CLEAR. The old scalar reported the DHCP result, so a total
  // DNS collection failure here read 'ok' and nobody would ever have seen it.
  const s = {
    role: 'both',
    poll_status: 'ok', last_polled: '2026-11-18T14:00:00Z', poll_error: null,
    dns_poll_status: 'error', dns_polled_at: '2026-11-18T13:00:00Z',
    dns_last_error: 'AXFR refused: REFUSED',
  };
  const r = st.collectionStatus(s);
  assert.strictEqual(r.status, 'error', 'any applicable failure wins');
  const dns = r.parts.find((p) => p.capability === 'dns');
  assert.strictEqual(dns.error, 'AXFR refused: REFUSED', 'and it says which half, and why');
});

test('a both-role server failing DHCP is still an error when DNS is fine', () => {
  const s = {
    role: 'both',
    poll_status: 'error', last_polled: '2026-11-18T14:00:00Z',
    poll_error: 'No scope stats returned — check WinRM',
    dns_poll_status: 'ok', dns_polled_at: '2026-11-18T13:00:00Z',
  };
  const r = st.collectionStatus(s);
  assert.strictEqual(r.status, 'error');
  assert.match(r.parts.find((p) => p.capability === 'dhcp').error, /scope stats/);
});

// ── not applicable is not a failure, and not a success ──────────────────────

test('a DHCP-only server is never judged by DNS collection', () => {
  // The recurring mistake in this codebase, in its smallest form: measuring a
  // thing by something that does not apply to it.
  const s = {
    role: 'dhcp',
    poll_status: 'ok', last_polled: '2026-11-18T14:00:00Z',
    dns_poll_status: null, dns_polled_at: null,
  };
  const r = st.collectionStatus(s);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.parts.find((p) => p.capability === 'dns').status, 'not_applicable');
});

test('not_applicable never moves the verdict in either direction', () => {
  const dhcpOnly = { role: 'dhcp', poll_status: 'error', poll_error: 'x' };
  assert.strictEqual(st.collectionStatus(dhcpOnly).status, 'error',
    'a DNS not_applicable must not rescue a real DHCP failure');
  const dnsOnly = { role: 'dns', dns_poll_status: 'ok', dns_polled_at: '2026-11-18T13:00:00Z' };
  assert.strictEqual(st.collectionStatus(dnsOnly).status, 'ok',
    'a DHCP not_applicable must not hold a working server at pending');
});

// ── pending is a neutral "not yet", not an alarm ────────────────────────────

test('a freshly added server is pending, not an error', () => {
  const s = { role: 'both', poll_status: 'pending', last_polled: null, dns_poll_status: null };
  assert.strictEqual(st.collectionStatus(s).status, 'pending');
  assert.strictEqual(st.lastCollectedAt(s), null, 'nothing collected yet is null, not epoch 0');
});

test('half-reported is pending, not ok', () => {
  const s = {
    role: 'both',
    poll_status: 'ok', last_polled: '2026-11-18T14:00:00Z',
    dns_poll_status: null, dns_polled_at: null,
  };
  assert.strictEqual(st.collectionStatus(s).status, 'pending',
    'claiming ok while one applicable half has never reported is the old bug');
});

// ── agent staleness is a real error ─────────────────────────────────────────

test("an agent that stopped reporting is an error, and says so", () => {
  // ws-server.js writes poll_status='stale' and no poll_error.
  const s = { role: 'both', poll_status: 'stale', poll_error: null, dns_poll_status: 'ok',
    dns_polled_at: '2026-11-18T13:00:00Z' };
  const r = st.collectionStatus(s);
  assert.strictEqual(r.status, 'error');
  assert.match(r.parts.find((p) => p.capability === 'dhcp').error, /stopped reporting/,
    'a blank poll_error must not render as an unexplained failure');
});

// ── the API shape ───────────────────────────────────────────────────────────

test('describeCollection is JSON-safe and keeps both halves', () => {
  const d = st.describeCollection({
    role: 'both',
    poll_status: 'ok', last_polled: new Date('2026-11-18T14:00:00Z'),
    dns_poll_status: 'error', dns_polled_at: new Date('2026-11-18T13:00:00Z'),
    dns_last_error: 'statistics channel unreachable',
  });
  assert.strictEqual(d.collection_status, 'error');
  assert.strictEqual(d.last_collected_at, '2026-11-18T14:00:00.000Z');
  assert.strictEqual(d.collection_parts.length, 2);
  for (const p of d.collection_parts) {
    assert.ok(typeof p.at === 'string' || p.at === null, 'Date objects are serialised');
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d)), d, 'survives JSON round-trip');
});

test('an unrecognised role reports unknown rather than guessing', () => {
  const r = st.collectionStatus({ role: 'ipam-only', poll_status: 'ok' });
  assert.strictEqual(r.status, 'unknown');
});

test('a missing role defaults to both, matching the column default', () => {
  assert.strictEqual(st.hasDhcp(undefined), true);
  assert.strictEqual(st.hasDns(undefined), true);
});
