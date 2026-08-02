'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { scheduleTasks, taskOrder, taskUrgency } = require('../src/services/taskScheduler');
const { parseCommand } = require('../src/services/voiceCommand');

const ev = (id, t, s, e) => ({ id, provider: 'google', title: t, start: `2026-08-03T${s}:00Z`, end: `2026-08-03T${e}:00Z`, status: 'confirmed' });
const REF = new Date('2026-08-03T09:00:00');

test('tasks fill free gaps without overlapping meetings', () => {
  const events = [ev('m1', 'Design review', '10:00', '11:00'), ev('m2', '1:1', '14:00', '15:00')];
  const tasks = [
    { id: 't1', title: 'Budget', estimatedMinutes: 60, priority: 'high', deadline: null, done: false },
    { id: 't2', title: 'Slides', estimatedMinutes: 90, priority: 'med', deadline: null, done: false },
  ];
  const plan = scheduleTasks(tasks, events, { tzOffsetMinutes: 0 }, { date: '2026-08-03' });
  assert.equal(plan.slots.length, 2);
  const overlaps = plan.slots.some((s) =>
    events.some((e) => new Date(s.start) < new Date(e.end) && new Date(e.start) < new Date(s.end))
  );
  assert.equal(overlaps, false, 'no task overlaps a meeting');
});

test('done tasks are skipped; oversized tasks are unscheduled', () => {
  const tasks = [
    { id: 'd', title: 'Done thing', estimatedMinutes: 60, priority: 'high', deadline: null, done: true },
    { id: 'big', title: 'Huge', estimatedMinutes: 960, priority: 'med', deadline: null, done: false },
  ];
  const plan = scheduleTasks(tasks, [], { tzOffsetMinutes: 0 }, { date: '2026-08-03' });
  assert.equal(plan.slots.length, 0);
  assert.equal(plan.unscheduled.length, 1);
  assert.equal(plan.unscheduled[0].id, 'big'); // 960 min > the 15h (900 min) window
});

test('higher priority is scheduled before lower', () => {
  const tasks = [
    { id: 'low', title: 'Low', estimatedMinutes: 60, priority: 'low', deadline: null, done: false },
    { id: 'high', title: 'High', estimatedMinutes: 60, priority: 'high', deadline: null, done: false },
  ];
  const plan = scheduleTasks(tasks, [], { tzOffsetMinutes: 0 }, { date: '2026-08-03' });
  assert.equal(plan.slots[0].title, 'High');
});

test('voice: add-task phrasings', () => {
  assert.equal(parseCommand('add a task to review the budget for 30 minutes by Friday', REF).type, 'add_task');
  assert.equal(parseCommand('remember to call the vendor, urgent', REF).priority, 'high');
  assert.equal(parseCommand('create a task prep slides 90 minutes', REF).estimatedMinutes, 90);
});

test('voice: plan-tasks phrasings', () => {
  assert.equal(parseCommand('plan my day', REF).type, 'plan_tasks');
  assert.equal(parseCommand('schedule my tasks', REF).type, 'plan_tasks');
});

test('plan skips past time when planning today', () => {
  const ref = new Date('2026-08-03T13:00:00Z'); // 13:00 local (tz 0)
  const tasks = [{ id: 't1', title: 'A', estimatedMinutes: 60, priority: 'high', deadline: null, done: false }];
  const plan = scheduleTasks(tasks, [], { tzOffsetMinutes: 0 }, { date: '2026-08-03', referenceDate: ref });
  assert.equal(plan.slots[0].start, '2026-08-03T13:00:00.000Z'); // not 09:00
});

test('plan for a future day ignores the current time (starts at work open)', () => {
  const ref = new Date('2026-08-03T13:00:00Z');
  const tasks = [{ id: 't1', title: 'A', estimatedMinutes: 60, priority: 'high', deadline: null, done: false }];
  const plan = scheduleTasks(tasks, [], { tzOffsetMinutes: 0 }, { date: '2026-08-05', referenceDate: ref });
  assert.equal(plan.slots[0].start, '2026-08-05T06:00:00.000Z');
});

test('plan timeline drops events that already ended today', () => {
  const ref = new Date('2026-08-03T12:00:00Z'); // noon
  const events = [
    { id: 'm1', title: 'Morning standup', start: '2026-08-03T09:30:00Z', end: '2026-08-03T10:00:00Z', status: 'confirmed' },
    { id: 'm2', title: 'Afternoon review', start: '2026-08-03T14:00:00Z', end: '2026-08-03T15:00:00Z', status: 'confirmed' },
  ];
  const plan = scheduleTasks([], events, { tzOffsetMinutes: 0 }, { referenceDate: ref });
  assert.deepEqual(plan.events.map((e) => e.id), ['m2']); // the 9:30 event is gone
});

test('voice: brief phrasings', () => {
  assert.equal(parseCommand("how's my day", REF).type, 'brief');
  assert.equal(parseCommand('brief me', REF).type, 'brief');
  assert.equal(parseCommand('what does my day look like', REF).type, 'brief');
});

test('deadline-aware order: an imminent deadline beats higher priority', () => {
  const today = '2026-08-03';
  const dueToday = { id: 'a', title: 'Low but due today', priority: 'low', deadline: '2026-08-03', estimatedMinutes: 30 };
  const highNoDeadline = { id: 'b', title: 'High no deadline', priority: 'high', deadline: null, estimatedMinutes: 30 };
  assert.ok(taskOrder(dueToday, highNoDeadline, today) < 0, 'due-today task sorts first');
  // Without a reference day, it falls back to priority-first (high wins).
  assert.ok(taskOrder(dueToday, highNoDeadline) > 0);
});

test('taskUrgency classifies overdue / today / tomorrow', () => {
  const today = '2026-08-03';
  assert.equal(taskUrgency({ deadline: '2026-08-01' }, today).overdue, true);
  assert.equal(taskUrgency({ deadline: '2026-08-03' }, today).dueToday, true);
  assert.equal(taskUrgency({ deadline: '2026-08-04' }, today).dueTomorrow, true);
  assert.equal(taskUrgency({ deadline: null }, today).dueSoon, false);
});
