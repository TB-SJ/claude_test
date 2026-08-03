'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { weekRange, dayRange, localNoonAnchor } = require('../src/services/calendarUtils');

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

test('dayRange shifts to the LOCAL day for a non-UTC offset (fixes missing evening events)', () => {
  // US Eastern (UTC-5): the local day Aug 2 runs 05:00Z Aug 2 → 05:00Z Aug 3,
  // so an 8pm-local event (01:00Z Aug 3) is inside the window — it wouldn't be
  // with a plain UTC window.
  const d = dayRange('2026-08-02T12:00:00Z', -300);
  assert.equal(d.start, '2026-08-02T05:00:00.000Z');
  assert.equal(d.end, '2026-08-03T05:00:00.000Z');
});

test('weekRange shifts to local days for a non-UTC offset', () => {
  const w = weekRange('2026-08-02T12:00:00Z', -300);
  assert.equal(w.start, '2026-08-02T05:00:00.000Z');
  assert.equal(w.end, '2026-08-09T05:00:00.000Z');
});

test('localNoonAnchor returns the local date at noon UTC', () => {
  // 03:00Z Aug 3 is still Aug 2 in UTC-5 → anchor should be Aug 2 noon.
  const a = localNoonAnchor(-300, Date.parse('2026-08-03T03:00:00Z'));
  assert.equal(a, '2026-08-02T12:00:00Z');
});
