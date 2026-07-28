'use strict';

/**
 * ws-server.js — DDIVault WebSocket ingest server for remote data-plane agents.
 *
 * Phase 4b of the NocVault agent initiative. A remote agent (built by the
 * netvault agent module against the SAME wire contract) connects outbound to
 *   wss?://<host>:DDI_WS_PORT/   with header  Authorization: Bearer <hub JWT>
 * and takes over collection for the DDI servers assigned to it, so DDIVault can
 * monitor DHCP/DNS servers on remote/isolated LANs it cannot reach with WinRM.
 *
 * On connect the server:
 *   1. verifies the hub-signed agent JWT (HS256, NEXTAUTH_SECRET, typ==='agent',
 *      aud includes 'ddi'/'ddivault' — api/agent-identity.js, ported verbatim
 *      from SpanVault),
 *   2. cross-checks hub revocation against netvault.agents (FAIL CLOSED → 4003),
 *   3. auto-provisions/links a local ddi_agents row by hub_agent_id, marks it
 *      online, indexes the live socket by local agent id,
 *   4. pushes the agent its slice of getActiveServers() — the ddi_servers whose
 *      agent_hub_id == this agent — with ps_password DECRYPTED (credStore) so
 *      the agent has usable WinRM creds, plus the site-scoped IPAM subnets.
 *
 * Then it receives ddi_result / ddi_scan_result / heartbeat frames and routes
 * each to the SHARED collector write path (collector/writers.js) — so a scope
 * written by an agent is byte-identical to one polled centrally.
 *
 * Wire contract (PINNED — the agent module is built to this):
 *   Agent → server:
 *     { type:'ddi_result', server_id, kind, data }
 *       kind ∈ {scope_stats,scopes,leases,reservations,scope_options,
 *               dhcp_events,dns_zones,dns_records,dns_health,failover}
 *       data shapes (inner payload this server expects per kind):
 *         scope_stats  -> { stats:[...], scopes:[...] }   (scopes may instead
 *                          arrive as a separate 'scopes' frame; cached + merged)
 *         scopes       -> [...Get-DhcpServerv4Scope]      (cached for scope_stats)
 *         leases       -> [...Get-DhcpServerv4Lease]
 *         reservations -> [...Get-DhcpServerv4Reservation]
 *         dhcp_events  -> [...parsed dhcp log events]
 *         dns_zones    -> { zones:[...], recordsByZone:{ "<zone>":[...recs] } }
 *     { type:'ddi_scan_result', subnet_id, data:[ {ip,alive,ping_ms,mac_address,hostname,is_dhcp} ] }
 *     { type:'heartbeat', version, health }
 *   Server → agent:
 *     { type:'ddi_config', servers:[...], subnets:[...], settings:{...} }
 *     { type:'ddi_scan', subnet_id, cidr }
 *
 * Close codes mirror SpanVault: 4001 no token, 4003 invalid/revoked, 4000 setup error.
 * Plain JavaScript only — no TypeScript syntax. Started from api/server.js.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const { verifyHubAgentJwt } = require('./agent-identity');
const { decrypt } = require('../collector/credStore');
const writers = require('../collector/writers');

// Collection intervals advertised to agents (seconds) — mirror collector.js.
const SETTINGS = {
  scope_stats_interval_s: 300,   // INTERVAL_SCOPE_STATS
  leases_interval_s:      900,   // INTERVAL_LEASE_SYNC
  reservations_interval_s: 900,
  dns_interval_s:         3600,  // INTERVAL_DNS_SYNC
  dhcp_events_interval_s: 60,    // INTERVAL_LOG_TAIL — key name MUST match the agent
                                 // DDI module's reader (dhcp_events_interval_s); a
                                 // mismatch silently drops the configured cadence.
  heartbeat_interval_s:   30,
};

// DDIVault DB (read/write) — own pool so this module is self-contained.
const ddi = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DDI_DB_NAME || 'ddivault',
  user:     process.env.DDI_DB_USER || 'ddivault_user',
  password: process.env.DDI_DB_PASS || '',
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30000,
});
ddi.on('error', (err) => console.error('[WS DB] Pool error:', err.message));

// NetVault DB (read-only) — hub revocation cross-check at connect. Uses the
// SAME cross-DB credentials as api/server.js's netvaultDb (DDI_DB_USER over the
// netvault database) so no new grant target is introduced; ddivault_user needs
// SELECT on netvault.agents (see installer note in the ws-server report).
const nv = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.DDI_DB_USER      || 'ddivault_user',
  password: process.env.DDI_DB_PASS      || '',
  ssl: false,
  max: 3,
  idleTimeoutMillis: 30000,
});
nv.on('error', (err) => console.error('[WS DB nv] Pool error:', err.message));

// local ddi_agents.id (integer) → live WebSocket connection.
const connectedAgents = new Map();
// local ddi_agents.id → hub_agent_id (to resolve owned servers on messages).
const agentHubId = new Map();
// server_id → last scope config array (merged into a scope_stats frame that
// arrives without its own scopes payload).
const scopeCache = new Map();

function getBearerToken(req) {
  const auth = req.headers && req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

// Build + send the config snapshot for an agent (its assigned servers + subnets).
async function pushConfigToAgent(ws, hubAgentId) {
  if (!ws || ws.readyState !== 1) return; // 1 === WebSocket.OPEN
  try {
    const srv = await ddi.query(
      `SELECT id, hostname, ip_address::text AS ip_address, role, auth_mode,
              ps_username, ps_password, winrm_port, winrm_https, site_id
         FROM ddi_servers
        WHERE agent_hub_id = $1 AND is_active = TRUE ORDER BY id`,
      [hubAgentId]
    );
    const servers = srv.rows.map((r) => ({
      server_id:   r.id,
      hostname:    r.hostname,
      ip_address:  r.ip_address,
      role:        r.role,
      auth_mode:   r.auth_mode || 'kerberos',
      ps_username: r.ps_username || null,
      ps_password: r.ps_password ? decrypt(r.ps_password) : null, // DECRYPTED for the agent
      winrm_port:  r.winrm_port || 5985,
      winrm_https: r.winrm_https || false,
    }));

    // IPAM subnets the agent should be able to scan: those in the same site(s)
    // as its assigned servers (there is no per-subnet agent column). If the
    // agent's servers carry no site_id, no subnets are pushed (scan on demand).
    const siteIds = [...new Set(srv.rows.map((r) => r.site_id).filter((s) => s != null))];
    let subnets = [];
    if (siteIds.length) {
      const sub = await ddi.query(
        `SELECT id AS subnet_id, (network::text || '/' || prefix_length) AS cidr
           FROM ipam_subnets WHERE site_id = ANY($1::int[]) ORDER BY id`,
        [siteIds]
      );
      subnets = sub.rows;
    }

    ws.send(JSON.stringify({ type: 'ddi_config', servers, subnets, settings: SETTINGS }));
    console.log(`[WS] Pushed ddi_config to agent hub=${hubAgentId}: ${servers.length} server(s), ${subnets.length} subnet(s)`);
  } catch (err) {
    console.error('[WS] pushConfigToAgent error:', err.message);
  }
}

// Re-push config to a connected agent by hub id after an assignment change.
// Returns true if the agent was online to receive it.
async function reconfigureAgent(hubAgentId) {
  if (!hubAgentId) return false;
  for (const [localId, hid] of agentHubId.entries()) {
    if (hid === hubAgentId) {
      const ws = connectedAgents.get(localId);
      if (ws) { await pushConfigToAgent(ws, hubAgentId); return true; }
    }
  }
  return false;
}

// Look up the ddi_servers row for a result, SCOPED to this agent's ownership so
// an agent can never write to a server it does not own. Returns null if absent.
async function ownedServer(hubAgentId, serverId) {
  const r = await ddi.query(
    `SELECT id, hostname, ip_address::text AS ip_address, role
       FROM ddi_servers WHERE id = $1 AND agent_hub_id = $2`,
    [serverId, hubAgentId]
  );
  return r.rows[0] || null;
}

async function handleResult(hubAgentId, msg) {
  const server = await ownedServer(hubAgentId, msg.server_id);
  if (!server) {
    console.warn(`[WS] ddi_result for server ${msg.server_id} not owned by agent ${hubAgentId} — ignored`);
    return;
  }
  const data = msg.data;
  const ctx = {}; // agent path: default console loggers, no getGateway
  switch (msg.kind) {
    case 'scopes':
      // Config-only frame — cache for the next scope_stats that omits scopes.
      scopeCache.set(server.id, Array.isArray(data) ? data : (data && data.scopes) || []);
      break;
    case 'scope_stats': {
      let stats = [], scopes = [];
      if (Array.isArray(data)) { stats = data; }
      else if (data) { stats = data.stats || []; scopes = data.scopes || []; }
      if (!scopes.length && scopeCache.has(server.id)) scopes = scopeCache.get(server.id);
      await writers.writeScopeStats(ddi, server, { stats, scopes }, ctx);
      break;
    }
    case 'leases':
      await writers.writeLeases(ddi, server, Array.isArray(data) ? data : (data && data.leases) || [], ctx);
      break;
    case 'reservations':
      await writers.writeReservations(ddi, server, Array.isArray(data) ? data : (data && data.reservations) || [], ctx);
      break;
    case 'dhcp_events':
      await writers.writeDhcpEvents(ddi, server, Array.isArray(data) ? data : (data && data.events) || [], ctx);
      break;
    case 'dns_zones':
      await writers.writeDnsZones(ddi, server, {
        zones: (data && data.zones) || [],
        recordsByZone: (data && data.recordsByZone) || {},
      }, ctx);
      break;
    case 'dns_records':
      // DNS records are persisted inside a dns_zones frame (recordsByZone). A
      // standalone dns_records frame carrying zones is folded in; otherwise it
      // is accepted but not written (needs zone metadata to resolve zone_id).
      if (data && data.zones) {
        await writers.writeDnsZones(ddi, server, {
          zones: data.zones, recordsByZone: data.recordsByZone || {},
        }, ctx);
      } else {
        console.log(`[WS] dns_records frame for server ${server.id} without zones — send DNS under kind='dns_zones' with recordsByZone`);
      }
      break;
    case 'scope_options':
    case 'dns_health':
    case 'failover':
      // Accepted for forward-compat; DDIVault Phase 4b does not yet persist
      // these agent-side (central dnsMonitor/haMonitor cover local servers).
      break;
    default:
      console.warn(`[WS] Unknown ddi_result kind '${msg.kind}' from agent ${hubAgentId}`);
      break;
  }
}

async function handleScanResult(hubAgentId, msg) {
  if (msg.subnet_id == null) return;
  // FAIL CLOSED (mirrors ownedServer/handleResult): subnets have no agent_hub_id,
  // so ownership is resolved through SITE — accept a subnet_id only if its site is
  // one of the sites of the ddi_servers this agent owns (exactly the subnet set
  // pushConfigToAgent advertised). Without this scoping an authenticated agent
  // could write scan data + fire "unknown device" alerts for ANY subnet in the
  // instance (cross-tenant IPAM write).
  const s = await ddi.query(
    `SELECT id, network::text AS network, prefix_length, name
       FROM ipam_subnets
      WHERE id = $1
        AND site_id = ANY(
          SELECT DISTINCT site_id FROM ddi_servers
           WHERE agent_hub_id = $2 AND site_id IS NOT NULL
        )`,
    [msg.subnet_id, hubAgentId]
  );
  if (!s.rows[0]) {
    console.warn(`[WS] ddi_scan_result for subnet ${msg.subnet_id} not owned by agent ${hubAgentId} — ignored`);
    return;
  }
  const results = Array.isArray(msg.data) ? msg.data : (msg.data && msg.data.results) || [];
  await writers.writeScanResult(ddi, s.rows[0], results, {});
}

async function handleAgentMessage(hubAgentId, localId, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'heartbeat':
      await ddi.query(
        `UPDATE ddi_agents SET last_seen_at=NOW(), status='online', version=$2 WHERE id=$1`,
        [localId, msg.version || null]
      );
      break;
    case 'ddi_result':
      await handleResult(hubAgentId, msg);
      break;
    case 'ddi_scan_result':
      await handleScanResult(hubAgentId, msg);
      break;
    default:
      break;
  }
}

function startWsServer(port) {
  // Optional TLS: terminate wss:// here when a cert+key are configured, else
  // plain ws:// (trusted LAN / behind a TLS-terminating proxy). The channel is
  // JWT-authed and carries DECRYPTED WinRM creds in ddi_config, so wss:// is
  // strongly recommended in production.
  let wss;
  const certPath = process.env.DDI_WS_TLS_CERT;
  const keyPath  = process.env.DDI_WS_TLS_KEY;
  const hasTls = !!(certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath));
  // Cap inbound frame size — ws defaults to 100MB, which lets one authenticated
  // (or half-authenticated) socket buffer huge payloads. Agent frames are small.
  const MAX_PAYLOAD = parseInt(process.env.DDI_WS_MAX_PAYLOAD || String(8 * 1024 * 1024), 10);
  if (hasTls) {
    const httpsServer = require('https').createServer({
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
    });
    wss = new WebSocketServer({ server: httpsServer, maxPayload: MAX_PAYLOAD });
    httpsServer.listen(port, '0.0.0.0');
    console.log('[WS] TLS enabled (DDI_WS_TLS_CERT/KEY configured)');
  } else {
    // Cleartext guard: binding a NON-loopback interface with no TLS pushes
    // DECRYPTED WinRM passwords over plain ws://. Refuse to start unless the
    // operator has consciously opted into cleartext on a trusted segment via
    // DDI_WS_ALLOW_PLAINTEXT=1. (Loopback-only binds are always allowed.)
    const bindHost = process.env.DDI_WS_HOST || '0.0.0.0';
    const isLoopback = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
    const allowPlaintext = process.env.DDI_WS_ALLOW_PLAINTEXT === '1';
    if (!isLoopback && !allowPlaintext) {
      throw new Error(
        `[WS] REFUSING TO START: no TLS (DDI_WS_TLS_CERT/KEY) and binding non-loopback ` +
        `interface ${bindHost}:${port}. The ddi_config frame carries DECRYPTED WinRM ` +
        `passwords in cleartext over plain ws://. Configure TLS, OR set ` +
        `DDI_WS_ALLOW_PLAINTEXT=1 to consciously accept cleartext creds on a trusted segment.`
      );
    }
    wss = new WebSocketServer({ port, host: bindHost, maxPayload: MAX_PAYLOAD });
    console.warn(
      `[WS] WARNING: TLS is NOT configured — agent connections are plain ws:// on ${bindHost}:${port}. ` +
      `The ddi_config frame carries DECRYPTED WinRM passwords; set DDI_WS_TLS_CERT and ` +
      `DDI_WS_TLS_KEY to enable wss:// and protect them in transit.`
    );
  }

  wss.on('connection', async (ws, req) => {
    let localId = null;
    let hubId = null;
    try {
      // ── Verify the hub-signed agent JWT (local crypto, no DB) ──
      const bearer = getBearerToken(req);
      if (!bearer) { ws.close(4001, 'No token'); return; }
      const claims = verifyHubAgentJwt(bearer);
      const aud = claims ? claims.modules.map((m) => String(m).toLowerCase()) : [];
      const isDdiJwt = !!claims && (aud.indexOf('ddi') !== -1 || aud.indexOf('ddivault') !== -1);
      if (!isDdiJwt) { ws.close(4003, 'Invalid token'); return; }

      // ── Hub revocation cross-check — FAIL CLOSED on absent/any error ──
      try {
        const rev = await nv.query(
          'SELECT 1 FROM agents WHERE id = $1 AND revoked_at IS NULL', [claims.agentId]);
        if (!rev.rows[0]) { ws.close(4003, 'Agent revoked'); return; }
      } catch (e) {
        console.error(`[WS] JWT revocation check failed (NetVault DB) for ${claims.agentId}: ${e.message}`);
        ws.close(4003, 'Agent revoked');
        return;
      }

      // ── Auto-provision / link the local ddi_agents row by hub_agent_id ──
      const prov = await ddi.query(
        `INSERT INTO ddi_agents (hub_agent_id, name, status, last_seen_at)
           VALUES ($1, $1, 'online', NOW())
         ON CONFLICT (hub_agent_id) DO UPDATE SET status='online', last_seen_at=NOW()
         RETURNING *`,
        [claims.agentId]
      );
      const agent = prov.rows[0];
      localId = agent.id;
      hubId = claims.agentId;

      connectedAgents.set(localId, ws);
      agentHubId.set(localId, hubId);
      console.log(`[WS] Agent authenticated via hub JWT: ${agent.name} (#${localId}, hub=${hubId})`);

      await pushConfigToAgent(ws, hubId);
    } catch (err) {
      console.error('[WS] Connection setup error:', err.message);
      try { ws.close(4000, 'Setup error'); } catch (_e) { /* ignore */ }
      return;
    }

    // Very simple per-connection message-rate guard: allow a burst, then cap the
    // sustained rate. A well-behaved agent sends a handful of frames per interval.
    const RATE_MAX = parseInt(process.env.DDI_WS_MSG_RATE || '120', 10); // msgs / window
    const RATE_WINDOW_MS = 10000;
    let rateCount = 0;
    let rateWindowStart = Date.now();
    ws.on('message', async (raw) => {
      const now = Date.now();
      if (now - rateWindowStart >= RATE_WINDOW_MS) { rateWindowStart = now; rateCount = 0; }
      if (++rateCount > RATE_MAX) {
        console.warn(`[WS] Agent #${localId} (hub=${hubId}) exceeded message rate (${RATE_MAX}/${RATE_WINDOW_MS}ms) — closing`);
        try { ws.close(4008, 'Rate limit exceeded'); } catch (_e) { /* ignore */ }
        return;
      }
      try {
        const msg = JSON.parse(raw);
        await handleAgentMessage(hubId, localId, msg);
      } catch (e) { console.error('[WS] Message error:', e.message); }
    });

    ws.on('close', async () => {
      // If the agent already reconnected on a newer socket, don't evict it.
      if (connectedAgents.get(localId) !== ws) return;
      connectedAgents.delete(localId);
      agentHubId.delete(localId);
      try {
        await ddi.query(`UPDATE ddi_agents SET status='offline' WHERE id=$1`, [localId]);
      } catch (e) { console.error('[WS] Close handler error:', e.message); }
      console.log(`[WS] Agent disconnected: #${localId} (hub=${hubId})`);
    });

    ws.on('error', (err) => console.error('[WS] Socket error:', err.message));
  });

  wss.on('error', (err) => console.error('[WS] Server error:', err.message));

  // Heartbeat monitor — mark agents offline if silent for 90s.
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 90000).toISOString();
      const stale = await ddi.query(
        `SELECT id, hub_agent_id, name FROM ddi_agents
          WHERE status='online' AND (last_seen_at IS NULL OR last_seen_at < $1)`,
        [cutoff]
      );
      for (const row of stale.rows) {
        // Only flip a row that has no live socket (a busy agent that hasn't sent
        // a heartbeat but is still connected keeps its socket in the map).
        if (connectedAgents.has(row.id)) continue;
        await ddi.query(`UPDATE ddi_agents SET status='offline' WHERE id=$1`, [row.id]);

        // Visibility: an offline agent's assigned servers are collected by NOBODY
        // (the central collector skips agent_hub_id-owned servers, and the dead
        // agent can't collect either). Mark them 'stale' and fire ONE alert so the
        // blind spot is visible. Idempotent: the monitor only selects rows still
        // status='online', so each online->offline transition fires at most once
        // per agent; the alert_events NOT EXISTS guard covers rapid flap.
        try {
          const owned = await ddi.query(
            `SELECT id FROM ddi_servers WHERE agent_hub_id = $1`, [row.hub_agent_id]);
          if (owned.rows.length) {
            await ddi.query(
              `UPDATE ddi_servers SET poll_status='stale', updated_at=NOW()
                 WHERE agent_hub_id = $1 AND poll_status IS DISTINCT FROM 'stale'`,
              [row.hub_agent_id]
            );
            const label = row.name || row.hub_agent_id;
            await ddi.query(
              `INSERT INTO alert_events (message, severity)
               SELECT $1, 'warning'
                WHERE NOT EXISTS (
                  SELECT 1 FROM alert_events
                   WHERE message LIKE $2 AND fired_at > NOW()-INTERVAL '24 hours'
                )`,
              [
                `Remote agent "${label}" is offline — ${owned.rows.length} assigned DDI server(s) are no longer being collected`,
                `Remote agent "${label}" is offline%`,
              ]
            );
            console.warn(`[WS] Agent #${row.id} (hub=${row.hub_agent_id}) offline with ${owned.rows.length} assigned server(s) — alerted, servers marked stale`);
          }
        } catch (inner) {
          console.error('[WS] Heartbeat offline-alert error:', inner.message);
        }
      }
    } catch (err) {
      console.error('[WS] Heartbeat monitor error:', err.message);
    }
  }, 30000);

  console.log(`DDIVault WebSocket ingest server listening on port ${port} (all interfaces)`);
  return { wss, connectedAgents };
}

module.exports = { startWsServer, reconfigureAgent, pushConfigToAgent, connectedAgents };
