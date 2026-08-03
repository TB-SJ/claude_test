'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeReview } = require('../src/services/reviewService');

// "Now" = Fri Aug 7 2026, 18:00. This week = Aug 1–7; last week = Jul 25–31.
const REF = new Date('2026-08-07T18:00:00Z');
const ev = (id, s, e) => ({ id, title: id, start: s, end: e, status: 'confirmed' });

test('computeReview summarizes meetings, trend, tasks, and habits', () => {
  const events = [
    ev('m1', '2026-08-05T10:00:00Z', '2026-08-05T11:00:00Z'), // this week, in deep-work
    ev('m2', '2026-08-06T14:00:00Z', '2026-08-06T14:30:00Z'), // this week, afternoon
    ev('old', '2026-07-28T10:00:00Z', '2026-07-28T11:00:00Z'), // last week
  ];
  const tasks = [
    { title: 'Done', repeat: null, done: true, completedAt: '2026-08-05T12:00:00Z' },
    { title: 'Open', repeat: null, done: false, deadline: null },
    { title: 'Gym', repeat: [1, 3, 5], streak: 4, lastDone: '2026-08-07' },
  ];
  const r = computeReview(events, tasks, { tzOffsetMinutes: 0, referenceDate: REF });

  assert.equal(r.meetings.count, 2);
  assert.equal(r.meetings.minutes, 90); // 60 + 30
  assert.equal(r.meetings.lastWeekMinutes, 60);
  assert.equal(r.meetings.trend, 'up');

  assert.equal(r.deepWork.days, 5); // Mon–Fri in the window
  assert.equal(r.deepWork.protected, 4); // only Aug 5 intruded (10:00 inside 9–11)

  assert.equal(r.tasks.open, 1);
  assert.equal(r.tasks.completedThisWeek, 2); // one-off + the recurring completion
  assert.equal(r.habits[0].title, 'Gym');
  assert.equal(r.habits[0].streak, 4);

  // Meeting-trend sparkline series: 6 rolling weeks ending this week.
  assert.equal(r.meetingTrend.length, 6);
  assert.equal(r.meetingTrend[5].to, '2026-08-07'); // last bucket ends today
  assert.equal(r.meetingTrend[5].minutes, 90); // this week matches meetings.minutes
  assert.equal(r.meetingTrend[4].minutes, 60); // prior week matches lastWeekMinutes
});
