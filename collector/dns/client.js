'use strict';
/**
 * client.js — the two network operations every Linux DNS platform shares:
 * a cheap SOA probe and a full zone transfer.
 *
 * ⛔ THE SOA PROBE IS WHY THIS SCALES. Production holds 339 zones / 256,951
 * records. Transferring every zone on every cycle would move ~hundreds of MB to
 * learn that nothing changed. `dns_zones.soa_serial` already exists in the
 * schema, and a zone's serial is REQUIRED to change when its contents do — so
 * the steady state is 339 single-packet SOA queries and zero transfers, and a
 * transfer happens only for the zones that actually moved.
 */

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const dnsPacket = require('dns-packet');
const W = require('./wire');

function nextId() { return crypto.randomInt(1, 65535); }

/**
 * SOA over UDP, falling back to TCP on truncation or timeout.
 * Returns { serial, primary, email, refresh, retry, expire, minimum } or throws.
 */
async function querySoa(host, port, zone, { timeoutMs = 5000 } = {}) {
  const q = { id: nextId(), type: 'query', flags: dnsPacket.RECURSION_DESIRED & 0, questions: [{ type: 'SOA', name: zone }] };
  let answer;
  try { answer = await udpQuery(host, port, q, timeoutMs); }
  catch (e) { answer = await tcpQuery(host, port, q, timeoutMs); }
  const soa = (answer.answers || []).find((a) => a.type === 'SOA')
    || (answer.authorities || []).find((a) => a.type === 'SOA');
  if (!soa) throw new Error(`no SOA in response for ${zone}`);
  const d = soa.data || {};
  return {
    serial: Number(d.serial) || null,
    primary: d.mname || null,
    email: d.rname || null,
    refresh: Number(d.refresh) || null,
    retry: Number(d.retry) || null,
    expire: Number(d.expire) || null,
    minimum: Number(d.minimum) || null,
    ttl: Number(soa.ttl) || null,
  };
}

function udpQuery(host, port, q, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const buf = dnsPacket.encode(q);
    let settled = false;
    const finish = (err, val) => {
      if (settled) return; settled = true;
      clearTimeout(timer); try { sock.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('UDP timeout')), timeoutMs);
    sock.on('message', (msg) => {
      let d; try { d = dnsPacket.decode(msg); } catch (e) { return finish(new Error('decode: ' + e.message)); }
      if (d.id !== q.id) return;                    // not ours — keep waiting
      if (d.flag_tc) return finish(new Error('truncated'));
      finish(null, d);
    });
    sock.on('error', (e) => finish(e));
    sock.send(buf, port, host, (e) => { if (e) finish(e); });
  });
}

function tcpQuery(host, port, q, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const buf = dnsPacket.encode(q);
    let acc = Buffer.alloc(0); let settled = false;
    const finish = (err, val) => {
      if (settled) return; settled = true;
      try { sock.destroy(); } catch { /* already gone */ }
      err ? reject(err) : resolve(val);
    };
    sock.setTimeout(timeoutMs, () => finish(new Error('TCP timeout')));
    sock.on('connect', () => sock.write(Buffer.concat([W.u16(buf.length), buf])));
    sock.on('data', (c) => {
      acc = Buffer.concat([acc, c]);
      if (acc.length < 2) return;
      const len = acc.readUInt16BE(0);
      if (len > W.MAX_MESSAGE_BYTES) return finish(new Error('oversized DNS message'));
      if (acc.length < 2 + len) return;
      let d; try { d = dnsPacket.decode(acc.subarray(2, 2 + len)); }
      catch (e) { return finish(new Error('decode: ' + e.message)); }
      finish(null, d);
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('closed before a reply')));
  });
}

/**
 * Full zone transfer. TCP only — AXFR has no UDP form.
 *
 * @param {object} opts {host, port, zone, tsig?, timeoutMs?, maxRecords?}
 * @returns {Promise<{records: Array, signed: boolean, bytes: number}>}
 */
function axfr({ host, port, zone, tsig = null, timeoutMs = W.DEFAULT_TIMEOUT_MS, maxRecords = 500000 }) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    let msg = dnsPacket.encode({ id, type: 'query', flags: 0, questions: [{ type: 'AXFR', name: zone }] });
    let sentMac = null;
    if (tsig) { const s = W.signMessage(msg, tsig); msg = s.packet; sentMac = s.mac; }

    const sock = net.connect({ host, port });
    const records = [];
    let acc = Buffer.alloc(0);
    let soaSeen = 0, envelopes = 0, bytes = 0, signedAny = false, finished = false, settled = false;
    let priorMac = sentMac;

    const finish = (err, val) => {
      if (settled) return; settled = true;
      try { sock.destroy(); } catch { /* already gone */ }
      err ? reject(err) : resolve(val);
    };
    sock.setTimeout(timeoutMs, () => finish(new Error(`AXFR timeout after ${timeoutMs}ms`)));
    sock.on('connect', () => sock.write(Buffer.concat([W.u16(msg.length), msg])));

    sock.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > W.MAX_ZONE_BYTES) return finish(new Error(`zone transfer exceeded ${W.MAX_ZONE_BYTES} bytes`));
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 2) {
        const len = acc.readUInt16BE(0);
        if (len > W.MAX_MESSAGE_BYTES) return finish(new Error('oversized AXFR envelope'));
        if (acc.length < 2 + len) return;
        const raw = acc.subarray(2, 2 + len);
        acc = acc.subarray(2 + len);
        envelopes++;

        let body = raw;
        if (tsig) {
          const v = W.verifyEnvelope(raw, tsig, priorMac, envelopes === 1);
          if (!v.ok) return finish(new Error(`AXFR verification failed: ${v.reason}`));
          if (v.signed) { signedAny = true; priorMac = v.mac; }
          body = v.body;
        }

        let d; try { d = dnsPacket.decode(body); }
        catch (e) { return finish(new Error('AXFR decode: ' + e.message)); }
        if (d.rcode && d.rcode !== 'NOERROR') return finish(new Error(`AXFR refused: ${d.rcode}`));

        for (const a of d.answers || []) {
          if (a.type === 'SOA') soaSeen++;
          if (records.length >= maxRecords) return finish(new Error(`zone exceeded ${maxRecords} records`));
          records.push(a);
        }
        // The zone ends with a second copy of the SOA.
        if (soaSeen >= 2) { finished = true; return finish(null, { records, signed: signedAny, bytes, envelopes }); }
      }
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => {
      if (!finished) finish(new Error(`AXFR closed early (${records.length} records, ${soaSeen} SOA)`));
    });
  });
}

module.exports = { querySoa, axfr, udpQuery, tcpQuery };
