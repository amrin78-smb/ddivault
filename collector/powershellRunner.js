'use strict';

/**
 * powershellRunner.js
 * Executes PowerShell commands locally or remotely via WinRM.
 *
 * Per-server auth — each server object has:
 *   auth_mode:   'kerberos' | 'credential' | 'local'
 *   ps_username: domain\user or user@domain
 *   ps_password: plaintext (decrypted by caller before passing here)
 *   winrm_port:  5985 (HTTP) or 5986 (HTTPS)
 *   winrm_https: boolean
 *
 * Global fallback (from .env.local) used if server has no auth config.
 */

const { execFile } = require('child_process');

// ════════════════════════════════════════════════════════════════════════════
// PowerShell argument escaping — SECURITY CRITICAL, do not bypass
// ════════════════════════════════════════════════════════════════════════════
// Every script in this file is built by string interpolation and then executed ON A
// CUSTOMER'S Windows DNS/DHCP server, over WinRM, as the configured WinRM identity
// (frequently a domain account with DNS/DHCP admin rights). A caller-supplied value
// that can close its own quoting context is therefore remote code execution on a
// domain controller, not a cosmetic bug.
//
// There are exactly two kinds of interpolation site below, and each has its own helper:
//
//   psq(v)    — the value sits INSIDE a '...' PowerShell string literal
//               (`-ZoneName '${psq(zoneName)}'`). A single-quoted PowerShell literal
//               has precisely one escape — a doubled quote ('') — so doubling every
//               ' makes it impossible to leave the literal. Nothing else needs
//               escaping in that context: ; & | % $ " \ and newlines are all inert
//               inside '...'.
//
//   psNum(v, fallback, min, max)
//             — the value sits in an UNQUOTED numeric position
//               (`-Port ${...}`, `-Priority ${...}`, `AddDays(-${...})`). There is no
//               quoting to escape out of here, so ANY non-digit text is parsed as
//               PowerShell code. psNum can only ever emit digits (with a leading '-'
//               only when `min` permits a negative), whatever it is handed.
//
// The credential path has always escaped its username/password this way; the rest of
// the file did not, and a handful of builders did it inconsistently — that gap was the
// vulnerability. RULE for anything added below: if you write ${...} inside a PS script
// string, it goes through psq() when it sits inside '...', and through psNum() when it
// does not. There is no third option.
//
// Both are exported, mainly so they can be unit-tested directly.

/** Escape a value for embedding inside a single-quoted PowerShell string literal. */
const psq = (v) => String(v == null ? '' : v).replace(/'/g, "''");

/**
 * Coerce a value for an UNQUOTED numeric position in a PowerShell script.
 *
 * Returns a string of digits (optionally sign-prefixed when `min` allows negatives),
 * or `fallback` when the input cannot be used as a number. `fallback` must be a
 * literal number written in this file — never a caller-supplied value.
 */
function psNum(v, fallback, min, max) {
  // Only a number or a string can be a number. Anything else (null, undefined,
  // boolean, object, array, function) is unusable — including '' and '   ', which
  // Number() would silently turn into 0.
  if (typeof v !== 'number' && typeof v !== 'string') return fallback;
  if (typeof v === 'string' && v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;           // NaN, Infinity, '12abc', '0x'…
  let i = Math.floor(n);
  if (Number.isFinite(min) && i < min) i = Math.floor(min);
  if (Number.isFinite(max) && i > max) i = Math.floor(max);
  const s = String(i);
  // Belt and braces: never emit anything that is not a plain integer literal
  // (guards exponential notation such as "1e+21" from an unclamped huge input).
  return /^-?\d+$/.test(s) ? s : fallback;
}

// Every PowerShell/WinRM call used to run through execSync, which BLOCKS the Node
// event loop for the whole duration (up to PS_DNS_TIMEOUT = 60s). While blocked,
// nothing else in the process runs — including pg's connection callbacks and its
// connectionTimeoutMillis timer, so a perfectly healthy database reported
// "Connection terminated due to connection timeout" purely because the loop was
// frozen. Same freeze hit the API server, where a single DNS write stalled every
// other HTTP request. execFile() keeps the loop free; callers await instead.
//
// execFile, NOT exec: exec() spawns cmd.exe, so the script crossed TWO quoting layers
// (cmd.exe's and PowerShell's). That required escaping the command for cmd — which the
// old code did with `"` -> `\"`, a form cmd.exe does not even honour (it toggles on the
// bare quote and has no backslash escape), while cmd.exe additionally expanded %VAR%
// inside the string and mangled backslashes. execFile hands powershell.exe its argv
// directly: no shell, no second quoting layer, no %VAR% expansion, and the whole PS
// command travels as ONE -Command argument.
//
// Resolves to stdout (not {stdout,stderr}) so call sites keep their .trim() shape,
// and re-attaches stdout/stderr to the error so the existing catch blocks — which
// read err.stderr/err.stdout — behave exactly as they did under execSync.
const PS_MAX_BUFFER = 32 * 1024 * 1024; // was exec/execSync's 1MB default; big DNS zones and DHCP log tails overflowed it

// Env var the credential path uses to hand the decrypted password to the child
// PowerShell. It is set ONLY on that child's environment (never on this process),
// never written to argv — a command line is world-readable via
// Win32_Process.CommandLine — and never logged.
const PS_PASS_ENV = 'DDI_PS_PASSWORD';

function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      // execSync forwarded the child's stderr to our own stderr by default; execFile
      // captures it instead. Surface it (bounded) so a command that SUCCEEDS while
      // emitting a PowerShell warning stays as visible in the logs as it was before.
      if (stderr && String(stderr).trim()) {
        console.warn('[PS] stderr (command succeeded):', String(stderr).trim().slice(0, 300));
      }
      resolve(stdout);
    });
  });
}

const PS_TIMEOUT = parseInt(process.env.PS_TIMEOUT_MS || '30000');
// DNS zone collection on servers with many zones (100+) takes far longer than a
// standard DHCP query, so DNS reads use a dedicated, larger timeout (60s default).
const DNS_PS_TIMEOUT = parseInt(process.env.PS_DNS_TIMEOUT_MS || '60000');
// The DHCP audit-log tail (getDhcpAuditLog) is the single largest DHCP read — up to
// DHCP_LOG_TAIL_LINES (2000) lines of CSV pulled over WinRM — and it was left on the
// 30s PS_TIMEOUT while the comparably-sized DNS reads already had their own 60s.
// Measured on the live server it takes 28-30s per cycle, i.e. sitting exactly ON the
// 30s limit, so it tipped over intermittently: 25 killed-mid-output failures in one
// day, each losing that cycle's events. 120s is deliberate headroom, not a fine-tuned
// value — this read is bounded by -Tail, so a slow one should be waited out, not
// abandoned. If this ever times out for real, the log is far bigger than expected or
// WinRM is genuinely broken; lower DHCP_LOG_TAIL_LINES rather than trimming this.
const DHCP_LOG_PS_TIMEOUT = parseInt(process.env.PS_DHCP_LOG_TIMEOUT_MS || '120000');

// PostgreSQL inet values include CIDR (e.g. 172.24.0.10/32) which the
// PowerShell remoting functions reject — strip it before any PS use.
const cleanIp = ip => (ip || '').replace(/\/\d+$/, '').trim();

// Upper bound used for every DNS TTL / New-TimeSpan -Seconds position. Max int32
// seconds (~68 years) is far beyond any real TTL and keeps the emitted literal short.
const TTL_MAX = 2147483647;

// Global fallback auth (from .env.local)
const DEFAULT_AUTH_MODE = process.env.PS_AUTH_MODE || 'kerberos';
const DEFAULT_USERNAME  = process.env.PS_USERNAME  || '';
const DEFAULT_PASSWORD  = process.env.PS_PASSWORD  || '';

/**
 * Build and run a PowerShell command for a given server config.
 *
 * @param {string} serverIp
 * @param {string} script      - PS script to execute
 * @param {object} auth        - { auth_mode, ps_username, ps_password, winrm_port, winrm_https }
 * @param {boolean} returnRaw  - if true, return stdout as-is; if false, parse JSON
 * @returns {Promise<string|object|null>}
 */
async function runPS(serverIp, script, auth, returnRaw, timeoutMs) {
  // PostgreSQL inet values include CIDR (e.g. 172.24.0.10/32) which
  // Invoke-Command -ComputerName rejects. Strip it before any remote use.
  const cleanIp = (serverIp || '').replace(/\/\d+$/, '').trim();
  if (!cleanIp) {
    console.warn('[PS] No server IP provided');
    return null;
  }

  const mode     = auth?.auth_mode  || DEFAULT_AUTH_MODE;
  const user     = auth?.ps_username || DEFAULT_USERNAME;
  const pass     = auth?.ps_password || DEFAULT_PASSWORD;
  const port     = auth?.winrm_port  || 5985;
  const useHttps = auth?.winrm_https || false;

  // The IP is interpolated into a '...' literal, and the port into an unquoted
  // numeric position — both are DB-sourced, so both go through the helpers.
  const safeIp   = psq(cleanIp);
  const portOpt  = port !== 5985 ? ` -Port ${psNum(port, 5985, 1, 65535)}` : '';
  const httpsOpt = useHttps ? ' -UseSSL' : '';

  let psCmd;
  let childEnv = null; // only the credential path needs a modified environment

  if (mode === 'local') {
    // Run directly on this machine — only works if NocVault IS the target server
    psCmd = `try { ${script} } catch { Write-Error $_.Exception.Message; exit 1 }`;

  } else if (mode === 'credential') {
    if (!user || !pass) {
      console.error(`[PS] credential mode requires ps_username and ps_password for ${cleanIp}`);
      return null;
    }
    // The decrypted password reaches PowerShell through the child's environment and is
    // read inside the script as $env:DDI_PS_PASSWORD — it never appears in the command
    // line (world-readable via Win32_Process.CommandLine) nor in the script text.
    // NOTE: the inner script already pipes to ConvertTo-Json — do NOT add a second
    // ConvertTo-Json here or the output gets double-encoded (a JSON string of a JSON
    // string), which JSON.parse turns back into a string, not an array/object.
    psCmd =
      `$secPass = ConvertTo-SecureString $env:${PS_PASS_ENV} -AsPlainText -Force; ` +
      `$cred = New-Object System.Management.Automation.PSCredential('${psq(user)}', $secPass); ` +
      `try { ` +
        `Invoke-Command -ComputerName '${safeIp}'${portOpt}${httpsOpt} -Credential $cred -ScriptBlock { ${script} } ` +
      `} catch { Write-Error $_.Exception.Message; exit 1 }`;
    childEnv = { ...process.env, [PS_PASS_ENV]: pass };

  } else {
    // kerberos — use current Windows identity (NocVault service account)
    // NOTE: inner script already emits JSON — no second ConvertTo-Json (see above).
    psCmd =
      `try { ` +
        `Invoke-Command -ComputerName '${safeIp}'${portOpt}${httpsOpt} -ScriptBlock { ${script} } ` +
      `} catch { Write-Error $_.Exception.Message; exit 1 }`;
  }

  const opts = {
    encoding: 'utf8',
    timeout: timeoutMs || PS_TIMEOUT,
    maxBuffer: PS_MAX_BUFFER,
    windowsHide: true,
  };
  if (childEnv) opts.env = childEnv;

  try {
    const raw = (await execFileAsync(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-Command', psCmd],
      opts
    )).trim();
    if (!raw) return returnRaw ? '' : null;
    if (returnRaw) return raw;
    return JSON.parse(raw);
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').trim().slice(0, 400);
    console.error(`[PS] Command failed on ${cleanIp} (mode=${mode}):`, msg);
    return null;
  }
}

/**
 * Run a simple local PowerShell command — no remote, no auth.
 * execFile (no shell) for the same reason as runPS — the script is one argv entry.
 */
async function runLocalPS(script) {
  try {
    return (await execFileAsync(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-Command', script],
      { encoding: 'utf8', timeout: PS_TIMEOUT, maxBuffer: PS_MAX_BUFFER, windowsHide: true }
    )).trim();
  } catch (err) {
    console.error('[PS] Local command failed:', (err.stderr || err.message || '').slice(0, 200));
    return null;
  }
}

/**
 * Add an IP to WinRM TrustedHosts if not already present.
 * Runs locally — never remote. Safe to call multiple times.
 */
async function addToTrustedHosts(ip) {
  const cleanIp = (ip || '').replace(/\/\d+$/, '').trim();
  if (!cleanIp) return;
  const safeIp = psq(cleanIp);
  // Single line — kept as a deliberate convention across this file (see getDhcpLeases).
  const script = `$current = (Get-Item WSMan:\\localhost\\Client\\TrustedHosts -ErrorAction SilentlyContinue).Value; $ips = if ($current) { $current -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' } } else { @() }; if ($ips -notcontains '${safeIp}') { $newList = ($ips + '${safeIp}') -join ','; Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value $newList -Force; Write-Output 'added' } else { Write-Output 'exists' }`;
  try {
    const result = await runLocalPS(script);
    console.log(`[TrustedHosts] ${cleanIp}: ${result || 'failed'}`);
    return result;
  } catch (err) {
    console.error(`[TrustedHosts] Failed to add ${cleanIp}:`, err.message);
  }
}

/**
 * Test WinRM connectivity to a server.
 * @param {string} serverIp
 * @param {object} auth
 * @returns {{ ok: boolean, error: string|null, latencyMs: number|null }}
 */
async function testWinRM(serverIp, auth) {
  const cleanIp = (serverIp || '').replace(/\/\d+$/, '').trim();
  if (!cleanIp) return { ok: false, error: 'No server IP', latencyMs: null };
  const start = Date.now();
  try {
    const result = await runPS(cleanIp, `Write-Output 'winrm-ok'`, auth, true);
    const latencyMs = Date.now() - start;
    if (result && result.includes('winrm-ok')) {
      return { ok: true, error: null, latencyMs };
    }
    return { ok: false, error: 'Unexpected response', latencyMs };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: null };
  }
}

// ════════════════════════════════════════════════════════════
// DHCP — READ
// ════════════════════════════════════════════════════════════

async function getDhcpScopeStats(serverIp, auth) {
  const r = await runPS(serverIp, `Get-DhcpServerv4ScopeStatistics | Select-Object ScopeId,PercentageInUse,InUse,Free,Reserved,Pending | ConvertTo-Json -Depth 5 -Compress`, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

async function getDhcpScopes(serverIp, auth) {
  const r = await runPS(serverIp, `Get-DhcpServerv4Scope | Select-Object ScopeId,Name,StartRange,EndRange,SubnetMask,State,LeaseDuration,Description | ConvertTo-Json -Depth 5 -Compress`, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

async function getDhcpLeases(serverIp, auth) {
  // -AllScope is not supported on PS5, so loop over each scope. Keep this on a
  // SINGLE line — a long-standing convention in this file (it predates the shell
  // removal, which relaxed the hard newline constraint; don't reformat).
  const script = `$all = foreach ($s in (Get-DhcpServerv4Scope | Select-Object -ExpandProperty ScopeId)) { Get-DhcpServerv4Lease -ScopeId $s -ErrorAction SilentlyContinue | Select-Object ScopeId,IPAddress,HostName,ClientId,AddressState,LeaseExpiryTime }; $all | ConvertTo-Json -Depth 5 -Compress`;
  const r = await runPS(serverIp, script, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

// scopeId optional — when null/omitted, returns reservations across ALL scopes.
async function getDhcpReservations(serverIp, scopeId, auth) {
  const script = scopeId
    ? `Get-DhcpServerv4Reservation -ScopeId '${psq(scopeId)}' | Select-Object ScopeId,IPAddress,ClientId,Name,Description,Type | ConvertTo-Json -Depth 5 -Compress`
    : `$scopes = Get-DhcpServerv4Scope | Select-Object -ExpandProperty ScopeId; $all = foreach ($s in $scopes) { Get-DhcpServerv4Reservation -ScopeId $s -ErrorAction SilentlyContinue | Select-Object ScopeId,IPAddress,ClientId,Name,Description,Type }; $all | ConvertTo-Json -Depth 5 -Compress`;
  const r = await runPS(serverIp, script, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

// ════════════════════════════════════════════════════════════
// DHCP — WRITE
// ════════════════════════════════════════════════════════════

async function addDhcpReservation(serverIp, scopeId, ipAddress, macAddress, name, auth) {
  // The MAC normaliser strips ':' and whitespace but NOT quotes — psq still required.
  const mac    = String(macAddress == null ? '' : macAddress).replace(/[:\s]/g, '-').toUpperCase();
  const script = `Add-DhcpServerv4Reservation -ScopeId '${psq(scopeId)}' -IPAddress '${psq(ipAddress)}' -ClientId '${psq(mac)}' -Name '${psq(name || ipAddress)}' -ErrorAction Stop; Write-Output 'ok'`;
  const r = await runPS(serverIp, script, auth, true);
  return !!(r && r.includes('ok'));
}

async function removeDhcpReservation(serverIp, scopeId, ipAddress, auth) {
  const script = `Remove-DhcpServerv4Reservation -ScopeId '${psq(scopeId)}' -IPAddress '${psq(ipAddress)}' -ErrorAction Stop; Write-Output 'ok'`;
  const r = await runPS(serverIp, script, auth, true);
  return !!(r && r.includes('ok'));
}

async function createDhcpScope(serverIp, auth, scope) {
  // scope = { name, startRange, endRange, subnetMask, description, leaseDuration, state }
  const ip = cleanIp(serverIp);
  const state = scope.state || 'Active';
  const duration = scope.leaseDuration || '8.00:00:00'; // 8 days default
  const script = `Add-DhcpServerv4Scope -Name '${psq(scope.name || '')}' -StartRange '${psq(scope.startRange)}' -EndRange '${psq(scope.endRange)}' -SubnetMask '${psq(scope.subnetMask)}' -Description '${psq(scope.description || '')}' -LeaseDuration '${psq(duration)}' -State '${psq(state)}' -PassThru | Select-Object ScopeId,Name,StartRange,EndRange,SubnetMask,State | ConvertTo-Json -Compress`;
  return await runPS(ip, script, auth);
}

async function editDhcpScope(serverIp, auth, scopeId, changes) {
  // changes = { name, description, leaseDuration, state }
  const ip = cleanIp(serverIp);
  const parts = [];
  if (changes.name) parts.push(`-Name '${psq(changes.name)}'`);
  if (changes.description !== undefined) parts.push(`-Description '${psq(changes.description || '')}'`);
  if (changes.leaseDuration) parts.push(`-LeaseDuration '${psq(changes.leaseDuration)}'`);
  if (changes.state) parts.push(`-State '${psq(changes.state)}'`);
  const script = `Set-DhcpServerv4Scope -ScopeId '${psq(scopeId)}' ${parts.join(' ')}; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

async function setScopeState(serverIp, auth, scopeId, state) {
  const ip = cleanIp(serverIp);
  const script = `Set-DhcpServerv4Scope -ScopeId '${psq(scopeId)}' -State '${psq(state)}'; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

async function deleteDhcpScope(serverIp, auth, scopeId) {
  const ip = cleanIp(serverIp);
  const script = `Remove-DhcpServerv4Scope -ScopeId '${psq(scopeId)}' -Force; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

async function getDhcpScopeOptions(serverIp, auth, scopeId) {
  const ip = cleanIp(serverIp);
  const script = `Get-DhcpServerv4OptionValue -ScopeId '${psq(scopeId)}' -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ OptionId = $_.OptionId; Name = $_.Name; Value = ($_.Value -join ', ') } } | ConvertTo-Json -Compress`;
  return await runPS(ip, script, auth);
}

async function setDhcpScopeOption(serverIp, auth, scopeId, optionId, values) {
  const ip = cleanIp(serverIp);
  // -OptionId is an UNQUOTED numeric position. There is no sane default for an option
  // id, so an unusable one is rejected here rather than silently coerced; null is what
  // runPS itself returns on failure, so callers already treat it as "did not apply".
  const oid = psNum(optionId, null, 0, 255);
  if (oid === null) {
    console.error(`[PS] setDhcpScopeOption: invalid optionId ${JSON.stringify(optionId)}`);
    return null;
  }
  const vals = (Array.isArray(values) ? values : [values]).map(v => `'${psq(v)}'`).join(',');
  const script = `Set-DhcpServerv4OptionValue -ScopeId '${psq(scopeId)}' -OptionId ${oid} -Value ${vals}; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

async function getDhcpExclusions(serverIp, auth, scopeId) {
  const ip = cleanIp(serverIp);
  const script = `Get-DhcpServerv4ExclusionRange -ScopeId '${psq(scopeId)}' -ErrorAction SilentlyContinue | Select-Object StartRange,EndRange | ConvertTo-Json -Compress`;
  return await runPS(ip, script, auth);
}

async function addDhcpExclusion(serverIp, auth, scopeId, startRange, endRange) {
  const ip = cleanIp(serverIp);
  const script = `Add-DhcpServerv4ExclusionRange -ScopeId '${psq(scopeId)}' -StartRange '${psq(startRange)}' -EndRange '${psq(endRange)}'; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

// ════════════════════════════════════════════════════════════
// DNS — READ
// ════════════════════════════════════════════════════════════

async function getDnsZones(serverIp, auth) {
  const r = await runPS(serverIp, `Get-DnsServerZone | Select-Object ZoneName,ZoneType,IsAutoCreated,IsDsIntegrated,IsReverseLookupZone,IsReadOnly | ConvertTo-Json -Depth 5 -Compress`, auth, false, DNS_PS_TIMEOUT);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

async function getDnsRecords(serverIp, zoneName, auth) {
  // Single line — file convention, kept deliberately.
  const script = `Get-DnsServerResourceRecord -ZoneName '${psq(zoneName)}' | ForEach-Object { $r = $_; $data = ''; try { if ($r.RecordData.IPv4Address) { $data = $r.RecordData.IPv4Address.IPAddressToString } elseif ($r.RecordData.IPv6Address) { $data = $r.RecordData.IPv6Address.IPAddressToString } elseif ($r.RecordData.HostNameAlias) { $data = $r.RecordData.HostNameAlias } elseif ($r.RecordData.MailExchange) { $data = $r.RecordData.MailExchange + ' ' + $r.RecordData.Preference } elseif ($r.RecordData.NameServer) { $data = $r.RecordData.NameServer } elseif ($r.RecordData.DescriptiveText) { $data = $r.RecordData.DescriptiveText } else { $data = '' } } catch {}; [PSCustomObject]@{ HostName=$r.HostName; RecordType=$r.RecordType; TTL=[int]$r.TimeToLive.TotalSeconds; RecordData=$data } } | ConvertTo-Json -Depth 5 -Compress`;
  const r = await runPS(serverIp, script, auth, false, DNS_PS_TIMEOUT);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

async function getDnsServerStats(serverIp, auth) {
  // Single line — file convention, kept deliberately.
  const script = `$s = Get-DnsServerStatistics -ErrorAction SilentlyContinue; if ($s) { [PSCustomObject]@{ TotalQueries=$s.Query2Statistics.TotalReceived; TotalResponses=$s.Query2Statistics.TotalResponseSent; TotalFailures=$s.Query2Statistics.TotalFailure } | ConvertTo-Json -Compress }`;
  return await runPS(serverIp, script, auth, false, DNS_PS_TIMEOUT);
}

// Get DNS server role and AD info
async function getDnsServerRole(serverIp, auth) {
  const script = `$d=(Get-WmiObject Win32_ComputerSystem).Domain;$pdc=(Get-ADDomain -ErrorAction SilentlyContinue).PDCEmulator;$isPdc=$pdc -eq "$env:COMPUTERNAME.$d";$fwd=(Get-DnsServerForwarder -ErrorAction SilentlyContinue).IPAddress.IPAddressToString -join ',';[PSCustomObject]@{isPDC=[bool]$isPdc;forwarders="$fwd";domain="$d"}|ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Get SOA record detail for a zone
async function getDnsZoneSoaDetail(serverIp, auth, zoneName) {
  const z = psq(zoneName);
  const script = `Get-DnsServerResourceRecord -ZoneName '${z}' -RRType Soa -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $soa = $_.RecordData; [PSCustomObject]@{ Serial=$soa.SerialNumber; PrimaryServer=$soa.PrimaryServer; AdminEmail=$soa.ResponsiblePerson; Refresh=$soa.RefreshInterval.TotalSeconds; Retry=$soa.RetryDelay.TotalSeconds; Expire=$soa.ExpireLimit.TotalSeconds; MinTTL=$soa.TimeToLive.TotalSeconds } } | ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Get record counts by type per zone
async function getDnsZoneRecordCounts(serverIp, auth, zoneName) {
  const z = psq(zoneName);
  const script = `$recs = Get-DnsServerResourceRecord -ZoneName '${z}' -ErrorAction SilentlyContinue; [PSCustomObject]@{ Total=$recs.Count; A=($recs | Where-Object RecordType -eq 'A').Count; PTR=($recs | Where-Object RecordType -eq 'PTR').Count; CNAME=($recs | Where-Object RecordType -eq 'CNAME').Count; MX=($recs | Where-Object RecordType -eq 'MX').Count; TXT=($recs | Where-Object RecordType -eq 'TXT').Count; SRV=($recs | Where-Object RecordType -eq 'SRV').Count; AAAA=($recs | Where-Object RecordType -eq 'AAAA').Count } | ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Get DNS forwarders
async function getDnsForwarders(serverIp, auth) {
  const script = `Get-DnsServerForwarder -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress | ForEach-Object { $_.IPAddressToString } | ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Get scavenging/aging settings per zone
async function getDnsZoneScavenging(serverIp, auth, zoneName) {
  const z = psq(zoneName);
  const script = `Get-DnsServerZoneAging -ZoneName '${z}' -ErrorAction SilentlyContinue | Select-Object AgingEnabled,ScavengeServers,NoRefreshInterval,RefreshInterval | ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Get stale records (not updated in X days)
async function getDnsStaleRecords(serverIp, auth, zoneName, staleDays) {
  const z = psq(zoneName);
  // UNQUOTED numeric position inside AddDays(-N) — the '-' is part of the script, so
  // the emitted value must be a non-negative integer (min 1). 36500 days = 100 years.
  const cutoff = psNum(staleDays || 90, 90, 1, 36500);
  // `$r = @(...)` + `ConvertTo-Json -InputObject` is deliberate, NOT a style choice.
  // Piping an EMPTY pipeline into ConvertTo-Json emits nothing at all, so runPS saw
  // empty output and returned null — identical to what it returns when the command
  // genuinely FAILS. The caller could not tell "this zone has no stale records" from
  // "this zone could not be read", and had to guess. Forcing an array makes an empty
  // result a real `[]` (live-verified on 172.24.0.44), so null now unambiguously
  // means failure. A single record also serialises as a 1-element array rather than
  // a bare object, which the caller already handles.
  // Caveat unchanged: -ErrorAction SilentlyContinue still swallows a per-zone read
  // error into an empty result, so an unreadable zone reads as "no stale records".
  const script = `$cutoff = (Get-Date).AddDays(-${cutoff}); $r = @(Get-DnsServerResourceRecord -ZoneName '${z}' -ErrorAction SilentlyContinue | Where-Object { $_.TimeStamp -and $_.TimeStamp -lt $cutoff -and $_.RecordType -ne 'SOA' -and $_.RecordType -ne 'NS' } | Select-Object HostName,RecordType,TimeStamp); ConvertTo-Json -InputObject $r -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Test forwarder reachability (resolves a name via the forwarder, measures ms)
async function testDnsForwarder(serverIp, auth, forwarderIp) {
  const f = psq(forwarderIp);
  // Force an A-record lookup and use -ErrorAction Stop so a failed resolve lands
  // in catch; both branches emit an explicit [PSCustomObject] with a real
  // boolean Reachable (never the raw record array, which has no .Reachable).
  // NOTE: a try/catch statement cannot be the left side of a pipeline in
  // PowerShell — `try{}catch{}|ConvertTo-Json` is a parse error and makes the
  // whole Invoke-Command scriptblock fail (runPS then returns null and every
  // forwarder is silently skipped). Capture the result in $out inside each
  // branch, then pipe that variable (an expression) to ConvertTo-Json after.
  const script = `$start=Get-Date;$out=$null;try{$r=Resolve-DnsName -Name 'google.com' -Server '${f}' -Type A -ErrorAction Stop;$ms=[int](((Get-Date)-$start).TotalMilliseconds);$out=[PSCustomObject]@{Reachable=$true;ResponseMs=$ms;Forwarder='${f}'}}catch{$ms=[int](((Get-Date)-$start).TotalMilliseconds);$out=[PSCustomObject]@{Reachable=$false;ResponseMs=$ms;Forwarder='${f}'}};$out|ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Get DNS query statistics from performance counters
async function getDnsQueryStats(serverIp, auth) {
  const script = `$counters = Get-Counter -Counter '\\DNS\\Total Query Received/sec','\\DNS\\Total Response Sent/sec','\\DNS\\Total Query Received','\\DNS\\Recursive Queries/sec' -ErrorAction SilentlyContinue; $vals = @{}; if ($counters) { $counters.CounterSamples | ForEach-Object { $vals[$_.Path.Split('\\')[-1]] = [math]::Round($_.CookedValue,2) } }; $vals | ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// ════════════════════════════════════════════════════════════
// DNS — WRITE
// ════════════════════════════════════════════════════════════

async function addDnsARecord(serverIp, zoneName, hostname, ipAddress, ttl, auth) {
  const script = `Add-DnsServerResourceRecordA -ZoneName '${psq(zoneName)}' -Name '${psq(hostname)}' -IPv4Address '${psq(ipAddress)}' -TimeToLive (New-TimeSpan -Seconds ${psNum(ttl || 3600, 3600, 1, TTL_MAX)}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsCNameRecord(serverIp, zoneName, hostname, alias, ttl, auth) {
  const script = `Add-DnsServerResourceRecordCName -ZoneName '${psq(zoneName)}' -Name '${psq(hostname)}' -HostNameAlias '${psq(alias)}' -TimeToLive (New-TimeSpan -Seconds ${psNum(ttl || 3600, 3600, 1, TTL_MAX)}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsAaaaRecord(serverIp, zoneName, hostname, ipv6Address, ttl, auth) {
  const script = `Add-DnsServerResourceRecordAAAA -ZoneName '${psq(zoneName)}' -Name '${psq(hostname)}' -IPv6Address '${psq(ipv6Address)}' -TimeToLive (New-TimeSpan -Seconds ${psNum(ttl || 3600, 3600, 1, TTL_MAX)}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsSrvRecord(serverIp, zoneName, hostname, priority, weight, port, target, ttl, auth) {
  // -Priority / -Weight / -Port / -Seconds are UNQUOTED numeric positions.
  const script = `Add-DnsServerResourceRecord -Srv -ZoneName '${psq(zoneName)}' -Name '${psq(hostname)}' -DomainName '${psq(target)}' -Priority ${psNum(priority || 0, 0, 0, 65535)} -Weight ${psNum(weight || 0, 0, 0, 65535)} -Port ${psNum(port || 0, 0, 0, 65535)} -TimeToLive (New-TimeSpan -Seconds ${psNum(ttl || 3600, 3600, 1, TTL_MAX)}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsPtrRecord(serverIp, zoneName, hostname, ptrDomain, ttl, auth) {
  const script = `Add-DnsServerResourceRecordPtr -ZoneName '${psq(zoneName)}' -Name '${psq(hostname)}' -PtrDomainName '${psq(ptrDomain)}' -TimeToLive (New-TimeSpan -Seconds ${psNum(ttl || 3600, 3600, 1, TTL_MAX)}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsMxRecord(serverIp, zoneName, hostname, mailExchange, preference, ttl, auth) {
  // -Preference is an UNQUOTED numeric position.
  const script = `Add-DnsServerResourceRecordMX -ZoneName '${psq(zoneName)}' -Name '${psq(hostname)}' -MailExchange '${psq(mailExchange)}' -Preference ${psNum(preference || 10, 10, 0, 65535)} -TimeToLive (New-TimeSpan -Seconds ${psNum(ttl || 3600, 3600, 1, TTL_MAX)}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsTxtRecord(serverIp, zoneName, hostname, text, ttl, auth) {
  const script = `Add-DnsServerResourceRecordTxt -ZoneName '${psq(zoneName)}' -Name '${psq(hostname)}' -DescriptiveText '${psq(text)}' -TimeToLive (New-TimeSpan -Seconds ${psNum(ttl || 3600, 3600, 1, TTL_MAX)}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function removeDnsRecord(serverIp, zoneName, hostname, recordType, recordData, auth) {
  const z = psq(zoneName);
  const h = psq(hostname);
  let script;
  if (recordType === 'A') {
    script = `Remove-DnsServerResourceRecord -ZoneName '${z}' -Name '${h}' -RRType A -RecordData '${psq(recordData)}' -Force -ErrorAction Stop; Write-Output 'ok'`;
  } else if (recordType === 'CNAME') {
    script = `Remove-DnsServerResourceRecord -ZoneName '${z}' -Name '${h}' -RRType CName -Force -ErrorAction Stop; Write-Output 'ok'`;
  } else {
    script = `Get-DnsServerResourceRecord -ZoneName '${z}' -Name '${h}' -RRType '${psq(recordType)}' -ErrorAction Stop | Remove-DnsServerResourceRecord -ZoneName '${z}' -Force; Write-Output 'ok'`;
  }
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsZone(serverIp, zoneName, zoneType, replicationScope, auth) {
  const scope = replicationScope || 'Domain';
  let script;
  if (zoneType === 'Secondary') {
    // ⚠ Pre-existing SEMANTIC bug, deliberately left as-is (only the injection is
    // fixed): this branch passes `replicationScope` as -MasterServers, i.e. it feeds a
    // replication-scope name ('Domain'/'Forest' — what both call sites actually send)
    // into a parameter that wants an IPAddress[] of master servers, so creating a
    // secondary zone cannot succeed today. The value was also interpolated UNQUOTED,
    // which in PowerShell argument mode means a comma-separated value became a real
    // array — so it is quoted per element here, preserving the only input shape that
    // could ever have worked (a comma list of master IPs) while removing the
    // injection. Fixing the semantics means a signature change + a UI field for
    // master servers, which is out of scope for a security fix.
    const masters = String(scope).split(',').map(s => s.trim()).filter(Boolean)
      .map(s => `'${psq(s)}'`).join(',');
    if (!masters) {
      console.error('[PS] addDnsZone: Secondary zone requires at least one master server');
      return false;
    }
    script = `Add-DnsServerSecondaryZone -Name '${psq(zoneName)}' -MasterServers ${masters} -ErrorAction Stop; Write-Output 'ok'`;
  } else {
    script = `Add-DnsServerPrimaryZone -Name '${psq(zoneName)}' -ReplicationScope '${psq(scope)}' -ErrorAction Stop; Write-Output 'ok'`;
  }
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

// Create a conditional forwarder zone — WRITE. forwarderIps is an array of IP strings.
async function addDnsForwarderZone(serverIp, zoneName, forwarderIps, auth) {
  const masters = (Array.isArray(forwarderIps) ? forwarderIps : [forwarderIps])
    .map(ip => String(ip == null ? '' : ip).trim())
    .filter(Boolean)
    .map(ip => `'${psq(ip)}'`)
    .join(',');
  if (!masters) {
    console.error('[PS] addDnsForwarderZone: at least one forwarder IP is required');
    return false;
  }
  const script = `Add-DnsServerConditionalForwarderZone -Name '${psq(zoneName)}' -MasterServers ${masters} -ReplicationScope 'Forest' -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function removeDnsZone(serverIp, zoneName, auth) {
  const script = `Remove-DnsServerZone -Name '${psq(zoneName)}' -Force -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

// Enable/disable scavenging (aging) on a zone — WRITE
async function setDnsZoneAging(serverIp, auth, zoneName, enabled) {
  const z = psq(zoneName);
  const flag = enabled ? '$true' : '$false'; // derived from a boolean — never caller text
  const script = `Set-DnsServerZoneAging -Name '${z}' -Aging ${flag} -Force -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(cleanIp(serverIp), script, auth, true) || '').includes('ok');
}

// ════════════════════════════════════════════════════════════
// HA / FAILOVER / HEALTH — READ
// ════════════════════════════════════════════════════════════

/** DHCP failover relationships configured on a server. */
async function getDhcpFailover(serverIp, auth) {
  const r = await runPS(serverIp,
    `Get-DhcpServerv4Failover -ErrorAction SilentlyContinue | Select-Object Name,PrimaryServerName,SecondaryServerName,State,Mode,LoadBalancePercent,MaxClientLeadTime,ScopeId | ConvertTo-Json -Depth 5 -Compress`,
    auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/** Per-scope state inside a named failover relationship. */
async function getDhcpFailoverScopeState(serverIp, relationshipName, auth) {
  const r = await runPS(serverIp,
    `Get-DhcpServerv4Failover -Name '${psq(relationshipName)}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ScopeId | ForEach-Object { [PSCustomObject]@{ ScopeId = $_.IPAddressToString } } | ConvertTo-Json -Depth 4 -Compress`,
    auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/**
 * Tail a DHCP server's audit log over the SAME authenticated WinRM channel every
 * other collector call uses, and return the raw text.
 *
 * This replaces reading the log over SMB. The SMB route needed a file share on
 * each DHCP server plus filesystem ACLs for whatever identity the collector
 * service happens to run as (LocalSystem → the machine account) — a second,
 * entirely separate access path that has never worked on this deployment, while
 * the WinRM channel beside it works for every other DHCP call. Here the
 * per-server credential is applied exactly as it is for scopes and leases.
 *
 * The path is resolved ON the server from $env:SystemRoot rather than assuming
 * C:\Windows. `-Tail` bounds the payload: these logs reach a few MB/day and the
 * caller keeps a per-server high-water mark, so only the recent tail is needed.
 * returnRaw — the log is CSV text, not JSON.
 *
 * @param {string} serverIp
 * @param {object} auth      - per-server credentials (same shape as every other call)
 * @param {string} dayFile   - e.g. 'DhcpSrvLog-Mon.log' (caller owns day rotation)
 * @param {number} maxLines  - tail size
 * @returns {string|null}    - raw log text, or null if unreadable/absent
 */
async function getDhcpAuditLog(serverIp, auth, dayFile, maxLines) {
  // This allow-list sanitiser is the strongest guard in the file and is kept as the
  // primary control: a filename reduced to [A-Za-z0-9._-] cannot carry a quote, a
  // path separator or a PowerShell metacharacter. psq() is applied on top only so
  // that every interpolation in this file goes through one mechanism.
  const safeFile = String(dayFile || '').replace(/[^A-Za-z0-9._-]/g, ''); // filename only, never a path
  if (!safeFile) return null;
  const n = psNum(parseInt(maxLines, 10) || 2000, 2000, 1, 20000);
  const script =
    `$p = Join-Path $env:SystemRoot 'System32\\dhcp\\${psq(safeFile)}'; ` +
    `if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Tail ${n} } `;
  const out = await runPS(serverIp, script, auth, true, DHCP_LOG_PS_TIMEOUT);
  return (typeof out === 'string' && out.trim()) ? out : null;
}

/** SOA serial for a zone (replication-lag detection). */
async function getDnsZoneSoa(serverIp, zoneName, auth) {
  const z = psq(zoneName);
  // Single line — file convention, kept deliberately.
  const script = `$rec = Get-DnsServerResourceRecord -ZoneName '${z}' -RRType SOA -ErrorAction SilentlyContinue | Select-Object -First 1; if ($rec) { [PSCustomObject]@{ ZoneName='${z}'; Serial=[int64]$rec.RecordData.SerialNumber } | ConvertTo-Json -Compress }`;
  return await runPS(serverIp, script, auth);
}

/** Measure DNS query response time (ms) for a name against this server. */
async function testDnsQuery(serverIp, queryName, auth) {
  // serverIp is embedded INSIDE the PS script (-Server) and as a query fallback,
  // so it must be CIDR-stripped here — runPS only cleans its -ComputerName target.
  const target = cleanIp(serverIp);
  const q = psq(queryName || target);
  const t = psq(target);
  // Single line — file convention, kept deliberately.
  const script = `$sw = [System.Diagnostics.Stopwatch]::StartNew(); try { Resolve-DnsName -Name '${q}' -Server '${t}' -QuickTimeout -ErrorAction Stop | Out-Null; $ok = $true } catch { $ok = $false }; $sw.Stop(); [PSCustomObject]@{ Ok=$ok; Ms=[int]$sw.ElapsedMilliseconds } | ConvertTo-Json -Compress`;
  return await runPS(serverIp, script, auth);
}

module.exports = {
  runPS,
  runLocalPS,
  testWinRM,
  addToTrustedHosts,
  // escaping helpers (exported for unit tests and for any new PS builder)
  psq,
  psNum,
  // HA / health
  getDhcpFailover,
  getDhcpFailoverScopeState,
  getDnsZoneSoa,
  testDnsQuery,
  // DHCP read
  getDhcpAuditLog,
  getDhcpScopeStats,
  getDhcpScopes,
  getDhcpLeases,
  getDhcpReservations,
  // DHCP write
  addDhcpReservation,
  removeDhcpReservation,
  createDhcpScope,
  editDhcpScope,
  setScopeState,
  deleteDhcpScope,
  getDhcpScopeOptions,
  setDhcpScopeOption,
  getDhcpExclusions,
  addDhcpExclusion,
  // DNS read
  getDnsZones,
  getDnsRecords,
  getDnsServerStats,
  getDnsServerRole,
  getDnsZoneSoaDetail,
  getDnsZoneRecordCounts,
  getDnsForwarders,
  getDnsZoneScavenging,
  getDnsStaleRecords,
  testDnsForwarder,
  getDnsQueryStats,
  // DNS write
  addDnsARecord,
  addDnsAaaaRecord,
  addDnsSrvRecord,
  addDnsCNameRecord,
  addDnsPtrRecord,
  addDnsMxRecord,
  addDnsTxtRecord,
  removeDnsRecord,
  addDnsZone,
  addDnsForwarderZone,
  removeDnsZone,
  setDnsZoneAging,
};
