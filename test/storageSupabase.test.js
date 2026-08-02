'use strict';

// Turn on Supabase mode BEFORE requiring config/stores.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.TOKEN_ENCRYPTION_KEY = '0'.repeat(64); // 32-byte hex, for encrypt/decrypt

const { test } = require('node:test');
const assert = require('node:assert');

// In-memory stand-in for the Supabase REST KV.
const kv = require('../src/storage/supabaseKv');
const backing = new Map();
kv.get = async (k) => (backing.has(k) ? backing.get(k) : null);
kv.set = async (k, v) => { backing.set(k, v); };
kv.del = async (k) => { backing.delete(k); };

const { decrypt } = require('../src/crypto');
const tokenStore = require('../src/tokenStore');
const taskStore = require('../src/taskStore');

test('tokenStore (Supabase mode) persists encrypted, reads from cache', async () => {
  await tokenStore.init();
  tokenStore.saveTokens('google', { access_token: 'a', refresh_token: 'b' });
  await tokenStore.flush();

  // Stored value is ciphertext, not plaintext.
  const row = backing.get('tokens');
  assert.ok(row && typeof row.data === 'string');
  assert.ok(!row.data.includes('refresh_token'), 'tokens must be encrypted at rest');

  // Decrypts back to the original document.
  const doc = JSON.parse(decrypt(row.data, process.env.TOKEN_ENCRYPTION_KEY));
  assert.equal(doc.google.access_token, 'a');

  // Reads are served synchronously from the in-memory cache.
  assert.equal(tokenStore.getTokens('google').refresh_token, 'b');
  assert.equal(tokenStore.hasTokens('google'), true);

  tokenStore.clearTokens('google');
  await tokenStore.flush();
  assert.equal(tokenStore.getTokens('google'), null);
});

test('tokenStore.init tolerates undecryptable saved tokens (wrong key) without crashing', async () => {
  backing.set('tokens', { data: 'not-valid-ciphertext-for-this-key' });
  await assert.doesNotReject(() => tokenStore.init());
  assert.equal(tokenStore.getTokens('google'), null); // starts disconnected, not a crash
});

test('taskStore (Supabase mode) round-trips through the KV', async () => {
  await taskStore.init();
  const t = taskStore.add({ title: 'Draft budget', estimatedMinutes: 45, priority: 'high' });
  await taskStore.flush();

  assert.deepEqual(backing.get('tasks').data.map((x) => x.title), ['Draft budget']);
  assert.equal(taskStore.list()[0].title, 'Draft budget');

  taskStore.update(t.id, { done: true });
  await taskStore.flush();
  assert.equal(backing.get('tasks').data[0].done, true);

  taskStore.remove(t.id);
  await taskStore.flush();
  assert.equal(backing.get('tasks').data.length, 0);
});
