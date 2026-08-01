'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { Dashboard, routeCommand } = require('../src/dashboard/core');
const { analyze } = require('../src/services/scheduleOptimizer');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const ev = (id, title, s, e, extra = {}) => ({
  id,
  provider: 'google',
  title,
  start: `2026-08-03T${s}:00Z`, // Monday
  end: `2026-08-03T${e}:00Z`,
  status: 'confirmed',
  ...extra,
});

/** In-memory calendar mirroring the real service's update semantics. */
function makeFakeCalendar(initial) {
  const store = new Map(initial.map((e) => [e.id, { ...e }]));
  return {
    store,
    async getEvents() {
      return [...store.values()].map((e) => ({ ...e }));
    },
    async updateEvent(_provider, id, changes) {
      const e = store.get(id);
      if (!e) throw Object.assign(new Error('event not found'), { code: 'API_ERROR' });
      if (changes.start && changes.end) {
        e.start = changes.start;
        e.end = changes.end;
      } else if (changes.start) {
        const dur = new Date(e.end) - new Date(e.start);
        e.start = changes.start;
        e.end = new Date(new Date(changes.start).getTime() + dur).toISOString();
      }
      store.set(id, e);
      return { ...e };
    },
    async createEvent(_provider, input) {
      const id = `new-${store.size + 1}`;
      const e = {
        id,
        provider: 'google',
        title: input.title,
        start: input.start,
        end: input.end || input.start,
        status: 'confirmed',
      };
      store.set(id, e);
      return { ...e };
    },
    async deleteEvent(_provider, id) {
      store.delete(id);
      return { id, deleted: true };
    },
    assertProvider() {},
  };
}

/** Scripted terminal I/O that records everything printed. */
function makeFakeIO({ hotkeys, confirms = [] }) {
  const out = [];
  let hk = 0;
  let cf = 0;
  return {
    output: out,
    text: () => out.join('\n'),
    print: (m = '') => out.push(String(m)),
    waitForHotkey: async () => hotkeys[hk++],
    confirm: async (question) => {
      out.push(String(question)); // the real terminal shows the prompt
      return confirms[cf++];
    },
  };
}

const makeFakeVoice = (scripts) => {
  let i = 0;
  return { listen: async () => scripts[i++] };
};

/** A week with a double-booking + two events inside the 9-11 deep-work block. */
const problemWeek = () => [
  ev('a', 'Standup', '09:30', '09:45'),
  ev('b', 'Design review', '10:00', '11:00'),
  ev('c', '1:1 with Alice', '13:00', '13:30'),
  ev('d', '1:1 with Bob', '13:20', '13:50'), // overlaps c
  ev('e', 'Roadmap sync', '15:00', '15:35'),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('routeCommand classifies utterances', () => {
  assert.equal(routeCommand('Optimize my day').type, 'optimize');
  assert.equal(routeCommand('Optimize my day').scope, 'day');
  assert.equal(routeCommand('optimize my week please').scope, 'week');
  assert.equal(routeCommand('quit').type, 'quit');
  assert.equal(routeCommand('help').type, 'help');
  assert.equal(routeCommand('what is the weather').type, 'unknown');
  assert.equal(routeCommand('add lunch', { action: 'add', event_details: {} }).type, 'event');
});

test('full loop: hotkey -> "Optimize my day" -> Before/After -> confirm -> save', async () => {
  const cal = makeFakeCalendar(problemWeek());
  const io = makeFakeIO({ hotkeys: ['go', 'q'], confirms: [true] });
  const dash = new Dashboard({
    io,
    voice: makeFakeVoice([{ transcript: 'Optimize my day', intent: null }]),
    calendar: cal,
    provider: 'google',
  });

  await dash.run();
  const text = io.text();

  // The side-by-side view was shown before saving.
  assert.match(text, /BEFORE/);
  assert.match(text, /AFTER/);
  assert.match(text, /Apply these 5 change\(s\)\?/);
  assert.match(text, /Saved: 5 updated, 0 failed/);

  // The calendar was actually rewritten to a clean schedule.
  const after = await cal.getEvents();
  const counts = analyze(after).counts;
  assert.equal(counts.conflicts, 0, 'no conflicts remain');
  assert.equal(counts.deepWorkViolations, 0, 'deep-work block is clear');

  // Something actually moved.
  const standup = after.find((e) => e.id === 'a');
  assert.notEqual(standup.start, '2026-08-03T09:30:00Z', 'standup was moved out of 9-11');
});

test('abort at confirmation leaves the calendar untouched', async () => {
  const original = problemWeek();
  const cal = makeFakeCalendar(original);
  const io = makeFakeIO({ hotkeys: ['go', 'q'], confirms: [false] });
  const dash = new Dashboard({
    io,
    voice: makeFakeVoice([{ transcript: 'Optimize my day', intent: null }]),
    calendar: cal,
    provider: 'google',
  });

  await dash.run();

  assert.match(io.text(), /No changes made/);
  const after = await cal.getEvents();
  for (const o of original) {
    const now = after.find((e) => e.id === o.id);
    assert.equal(now.start, o.start, `${o.id} start unchanged`);
    assert.equal(now.end, o.end, `${o.id} end unchanged`);
  }
});

test('already-optimized schedule proposes no changes', async () => {
  const clean = [
    ev('c', '1:1 with Alice', '13:00', '13:30'),
    ev('d', 'Planning', '13:45', '14:15'),
    ev('e', 'Roadmap sync', '14:30', '15:00'),
  ];
  const cal = makeFakeCalendar(clean);
  const io = makeFakeIO({ hotkeys: ['go', 'q'], confirms: [] });
  const dash = new Dashboard({
    io,
    voice: makeFakeVoice([{ transcript: 'optimize my day', intent: null }]),
    calendar: cal,
    provider: 'google',
  });

  await dash.run();
  assert.match(io.text(), /already optimized/);
});

test('voice "add" command creates an event after confirmation', async () => {
  const cal = makeFakeCalendar([]);
  const io = makeFakeIO({ hotkeys: ['go', 'q'], confirms: [true] });
  const intent = {
    action: 'add',
    event_details: { title: 'Dentist', date: '2026-08-04', start_time: '14:00', end_time: '15:00' },
  };
  const dash = new Dashboard({
    io,
    voice: makeFakeVoice([{ transcript: 'add dentist tomorrow at 2pm', intent }]),
    calendar: cal,
    provider: 'google',
  });

  await dash.run();
  assert.match(io.text(), /Event added/);
  const events = await cal.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Dentist');
  assert.equal(events[0].start, '2026-08-04T14:00:00.000Z');
});
