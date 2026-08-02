'use strict';

const chrono = require('chrono-node');
const calendar = require('./calendar');
const { optimize } = require('./scheduleOptimizer');
const { addMinutes, diffMinutes } = require('./calendarUtils');

// Action keyword detection. "optimize" is checked first (most specific);
// otherwise the earliest-matching action keyword in the sentence wins.
const OPTIMIZE_RE = /\b(optimi[sz]e|rearrange|tidy up|clean up)\b/i;
const ACTIONS = [
  { type: 'remove', re: /\b(remove|delete|cancel|clear|drop|get rid of)\b/i },
  { type: 'move', re: /\b(move|reschedule|resched|shift|push|bump)\b/i },
  { type: 'add', re: /\b(add|create|schedule|new|book|set up|put|make)\b/i },
];

function detectAction(text) {
  if (OPTIMIZE_RE.test(text)) return { type: 'optimize' };
  let best = null;
  for (const a of ACTIONS) {
    const m = a.re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { type: a.type, keyword: m[0], index: m.index };
  }
  return best || { type: 'unknown' };
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips the action keyword and date phrase, leaving a clean event title. */
function extractTitle(text, keyword, dateText) {
  let t = text;
  if (dateText) t = t.replace(dateText, ' ');
  if (keyword) t = t.replace(new RegExp(`\\b${escapeReg(keyword)}\\b`, 'i'), ' ');
  t = t.replace(/\bplease\b/gi, ' ').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/^(my|the|a|an|to|on|at|for|new|from)\s+/i, '').trim();
  } while (t !== prev);
  do {
    prev = t;
    t = t.replace(/\s+(to|on|at|for|from)$/i, '').trim();
  } while (t !== prev);
  return t;
}

function parseWhen(text, referenceDate) {
  const results = chrono.parse(text, referenceDate, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  const dateSpecified =
    r.start.isCertain('day') || r.start.isCertain('weekday') || r.start.isCertain('month');
  const timeSpecified = r.start.isCertain('hour');
  return {
    text: r.text,
    start: r.start.date(),
    end: r.end ? r.end.date() : null,
    dateSpecified,
    timeSpecified,
  };
}

/**
 * Pure parse of a spoken command into a structured intent. No calendar access.
 *
 * @returns one of:
 *   { type:'optimize', scope:'day'|'week' }
 *   { type:'add', title, start(ISO)|null, end(ISO)|null, timeSpecified }
 *   { type:'remove', title }
 *   { type:'move', title, when:{start,end,dateSpecified,timeSpecified}|null }
 *   { type:'unknown' }
 */
function parseCommand(transcript, referenceDate = new Date()) {
  const text = String(transcript || '').trim();
  if (!text) return { type: 'unknown', transcript: text };

  const action = detectAction(text);
  if (action.type === 'optimize') {
    return { type: 'optimize', scope: /\bweek\b/i.test(text) ? 'week' : 'day', transcript: text };
  }
  if (action.type === 'unknown') return { type: 'unknown', transcript: text };

  const when = parseWhen(text, referenceDate);
  const title = extractTitle(text, action.keyword, when && when.text);

  if (action.type === 'add') {
    const start = when ? when.start : null;
    const end = when && when.end ? when.end : start ? new Date(addMinutes(start.toISOString(), 60)) : null;
    return {
      type: 'add',
      title,
      start: start ? start.toISOString() : null,
      end: end ? end.toISOString() : null,
      timeSpecified: Boolean(when && when.timeSpecified),
      transcript: text,
    };
  }
  if (action.type === 'remove') {
    return { type: 'remove', title, transcript: text };
  }
  // move
  return {
    type: 'move',
    title,
    when: when
      ? {
          start: when.start.toISOString(),
          end: when.end ? when.end.toISOString() : null,
          dateSpecified: when.dateSpecified,
          timeSpecified: when.timeSpecified,
        }
      : null,
    transcript: text,
  };
}

// ---------------------------------------------------------------------------
// Resolution against the live calendar (async)
// ---------------------------------------------------------------------------

/** Finds upcoming timed events whose title contains `hint` (next ~21 days). */
async function findByTitle(provider, hint, referenceDate) {
  const q = String(hint || '').toLowerCase().trim();
  if (!q) return [];
  const startISO = referenceDate.toISOString();
  const endISO = new Date(referenceDate.getTime() + 21 * 86400000).toISOString();
  const events = await calendar.getEvents(provider, { start: startISO, end: endISO });
  return events
    .filter((e) => e.start.includes('T') && (e.title || '').toLowerCase().includes(q))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

/**
 * Parses the transcript and resolves it into an actionable, confirmable command
 * (fetching/optimizing the calendar as needed). Never writes — the caller
 * confirms and then calls the normal calendar/schedule endpoints.
 */
async function buildCommand(provider, transcript, { referenceDate = new Date(), tzOffsetMinutes = 0 } = {}) {
  const parsed = parseCommand(transcript, referenceDate);

  if (parsed.type === 'optimize') {
    const events = await calendar.getEvents(provider, { range: parsed.scope });
    const opt = optimize(events, { tzOffsetMinutes });
    return {
      type: 'optimize',
      scope: parsed.scope,
      transcript: parsed.transcript,
      proposal: {
        rules: opt.rules,
        analysis: { counts: opt.analysis.counts },
        moves: opt.moves,
        summary: opt.summary,
        events,
      },
    };
  }

  if (parsed.type === 'add') {
    if (!parsed.title) return { type: 'add', error: 'need_title', transcript };
    if (!parsed.start || !parsed.timeSpecified) return { type: 'add', error: 'need_time', title: parsed.title, transcript };
    return {
      type: 'add',
      transcript,
      event: { title: parsed.title, start: parsed.start, end: parsed.end },
    };
  }

  if (parsed.type === 'remove') {
    if (!parsed.title) return { type: 'remove', error: 'need_title', transcript };
    const matches = await findByTitle(provider, parsed.title, referenceDate);
    if (matches.length === 0) return { type: 'remove', error: 'not_found', title: parsed.title, transcript };
    return { type: 'remove', transcript, match: matches[0], otherMatches: matches.length - 1 };
  }

  if (parsed.type === 'move') {
    if (!parsed.title) return { type: 'move', error: 'need_title', transcript };
    if (!parsed.when) return { type: 'move', error: 'need_time', title: parsed.title, transcript };
    const matches = await findByTitle(provider, parsed.title, referenceDate);
    if (matches.length === 0) return { type: 'move', error: 'not_found', title: parsed.title, transcript };
    const target = matches[0];

    let start;
    if (parsed.when.dateSpecified) {
      start = parsed.when.start; // full date+time spoken
    } else {
      // Time-only ("move to 4pm"): keep the event's existing date, new time.
      const day = target.start.slice(0, 10);
      const t = new Date(parsed.when.start);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      start = new Date(`${day}T${hh}:${mm}:00${offsetSuffix(t)}`).toISOString();
    }
    // Preserve original duration unless an explicit end was spoken.
    const end = parsed.when.end
      ? parsed.when.end
      : addMinutes(start, diffMinutes(target.start, target.end));
    return { type: 'move', transcript, match: target, otherMatches: matches.length - 1, to: { start, end } };
  }

  return { type: 'unknown', transcript };
}

/** Local timezone offset suffix (e.g. "-05:00") for a Date, for ISO building. */
function offsetSuffix(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

module.exports = { parseCommand, buildCommand, findByTitle };
