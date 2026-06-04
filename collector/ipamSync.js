'use strict';

/**
 * ipamSync.js — derive IPAM subnets/supernets from discovered DHCP scopes.
 * Shared by the collector (per-poll) and the API (manual trigger).
 * Pure DB logic — no PowerShell. Callers resolve the gateway and pass it via getGateway.
 */

// "255.255.255.0" -> 24
function maskToPrefixLength(mask) {
  return mask.split('.').reduce((acc, octet) => {
    return acc + parseInt(octet).toString(2).split('1').length - 1;
  }, 0);
}

// Derive the parent supernet (network + prefix) for a given subnet.
//  /25–/30 -> .0/24 ; /24 -> .0.0/16 ; /17–/23 -> .0.0/16 ; /16 -> .0.0.0/8 ; </16 -> /8
function deriveSupernet(network, prefix) {
  const o = network.split('.').map(n => parseInt(n) || 0);
  if (prefix >= 25 && prefix <= 30) return { network: `${o[0]}.${o[1]}.${o[2]}.0`, prefix: 24 };
  if (prefix === 24)                return { network: `${o[0]}.${o[1]}.0.0`,        prefix: 16 };
  if (prefix >= 17 && prefix <= 23) return { network: `${o[0]}.${o[1]}.0.0`,        prefix: 16 };
  if (prefix === 16)                return { network: `${o[0]}.0.0.0`,              prefix: 8  };
  if (prefix < 16)                  return { network: `${o[0]}.0.0.0`,              prefix: 8  };
  return { network: `${o[0]}.${o[1]}.0.0`, prefix: 16 };
}

const isIpv4 = s => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(String(s || '').trim())
  && String(s).split('.').every(x => +x >= 0 && +x <= 255);

/**
 * @param db   pg Pool/Client
 * @param scopes  Array<{ scopeId: string, subnetMask: string, name?: string }>
 * @param opts  { log?: (msg)=>void, getGateway?: async (scopeId)=>string|null }
 *              getGateway is awaited ONLY for subnets that don't already exist.
 * @returns { created, updated, supernetsCreated }
 */
async function syncScopesToIpam(db, scopes, opts = {}) {
  const log = opts.log || (() => {});
  const getGateway = opts.getGateway || null;
  let created = 0, updated = 0, supernetsCreated = 0;

  for (const sc of (scopes || [])) {
    try {
      const network = String(sc.scopeId || '').trim();
      const mask    = String(sc.subnetMask || '').trim();
      if (!isIpv4(network) || !isIpv4(mask)) continue;
      const prefix = maskToPrefixLength(mask);
      if (!prefix || prefix < 1 || prefix > 32) continue;

      // Does the subnet already exist?
      const existing = await db.query(
        'SELECT id, supernet_id FROM ipam_subnets WHERE network=$1 AND prefix_length=$2 LIMIT 1',
        [network, prefix]
      );

      // Ensure the parent supernet exists.
      const sup = deriveSupernet(network, prefix);
      let supernetId = null;
      const supIns = await db.query(
        `INSERT INTO ipam_supernets (network, prefix_length, name, description)
         VALUES ($1, $2, $3, 'Auto-created from DHCP scope discovery')
         ON CONFLICT (network, prefix_length) DO NOTHING
         RETURNING id`,
        [sup.network, sup.prefix, `${sup.network}/${sup.prefix}`]
      );
      if (supIns.rows.length) { supernetId = supIns.rows[0].id; supernetsCreated++; }
      else {
        const supSel = await db.query(
          'SELECT id FROM ipam_supernets WHERE network=$1 AND prefix_length=$2 LIMIT 1',
          [sup.network, sup.prefix]
        );
        supernetId = supSel.rows[0] ? supSel.rows[0].id : null;
      }

      if (existing.rows.length) {
        // Existing subnet: only refresh name + is_managed. NEVER touch site_id/gateway/supernet.
        await db.query(
          `UPDATE ipam_subnets SET name = COALESCE(name, $2), is_managed = true, updated_at = NOW()
           WHERE id = $1`,
          [existing.rows[0].id, sc.name || null]
        );
        updated++;
      } else {
        // New subnet — resolve gateway (DHCP option 3) lazily, only for new rows.
        let gateway = null;
        if (getGateway) {
          try { const g = await getGateway(network); if (isIpv4(g)) gateway = g; } catch (_) {}
        }

        await db.query(
          `INSERT INTO ipam_subnets
             (network, prefix_length, name, gateway, supernet_id, description, is_managed)
           VALUES ($1, $2, $3, $4, $5, 'Auto-synced from DHCP scope', true)
           ON CONFLICT (network, prefix_length) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, ipam_subnets.name),
             is_managed = true`,
          [network, prefix, sc.name || `${network}/${prefix}`, gateway, supernetId]
        );
        created++;
        log(`[IPAM Sync] Created subnet ${network}/${prefix} → supernet ${sup.network}/${sup.prefix}`);
      }

      // Sync utilization from the matching DHCP scope (scope_id == network address).
      const scope = await db.query(
        `SELECT in_use, free, total_ips, percent_used FROM dhcp_scopes WHERE scope_id = $1 LIMIT 1`,
        [network]
      );
      if (scope.rows.length) {
        const s = scope.rows[0];
        await db.query(
          `UPDATE ipam_subnets SET used_hosts = $1, free_hosts = $2, total_hosts = $3, updated_at = NOW()
           WHERE network = $4::inet AND prefix_length = $5`,
          [s.in_use, s.free, s.total_ips, network, prefix]
        );
      }
    } catch (err) {
      log(`[IPAM Sync] Error on scope ${sc && sc.scopeId}: ${err.message}`);
    }
  }
  return { created, updated, supernetsCreated };
}

module.exports = { maskToPrefixLength, deriveSupernet, syncScopesToIpam };
