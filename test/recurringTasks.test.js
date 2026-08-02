'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isPending, isDueOn, previousDue, normRepeat, isRecurring } = require('../src/taskStore');

// Reference weekdays: 2026-08-03 Mon(1) … 08-05 Wed(3) … 08-07 Fri(5).

test('normRepeat normalizes presets and arrays', () => {
  assert.deepEqual(normRepeat('daily'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(normRepeat('weekdays'), [1, 2, 3, 4, 5]);
  assert.deepEqual(normRepeat([5, 1, 3, 1]), [1, 3, 5]); // dedupe + sort
  assert.deepEqual(normRepeat([7, -1, 2]), [2]); // drop out-of-range
  assert.equal(normRepeat([]), null);
  assert.equal(normRepeat(null), null);
});

test('isRecurring / isDueOn', () => {
  const gym = { repeat: [1, 3, 5], lastDone: null };
  assert.equal(isRecurring(gym), true);
  assert.equal(isRecurring({ repeat: null }), false);
  assert.equal(isDueOn(gym, '2026-08-07'), true); // Fri
  assert.equal(isDueOn(gym, '2026-08-06'), false); // Thu
});

test('isPending: recurring is pending on due days until completed that day', () => {
  const gym = { repeat: [1, 3, 5], lastDone: null };
  assert.equal(isPending(gym, '2026-08-07'), true);
  gym.lastDone = '2026-08-07';
  assert.equal(isPending(gym, '2026-08-07'), false); // done today
  assert.equal(isPending(gym, '2026-08-05'), true); // a different due day
});

test('isPending: one-off follows the done flag', () => {
  assert.equal(isPending({ done: false }, '2026-08-07'), true);
  assert.equal(isPending({ done: true }, '2026-08-07'), false);
});

test('previousDue finds the prior recurrence day', () => {
  assert.equal(previousDue([1, 3, 5], '2026-08-07'), '2026-08-05'); // Fri → prev Wed
  assert.equal(previousDue([0, 1, 2, 3, 4, 5, 6], '2026-08-07'), '2026-08-06'); // daily → yesterday
  assert.equal(previousDue([5], '2026-08-07'), '2026-07-31'); // weekly Fri → prior Fri
});
