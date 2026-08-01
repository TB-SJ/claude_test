'use strict';

const { validationError } = require('../errors');

/**
 * Default optimization ruleset. Times are local wall-clock "HH:MM"; because
 * events are stored in UTC, `tzOffsetMinutes` (local = UTC + offset) maps
 * between them — e.g. US Pacific DST is -420. Default 0 treats UTC as local.
 */
const DEFAULT_RULES = {
  tzOffsetMinutes: 0,

  // Only schedule within these hours.
  workday: { start: '09:00', end: '17:00' },

  // Leave at least this many minutes between events.
  bufferMinutes: 15,

  // Gaps smaller than this (but non-zero) are considered wasted/fragmented.
  minUsefulGapMinutes: 30,

  // Protect a recurring focus block; meetings are moved out of it.
  deepWork: { enabled: true, start: '09:00', end: '11:00', days: [1, 2, 3, 4, 5] },

  // Preferred window to group meetings into (e.g. the afternoon).
  meetingWindow: { enabled: true, start: '13:00', end: '17:00' },

  // Movable events are re-placed within their original day only.
  keepWithinDay: true,

  // Events whose title matches any of these (regex strings) are never moved.
  pinnedTitlePatterns: [],
};

/** Parses "HH:MM" into minutes since local midnight. */
function parseHM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) throw validationError(`Invalid time "${value}" (expected HH:MM).`);
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) throw validationError(`Invalid time "${value}".`);
  return h * 60 + min;
}

/** Formats minutes-since-midnight back into "HH:MM". */
function formatHM(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Deep-merges user overrides onto the defaults and validates the result. */
function resolveRules(overrides = {}) {
  const r = {
    ...DEFAULT_RULES,
    ...overrides,
    workday: { ...DEFAULT_RULES.workday, ...(overrides.workday || {}) },
    deepWork: { ...DEFAULT_RULES.deepWork, ...(overrides.deepWork || {}) },
    meetingWindow: { ...DEFAULT_RULES.meetingWindow, ...(overrides.meetingWindow || {}) },
  };

  // Validate time fields (throws on bad input).
  parseHM(r.workday.start);
  parseHM(r.workday.end);
  parseHM(r.deepWork.start);
  parseHM(r.deepWork.end);
  parseHM(r.meetingWindow.start);
  parseHM(r.meetingWindow.end);
  if (parseHM(r.workday.end) <= parseHM(r.workday.start)) {
    throw validationError('workday.end must be after workday.start.');
  }
  if (!(r.bufferMinutes >= 0)) throw validationError('bufferMinutes must be >= 0.');

  return r;
}

/** Human-readable summary of the active rules, for CLI/API output. */
function describeRules(r) {
  const lines = [
    `Work hours: ${r.workday.start}–${r.workday.end}`,
    `Buffer between events: ${r.bufferMinutes} min`,
    `Fragmented-gap threshold: < ${r.minUsefulGapMinutes} min`,
  ];
  if (r.deepWork.enabled) lines.push(`Protect deep-work: ${r.deepWork.start}–${r.deepWork.end}`);
  if (r.meetingWindow.enabled) lines.push(`Group meetings into: ${r.meetingWindow.start}–${r.meetingWindow.end}`);
  if (r.tzOffsetMinutes) lines.push(`Timezone offset: ${r.tzOffsetMinutes} min from UTC`);
  return lines;
}

module.exports = { DEFAULT_RULES, resolveRules, describeRules, parseHM, formatHM };
