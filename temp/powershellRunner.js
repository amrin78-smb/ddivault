'use strict';

/**
 * powershellRunner.js
 * Executes PowerShell commands locally or remotely via WinRM.
 * All functions return parsed JS objects — caller never sees raw PS output.
 *
 * Auth strategy (set in .env.local):
 *   PS_AUTH_MODE = 'local'     — run on this machine (NexVault server is also DHCP server)
 *   PS_AUTH_MODE = 'credential'— Invoke-Command with explicit -Credential
 *   PS_AUTH_MODE = 'kerberos'  — domain-joined, no credential object needed
 *
 * DHCP_SERVER env var = target hostname or IP (can be same as localhost)
 */

const { execSync } = require('child_process');

const PS_TIMEOUT = parseInt(process.env.PS_TIMEOUT_MS || '30000');
const PS_AUTH_MODE = process.env.PS_AUTH_MODE || 'local';
const DHCP_SERVER  = process.env.DHCP_SERVER  || '';
const DNS_SERVER   = process.env.DNS_SERVER   || '';

// ── Credential block (used only when PS_AUTH_MODE=credential) ──
function credentialBlock() {
  const user = process.env.PS_USERNAME || '';
  const pass = process.env.PS_PASSWORD || '';
  if (!user || !pass) return '';
  return `
$secPass = ConvertTo-SecureString '${pass.replace(/'/g, "''")}' -AsPlainText -Force;
$cred    = New-Object System.Management.Automation.PSCredential('${user}', $secPass);
`;
}

/**
 * Run a PowerShell scriptblock on a remote server.
 * @param {string} server   - hostname or IP
 * @param {string} script   - PS code to run inside Invoke-Command scriptblock
 * @returns {any}           - parsed JSON result, or null on error
 */
function runRemotePS(server, script) {
  if (!server) {
    console.warn('[PS] No server configured — skipping remote command');
    return null;
  }

  let psCmd;

  if (PS_AUTH_MODE === 'local') {
    // Server is localhost — run directly
    psCmd = `powershell.exe -NonInteractive -NoProfile -Command "
      try {
        ${script}
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    "`;
  } else if (PS_AUTH_MODE === 'credential') {
    const cred = credentialBlock();
    psCmd = `powershell.exe -NonInteractive -NoProfile -Command "
      ${cred}
      try {
        Invoke-Command -ComputerName '${server}' -Credential $cred -ScriptBlock {
          ${script}
        } | ConvertTo-Json -Depth 10 -Compress
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    "`;
  } else {
    // kerberos / domain — no explicit credential
    psCmd = `powershell.exe -NonInteractive -NoProfile -Command "
      try {
        Invoke-Command -ComputerName '${server}' -ScriptBlock {
          ${script}
        } | ConvertTo-Json -Depth 10 -Compress
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    "`;
  }

  try {
    const raw = execSync(psCmd, { encoding: 'utf8', timeout: PS_TIMEOUT });
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (err) {
    const msg = err.stderr || err.message || 'Unknown PS error';
    console.error(`[PS] Remote command failed on ${server}:`, msg.trim());
    return null;
  }
}

/**
 * Run a simple local PowerShell command, return raw string output.
 */
function runLocalPS(script) {
  const psCmd = `powershell.exe -NonInteractive -NoProfile -Command "${script.replace(/"/g, '\\"')}"`;
  try {
    return execSync(psCmd, { encoding: 'utf8', timeout: PS_TIMEOUT }).trim();
  } catch (err) {
    console.error('[PS] Local command failed:', (err.stderr || err.message || '').trim());
    return null;
  }
}

// ── DHCP queries ─────────────────────────────────────────────

/**
 * Get scope utilization statistics.
 * Returns array of scope stat objects.
 */
function getDhcpScopeStats(server) {
  const target = server || DHCP_SERVER;
  const script = `
    Get-DhcpServerv4ScopeStatistics |
      Select-Object ScopeId, PercentageInUse, InUse, Free, Reserved, Pending, SuperScopeId |
      ConvertTo-Json -Depth 5 -Compress
  `;
  const result = runRemotePS(target, script);
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

/**
 * Get full scope configuration (name, range, mask, state, lease duration).
 */
function getDhcpScopes(server) {
  const target = server || DHCP_SERVER;
  const script = `
    Get-DhcpServerv4Scope |
      Select-Object ScopeId, Name, StartRange, EndRange, SubnetMask,
                    State, LeaseDuration, Description |
      ConvertTo-Json -Depth 5 -Compress
  `;
  const result = runRemotePS(target, script);
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

/**
 * Get all active leases across all scopes.
 */
function getDhcpLeases(server) {
  const target = server || DHCP_SERVER;
  const script = `
    Get-DhcpServerv4Lease -AllScope |
      Select-Object ScopeId, IPAddress, HostName, ClientId,
                    AddressState, LeaseExpiryTime |
      ConvertTo-Json -Depth 5 -Compress
  `;
  const result = runRemotePS(target, script);
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

// ── DNS queries ───────────────────────────────────────────────

/**
 * Get all DNS zones from a DNS server.
 */
function getDnsZones(server) {
  const target = server || DNS_SERVER || DHCP_SERVER;
  const script = `
    Get-DnsServerZone |
      Select-Object ZoneName, ZoneType, IsAutoCreated, IsDsIntegrated,
                    IsReverseLookupZone, IsReadOnly |
      ConvertTo-Json -Depth 5 -Compress
  `;
  const result = runRemotePS(target, script);
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

/**
 * Get DNS records for a specific zone.
 */
function getDnsRecords(server, zoneName) {
  const target = server || DNS_SERVER || DHCP_SERVER;
  const script = `
    Get-DnsServerResourceRecord -ZoneName '${zoneName}' |
      Select-Object HostName, RecordType,
        @{Name='TimeToLive';Expression={$_.TimeToLive.TotalSeconds}},
        @{Name='RecordData';Expression={$_.RecordData.IPv4Address.IPAddressToString -or
          $_.RecordData.HostNameAlias -or $_.RecordData.MailExchange -or
          ($_.RecordData | ConvertTo-Json -Compress)}} |
      ConvertTo-Json -Depth 5 -Compress
  `;
  const result = runRemotePS(target, script);
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

/**
 * Check if WinRM is reachable on a server.
 * Returns true/false.
 */
function testWinRM(server) {
  const target = server || DHCP_SERVER;
  if (!target) return false;
  const script = `
    Test-WSMan -ComputerName '${target}' -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty ProductVersion
  `;
  const result = runLocalPS(script);
  return !!(result && result.trim());
}

module.exports = {
  runRemotePS,
  runLocalPS,
  getDhcpScopeStats,
  getDhcpScopes,
  getDhcpLeases,
  getDnsZones,
  getDnsRecords,
  testWinRM,
};
