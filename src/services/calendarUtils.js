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

/** [00:00, next 00:00) UTC window for the given date (defaults to today). */
function dayRange(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  if (Number.isNaN(d.getTime())) throw validationError(`Invalid date: ${JSON.stringify(dateInput)}`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * A rolling 7-day window: the anchor day 00:00 through +7 days (UTC). Anchoring
 * on "today" (rather than the calendar Monday) means "week" always shows the
 * week ahead — otherwise, late in a Mon–Sun week (e.g. on a Sunday) almost the
 * whole window is in the past and only today's events show.
 */
function weekRange(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  if (Number.isNaN(d.getTime())) throw validationError(`Invalid date: ${JSON.stringify(dateInput)}`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Resolves the time window to query events over. Priority:
 *   1. explicit `start` + `end`
 *   2. `range: 'week'` (optionally anchored by `date`)
 *   3. `range: 'day'` / default (optionally anchored by `date`)
 */
function resolveRange({ range, date, start, end } = {}) {
  if (start || end) {
    if (!start || !end) throw validationError('Both `start` and `end` are required when either is provided.');
    return { start: toISO(start, 'start'), end: toISO(end, 'end') };
  }
  if (range === 'week') return weekRange(date);
  if (range && range !== 'day') throw validationError(`Unknown range: ${JSON.stringify(range)} (use "day" or "week").`);
  return dayRange(date);
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

module.exports = { toISO, addMinutes, diffMinutes, dayRange, weekRange, resolveRange, resolveEventTimes };
