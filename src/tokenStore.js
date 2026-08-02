'use strict';

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./crypto');
const { config, providerConfigured } = require('./config');
const logger = require('./logger');
const kv = require('./storage/supabaseKv');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.enc');
const KV_KEY = 'tokens';

/**
 * Persists OAuth tokens encrypted at rest with AES-256-GCM.
 *
 * Two backends, chosen by config:
 *  - Local file `data/tokens.enc` (default; fine for local dev).
 *  - Supabase, when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (for hosts with
 *    an ephemeral disk). The ciphertext is what's stored — the encryption key
 *    never leaves the app's environment.
 *
 * In Supabase mode the decrypted document is cached in memory (loaded once by
 * `init()` at startup) so reads stay synchronous for the OAuth client callbacks;
 * writes update the cache immediately and persist in the background (`flush()`
 * awaits the last write for the login path).
 */
const useSupabase = () => providerConfigured.supabase();

let cache = null; // in-memory decrypted document (Supabase mode)
let pending = Promise.resolve();

// --- File backend (synchronous, durable) -----------------------------------
function readFile() {
  if (!fs.existsSync(TOKEN_FILE)) return {};
  try {
    const payload = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!payload) return {};
    return JSON.parse(decrypt(payload, config.encryptionKey));
  } catch (err) {
    throw new Error(`Failed to read/decrypt token store: ${err.message}`);
  }
}
function writeFile(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = encrypt(JSON.stringify(all, null, 0), config.encryptionKey);
  fs.writeFileSync(TOKEN_FILE, payload, { mode: 0o600 });
}

// --- Unified accessors ------------------------------------------------------
/** Loads the Supabase-backed cache once at startup. No-op in file mode. */
async function init() {
  if (!useSupabase()) return;
  // A reachability error (bad URL/key, missing GRANT, network) throws here and
  // SHOULD fail startup — the app can't persist without storage.
  const v = await kv.get(KV_KEY);
  if (!v || !v.data) {
    cache = {};
    return;
  }
  // But if the saved tokens are present yet unreadable (usually a
  // TOKEN_ENCRYPTION_KEY that doesn't match the one that saved them), don't take
  // the whole app down — start with none and let the user reconnect.
  try {
    cache = JSON.parse(decrypt(v.data, config.encryptionKey));
  } catch (err) {
    cache = {};
    logger.error(
      'tokenStore: saved tokens could not be decrypted — TOKEN_ENCRYPTION_KEY likely does not match the one used when they were saved. Starting disconnected; reconnect your calendar to re-save under the current key.',
      { message: err.message }
    );
  }
}

function currentAll() {
  if (useSupabase()) {
    if (cache === null) cache = {};
    return cache;
  }
  return readFile();
}

function persist(all) {
  if (useSupabase()) {
    cache = all;
    const ciphertext = encrypt(JSON.stringify(all), config.encryptionKey);
    pending = pending
      .then(() => kv.set(KV_KEY, { data: ciphertext }))
      .catch((err) => logger.error('tokenStore: Supabase write failed', { message: err.message }));
    return;
  }
  writeFile(all);
}

/** Returns the stored token object for a provider, or null if none. */
function getTokens(provider) {
  return currentAll()[provider] || null;
}

/** Merges and persists tokens for a provider, stamping an updatedAt time. */
function saveTokens(provider, tokens) {
  const all = currentAll();
  all[provider] = { ...(all[provider] || {}), ...tokens, updatedAt: new Date().toISOString() };
  persist(all);
  return all[provider];
}

/** Removes a provider's tokens (logout). */
function clearTokens(provider) {
  const all = currentAll();
  delete all[provider];
  persist(all);
}

function hasTokens(provider) {
  return Boolean(getTokens(provider));
}

/** Awaits the last background write (Supabase mode); no-op in file mode. */
async function flush() {
  await pending;
}

module.exports = { init, getTokens, saveTokens, clearTokens, hasTokens, flush, TOKEN_FILE };
