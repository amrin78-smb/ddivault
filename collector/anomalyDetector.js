/**
 * anomalyDetector.js — DDIVault behavioral & security anomaly detection.
 *
 * Pure local module. Runs a suite of independent checks against the DDIVault
 * Postgres DB and records anomalies into `anomaly_events`, with best-effort
 * email dispatch via ../api/alertDispatcher. Each check is fully isolated so
 * a failure in one never aborts the others.
 *
 * Exports: { detectAnomalies, buildBaselines }
 */

function log(m) {
  console.log('[' + new Date().toISOString() + '] [Anomaly] ' + m);
}

/**
 * recordAnomaly — dedup + insert + best-effort dispatch.
 * Dedup: skip if an un-acknowledged anomaly_events row of the same
 * anomaly_type + entity_id exists within the last 60 minutes.
 * Returns the inserted row, or null if deduped / failed.
 */
async function recordAnomaly(db, { type, severity, entityType, entityId, description, details }) {
  // Dedup check
  const dup = await db.query(
    `SELECT 1 FROM anomaly_events
       WHERE anomaly_type = $1
         AND entity_id = $2
         AND acknowledged = FALSE
         AND detected_at > NOW() - INTERVAL '60 minutes'
       LIMIT 1`,
    [type, entityId != null ? String(entityId) : null]
  );
  if (dup.rows.length > 0) {
    return null;
  }

  // Extended dedup for MAC-based anomalies: skip if an un-acknowledged anomaly
  // of the same type for the same MAC exists within the last 6 hours. Prevents
  // a roaming/short-lived device from generating repeated identical anomalies.
  const mac = details && (details.mac_address || details.mac);
  if (mac) {
    const macDup = await db.query(
      `SELECT 1 FROM anomaly_events
         WHERE anomaly_type = $1
           AND details->>'mac_address' = $2
           AND acknowledged = FALSE
           AND detected_at > NOW() - INTERVAL '6 hours'
         LIMIT 1`,
      [type, String(mac)]
    );
    if (macDup.rows.length > 0) {
      return null;
    }
  }

  const ins = await db.query(
    `INSERT INTO anomaly_events
       (detected_at, anomaly_type, severity, entity_type, entity_id, description, details, acknowledged)
     VALUES (NOW(), $1, $2, $3, $4, $5, $6::jsonb, FALSE)
     RETURNING *`,
    [
      type,
      severity,
      entityType,
      entityId != null ? String(entityId) : null,
      description,
      JSON.stringify(details || {}),
    ]
  );
  const row = ins.rows[0];

  // Best-effort email dispatch — never throw.
  try {
    const ad = require('../api/alertDispatcher');
    await ad.dispatchAlert(
      db,
      {
        id: null,
        message: description,
        severity,
        scope_id: entityType === 'scope' ? entityId : null,
        server_id: null,
        fired_at: new Date(),
      },
      type
    );
  } catch (_) {
    /* ignore dispatch failures */
  }

  return row;
}

/**
 * isRuleEnabled — honor alert_rule_config.is_enabled if a row exists.
 * Defaults to enabled (true) when no config row is present or on error.
 */
async function isRuleEnabled(db, ruleType) {
  try {
    const r = await db.query(
      `SELECT is_enabled FROM alert_rule_config WHERE rule_type = $1 LIMIT 1`,
      [ruleType]
    );
    if (r.rows.length === 0) return true;
    return r.rows[0].is_enabled !== false;
  } catch (_) {
    return true;
  }
}

/** Read an integer app setting with a default fallback. */
async function getSettingInt(db, key, def) {
  try {
    const r = await db.query(`SELECT value FROM app_settings WHERE key = $1 LIMIT 1`, [key]);
    if (r.rows.length === 0) return def;
    const n = parseInt(r.rows[0].value, 10);
    return Number.isFinite(n) ? n : def;
  } catch (_) {
    return def;
  }
}

/**
 * detectAnomalies — run all checks, each isolated in its own try/catch.
 * Returns a summary object: { <type>: count, ... }.
 */
async function detectAnomalies(db) {
  const summary = {
    lease_spike: 0,
    after_hours_device: 0,
    mac_spoofing: 0,
    subnet_jumping: 0,
    ip_conflict: 0,
    new_device_vip_subnet: 0,
    dhcp_starvation: 0,
  };

  // ---- 1. Lease spikes ----------------------------------------------------
  try {
    if (await isRuleEnabled(db, 'lease_spike')) {
      const rows = (
        await db.query(
          `SELECT s.id AS pk, s.scope_id AS scope_text, s.name, s.in_use AS current,
                  b.avg_leases, b.stddev_leases, b.sample_count
             FROM dhcp_scopes s
             JOIN device_baselines b
               ON b.scope_id = s.id
              AND b.hour_of_day = EXTRACT(HOUR FROM NOW())::int
              AND b.day_of_week = EXTRACT(DOW FROM NOW())::int
            WHERE s.in_use IS NOT NULL
              AND b.sample_count >= 5
              AND b.stddev_leases > 0`
        )
      ).rows;

      for (const r of rows) {
        const current = Number(r.current);
        const avg = Number(r.avg_leases);
        const stddev = Number(r.stddev_leases);
        if (!Number.isFinite(current) || !Number.isFinite(avg) || !Number.isFinite(stddev)) continue;

        if (current > avg + 2 * stddev) {
          const severity = current > avg + 3 * stddev ? 'critical' : 'warning';
          const res = await recordAnomaly(db, {
            type: 'lease_spike',
            severity,
            entityType: 'scope',
            entityId: r.scope_text,
            description:
              'Lease spike on scope ' +
              (r.name || r.scope_text) +
              ': ' +
              current +
              ' leases (baseline avg ' +
              avg.toFixed(1) +
              ', stddev ' +
              stddev.toFixed(1) +
              ')',
            details: {
              scope_id: r.scope_text,
              scope_name: r.name,
              current,
              avg,
              stddev,
              threshold: avg + 2 * stddev,
            },
          });
          if (res) summary.lease_spike++;
        }
      }
    }
  } catch (e) {
    log('lease_spike check failed: ' + e.message);
  }

  // ---- 2. After-hours device ----------------------------------------------
  try {
    if (await isRuleEnabled(db, 'after_hours_device')) {
      const bhStart = await getSettingInt(db, 'business_hours_start', 7);
      const bhEnd = await getSettingInt(db, 'business_hours_end', 20);

      // Compute hour/day in Bangkok time (UTC+7) regardless of the host
      // timezone — production runs in Asia/Bangkok and business hours are
      // defined in local time.
      const now = new Date();
      const hour = (now.getUTCHours() + 7) % 24;
      const dow = new Date(now.getTime() + 7 * 60 * 60 * 1000).getUTCDay(); // 0=Sun..6=Sat
      const isWeekend = dow === 0 || dow === 6;
      const inBusinessHours = !isWeekend && hour >= bhStart && hour < bhEnd;

      if (!inBusinessHours) {
        // Genuinely new devices: first_seen within last 40 min, and the same
        // MAC was NOT seen more than 30 days ago anywhere in dhcp_leases.
        const rows = (
          await db.query(
            `SELECT l.ip_address, l.mac_address, l.hostname, l.scope_id, l.first_seen
               FROM dhcp_leases l
              WHERE l.first_seen > NOW() - INTERVAL '40 minutes'
                AND NOT EXISTS (
                      SELECT 1 FROM dhcp_leases o
                       WHERE o.mac_address = l.mac_address
                         AND o.first_seen < NOW() - INTERVAL '30 days'
                    )
              ORDER BY l.first_seen DESC
              LIMIT 50`
          )
        ).rows;

        for (const r of rows) {
          const entityId = r.ip_address || r.mac_address;
          if (!entityId) continue;
          const res = await recordAnomaly(db, {
            type: 'after_hours_device',
            severity: 'warning',
            entityType: 'device',
            entityId,
            description:
              'After-hours new device: ' +
              (r.hostname || r.mac_address || r.ip_address) +
              ' (' +
              r.ip_address +
              ' / ' +
              r.mac_address +
              ')',
            details: {
              ip_address: r.ip_address,
              mac_address: r.mac_address,
              hostname: r.hostname,
              scope_id: r.scope_id,
              first_seen: r.first_seen,
            },
          });
          if (res) summary.after_hours_device++;
        }
      }
    }
  } catch (e) {
    log('after_hours_device check failed: ' + e.message);
  }

  // ---- 3. MAC spoofing ----------------------------------------------------
  try {
    if (await isRuleEnabled(db, 'mac_spoofing')) {
      const rows = (
        await db.query(
          `SELECT ip_address, COUNT(DISTINCT mac_address) c,
                  array_agg(DISTINCT mac_address) macs
             FROM dhcp_events
            WHERE event_time > NOW() - INTERVAL '30 minutes'
              AND ip_address IS NOT NULL
              AND mac_address IS NOT NULL
            GROUP BY ip_address
           HAVING COUNT(DISTINCT mac_address) >= 2`
        )
      ).rows;

      for (const r of rows) {
        const res = await recordAnomaly(db, {
          type: 'mac_spoofing',
          severity: 'critical',
          entityType: 'device',
          entityId: r.ip_address,
          description:
            'Possible MAC spoofing on ' +
            r.ip_address +
            ': ' +
            r.c +
            ' distinct MACs in 30 minutes',
          details: { ip_address: r.ip_address, mac_count: Number(r.c), macs: r.macs },
        });
        if (res) summary.mac_spoofing++;
      }
    }
  } catch (e) {
    log('mac_spoofing check failed: ' + e.message);
  }

  // ---- 4. Subnet jumping --------------------------------------------------
  // Only flag a MAC seen in 3+ distinct /24 subnets in 24h. Normal WiFi roaming
  // between two adjacent SSIDs/subnets is expected and would otherwise be noise.
  try {
    if (await isRuleEnabled(db, 'subnet_jumping')) {
      const rows = (
        await db.query(
          `SELECT mac_address,
                  COUNT(DISTINCT (
                    split_part(host(ip_address),'.',1) || '.' ||
                    split_part(host(ip_address),'.',2) || '.' ||
                    split_part(host(ip_address),'.',3)
                  )) c,
                  array_agg(DISTINCT (
                    split_part(host(ip_address),'.',1) || '.' ||
                    split_part(host(ip_address),'.',2) || '.' ||
                    split_part(host(ip_address),'.',3)
                  )) subnets
             FROM dhcp_leases
            WHERE last_seen > NOW() - INTERVAL '24 hours'
              AND mac_address IS NOT NULL
              AND ip_address IS NOT NULL
            GROUP BY mac_address
           HAVING COUNT(DISTINCT (
                    split_part(host(ip_address),'.',1) || '.' ||
                    split_part(host(ip_address),'.',2) || '.' ||
                    split_part(host(ip_address),'.',3)
                  )) >= 3`
        )
      ).rows;

      for (const r of rows) {
        const res = await recordAnomaly(db, {
          type: 'subnet_jumping',
          severity: 'warning',
          entityType: 'device',
          entityId: r.mac_address,
          description:
            'Subnet jumping: MAC ' +
            r.mac_address +
            ' seen in ' +
            r.c +
            ' distinct /24 subnets in 24h',
          details: { mac_address: r.mac_address, subnet_count: Number(r.c), subnets: r.subnets },
        });
        if (res) summary.subnet_jumping++;
      }
    }
  } catch (e) {
    log('subnet_jumping check failed: ' + e.message);
  }

  // ---- 5. IP conflict -----------------------------------------------------
  try {
    if (await isRuleEnabled(db, 'ip_conflict')) {
      const rows = (
        await db.query(
          `SELECT ip_address, COUNT(DISTINCT mac_address) c,
                  array_agg(DISTINCT mac_address) macs
             FROM dhcp_leases
            WHERE address_state IN ('Active','ActiveReservation')
              AND ip_address IS NOT NULL
              AND mac_address IS NOT NULL
            GROUP BY ip_address
           HAVING COUNT(DISTINCT mac_address) >= 2`
        )
      ).rows;

      for (const r of rows) {
        const res = await recordAnomaly(db, {
          type: 'ip_conflict',
          severity: 'critical',
          entityType: 'device',
          entityId: r.ip_address,
          description:
            'IP conflict on ' + r.ip_address + ': ' + r.c + ' distinct active MACs',
          details: { ip_address: r.ip_address, mac_count: Number(r.c), macs: r.macs },
        });
        if (res) summary.ip_conflict++;
      }
    }
  } catch (e) {
    log('ip_conflict check failed: ' + e.message);
  }

  // ---- 6. New device on sensitive subnet ----------------------------------
  try {
    if (await isRuleEnabled(db, 'new_device_vip_subnet')) {
      const rows = (
        await db.query(
          `SELECT l.ip_address, l.mac_address, l.hostname, l.first_seen,
                  s.id AS subnet_id, s.network, s.prefix_length
             FROM ipam_subnets s
             JOIN dhcp_leases l
               ON l.ip_address << (host(s.network) || '/' || s.prefix_length)::inet
            WHERE s.is_sensitive = TRUE
              AND l.first_seen > NOW() - INTERVAL '40 minutes'
            ORDER BY l.first_seen DESC
            LIMIT 100`
        )
      ).rows;

      for (const r of rows) {
        const entityId = r.ip_address || r.mac_address;
        if (!entityId) continue;
        const res = await recordAnomaly(db, {
          type: 'new_device_vip_subnet',
          severity: 'critical',
          entityType: 'device',
          entityId,
          description:
            'New device on sensitive subnet ' +
            r.network +
            '/' +
            r.prefix_length +
            ': ' +
            (r.hostname || r.mac_address || r.ip_address) +
            ' (' +
            r.ip_address +
            ')',
          details: {
            ip_address: r.ip_address,
            mac_address: r.mac_address,
            hostname: r.hostname,
            subnet_id: r.subnet_id,
            network: r.network,
            prefix_length: r.prefix_length,
            first_seen: r.first_seen,
          },
        });
        if (res) summary.new_device_vip_subnet++;
      }
    }
  } catch (e) {
    log('new_device_vip_subnet check failed: ' + e.message);
  }

  // ---- 7. DHCP starvation -------------------------------------------------
  try {
    if (await isRuleEnabled(db, 'dhcp_starvation')) {
      const rows = (
        await db.query(
          `SELECT server_id, COUNT(*) c, COUNT(DISTINCT mac_address) macs
             FROM dhcp_events
            WHERE event_id = 10
              AND event_time > NOW() - INTERVAL '1 minute'
            GROUP BY server_id
           HAVING COUNT(*) > 50 AND COUNT(DISTINCT mac_address) > 30`
        )
      ).rows;

      for (const r of rows) {
        const res = await recordAnomaly(db, {
          type: 'dhcp_starvation',
          severity: 'critical',
          entityType: 'server',
          entityId: r.server_id,
          description:
            'Possible DHCP starvation attack on server ' +
            r.server_id +
            ': ' +
            r.c +
            ' DISCOVERs from ' +
            r.macs +
            ' MACs in 1 minute',
          details: {
            server_id: r.server_id,
            discover_count: Number(r.c),
            distinct_macs: Number(r.macs),
          },
        });
        if (res) summary.dhcp_starvation++;
      }
    }
  } catch (e) {
    log('dhcp_starvation check failed: ' + e.message);
  }

  log(
    'detectAnomalies complete: ' +
      Object.entries(summary)
        .map(([k, v]) => k + '=' + v)
        .join(' ')
  );
  return summary;
}

/**
 * detectDnsAnomalies — DNS infrastructure anomaly checks, each isolated.
 * Returns a summary object of counts per check.
 */
async function detectDnsAnomalies(db) {
  const summary = {
    dns_replication_lag: 0,
    dns_forwarder_down: 0,
    dns_record_count_drop: 0,
    dns_stale_records: 0,
    dns_scavenging_disabled: 0,
  };

  // ---- 1. Replication lag (divergent SOA serials across servers) ----------
  try {
    if (await isRuleEnabled(db, 'dns_replication_lag')) {
      const rows = (
        await db.query(
          `SELECT zone_name,
                  COUNT(DISTINCT soa_serial) AS serial_count,
                  MAX(soa_serial) - MIN(soa_serial) AS serial_lag
             FROM dns_zone_sync
            WHERE checked_at > NOW() - INTERVAL '30 minutes'
            GROUP BY zone_name
           HAVING COUNT(DISTINCT soa_serial) > 1`
        )
      ).rows;

      for (const r of rows) {
        const lag = Number(r.serial_lag) || 0;
        const res = await recordAnomaly(db, {
          type: 'dns_replication_lag',
          severity: lag >= 3 ? 'critical' : 'warning',
          entityType: 'dns_zone',
          entityId: r.zone_name,
          description:
            'DNS replication lag on zone ' +
            r.zone_name +
            ': SOA serials diverge by ' +
            lag +
            ' across ' +
            r.serial_count +
            ' distinct serial(s)',
          details: {
            zone_name: r.zone_name,
            serial_count: Number(r.serial_count),
            serial_lag: lag,
          },
        });
        if (res) summary.dns_replication_lag++;
      }
    }
  } catch (e) {
    log('dns_replication_lag check failed: ' + e.message);
  }

  // ---- 2. Forwarder down --------------------------------------------------
  try {
    if (await isRuleEnabled(db, 'dns_forwarder_down')) {
      const rows = (
        await db.query(
          `SELECT server_id, forwarder_ip
             FROM dns_forwarder_health
            WHERE is_reachable = false
              AND last_checked > NOW() - INTERVAL '20 minutes'`
        )
      ).rows;

      for (const r of rows) {
        const res = await recordAnomaly(db, {
          type: 'dns_forwarder_down',
          severity: 'warning',
          entityType: 'server',
          entityId: r.server_id,
          description:
            'DNS forwarder unreachable: ' +
            r.forwarder_ip +
            ' (server ' +
            r.server_id +
            ')',
          details: { server_id: r.server_id, forwarder_ip: r.forwarder_ip },
        });
        if (res) summary.dns_forwarder_down++;
      }
    }
  } catch (e) {
    log('dns_forwarder_down check failed: ' + e.message);
  }

  // ---- 3. Record count drop (>10% vs ~24h ago) ----------------------------
  try {
    if (await isRuleEnabled(db, 'dns_record_count_drop')) {
      const rows = (
        await db.query(
          `SELECT z.id, z.zone_name, z.record_count AS current, prev.record_count AS previous
             FROM dns_zones z
             JOIN LATERAL (
                    SELECT record_count
                      FROM dns_zone_sync s
                     WHERE s.zone_name = z.zone_name
                       AND s.checked_at < NOW() - INTERVAL '20 hours'
                     ORDER BY s.checked_at DESC
                     LIMIT 1
                  ) prev ON TRUE
            WHERE z.record_count IS NOT NULL
              AND prev.record_count IS NOT NULL
              AND prev.record_count > 0
              AND z.record_count < prev.record_count * 0.9`
        )
      ).rows;

      for (const r of rows) {
        const cur = Number(r.current);
        const prev = Number(r.previous);
        const res = await recordAnomaly(db, {
          type: 'dns_record_count_drop',
          severity: 'warning',
          entityType: 'dns_zone',
          entityId: r.zone_name,
          description:
            'DNS record count drop on zone ' +
            r.zone_name +
            ': ' +
            cur +
            ' records (was ' +
            prev +
            ' ~24h ago)',
          details: { zone_id: r.id, zone_name: r.zone_name, current: cur, previous: prev },
        });
        if (res) summary.dns_record_count_drop++;
      }
    }
  } catch (e) {
    log('dns_record_count_drop check failed: ' + e.message);
  }

  // ---- 4. Excessive stale records (>50 per zone) --------------------------
  try {
    if (await isRuleEnabled(db, 'dns_stale_records')) {
      const rows = (
        await db.query(
          `SELECT z.id, z.zone_name, COUNT(*) AS c
             FROM dns_stale_records sr
             JOIN dns_zones z ON z.id = sr.zone_id
            GROUP BY z.id, z.zone_name
           HAVING COUNT(*) > 50`
        )
      ).rows;

      for (const r of rows) {
        const res = await recordAnomaly(db, {
          type: 'dns_stale_records',
          severity: 'warning',
          entityType: 'dns_zone',
          entityId: r.zone_name,
          description:
            'Excessive stale DNS records in zone ' +
            r.zone_name +
            ': ' +
            r.c +
            ' stale record(s)',
          details: { zone_id: r.id, zone_name: r.zone_name, stale_count: Number(r.c) },
        });
        if (res) summary.dns_stale_records++;
      }
    }
  } catch (e) {
    log('dns_stale_records check failed: ' + e.message);
  }

  // ---- 5. Scavenging disabled on manual forward zones ---------------------
  try {
    if (await isRuleEnabled(db, 'dns_scavenging_disabled')) {
      const rows = (
        await db.query(
          `SELECT id, zone_name
             FROM dns_zones
            WHERE is_reverse = FALSE
              AND is_auto_created = FALSE
              AND scavenging_enabled = FALSE`
        )
      ).rows;

      for (const r of rows) {
        const res = await recordAnomaly(db, {
          type: 'dns_scavenging_disabled',
          severity: 'warning',
          entityType: 'dns_zone',
          entityId: r.zone_name,
          description: 'DNS scavenging disabled on zone ' + r.zone_name,
          details: { zone_id: r.id, zone_name: r.zone_name },
        });
        if (res) summary.dns_scavenging_disabled++;
      }
    }
  } catch (e) {
    log('dns_scavenging_disabled check failed: ' + e.message);
  }

  log(
    'detectDnsAnomalies complete: ' +
      Object.entries(summary)
        .map(([k, v]) => k + '=' + v)
        .join(' ')
  );
  return summary;
}

/**
 * buildBaselines — aggregate dhcp_scope_history per scope into hour/day buckets
 * and upsert into device_baselines. Requires >= 7 days of data per scope and
 * >= 3 samples per bucket.
 * Returns { baselines: <upserted count> }.
 */
async function buildBaselines(db) {
  let upserted = 0;

  let scopes = [];
  try {
    scopes = (await db.query(`SELECT id FROM dhcp_scopes`)).rows;
  } catch (e) {
    log('buildBaselines: failed to list scopes: ' + e.message);
    return { baselines: 0 };
  }

  for (const sc of scopes) {
    try {
      // Guard: skip scope without at least 7 days of history span.
      const span = await db.query(
        `SELECT MAX(recorded_at) - MIN(recorded_at) AS span, COUNT(*) AS n
           FROM dhcp_scope_history
          WHERE scope_id = $1`,
        [sc.id]
      );
      const n = Number(span.rows[0] && span.rows[0].n) || 0;
      if (n === 0) continue;
      const spanCheck = await db.query(
        `SELECT (MAX(recorded_at) - MIN(recorded_at)) >= INTERVAL '7 days' AS ok
           FROM dhcp_scope_history
          WHERE scope_id = $1`,
        [sc.id]
      );
      if (!spanCheck.rows[0] || spanCheck.rows[0].ok !== true) continue;

      const buckets = (
        await db.query(
          `SELECT EXTRACT(HOUR FROM recorded_at)::int AS hour_of_day,
                  EXTRACT(DOW  FROM recorded_at)::int AS day_of_week,
                  AVG(in_use)        AS avg_leases,
                  STDDEV_POP(in_use) AS stddev_leases,
                  COUNT(*)           AS sample_count
             FROM dhcp_scope_history
            WHERE scope_id = $1
              AND in_use IS NOT NULL
            GROUP BY 1, 2
           HAVING COUNT(*) >= 3`,
          [sc.id]
        )
      ).rows;

      for (const b of buckets) {
        await db.query(
          `INSERT INTO device_baselines
             (scope_id, hour_of_day, day_of_week, avg_leases, stddev_leases, sample_count, calculated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (scope_id, hour_of_day, day_of_week)
           DO UPDATE SET
             avg_leases    = EXCLUDED.avg_leases,
             stddev_leases = EXCLUDED.stddev_leases,
             sample_count  = EXCLUDED.sample_count,
             calculated_at = NOW()`,
          [
            sc.id,
            b.hour_of_day,
            b.day_of_week,
            b.avg_leases != null ? Number(b.avg_leases) : 0,
            b.stddev_leases != null ? Number(b.stddev_leases) : 0,
            Number(b.sample_count),
          ]
        );
        upserted++;
      }
    } catch (e) {
      log('buildBaselines scope ' + sc.id + ' failed: ' + e.message);
    }
  }

  log('buildBaselines complete: ' + upserted + ' baseline rows upserted');
  return { baselines: upserted };
}

module.exports = { detectAnomalies, detectDnsAnomalies, buildBaselines };
