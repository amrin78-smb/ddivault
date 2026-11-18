'use strict';
/**
 * serverFields.test.js — the /api/servers write decisions that fail silently
 * and destructively.
 */
const test = require('node:test');
const assert = require('node:assert');
const { normaliseDnsPlatform, shouldReplaceSecret, SECRET_MASK, planAgentAssignment } = require('../api/serverFields');
const { isProtocolPlatform } = require('../collector/dns');

test('a blank platform defaults to windows, preserving every existing row', () => {
  // Every server that existed before this feature has no dns_platform in the
  // submitted form; it must stay on the PowerShell path.
  for (const v of [undefined, null, '']) {
    assert.strictEqual(normaliseDnsPlatform(v), 'windows', String(v));
  }
});

test('supported platforms are accepted case- and space-insensitively', () => {
  assert.strictEqual(normaliseDnsPlatform('bind'), 'bind');
  assert.strictEqual(normaliseDnsPlatform(' BIND '), 'bind');
  assert.strictEqual(normaliseDnsPlatform('PowerDNS'), 'powerdns');
  assert.strictEqual(normaliseDnsPlatform('windows'), 'windows');
});

test('an unsupported platform is REJECTED, never defaulted to windows', () => {
  // ⛔ Falling back to 'windows' here would poll a Linux host over WinRM
  // forever and report the resulting auth errors as a network problem.
  for (const v of ['bind9', 'knot', 'nsd', 'unbound', 'dnsmasq', 'route53', 'nonsense']) {
    assert.strictEqual(normaliseDnsPlatform(v), null, v);
  }
});

test('an empty secret means UNCHANGED — the credential-wiping case', () => {
  // ⛔ ServersTab initialises every secret field to '' and PUTs the whole form,
  // so editing a description submits ps_password: ''. If that replaced the
  // stored value, tidying a description would destroy the server's credential
  // with no error, discovered only at the next poll.
  assert.strictEqual(shouldReplaceSecret(''), false);
  assert.strictEqual(shouldReplaceSecret(undefined), false);
  assert.strictEqual(shouldReplaceSecret(null), false);
});

test('the displayed mask is never stored as if it were the secret', () => {
  assert.strictEqual(shouldReplaceSecret(SECRET_MASK), false);
  assert.strictEqual(SECRET_MASK, '••••••••', 'must match the placeholder ServersTab renders');
});

test('a real new secret does replace the stored one', () => {
  assert.strictEqual(shouldReplaceSecret('hunter2'), true);
  assert.strictEqual(shouldReplaceSecret('c3BhbnZhdWx0'), true);
  assert.strictEqual(shouldReplaceSecret('   '), true, 'whitespace is a value the caller chose');
});

// ── agent assignment vs a protocol-collected server ─────────────────────────
// ⛔ The failure being guarded is a server collected by NOBODY: getActiveServers()
// skips anything an agent owns, and the agent's config carries no DNS-platform
// fields. It produces no error on either side, so only a test can hold it.

const ROWS = [
  { id: 1, hostname: 'dc01', dns_platform: 'windows' },
  { id: 2, hostname: 'ns1.branch', dns_platform: 'bind' },
  { id: 3, hostname: 'dhcp02', dns_platform: 'windows' },
  { id: 4, hostname: 'ns2.branch', dns_platform: 'powerdns' },
];

test('a Windows-only assignment is untouched', () => {
  const p = planAgentAssignment(ROWS, [1, 3], [1, 3], isProtocolPlatform);
  assert.strictEqual(p.refuse, null);
  assert.deepStrictEqual(p.skipped, []);
  assert.deepStrictEqual(p.assignIds, [1, 3], 'the normal case must not be disturbed');
});

test('an id the operator TYPED is refused, and the refusal names the server', () => {
  const p = planAgentAssignment(ROWS, [1, 2], [1, 2], isProtocolPlatform);
  assert.ok(p.refuse, 'must refuse');
  assert.match(p.refuse, /ns1\.branch/, 'names the server, not just a count');
  assert.match(p.refuse, /bind/, 'says which platform, so the cause is obvious');
  assert.deepStrictEqual(p.assignIds, [1, 2], 'refusing changes nothing — all or none');
});

test('a SITE SWEEP skips them and names every one it skipped', () => {
  // explicitAssign is empty: the operator named a site, not these servers.
  const p = planAgentAssignment(ROWS, [1, 2, 3, 4], [], isProtocolPlatform);
  assert.strictEqual(p.refuse, null, 'one Linux resolver must not fail the whole site');
  assert.deepStrictEqual(p.assignIds, [1, 3], 'the Windows servers are still assigned');
  assert.deepStrictEqual(p.skipped.map((r) => r.hostname).sort(), ['ns1.branch', 'ns2.branch']);
  for (const r of p.skipped) {
    assert.ok(r.dns_platform, 'each skipped row says WHY it was skipped');
  }
});

test('a typed id still refuses even when a site sweep widened the list', () => {
  // The operator typed 2 AND asked for the site. The typed id wins: they said
  // that server out loud, so answering "skipped, quietly" would ignore them.
  const p = planAgentAssignment(ROWS, [1, 2, 3, 4], [2], isProtocolPlatform);
  assert.ok(p.refuse, 'the typed id is refused, not silently skipped');
  assert.match(p.refuse, /ns1\.branch/);
});

test('a server NOT being assigned is never judged', () => {
  // ns1.branch is in rows because it is being UNassigned. Unassigning a
  // protocol server is how you fix a bad state, so it must stay possible.
  const p = planAgentAssignment(ROWS, [1], [1], isProtocolPlatform);
  assert.strictEqual(p.refuse, null);
  assert.deepStrictEqual(p.skipped, []);
  assert.deepStrictEqual(p.assignIds, [1]);
});

test('the guard uses the real isProtocolPlatform, not a local list', () => {
  // ⛔ A second copy of "which platforms are protocol-collected" would drift the
  // moment a platform is added — exactly how `generic` would have been missed.
  assert.strictEqual(isProtocolPlatform('generic'), true);
  const rows = [{ id: 9, hostname: 'knot01', dns_platform: 'generic' }];
  const p = planAgentAssignment(rows, [9], [9], isProtocolPlatform);
  assert.ok(p.refuse, 'generic is caught by the same guard as bind and powerdns');
  assert.match(p.refuse, /knot01/);
});
