'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { composeBrief } = require('../src/services/brief');

// Reference "now": Mon Aug 3 2026, 08:00 UTC (before the day's events). tz = 0.
const REF = new Date('2026-08-03T08:00:00Z');
const CTX = { tzOffsetMinutes: 0, referenceDate: REF };

const ev = (id, title, s, e) => ({ id, title, start: `2026-08-03T${s}:00Z`, end: `2026-08-03T${e}:00Z`, status: 'confirmed' });

test('composeBrief summarizes meetings, free time, and next event', () => {
  const events = [ev('m1', 'Standup', '14:00', '14:30'), ev('m2', 'Review', '15:00', '16:00')];
  const b = composeBrief(events, [], CTX);
  assert.equal(b.meetingCount, 2);
  assert.equal(b.meetingMinutes, 90);
  assert.equal(b.nextEvent.title, 'Standup'); // first event after 08:00
  // 09:00–17:00 work window minus 14:00–14:30 and 15:00–16:00 = 8h - 1.5h = 390m.
  assert.equal(b.freeMinutes, 390);
  assert.equal(b.deepWorkClear, true); // no meeting in 09:00–11:00
});

test('composeBrief flags a meeting inside the deep-work block', () => {
  const b = composeBrief([ev('m', 'Early sync', '09:30', '10:00')], [], CTX);
  assert.equal(b.deepWorkClear, false);
});

test('composeBrief surfaces the top task and at-risk deadlines', () => {
  const tasks = [
    { id: 't1', title: 'Ship report', priority: 'med', deadline: '2026-08-03', estimatedMinutes: 60, done: false },
    { id: 't2', title: 'Someday idea', priority: 'low', deadline: null, estimatedMinutes: 30, done: false },
  ];
  const b = composeBrief([], tasks, CTX);
  assert.equal(b.topTask.id, 't1'); // due today → first
  assert.equal(b.atRisk.length, 1);
  assert.equal(b.atRisk[0].when, 'due today');
  assert.equal(b.pendingTaskCount, 2);
});
