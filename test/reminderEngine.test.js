'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { planNotifications } = require('../src/services/reminderEngine');

const DAY = '2026-08-03';
const base = { tzOffsetMinutes: 0, briefTime: '07:00', leadMinutes: 10, tickMinutes: 15, appUrl: '/' };

test('daily brief fires once at/after the brief time', () => {
  const brief = { lines: ['🗓 2 meetings · 1h booked', '🎯 4h free'], events: [] };
  const r = planNotifications({ ...base, now: new Date(`${DAY}T07:05:00Z`), brief, state: {} });
  const b = r.notifications.find((n) => n.type === 'brief');
  assert.ok(b, 'brief sent');
  assert.match(b.body, /2 meetings/);
  assert.equal(r.state.lastBriefDate, DAY);
});

test('daily brief does not repeat the same day', () => {
  const brief = { lines: ['x'], events: [] };
  const r = planNotifications({ ...base, now: new Date(`${DAY}T09:00:00Z`), brief, state: { lastBriefDate: DAY, remindedDay: DAY, reminded: {} } });
  assert.equal(r.notifications.filter((n) => n.type === 'brief').length, 0);
});

test('no brief before the brief time', () => {
  const r = planNotifications({ ...base, now: new Date(`${DAY}T06:30:00Z`), brief: { lines: ['x'], events: [] }, state: {} });
  assert.equal(r.notifications.filter((n) => n.type === 'brief').length, 0);
});

test('reminds an event within the lookahead window, once', () => {
  const brief = { lines: [], events: [{ id: 'e1', title: 'Sync', start: `${DAY}T13:10:00Z` }] };
  const state = { lastBriefDate: DAY, remindedDay: DAY, reminded: {} };
  const r1 = planNotifications({ ...base, now: new Date(`${DAY}T13:00:00Z`), brief, state });
  const rem = r1.notifications.find((n) => n.type === 'reminder');
  assert.ok(rem);
  assert.equal(rem.eventId, 'e1');
  assert.equal(r1.state.reminded.e1, true);

  // Next tick with the updated state must not remind again.
  const r2 = planNotifications({ ...base, now: new Date(`${DAY}T13:05:00Z`), brief, state: r1.state });
  assert.equal(r2.notifications.filter((n) => n.type === 'reminder').length, 0);
});

test('does not remind an event far in the future', () => {
  const brief = { lines: [], events: [{ id: 'e2', title: 'Later', start: `${DAY}T16:00:00Z` }] };
  const r = planNotifications({ ...base, now: new Date(`${DAY}T13:00:00Z`), brief, state: { lastBriefDate: DAY, remindedDay: DAY, reminded: {} } });
  assert.equal(r.notifications.filter((n) => n.type === 'reminder').length, 0);
});

test('brief carries a mark-done action + taskId when there is a top task', () => {
  const brief = { lines: ['x'], events: [], topTask: { id: 't9', title: 'Ship it' } };
  const r = planNotifications({ ...base, now: new Date(`${DAY}T07:05:00Z`), brief, state: {} });
  const b = r.notifications.find((n) => n.type === 'brief');
  assert.equal(b.taskId, 't9');
  assert.ok(b.actions.some((a) => a.action === 'done'));
});

test('brief has only an open action when there is no top task', () => {
  const brief = { lines: ['x'], events: [], topTask: null };
  const r = planNotifications({ ...base, now: new Date(`${DAY}T07:05:00Z`), brief, state: {} });
  const b = r.notifications.find((n) => n.type === 'brief');
  assert.equal(b.taskId, null);
  assert.deepEqual(b.actions.map((a) => a.action), ['open']);
});

test('event reminders carry snooze + open actions', () => {
  const brief = { lines: [], events: [{ id: 'e1', title: 'Sync', start: `${DAY}T13:10:00Z` }] };
  const r = planNotifications({ ...base, now: new Date(`${DAY}T13:00:00Z`), brief, state: { lastBriefDate: DAY, remindedDay: DAY, reminded: {} } });
  const rem = r.notifications.find((n) => n.type === 'reminder');
  assert.deepEqual(rem.actions.map((a) => a.action), ['snooze', 'open']);
});

test('a snoozed reminder re-fires once its snooze elapses, then clears', () => {
  const ev = { id: 'e1', title: 'Sync', start: `${DAY}T14:00:00Z` };
  const brief = { lines: [], events: [ev] };
  // Snooze set to 13:00; now 13:05 → should re-fire and be cleared from state.
  const state = { lastBriefDate: DAY, remindedDay: DAY, reminded: { e1: true }, snoozed: { e1: new Date(`${DAY}T13:00:00Z`).getTime() } };
  const r = planNotifications({ ...base, now: new Date(`${DAY}T13:05:00Z`), brief, state });
  assert.ok(r.notifications.find((n) => n.type === 'reminder' && n.eventId === 'e1'));
  assert.equal(r.state.snoozed.e1, undefined);
});

test('a snoozed reminder does not fire before its time', () => {
  const ev = { id: 'e1', title: 'Sync', start: `${DAY}T14:00:00Z` };
  const brief = { lines: [], events: [ev] };
  const until = new Date(`${DAY}T13:30:00Z`).getTime();
  const state = { lastBriefDate: DAY, remindedDay: DAY, reminded: { e1: true }, snoozed: { e1: until } };
  const r = planNotifications({ ...base, now: new Date(`${DAY}T13:05:00Z`), brief, state });
  assert.equal(r.notifications.filter((n) => n.type === 'reminder').length, 0);
  assert.equal(r.state.snoozed.e1, until); // still pending
});

test('the reminded set resets on a new day', () => {
  const brief = { lines: [], events: [{ id: 'e1', title: 'Sync', start: `2026-08-04T13:10:00Z` }] };
  const state = { lastBriefDate: '2026-08-04', remindedDay: DAY, reminded: { e1: true } }; // stale day
  const r = planNotifications({ ...base, now: new Date('2026-08-04T13:00:00Z'), brief, state });
  assert.equal(r.state.remindedDay, '2026-08-04');
  assert.ok(r.notifications.find((n) => n.type === 'reminder')); // reminded fresh after reset
});
