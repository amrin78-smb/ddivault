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

const { execSync } = require('child_process');

const PS_TIMEOUT = parseInt(process.env.PS_TIMEOUT_MS || '30000');

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
function runPS(serverIp, script, auth, returnRaw) {
  if (!serverIp) {
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
      console.error(`[PS] credential mode requires ps_username and ps_password for ${serverIp}`);
      return null;
    }
    const safePass = pass.replace(/'/g, "''");
    const safeUser = user.replace(/'/g, "''");
    const portOpt  = port !== 5985 ? ` -Port ${port}` : '';
    const httpsOpt = useHttps ? ' -UseSSL' : '';
    psCmd = `powershell.exe -NonInteractive -NoProfile -Command "` +
      `$secPass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force; ` +
      `$cred = New-Object System.Management.Automation.PSCredential('${safeUser}', $secPass); ` +
      `try { ` +
        `Invoke-Command -ComputerName '${serverIp}'${portOpt}${httpsOpt} -Credential $cred -ScriptBlock { ${safeScript} } | ConvertTo-Json -Depth 10 -Compress ` +
      `} catch { Write-Error $_.Exception.Message; exit 1 }" `;

  } else {
    // kerberos — use current Windows identity (NocVault service account)
    const portOpt  = port !== 5985 ? ` -Port ${port}` : '';
    const httpsOpt = useHttps ? ' -UseSSL' : '';
    psCmd = `powershell.exe -NonInteractive -NoProfile -Command "` +
      `try { ` +
        `Invoke-Command -ComputerName '${serverIp}'${portOpt}${httpsOpt} -ScriptBlock { ${safeScript} } | ConvertTo-Json -Depth 10 -Compress ` +
      `} catch { Write-Error $_.Exception.Message; exit 1 }"`;
  }

  try {
    const raw = execSync(psCmd, { encoding: 'utf8', timeout: PS_TIMEOUT }).trim();
    if (!raw) return returnRaw ? '' : null;
    if (returnRaw) return raw;
    return JSON.parse(raw);
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').trim().slice(0, 400);
    console.error(`[PS] Command failed on ${serverIp} (mode=${mode}):`, msg);
    return null;
  }
}

/**
 * Run a simple local PowerShell command — no remote, no auth.
 */
function runLocalPS(script) {
  try {
    return execSync(
      `powershell.exe -NonInteractive -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: PS_TIMEOUT }
    ).trim();
  } catch (err) {
    console.error('[PS] Local command failed:', (err.stderr || err.message || '').slice(0, 200));
    return null;
  }
}

/**
 * Test WinRM connectivity to a server.
 * @param {string} serverIp
 * @param {object} auth
 * @returns {{ ok: boolean, error: string|null, latencyMs: number|null }}
 */
function testWinRM(serverIp, auth) {
  if (!serverIp) return { ok: false, error: 'No server IP', latencyMs: null };
  const start = Date.now();
  try {
    const result = runPS(serverIp, `Write-Output 'winrm-ok'`, auth, true);
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

function getDhcpScopeStats(serverIp, auth) {
  const r = runPS(serverIp, `Get-DhcpServerv4ScopeStatistics | Select-Object ScopeId,PercentageInUse,InUse,Free,Reserved,Pending | ConvertTo-Json -Depth 5 -Compress`, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

function getDhcpScopes(serverIp, auth) {
  const r = runPS(serverIp, `Get-DhcpServerv4Scope | Select-Object ScopeId,Name,StartRange,EndRange,SubnetMask,State,LeaseDuration,Description | ConvertTo-Json -Depth 5 -Compress`, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

function getDhcpLeases(serverIp, auth) {
  const r = runPS(serverIp, `Get-DhcpServerv4Lease -AllScope | Select-Object ScopeId,IPAddress,HostName,ClientId,AddressState,LeaseExpiryTime | ConvertTo-Json -Depth 5 -Compress`, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

function getDhcpReservations(serverIp, scopeId, auth) {
  const script = scopeId
    ? `Get-DhcpServerv4Reservation -ScopeId '${scopeId}' | Select-Object ScopeId,IPAddress,ClientId,Name,Description | ConvertTo-Json -Depth 5 -Compress`
    : `Get-DhcpServerv4Scope | ForEach-Object { Get-DhcpServerv4Reservation -ScopeId $_.ScopeId -ErrorAction SilentlyContinue } | Select-Object ScopeId,IPAddress,ClientId,Name,Description | ConvertTo-Json -Depth 5 -Compress`;
  const r = runPS(serverIp, script, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

// ════════════════════════════════════════════════════════════
// DHCP — WRITE
// ════════════════════════════════════════════════════════════

function addDhcpReservation(serverIp, scopeId, ipAddress, macAddress, name, auth) {
  const mac    = macAddress.replace(/[:\s]/g, '-').toUpperCase();
  const saName = (name || ipAddress).replace(/'/g, "''");
  const script = `Add-DhcpServerv4Reservation -ScopeId '${scopeId}' -IPAddress '${ipAddress}' -ClientId '${mac}' -Name '${saName}' -ErrorAction Stop; Write-Output 'ok'`;
  const r = runPS(serverIp, script, auth, true);
  return !!(r && r.includes('ok'));
}

function removeDhcpReservation(serverIp, scopeId, ipAddress, auth) {
  const script = `Remove-DhcpServerv4Reservation -ScopeId '${scopeId}' -IPAddress '${ipAddress}' -ErrorAction Stop; Write-Output 'ok'`;
  const r = runPS(serverIp, script, auth, true);
  return !!(r && r.includes('ok'));
}

// ════════════════════════════════════════════════════════════
// DNS — READ
// ════════════════════════════════════════════════════════════

function getDnsZones(serverIp, auth) {
  const r = runPS(serverIp, `Get-DnsServerZone | Select-Object ZoneName,ZoneType,IsAutoCreated,IsDsIntegrated,IsReverseLookupZone,IsReadOnly | ConvertTo-Json -Depth 5 -Compress`, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

function getDnsRecords(serverIp, zoneName, auth) {
  const script = `
Get-DnsServerResourceRecord -ZoneName '${zoneName}' | ForEach-Object {
  $r = $_; $data = ''
  try {
    if ($r.RecordData.IPv4Address)     { $data = $r.RecordData.IPv4Address.IPAddressToString }
    elseif ($r.RecordData.IPv6Address) { $data = $r.RecordData.IPv6Address.IPAddressToString }
    elseif ($r.RecordData.HostNameAlias) { $data = $r.RecordData.HostNameAlias }
    elseif ($r.RecordData.MailExchange)  { $data = $r.RecordData.MailExchange + ' ' + $r.RecordData.Preference }
    elseif ($r.RecordData.NameServer)    { $data = $r.RecordData.NameServer }
    elseif ($r.RecordData.DescriptiveText) { $data = $r.RecordData.DescriptiveText }
    else { $data = '' }
  } catch {}
  [PSCustomObject]@{ HostName=$r.HostName; RecordType=$r.RecordType; TTL=[int]$r.TimeToLive.TotalSeconds; RecordData=$data }
} | ConvertTo-Json -Depth 5 -Compress`;
  const r = runPS(serverIp, script, auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

function getDnsServerStats(serverIp, auth) {
  const script = `
$s = Get-DnsServerStatistics -ErrorAction SilentlyContinue
if ($s) { [PSCustomObject]@{ TotalQueries=$s.Query2Statistics.TotalReceived; TotalResponses=$s.Query2Statistics.TotalResponseSent; TotalFailures=$s.Query2Statistics.TotalFailure } | ConvertTo-Json -Compress }`;
  return runPS(serverIp, script, auth);
}

// ════════════════════════════════════════════════════════════
// DNS — WRITE
// ════════════════════════════════════════════════════════════

function addDnsARecord(serverIp, zoneName, hostname, ipAddress, ttl, auth) {
  const script = `Add-DnsServerResourceRecordA -ZoneName '${zoneName}' -Name '${hostname}' -IPv4Address '${ipAddress}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(runPS(serverIp, script, auth, true) || '').includes('ok');
}

function addDnsCNameRecord(serverIp, zoneName, hostname, alias, ttl, auth) {
  const script = `Add-DnsServerResourceRecordCName -ZoneName '${zoneName}' -Name '${hostname}' -HostNameAlias '${alias}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(runPS(serverIp, script, auth, true) || '').includes('ok');
}

function addDnsPtrRecord(serverIp, zoneName, hostname, ptrDomain, ttl, auth) {
  const script = `Add-DnsServerResourceRecordPtr -ZoneName '${zoneName}' -Name '${hostname}' -PtrDomainName '${ptrDomain}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(runPS(serverIp, script, auth, true) || '').includes('ok');
}

function addDnsMxRecord(serverIp, zoneName, hostname, mailExchange, preference, ttl, auth) {
  const script = `Add-DnsServerResourceRecordMX -ZoneName '${zoneName}' -Name '${hostname}' -MailExchange '${mailExchange}' -Preference ${preference||10} -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(runPS(serverIp, script, auth, true) || '').includes('ok');
}

function addDnsTxtRecord(serverIp, zoneName, hostname, text, ttl, auth) {
  const escaped = text.replace(/'/g, "''");
  const script = `Add-DnsServerResourceRecordTxt -ZoneName '${zoneName}' -Name '${hostname}' -DescriptiveText '${escaped}' -TimeToLive (New-TimeSpan -Seconds ${ttl||3600}) -ErrorAction Stop; Write-Output 'ok'`;
  return !!(runPS(serverIp, script, auth, true) || '').includes('ok');
}

function removeDnsRecord(serverIp, zoneName, hostname, recordType, recordData, auth) {
  let script;
  if (recordType === 'A') {
    script = `Remove-DnsServerResourceRecord -ZoneName '${zoneName}' -Name '${hostname}' -RRType A -RecordData '${recordData}' -Force -ErrorAction Stop; Write-Output 'ok'`;
  } else if (recordType === 'CNAME') {
    script = `Remove-DnsServerResourceRecord -ZoneName '${zoneName}' -Name '${hostname}' -RRType CName -Force -ErrorAction Stop; Write-Output 'ok'`;
  } else {
    script = `Get-DnsServerResourceRecord -ZoneName '${zoneName}' -Name '${hostname}' -RRType '${recordType}' -ErrorAction Stop | Remove-DnsServerResourceRecord -ZoneName '${zoneName}' -Force; Write-Output 'ok'`;
  }
  return !!(runPS(serverIp, script, auth, true) || '').includes('ok');
}

function addDnsZone(serverIp, zoneName, zoneType, replicationScope, auth) {
  const scope = replicationScope || 'Domain';
  const script = zoneType === 'Secondary'
    ? `Add-DnsServerSecondaryZone -Name '${zoneName}' -MasterServers ${scope} -ErrorAction Stop; Write-Output 'ok'`
    : `Add-DnsServerPrimaryZone -Name '${zoneName}' -ReplicationScope '${scope}' -ErrorAction Stop; Write-Output 'ok'`;
  return !!(runPS(serverIp, script, auth, true) || '').includes('ok');
}

function removeDnsZone(serverIp, zoneName, auth) {
  const script = `Remove-DnsServerZone -Name '${zoneName}' -Force -ErrorAction Stop; Write-Output 'ok'`;
  return !!(runPS(serverIp, script, auth, true) || '').includes('ok');
}

// ════════════════════════════════════════════════════════════
// HA / FAILOVER / HEALTH — READ
// ════════════════════════════════════════════════════════════

/** DHCP failover relationships configured on a server. */
function getDhcpFailover(serverIp, auth) {
  const r = runPS(serverIp,
    `Get-DhcpServerv4Failover -ErrorAction SilentlyContinue | Select-Object Name,PrimaryServerName,SecondaryServerName,State,Mode,LoadBalancePercent,MaxClientLeadTime,ScopeId | ConvertTo-Json -Depth 5 -Compress`,
    auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/** Per-scope state inside a named failover relationship. */
function getDhcpFailoverScopeState(serverIp, relationshipName, auth) {
  const r = runPS(serverIp,
    `Get-DhcpServerv4Failover -Name '${String(relationshipName).replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ScopeId | ForEach-Object { [PSCustomObject]@{ ScopeId = $_.IPAddressToString } } | ConvertTo-Json -Depth 4 -Compress`,
    auth);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/** SOA serial for a zone (replication-lag detection). */
function getDnsZoneSoa(serverIp, zoneName, auth) {
  const script = `
$rec = Get-DnsServerResourceRecord -ZoneName '${String(zoneName).replace(/'/g, "''")}' -RRType SOA -ErrorAction SilentlyContinue | Select-Object -First 1
if ($rec) { [PSCustomObject]@{ ZoneName='${String(zoneName).replace(/'/g, "''")}'; Serial=[int64]$rec.RecordData.SerialNumber } | ConvertTo-Json -Compress }`;
  return runPS(serverIp, script, auth);
}

/** Measure DNS query response time (ms) for a name against this server. */
function testDnsQuery(serverIp, queryName, auth) {
  const q = String(queryName || serverIp).replace(/'/g, "''");
  const script = `
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try { Resolve-DnsName -Name '${q}' -Server '${serverIp}' -QuickTimeout -ErrorAction Stop | Out-Null; $ok = $true } catch { $ok = $false }
$sw.Stop()
[PSCustomObject]@{ Ok=$ok; Ms=[int]$sw.ElapsedMilliseconds } | ConvertTo-Json -Compress`;
  return runPS(serverIp, script, auth);
}

module.exports = {
  runPS,
  runLocalPS,
  testWinRM,
  // HA / health
  getDhcpFailover,
  getDhcpFailoverScopeState,
  getDnsZoneSoa,
  testDnsQuery,
  // DHCP read
  getDhcpScopeStats,
  getDhcpScopes,
  getDhcpLeases,
  getDhcpReservations,
  // DHCP write
  addDhcpReservation,
  removeDhcpReservation,
  // DNS read
  getDnsZones,
  getDnsRecords,
  getDnsServerStats,
  // DNS write
  addDnsARecord,
  addDnsCNameRecord,
  addDnsPtrRecord,
  addDnsMxRecord,
  addDnsTxtRecord,
  removeDnsRecord,
  addDnsZone,
  removeDnsZone,
};
