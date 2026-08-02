'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { suggestNext } = require('../src/services/focusService');

// tz 0. Mon Aug 3 2026, "now" = 13:00. Workday 06:00–21:00.
const REF = new Date('2026-08-03T13:00:00Z');
const CTX = { tzOffsetMinutes: 0, referenceDate: REF };
const ev = (id, s, e) => ({ id, title: id, start: s, end: e, status: 'confirmed' });
const task = (id, min, prio) => ({ id, title: id, estimatedMinutes: min, priority: prio, done: false, repeat: null });

test('suggests the best fitting task for the open window', () => {
  const events = [ev('m', '2026-08-03T15:00:00Z', '2026-08-03T15:30:00Z')]; // next event at 15:00
  const tasks = [task('big', 200, 'low'), task('quick', 45, 'high')];
  const f = suggestNext(events, tasks, CTX);
  assert.equal(f.status, 'ok');
  assert.equal(f.availableMinutes, 120); // 13:00 → 15:00
  assert.equal(f.task.id, 'quick'); // high priority AND fits
  assert.equal(f.fits, true);
});

test('reports being in a meeting right now', () => {
  const events = [ev('standup', '2026-08-03T12:30:00Z', '2026-08-03T14:00:00Z')];
  const f = suggestNext(events, [task('x', 30, 'high')], CTX);
  assert.equal(f.status, 'busy');
  assert.equal(f.event.title, 'standup');
});

test('offers to start a task that does not fully fit', () => {
  const events = [ev('m', '2026-08-03T13:30:00Z', '2026-08-03T14:00:00Z')]; // only 30 min free
  const f = suggestNext(events, [task('long', 90, 'high')], CTX);
  assert.equal(f.status, 'ok');
  assert.equal(f.availableMinutes, 30);
  assert.equal(f.fits, false);
  assert.equal(f.task.id, 'long');
});

test('free time but no tasks', () => {
  const f = suggestNext([], [], CTX);
  assert.equal(f.status, 'free_no_tasks');
});

test('deferred tasks are not suggested', () => {
  const tasks = [{ ...task('later', 30, 'high'), deferred: true }];
  const f = suggestNext([], tasks, CTX);
  assert.equal(f.status, 'free_no_tasks');
});
