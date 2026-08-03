'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// File-backed mode (no Supabase env) so save() writes to data/settings.json.
const FILE = path.join(__dirname, '..', 'data', 'settings.json');
function clean() {
  try { fs.unlinkSync(FILE); } catch (_) { /* ignore */ }
}

const settingsStore = require('../src/settingsStore');

test('defaults mirror the built-in scheduling behavior', () => {
  const d = settingsStore.DEFAULTS;
  assert.equal(d.workday.start, '06:00');
  assert.equal(d.workday.end, '21:00');
  assert.equal(d.bufferMinutes, 15);
  assert.equal(d.briefTime, '07:00');
});

test('rules() returns a resolveRules-shaped override carrying the tz offset', () => {
  clean();
  const r = settingsStore.rules(-300);
  assert.equal(r.tzOffsetMinutes, -300);
  assert.deepEqual(r.workday, { start: '06:00', end: '21:00' });
  assert.equal(r.bufferMinutes, 15);
});

test('save() persists a valid patch and clamps numeric fields', async () => {
  clean();
  const next = await settingsStore.save({
    workday: { start: '07:00', end: '22:00' },
    bufferMinutes: 999,
    reminderLeadMinutes: -5,
    optimizePrefs: 'No meetings before 10am',
  });
  assert.equal(next.workday.start, '07:00');
  assert.equal(next.bufferMinutes, 120); // clamped to max
  assert.equal(next.reminderLeadMinutes, 0); // clamped to min
  assert.equal(next.optimizePrefs, 'No meetings before 10am');
  // Persisted and reflected in rules().
  assert.equal(settingsStore.rules(0).workday.end, '22:00');
  assert.equal(settingsStore.optimizePrefs(), 'No meetings before 10am');
  clean();
});

test('save() rejects an invalid work window', async () => {
  clean();
  await assert.rejects(
    () => settingsStore.save({ workday: { start: '21:00', end: '06:00' } }),
    /workday\.end must be after/
  );
  clean();
});

test('optimizePrefs is capped to 500 characters', async () => {
  clean();
  const long = 'x'.repeat(700);
  const next = await settingsStore.save({ optimizePrefs: long });
  assert.equal(next.optimizePrefs.length, 500);
  clean();
});
