'use strict';
/**
 * serverFields.test.js — the two /api/servers write decisions that fail
 * silently and destructively.
 */
const test = require('node:test');
const assert = require('node:assert');
const { normaliseDnsPlatform, shouldReplaceSecret, SECRET_MASK } = require('../api/serverFields');

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
