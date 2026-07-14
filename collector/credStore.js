'use strict';

/**
 * credStore.js — Secure credential storage for DDIVault
 *
 * Encrypts PS passwords using AES-256-GCM before storing in DB.
 * Key is derived from NEXTAUTH_SECRET (or DDI_CRED_SECRET) so no separate key
 * management needed.
 *
 * Stored format: "iv:authTag:ciphertext" (all hex-encoded)
 */

const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const KEY_LENGTH = 32; // bytes for AES-256

// This secret derives the AES-256-GCM key that encrypts stored DHCP/DNS server
// admin passwords (ddi_servers.ps_password) and the SMTP password
// (smtp_config.password) — a higher-value target than most secrets in this
// app. There is no safe fallback for a security-relevant secret — fail loud
// and immediate at module load rather than silently encrypting real
// credentials with a known, hardcoded literal.
if (!process.env.NEXTAUTH_SECRET && !process.env.DDI_CRED_SECRET) {
  throw new Error(
    'NEXTAUTH_SECRET (or DDI_CRED_SECRET) is not set. One of them is required ' +
    'to derive the encryption key for stored server/SMTP credentials ' +
    '(collector/credStore.js). Refusing to start with a weak fallback secret.'
  );
}
const SECRET = process.env.NEXTAUTH_SECRET || process.env.DDI_CRED_SECRET;

/**
 * Derive a 32-byte key from the secret using SHA-256.
 */
function getKey() {
  return crypto.createHash('sha256').update(SECRET).digest(); // 32 bytes
}

/**
 * Encrypt a plaintext password.
 * @param {string} plaintext
 * @returns {string} encrypted string "iv:authTag:ciphertext"
 */
function encrypt(plaintext) {
  if (!plaintext) return '';
  const key    = getKey();
  const iv     = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/**
 * Decrypt an encrypted password.
 * @param {string} encrypted  "iv:authTag:ciphertext"
 * @returns {string} plaintext password, or '' on failure
 */
function decrypt(encrypted) {
  if (!encrypted) return '';
  try {
    const [ivHex, tagHex, encHex] = encrypted.split(':');
    const key     = getKey();
    const iv      = Buffer.from(ivHex,  'hex');
    const tag     = Buffer.from(tagHex, 'hex');
    const encData = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encData), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[CredStore] Decrypt failed:', err.message);
    return '';
  }
}

/**
 * Check if a string looks like an encrypted credential (has the iv:tag:enc format).
 */
function isEncrypted(str) {
  if (!str) return false;
  const parts = str.split(':');
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32;
}

module.exports = { encrypt, decrypt, isEncrypted };
