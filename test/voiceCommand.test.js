'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseCommand } = require('../src/services/voiceCommand');

const REF = new Date('2026-08-03T09:00:00'); // a Monday, local time

test('optimize commands + scope', () => {
  assert.deepEqual(parseCommand('optimize my day', REF).type, 'optimize');
  assert.equal(parseCommand('optimize my day', REF).scope, 'day');
  assert.equal(parseCommand('rearrange my week please', REF).scope, 'week');
});

test('add extracts title + time', () => {
  const r = parseCommand('add dentist appointment tomorrow at 2pm', REF);
  assert.equal(r.type, 'add');
  assert.equal(r.title, 'dentist appointment');
  assert.equal(r.start, '2026-08-04T14:00:00.000Z');
  assert.equal(r.end, '2026-08-04T15:00:00.000Z'); // default 60 min
  assert.equal(r.timeSpecified, true);
});

test('add with explicit range keeps the end time', () => {
  const r = parseCommand('schedule lunch with Sarah next Friday from 12 to 1pm', REF);
  assert.equal(r.title, 'lunch with Sarah');
  assert.equal(r.end, '2026-08-14T13:00:00.000Z');
});

test('add without a time is flagged (no time)', () => {
  const r = parseCommand('add a meeting', REF);
  assert.equal(r.type, 'add');
  assert.equal(r.timeSpecified, false);
});

test('remove extracts title', () => {
  assert.deepEqual(
    { type: parseCommand('cancel my standup', REF).type, title: parseCommand('cancel my standup', REF).title },
    { type: 'remove', title: 'standup' }
  );
});

test('move time-only flags dateSpecified=false (keep event day)', () => {
  const r = parseCommand('move my standup to 4pm', REF);
  assert.equal(r.type, 'move');
  assert.equal(r.title, 'standup');
  assert.equal(r.when.dateSpecified, false);
  assert.equal(r.when.timeSpecified, true);
});

test('move with a full date sets dateSpecified=true', () => {
  const r = parseCommand('reschedule dentist to next Wednesday at 10am', REF);
  assert.equal(r.when.dateSpecified, true);
});

test('"change" and "update" are treated as move', () => {
  assert.equal(parseCommand('change my standup to 4pm', REF).type, 'move');
  assert.equal(parseCommand('update design review to 3pm', REF).type, 'move');
});

test('unrecognized input is unknown', () => {
  assert.equal(parseCommand('what is the weather', REF).type, 'unknown');
});
