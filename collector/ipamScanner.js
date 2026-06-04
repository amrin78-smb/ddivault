'use strict';

/**
 * ipamScanner.js — IPAM Network Scanner
 * PS5 compatible. Uses temp script files to avoid command-line length limits.
 * Runs scan in background — does NOT block the API process.
 */

const { execSync, execFile, exec } = require('child_process');
const { Pool }  = require('pg');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const deviceClassifier = require('../api/deviceClassifier'); // { classifyDevice(mac, hostname) }

require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DDI_DB_NAME || 'ddivault',
  user:     process.env.DDI_DB_USER || 'ddivault_user',
  password: process.env.DDI_DB_PASS || '',
  max: 3,
});

const SCAN_TIMEOUT = parseInt(process.env.SCAN_TIMEOUT_MS || '300000'); // 5 min max per subnet

function log(msg)  { console.log(`[${new Date().toISOString()}] [Scanner] ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toISOString()}] [Scanner] WARN: ${msg}`); }

/**
 * Generate all host IPs in a subnet.
 */
function generateHostIPs(network, prefix) {
  if (prefix < 16 || prefix > 30) {
    warn(`Prefix /${prefix} out of safe range — skipping`);
    return [];
  }
  const parts = network.split('.').map(Number);
  const hostCount = Math.pow(2, 32 - prefix) - 2;
  if (hostCount > 1022) {
    warn(`Subnet ${network}/${prefix} has ${hostCount} hosts — too large to scan (max /22)`);
    return [];
  }
  let base = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  base = base & (~0 << (32 - prefix));
  const ips = [];
  for (let i = 1; i <= hostCount; i++) {
    const ip = base + i;
    ips.push(`${(ip>>>24)&255}.${(ip>>>16)&255}.${(ip>>>8)&255}.${ip&255}`);
  }
  return ips;
}

/**
 * Write a PowerShell script to a temp file and execute it.
 * Returns stdout string or null on error.
 */
function runPsScript(scriptContent, timeoutMs) {
  const tmpFile = path.join(os.tmpdir(), `ddivault_scan_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tmpFile, scriptContent, 'utf8');
    const result = execSync(
      `powershell.exe -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { encoding: 'utf8', timeout: timeoutMs || 60000 }
    );
    return result.trim();
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').trim().slice(0, 500);
    warn(`PS script error: ${msg}`);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Async variant of runPsScript — lets multiple batches run concurrently.
 * execSync blocks the event loop, so we use exec() to allow Promise.all
 * to actually parallelize ping batches. Returns stdout string or null.
 */
function runPsScriptAsync(scriptContent, timeoutMs, tag) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `ddivault_scan_${process.pid}_${tag}.ps1`);
    try { fs.writeFileSync(tmpFile, scriptContent, 'utf8'); } catch (_) { return resolve(null); }
    exec(`powershell.exe -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { encoding: 'utf8', timeout: timeoutMs || 60000, maxBuffer: 1024 * 1024 * 8 },
      (err, stdout) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        resolve(err && !stdout ? null : (stdout || '').trim());
      });
  });
}

/**
 * Ping sweep using PS background jobs (PS5 compatible).
 * Runs multiple batches concurrently via runPsScriptAsync and reports
 * progress per chunk via the optional onProgress(scanned, alive) callback.
 * Returns Map of ip -> { alive, responseTime }
 */
async function pingSweep(ips, onProgress) {
  const results = new Map();
  if (!ips.length) return results;
  const BATCH = 50;
  const CONCURRENT_BATCHES = 3;
  const batches = [];
  for (let i = 0; i < ips.length; i += BATCH) batches.push(ips.slice(i, i + BATCH));

  const runBatch = async (batch, idx) => {
    const ipArray = batch.map(ip => `'${ip}'`).join(',');
    const script = `
$ips = @(${ipArray})
$jobs = @()
foreach ($ip in $ips) {
    $jobs += Start-Job -ScriptBlock {
        param($target)
        $alive = Test-Connection -ComputerName $target -Count 1 -Quiet -ErrorAction SilentlyContinue
        if ($alive) {
            $p = Test-Connection -ComputerName $target -Count 1 -ErrorAction SilentlyContinue
            $ms = if ($p -and $p.ResponseTime) { $p.ResponseTime } else { 0 }
            Write-Output "$target,true,$ms"
        } else { Write-Output "$target,false," }
    } -ArgumentList $ip
}
$jobs | Wait-Job -Timeout 15 | Out-Null
foreach ($job in $jobs) {
    $out = Receive-Job $job -ErrorAction SilentlyContinue
    if ($out) { Write-Output $out }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
}
`;
    const raw = await runPsScriptAsync(script, 40000, `b${idx}`);
    const out = [];
    if (raw) {
      for (const line of raw.split('\n')) {
        const parts = line.trim().split(',');
        if (parts.length >= 2) {
          const ip    = parts[0].trim();
          const alive = parts[1].trim() === 'true';
          const ms    = parts[2] ? parseInt(parts[2].trim()) : null;
          if (ip) out.push([ip, { alive, responseTime: alive ? (ms || 0) : null }]);
        }
      }
    } else {
      warn(`Ping sweep failed for batch starting at ${batch[0]} — marking as unknown`);
      for (const ip of batch) out.push([ip, { alive: false, responseTime: null }]);
    }
    return out;
  };

  let scanned = 0, alive = 0;
  for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
    const chunk = batches.slice(i, i + CONCURRENT_BATCHES);
    const chunkOut = await Promise.all(chunk.map((b, k) => runBatch(b, i + k)));
    for (let c = 0; c < chunk.length; c++) {
      scanned += chunk[c].length;
      for (const [ip, val] of chunkOut[c]) {
        results.set(ip, val);
        if (val.alive) alive++;
      }
    }
    if (onProgress) { try { await onProgress(scanned, alive); } catch (_) {} }
  }
  return results;
}

/**
 * Resolve hostname using DNS reverse lookup.
 * Uses custom DNS server if configured in app_settings.
 */
async function resolveHostname(ip, dnsServer) {
  let script;
  if (dnsServer) {
    // Use specific DNS server for PTR lookup
    script = `
try {
    $ns = '${dnsServer}'
    $result = Resolve-DnsName -Name '${ip}' -Type PTR -Server $ns -ErrorAction SilentlyContinue
    if ($result) { Write-Output $result.NameHost } else { Write-Output '' }
} catch { Write-Output '' }
`;
  } else {
    // Use system default DNS
    script = `
try {
    $h = [System.Net.Dns]::GetHostEntry('${ip}')
    Write-Output $h.HostName
} catch { Write-Output '' }
`;
  }
  const result = runPsScript(script, 5000);
  return (result && result.trim()) ? result.trim() : null;
}

/**
 * Get MAC from ARP table using PowerShell.
 * Pings first to populate ARP cache, then reads arp -a.
 */
function getMacFromArp(ip) {
  const script = `
# Ping once to ensure ARP cache is populated
Test-Connection -ComputerName '${ip}' -Count 1 -Quiet -ErrorAction SilentlyContinue | Out-Null
# Read ARP table and find the entry
$arpOutput = arp -a
foreach ($line in $arpOutput) {
    if ($line -match [regex]::Escape('${ip}') + '\\s+([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})') {
        Write-Output $matches[1]
        exit
    }
}
Write-Output ''
`;
  try {
    const result = runPsScript(script, 8000);
    if (result && result.trim()) {
      return result.trim().replace(/-/g, ':').toUpperCase();
    }
    return null;
  } catch (_) { return null; }
}

/**
 * Build the ARP cache once for the whole subnet (instead of per-IP).
 * Reads `arp -a` a single time and parses all IP -> MAC entries.
 * Returns Map of ip -> MAC (colon-separated, uppercase).
 */
function buildArpCache() {
  const cache = new Map();
  try {
    const out = execSync('arp -a', { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split('\n')) {
      const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})/i);
      if (m) cache.set(m[1], m[2].replace(/-/g, ':').toUpperCase());
    }
  } catch (_) {}
  return cache;
}

/**
 * Get DHCP leases for a subnet from DB.
 */
async function getDhcpLeasesForSubnet(network, prefix) {
  try {
    const result = await db.query(
      `SELECT ip_address::text, hostname, mac_address, id FROM dhcp_leases
       WHERE ip_address << ($1 || '/' || $2)::inet AND address_state = 'Active'`,
      [network, prefix]
    );
    const map = new Map();
    for (const row of result.rows) map.set(row.ip_address, row);
    return map;
  } catch (err) {
    warn(`Cannot fetch DHCP leases: ${err.message}`);
    return new Map();
  }
}

/**
 * Scan a single subnet.
 * This is async but runs sequentially — caller should not await in the HTTP handler.
 */
async function scanSubnet(subnet) {
  const { id: subnetId, network, prefix_length: prefix, name } = subnet;
  const label = `${network}/${prefix}${name ? ` (${name})` : ''}`;
  log(`Starting scan: ${label}`);

  // Get custom DNS server from settings if configured
  let dnsServer = null;
  try {
    const setting = await db.query(
      `SELECT value FROM app_settings WHERE key = 'scan_dns_server'`
    );
    if (setting.rows.length && setting.rows[0].value) {
      dnsServer = setting.rows[0].value.trim();
      log(`Using custom DNS server for lookups: ${dnsServer}`);
    }
  } catch (_) {}

  const jobRes = await db.query(
    `INSERT INTO ipam_scan_jobs (subnet_id, status) VALUES ($1, 'running') RETURNING id`,
    [subnetId]
  );
  const jobId = jobRes.rows[0].id;

  await db.query(
    `UPDATE ipam_subnets SET scan_status='scanning', last_scanned=NOW() WHERE id=$1`,
    [subnetId]
  );

  let hostsScanned = 0, hostsUp = 0, hostsUnknown = 0;

  try {
    const ips      = generateHostIPs(network, parseInt(prefix));
    const leaseMap = await getDhcpLeasesForSubnet(network, prefix);

    if (!ips.length) throw new Error(`Cannot scan ${label} — invalid prefix or too large`);

    log(`${label} — pinging ${ips.length} hosts (this may take 1-2 minutes)...`);

    // Build the ARP cache once for the whole subnet (was per-IP, very slow)
    const arpCache = buildArpCache();

    const total = ips.length;
    const pingResults = await pingSweep(ips, async (scanned, up) => {
      const pct = total ? Math.round((scanned / total) * 100) : 0;
      await db.query(
        `UPDATE ipam_scan_jobs SET hosts_scanned=$1, hosts_up=$2, progress_pct=$3, updated_at=NOW()
         WHERE id=$4 AND status='running'`,
        [scanned, up, pct, jobId]
      ).catch(() => {});
    });
    hostsScanned = ips.length;

    const reservedRes = await db.query(
      `SELECT ip_address::text FROM ipam_addresses WHERE subnet_id=$1 AND is_reserved=TRUE`,
      [subnetId]
    );
    const reservedSet = new Set(reservedRes.rows.map(r => r.ip_address));

    let processed = 0;
    for (const ip of ips) {
      if (reservedSet.has(ip)) continue;

      const pingResult = pingResults.get(ip) || { alive: false, responseTime: null };
      const lease = leaseMap.get(ip);

      let status;
      let hostname   = lease?.hostname    || null;
      let macAddress = lease?.mac_address || null;

      // ARP first - detects devices blocking ICMP (Windows firewall etc).
      // Uses the cache built once above instead of a slow per-IP arp call.
      if (!macAddress && !lease) macAddress = arpCache.get(ip) || null;

      // Alive if ping responded OR ARP found a MAC
      const alive = pingResult.alive || (!!macAddress && !lease);

      // Device fingerprinting — classify when a MAC is known
      let devType = null, devVendor = null, devRisk = 'unknown';
      if (macAddress) {
        try {
          const c = deviceClassifier.classifyDevice(macAddress, hostname || '');
          devType = c.type || null; devVendor = c.vendor || null; devRisk = c.risk_level || 'unknown';
        } catch (_) {}
      }

      if (lease) {
        status = 'dhcp';
        hostsUp++;
      } else if (alive) {
        status = 'unknown';
        hostsUp++;
        hostsUnknown++;
      } else {
        status = 'available';
      }

      await db.query(
        `INSERT INTO ipam_addresses
           (subnet_id, ip_address, status, hostname, mac_address, last_ping, ping_ms, last_seen, dhcp_lease_id, device_type, device_vendor, risk_level, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (subnet_id, ip_address) DO UPDATE SET
           status        = CASE WHEN ipam_addresses.is_reserved THEN ipam_addresses.status ELSE EXCLUDED.status END,
           hostname      = COALESCE(EXCLUDED.hostname, ipam_addresses.hostname),
           mac_address   = COALESCE(EXCLUDED.mac_address, ipam_addresses.mac_address),
           last_ping     = NOW(),
           ping_ms       = EXCLUDED.ping_ms,
           last_seen     = CASE WHEN EXCLUDED.status != 'available' THEN NOW() ELSE ipam_addresses.last_seen END,
           dhcp_lease_id = EXCLUDED.dhcp_lease_id,
           device_type   = EXCLUDED.device_type,
           device_vendor = COALESCE(EXCLUDED.device_vendor, ipam_addresses.device_vendor),
           risk_level    = EXCLUDED.risk_level,
           updated_at    = NOW()`,
        [subnetId, ip, status, hostname, macAddress, pingResult.responseTime,
         alive || lease ? new Date().toISOString() : null, lease?.id || null,
         devType, devVendor, devRisk]
      );

      // Alert on first discovery of unknown devices
      if (status === 'unknown') {
        await db.query(
          `INSERT INTO alert_events (scope_id, message, severity)
           SELECT $1, $2, 'warning'
           WHERE NOT EXISTS (
             SELECT 1 FROM alert_events
             WHERE scope_id=$1 AND message LIKE $3 AND fired_at > NOW()-INTERVAL '24 hours'
           )`,
          [network, `Unknown device at ${ip}${hostname ? ` (${hostname})` : ''} — responds to ping but has no DHCP lease`,
           `%Unknown device at ${ip}%`]
        ).catch(() => {});
      }

      processed++;
      // Log + persist progress every 25 IPs
      if (processed % 25 === 0) {
        log(`${label} — processed ${processed}/${ips.length} IPs, ${hostsUp} alive`);
        // Update live counts in DB for progress display
        await db.query(
          `UPDATE ipam_subnets SET used_hosts=$2, free_hosts=$3, unknown_hosts=$4 WHERE id=$1`,
          [subnetId, hostsUp, processed - hostsUp, hostsUnknown]
        ).catch(() => {});
        await db.query(
          `UPDATE ipam_scan_jobs SET hosts_scanned=$1, hosts_up=$2, hosts_unknown=$3,
             progress_pct=$4, updated_at=NOW() WHERE id=$5 AND status='running'`,
          [processed, hostsUp, hostsUnknown,
           Math.round((processed / ips.length) * 100), jobId]
        ).catch(() => {});
      }
    }

    const freeHosts = hostsScanned - hostsUp;
    await db.query(
      `UPDATE ipam_subnets SET
         scan_status='done', last_scanned=NOW(),
         total_hosts=$2, used_hosts=$3, free_hosts=$4, unknown_hosts=$5
       WHERE id=$1`,
      [subnetId, hostsScanned, hostsUp, freeHosts, hostsUnknown]
    );

    await db.query(
      `UPDATE ipam_scan_jobs SET status='done', completed_at=NOW(),
         hosts_scanned=$2, hosts_up=$3, hosts_unknown=$4,
         progress_pct=100, updated_at=NOW() WHERE id=$1`,
      [jobId, hostsScanned, hostsUp, hostsUnknown]
    );

    log(`${label} — DONE. Alive: ${hostsUp}/${hostsScanned}, Unknown: ${hostsUnknown}`);
    return { hostsScanned, hostsUp, hostsUnknown, freeHosts: hostsScanned - hostsUp };

  } catch (err) {
    warn(`${label} — scan error: ${err.message}`);
    await db.query(`UPDATE ipam_subnets SET scan_status='error' WHERE id=$1`, [subnetId]);
    await db.query(
      `UPDATE ipam_scan_jobs SET status='error', completed_at=NOW(), error_msg=$2 WHERE id=$1`,
      [jobId, err.message]
    );
    return {};
  }
}

/**
 * Scan all managed subnets sequentially.
 */
async function scanAllSubnets() {
  const result = await db.query(
    `SELECT id, network::text, prefix_length, name FROM ipam_subnets WHERE is_managed=TRUE ORDER BY network`
  );
  log(`Scanning ${result.rows.length} managed subnets...`);
  for (const subnet of result.rows) {
    await scanSubnet(subnet);
  }
  log('All subnet scans complete');
}

module.exports = { scanSubnet, scanAllSubnets, generateHostIPs };
