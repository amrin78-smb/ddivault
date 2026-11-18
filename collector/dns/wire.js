'use strict';
/**
 * wire.js — DNS protocol primitives: SOA query, TSIG signing, AXFR over TCP.
 *
 * ⛔ THIS EXISTS BECAUSE DDIVault RUNS ON WINDOWS, WHERE `dig` DOES NOT EXIST.
 * Shelling out to a DNS client is the obvious implementation and it is not
 * available to us on the platform this product actually ships on. Everything
 * here is pure Node so the collector behaves identically on the Windows box a
 * customer installs on and on the Linux box we test from.
 *
 * ⛔ WHY NOT A TSIG LIBRARY. `dns-packet` carries the genuinely bug-prone part —
 * message framing, name compression and the per-type rdata codecs — but it has
 * NO TSIG support. `dnsPacket.record('TSIG')` returns a codec, which looks like
 * support and is not: it is the generic opaque-rdata fallback that `record()`
 * hands back for ANY unknown type (verified: the object it returns is identical
 * to the one for a made-up type name). So TSIG is implemented here, to RFC 8945.
 */

const net = require('net');
const crypto = require('crypto');
const dnsPacket = require('dns-packet');

// ⛔ BOUNDS ON UNTRUSTED NETWORK INPUT. A zone transfer is attacker-influenced
// data from the operator's point of view and merely large data from ours:
// production already holds 256,951 records across 339 zones, so "just read
// until the stream ends" is how one bad zone exhausts the collector's heap.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;   // one AXFR envelope
const MAX_ZONE_BYTES    = 256 * 1024 * 1024; // whole transfer
const DEFAULT_TIMEOUT_MS = 20000;

const TYPE_TSIG = 250;
const CLASS_ANY = 255;

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function u48(n) { const b = Buffer.alloc(6); b.writeUIntBE(n, 0, 6); return b; }

/**
 * A domain name in canonical wire form: lowercase, uncompressed, root-terminated.
 * ⛔ CANONICAL FORM IS LOAD-BEARING FOR TSIG, not cosmetic — the MAC is computed
 * over these bytes, so a stray trailing dot or an uppercase label produces a
 * signature the server rejects as BADSIG with no other clue what is wrong.
 */
function nameToWire(name) {
  const n = String(name == null ? '' : name).replace(/\.+$/, '').toLowerCase();
  const parts = n ? n.split('.') : [];
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'ascii');
    if (b.length === 0 || b.length > 63) throw new Error(`invalid DNS label in "${name}"`);
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  const out = Buffer.concat(bufs);
  if (out.length > 255) throw new Error(`DNS name too long: ${name}`);
  return out;
}

/** Node's crypto spells these without the dash: hmac-sha256 -> sha256. */
function hmacAlgoFor(algo) {
  const a = String(algo || '').replace(/\.+$/, '').toLowerCase();
  const map = {
    'hmac-md5.sig-alg.reg.int': 'md5',
    'hmac-sha1': 'sha1', 'hmac-sha224': 'sha224', 'hmac-sha256': 'sha256',
    'hmac-sha384': 'sha384', 'hmac-sha512': 'sha512',
  };
  const h = map[a];
  if (!h) throw new Error(`unsupported TSIG algorithm: ${algo}`);
  return h;
}
function normaliseAlgo(algo) {
  const a = String(algo || 'hmac-sha256').replace(/\.+$/, '').toLowerCase();
  return a === 'hmac-md5.sig-alg.reg.int' ? 'hmac-md5.sig-alg.reg.int.' : `${a}.`;
}

/** RFC 8945 §4.3.3 "TSIG Variables". */
function tsigVariables(keyName, algo, timeSigned, fudge, error, otherData) {
  return Buffer.concat([
    nameToWire(keyName), u16(CLASS_ANY), u32(0), nameToWire(algo),
    u48(timeSigned), u16(fudge), u16(error), u16(otherData.length), otherData,
  ]);
}

/**
 * Sign an outgoing message, returning the wire packet and the MAC we sent.
 * The MAC is needed later: the server's reply is signed over OUR mac, which is
 * what ties the response to this request rather than to a replayed one.
 */
function signMessage(msg, tsig) {
  const algo = normaliseAlgo(tsig.algorithm);
  const fudge = Number.isFinite(tsig.fudge) ? tsig.fudge : 300;
  const timeSigned = Math.floor(Date.now() / 1000);
  let secret;
  try { secret = Buffer.from(String(tsig.secret || ''), 'base64'); }
  catch { throw new Error('TSIG secret is not valid base64'); }
  if (!secret.length) throw new Error('TSIG secret is empty');

  const vars = tsigVariables(tsig.keyName, algo, timeSigned, fudge, 0, Buffer.alloc(0));
  const mac = crypto.createHmac(hmacAlgoFor(algo), secret)
    .update(Buffer.concat([msg, vars])).digest();

  const rdata = Buffer.concat([
    nameToWire(algo), u48(timeSigned), u16(fudge),
    u16(mac.length), mac, u16(msg.readUInt16BE(0)), u16(0), u16(0),
  ]);
  const rr = Buffer.concat([
    nameToWire(tsig.keyName), u16(TYPE_TSIG), u16(CLASS_ANY), u32(0),
    u16(rdata.length), rdata,
  ]);
  const packet = Buffer.concat([msg, rr]);
  // ⛔ ARCOUNT is incremented AFTER the digest is taken, never before: the MAC
  // covers the message as it stood without the TSIG RR.
  packet.writeUInt16BE(msg.readUInt16BE(10) + 1, 10);
  return { packet, mac };
}

/**
 * Split a received message into (body-without-TSIG, parsed TSIG fields).
 * Returns tsig=null when the last RR is not a TSIG.
 */
function splitTsig(msg) {
  const arcount = msg.readUInt16BE(10);
  if (arcount < 1) return { body: msg, tsig: null };

  // ⛔ DO NOT LOCATE THE TSIG BY SCANNING BACKWARDS FOR SOMETHING THAT PARSES.
  // That was the first implementation and it is subtly wrong: a key name's
  // terminating 0 byte is itself a valid (root) name, and it sits LATER in the
  // buffer than the name's real first byte — so a backwards scan matches the
  // root interpretation first and returns a TSIG whose key name is "". Every
  // other field decodes correctly, so the bug survives a smoke test and only
  // shows up as the server rejecting a signature we believe we computed over
  // the right key. Locate the RR structurally instead: dns-packet parses the
  // message, the TSIG is required to be the last additional, and its encoded
  // length is exactly name + 10 + rdlength.
  let parsed;
  try { parsed = dnsPacket.decode(msg); } catch { return { body: msg, tsig: null }; }
  const adds = parsed.additionals || [];
  const last = adds[adds.length - 1];
  if (!last) return { body: msg, tsig: null };
  const isTsig = last.type === 'TSIG' || last.type === `UNKNOWN_${TYPE_TSIG}` || last.type === TYPE_TSIG;
  if (!isTsig) return { body: msg, tsig: null };

  const keyName = String(last.name || '').replace(/\.+$/, '').toLowerCase();
  const rdata = Buffer.isBuffer(last.data) ? last.data : Buffer.alloc(0);
  const rrLen = nameToWire(keyName).length + 10 + rdata.length;
  if (rrLen > msg.length - 12) return { body: msg, tsig: null };

  let p = 0;
  const algo = readName(rdata, p); p += nameToWire(algo).length;
  if (p + 10 > rdata.length) return { body: msg, tsig: null };
  const timeSigned = rdata.readUIntBE(p, 6); p += 6;
  const fudge = rdata.readUInt16BE(p); p += 2;
  const macLen = rdata.readUInt16BE(p); p += 2;
  if (p + macLen + 6 > rdata.length) return { body: msg, tsig: null };
  const mac = rdata.subarray(p, p + macLen); p += macLen;
  const originalID = rdata.readUInt16BE(p); p += 2;
  const error = rdata.readUInt16BE(p); p += 2;
  const otherLen = rdata.readUInt16BE(p); p += 2;
  const otherData = rdata.subarray(p, p + otherLen);

  const body = Buffer.from(msg.subarray(0, msg.length - rrLen));
  body.writeUInt16BE(arcount - 1, 10);   // ARCOUNT excludes the TSIG
  body.writeUInt16BE(originalID, 0);     // and the ID the MAC was taken over
  return { body, tsig: { keyName, algorithm: algo, timeSigned, fudge, mac, originalID, error, otherData } };
}

/** Read an uncompressed name at `off`. */
function readName(buf, off) {
  const labels = [];
  let o = off;
  while (o < buf.length && buf[o] !== 0) {
    if (buf[o] & 0xc0) throw new Error('compressed name where none allowed');
    const len = buf[o];
    labels.push(buf.subarray(o + 1, o + 1 + len).toString('ascii'));
    o += len + 1;
  }
  return labels.join('.').toLowerCase();
}

/**
 * Verify one received envelope.
 *
 * ⛔ SIGNING THE REQUEST ONLY AUTHENTICATES US TO THE SERVER. Without this the
 * server never proves it holds the key, and anything on the path could hand us
 * a fabricated zone that we would write into dns_records as fact. The first
 * envelope chains over the request MAC (so a replayed capture does not verify);
 * later envelopes chain over the previous MAC with timers-only variables.
 */
function verifyEnvelope(msg, tsigKey, priorMac, isFirst) {
  const { body, tsig } = splitTsig(msg);
  if (!tsig) return { ok: true, signed: false, body, mac: priorMac };
  if (tsig.error !== 0) return { ok: false, reason: `server TSIG error ${tsig.error}`, body };

  const algo = normaliseAlgo(tsig.algorithm);
  const secret = Buffer.from(String(tsigKey.secret || ''), 'base64');
  const h = crypto.createHmac(hmacAlgoFor(algo), secret);
  if (priorMac) h.update(Buffer.concat([u16(priorMac.length), priorMac]));
  h.update(body);
  h.update(isFirst
    ? tsigVariables(tsig.keyName, algo, tsig.timeSigned, tsig.fudge, tsig.error, tsig.otherData)
    : Buffer.concat([u48(tsig.timeSigned), u16(tsig.fudge)]));
  const expect = h.digest();

  if (expect.length !== tsig.mac.length || !crypto.timingSafeEqual(expect, tsig.mac)) {
    return { ok: false, reason: 'TSIG signature mismatch (BADSIG)', body };
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - tsig.timeSigned);
  if (skew > tsig.fudge) return { ok: false, reason: `TSIG time skew ${skew}s exceeds fudge ${tsig.fudge}s`, body };
  return { ok: true, signed: true, body, mac: tsig.mac };
}

module.exports = {
  nameToWire, signMessage, splitTsig, verifyEnvelope, normaliseAlgo, hmacAlgoFor,
  MAX_MESSAGE_BYTES, MAX_ZONE_BYTES, DEFAULT_TIMEOUT_MS, u16,
};
