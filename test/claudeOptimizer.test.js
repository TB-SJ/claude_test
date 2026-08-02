'use strict';

// Enable the Claude path BEFORE requiring config/modules.
process.env.ANTHROPIC_API_KEY = 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');

// Patch the client factory before claudeOptimizer uses it.
const anthropicClient = require('../src/services/anthropicClient');
let lastArgs = null;
let fakeMoves = { moves: [] };
let shouldThrow = false;
anthropicClient.getAnthropic = () => ({
  messages: {
    create: async (args) => {
      lastArgs = args;
      if (shouldThrow) throw new Error('boom');
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fakeMoves) }] };
    },
  },
});

const claudeOptimizer = require('../src/services/claudeOptimizer');
const { resolveRules } = require('../src/services/scheduleRules');

// A weekday (Wed 2026-08-05) with two morning meetings that intrude on the
// 09:00–11:00 deep-work block. tzOffset 0 → UTC is local.
const RULES = { tzOffsetMinutes: 0 };
function events() {
  return [
    { id: 'a', provider: 'google', title: 'Standup', start: '2026-08-05T09:30:00Z', end: '2026-08-05T10:00:00Z' },
    { id: 'b', provider: 'google', title: 'Review', start: '2026-08-05T10:15:00Z', end: '2026-08-05T11:00:00Z' },
  ];
}

test('buildValidatedResult accepts a clean proposal and preserves durations', () => {
  const rules = resolveRules(RULES);
  // Move both meetings into the afternoon window, keeping their durations.
  const result = claudeOptimizer.buildValidatedResult(
    events(),
    [
      { id: 'a', new_start: '13:00', reason: 'Group into afternoon' },
      { id: 'b', new_start: '13:45', reason: 'Group into afternoon' },
    ],
    rules
  );
  assert.ok(result, 'expected a valid result');
  assert.equal(result.moves.length, 2);
  const a = result.moves.find((m) => m.id === 'a');
  assert.equal(a.to.start, '2026-08-05T13:00:00.000Z');
  assert.equal(a.to.end, '2026-08-05T13:30:00.000Z'); // 30-min duration preserved
  assert.equal(a.reasons[0], 'Group into afternoon');
});

test('buildValidatedResult rejects a proposal that creates an overlap', () => {
  const rules = resolveRules(RULES);
  // Both placed at 13:00 → they overlap; the analyzer must veto this.
  const result = claudeOptimizer.buildValidatedResult(
    events(),
    [
      { id: 'a', new_start: '13:00', reason: 'x' },
      { id: 'b', new_start: '13:00', reason: 'x' },
    ],
    rules
  );
  assert.equal(result, null);
});

test('buildValidatedResult rejects a move that lands inside the deep-work block', () => {
  const rules = resolveRules(RULES);
  const result = claudeOptimizer.buildValidatedResult(
    events(),
    [
      { id: 'a', new_start: '09:00', reason: 'x' }, // still inside 09:00–11:00
      { id: 'b', new_start: '13:00', reason: 'x' },
    ],
    rules
  );
  assert.equal(result, null);
});

test('buildValidatedResult rejects a hallucinated event id', () => {
  const rules = resolveRules(RULES);
  const result = claudeOptimizer.buildValidatedResult(
    events(),
    [{ id: 'does-not-exist', new_start: '13:00', reason: 'x' }],
    rules
  );
  assert.equal(result, null);
});

test('buildValidatedResult rejects a move outside work hours', () => {
  const rules = resolveRules(RULES);
  const result = claudeOptimizer.buildValidatedResult(
    events(),
    [
      { id: 'a', new_start: '22:00', reason: 'x' }, // after 21:00 workday end
      { id: 'b', new_start: '13:00', reason: 'x' },
    ],
    rules
  );
  assert.equal(result, null);
});

test('optimizeWithClaude sends schema + returns a validated result', async () => {
  shouldThrow = false;
  fakeMoves = {
    moves: [
      { id: 'a', new_start: '13:00', reason: 'Group into afternoon' },
      { id: 'b', new_start: '13:45', reason: 'Group into afternoon' },
    ],
  };
  const result = await claudeOptimizer.optimizeWithClaude(events(), RULES, {
    referenceDate: new Date('2026-08-05T08:00:00Z'),
  });
  assert.equal(result.moves.length, 2);
  assert.equal(lastArgs.output_config.format.type, 'json_schema');
  assert.deepEqual(lastArgs.thinking, { type: 'disabled' });
  assert.match(lastArgs.system, /deep-work/i);
});

test('optimizeWithClaude throws when the proposal fails validation (caller falls back)', async () => {
  shouldThrow = false;
  fakeMoves = { moves: [{ id: 'a', new_start: '13:00', reason: 'x' }, { id: 'b', new_start: '13:00', reason: 'x' }] };
  await assert.rejects(
    () => claudeOptimizer.optimizeWithClaude(events(), RULES, { referenceDate: new Date('2026-08-05T08:00:00Z') }),
    /failed validation/
  );
});

test('optimizeWithClaude throws when the API errors (caller falls back)', async () => {
  shouldThrow = true;
  await assert.rejects(
    () => claudeOptimizer.optimizeWithClaude(events(), RULES, { referenceDate: new Date('2026-08-05T08:00:00Z') }),
    /boom/
  );
});
