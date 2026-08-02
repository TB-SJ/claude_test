'use strict';

const { getAnthropic } = require('./anthropicClient');
const { config, providerConfigured } = require('../config');
const { diffMinutes } = require('./calendarUtils');
const { resolveRules, parseHM, formatHM } = require('./scheduleRules');
const {
  analyze,
  isTimed,
  isCancelled,
  isPinned,
  localParts,
  fromLocal,
} = require('./scheduleOptimizer');
const logger = require('../logger');

// Claude returns only a new local start ("HH:MM") per event it wants to move —
// the server does all the timezone math and preserves each event's duration.
// This keeps Claude out of error-prone ISO/offset arithmetic entirely.
const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    moves: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          new_start: { type: 'string' }, // local wall-clock "HH:MM"
          reason: { type: 'string' },
        },
        required: ['id', 'new_start', 'reason'],
      },
    },
  },
  required: ['moves'],
};

function isEnabled() {
  return providerConfigured.anthropic();
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Compact, Claude-friendly view of a timed event in local wall-clock time. */
function describeEvent(ev, off, rules) {
  const s = localParts(ev.start, off);
  const e = localParts(ev.end, off);
  return {
    id: ev.id,
    title: ev.title || '(untitled)',
    day: `${WEEKDAYS[s.weekday]} ${s.dayKey}`,
    start: formatHM(s.minute),
    end: formatHM(e.minute),
    minutes: diffMinutes(ev.start, ev.end),
    pinned: isPinned(ev, rules),
  };
}

function buildSystemPrompt(rules) {
  const dw = rules.deepWork;
  const mw = rules.meetingWindow;
  return [
    'You rearrange a weekly calendar into a cleaner schedule. You will get a JSON',
    'list of events (local wall-clock times) and must return the moves that improve it.',
    '',
    'Hard constraints (a proposal that breaks any of these is discarded):',
    `- Keep every event on its ORIGINAL day. Only change the start time.`,
    `- Never change an event's duration, and never move an event marked "pinned": true.`,
    `- Stay within work hours ${rules.workday.start}–${rules.workday.end}.`,
    `- No two events may overlap; leave at least ${rules.bufferMinutes} minutes between them.`,
    dw.enabled
      ? `- Protect the deep-work block ${dw.start}–${dw.end} on weekdays — no meetings inside it.`
      : '- No deep-work block configured.',
    '',
    'Preferences (apply where they do not break a hard constraint):',
    mw.enabled ? `- Group meetings into ${mw.start}–${mw.end} where reasonable.` : '',
    '- Keep naturally time-bound events near their usual time (e.g. lunch around midday).',
    '- Prefer fewer, larger free blocks over many small fragmented gaps.',
    '- Do not move an event that is already in a good spot — only return moves that help.',
    '',
    'For each event you move, return its id, the new local start as "HH:MM"',
    '(24-hour), and a short reason. Return an empty list if nothing should move.',
  ].filter(Boolean).join('\n');
}

/** Calls Claude for a proposal. Throws on any API/parse error. */
async function propose(events, rules, { referenceDate = new Date() } = {}) {
  const off = rules.tzOffsetMinutes;
  const timed = events
    .filter((e) => isTimed(e) && !isCancelled(e))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const payload = timed.map((e) => describeEvent(e, off, rules));

  const client = getAnthropic();
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system: buildSystemPrompt(rules),
    output_config: { format: { type: 'json_schema', schema: PROPOSAL_SCHEMA } },
    messages: [{ role: 'user', content: `Today is ${referenceDate.toISOString().slice(0, 10)}.\nEvents:\n${JSON.stringify(payload, null, 2)}` }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined the request.');
  const block = (response.content || []).find((b) => b.type === 'text');
  const raw = JSON.parse(block ? block.text : '{}');
  return Array.isArray(raw.moves) ? raw.moves : [];
}

/** Applies validated {id,to} moves to a copy of the events array. */
function applyMoves(events, moves) {
  const byId = new Map(moves.map((m) => [m.id, m.to]));
  return events.map((e) => (byId.has(e.id) ? { ...e, start: byId.get(e.id).start, end: byId.get(e.id).end } : e));
}

/**
 * Turns Claude's raw proposal into concrete moves and validates the *result*
 * with the deterministic analyzer. Returns a result object shaped exactly like
 * scheduleOptimizer.optimize(), or null if the proposal is unusable (so the
 * caller can fall back to the rules engine). The LLM never bypasses the rules —
 * it only suggests; this function is the gate.
 */
function buildValidatedResult(events, proposedMoves, rules) {
  const off = rules.tzOffsetMinutes;
  const workStart = parseHM(rules.workday.start);
  const workEnd = parseHM(rules.workday.end);
  const timed = events.filter((e) => isTimed(e) && !isCancelled(e));
  const byId = new Map(timed.map((e) => [e.id, e]));

  const moves = [];
  for (const pm of proposedMoves || []) {
    if (!pm || typeof pm.id !== 'string') return null;
    const ev = byId.get(pm.id);
    if (!ev) return null; // hallucinated id → reject whole proposal
    if (isPinned(ev, rules)) return null; // tried to move a pinned event

    let startMin;
    try {
      startMin = parseHM(pm.new_start);
    } catch (_) {
      return null; // malformed time
    }
    const duration = diffMinutes(ev.start, ev.end);
    const endMin = startMin + duration;
    if (startMin < workStart || endMin > workEnd) return null; // outside work hours

    const dayKey = localParts(ev.start, off).dayKey;
    const newStart = fromLocal(dayKey, startMin, off);
    const newEnd = fromLocal(dayKey, endMin, off);
    if (new Date(newStart).getTime() === new Date(ev.start).getTime()) continue; // no-op

    const reason = typeof pm.reason === 'string' && pm.reason.trim()
      ? pm.reason.trim().slice(0, 140)
      : 'Rearranged for a cleaner day';
    moves.push({
      id: ev.id,
      provider: ev.provider,
      title: ev.title,
      from: { start: ev.start, end: ev.end },
      to: { start: newStart, end: newEnd },
      reasons: [reason],
    });
  }

  // The deterministic guarantee: apply the moves and require the analyzer to
  // find no conflicts, no buffer violations, and no deep-work intrusions.
  const post = analyze(applyMoves(events, moves), rules);
  if (post.counts.conflicts > 0 || post.counts.bufferIssues > 0 || post.counts.deepWorkViolations > 0) {
    return null;
  }

  moves.sort((a, b) => new Date(a.to.start) - new Date(b.to.start));
  const analysisBefore = analyze(events, rules);
  return {
    rules,
    analysis: analysisBefore,
    moves,
    unplaceable: [],
    summary: {
      totalEvents: timed.length,
      movable: timed.filter((e) => !isPinned(e, rules)).length,
      pinned: timed.filter((e) => isPinned(e, rules)).length,
      proposedMoves: moves.length,
      unchanged: timed.length - moves.length,
      unplaceable: 0,
    },
  };
}

/**
 * Full Claude-optimize flow: propose → validate. Throws if Claude errors or the
 * proposal fails validation, so the caller can fall back to optimize().
 */
async function optimizeWithClaude(events, ruleOverrides = {}, opts = {}) {
  const rules = resolveRules(ruleOverrides);
  const proposed = await propose(events, rules, opts);
  const result = buildValidatedResult(events, proposed, rules);
  if (!result) {
    logger.warn('Claude optimize proposal failed validation; falling back to rules');
    throw new Error('Claude proposal failed validation.');
  }
  logger.info('schedule.optimize via claude', { moves: result.moves.length });
  return result;
}

module.exports = {
  isEnabled,
  optimizeWithClaude,
  // exported for tests:
  propose,
  buildValidatedResult,
  buildSystemPrompt,
  PROPOSAL_SCHEMA,
};
