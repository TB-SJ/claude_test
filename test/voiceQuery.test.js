'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Patch the data sources the resolver reads before requiring it.
const calendar = require('../src/services/calendar');
const taskStore = require('../src/taskStore');
const { resolveParsed } = require('../src/services/voiceCommand');

const REF = new Date('2026-08-05T15:00:00Z'); // Wednesday
const CTX = { referenceDate: REF, tzOffsetMinutes: 0, transcript: 't' };

function withEvents(events, fn) {
  const orig = calendar.getEvents;
  calendar.getEvents = async () => events;
  return Promise.resolve(fn()).finally(() => { calendar.getEvents = orig; });
}

test('resolveParsed show_schedule returns the day\'s events + label', async () => {
  const events = [{ id: '1', title: 'Sync', start: '2026-08-05T10:00:00Z', end: '2026-08-05T10:30:00Z' }];
  await withEvents(events, async () => {
    const r = await resolveParsed('google', { type: 'show_schedule', scope: 'day', date: '2026-08-05' }, CTX);
    assert.equal(r.type, 'show_schedule');
    assert.equal(r.events.length, 1);
    assert.equal(r.label, 'Today');
  });
});

test('resolveParsed show_free computes remaining gaps from now', async () => {
  // CTX reference time is 15:00 on the queried day, so only 15:00–21:00 is left
  // (the 10:00–11:00 event is already past).
  const events = [{ id: '1', title: 'Sync', start: '2026-08-05T10:00:00Z', end: '2026-08-05T11:00:00Z' }];
  await withEvents(events, async () => {
    const r = await resolveParsed('google', { type: 'show_free', scope: 'day', date: '2026-08-05' }, CTX);
    assert.equal(r.type, 'show_free');
    assert.equal(r.days.length, 1);
    assert.deepEqual(r.days[0].slots.map((s) => s.minutes), [360]);
  });
});

test('resolveParsed edit resolves the event and builds changes', async () => {
  const events = [{ id: 'e1', title: 'Standup', start: '2026-08-05T09:30:00Z', end: '2026-08-05T09:45:00Z' }];
  await withEvents(events, async () => {
    const r = await resolveParsed('google', { type: 'edit', title: 'standup', newTitle: 'Team Sync', durationMinutes: 30 }, CTX);
    assert.equal(r.type, 'edit');
    assert.equal(r.match.id, 'e1');
    assert.equal(r.changes.title, 'Team Sync');
    assert.equal(r.changes.duration, 30);
  });
});

test('resolveParsed edit reports not_found when nothing matches', async () => {
  await withEvents([], async () => {
    const r = await resolveParsed('google', { type: 'edit', title: 'ghost', newTitle: 'x' }, CTX);
    assert.equal(r.error, 'not_found');
  });
});

test('resolveParsed edit_task finds a task and builds a patch', async () => {
  const origList = taskStore.list;
  taskStore.list = () => [{ id: 't1', title: 'Budget review', priority: 'med', estimatedMinutes: 30, done: false }];
  try {
    const r = await resolveParsed('google', { type: 'edit_task', title: 'budget', priority: 'high', done: true }, CTX);
    assert.equal(r.type, 'edit_task');
    assert.equal(r.task.id, 't1');
    assert.equal(r.patch.priority, 'high');
    assert.equal(r.patch.done, true);
  } finally {
    taskStore.list = origList;
  }
});
