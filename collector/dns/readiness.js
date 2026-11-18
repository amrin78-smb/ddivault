'use strict';
/**
 * readiness.js — "Test Connection" for a protocol-collected DNS server.
 *
 * ⛔ A BOOLEAN IS NOT A USEFUL ANSWER HERE. The Windows path can get away with
 * ok/not-ok because there is one thing to check: does WinRM answer. A BIND
 * server needs THREE independent things configured, by hand, in named.conf —
 * the service reachable on the right port, a statistics-channel we are allowed
 * to query, and `allow-transfer` keyed to a TSIG secret that matches ours. Any
 * one of them missing produces a different fix, and "Test failed" sends the
 * operator to look at all three.
 *
 * So every check reports what it tried, what happened, and the literal
 * configuration that would fix it. The point is that the person adding the
 * server can finish the job without reading our documentation.
 */

const { providerFor } = require('./index');
const client = require('./client');

function check(name, ok, detail, fix) {
  return { name, ok, detail: detail || null, fix: ok ? null : (fix || null) };
}

/** Did we get far enough to say the server is usable at all? */
function summarise(checks) {
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) return { ok: true, summary: 'All checks passed' };
  // ⛔ Report the FIRST failure, not the count. The checks are ordered by
  // dependency: a statistics channel cannot be reached if the host is
  // unreachable, so "3 checks failed" is one problem reported three times.
  return { ok: false, summary: failed[0].detail || `${failed[0].name} failed` };
}

async function checkBind(server) {
  const checks = [];
  const keyName = server.tsig_key_name || 'ddivault';

  // 1. Statistics channel — this is also how we enumerate zones.
  let zones = null;
  try {
    const t = await providerFor('bind').testConnection(server);
    if (t.ok) {
      checks.push(check('Statistics channel', true, `BIND ${t.version || ''}`.trim()));
      zones = await providerFor('bind').listZones(server);
      checks.push(check('Zone list', true, `${zones.length} zone(s) visible`));
    } else {
      checks.push(check('Statistics channel', false, t.detail,
        `statistics-channels { inet 0.0.0.0 port 8653 allow { <this server's IP>; }; };`));
    }
  } catch (e) {
    checks.push(check('Statistics channel', false, e.message,
      `statistics-channels { inet 0.0.0.0 port 8653 allow { <this server's IP>; }; };`));
  }

  // 2. Does the DNS service itself answer?
  const probeZone = zones && zones.find((z) => !z.is_reverse);
  if (probeZone) {
    const t0 = Date.now();
    try {
      const soa = await client.querySoa(server.dns_host, server.dns_port || 53, probeZone.zone_name, { timeoutMs: 5000 });
      checks.push(check('DNS query', true, `SOA for ${probeZone.zone_name} in ${Date.now() - t0}ms (serial ${soa.serial})`));
    } catch (e) {
      checks.push(check('DNS query', false, `${probeZone.zone_name}: ${e.message}`,
        `Check the DNS service is listening on ${server.dns_host}:${server.dns_port || 53} and reachable from this server.`));
    }

    // 3. Zone transfer — the one that actually gets us records.
    try {
      const r = await client.axfr({
        host: server.dns_host, port: server.dns_port || 53, zone: probeZone.zone_name,
        tsig: server.tsig_key_name && server.tsig_secret
          ? { keyName: server.tsig_key_name, algorithm: server.tsig_algorithm || 'hmac-sha256', secret: server.tsig_secret }
          : null,
        timeoutMs: 15000,
      });
      checks.push(check('Zone transfer (AXFR)', true,
        `${r.records.length} records from ${probeZone.zone_name}` +
        (r.signed ? ', TSIG verified' : ' — NOT TSIG-signed (IP allow-list)')));
      if (!r.signed) {
        // Not a failure: an IP allow-list is a legitimate configuration. But it
        // is worth saying out loud that nothing authenticates the data.
        checks.push(check('TSIG', true,
          'Transfer is permitted without a key. Nothing authenticates the zone contents; a TSIG key is recommended.'));
      }
    } catch (e) {
      const refused = /REFUSED|NOTAUTH|verification failed|BADSIG/i.test(e.message);
      checks.push(check('Zone transfer (AXFR)', false, e.message, refused
        ? `key "${keyName}" {\n    algorithm ${server.tsig_algorithm || 'hmac-sha256'};\n    secret "<the secret configured in DDIVault>";\n};\n\nzone "${probeZone.zone_name}" {\n    // ...\n    allow-transfer { key "${keyName}"; };\n};`
        : `Check TCP ${server.dns_port || 53} is reachable — AXFR is TCP-only.`));
    }
  } else if (checks.every((c) => c.ok)) {
    checks.push(check('Zone list', false, 'No forward zones reported by this server',
      'DDIVault reads zones from the statistics channel. A server with only reverse zones, or none, has nothing to collect.'));
  }

  return checks;
}

async function checkPowerDns(server) {
  const checks = [];
  const p = providerFor('powerdns');

  let zones = null;
  try {
    const t = await p.testConnection(server);
    if (t.ok) {
      checks.push(check('API', true, t.detail));
    } else {
      // ⛔ A rejected key and an unreachable host are different problems with
      // different fixes; the provider already distinguishes them.
      const keyProblem = /API key/i.test(t.detail || '');
      checks.push(check('API', false, t.detail, keyProblem
        ? 'The API key was rejected. Check api-key= in pdns.conf matches the key stored here.'
        : `Enable the API in pdns.conf:\n  api=yes\n  api-key=<a long random string>\n  webserver=yes\n  webserver-address=0.0.0.0\n  webserver-allow-from=<this server's IP>`));
    }
  } catch (e) {
    checks.push(check('API', false, e.message, 'Check the API URL and that pdns is listening on it.'));
  }

  if (checks[0] && checks[0].ok) {
    try {
      zones = await p.listZones(server);
      checks.push(check('Zone list', true, `${zones.length} zone(s) visible`));
    } catch (e) {
      checks.push(check('Zone list', false, e.message, 'The API answered but the zone list could not be read.'));
    }
  }

  const probeZone = zones && zones.find((z) => !z.is_reverse);
  if (probeZone) {
    const t0 = Date.now();
    try {
      const soa = await client.querySoa(server.dns_host, server.dns_port || 53, probeZone.zone_name, { timeoutMs: 5000 });
      checks.push(check('DNS query', true, `SOA for ${probeZone.zone_name} in ${Date.now() - t0}ms (serial ${soa.serial})`));
    } catch (e) {
      checks.push(check('DNS query', false, `${probeZone.zone_name}: ${e.message}`,
        `Check the DNS service is listening on ${server.dns_host}:${server.dns_port || 53}.`));
    }
    try {
      const r = await p.getZoneRecords(server, probeZone.zone_name);
      checks.push(check('Records', true, `${r.records.length} records readable from ${probeZone.zone_name}`));
    } catch (e) {
      checks.push(check('Records', false, e.message, 'The zone list worked but records could not be read.'));
    }
  }

  return checks;
}

/**
 * Knot, NSD and anything else that speaks AXFR but cannot be asked for its zone
 * list remotely. The checks mirror BIND's minus the statistics channel, because
 * that is precisely the difference between the two platforms.
 */
async function checkGeneric(server) {
  const checks = [];
  const provider = providerFor('generic');
  const names = provider.parseZoneList(server.dns_zone_list);

  if (!names.length) {
    checks.push(check('Zone list', false,
      'No zones configured, and this platform cannot be asked for them',
      'Enter the zone names this server is authoritative for, one per line. Knot and NSD\n' +
      'expose no remote way to enumerate them (Knot\'s control socket is local-only and\n' +
      'NSD\'s needs client certificates), so DDIVault has to be told.'));
    return checks;
  }
  checks.push(check('Zone list', true, `${names.length} zone(s) configured`));

  let answered = 0;
  const silent = [];
  for (const n of names) {
    try {
      const soa = await client.querySoa(server.dns_host, server.dns_port || 53, n, { timeoutMs: 5000 });
      answered++;
      if (answered === 1) checks.push(check('DNS query', true, `SOA for ${n} (serial ${soa.serial})`));
    } catch (e) {
      silent.push(`${n}: ${e.message}`);
    }
  }
  if (!answered) {
    checks.push(check('DNS query', false, silent.join('; '),
      `No configured zone answered. Check the name is spelt correctly and that the service is\nlistening on ${server.dns_host}:${server.dns_port || 53}.`));
    return checks;
  }
  if (silent.length) {
    // ⛔ Named individually: the likeliest cause is a typo in the list, and
    // "some zones failed" does not tell anyone which to correct.
    checks.push(check('Configured zones', false, silent.join('; '),
      'These zone names are configured here but the server does not answer for them. Check for\na typo, or remove them from the list.'));
  }

  const probe = names.find((n) => !/\.(in-addr|ip6)\.arpa$/i.test(n)) || names[0];
  try {
    const r = await client.axfr({
      host: server.dns_host, port: server.dns_port || 53, zone: probe,
      tsig: server.tsig_key_name && server.tsig_secret
        ? { keyName: server.tsig_key_name, algorithm: server.tsig_algorithm || 'hmac-sha256', secret: server.tsig_secret }
        : null,
      timeoutMs: 15000,
    });
    checks.push(check('Zone transfer (AXFR)', true,
      `${r.records.length} records from ${probe}` + (r.signed ? ', TSIG verified' : ' — NOT TSIG-signed (IP allow-list)')));
  } catch (e) {
    const key = server.tsig_key_name || 'ddivault';
    checks.push(check('Zone transfer (AXFR)', false, e.message,
      `The server must allow a zone transfer to this host. For Knot:\n\n` +
      `key:\n  - id: ${key}\n    algorithm: ${server.tsig_algorithm || 'hmac-sha256'}\n    secret: <the secret configured in DDIVault>\n\n` +
      `acl:\n  - id: xfr-ddivault\n    key: ${key}\n    action: transfer\n\n` +
      `zone:\n  - domain: ${probe}\n    acl: xfr-ddivault\n\n` +
      `For NSD, add a provide-xfr: entry with the same key to the zone's stanza.`));
  }
  return checks;
}

/**
 * @returns {Promise<{ok, summary, platform, checks: Array}>}
 */
async function testProtocolServer(server) {
  const platform = String(server.dns_platform || '').toLowerCase();
  if (!server.dns_host) {
    return { ok: false, platform, summary: 'No DNS host or IP is configured for this server',
      checks: [check('Configuration', false, 'dns_host is empty', 'Set the DNS host/IP on the server.')] };
  }
  let checks;
  try {
    checks = platform === 'bind' ? await checkBind(server)
      : platform === 'powerdns' ? await checkPowerDns(server)
      : platform === 'generic' ? await checkGeneric(server)
      : [check('Platform', false, `No readiness check for platform "${platform}"`, null)];
  } catch (e) {
    checks = [check('Readiness check', false, e.message, null)];
  }
  return { platform, checks, ...summarise(checks) };
}

module.exports = { testProtocolServer, checkBind, checkPowerDns, checkGeneric };
