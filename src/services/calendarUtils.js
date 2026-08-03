'use strict';

const { validationError } = require('../errors');

/** Parses a value into a validated ISO 8601 string, or throws a 400-style error. */
function toISO(value, label = 'date') {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw validationError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return d.toISOString();
}

/** Adds (or subtracts) minutes to an ISO timestamp and returns a new ISO string. */
function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

/** Whole-minute difference between two ISO timestamps (end - start). */
function diffMinutes(startIso, endIso) {
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
}

/**
 * The current local date as a noon-UTC anchor (YYYY-MM-DDT12:00:00Z) for a
 * given tz offset. Noon keeps the calendar date stable across offsets, so it's
 * a safe anchor for dayRange/weekRange when the caller has no client-sent date.
 */
function localNoonAnchor(tzOffsetMinutes = 0, nowMs = Date.now()) {
  const off = Number(tzOffsetMinutes) || 0;
  const localDate = new Date(nowMs + off * 60000).toISOString().slice(0, 10);
  return `${localDate}T12:00:00Z`;
}

/**
 * A window of `days` local days starting at the anchor date's local midnight.
 * `tzOffsetMinutes` (local = UTC + offset) shifts the UTC boundaries so the
 * window covers the user's calendar day — otherwise, off-UTC users lose their
 * evening events (which fall into the next UTC day) and pick up yesterday's.
 * The anchor `date` should be sent as local-noon (YYYY-MM-DDT12:00:00Z) so the
 * calendar date reads the same regardless of offset.
 */
function localWindow(dateInput, days, tzOffsetMinutes = 0) {
  const d = dateInput ? new Date(dateInput) : new Date();
  if (Number.isNaN(d.getTime())) throw validationError(`Invalid date: ${JSON.stringify(dateInput)}`);
  const off = Number(tzOffsetMinutes) || 0;
  // Local midnight of the anchor date, expressed in UTC.
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off * 60000;
  const start = new Date(startMs);
  const end = new Date(startMs + days * 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** [local 00:00, next local 00:00) window for the given date (defaults to today). */
function dayRange(dateInput, tzOffsetMinutes = 0) {
  return localWindow(dateInput, 1, tzOffsetMinutes);
}

/**
 * A rolling 7-day window: the anchor day's local 00:00 through +7 days.
 * Anchoring on "today" (rather than the calendar Monday) means "week" always
 * shows the week ahead — otherwise, late in a Mon–Sun week (e.g. on a Sunday)
 * almost the whole window is in the past and only today's events show.
 */
function weekRange(dateInput, tzOffsetMinutes = 0) {
  return localWindow(dateInput, 7, tzOffsetMinutes);
}

/**
 * Resolves the time window to query events over. Priority:
 *   1. explicit `start` + `end`
 *   2. `range: 'week'` (optionally anchored by `date`)
 *   3. `range: 'day'` / default (optionally anchored by `date`)
 */
function resolveRange({ range, date, start, end, tzOffsetMinutes = 0 } = {}) {
  if (start || end) {
    if (!start || !end) throw validationError('Both `start` and `end` are required when either is provided.');
    return { start: toISO(start, 'start'), end: toISO(end, 'end') };
  }
  if (range === 'week') return weekRange(date, tzOffsetMinutes);
  if (range && range !== 'day') throw validationError(`Unknown range: ${JSON.stringify(range)} (use "day" or "week").`);
  return dayRange(date, tzOffsetMinutes);
}

/**
 * Resolves the concrete { start, end } for creating or updating an event.
 *
 * - both start & end        -> used as-is
 * - start + duration (min)  -> end = start + duration
 * - duration only           -> end = existing.start + duration (start unchanged)
 * - start only              -> end shifted to preserve the existing duration
 * - end only                -> start unchanged, end updated
 *
 * `existing` is the current event's { start, end } (required for update paths
 * that reference it). Throws a validation error if times cannot be resolved.
 */
function resolveEventTimes({ start, end, duration } = {}, existing = null) {
  const s = start ? toISO(start, 'start') : existing && existing.start;
  let e = end ? toISO(end, 'end') : null;

  if (!e) {
    if (duration != null) {
      if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
        throw validationError('`duration` must be a positive number of minutes.');
      }
      const base = start ? toISO(start, 'start') : existing && existing.start;
      if (!base) throw validationError('Cannot apply `duration` without a start time.');
      e = addMinutes(base, duration);
    } else if (start && existing && existing.start && existing.end) {
      // Moving the event: keep its original duration.
      e = addMinutes(toISO(start, 'start'), diffMinutes(existing.start, existing.end));
    } else if (existing && existing.end) {
      e = existing.end;
    }
  }

  if (!s || !e) throw validationError('Insufficient time information — provide start/end or duration.');
  if (new Date(e).getTime() <= new Date(s).getTime()) {
    throw validationError('Event end must be after start.');
  }
  return { start: s, end: e };
}

// --- Recurring events (RFC 5545 RRULE, as Google/Graph expect) --------------

// Friendly preset keys → recurrence spec. FREQ=WEEKLY without BYDAY repeats on
// the event's own start weekday, so most presets need no BYDAY.
const RECURRENCE_PRESETS = {
  daily: { freq: 'DAILY' },
  weekly: { freq: 'WEEKLY' },
  biweekly: { freq: 'WEEKLY', interval: 2 },
  every3weeks: { freq: 'WEEKLY', interval: 3 },
  every4weeks: { freq: 'WEEKLY', interval: 4 },
  monthly: { freq: 'MONTHLY' },
  yearly: { freq: 'YEARLY' },
  weekdays: { freq: 'WEEKLY', byday: ['MO', 'TU', 'WE', 'TH', 'FR'] },
};

const VALID_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const VALID_DAYS = new Set(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);

/**
 * Builds a recurrence array (e.g. ["RRULE:FREQ=WEEKLY;INTERVAL=2"]) from a spec
 * object `{ freq, interval?, byday?, count?, until? }`. Returns null for a
 * falsy/`none` spec. Throws on an invalid frequency/day.
 */
function buildRecurrence(spec) {
  if (!spec || spec === 'none') return null;
  const freq = String(spec.freq || '').toUpperCase();
  if (!VALID_FREQ.has(freq)) throw validationError(`Invalid recurrence frequency: ${JSON.stringify(spec.freq)}`);
  const parts = [`FREQ=${freq}`];
  const interval = Math.max(1, Math.min(52, parseInt(spec.interval, 10) || 1));
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (Array.isArray(spec.byday) && spec.byday.length) {
    const days = spec.byday.map((d) => String(d).toUpperCase());
    if (days.some((d) => !VALID_DAYS.has(d))) throw validationError('Invalid BYDAY in recurrence.');
    parts.push(`BYDAY=${days.join(',')}`);
  }
  const count = parseInt(spec.count, 10);
  if (count > 0) {
    parts.push(`COUNT=${Math.min(count, 730)}`);
  } else if (spec.until) {
    const d = new Date(spec.until);
    if (!Number.isNaN(d.getTime())) {
      parts.push(`UNTIL=${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`);
    }
  }
  return [`RRULE:${parts.join(';')}`];
}

/**
 * Resolves an event-create input's recurrence into an RRULE array (or null).
 * Accepts a pass-through `recurrence` array, a preset key via `repeat`, or a
 * spec object via `repeat`, plus an optional `repeatCount`.
 */
function recurrenceFromInput(input = {}) {
  if (Array.isArray(input.recurrence)) return input.recurrence.length ? input.recurrence : null;
  const repeat = input.repeat;
  if (!repeat || repeat === 'none') return null;
  const base = typeof repeat === 'string' ? RECURRENCE_PRESETS[repeat.toLowerCase()] : repeat;
  if (!base) throw validationError(`Unknown repeat option: ${JSON.stringify(repeat)}`);
  // A date-only "until" (YYYY-MM-DD) should include that whole day.
  let until = input.repeatUntil;
  if (typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until)) until = `${until}T23:59:59Z`;
  return buildRecurrence({ ...base, count: input.repeatCount, until });
}

module.exports = {
  toISO, addMinutes, diffMinutes, localNoonAnchor, dayRange, weekRange, resolveRange, resolveEventTimes,
  RECURRENCE_PRESETS, buildRecurrence, recurrenceFromInput,
};
