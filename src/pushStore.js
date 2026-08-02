'use strict';

const fs = require('fs');
const path = require('path');
const { providerConfigured } = require('./config');
const kv = require('./storage/supabaseKv');

// Push subscriptions + notification state. Persisted in Supabase when
// configured (so they survive redeploys), else a local file. Unlike the token
// store these are only touched by async routes (subscribe, cron), so the API is
// async — no in-memory cache needed.
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'push.json');
const KV_KEY = 'push';

const useSupabase = () => providerConfigured.supabase();

const EMPTY = { subscriptions: [], tzOffsetMinutes: 0, state: { lastBriefDate: null, remindedDay: null, reminded: {} } };

async function load() {
  if (useSupabase()) {
    const v = await kv.get(KV_KEY);
    return normalize(v);
  }
  if (!fs.existsSync(FILE)) return { ...EMPTY, state: { ...EMPTY.state, reminded: {} } };
  try {
    return normalize(JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}'));
  } catch (_) {
    return { ...EMPTY, state: { ...EMPTY.state, reminded: {} } };
  }
}

function normalize(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  return {
    subscriptions: Array.isArray(d.subscriptions) ? d.subscriptions : [],
    tzOffsetMinutes: Number.isFinite(d.tzOffsetMinutes) ? d.tzOffsetMinutes : 0,
    state: {
      lastBriefDate: (d.state && d.state.lastBriefDate) || null,
      remindedDay: (d.state && d.state.remindedDay) || null,
      reminded: (d.state && d.state.reminded && typeof d.state.reminded === 'object') ? d.state.reminded : {},
    },
  };
}

async function save(doc) {
  const clean = normalize(doc);
  if (useSupabase()) {
    await kv.set(KV_KEY, clean);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
}

/** Adds/updates a subscription (deduped by endpoint) and records the tz. */
async function addSubscription(subscription, tzOffsetMinutes) {
  const doc = await load();
  doc.subscriptions = doc.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
  doc.subscriptions.push(subscription);
  if (Number.isFinite(tzOffsetMinutes)) doc.tzOffsetMinutes = tzOffsetMinutes;
  await save(doc);
  return doc;
}

async function removeSubscription(endpoint) {
  const doc = await load();
  doc.subscriptions = doc.subscriptions.filter((s) => s.endpoint !== endpoint);
  await save(doc);
  return doc;
}

module.exports = { load, save, addSubscription, removeSubscription };
