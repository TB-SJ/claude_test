'use strict';

const { config } = require('../config');

// A tiny key→JSON store over Supabase's REST (PostgREST) API. No SDK needed —
// Node's global fetch is enough. Backs a single table:
//
//   create table app_state (
//     key text primary key,
//     value jsonb not null,
//     updated_at timestamptz default now()
//   );
//
// `value` holds { data: <payload> }; for tokens the payload is the AES-encrypted
// ciphertext string, so secrets remain encrypted at rest in Supabase too.

function base() {
  return `${config.supabase.url.replace(/\/$/, '')}/rest/v1/app_state`;
}

function headers(extra = {}) {
  return {
    apikey: config.supabase.serviceKey,
    Authorization: `Bearer ${config.supabase.serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function get(key) {
  const res = await fetch(`${base()}?key=eq.${encodeURIComponent(key)}&select=value`, { headers: headers() });
  if (!res.ok) throw new Error(`Supabase get(${key}) failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rows[0].value : null;
}

async function set(key, value) {
  const res = await fetch(base(), {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase set(${key}) failed: ${res.status} ${await res.text()}`);
}

async function del(key) {
  const res = await fetch(`${base()}?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE', headers: headers() });
  if (!res.ok) throw new Error(`Supabase del(${key}) failed: ${res.status} ${await res.text()}`);
}

module.exports = { get, set, del };
