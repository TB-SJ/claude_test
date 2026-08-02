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

/** Normalizes a repeat rule to a sorted array of unique weekdays (0=Sun..6=Sat),
 *  or null for a one-off. Accepts an array, 'daily', or 'weekdays'. */
function normRepeat(v) {
  if (v == null || v === 'none' || v === '') return null;
  if (v === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (v === 'weekdays') return [1, 2, 3, 4, 5];
  if (!Array.isArray(v)) return null;
  const days = [...new Set(v.map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b);
  return days.length ? days : null;
}

function isRecurring(task) {
  return Array.isArray(task.repeat) && task.repeat.length > 0;
}

function weekdayOfKey(dateKey) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** True when a recurring task recurs on this local day. */
function isDueOn(task, dateKey) {
  return isRecurring(task) && task.repeat.includes(weekdayOfKey(dateKey));
}

/** True when a task should appear as actionable on `dateKey`. */
function isPending(task, dateKey) {
  if (task.deferred) return false; // parked in the "Someday/Later" bucket
  if (isRecurring(task)) return isDueOn(task, dateKey) && task.lastDone !== dateKey;
  return !task.done;
}

/** Normalizes a free-text category/tag (trimmed, capped), or null. */
function normCategory(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 24);
  return s || null;
}

/** The most recent recurrence day strictly before `dateKey`, or null. */
function previousDue(repeat, dateKey) {
  const base = new Date(`${dateKey}T00:00:00Z`);
  for (let i = 1; i <= 7; i += 1) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() - i);
    if (repeat.includes(d.getUTCDay())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10);
}

function list() {
  return currentAll();
}

function add({ title, estimatedMinutes, priority, deadline, repeat, category }) {
  const t = {
    id: crypto.randomUUID(),
    title: String(title || '').trim(),
    estimatedMinutes: clampMinutes(estimatedMinutes),
    priority: normPriority(priority),
    deadline: deadline || null, // YYYY-MM-DD or null
    repeat: normRepeat(repeat), // null (one-off) or [weekdays]
    category: normCategory(category),
    deferred: false, // "Someday/Later" bucket
    streak: 0,
    lastDone: null, // last completion date (recurring) — YYYY-MM-DD
    done: false, // one-off completion
    completedAt: null,
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
  const t = all[i];
  const clean = {};
  if (patch.title != null) clean.title = String(patch.title).trim();
  if (patch.estimatedMinutes != null) clean.estimatedMinutes = clampMinutes(patch.estimatedMinutes);
  if (patch.priority != null) clean.priority = normPriority(patch.priority);
  if (patch.deadline !== undefined) clean.deadline = patch.deadline || null;
  if (patch.repeat !== undefined) clean.repeat = normRepeat(patch.repeat);
  if (patch.category !== undefined) clean.category = normCategory(patch.category);
  if (patch.deferred != null) clean.deferred = Boolean(patch.deferred);

  if (patch.done != null) {
    const dateKey = patch.date || todayKeyUTC(); // client passes its local date
    const repeat = clean.repeat !== undefined ? clean.repeat : t.repeat;
    if (Array.isArray(repeat) && repeat.length) {
      // Recurring: completion is per-day and feeds the streak.
      if (patch.done) {
        clean.streak = t.lastDone === previousDue(repeat, dateKey) ? (t.streak || 0) + 1 : 1;
        clean.lastDone = dateKey;
      } else if (t.lastDone === dateKey) {
        clean.lastDone = null;
        clean.streak = Math.max(0, (t.streak || 0) - 1);
      }
    } else {
      clean.done = Boolean(patch.done);
      clean.completedAt = patch.done ? new Date().toISOString() : null;
    }
  }

  all[i] = { ...t, ...clean };
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

module.exports = {
  init, list, add, update, remove, flush, PRIORITIES,
  // recurring/habit helpers (also used by the scheduler, brief, and review):
  isRecurring, isDueOn, isPending, previousDue, normRepeat, weekdayOfKey,
};
