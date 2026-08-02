'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { scheduleTasks } = require('../src/services/taskScheduler');
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
    { id: 'big', title: 'Huge', estimatedMinutes: 600, priority: 'med', deadline: null, done: false },
  ];
  const plan = scheduleTasks(tasks, [], { tzOffsetMinutes: 0 }, { date: '2026-08-03' });
  assert.equal(plan.slots.length, 0);
  assert.equal(plan.unscheduled.length, 1);
  assert.equal(plan.unscheduled[0].id, 'big');
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
