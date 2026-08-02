'use strict';

// Enable the Claude path BEFORE requiring config/modules.
process.env.ANTHROPIC_API_KEY = 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');

// Patch the client factory before claudeIntent destructures it.
const anthropicClient = require('../src/services/anthropicClient');
let lastArgs = null;
let fakeReply = {};
let shouldThrow = false;
anthropicClient.getAnthropic = () => ({
  messages: {
    create: async (args) => {
      lastArgs = args;
      if (shouldThrow) throw new Error('boom');
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fakeReply) }] };
    },
  },
});

const claudeIntent = require('../src/services/claudeIntent');
const { buildCommand } = require('../src/services/voiceCommand');

const REF = new Date('2026-08-03T09:00:00Z');

test('adaptToParsed maps each action to the internal shape', () => {
  assert.deepEqual(claudeIntent.adaptToParsed({ action: 'optimize', scope: 'week' }), {
    type: 'optimize', scope: 'week', transcript: '',
  });
  const add = claudeIntent.adaptToParsed({
    action: 'add', title: 'Dentist', start: '2026-08-04T14:00:00-05:00', end: null, time_specified: true,
  });
  assert.equal(add.type, 'add');
  assert.equal(add.title, 'Dentist');
  assert.equal(add.start, '2026-08-04T14:00:00-05:00');
  assert.equal(add.end, '2026-08-04T20:00:00.000Z'); // 14:00-05:00 = 19:00Z, +60m
  assert.equal(add.timeSpecified, true);

  const move = claudeIntent.adaptToParsed({
    action: 'move', title: 'standup', start: '2026-08-03T16:00:00-05:00', end: null, date_specified: false, time_specified: true,
  });
  assert.equal(move.when.dateSpecified, false);
  assert.equal(move.when.timeSpecified, true);

  const task = claudeIntent.adaptToParsed({
    action: 'add_task', title: 'Budget', estimated_minutes: 45, priority: 'high', deadline: '2026-08-07',
  });
  assert.deepEqual(
    { t: task.type, m: task.estimatedMinutes, p: task.priority, d: task.deadline },
    { t: 'add_task', m: 45, p: 'high', d: '2026-08-07' }
  );

  assert.equal(claudeIntent.adaptToParsed({ action: 'weird' }).type, 'unknown');
});

test('adaptToParsed maps the query + edit actions', () => {
  assert.deepEqual(claudeIntent.adaptToParsed({ action: 'show_schedule', scope: 'week', date: '2026-08-07' }), {
    type: 'show_schedule', scope: 'week', date: '2026-08-07', transcript: '',
  });
  assert.deepEqual(claudeIntent.adaptToParsed({ action: 'show_free', scope: 'day', date: null }), {
    type: 'show_free', scope: 'day', date: null, transcript: '',
  });

  const edit = claudeIntent.adaptToParsed({
    action: 'edit', title: 'standup', new_title: 'Team Sync', estimated_minutes: 30, time_specified: false, date_specified: false,
  });
  assert.equal(edit.type, 'edit');
  assert.equal(edit.newTitle, 'Team Sync');
  assert.equal(edit.durationMinutes, 30);

  const editTask = claudeIntent.adaptToParsed({
    action: 'edit_task', title: 'budget', priority: 'high', done: true, estimated_minutes: null,
  });
  assert.deepEqual(
    { t: editTask.type, p: editTask.priority, d: editTask.done },
    { t: 'edit_task', p: 'high', d: true }
  );
});

test('parse() sends a dated system prompt + JSON schema and returns adapted intent', async () => {
  fakeReply = { action: 'add', title: 'Lunch', start: '2026-08-04T12:00:00+00:00', end: null, time_specified: true };
  shouldThrow = false;
  const parsed = await claudeIntent.parse('add lunch tomorrow at noon', { referenceDate: REF, tzOffsetMinutes: 0 });

  assert.equal(parsed.type, 'add');
  assert.equal(parsed.title, 'Lunch');
  // Request was well-formed:
  assert.equal(lastArgs.model, 'claude-sonnet-5');
  assert.deepEqual(lastArgs.thinking, { type: 'disabled' });
  assert.equal(lastArgs.output_config.format.type, 'json_schema');
  assert.match(lastArgs.system, /2026-08-03/); // today's date is in the prompt
});

test('buildCommand uses Claude and tags engine="claude"', async () => {
  fakeReply = { action: 'add', title: 'Sync', start: '2026-08-04T10:00:00+00:00', end: null, time_specified: true };
  shouldThrow = false;
  const cmd = await buildCommand('google', 'set up a sync tomorrow at 10', { referenceDate: REF });
  assert.equal(cmd.type, 'add');
  assert.equal(cmd.event.title, 'Sync');
  assert.equal(cmd.engine, 'claude');
});

test('buildCommand falls back to the rules parser when Claude throws', async () => {
  shouldThrow = true;
  const cmd = await buildCommand('google', 'add dentist tomorrow at 2pm', { referenceDate: REF });
  assert.equal(cmd.type, 'add');
  assert.equal(cmd.engine, 'rules-fallback');
});
