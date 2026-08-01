'use strict';

const { getOpenAI } = require('./openaiClient');
const { config } = require('../config');
const { apiError, validationError } = require('../errors');
const logger = require('../logger');

const ACTIONS = ['add', 'remove', 'move'];

// Common phrasings the model (or a user) might use, mapped to our three actions.
const ACTION_SYNONYMS = {
  create: 'add',
  new: 'add',
  schedule: 'add',
  book: 'add',
  delete: 'remove',
  cancel: 'remove',
  drop: 'remove',
  reschedule: 'move',
  update: 'move',
  change: 'move',
  shift: 'move',
};

function cleanString(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** Coerces a value to `YYYY-MM-DD` or null. */
function normalizeDate(v) {
  const s = cleanString(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Coerces a value to 24-hour `HH:MM` or null. */
function normalizeTime(v) {
  const s = cleanString(v);
  if (!s) return null;
  let m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (m) {
    const h = Math.min(23, parseInt(m[1], 10));
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  // Handle "3pm" / "3 pm" style.
  m = /^(\d{1,2})\s*(am|pm)$/i.exec(s);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (/pm/i.test(m[2])) h += 12;
    return `${String(h).padStart(2, '0')}:00`;
  }
  return null;
}

/**
 * Normalizes an arbitrary object into the strict intent schema. Exported so the
 * shape guarantees can be unit-tested without hitting the API.
 *
 * @returns {{action: ('add'|'remove'|'move'|null), event_details: {title, date, start_time, end_time}}}
 */
function normalizeIntent(raw) {
  const out = {
    action: null,
    event_details: { title: null, date: null, start_time: null, end_time: null },
  };
  if (!raw || typeof raw !== 'object') return out;

  let action = cleanString(raw.action);
  if (action) {
    action = action.toLowerCase();
    action = ACTION_SYNONYMS[action] || action;
    if (ACTIONS.includes(action)) out.action = action;
  }

  const d = raw.event_details && typeof raw.event_details === 'object' ? raw.event_details : {};
  out.event_details.title = cleanString(d.title);
  out.event_details.date = normalizeDate(d.date);
  out.event_details.start_time = normalizeTime(d.start_time);
  out.event_details.end_time = normalizeTime(d.end_time);
  return out;
}

function buildSystemPrompt(referenceDate) {
  const iso = referenceDate.toISOString().slice(0, 10);
  const weekday = referenceDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return [
    'You extract a single calendar command from the user\'s transcribed speech.',
    `Today is ${iso} (${weekday}). Resolve relative dates like "tomorrow" or "next Friday" to absolute dates.`,
    'Respond with ONLY a JSON object of exactly this shape:',
    '{',
    '  "action": "add" | "remove" | "move" | null,',
    '  "event_details": {',
    '    "title": string | null,',
    '    "date": "YYYY-MM-DD" | null,',
    '    "start_time": "HH:MM" (24-hour) | null,',
    '    "end_time": "HH:MM" (24-hour) | null',
    '  }',
    '}',
    'Use "add" to create, "remove" to delete/cancel, "move" to reschedule or change timing.',
    'Set any field you cannot determine to null. Never invent details that were not spoken.',
  ].join('\n');
}

/**
 * Passes transcribed text to a language model and returns the structured intent
 * JSON: { action, event_details: { title, date, start_time, end_time } }.
 *
 * @param {string} text            The user's utterance (e.g. from Whisper).
 * @param {object} [opts]
 * @param {Date}   [opts.referenceDate]  "Now" for resolving relative dates.
 */
async function extractIntent(text, { referenceDate } = {}) {
  const utterance = typeof text === 'string' ? text.trim() : '';
  if (!utterance) throw validationError('`text` is required to extract intent.');

  const now = referenceDate || new Date();
  try {
    const client = getOpenAI();
    const completion = await client.chat.completions.create({
      model: config.openai.chatModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(now) },
        { role: 'user', content: utterance },
      ],
    });

    const content = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      throw apiError('llm', 'extractIntent', new Error('Model returned non-JSON output.'), {
        content: content.slice(0, 300),
      });
    }
    const intent = normalizeIntent(parsed);
    logger.info('voice.intent extracted', { action: intent.action });
    return intent;
  } catch (err) {
    throw apiError('llm', 'extractIntent', err, { textPreview: utterance.slice(0, 120) });
  }
}

module.exports = { extractIntent, normalizeIntent, ACTIONS };
