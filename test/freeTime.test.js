'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freeForDays, coveringWindow, weekdayKeys } = require('../src/services/freeTime');

// tzOffset 0 → UTC is local; workday defaults to 09:00–17:00.
const RULES = { tzOffsetMinutes: 0 };

test('freeForDays returns the gaps around events within work hours', () => {
  const events = [
    { id: '1', title: 'A', start: '2026-08-05T10:00:00Z', end: '2026-08-05T11:00:00Z' },
    { id: '2', title: 'B', start: '2026-08-05T13:00:00Z', end: '2026-08-05T14:00:00Z' },
  ];
  const [day] = freeForDays(events, ['2026-08-05'], RULES);
  assert.deepEqual(
    day.slots.map((s) => [s.start, s.end, s.minutes]),
    [
      ['2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', 60],
      ['2026-08-05T11:00:00.000Z', '2026-08-05T13:00:00.000Z', 120],
      ['2026-08-05T14:00:00.000Z', '2026-08-05T17:00:00.000Z', 180],
    ]
  );
});

test('a fully open day is one 8-hour slot; overlapping events merge', () => {
  const [empty] = freeForDays([], ['2026-08-05'], RULES);
  assert.equal(empty.slots.length, 1);
  assert.equal(empty.slots[0].minutes, 480);

  const overlapping = [
    { id: '1', title: 'A', start: '2026-08-05T10:00:00Z', end: '2026-08-05T12:00:00Z' },
    { id: '2', title: 'B', start: '2026-08-05T11:00:00Z', end: '2026-08-05T13:00:00Z' },
  ];
  const [day] = freeForDays(overlapping, ['2026-08-05'], RULES);
  // One merged busy block 10–13 → free 09–10 and 13–17.
  assert.deepEqual(day.slots.map((s) => s.minutes), [60, 240]);
});

test('weekdayKeys returns the upcoming weekdays in the rolling 7-day window', () => {
  // From Wed Aug 5: Wed–Fri this week, then Mon–Tue next (Sat/Sun skipped).
  assert.deepEqual(weekdayKeys('2026-08-05'), [
    '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11',
  ]);
  // From Sun Aug 2 (the reported case): the next working week, not the past one.
  assert.deepEqual(weekdayKeys('2026-08-02'), [
    '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
  ]);
});

test('coveringWindow spans the work hours of all days', () => {
  const win = coveringWindow(['2026-08-03', '2026-08-07'], RULES);
  assert.equal(win.start, '2026-08-03T09:00:00.000Z');
  assert.equal(win.end, '2026-08-07T17:00:00.000Z');
});
