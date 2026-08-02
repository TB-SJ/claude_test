'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { providerConfigured } = require('./config');
const logger = require('./logger');
const kv = require('./storage/supabaseKv');

// Tasks are app-only (never written to the calendar). Stored locally as JSON,
// or in Supabase when configured (for hosts with an ephemeral disk). See
// tokenStore.js for the dual-backend rationale; tasks aren't sensitive so they
// are stored as plain JSON.
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'tasks.json');
const KV_KEY = 'tasks';

const PRIORITIES = ['high', 'med', 'low'];
const useSupabase = () => providerConfigured.supabase();

let cache = null; // in-memory array (Supabase mode)
let pending = Promise.resolve();

// --- File backend ----------------------------------------------------------
function readFile() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8') || '[]');
  } catch (_) {
    return [];
  }
}
function writeFile(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

// --- Unified accessors ------------------------------------------------------
async function init() {
  if (!useSupabase()) return;
  const v = await kv.get(KV_KEY);
  cache = v && Array.isArray(v.data) ? v.data : [];
}

function currentAll() {
  if (useSupabase()) {
    if (cache === null) cache = [];
    return cache;
  }
  return readFile();
}

function persist(list) {
  if (useSupabase()) {
    cache = list;
    pending = pending
      .then(() => kv.set(KV_KEY, { data: list }))
      .catch((err) => logger.error('taskStore: Supabase write failed', { message: err.message }));
    return;
  }
  writeFile(list);
}

function clampMinutes(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, 8 * 60); // cap at a workday
}

function normPriority(p) {
  const s = String(p || '').toLowerCase();
  return PRIORITIES.includes(s) ? s : 'med';
}

function list() {
  return currentAll();
}

function add({ title, estimatedMinutes, priority, deadline }) {
  const t = {
    id: crypto.randomUUID(),
    title: String(title || '').trim(),
    estimatedMinutes: clampMinutes(estimatedMinutes),
    priority: normPriority(priority),
    deadline: deadline || null, // YYYY-MM-DD or null
    done: false,
    createdAt: new Date().toISOString(),
  };
  const all = currentAll();
  all.push(t);
  persist(all);
  return t;
}

function update(id, patch = {}) {
  const all = currentAll();
  const i = all.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const clean = {};
  if (patch.title != null) clean.title = String(patch.title).trim();
  if (patch.estimatedMinutes != null) clean.estimatedMinutes = clampMinutes(patch.estimatedMinutes);
  if (patch.priority != null) clean.priority = normPriority(patch.priority);
  if (patch.deadline !== undefined) clean.deadline = patch.deadline || null;
  if (patch.done != null) clean.done = Boolean(patch.done);
  all[i] = { ...all[i], ...clean };
  persist(all);
  return all[i];
}

function remove(id) {
  const all = currentAll();
  const next = all.filter((t) => t.id !== id);
  persist(next);
  return next.length !== all.length;
}

/** Awaits the last background write (Supabase mode); no-op in file mode. */
async function flush() {
  await pending;
}

module.exports = { init, list, add, update, remove, flush, PRIORITIES };
