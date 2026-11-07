'use strict';

/**
 * siteScoping.test.js — the site-scope predicates and the 404 convention.
 *
 * These exercise api/queryScope.js, which is what api/server.js's lease routes
 * and api/reports.js's drill-down now actually call, so a regression in either
 * shows up here rather than only on a live database.
 *
 * WHAT FAILS PRE-FIX
 *  - `buildLeaseExportQuery`: the route's query was a bare
 *    `SELECT … FROM dhcp_leases ORDER BY ip_address` — no join, no WHERE, no
 *    bind parameters at all. Every assertion below about a site predicate fails
 *    against that.
 *  - `buildLeaseWhere` / `buildLeaseHistoryQuery`: same, the site predicate did
 *    not exist for any role.
 *  - `scopeGate`: api/reports.js returned `403 { error: 'Forbidden' }` on
 *    out-of-scope while returning `404 { error: 'Scope not found' }` on absent.
 *    The "identical to the absent answer" assertions fail against that — which
 *    is the whole point: a caller could tell the two apart and map which ids
 *    exist.
 *
 * NOT COVERED HERE, AND HONESTLY SO: that Postgres actually filters the rows.
 * These assert the generated SQL and its bind parameters. Confirming the result
 * set needs a database with multi-site fixtures, which this repo has no harness
 * for; `= ANY($n::int[])` is the shape used by ~40 already-correct routes in
 * api/server.js, so it is at least the same shape that is known to work there.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  siteAllowed,
  siteScopeSql,
  scopeGate,
  buildLeaseWhere,
  buildLeaseExportQuery,
  buildLeaseHistoryQuery,
} = require('../api/queryScope');

// ── siteAllowed ──────────────────────────────────────────────────────────────

test('siteAllowed: null means unrestricted', () => {
  assert.strictEqual(siteAllowed(null, 3), true);
  assert.strictEqual(siteAllowed(null, null), true);
});

test('siteAllowed: a NULL site is never visible to a restricted caller', () => {
  // A lease or alert with no server_id cannot be attributed to a site. Showing
  // it would be the fail-OPEN answer.
  assert.strictEqual(siteAllowed([3], null), false);
  assert.strictEqual(siteAllowed([3], undefined), false);
  assert.strictEqual(siteAllowed([], null), false);
});

test('siteAllowed: in and out of scope', () => {
  assert.strictEqual(siteAllowed([3, 7], 3), true);
  assert.strictEqual(siteAllowed([3, 7], 9), false);
  assert.strictEqual(siteAllowed([], 3), false);
});

// ── siteScopeSql ─────────────────────────────────────────────────────────────

test('siteScopeSql: unrestricted emits nothing and touches no params', () => {
  const params = ['keep-me'];
  assert.strictEqual(siteScopeSql(null, 's.site_id', params), '');
  assert.deepStrictEqual(params, ['keep-me']);
});

test('siteScopeSql: numbers its own bind parameter from the array it is given', () => {
  const params = ['%search%', 'Active'];
  const clause = siteScopeSql([3, 7], 's.site_id', params);
  assert.strictEqual(clause, 's.site_id = ANY($3::int[])');
  assert.deepStrictEqual(params, ['%search%', 'Active', [3, 7]]);
});

test('siteScopeSql: a caller scoped to NO sites still gets a predicate', () => {
  // `= ANY('{}')` matches nothing. Emitting '' here would have meant
  // "restricted to nothing" rendered as "see everything" — fail open.
  const params = [];
  assert.strictEqual(siteScopeSql([], 's.site_id', params), 's.site_id = ANY($1::int[])');
  assert.deepStrictEqual(params, [[]]);
});

test('siteScopeSql: the column name is used verbatim, so aliases work', () => {
  const p = [];
  assert.strictEqual(siteScopeSql([1], 'srv.site_id', p), 'srv.site_id = ANY($1::int[])');
});

// ── scopeGate: the 404 convention ────────────────────────────────────────────

test('scopeGate: an absent row and an out-of-scope row answer IDENTICALLY', () => {
  const absent = scopeGate(undefined, [3], 'Scope not found');
  const outOfScope = scopeGate({ id: 41, site_id: 9 }, [3], 'Scope not found');

  assert.deepStrictEqual(absent, { status: 404, body: { error: 'Scope not found' } });
  assert.deepStrictEqual(outOfScope, { status: 404, body: { error: 'Scope not found' } });
  // The property that matters: a caller cannot tell these two apart.
  assert.deepStrictEqual(absent, outOfScope);
  assert.strictEqual(outOfScope.status, 404, 'must not be 403 — that confirms the row exists');
  assert.notStrictEqual(outOfScope.body.error, 'Forbidden');
});

test('scopeGate: each entity keeps its own message, both ways', () => {
  for (const message of ['Scope not found', 'Subnet not found', 'Zone not found']) {
    assert.deepStrictEqual(
      scopeGate(null, [3], message),
      scopeGate({ site_id: 9 }, [3], message),
      `${message}: absent and out-of-scope must match`,
    );
  }
});

test('scopeGate: returns null (serve the row) when in scope or unrestricted', () => {
  assert.strictEqual(scopeGate({ site_id: 3 }, [3], 'Scope not found'), null);
  assert.strictEqual(scopeGate({ site_id: 9 }, null, 'Scope not found'), null);
});

test('scopeGate: a row with no site is denied for a restricted caller', () => {
  assert.deepStrictEqual(
    scopeGate({ id: 1, site_id: null }, [3], 'Zone not found'),
    { status: 404, body: { error: 'Zone not found' } },
  );
});

test('scopeGate: honours an alternative site key', () => {
  assert.strictEqual(scopeGate({ owner_site: 3 }, [3], 'x', 'owner_site'), null);
  assert.deepStrictEqual(
    scopeGate({ owner_site: 9 }, [3], 'x', 'owner_site'),
    { status: 404, body: { error: 'x' } },
  );
});

// ── GET /api/leases ──────────────────────────────────────────────────────────

test('buildLeaseWhere: a site_admin always gets a site predicate, filters or not', () => {
  const bare = buildLeaseWhere({}, [3]);
  assert.match(bare.whereClause, /^WHERE s\.site_id = ANY\(\$1::int\[\]\)$/);
  assert.deepStrictEqual(bare.params, [[3]]);
});

test('buildLeaseWhere: an unrestricted caller gets no site predicate', () => {
  const r = buildLeaseWhere({}, null);
  assert.strictEqual(r.whereClause, '');
  assert.deepStrictEqual(r.params, []);
});

test('buildLeaseWhere: the site predicate is ANDed after the user filters', () => {
  const r = buildLeaseWhere(
    { search: 'printer', scope: '10.0.0.0', state: 'Active', device_type: 'Printer' },
    [3, 7],
  );
  assert.ok(r.whereClause.startsWith('WHERE '));
  assert.ok(r.whereClause.includes('s.site_id = ANY($5::int[])'), r.whereClause);
  assert.deepStrictEqual(r.params, ['%printer%', '10.0.0.0', 'Active', 'Printer', [3, 7]]);
  // Everything is a bind parameter; no interpolated user input.
  assert.ok(!r.whereClause.includes('printer'), 'user input must not be interpolated');
});

test('buildLeaseWhere: the device_type=unknown branch adds no param and does not shift numbering', () => {
  const r = buildLeaseWhere({ device_type: 'UnKnOwN', state: 'Active' }, [3]);
  assert.ok(r.whereClause.includes("l.device_type IS NULL"));
  assert.ok(r.whereClause.includes('s.site_id = ANY($2::int[])'), r.whereClause);
  assert.deepStrictEqual(r.params, ['Active', [3]]);
});

test('buildLeaseWhere: a caller scoped to no sites is restricted, not unrestricted', () => {
  const r = buildLeaseWhere({}, []);
  assert.strictEqual(r.whereClause, 'WHERE s.site_id = ANY($1::int[])');
  assert.deepStrictEqual(r.params, [[]]);
});

// ── GET /api/leases/export — the unfiltered CSV ──────────────────────────────

test('buildLeaseExportQuery: joins the owning server and filters on it', () => {
  const { sql, params } = buildLeaseExportQuery([3]);
  assert.ok(/LEFT JOIN ddi_servers s ON s\.id = l\.server_id/.test(sql), sql);
  assert.ok(/WHERE s\.site_id = ANY\(\$1::int\[\]\)/.test(sql), sql);
  assert.deepStrictEqual(params, [[3]]);
});

test('buildLeaseExportQuery: unrestricted still exports everything, with no WHERE', () => {
  const { sql, params } = buildLeaseExportQuery(null);
  assert.ok(!/WHERE/.test(sql), sql);
  assert.deepStrictEqual(params, []);
});

test('buildLeaseExportQuery: still selects exactly the eight CSV columns', () => {
  // The route maps these positionally into the CSV header
  // "IP Address,Hostname,MAC Address,Scope,State,Lease Start,Lease Expiry,Last Seen".
  const { sql } = buildLeaseExportQuery(null);
  for (const col of ['l.ip_address', 'l.hostname', 'l.mac_address', 'l.scope_id',
    'l.address_state', 'l.lease_start', 'l.lease_expiry', 'l.last_seen']) {
    assert.ok(sql.includes(col), `missing ${col}`);
  }
  assert.ok(/ORDER BY l\.ip_address/.test(sql), sql);
});

// ── GET /api/leases/ip/:ip/history ───────────────────────────────────────────

test('buildLeaseHistoryQuery: the ip stays a bind parameter and the site is ANDed', () => {
  const { sql, params } = buildLeaseHistoryQuery('10.20.30.40', [3, 7]);
  assert.ok(/WHERE h\.ip_address = \$1 AND s\.site_id = ANY\(\$2::int\[\]\)/.test(sql), sql);
  assert.deepStrictEqual(params, ['10.20.30.40', [3, 7]]);
  assert.ok(!sql.includes('10.20.30.40'), 'the ip must not be interpolated');
});

test('buildLeaseHistoryQuery: unrestricted keeps the original single-condition query', () => {
  const { sql, params } = buildLeaseHistoryQuery('10.20.30.40', null);
  assert.ok(/WHERE h\.ip_address = \$1\s*$/m.test(sql.split('ORDER BY')[0]), sql);
  assert.deepStrictEqual(params, ['10.20.30.40']);
});

test('buildLeaseHistoryQuery: joins lease_history on its own server_id FK', () => {
  const { sql } = buildLeaseHistoryQuery('1.2.3.4', [1]);
  assert.ok(/FROM lease_history h/.test(sql), sql);
  assert.ok(/LEFT JOIN ddi_servers s ON s\.id = h\.server_id/.test(sql), sql);
  assert.ok(/LIMIT 200/.test(sql), sql);
});
