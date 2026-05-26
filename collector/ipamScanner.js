'use strict';

/**
 * ipamScanner.js — Network scanner for DDIVault IPAM Phase B
 *
 * Uses PowerShell Test-Connection (ping) to sweep subnets.
 * Correlates results with DHCP leases to classify each IP:
 *   available — no ping, no lease
 *   dhcp      — has active DHCP lease (ping may or may not respond)
 *   unknown   — ping responds but no DHCP lease (unmanaged/rogue device)
 *   reserved  — manually reserved (skip scanning)
 *
 * Runs as on-demand scan triggered by API, or scheduled every 4 hours.
 */

const { execSync } = require('child_process');
const { Pool }     = require('pg');

const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DDI_DB_NAME || 'ddivault',
  user:     process.env.DDI_DB_USER || 'ddivault_user',
  password: process.env.DDI_DB_PASS || '',
  max: 3,
});

const PS_TIMEOUT = parseInt(process.env.PS_TIMEOUT_MS || '60000');

function log(msg)  { console.log(`[${new Date().toISOString()}] [Scanner] ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toISOString()}] [Scanner] WARN: ${msg}`); }

/**
 * Generate all host IPs in a subnet (excluding network and broadcast).
 * @param {string} network     e.g. "192.168.1.0"
 * @param {number} prefix      e.g. 24
 * @returns {string[]}         array of IP strings
 */
function generateHostIPs(network, prefix) {
  if (prefix < 16 || prefix > 30) {
    warn(`Prefix /${prefix} too large to scan safely — skipping`);
    return [];
  }

  const parts = network.split('.').map(Number);
  const hostCount = Math.pow(2, 32 - prefix) - 2; // exclude network + broadcast

  if (hostCount > 1022) {
    warn(`Subnet ${network}/${prefix} has ${hostCount} hosts — limiting scan to /22 max`);
    return [];
  }

  const ips = [];
  // Convert base IP to 32-bit int
  let base = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  base = base & (~0 << (32 - prefix)); // mask to network address

  for (let i = 1; i <= hostCount; i++) {
    const ip = base + i;
    const a = (ip >>> 24) & 0xff;
    const b = (ip >>> 16) & 0xff;
    const c = (ip >>> 8)  & 0xff;
    const d =  ip         & 0xff;
    ips.push(`${a}.${b}.${c}.${d}`);
  }

  return ips;
}

/**
 * Ping sweep a list of IPs using PowerShell Test-Connection.
 * Returns a Map of ip -> { alive: bool, responseTime: number|null }
 *
 * Uses parallel jobs for speed (up to 50 concurrent pings).
 */
function pingSweep(ips) {
  if (!ips.length) return new Map();

  const results = new Map();

  // Build PowerShell parallel ping command
  // Split into batches of 50 for parallel execution
  const BATCH = 50;
  const batches = [];
  for (let i = 0; i < ips.length; i += BATCH) {
    batches.push(ips.slice(i, i + BATCH));
  }

  for (const batch of batches) {
    const ipList = batch.map(ip => `'${ip}'`).join(',');
    const script = `
$ips = @(${ipList})
$results = $ips | ForEach-Object -Parallel {
  $ip = $_
  $ping = Test-Connection -ComputerName $ip -Count 1 -TimeoutSeconds 1 -ErrorAction SilentlyContinue
  if ($ping) {
    [PSCustomObject]@{ IP=$ip; Alive=$true; ResponseTime=$ping.Latency }
  } else {
    [PSCustomObject]@{ IP=$ip; Alive=$false; ResponseTime=$null }
  }
} -ThrottleLimit 50
$results | ConvertTo-Json -Compress
`;

    try {
      const raw = execSync(
        `powershell.exe -NonInteractive -NoProfile -Command "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        { encoding: 'utf8', timeout: PS_TIMEOUT }
      ).trim();

      if (!raw) continue;

      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];

      for (const r of arr) {
        results.set(r.IP, {
          alive:        r.Alive === true,
          responseTime: r.ResponseTime ? parseInt(r.ResponseTime) : null,
        });
      }
    } catch (err) {
      // PowerShell -Parallel requires PS7 — fallback to sequential
      warn(`Parallel ping failed (requires PowerShell 7), falling back to sequential: ${err.message.slice(0, 80)}`);

      for (const ip of batch) {
        try {
          const seq = execSync(
            `powershell.exe -NonInteractive -NoProfile -Command "` +
            `$p = Test-Connection -ComputerName '${ip}' -Count 1 -TimeoutSeconds 1 -ErrorAction SilentlyContinue; ` +
            `if ($p) { Write-Output ('alive:' + $p.Latency) } else { Write-Output 'dead' }"`,
            { encoding: 'utf8', timeout: 5000 }
          ).trim();

          if (seq.startsWith('alive:')) {
            const ms = parseInt(seq.split(':')[1]) || 0;
            results.set(ip, { alive: true, responseTime: ms });
          } else {
            results.set(ip, { alive: false, responseTime: null });
          }
        } catch (_) {
          results.set(ip, { alive: false, responseTime: null });
        }
      }
    }
  }

  return results;
}

/**
 * Get active DHCP leases for a subnet from the DB.
 * Returns a Map of ip -> { hostname, mac_address, address_state }
 */
async function getDhcpLeasesForSubnet(network, prefix) {
  try {
    const result = await db.query(
      `SELECT ip_address::text, hostname, mac_address, address_state
       FROM dhcp_leases
       WHERE ip_address << ($1 || '/' || $2)::inet
         AND address_state = 'Active'`,
      [network, prefix]
    );
    const map = new Map();
    for (const row of result.rows) {
      map.set(row.ip_address, row);
    }
    return map;
  } catch (err) {
    warn(`Cannot fetch DHCP leases: ${err.message}`);
    return new Map();
  }
}

/**
 * Scan a single subnet and update ipam_addresses table.
 * @param {object} subnet  — row from ipam_subnets
 * @returns {object}       — scan summary
 */
async function scanSubnet(subnet) {
  const { id: subnetId, network, prefix_length: prefix, name } = subnet;
  const label = `${network}/${prefix}${name ? ` (${name})` : ''}`;

  log(`Starting scan: ${label}`);

  // Create scan job record
  const jobRes = await db.query(
    `INSERT INTO ipam_scan_jobs (subnet_id, status) VALUES ($1, 'running') RETURNING id`,
    [subnetId]
  );
  const jobId = jobRes.rows[0].id;

  // Mark subnet as scanning
  await db.query(
    `UPDATE ipam_subnets SET scan_status='scanning', last_scanned=NOW() WHERE id=$1`,
    [subnetId]
  );

  let hostsScanned = 0;
  let hostsUp      = 0;
  let hostsUnknown = 0;
  let summary      = {};

  try {
    const ips      = generateHostIPs(network, parseInt(prefix));
    const leaseMap = await getDhcpLeasesForSubnet(network, prefix);

    if (!ips.length) {
      throw new Error(`Cannot scan ${label} — subnet too large or invalid prefix`);
    }

    log(`${label} — scanning ${ips.length} hosts...`);
    const pingResults = pingSweep(ips);
    hostsScanned = ips.length;

    // Get reserved IPs (skip their ping status)
    const reservedRes = await db.query(
      `SELECT ip_address::text FROM ipam_addresses WHERE subnet_id=$1 AND is_reserved=TRUE`,
      [subnetId]
    );
    const reservedSet = new Set(reservedRes.rows.map(r => r.ip_address));

    // Process each IP
    for (const ip of ips) {
      if (reservedSet.has(ip)) continue; // don't overwrite reserved entries

      const ping  = pingResults.get(ip) || { alive: false, responseTime: null };
      const lease = leaseMap.get(ip);

      let status;
      if (lease) {
        status = 'dhcp';         // has DHCP lease — regardless of ping
        hostsUp++;
      } else if (ping.alive) {
        status = 'unknown';      // ping responds but no DHCP = unmanaged device
        hostsUp++;
        hostsUnknown++;
      } else {
        status = 'available';    // no ping, no lease
      }

      // Upsert into ipam_addresses
      await db.query(
        `INSERT INTO ipam_addresses
           (subnet_id, ip_address, status, hostname, mac_address, last_ping, ping_ms,
            last_seen, dhcp_lease_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, NOW())
         ON CONFLICT (subnet_id, ip_address) DO UPDATE SET
           status       = CASE WHEN ipam_addresses.is_reserved THEN ipam_addresses.status ELSE EXCLUDED.status END,
           hostname     = COALESCE(EXCLUDED.hostname, ipam_addresses.hostname),
           mac_address  = COALESCE(EXCLUDED.mac_address, ipam_addresses.mac_address),
           last_ping    = NOW(),
           ping_ms      = EXCLUDED.ping_ms,
           last_seen    = CASE WHEN EXCLUDED.status != 'available' THEN NOW() ELSE ipam_addresses.last_seen END,
           dhcp_lease_id = EXCLUDED.dhcp_lease_id,
           updated_at   = NOW()`,
        [
          subnetId,
          ip,
          status,
          lease?.hostname    || null,
          lease?.mac_address || null,
          ping.responseTime,
          ping.alive || lease ? new Date().toISOString() : null,
          lease?.id || null,
        ]
      );

      // Audit unknown devices (first discovery)
      if (status === 'unknown') {
        const existing = await db.query(
          `SELECT id, status FROM ipam_addresses WHERE subnet_id=$1 AND ip_address=$2`,
          [subnetId, ip]
        );
        if (!existing.rows.length || existing.rows[0].status !== 'unknown') {
          await db.query(
            `INSERT INTO ipam_audit (ip_address, subnet_id, action, new_status, notes)
             VALUES ($1, $2, 'discovered', 'unknown', 'Responds to ping but has no DHCP lease')`,
            [ip, subnetId]
          ).catch(() => {});

          // Fire alert for unknown device
          await db.query(
            `INSERT INTO alert_events (scope_id, message, severity)
             VALUES ($1, $2, 'warning')`,
            [network, `Unknown device detected at ${ip} — responds to ping but has no DHCP lease`]
          ).catch(() => {});
        }
      }
    }

    // Update subnet counters
    const freeHosts    = hostsScanned - hostsUp;
    summary = { hostsScanned, hostsUp, hostsUnknown, freeHosts };

    await db.query(
      `UPDATE ipam_subnets SET
         scan_status='done', last_scanned=NOW(),
         total_hosts=$2, used_hosts=$3, free_hosts=$4, unknown_hosts=$5
       WHERE id=$1`,
      [subnetId, hostsScanned, hostsUp, freeHosts, hostsUnknown]
    );

    await db.query(
      `UPDATE ipam_scan_jobs SET
         status='done', completed_at=NOW(),
         hosts_scanned=$2, hosts_up=$3, hosts_unknown=$4
       WHERE id=$1`,
      [jobId, hostsScanned, hostsUp, hostsUnknown]
    );

    log(`${label} — done. Up: ${hostsUp}/${hostsScanned}, Unknown: ${hostsUnknown}`);

  } catch (err) {
    warn(`${label} — scan error: ${err.message}`);
    await db.query(
      `UPDATE ipam_subnets SET scan_status='error' WHERE id=$1`, [subnetId]
    );
    await db.query(
      `UPDATE ipam_scan_jobs SET status='error', completed_at=NOW(), error_msg=$2 WHERE id=$1`,
      [jobId, err.message]
    );
  }

  return summary;
}

/**
 * Scan all managed subnets.
 */
async function scanAllSubnets() {
  const result = await db.query(
    `SELECT id, network::text, prefix_length, name
     FROM ipam_subnets
     WHERE is_managed = TRUE
     ORDER BY network`
  );

  log(`Scanning ${result.rows.length} managed subnets...`);
  for (const subnet of result.rows) {
    await scanSubnet(subnet);
  }
  log('All subnet scans complete');
}

module.exports = { scanSubnet, scanAllSubnets, generateHostIPs, pingSweep };
