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

const { exec } = require('child_process');

// Every PowerShell/WinRM call used to run through execSync, which BLOCKS the Node
// event loop for the whole duration (up to PS_DNS_TIMEOUT = 60s). While blocked,
// nothing else in the process runs — including pg's connection callbacks and its
// connectionTimeoutMillis timer, so a perfectly healthy database reported
// "Connection terminated due to connection timeout" purely because the loop was
// frozen. Same freeze hit the API server, where a single DNS write stalled every
// other HTTP request. exec() keeps the loop free; callers await instead.
//
// Resolves to stdout (not {stdout,stderr}) so call sites keep their .trim() shape,
// and re-attaches stdout/stderr to the error so the existing catch blocks — which
// read err.stderr/err.stdout — behave exactly as they did under execSync.
const PS_MAX_BUFFER = 32 * 1024 * 1024; // was exec/execSync's 1MB default; big DNS zones and DHCP log tails overflowed it
function execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      // execSync forwarded the child's stderr to our own stderr by default; exec
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

// PostgreSQL inet values include CIDR (e.g. 172.24.0.10/32) which the
// PowerShell remoting functions reject — strip it before any PS use.
const cleanIp = ip => (ip || '').replace(/\/\d+$/, '').trim();

// Global fallback auth (from .env.local)
const DEFAULT_AUTH_MODE = process.env.PS_AUTH_MODE || 'kerberos';
const DEFAULT_USERNAME  = process.env.PS_USERNAME  || '';
const DEFAULT_PASSWORD  = process.env.PS_PASSWORD  || '';

/**
 * Build PowerShell command string for a given server config.
 *
 * @param {string} serverIp
 * @param {string} script      - PS script to execute
 * @param {object} auth        - { auth_mode, ps_username, ps_password, winrm_port, winrm_https }
 * @param {boolean} returnRaw  - if true, return stdout as-is; if false, parse JSON
 * @returns {string|object|null}
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

  // Escape script for PowerShell -Command argument
  const safeScript = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  let psCmd;

  if (mode === 'local') {
    // Run directly on this machine — only works if NocVault IS the target server
    psCmd = `powershell.exe -NonInteractive -NoProfile -Command "try { ${safeScript} } catch { Write-Error $_.Exception.Message; exit 1 }"`;

  } else if (mode === 'credential') {
    if (!user || !pass) {
      console.error(`[PS] credential mode requires ps_username and ps_password for ${cleanIp}`);
      return null;
    }
    const safePass = pass.replace(/'/g, "''");
    const safeUser = user.replace(/'/g, "''");
    const portOpt  = port !== 5985 ? ` -Port ${port}` : '';
    const httpsOpt = useHttps ? ' -UseSSL' : '';
    // NOTE: the inner script already pipes to ConvertTo-Json — do NOT add a second
    // ConvertTo-Json here or the output gets double-encoded (a JSON string of a JSON
    // string), which JSON.parse turns back into a string, not an array/object.
    psCmd = `powershell.exe -NonInteractive -NoProfile -Command "` +
      `$secPass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force; ` +
      `$cred = New-Object System.Management.Automation.PSCredential('${safeUser}', $secPass); ` +
      `try { ` +
        `Invoke-Command -ComputerName '${cleanIp}'${portOpt}${httpsOpt} -Credential $cred -ScriptBlock { ${safeScript} } ` +
      `} catch { Write-Error $_.Exception.Message; exit 1 }" `;

  } else {
    // kerberos — use current Windows identity (NocVault service account)
    const portOpt  = port !== 5985 ? ` -Port ${port}` : '';
    const httpsOpt = useHttps ? ' -UseSSL' : '';
    // NOTE: inner script already emits JSON — no second ConvertTo-Json (see above).
    psCmd = `powershell.exe -NonInteractive -NoProfile -Command "` +
      `try { ` +
        `Invoke-Command -ComputerName '${cleanIp}'${portOpt}${httpsOpt} -ScriptBlock { ${safeScript} } ` +
      `} catch { Write-Error $_.Exception.Message; exit 1 }"`;
  }

  try {
    const raw = (await execAsync(psCmd, { encoding: 'utf8', timeout: timeoutMs || PS_TIMEOUT, maxBuffer: PS_MAX_BUFFER })).trim();
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
 */
async function runLocalPS(script) {
  try {
    return (await execAsync(
      `powershell.exe -NonInteractive -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: PS_TIMEOUT, maxBuffer: PS_MAX_BUFFER }
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
  // Single line — runLocalPS passes this via -Command, and cmd.exe truncates -Command strings at newlines.
  const script = `$current = (Get-Item WSMan:\\localhost\\Client\\TrustedHosts -ErrorAction SilentlyContinue).Value; $ips = if ($current) { $current -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' } } else { @() }; if ($ips -notcontains '${cleanIp}') { $newList = ($ips + '${cleanIp}') -join ','; Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value $newList -Force; Write-Output 'added' } else { Write-Output 'exists' }`;
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
  // SINGLE line — runPS passes the script via -Command, and cmd.exe truncates
  // -Command strings at newlines (which previously caused "Missing closing '}'").
  const script = `$all = foreach ($s in (Get-DhcpServerv4Scope | Select-Object -ExpandProperty ScopeId)) { Get-DhcpServerv4Lease -ScopeId $s -ErrorAction SilentlyContinue | Select-Object ScopeId,IPAddress,HostName,ClientId,AddressState,LeaseExpiryTime }; $all | ConvertTo-Json -Depth 5 -Compress`;
  const r = await runPS(serverIp, script, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

// scopeId optional — when null/omitted, returns reservations across ALL scopes.
async function getDhcpReservations(serverIp, scopeId, auth) {
  const script = scopeId
    ? `Get-DhcpServerv4Reservation -ScopeId '${scopeId}' | Select-Object ScopeId,IPAddress,ClientId,Name,Description,Type | ConvertTo-Json -Depth 5 -Compress`
    : `$scopes = Get-DhcpServerv4Scope | Select-Object -ExpandProperty ScopeId; $all = foreach ($s in $scopes) { Get-DhcpServerv4Reservation -ScopeId $s -ErrorAction SilentlyContinue | Select-Object ScopeId,IPAddress,ClientId,Name,Description,Type }; $all | ConvertTo-Json -Depth 5 -Compress`;
  const r = await runPS(serverIp, script, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

// ════════════════════════════════════════════════════════════
// DHCP — WRITE
// ════════════════════════════════════════════════════════════

async function addDhcpReservation(serverIp, scopeId, ipAddress, macAddress, name, auth) {
  const mac    = macAddress.replace(/[:\s]/g, '-').toUpperCase();
  const saName = (name || ipAddress).replace(/'/g, "''");
  const script = `Add-DhcpServerv4Reservation -ScopeId '${scopeId}' -IPAddress '${ipAddress}' -ClientId '${mac}' -Name '${saName}' -ErrorAction Stop; Write-Output 'ok'`;
  const r = await runPS(serverIp, script, auth, true);
  return !!(r && r.includes('ok'));
}

async function removeDhcpReservation(serverIp, scopeId, ipAddress, auth) {
  const script = `Remove-DhcpServerv4Reservation -ScopeId '${scopeId}' -IPAddress '${ipAddress}' -ErrorAction Stop; Write-Output 'ok'`;
  const r = await runPS(serverIp, script, auth, true);
  return !!(r && r.includes('ok'));
}

async function createDhcpScope(serverIp, auth, scope) {
  // scope = { name, startRange, endRange, subnetMask, description, leaseDuration, state }
  const ip = cleanIp(serverIp);
  const state = scope.state || 'Active';
  const desc = (scope.description || '').replace(/'/g, "''");
  const name = (scope.name || '').replace(/'/g, "''");
  const duration = scope.leaseDuration || '8.00:00:00'; // 8 days default
  const script = `Add-DhcpServerv4Scope -Name '${name}' -StartRange '${scope.startRange}' -EndRange '${scope.endRange}' -SubnetMask '${scope.subnetMask}' -Description '${desc}' -LeaseDuration '${duration}' -State '${state}' -PassThru | Select-Object ScopeId,Name,StartRange,EndRange,SubnetMask,State | ConvertTo-Json -Compress`;
  return await runPS(ip, script, auth);
}

async function editDhcpScope(serverIp, auth, scopeId, changes) {
  // changes = { name, description, leaseDuration, state }
  const ip = cleanIp(serverIp);
  const parts = [];
  if (changes.name) parts.push(`-Name '${changes.name.replace(/'/g, "''")}'`);
  if (changes.description !== undefined) parts.push(`-Description '${(changes.description||'').replace(/'/g, "''")}'`);
  if (changes.leaseDuration) parts.push(`-LeaseDuration '${changes.leaseDuration}'`);
  if (changes.state) parts.push(`-State '${changes.state}'`);
  const script = `Set-DhcpServerv4Scope -ScopeId '${scopeId}' ${parts.join(' ')}; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

async function setScopeState(serverIp, auth, scopeId, state) {
  const ip = cleanIp(serverIp);
  const script = `Set-DhcpServerv4Scope -ScopeId '${scopeId}' -State '${state}'; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

async function deleteDhcpScope(serverIp, auth, scopeId) {
  const ip = cleanIp(serverIp);
  const script = `Remove-DhcpServerv4Scope -ScopeId '${scopeId}' -Force; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

async function getDhcpScopeOptions(serverIp, auth, scopeId) {
  const ip = cleanIp(serverIp);
  const script = `Get-DhcpServerv4OptionValue -ScopeId '${scopeId}' -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ OptionId = $_.OptionId; Name = $_.Name; Value = ($_.Value -join ', ') } } | ConvertTo-Json -Compress`;
  return await runPS(ip, script, auth);
}

async function setDhcpScopeOption(serverIp, auth, scopeId, optionId, values) {
  const ip = cleanIp(serverIp);
  const vals = values.map(v => `'${v}'`).join(',');
  const script = `Set-DhcpServerv4OptionValue -ScopeId '${scopeId}' -OptionId ${optionId} -Value ${vals}; Write-Output 'ok'`;
  return await runPS(ip, script, auth, true);
}

async function getDhcpExclusions(serverIp, auth, scopeId) {
  const ip = cleanIp(serverIp);
  const script = `Get-DhcpServerv4ExclusionRange -ScopeId '${scopeId}' -ErrorAction SilentlyContinue | Select-Object StartRange,EndRange | ConvertTo-Json -Compress`;
  return await runPS(ip, script, auth);
}

async function addDhcpExclusion(serverIp, auth, scopeId, startRange, endRange) {
  const ip = cleanIp(serverIp);
  const script = `Add-DhcpServerv4ExclusionRange -ScopeId '${scopeId}' -StartRange '${startRange}' -EndRange '${endRange}'; Write-Output 'ok'`;
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
  // Single line — cmd.exe truncates -Command strings at newlines.
  const script = `Get-DnsServerResourceRecord -ZoneName '${zoneName}' | ForEach-Object { $r = $_; $data = ''; try { if ($r.RecordData.IPv4Address) { $data = $r.RecordData.IPv4Address.IPAddressToString } elseif ($r.RecordData.IPv6Address) { $data = $r.RecordData.IPv6Address.IPAddressToString } elseif ($r.RecordData.HostNameAlias) { $data = $r.RecordData.HostNameAlias } elseif ($r.RecordData.MailExchange) { $data = $r.RecordData.MailExchange + ' ' + $r.RecordData.Preference } elseif ($r.RecordData.NameServer) { $data = $r.RecordData.NameServer } elseif ($r.RecordData.DescriptiveText) { $data = $r.RecordData.DescriptiveText } else { $data = '' } } catch {}; [PSCustomObject]@{ HostName=$r.HostName; RecordType=$r.RecordType; TTL=[int]$r.TimeToLive.TotalSeconds; RecordData=$data } } | ConvertTo-Json -Depth 5 -Compress`;
  const r = await runPS(serverIp, script, auth, false, DNS_PS_TIMEOUT);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

async function getDnsServerStats(serverIp, auth) {
  // Single line — cmd.exe truncates -Command strings at newlines.
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
  const z = String(zoneName).replace(/'/g, "''");
  const script = `Get-DnsServerResourceRecord -ZoneName '${z}' -RRType Soa -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $soa = $_.RecordData; [PSCustomObject]@{ Serial=$soa.SerialNumber; PrimaryServer=$soa.PrimaryServer; AdminEmail=$soa.ResponsiblePerson; Refresh=$soa.RefreshInterval.TotalSeconds; Retry=$soa.RetryDelay.TotalSeconds; Expire=$soa.ExpireLimit.TotalSeconds; MinTTL=$soa.TimeToLive.TotalSeconds } } | ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Get record counts by type per zone
async function getDnsZoneRecordCounts(serverIp, auth, zoneName) {
  const z = String(zoneName).replace(/'/g, "''");
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
  const z = String(zoneName).replace(/'/g, "''");
  const script = `Get-DnsServerZoneAging -ZoneName '${z}' -ErrorAction SilentlyContinue | Select-Object AgingEnabled,ScavengeServers,NoRefreshInterval,RefreshInterval | ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Get stale records (not updated in X days)
async function getDnsStaleRecords(serverIp, auth, zoneName, staleDays) {
  const z = String(zoneName).replace(/'/g, "''");
  const cutoff = staleDays || 90;
  const script = `$cutoff = (Get-Date).AddDays(-${cutoff}); Get-DnsServerResourceRecord -ZoneName '${z}' -ErrorAction SilentlyContinue | Where-Object { $_.TimeStamp -and $_.TimeStamp -lt $cutoff -and $_.RecordType -ne 'SOA' -and $_.RecordType -ne 'NS' } | Select-Object HostName,RecordType,TimeStamp | ConvertTo-Json -Compress`;
  return await runPS(cleanIp(serverIp), script, auth, false, DNS_PS_TIMEOUT);
}

// Test forwarder reachability (resolves a name via the forwarder, measures ms)
async function testDnsForwarder(serverIp, auth, forwarderIp) {
  const f = String(forwarderIp).replace(/'/g, "''");
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
  const script = `Add-DnsServerResourceRecordA -ZoneName '${zoneName}' -Name '${hostname}' -IPv4Address '${ipAddress}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsCNameRecord(serverIp, zoneName, hostname, alias, ttl, auth) {
  const script = `Add-DnsServerResourceRecordCName -ZoneName '${zoneName}' -Name '${hostname}' -HostNameAlias '${alias}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsAaaaRecord(serverIp, zoneName, hostname, ipv6Address, ttl, auth) {
  const script = `Add-DnsServerResourceRecordAAAA -ZoneName '${zoneName}' -Name '${hostname}' -IPv6Address '${ipv6Address}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsSrvRecord(serverIp, zoneName, hostname, priority, weight, port, target, ttl, auth) {
  const script = `Add-DnsServerResourceRecord -Srv -ZoneName '${zoneName}' -Name '${hostname}' -DomainName '${target}' -Priority ${priority||0} -Weight ${weight||0} -Port ${port||0} -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsPtrRecord(serverIp, zoneName, hostname, ptrDomain, ttl, auth) {
  const script = `Add-DnsServerResourceRecordPtr -ZoneName '${zoneName}' -Name '${hostname}' -PtrDomainName '${ptrDomain}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsMxRecord(serverIp, zoneName, hostname, mailExchange, preference, ttl, auth) {
  const script = `Add-DnsServerResourceRecordMX -ZoneName '${zoneName}' -Name '${hostname}' -MailExchange '${mailExchange}' -Preference ${preference||10} -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsTxtRecord(serverIp, zoneName, hostname, text, ttl, auth) {
  const escaped = text.replace(/'/g, "''");
  const script = `Add-DnsServerResourceRecordTxt -ZoneName '${zoneName}' -Name '${hostname}' -DescriptiveText '${escaped}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function removeDnsRecord(serverIp, zoneName, hostname, recordType, recordData, auth) {
  let script;
  if (recordType === 'A') {
    script = `Remove-DnsServerResourceRecord -ZoneName '${zoneName}' -Name '${hostname}' -RRType A -RecordData '${recordData}' -Force -ErrorAction Stop; Write-Output 'ok'`;
  } else if (recordType === 'CNAME') {
    script = `Remove-DnsServerResourceRecord -ZoneName '${zoneName}' -Name '${hostname}' -RRType CName -Force -ErrorAction Stop; Write-Output 'ok'`;
  } else {
    script = `Get-DnsServerResourceRecord -ZoneName '${zoneName}' -Name '${hostname}' -RRType '${recordType}' -ErrorAction Stop | Remove-DnsServerResourceRecord -ZoneName '${zoneName}' -Force; Write-Output 'ok'`;
  }
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function addDnsZone(serverIp, zoneName, zoneType, replicationScope, auth) {
  const scope = replicationScope || 'Domain';
  const script = zoneType === 'Secondary'
    ? `Add-DnsServerSecondaryZone -Name '${zoneName}' -MasterServers ${scope} -ErrorAction Stop; Write-Output 'ok'`
    : `Add-DnsServerPrimaryZone -Name '${zoneName}' -ReplicationScope '${scope}' -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

// Create a conditional forwarder zone — WRITE. forwarderIps is an array of IP strings.
async function addDnsForwarderZone(serverIp, zoneName, forwarderIps, auth) {
  const masters = (Array.isArray(forwarderIps) ? forwarderIps : [forwarderIps])
    .map(ip => String(ip).trim())
    .filter(Boolean)
    .map(ip => `'${ip}'`)
    .join(',');
  const script = `Add-DnsServerConditionalForwarderZone -Name '${zoneName}' -MasterServers ${masters} -ReplicationScope 'Forest' -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

async function removeDnsZone(serverIp, zoneName, auth) {
  const script = `Remove-DnsServerZone -Name '${zoneName}' -Force -ErrorAction Stop; Write-Output 'ok'`;
  return !!(await runPS(serverIp, script, auth, true) || '').includes('ok');
}

// Enable/disable scavenging (aging) on a zone — WRITE
async function setDnsZoneAging(serverIp, auth, zoneName, enabled) {
  const z = String(zoneName).replace(/'/g, "''");
  const flag = enabled ? '$true' : '$false';
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
    `Get-DhcpServerv4Failover -Name '${String(relationshipName).replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ScopeId | ForEach-Object { [PSCustomObject]@{ ScopeId = $_.IPAddressToString } } | ConvertTo-Json -Depth 4 -Compress`,
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
  const safeFile = String(dayFile || '').replace(/[^A-Za-z0-9._-]/g, ''); // filename only, never a path
  if (!safeFile) return null;
  const n = Math.max(1, Math.min(parseInt(maxLines, 10) || 2000, 20000));
  const script =
    `$p = Join-Path $env:SystemRoot 'System32\\dhcp\\${safeFile}'; ` +
    `if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Tail ${n} } `;
  const out = await runPS(serverIp, script, auth, true);
  return (typeof out === 'string' && out.trim()) ? out : null;
}

/** SOA serial for a zone (replication-lag detection). */
async function getDnsZoneSoa(serverIp, zoneName, auth) {
  // Single line — cmd.exe truncates -Command strings at newlines.
  const script = `$rec = Get-DnsServerResourceRecord -ZoneName '${String(zoneName).replace(/'/g, "''")}' -RRType SOA -ErrorAction SilentlyContinue | Select-Object -First 1; if ($rec) { [PSCustomObject]@{ ZoneName='${String(zoneName).replace(/'/g, "''")}'; Serial=[int64]$rec.RecordData.SerialNumber } | ConvertTo-Json -Compress }`;
  return await runPS(serverIp, script, auth);
}

/** Measure DNS query response time (ms) for a name against this server. */
async function testDnsQuery(serverIp, queryName, auth) {
  // serverIp is embedded INSIDE the PS script (-Server) and as a query fallback,
  // so it must be CIDR-stripped here — runPS only cleans its -ComputerName target.
  const target = cleanIp(serverIp);
  const q = String(queryName || target).replace(/'/g, "''");
  // Single line — cmd.exe truncates -Command strings at newlines.
  const script = `$sw = [System.Diagnostics.Stopwatch]::StartNew(); try { Resolve-DnsName -Name '${q}' -Server '${target}' -QuickTimeout -ErrorAction Stop | Out-Null; $ok = $true } catch { $ok = $false }; $sw.Stop(); [PSCustomObject]@{ Ok=$ok; Ms=[int]$sw.ElapsedMilliseconds } | ConvertTo-Json -Compress`;
  return await runPS(serverIp, script, auth);
}

module.exports = {
  runPS,
  runLocalPS,
  testWinRM,
  addToTrustedHosts,
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
