'use strict';

const chrono = require('chrono-node');
const calendar = require('./calendar');
const taskStore = require('../taskStore');
const claudeIntent = require('./claudeIntent');
const logger = require('../logger');
const { optimize } = require('./scheduleOptimizer');
const { scheduleTasks } = require('./taskScheduler');
const { composeBrief } = require('./brief');
const { freeForDays, coveringWindow, weekdayKeys } = require('./freeTime');
const { addMinutes, diffMinutes } = require('./calendarUtils');

// Action keyword detection. "optimize" is checked first (most specific);
// otherwise the earliest-matching action keyword in the sentence wins.
const OPTIMIZE_RE = /\b(optimi[sz]e|rearrange|tidy up|clean up)\b/i;
const ACTIONS = [
  { type: 'remove', re: /\b(remove|delete|cancel|clear|drop|get rid of)\b/i },
  { type: 'move', re: /\b(move|reschedule|resched|shift|push|bump|change|update|reset)\b/i },
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
/** Extracts an estimated duration in minutes from spoken text. */
function extractDuration(text) {
  let m;
  if ((m = /\bfor\s+(an?|one)\s+hours?\b/i.exec(text)) || (m = /\b(an?|one)\s+hours?\b/i.exec(text))) {
    return { minutes: 60, text: m[0] };
  }
  if ((m = /\bhalf\s+(an\s+)?hour\b/i.exec(text))) return { minutes: 30, text: m[0] };
  if ((m = /(\d+)\s*(hours?|hrs?)\b/i.exec(text))) return { minutes: parseInt(m[1], 10) * 60, text: m[0] };
  if ((m = /(\d+)\s*(minutes?|mins?)\b/i.exec(text))) return { minutes: parseInt(m[1], 10), text: m[0] };
  return null;
}

function ymdLocal(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Trims filler words off a spoken phrase (e.g. "my standup" -> "standup"). */
function cleanPhrase(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(my|the|a|an|to)\s+/i, '').replace(/[,.;\s]+$/g, '').trim();
  return t;
}

/** Parses "add a task to X for 30 minutes by Friday" into a task intent. */
function parseAddTask(text, referenceDate) {
  const priority = /\b(urgent|important|high priority|asap)\b/i.test(text) ? 'high'
    : /\b(low priority|whenever|someday)\b/i.test(text) ? 'low' : 'med';
  let w = text
    .replace(/\bnote to self\b/i, ' ')
    .replace(/\bremember to\b/i, ' ')
    .replace(/\b(add|create|new|make|remember|note|put)\b/i, ' ')
    .replace(/\b(a|the)\s+(task|to-?do)\b|\b(task|to-?do)\b/i, ' ')
    .replace(/\b(urgent|important|high priority|asap|low priority|whenever|someday)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const dur = extractDuration(w);
  if (dur) w = w.replace(dur.text, ' ');

  let deadline = null;
  let dlText = '';
  const by = /\bby\b\s+(.+)$/i.exec(w);
  const src = by ? by[1] : w;
  const parsed = chrono.parse(src, referenceDate, { forwardDate: true });
  if (parsed.length) {
    deadline = ymdLocal(parsed[0].start.date());
    dlText = by ? `by ${parsed[0].text}` : parsed[0].text;
  }
  if (dlText) w = w.replace(dlText, ' ');

  let title = w.replace(/^(to|that|for|a|an|the)\s+/i, '').replace(/[,;.\s]+$/g, '').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = title;
    title = title.replace(/\s+(by|for|to)$/i, '').replace(/[,;.]+$/g, '').trim();
  } while (title !== prev);

  return {
    type: 'add_task',
    title,
    estimatedMinutes: dur ? dur.minutes : 30,
    priority,
    deadline,
    transcript: text,
  };
}

function parseCommand(transcript, referenceDate = new Date()) {
  const text = String(transcript || '').trim();
  if (!text) return { type: 'unknown', transcript: text };

  // Task commands take priority when they mention "task(s)" or "plan my day".
  if (/\bplan my day\b/i.test(text) || (/\b(plan|schedule|organi[sz]e)\b/i.test(text) && /\btasks?\b/i.test(text))) {
    return { type: 'plan_tasks', transcript: text };
  }
  const mentionsTask = /\b(tasks?|to-?dos?)\b/i.test(text);
  if (
    (mentionsTask && /\b(add|create|new|make|remember|note|put)\b/i.test(text)) ||
    /\bremember to\b/i.test(text) ||
    /\bnote to self\b/i.test(text)
  ) {
    return parseAddTask(text, referenceDate);
  }

  // Rename an event: "rename standup to team sync".
  let rn;
  if ((rn = /\brename\s+(.+?)\s+to\s+(.+)$/i.exec(text))) {
    return { type: 'edit', title: cleanPhrase(rn[1]), newTitle: cleanPhrase(rn[2]), transcript: text };
  }
  // Mark a task complete: "mark budget review as done".
  let md;
  if ((md = /\bmark\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)\b/i.exec(text))) {
    return { type: 'edit_task', title: cleanPhrase(md[1]), done: true, transcript: text };
  }

  // Daily brief: "how's my day", "brief me", "what does my day look like".
  if (/\bbrief\b/i.test(text)
      || /\bhow'?s?\s+(?:is\s+)?my\s+day\b/i.test(text)
      || /\bmy\s+day\s+(?:look|going)/i.test(text)
      || /\bsum(?:mari[sz]e|mary\s+of)\s+my\s+day\b/i.test(text)) {
    return { type: 'brief', transcript: text };
  }

  // Read-only queries. Free-time first (more specific than "show").
  const scope = /\bweek\b/i.test(text) ? 'week' : 'day';
  const queryWhen = parseWhen(text, referenceDate);
  const queryDate = queryWhen && queryWhen.dateSpecified ? ymdLocal(queryWhen.start) : null;
  if (/\bfree\b|\bavailable\b|\bavailability\b|\bopen (?:time|slots?)\b/i.test(text)
      && /\b(time|slots?|day|week|today|tomorrow|when|free|available)\b/i.test(text)) {
    return { type: 'show_free', scope, date: queryDate, transcript: text };
  }
  if (/\b(show|display|list|view|see|pull up|bring up|what'?s|what is|what do i have|do i have|agenda)\b/i.test(text)
      && /\b(schedule|calendar|agenda|events?|meetings?|day|week|today|tomorrow|on|have|got)\b/i.test(text)) {
    return { type: 'show_schedule', scope, date: queryDate, transcript: text };
  }

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

/**
 * Finds timed events whose title contains `hint`, searching from the start of
 * *today* (so events earlier today are still matchable) through ~21 days out.
 */
async function findByTitle(provider, hint, referenceDate) {
  const q = String(hint || '').toLowerCase().trim();
  if (!q) return [];
  const startOfToday = new Date(referenceDate);
  startOfToday.setHours(0, 0, 0, 0);
  const startISO = startOfToday.toISOString();
  const endISO = new Date(referenceDate.getTime() + 21 * 86400000).toISOString();
  const events = await calendar.getEvents(provider, { start: startISO, end: endISO });
  return events
    .filter((e) => e.start.includes('T') && (e.title || '').toLowerCase().includes(q))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

/** Finds a pending-first task whose title contains `hint`. */
function findTaskByTitle(hint) {
  const q = String(hint || '').toLowerCase().trim();
  if (!q) return null;
  const matches = taskStore.list().filter((t) => (t.title || '').toLowerCase().includes(q));
  if (!matches.length) return null;
  return matches.sort((a, b) => a.done - b.done)[0]; // prefer not-yet-done
}

/** Local YYYY-MM-DD for "now", given the client's UTC offset. */
function localTodayKey(referenceDate, offsetMin) {
  return new Date(referenceDate.getTime() + offsetMin * 60000).toISOString().slice(0, 10);
}

/** Friendly label for a queried day/week (week = rolling 7-day span). */
function rangeLabel(scope, dateKey, todayKey) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  const fmt = (x) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (scope === 'week') {
    const end = new Date(d);
    end.setUTCDate(d.getUTCDate() + 6);
    return `${fmt(d)} – ${fmt(end)}`;
  }
  if (dateKey === todayKey) return 'Today';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Parses the transcript and resolves it into an actionable, confirmable command.
 *
 * Uses Claude for natural-language understanding when configured, falling back
 * to the rules parser if Claude is unavailable or errors. Never writes — the
 * caller confirms and then calls the normal calendar/schedule endpoints. The
 * returned command carries an `engine` field ("claude" | "rules" | "rules-fallback").
 */
async function buildCommand(provider, transcript, { referenceDate = new Date(), tzOffsetMinutes = 0 } = {}) {
  let parsed;
  let engine;
  if (claudeIntent.isEnabled()) {
    try {
      parsed = await claudeIntent.parse(transcript, { referenceDate, tzOffsetMinutes });
      engine = 'claude';
    } catch (err) {
      logger.warn('Claude intent failed; using rules parser', { message: err.message });
      parsed = parseCommand(transcript, referenceDate);
      engine = 'rules-fallback';
    }
  } else {
    parsed = parseCommand(transcript, referenceDate);
    engine = 'rules';
  }

  const result = await resolveParsed(provider, parsed, { referenceDate, tzOffsetMinutes, transcript });
  if (result && typeof result === 'object') result.engine = engine;
  return result;
}

/**
 * Resolves a parsed intent into a confirmable command, fetching/optimizing the
 * calendar as needed. Shared by both the Claude and rules paths.
 */
async function resolveParsed(provider, parsed, { referenceDate = new Date(), tzOffsetMinutes = 0, transcript } = {}) {
  if (parsed.type === 'add_task') {
    if (!parsed.title) return { type: 'add_task', error: 'need_title', transcript };
    return {
      type: 'add_task',
      transcript,
      task: {
        title: parsed.title,
        estimatedMinutes: parsed.estimatedMinutes,
        priority: parsed.priority || 'med',
        deadline: parsed.deadline || null,
      },
    };
  }

  if (parsed.type === 'plan_tasks') {
    const tasks = taskStore.list();
    const events = await calendar.getEvents(provider, { range: 'day' });
    const plan = scheduleTasks(tasks, events, { tzOffsetMinutes }, { referenceDate });
    return { type: 'plan_tasks', transcript, plan };
  }

  if (parsed.type === 'optimize') {
    const events = await calendar.getEvents(provider, { range: parsed.scope });
    const opt = optimize(events, { tzOffsetMinutes }, { referenceDate });
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
      // Time-only ("move to 4pm"): keep the event's own day, apply the new local
      // time. Operating on the target's Date with setHours stays in local tz.
      const spoken = new Date(parsed.when.start);
      const d = new Date(target.start);
      d.setHours(spoken.getHours(), spoken.getMinutes(), 0, 0);
      start = d.toISOString();
    }
    // Preserve original duration unless an explicit end was spoken.
    const end = parsed.when.end
      ? parsed.when.end
      : addMinutes(start, diffMinutes(target.start, target.end));
    return { type: 'move', transcript, match: target, otherMatches: matches.length - 1, to: { start, end } };
  }

  if (parsed.type === 'edit') {
    if (!parsed.title) return { type: 'edit', error: 'need_title', transcript };
    const matches = await findByTitle(provider, parsed.title, referenceDate);
    if (matches.length === 0) return { type: 'edit', error: 'not_found', title: parsed.title, transcript };
    const target = matches[0];
    const changes = {};
    if (parsed.newTitle) changes.title = parsed.newTitle;
    if (parsed.durationMinutes) changes.duration = parsed.durationMinutes;
    if (parsed.start) {
      let start;
      if (parsed.dateSpecified) {
        start = parsed.start;
      } else {
        const spoken = new Date(parsed.start);
        const d = new Date(target.start);
        d.setHours(spoken.getHours(), spoken.getMinutes(), 0, 0);
        start = d.toISOString();
      }
      changes.start = start;
      if (parsed.end) changes.end = parsed.end;
    }
    if (Object.keys(changes).length === 0) return { type: 'edit', error: 'need_change', title: parsed.title, transcript };
    return { type: 'edit', transcript, match: target, otherMatches: matches.length - 1, changes };
  }

  if (parsed.type === 'edit_task') {
    if (!parsed.title) return { type: 'edit_task', error: 'need_title', transcript };
    const task = findTaskByTitle(parsed.title);
    if (!task) return { type: 'edit_task', error: 'not_found', title: parsed.title, transcript };
    const patch = {};
    if (parsed.newTitle) patch.title = parsed.newTitle;
    if (parsed.estimatedMinutes) patch.estimatedMinutes = parsed.estimatedMinutes;
    if (parsed.priority) patch.priority = parsed.priority;
    if (parsed.deadline != null) patch.deadline = parsed.deadline;
    if (parsed.done != null) patch.done = parsed.done;
    if (Object.keys(patch).length === 0) return { type: 'edit_task', error: 'need_change', title: parsed.title, transcript };
    return { type: 'edit_task', transcript, task, patch };
  }

  if (parsed.type === 'brief') {
    const events = await calendar.getEvents(provider, { range: 'day' });
    const brief = composeBrief(events, taskStore.list(), { tzOffsetMinutes, referenceDate });
    return { type: 'brief', transcript, brief };
  }

  if (parsed.type === 'show_schedule' || parsed.type === 'show_free') {
    const scope = parsed.scope === 'week' ? 'week' : 'day';
    const todayKey = localTodayKey(referenceDate, tzOffsetMinutes);
    const dateKey = parsed.date || todayKey;
    const label = rangeLabel(scope, dateKey, todayKey);

    if (parsed.type === 'show_schedule') {
      const events = await calendar.getEvents(provider, { range: scope, date: `${dateKey}T12:00:00Z` });
      return { type: 'show_schedule', transcript, scope, date: dateKey, label, events };
    }
    const dayKeys = scope === 'week' ? weekdayKeys(dateKey) : [dateKey];
    const win = coveringWindow(dayKeys, { tzOffsetMinutes });
    const events = await calendar.getEvents(provider, { start: win.start, end: win.end });
    const days = freeForDays(events, dayKeys, { tzOffsetMinutes }, { referenceDate });
    return { type: 'show_free', transcript, scope, date: dateKey, label, days };
  }

  return { type: 'unknown', transcript };
}

module.exports = { parseCommand, buildCommand, resolveParsed, findByTitle };
