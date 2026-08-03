'use strict';

const fs = require('fs');
const path = require('path');
const { providerConfigured } = require('./config');
const { resolveRules } = require('./services/scheduleRules');
const kv = require('./storage/supabaseKv');
const logger = require('./logger');

// User-configurable settings (scheduling rules, brief time, optimizer prefs).
// Persisted in Supabase when configured, else a local file. Cached in memory so
// route handlers can read them synchronously; init() loads at startup.
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');
const KV_KEY = 'settings';

// Defaults mirror the built-in behavior, so an empty store changes nothing.
const DEFAULTS = {
  workday: { start: '06:00', end: '21:00' },
  deepWork: { enabled: true, start: '09:00', end: '11:00' },
  bufferMinutes: 15,
  meetingWindow: { enabled: true, start: '13:00', end: '17:00' },
  briefTime: '07:00',
  reminderLeadMinutes: 10,
  optimizePrefs: '',
};

const useSupabase = () => providerConfigured.supabase();
let cache = null;
let pending = Promise.resolve();

function merge(base, patch) {
  const out = { ...base };
  if (patch && typeof patch === 'object') {
    if (patch.workday) out.workday = { ...base.workday, ...patch.workday };
    if (patch.deepWork) out.deepWork = { ...base.deepWork, ...patch.deepWork };
    if (patch.meetingWindow) out.meetingWindow = { ...base.meetingWindow, ...patch.meetingWindow };
    if (patch.bufferMinutes != null) out.bufferMinutes = patch.bufferMinutes;
    if (patch.briefTime != null) out.briefTime = patch.briefTime;
    if (patch.reminderLeadMinutes != null) out.reminderLeadMinutes = patch.reminderLeadMinutes;
    if (patch.optimizePrefs != null) out.optimizePrefs = patch.optimizePrefs;
  }
  return out;
}

async function init() {
  if (!useSupabase()) {
    cache = readFile();
    return;
  }
  const v = await kv.get(KV_KEY);
  cache = merge(DEFAULTS, v || {});
}

function readFile() {
  if (!fs.existsSync(FILE)) return { ...DEFAULTS };
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}'));
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function current() {
  if (cache === null) cache = useSupabase() ? { ...DEFAULTS } : readFile();
  return cache;
}

/** Rule-overrides object for resolveRules(), with the client's tz offset. */
function rules(tzOffsetMinutes = 0) {
  const s = current();
  return {
    tzOffsetMinutes,
    workday: s.workday,
    deepWork: s.deepWork,
    bufferMinutes: s.bufferMinutes,
    meetingWindow: s.meetingWindow,
  };
}

/** Notification timing (falls back handled by callers if unset). */
function notify() {
  const s = current();
  return { briefTime: s.briefTime, reminderLeadMinutes: s.reminderLeadMinutes };
}

function optimizePrefs() {
  return current().optimizePrefs || '';
}

/** Validates + persists a patch. Throws on invalid times. Returns new settings. */
async function save(patch) {
  const next = merge(current(), patch);
  next.bufferMinutes = Math.max(0, Math.min(120, parseInt(next.bufferMinutes, 10) || 0));
  next.reminderLeadMinutes = Math.max(0, Math.min(120, parseInt(next.reminderLeadMinutes, 10) || 0));
  next.optimizePrefs = String(next.optimizePrefs || '').slice(0, 500);
  // resolveRules throws on malformed HH:MM / bad windows — validate before saving.
  resolveRules(rules(0) && {
    workday: next.workday, deepWork: next.deepWork, bufferMinutes: next.bufferMinutes, meetingWindow: next.meetingWindow,
  });
  cache = next;
  if (useSupabase()) {
    pending = pending.then(() => kv.set(KV_KEY, next)).catch((err) => logger.error('settings write failed', { message: err.message }));
    await pending;
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  }
  return next;
}

module.exports = { init, current, rules, notify, optimizePrefs, save, DEFAULTS };
