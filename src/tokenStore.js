'use strict';

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./crypto');
const { config } = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.enc');

/**
 * Persists OAuth tokens locally, encrypted at rest with AES-256-GCM.
 *
 * The entire token document (one entry per provider) is serialized to JSON,
 * encrypted with the master key, and written to `data/tokens.enc`. This keeps
 * refresh tokens on disk so the app stays logged in across restarts without
 * ever storing them in plaintext.
 */
function readAll() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return {};
  }
  try {
    const payload = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!payload) return {};
    return JSON.parse(decrypt(payload, config.encryptionKey));
  } catch (err) {
    throw new Error(`Failed to read/decrypt token store: ${err.message}`);
  }
}

function writeAll(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = encrypt(JSON.stringify(all, null, 0), config.encryptionKey);
  // Write with restrictive permissions (owner read/write only).
  fs.writeFileSync(TOKEN_FILE, payload, { mode: 0o600 });
}

/** Returns the stored token object for a provider, or null if none. */
function getTokens(provider) {
  const all = readAll();
  return all[provider] || null;
}

/** Merges and persists tokens for a provider, stamping an updatedAt time. */
function saveTokens(provider, tokens) {
  const all = readAll();
  all[provider] = { ...(all[provider] || {}), ...tokens, updatedAt: new Date().toISOString() };
  writeAll(all);
  return all[provider];
}

/** Removes a provider's tokens (logout). */
function clearTokens(provider) {
  const all = readAll();
  delete all[provider];
  writeAll(all);
}

function hasTokens(provider) {
  return Boolean(getTokens(provider));
}

module.exports = { getTokens, saveTokens, clearTokens, hasTokens, TOKEN_FILE };
