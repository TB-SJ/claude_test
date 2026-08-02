'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { weekRange, dayRange } = require('../src/services/calendarUtils');

test('weekRange is a rolling 7 days from the anchor (fixes Sunday-only week)', () => {
  // Aug 2 2026 is a Sunday — the reported case. The window must run forward a
  // full week, not end at Sunday (which would show only "today").
  const w = weekRange('2026-08-02T12:00:00Z');
  assert.equal(w.start, '2026-08-02T00:00:00.000Z');
  assert.equal(w.end, '2026-08-09T00:00:00.000Z');
});

test('weekRange spans 7 days from any weekday anchor', () => {
  const w = weekRange('2026-08-05T12:00:00Z'); // Wednesday
  assert.equal(w.start, '2026-08-05T00:00:00.000Z');
  assert.equal(w.end, '2026-08-12T00:00:00.000Z');
});

test('dayRange stays a single anchored day', () => {
  const d = dayRange('2026-08-02T12:00:00Z');
  assert.equal(d.start, '2026-08-02T00:00:00.000Z');
  assert.equal(d.end, '2026-08-03T00:00:00.000Z');
});
