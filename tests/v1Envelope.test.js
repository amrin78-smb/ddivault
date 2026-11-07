'use strict';

/**
 * v1Envelope.test.js — the public API must not hand its schema to a key holder.
 *
 * WHAT FAILS PRE-FIX: every `catch` in api/v1.js did
 * `fail(res, 500, 'INTERNAL_ERROR', e.message)` at ~20 call sites. A Postgres
 * error message names tables, columns and constraints, so each 500 leaked a
 * piece of the schema. The assertions below that the message is the fixed
 * `GENERIC_500` — and that it contains none of the identifiers from the error —
 * fail against that implementation, which returned the Postgres text verbatim.
 */

const test = require('node:test');
const assert = require('node:assert');

const { ok, fail, pageMeta, internalError, GENERIC_500, reqId } = require('../api/v1-envelope');

function fakeRes(requestId) {
  const r = { statusCode: 200, body: null };
  r.req = { requestId: requestId || 'req_test' };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

/** Swallow the deliberate console.error so the test output stays readable. */
function silenced(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { fn(); } finally { console.error = real; }
  return lines;
}

test('internalError returns the generic message, never the Postgres text', () => {
  const res = fakeRes();
  const err = new Error('relation "dhcp_leases" does not exist');
  err.code = '42P01';
  silenced(() => internalError(res, 'GET /leases', err));

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(res.body.error.message, GENERIC_500);
  assert.ok(!res.body.error.message.includes('dhcp_leases'));
  assert.deepStrictEqual(res.body.error.details, {});
});

test('internalError leaks no identifier from a constraint violation either', () => {
  const res = fakeRes();
  const err = new Error(
    'duplicate key value violates unique constraint "ipam_subnets_network_prefix_length_key"',
  );
  err.table = 'ipam_subnets';
  err.column = 'prefix_length';
  err.constraint = 'ipam_subnets_network_prefix_length_key';
  silenced(() => internalError(res, 'POST /subnets', err));

  const serialized = JSON.stringify(res.body);
  for (const leak of ['ipam_subnets', 'prefix_length', 'unique constraint', 'duplicate key']) {
    assert.ok(!serialized.includes(leak), `response must not contain ${leak}: ${serialized}`);
  }
});

test('internalError still logs the real detail server-side', () => {
  const res = fakeRes();
  const lines = silenced(() =>
    internalError(res, 'GET /audit', new Error('column "entity_nam" does not exist')));
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes('GET /audit'), lines[0]);
  assert.ok(lines[0].includes('entity_nam'), 'the detail must reach the log, just not the client');
});

test('internalError survives a non-Error being thrown', () => {
  const res = fakeRes();
  silenced(() => internalError(res, 'GET /scopes', 'a bare string'));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error.message, GENERIC_500);

  const res2 = fakeRes();
  silenced(() => internalError(res2, 'GET /scopes', null));
  assert.strictEqual(res2.statusCode, 500);
  assert.strictEqual(res2.body.error.message, GENERIC_500);
});

test('the generic message names nothing at all', () => {
  assert.ok(!/[a-z_]+_[a-z_]+/.test(GENERIC_500), `looks like an identifier: ${GENERIC_500}`);
  assert.ok(GENERIC_500.length > 0);
});

// ── The envelope itself still behaves as v1.js's contract documents ──────────

test('fail keeps its explicit message for non-500 errors', () => {
  // Validation and not-found messages are deliberately specific — they describe
  // the CALLER's input, not the server's internals.
  const res = fakeRes();
  fail(res, 404, 'SUBNET_NOT_FOUND', 'Subnet with ID 42 was not found');
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error.message, 'Subnet with ID 42 was not found');
  assert.strictEqual(res.body.request_id, 'req_test');
  assert.ok(typeof res.body.timestamp === 'string');
});

test('ok wraps data and meta in the documented envelope', () => {
  const res = fakeRes('req_abc');
  ok(res, [{ id: 1 }], pageMeta(7, 1, 50));
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.data, [{ id: 1 }]);
  assert.deepStrictEqual(res.body.meta, { total: 7, page: 1, limit: 50, pages: 1 });
  assert.strictEqual(res.body.request_id, 'req_abc');
});

test('pageMeta never reports fewer than one page', () => {
  assert.strictEqual(pageMeta(0, 1, 50).pages, 1);
  assert.strictEqual(pageMeta(51, 1, 50).pages, 2);
  assert.strictEqual(pageMeta(100, 1, 50).pages, 2);
});

test('reqId is prefixed and unique', () => {
  const a = reqId();
  const b = reqId();
  assert.match(a, /^req_[0-9a-f]{16}$/);
  assert.notStrictEqual(a, b);
});
