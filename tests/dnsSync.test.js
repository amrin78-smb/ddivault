'use strict';
/**
 * dnsSync.test.js — the whole Linux-DNS path, end to end, into a real database:
 * provider -> normalisation -> writers.js -> dns_zones/dns_records.
 *
 * ⛔ THIS IS THE TEST THAT MATTERS. The provider tests prove we can read a DNS
 * server; this proves the rows we write are the same rows the Windows collector
 * would have written, that the SOA gate actually prevents re-transfers, and
 * that a failure leaves the previous catalogue intact instead of emptying it.
 *
 * Needs:  tests/dnslab/lab.sh up   and   DDI_TEST_DB=<a scratch database>
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { Pool } = require('pg');

const DB_NAME = process.env.DDI_TEST_DB;
const writers = require('../collector/writers');
const { syncProtocolDns } = require('../collector/dns/sync');

const SCHEMA = `
DROP TABLE IF EXISTS dns_records, dns_zones, server_health_history, dns_query_stats, ddi_servers CASCADE;
CREATE TABLE ddi_servers (
  id SERIAL PRIMARY KEY, hostname TEXT, ip_address INET, role TEXT DEFAULT 'both',
  is_active BOOLEAN DEFAULT TRUE, last_polled TIMESTAMPTZ, agent_hub_id TEXT,
  health_score INT, health_checked_at TIMESTAMPTZ, query_ms INT,
  dns_platform TEXT DEFAULT 'windows', dns_host TEXT, dns_port INT DEFAULT 53,
  tsig_key_name TEXT, tsig_algorithm TEXT, tsig_secret TEXT,
  dns_stats_url TEXT, dns_api_url TEXT, dns_api_key TEXT, dns_api_server_id TEXT,
  dns_last_error TEXT, dns_capabilities JSONB);
CREATE TABLE dns_zones (
  id SERIAL PRIMARY KEY, server_id INT NOT NULL REFERENCES ddi_servers(id) ON DELETE CASCADE,
  zone_name TEXT NOT NULL, zone_type TEXT, is_reverse BOOLEAN DEFAULT FALSE,
  is_ds_integrated BOOLEAN DEFAULT FALSE, is_auto_created BOOLEAN DEFAULT FALSE,
  record_count INT DEFAULT 0, last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  soa_serial BIGINT, UNIQUE(server_id, zone_name));
CREATE TABLE dns_query_stats (
  id BIGSERIAL PRIMARY KEY, server_id INT, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_queries BIGINT, successful BIGINT, failed BIGINT, nxdomain_count BIGINT,
  response_time_ms INT, queries_per_sec NUMERIC(10,2),
  cumulative_total BIGINT, cumulative_success BIGINT, cumulative_nxdomain BIGINT, cumulative_failed BIGINT);
CREATE TABLE server_health_history (
  id SERIAL PRIMARY KEY, server_id INT, health_score INT, winrm_ok BOOLEAN,
  scope_count INT, lease_count INT, zone_count INT, record_count INT,
  query_ms INT, soa_in_sync BOOLEAN, ts TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE dns_records (
  id BIGSERIAL PRIMARY KEY, zone_id INT NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL, record_type TEXT NOT NULL, record_data TEXT, ttl INT,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dns_records_unique') THEN
    ALTER TABLE dns_records ADD CONSTRAINT dns_records_unique UNIQUE (zone_id, hostname, record_type, record_data);
  END IF;
END $$;`;

function reachable(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} res(v); };
    s.setTimeout(1500, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

let pool = null;
async function ready(t) {
  if (!DB_NAME) { t.skip('set DDI_TEST_DB to a scratch database'); return null; }
  if (!(await reachable(5354)) || !(await reachable(8081))) { t.skip('DNS lab not running (tests/dnslab/lab.sh up)'); return null; }
  if (!pool) {
    pool = new Pool({ host: process.env.PGHOST || '/var/run/postgresql', database: DB_NAME, max: 4 });
    await pool.query(SCHEMA);
  }
  return pool;
}
const ctx = { log: () => {}, warn: () => {} };

async function seedServer(db, over) {
  const r = await db.query(
    `INSERT INTO ddi_servers (hostname, ip_address, role, dns_platform, dns_host, dns_port,
       tsig_key_name, tsig_algorithm, tsig_secret, dns_stats_url, dns_api_url, dns_api_key, dns_api_server_id)
     VALUES ($1,$2,'both',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [over.hostname, '127.0.0.1', over.dns_platform, '127.0.0.1', over.dns_port,
     over.tsig_key_name || null, over.tsig_algorithm || null, over.tsig_secret || null,
     over.dns_stats_url || null, over.dns_api_url || null, over.dns_api_key || null, over.dns_api_server_id || null]);
  return r.rows[0];
}
const BIND = {
  hostname: 'bind-lab', dns_platform: 'bind', dns_port: 5354,
  tsig_key_name: 'ddivault', tsig_algorithm: 'hmac-sha256',
  tsig_secret: 'c3BhbnZhdWx0LXRlc3Qta2V5LWRvLW5vdC11c2U9PQ==',
  dns_stats_url: 'http://127.0.0.1:8653',
};
const PDNS = {
  hostname: 'pdns-lab', dns_platform: 'powerdns', dns_port: 5355,
  dns_api_url: 'http://127.0.0.1:8081', dns_api_key: process.env.DDI_LAB_PDNS_KEY || 'ddivault-lab-api-key',
  dns_api_server_id: 'localhost',
};

test('BIND: a full sync lands zones and records in the normal tables', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  const srv = await seedServer(db, BIND);
  const out = await syncProtocolDns(db, srv, writers, ctx);
  assert.strictEqual(out.error, null, 'no error: ' + out.error);
  assert.ok(out.zones >= 2, 'zones found: ' + out.zones);

  const z = await db.query('SELECT zone_name, zone_type, is_reverse, record_count FROM dns_zones WHERE server_id=$1 ORDER BY zone_name', [srv.id]);
  const names = z.rows.map((r) => r.zone_name);
  assert.ok(names.includes('lab.example'));
  assert.ok(!names.some((n) => /\.bind$|id\.server/.test(n)), 'no BIND pseudo-zones persisted');

  const recs = await db.query(
    `SELECT r.hostname, r.record_type, r.record_data FROM dns_records r
       JOIN dns_zones z ON z.id=r.zone_id WHERE z.server_id=$1 AND z.zone_name='lab.example' ORDER BY 1,2,3`, [srv.id]);
  assert.ok(recs.rowCount >= 9, 'records written: ' + recs.rowCount);
  const web = recs.rows.filter((r) => r.hostname === 'web' && r.record_type === 'A');
  assert.strictEqual(web.length, 2, 'round-robin A records both stored as rows');
  assert.ok(recs.rows.some((r) => r.hostname === '@' && r.record_type === 'MX'), 'apex MX stored as @');
  assert.ok(recs.rows.every((r) => r.record_type !== 'SOA'));
});

test('the SOA gate prevents a second transfer when nothing changed', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  const srv = await seedServer(db, BIND);
  const first = await syncProtocolDns(db, srv, writers, ctx);
  assert.ok(first.transferred >= 1, 'first run transfers');
  const second = await syncProtocolDns(db, srv, writers, ctx);
  // ⛔ Without this, 339 production zones would be transferred every cycle.
  assert.strictEqual(second.transferred, 0, 'second run transfers nothing');
  assert.ok(second.skipped >= 1, 'and reports them as unchanged');
  assert.strictEqual(second.records, 0);
});

test('PowerDNS: the same sync writes indistinguishable rows', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  const srv = await seedServer(db, PDNS);
  const out = await syncProtocolDns(db, srv, writers, ctx);
  assert.strictEqual(out.error, null, String(out.error));
  const recs = await db.query(
    `SELECT r.hostname, r.record_type FROM dns_records r JOIN dns_zones z ON z.id=r.zone_id
      WHERE z.server_id=$1 AND z.zone_name='pdns.example'`, [srv.id]);
  assert.ok(recs.rowCount >= 8, 'records: ' + recs.rowCount);
  assert.strictEqual(recs.rows.filter((r) => r.hostname === 'web' && r.record_type === 'A').length, 2);
});

test('capabilities are persisted, with the honest three-way answer', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  const srv = await seedServer(db, BIND);
  await syncProtocolDns(db, srv, writers, ctx);
  const r = await db.query('SELECT dns_capabilities FROM ddi_servers WHERE id=$1', [srv.id]);
  const c = r.rows[0].dns_capabilities;
  assert.strictEqual(c.records, 'supported');
  assert.strictEqual(c.scavenging, 'not_applicable', 'BIND has no scavenging — not "false"');
  assert.strictEqual(c.forwarders, 'not_available', 'BIND has forwarders we cannot read — not "none"');
});

test('an unreachable server leaves the existing catalogue intact', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  const srv = await seedServer(db, BIND);
  await syncProtocolDns(db, srv, writers, ctx);
  const before = await db.query('SELECT count(*)::int n FROM dns_records');
  assert.ok(before.rows[0].n > 0);

  // Point it at a dead port — the server is "up" as far as the row says.
  await db.query('UPDATE ddi_servers SET dns_stats_url=$1 WHERE id=$2', ['http://127.0.0.1:9', srv.id]);
  const dead = (await db.query('SELECT * FROM ddi_servers WHERE id=$1', [srv.id])).rows[0];
  const out = await syncProtocolDns(db, dead, writers, ctx);
  assert.ok(out.error, 'the failure is reported');

  // ⛔ A failed poll must never be read as "this server now has no zones".
  const after = await db.query('SELECT count(*)::int n FROM dns_records');
  assert.strictEqual(after.rows[0].n, before.rows[0].n, 'records untouched by a failed poll');
  const z = await db.query('SELECT count(*)::int n FROM dns_zones WHERE server_id=$1', [srv.id]);
  assert.ok(z.rows[0].n > 0, 'zones untouched');
  const err = await db.query('SELECT dns_last_error FROM ddi_servers WHERE id=$1', [srv.id]);
  assert.ok(err.rows[0].dns_last_error, 'and the reason is recorded on the server row');
});

// ── Milestone A: health must not be judged by a measurement that does not apply ──

test('a healthy BIND server scores healthy, not 50', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  const srv = await seedServer(db, BIND);
  await syncProtocolDns(db, srv, writers, ctx);          // give it zones to probe
  const fresh = (await db.query('SELECT * FROM ddi_servers WHERE id=$1', [srv.id])).rows[0];
  const { probeProtocolHealth } = require('../collector/dns/health');
  const h = await probeProtocolHealth(db, fresh);

  // ⛔ THE BUG THIS REPLACES: haMonitor.pollHealth starts at 100 and subtracts
  // 50 when testWinRM fails. A BIND host has no WinRM, so a server whose zones
  // we had just transferred successfully scored 50 and rendered DEGRADED.
  assert.ok(h.score >= 80, `healthy BIND should score >= 80, got ${h.score} (${h.detail})`);
  assert.strictEqual(h.reachable, true, 'DNS answered');
  assert.ok(Number.isFinite(h.query_ms), 'query time measured from the DNS query itself');
});

test('an unreachable DNS service scores badly, and says why', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  const srv = await seedServer(db, BIND);
  await syncProtocolDns(db, srv, writers, ctx);
  // Keep the zones, point the DNS service at a dead port.
  await db.query('UPDATE ddi_servers SET dns_port=9, dns_stats_url=$1 WHERE id=$2',
    ['http://127.0.0.1:9', srv.id]);
  const dead = (await db.query('SELECT * FROM ddi_servers WHERE id=$1', [srv.id])).rows[0];
  const { probeProtocolHealth } = require('../collector/dns/health');
  const h = await probeProtocolHealth(db, dead);
  assert.ok(h.score <= 50, `unreachable should score low, got ${h.score}`);
  assert.strictEqual(h.reachable, false);
  assert.match(h.detail, /DNS query: failed|management channel/, 'the reason is stated: ' + h.detail);
});

test('a brand-new server is not penalised for having no zones yet', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  const srv = await seedServer(db, BIND);          // never synced
  const { probeProtocolHealth } = require('../collector/dns/health');
  const h = await probeProtocolHealth(db, srv);
  // ⛔ No zones means "we have not collected yet", not "this server is sick".
  // Scoring it down would make every freshly added server look unhealthy for
  // its first cycle, training operators to ignore the number.
  assert.ok(h.score >= 80, `new server should not be marked unhealthy, got ${h.score} (${h.detail})`);
  assert.match(h.detail, /no known zone to probe yet/);
});

test('pollHealth records winrm_ok as NULL for a protocol platform, never false', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  await db.query('DELETE FROM server_health_history');
  const srv = await seedServer(db, BIND);
  await syncProtocolDns(db, srv, writers, ctx);
  const fresh = (await db.query('SELECT * FROM ddi_servers WHERE id=$1', [srv.id])).rows[0];
  const ha = require('../collector/haMonitor');
  await ha.pollHealth(db, null, fresh, null);   // ps/auth unused on this path

  const h = (await db.query(
    'SELECT health_score, winrm_ok, query_ms FROM server_health_history WHERE server_id=$1 ORDER BY id DESC LIMIT 1',
    [srv.id])).rows[0];
  assert.ok(h, 'a health sample was written');
  // ⛔ false would be a measurement we never made, and the DNS tab treats
  // winrm_ok === false as decisively offline.
  assert.strictEqual(h.winrm_ok, null, 'winrm_ok must be NULL, not false');
  assert.ok(h.health_score >= 80, 'scored on the protocol, not on WinRM: ' + h.health_score);

  const srvRow = (await db.query('SELECT health_score, query_ms FROM ddi_servers WHERE id=$1', [srv.id])).rows[0];
  assert.ok(srvRow.health_score >= 80);
  assert.ok(Number.isFinite(srvRow.query_ms), 'query_ms persisted from the DNS query');
});

test('the PowerShell DNS passes never receive a protocol-platform server', () => {
  // ⛔ dnsMonitor/detectStaleRecords/pollDnsSoa drive Get-DnsServer* over WinRM.
  // Handed a bind row they attempt ~8 calls per server per cycle against a host
  // with no WinRM, each waiting out PS_TIMEOUT_MS. The collector filters them
  // out; this asserts the predicate that filter depends on.
  const dnsProviders = require('../collector/dns');
  assert.strictEqual(dnsProviders.isProtocolPlatform('bind'), true);
  assert.strictEqual(dnsProviders.isProtocolPlatform('powerdns'), true);
  assert.strictEqual(dnsProviders.isProtocolPlatform('windows'), false,
    'windows MUST stay on the PowerShell path');
  assert.strictEqual(dnsProviders.isProtocolPlatform(null), false);
  assert.strictEqual(dnsProviders.isProtocolPlatform(undefined), false,
    'a row from before this feature has no platform and must behave as windows');
});

// ── Milestone C: query statistics ────────────────────────────────────────────

test('the first sample is a baseline, claiming no interval', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  await db.query('DELETE FROM dns_query_stats');
  const srv = await seedServer(db, BIND);
  await syncProtocolDns(db, srv, writers, ctx);

  const r = await db.query('SELECT * FROM dns_query_stats WHERE server_id=$1 ORDER BY id', [srv.id]);
  assert.strictEqual(r.rowCount, 1, 'one sample written');
  const row = r.rows[0];
  // ⛔ With nothing to subtract from, an interval cannot be known. NULL says
  // that; a 0 would claim the server served no queries.
  assert.strictEqual(row.total_queries, null, 'no interval on the first sample');
  assert.strictEqual(row.queries_per_sec, null);
  assert.ok(Number(row.cumulative_total) >= 0, 'but the raw reading IS stored as the baseline');
});

test('the second sample is a delta, not the running total', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  await db.query('DELETE FROM dns_query_stats');
  const srv = await seedServer(db, BIND);
  await syncProtocolDns(db, srv, writers, ctx);

  // Generate some traffic so the counter actually moves.
  const client = require('../collector/dns/client');
  for (let i = 0; i < 5; i++) {
    await client.querySoa('127.0.0.1', 5354, 'lab.example').catch(() => {});
  }
  await syncProtocolDns(db, srv, writers, ctx);

  const r = await db.query('SELECT * FROM dns_query_stats WHERE server_id=$1 ORDER BY id', [srv.id]);
  assert.strictEqual(r.rowCount, 2);
  const second = r.rows[1];
  // ⛔ Storing the cumulative figure would show a long-running server as
  // impossibly busy and the number would only ever climb.
  assert.ok(Number(second.total_queries) > 0, 'the interval counted the queries we just made');
  assert.ok(Number(second.total_queries) < Number(second.cumulative_total),
    'the interval is smaller than the running total');
  assert.ok(second.queries_per_sec != null, 'a rate was derived');
});

test('a counter reset is recorded as unknowable, not as a negative or a spike', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  await db.query('DELETE FROM dns_query_stats');
  const srv = await seedServer(db, BIND);
  const { recordQueryStats } = require('../collector/dns/stats');
  const ctxSrv = require('../collector/dns').serverContext(srv);

  await recordQueryStats(db, ctxSrv, { total_queries: 1000, successful: 900, nxdomain_count: 50, failed: 10, cumulative: true });
  await recordQueryStats(db, ctxSrv, { total_queries: 1500, successful: 1300, nxdomain_count: 70, failed: 20, cumulative: true });
  // The server restarts: counters go back to near zero.
  const reset = await recordQueryStats(db, ctxSrv, { total_queries: 12, successful: 10, nxdomain_count: 1, failed: 0, cumulative: true });

  assert.strictEqual(reset.recorded, true, 'the sample is still recorded');
  assert.match(reset.reason, /counter reset/, reset.reason);
  const rows = (await db.query('SELECT * FROM dns_query_stats WHERE server_id=$1 ORDER BY id', [srv.id])).rows;
  assert.strictEqual(rows.length, 3);
  // ⛔ 12 - 1500 is -1488. A negative query count is nonsense; so is clamping it
  // to 0 (which would claim no traffic) or treating 12 as the interval (which
  // would be a lie of a different size).
  assert.strictEqual(rows[2].total_queries, null, 'no interval claimed across the restart');
  assert.strictEqual(rows[2].queries_per_sec, null);
  assert.strictEqual(Number(rows[2].cumulative_total), 12, 'the new baseline is stored');

  // And the next sample recovers normally from the new baseline.
  const after = await recordQueryStats(db, ctxSrv, { total_queries: 60, successful: 55, nxdomain_count: 3, failed: 1, cumulative: true });
  assert.strictEqual(after.reason, 'delta');
  assert.strictEqual(after.delta.total, 48, '60 - 12, measured from the post-restart baseline');
});

test('a server whose stats channel is off still gets zones and records', async (t) => {
  const db = await ready(t); if (!db) return;
  await db.query('DELETE FROM ddi_servers');
  await db.query('DELETE FROM dns_query_stats');
  // PowerDNS reads zones AND stats through one API, so use BIND: its statistics
  // channel is separate from the zone transfer.
  const srv = await seedServer(db, BIND);
  await syncProtocolDns(db, srv, writers, ctx);           // needs the channel to list zones
  await db.query('UPDATE ddi_servers SET dns_stats_url=$1 WHERE id=$2', ['http://127.0.0.1:9', srv.id]);
  const broken = (await db.query('SELECT * FROM ddi_servers WHERE id=$1', [srv.id])).rows[0];
  const out = await syncProtocolDns(db, broken, writers, ctx);
  // The zone list comes from the same channel, so this run cannot enumerate —
  // but it must not destroy what the previous run collected.
  const recs = await db.query('SELECT count(*)::int n FROM dns_records');
  assert.ok(recs.rows[0].n > 0, 'previously collected records survive a stats-channel outage');
  assert.ok(out.error, 'and the failure is reported rather than swallowed');
});

test.after(async () => { if (pool) await pool.end(); });
