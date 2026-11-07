'use strict';

/**
 * Unit tests for the PowerShell escaping layer in collector/powershellRunner.js.
 *
 * Run with:  node --test tests/
 *
 * Uses Node's built-in test runner (node:test / node:assert) — this repo has no test
 * framework installed and this adds no dependency.
 *
 * These tests do NOT touch PowerShell or any remote machine. child_process.execFile is
 * replaced BEFORE powershellRunner is required (it destructures execFile at load time),
 * so every builder runs normally and we capture the exact argv it would have spawned.
 */

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');

// ── capture layer ───────────────────────────────────────────────────────────
// powershellRunner destructures execFile at load time, so the stub has to be installed
// before the require below AND stay the same function object. Tests that need a
// different child outcome swap `impl`, not childProcess.execFile.
const calls = [];
const okImpl = (file, args, opts, cb) => { process.nextTick(() => cb(null, '', '')); };
let impl = okImpl;
childProcess.execFile = function fakeExecFile(file, args, opts, cb) {
  calls.push({ file, args, opts });
  impl(file, args, opts, cb);
  return { pid: -1 };
};

const ps = require('../collector/powershellRunner');
const { psq, psNum } = ps;

const KERB = { auth_mode: 'kerberos' };

/** The -Command string from the most recent capture. */
function lastCmd() {
  assert.ok(calls.length > 0, 'no powershell.exe invocation was captured');
  const { file, args } = calls[calls.length - 1];
  assert.strictEqual(file, 'powershell.exe');
  const i = args.indexOf('-Command');
  assert.ok(i >= 0 && args.length === i + 2, `expected one -Command argument, got ${JSON.stringify(args)}`);
  return args[i + 1];
}

function lastOpts() {
  assert.ok(calls.length > 0, 'no powershell.exe invocation was captured');
  return calls[calls.length - 1].opts;
}

/**
 * Tokenise a PowerShell command the way the parser sees single-quoted literals:
 * inside '...' the ONLY escape is a doubled quote. Returns the decoded literal values
 * and everything that sits OUTSIDE any literal (i.e. what PowerShell executes as code),
 * plus whether every literal was closed.
 *
 * This is the real safety assertion: if an injected payload shows up in `code`, it is
 * being executed; if it only shows up in `literals`, it is inert data.
 */
function psScan(cmd) {
  const literals = [];
  let code = '';
  let cur = null; // null = in code, string = accumulating a literal
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (cur === null) {
      if (ch === "'") { cur = ''; } else { code += ch; }
    } else {
      if (ch === "'") {
        if (cmd[i + 1] === "'") { cur += "'"; i++; }  // doubled quote = one literal '
        else { literals.push(cur); cur = null; }       // literal closed
      } else {
        cur += ch;
      }
    }
  }
  return { literals, code, balanced: cur === null };
}

/**
 * Assert that `payload` reached the script purely as inert data: every literal closed,
 * the payload appears verbatim as one complete literal value, and no fragment of it
 * leaked into the executable part of the command.
 */
function assertInert(cmd, payload, marker) {
  const { literals, code, balanced } = psScan(cmd);
  assert.ok(balanced, `unbalanced single quote in built script:\n${cmd}`);
  assert.ok(
    literals.includes(payload),
    `payload did not survive as a single intact literal.\nwanted: ${JSON.stringify(payload)}\nliterals: ${JSON.stringify(literals)}`
  );
  assert.ok(
    !code.includes(marker),
    `payload marker ${JSON.stringify(marker)} leaked into executable code:\n${code}`
  );
}

// ════════════════════════════════════════════════════════════════════════════
// psq
// ════════════════════════════════════════════════════════════════════════════
test('psq doubles the single quote — the only escape a PS literal has', () => {
  assert.strictEqual(psq("x'; calc; '"), "x''; calc; ''");
  assert.strictEqual(psq("'"), "''");
  assert.strictEqual(psq("''"), "''''");
  assert.strictEqual(psq("o'brien"), "o''brien");
});

test('psq leaves every other metacharacter alone — inert inside a PS literal', () => {
  assert.strictEqual(psq('say "hi"'), 'say "hi"');            // double quote
  assert.strictEqual(psq('C:\\Windows\\System32'), 'C:\\Windows\\System32'); // backslash
  assert.strictEqual(psq('a;b&c|d%PATH%e'), 'a;b&c|d%PATH%e'); // ; & | %
  assert.strictEqual(psq('$(calc)'), '$(calc)');               // subexpression syntax
  assert.strictEqual(psq('a`b'), 'a`b');                       // PS escape char
  assert.strictEqual(psq('line1\nline2'), 'line1\nline2');     // newline
});

test('psq maps null/undefined to the empty string', () => {
  assert.strictEqual(psq(null), '');
  assert.strictEqual(psq(undefined), '');
  assert.strictEqual(psq(''), '');
});

test('psq stringifies non-strings', () => {
  assert.strictEqual(psq(3600), '3600');
  assert.strictEqual(psq(0), '0');
  assert.strictEqual(psq(false), 'false');
});

test('psq output can never close a literal (property check)', () => {
  const nasty = ["'", "''", "x'", "'; calc", "a'b'c", "''';", "\n';calc;'"];
  for (const v of nasty) {
    const built = `-ZoneName '${psq(v)}'`;
    const { literals, balanced } = psScan(built);
    assert.ok(balanced, `unbalanced for ${JSON.stringify(v)}: ${built}`);
    assert.deepStrictEqual(literals, [v], `round-trip failed for ${JSON.stringify(v)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// psNum
// ════════════════════════════════════════════════════════════════════════════
test('psNum returns the fallback for non-numeric strings', () => {
  assert.strictEqual(psNum('abc', 3600, 1, 100000), 3600);
  assert.strictEqual(psNum('3600; calc', 3600, 1, 100000), 3600);
  assert.strictEqual(psNum('10 -or $(calc)', 10, 0, 65535), 10);
  assert.strictEqual(psNum('12abc', 7, 0, 99), 7);
});

test('psNum returns the fallback for null, undefined, empty and blank input', () => {
  assert.strictEqual(psNum(null, 3600, 1, 100), 3600);
  assert.strictEqual(psNum(undefined, 3600, 1, 100), 3600);
  assert.strictEqual(psNum('', 3600, 1, 100), 3600);
  assert.strictEqual(psNum('   ', 3600, 1, 100), 3600);
});

test('psNum returns the fallback for non-number, non-string types', () => {
  assert.strictEqual(psNum(true, 5, 0, 10), 5);
  assert.strictEqual(psNum({}, 5, 0, 10), 5);
  assert.strictEqual(psNum([], 5, 0, 10), 5);
  assert.strictEqual(psNum([7], 5, 0, 10), 5);
  assert.strictEqual(psNum(() => 7, 5, 0, 10), 5);
  assert.strictEqual(psNum(NaN, 5, 0, 10), 5);
  assert.strictEqual(psNum(Infinity, 5, 0, 10), 5);
  assert.strictEqual(psNum(-Infinity, 5, 0, 10), 5);
});

test('psNum floors floats to an integer literal', () => {
  assert.strictEqual(psNum(3.7, 0, 0, 100), '3');
  assert.strictEqual(psNum('3.999', 0, 0, 100), '3');
  assert.strictEqual(psNum(-2.5, 0, -100, 100), '-3');
});

test('psNum clamps to [min,max]', () => {
  assert.strictEqual(psNum(99999, 10, 0, 65535), '65535');
  assert.strictEqual(psNum(-5, 10, 0, 65535), '0');
  assert.strictEqual(psNum(0, 90, 1, 36500), '1');
  assert.strictEqual(psNum('1e30', 90, 1, 36500), '36500');
});

test('psNum keeps a negative only when min allows it', () => {
  assert.strictEqual(psNum(-5, 0, -10, 10), '-5');
  assert.strictEqual(psNum(-5, 0, 0, 10), '0');
});

test('psNum can only ever emit digits (property check)', () => {
  const inputs = [
    "1; calc", "'; calc; '", '$(calc)', '0x10', '1e3', '-0', ' 42 ', '42\n; calc',
    3.99, -7.5, 1e21, Number.MAX_SAFE_INTEGER, '', null, undefined, true, {}, [], NaN,
  ];
  for (const v of inputs) {
    const out = psNum(v, 3600, 0, 2147483647);
    assert.ok(/^\d+$/.test(String(out)), `psNum(${JSON.stringify(v)}) emitted ${JSON.stringify(out)}`);
  }
  // with a negative min the only extra character allowed is a leading '-'
  for (const v of inputs) {
    const out = psNum(v, 0, -100, 100);
    assert.ok(/^-?\d+$/.test(String(out)), `psNum(${JSON.stringify(v)}) emitted ${JSON.stringify(out)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Built-script shapes — one test per shape, with a malicious input
// ════════════════════════════════════════════════════════════════════════════
const ATTACK = "x'; calc; '";   // closes the literal, runs a command, reopens it
const MARKER = 'calc';

test('shape: quoted strings — addDnsARecord zone/host/ip stay inert', async () => {
  await ps.addDnsARecord('10.0.0.1', ATTACK, ATTACK, ATTACK, 3600, KERB);
  const cmd = lastCmd();
  assertInert(cmd, ATTACK, MARKER);
  // sanity: the attack string is present three times as data
  assert.strictEqual(psScan(cmd).literals.filter(l => l === ATTACK).length, 3);
  assert.ok(cmd.includes('-Seconds 3600'));
});

test('shape: unquoted numerics — addDnsSrvRecord priority/weight/port/ttl are digits only', async () => {
  await ps.addDnsSrvRecord('10.0.0.1', ATTACK, ATTACK, '1; calc', '$(calc)', '99999', ATTACK, '3600; calc', KERB);
  const cmd = lastCmd();
  assertInert(cmd, ATTACK, MARKER);
  assert.ok(cmd.includes('-Priority 0'), cmd);
  assert.ok(cmd.includes('-Weight 0'), cmd);
  assert.ok(cmd.includes('-Port 65535'), cmd);     // clamped, not injected
  assert.ok(cmd.includes('-Seconds 3600'), cmd);   // fallback, not injected
});

test('shape: unquoted numeric — addDnsMxRecord preference', async () => {
  await ps.addDnsMxRecord('10.0.0.1', ATTACK, ATTACK, ATTACK, '10; calc', 3600, KERB);
  const cmd = lastCmd();
  assertInert(cmd, ATTACK, MARKER);
  assert.ok(cmd.includes('-Preference 10'), cmd);
});

test('shape: TXT record — zone and hostname are escaped, not just the text', async () => {
  await ps.addDnsTxtRecord('10.0.0.1', ATTACK, ATTACK, ATTACK, 3600, KERB);
  assertInert(lastCmd(), ATTACK, MARKER);
});

test('shape: removeDnsRecord escapes all four arguments (non-A/CNAME branch)', async () => {
  await ps.removeDnsRecord('10.0.0.1', ATTACK, ATTACK, ATTACK, ATTACK, KERB);
  assertInert(lastCmd(), ATTACK, MARKER);
  await ps.removeDnsRecord('10.0.0.1', ATTACK, ATTACK, 'A', ATTACK, KERB);
  assertInert(lastCmd(), ATTACK, MARKER);
});

test('shape: MAC normaliser does not strip quotes — addDhcpReservation still escapes', async () => {
  await ps.addDhcpReservation('10.0.0.1', ATTACK, ATTACK, "aa:bb:cc'; calc; '", ATTACK, KERB);
  const cmd = lastCmd();
  const { literals, code, balanced } = psScan(cmd);
  assert.ok(balanced, cmd);
  // the normaliser upper-cases, so compare case-insensitively
  assert.ok(!code.toLowerCase().includes(MARKER), code);
  // ':' and whitespace both become '-'; the quotes survive the normaliser untouched,
  // which is exactly why psq() is still required on the result.
  assert.ok(literals.includes("AA-BB-CC';-CALC;-'"), JSON.stringify(literals));
});

test('shape: DHCP scope option — unquoted optionId rejected, values escaped', async () => {
  const before = calls.length;
  assert.strictEqual(await ps.setDhcpScopeOption('10.0.0.1', KERB, ATTACK, '6; calc', ['8.8.8.8']), null);
  assert.strictEqual(calls.length, before, 'an invalid optionId must not spawn PowerShell');

  await ps.setDhcpScopeOption('10.0.0.1', KERB, ATTACK, '6', [ATTACK, '8.8.8.8']);
  const cmd = lastCmd();
  assertInert(cmd, ATTACK, MARKER);
  assert.ok(cmd.includes('-OptionId 6'), cmd);
});

test('shape: AddDays numeric — getDnsStaleRecords cutoff cannot be injected', async () => {
  await ps.getDnsStaleRecords('10.0.0.1', KERB, ATTACK, '90); calc; (');
  const cmd = lastCmd();
  assertInert(cmd, ATTACK, MARKER);
  assert.ok(cmd.includes('AddDays(-90)'), cmd);
});

test('shape: secondary zone master list — unquoted position is now a quoted list', async () => {
  await ps.addDnsZone('10.0.0.1', ATTACK, 'Secondary', ATTACK, KERB);
  const cmd = lastCmd();
  const { code, balanced } = psScan(cmd);
  assert.ok(balanced, cmd);
  assert.ok(!code.includes(MARKER), code);
  // a comma list still becomes a PS array of quoted elements
  await ps.addDnsZone('10.0.0.1', 'z.local', 'Secondary', '10.0.0.5, 10.0.0.6', KERB);
  assert.ok(lastCmd().includes("-MasterServers '10.0.0.5','10.0.0.6'"), lastCmd());
});

test('shape: conditional forwarder zone — each forwarder IP is escaped', async () => {
  await ps.addDnsForwarderZone('10.0.0.1', ATTACK, [ATTACK, '8.8.8.8'], KERB);
  assertInert(lastCmd(), ATTACK, MARKER);
});

test('shape: failover relationship name', async () => {
  await ps.getDhcpFailoverScopeState('10.0.0.1', ATTACK, KERB);
  assertInert(lastCmd(), ATTACK, MARKER);
});

test('shape: DHCP audit log — filename allow-list plus a bounded tail', async () => {
  await ps.getDhcpAuditLog('10.0.0.1', KERB, "../../'; calc; '.log", '999999');
  const cmd = lastCmd();
  const { literals, code, balanced } = psScan(cmd);
  assert.ok(balanced, cmd);
  assert.ok(!code.includes(MARKER), code);
  assert.ok(cmd.includes('-Tail 20000'), cmd);   // clamped
  // the path literal keeps the fixed System32\dhcp prefix and a filename reduced to
  // the allow-list: no separators, no quotes, no metacharacters.
  const pathLit = literals.find(l => l.startsWith('System32'));
  assert.ok(pathLit, JSON.stringify(literals));
  const fname = pathLit.split('\\').pop();
  assert.match(fname, /^[A-Za-z0-9._-]+$/);
  assert.strictEqual(pathLit, 'System32\\dhcp\\' + fname);
});

test('shape: the runPS wrapper itself — server IP and WinRM port', async () => {
  await ps.runPS("10.0.0.1'; calc; '", `Write-Output 'x'`, { auth_mode: 'kerberos', winrm_port: '5986; calc' }, true);
  const cmd = lastCmd();
  const { code, balanced } = psScan(cmd);
  assert.ok(balanced, cmd);
  assert.ok(!code.includes(MARKER), code);
  assert.ok(cmd.includes('-Port 5985'), cmd);    // unusable port falls back
});

// ════════════════════════════════════════════════════════════════════════════
// Execution shape — no shell, password off argv
// ════════════════════════════════════════════════════════════════════════════
test('no shell layer: powershell.exe is spawned directly with one -Command argument', async () => {
  await ps.runPS('10.0.0.1', `Write-Output 'x'`, KERB, true);
  const { file, args } = calls[calls.length - 1];
  assert.strictEqual(file, 'powershell.exe');
  assert.deepStrictEqual(args.slice(0, 3), ['-NonInteractive', '-NoProfile', '-Command']);
  assert.strictEqual(args.length, 4);
  assert.ok(!args.join(' ').includes('cmd.exe'));
});

test('credential mode: the password is in the child env only, never in argv or the script', async () => {
  const secret = "P@ss'w0rd; calc";
  await ps.runPS('10.0.0.1', `Write-Output 'x'`, {
    auth_mode: 'credential',
    ps_username: "dom\\adm'; calc; '",
    ps_password: secret,
  }, true);
  const cmd = lastCmd();
  const opts = lastOpts();
  assert.ok(!cmd.includes(secret), 'password must not appear in the command');
  assert.ok(!JSON.stringify(calls[calls.length - 1].args).includes('P@ss'), 'password must not appear in argv');
  assert.strictEqual(opts.env.DDI_PS_PASSWORD, secret);
  assert.ok(cmd.includes('$env:DDI_PS_PASSWORD'), cmd);
  // the username is still interpolated, so it must still be escaped
  const { code, balanced } = psScan(cmd);
  assert.ok(balanced, cmd);
  assert.ok(!code.includes(MARKER), code);
  // and it must not leak onto this process
  assert.strictEqual(process.env.DDI_PS_PASSWORD, undefined);
});

test('non-credential modes do not set a modified environment', async () => {
  await ps.runPS('10.0.0.1', `Write-Output 'x'`, KERB, true);
  assert.strictEqual(lastOpts().env, undefined);
  await ps.runPS('10.0.0.1', `Write-Output 'x'`, { auth_mode: 'local' }, true);
  assert.strictEqual(lastOpts().env, undefined);
});

test('runPS contracts: timeouts, maxBuffer, returnRaw and never throwing', async () => {
  await ps.runPS('10.0.0.1', `Write-Output 'x'`, KERB, true);
  assert.strictEqual(lastOpts().timeout, 30000);                 // PS_TIMEOUT default
  assert.strictEqual(lastOpts().maxBuffer, 32 * 1024 * 1024);
  await ps.runPS('10.0.0.1', `Write-Output 'x'`, KERB, true, 60000);
  assert.strictEqual(lastOpts().timeout, 60000);                 // explicit override

  // empty stdout: '' for returnRaw, null otherwise — and no missing server IP spawns
  assert.strictEqual(await ps.runPS('10.0.0.1', 'x', KERB, true), '');
  assert.strictEqual(await ps.runPS('10.0.0.1', 'x', KERB, false), null);
  const before = calls.length;
  assert.strictEqual(await ps.runPS('', 'x', KERB, true), null);
  assert.strictEqual(calls.length, before);

  // credential mode without credentials: null, no spawn, no throw
  assert.strictEqual(await ps.runPS('10.0.0.1', 'x', { auth_mode: 'credential' }, true), null);
  assert.strictEqual(calls.length, before);
});

test('runPS never throws when the child fails', async () => {
  impl = (file, args, opts, cb) => {
    process.nextTick(() => cb(new Error('spawn failed'), '', 'boom'));
  };
  try {
    assert.strictEqual(await ps.runPS('10.0.0.1', 'x', KERB, false), null);
    assert.strictEqual(await ps.runPS('10.0.0.1', 'x', KERB, true), null);
  } finally {
    impl = okImpl;
  }
});

test('runPS parses JSON stdout, and returns null on unparseable output', async () => {
  impl = (file, args, opts, cb) => { process.nextTick(() => cb(null, '{"a":1}\n', '')); };
  try {
    assert.deepStrictEqual(await ps.runPS('10.0.0.1', 'x', KERB, false), { a: 1 });
    assert.strictEqual(await ps.runPS('10.0.0.1', 'x', KERB, true), '{"a":1}');
  } finally { impl = okImpl; }
  impl = (file, args, opts, cb) => { process.nextTick(() => cb(null, 'not json', '')); };
  try {
    assert.strictEqual(await ps.runPS('10.0.0.1', 'x', KERB, false), null);
    assert.strictEqual(await ps.runPS('10.0.0.1', 'x', KERB, true), 'not json');
  } finally { impl = okImpl; }
});
