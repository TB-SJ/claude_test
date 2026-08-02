'use strict';

const { getAnthropic } = require('./anthropicClient');
const { config, providerConfigured } = require('../config');
const { addMinutes } = require('./calendarUtils');
const logger = require('../logger');

// Strict output schema — guarantees Claude returns valid, parseable JSON.
const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['add', 'remove', 'move', 'optimize', 'add_task', 'plan_tasks', 'unknown'] },
    scope: { anyOf: [{ type: 'string', enum: ['day', 'week'] }, { type: 'null' }] },
    title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    start: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    end: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    date_specified: { type: 'boolean' },
    time_specified: { type: 'boolean' },
    estimated_minutes: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    priority: { anyOf: [{ type: 'string', enum: ['high', 'med', 'low'] }, { type: 'null' }] },
    deadline: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'action', 'scope', 'title', 'start', 'end',
    'date_specified', 'time_specified', 'estimated_minutes', 'priority', 'deadline',
  ],
};

function isEnabled() {
  return providerConfigured.anthropic();
}

/** "-05:00" style offset string from minutes east of UTC. */
function offsetString(offsetMin) {
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function buildSystemPrompt(now, offsetMin) {
  const shifted = new Date(now.getTime() + offsetMin * 60000);
  const localDate = shifted.toISOString().slice(0, 10);
  const weekday = shifted.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const off = offsetString(offsetMin);
  return [
    'You convert a spoken calendar/task command into a single structured intent.',
    `Right now it is ${localDate} (${weekday}), timezone offset ${off}.`,
    'Resolve relative dates/times ("tomorrow", "next Friday", "in an hour", "this afternoon") to absolute values.',
    '',
    'Rules for the fields:',
    `- start / end: ISO 8601 with the ${off} offset (e.g. ${localDate}T14:00:00${off}). null if not applicable.`,
    '- action "optimize": set scope to "day" or "week" (default "day").',
    '- action "add": a new calendar event. Provide title and start; set time_specified=true only if a clock time was given; end optional.',
    '- action "move": reschedule an existing event. title = words identifying which event. start = the new time. date_specified=true only if the user named a day (not just a time). end optional.',
    '- action "remove": delete an existing event. title = words identifying it.',
    '- action "add_task": a flexible to-do (no fixed time). title, estimated_minutes (default 30), priority (high/med/low), deadline (YYYY-MM-DD or null).',
    '- action "plan_tasks": user wants their tasks fitted into free time ("plan my day", "schedule my tasks").',
    '- action "unknown": anything not about the calendar or tasks.',
    'Never invent details that were not said; use null.',
  ].join('\n');
}

/** Maps Claude\'s flat JSON to the internal parsed shape the resolver expects. */
function adaptToParsed(raw) {
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const action = raw && typeof raw === 'object' ? raw.action : 'unknown';

  switch (action) {
    case 'optimize':
      return { type: 'optimize', scope: raw.scope === 'week' ? 'week' : 'day', transcript: '' };
    case 'plan_tasks':
      return { type: 'plan_tasks', transcript: '' };
    case 'add_task':
      return {
        type: 'add_task',
        title: clean(raw.title),
        estimatedMinutes: Number.isFinite(raw.estimated_minutes) ? raw.estimated_minutes : 30,
        priority: ['high', 'med', 'low'].includes(raw.priority) ? raw.priority : 'med',
        deadline: clean(raw.deadline),
        transcript: '',
      };
    case 'add': {
      const start = clean(raw.start);
      const end = clean(raw.end) || (start ? addMinutes(start, 60) : null);
      return { type: 'add', title: clean(raw.title), start, end, timeSpecified: Boolean(raw.time_specified && start), transcript: '' };
    }
    case 'remove':
      return { type: 'remove', title: clean(raw.title), transcript: '' };
    case 'move': {
      const start = clean(raw.start);
      return {
        type: 'move',
        title: clean(raw.title),
        when: start
          ? { start, end: clean(raw.end), dateSpecified: Boolean(raw.date_specified), timeSpecified: Boolean(raw.time_specified) }
          : null,
        transcript: '',
      };
    }
    default:
      return { type: 'unknown', transcript: '' };
  }
}

/**
 * Parses a transcript into the internal intent shape using Claude. Throws on any
 * API/parse error so the caller can fall back to the rules parser.
 */
async function parse(transcript, { referenceDate = new Date(), tzOffsetMinutes = 0 } = {}) {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 512,
    thinking: { type: 'disabled' }, // fast, cheap — this is a lightweight extraction
    system: buildSystemPrompt(referenceDate, tzOffsetMinutes),
    output_config: { format: { type: 'json_schema', schema: INTENT_SCHEMA } },
    messages: [{ role: 'user', content: String(transcript || '') }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined the request.');
  }
  const block = (response.content || []).find((b) => b.type === 'text');
  const raw = JSON.parse(block ? block.text : '{}');
  logger.info('voice.intent via claude', { action: raw && raw.action });
  return adaptToParsed(raw);
}

module.exports = { isEnabled, parse, adaptToParsed, buildSystemPrompt, INTENT_SCHEMA };
