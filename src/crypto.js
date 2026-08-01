'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM
const KEY_LENGTH = 32; // 256-bit key

/**
 * Parses the hex-encoded master key from configuration into a 32-byte buffer.
 * Throws a clear error if the key is missing or malformed so failures surface
 * at write/read time rather than as opaque crypto errors.
 */
function loadKey(hexKey) {
  if (!hexKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY is not set — cannot encrypt/decrypt tokens.');
  }
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be a ${KEY_LENGTH}-byte hex string (got ${key.length} bytes).`
    );
  }
  return key;
}

/**
 * Encrypts a UTF-8 string and returns a self-describing payload:
 *   base64(iv) : base64(authTag) : base64(ciphertext)
 */
function encrypt(plaintext, hexKey) {
  const key = loadKey(hexKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':');
}

/**
 * Reverses `encrypt`. Throws if the payload is malformed or the auth tag fails
 * verification (i.e. the ciphertext or key was tampered with).
 */
function decrypt(payload, hexKey) {
  const key = loadKey(hexKey);
  const parts = String(payload).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload.');
  }
  const [iv, authTag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
