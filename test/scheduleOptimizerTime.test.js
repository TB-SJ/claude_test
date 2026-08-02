'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { optimize } = require('../src/services/scheduleOptimizer');

// tz 0 → UTC is local. Mon Aug 3 2026, "now" = 15:00.
const REF = new Date('2026-08-03T15:00:00Z');
const ev = (id, title, s, e) => ({ id, provider: 'google', title, start: `2026-08-03T${s}:00Z`, end: `2026-08-03T${e}:00Z`, status: 'confirmed' });

test('optimize never moves an event that has already started', () => {
  const events = [
    ev('past', 'Morning sync', '10:00', '10:30'), // already happened (and in deep-work) — must be left alone
    ev('a', 'Review', '16:00', '16:30'),
    ev('b', 'Sync', '16:15', '16:45'), // overlaps a → optimizer will separate them
  ];
  const res = optimize(events, { tzOffsetMinutes: 0 }, { referenceDate: REF });

  assert.ok(!res.moves.some((m) => m.id === 'past'), 'the past event must not be rescheduled');
  assert.ok(res.moves.length > 0, 'the future overlap should still be resolved');
  for (const m of res.moves) {
    assert.ok(new Date(m.to.start).getTime() >= REF.getTime(), `move ${m.id} must not land in the past`);
  }
});

test('optimize floors today placements at the current time', () => {
  // A lone future event sitting at 16:00; the meeting window opens at 13:00, but
  // "now" is 15:00 — it must never be pulled earlier than 15:00.
  const events = [ev('a', 'Review', '16:00', '16:30')];
  const res = optimize(events, { tzOffsetMinutes: 0 }, { referenceDate: REF });
  for (const m of res.moves) {
    assert.ok(new Date(m.to.start).getTime() >= REF.getTime());
  }
});
