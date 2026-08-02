'use strict';

const { resolveRules, parseHM } = require('./scheduleRules');
const { fromLocal } = require('./scheduleOptimizer');

/** Timed (not all-day), non-cancelled events only. */
function isTimed(ev) {
  return Boolean(ev.start && ev.end && ev.start.includes('T') && ev.end.includes('T') && ev.status !== 'cancelled');
}

/** Local day key (YYYY-MM-DD) for an instant, given a UTC offset in minutes. */
function localDayKey(instant, offsetMin) {
  return new Date(new Date(instant).getTime() + offsetMin * 60000).toISOString().slice(0, 10);
}

/** Weekday (Mon–Fri) keys within the rolling 7-day window starting at `dayKey`. */
function weekdayKeys(dayKey) {
  const base = new Date(`${dayKey}T00:00:00Z`);
  const keys = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) keys.push(d.toISOString().slice(0, 10)); // skip Sat/Sun
  }
  return keys;
}

/**
 * Computes free gaps within the working-hours window for each given local day,
 * subtracting busy timed events. Pure — takes already-fetched events.
 *
 * @param {Array}  events         normalized events (UTC ISO times)
 * @param {Array}  dayKeys        local YYYY-MM-DD days to compute
 * @param {object} ruleOverrides  optimizer rules (workday hours, tzOffsetMinutes)
 * @param {object} opts           { minSlotMinutes = 15 }
 * @returns {Array} [{ dayKey, slots: [{ start, end, minutes }] }]
 */
function freeForDays(events, dayKeys, ruleOverrides = {}, { minSlotMinutes = 15 } = {}) {
  const rules = resolveRules(ruleOverrides);
  const off = rules.tzOffsetMinutes;
  const workStart = parseHM(rules.workday.start);
  const workEnd = parseHM(rules.workday.end);
  const timed = events.filter(isTimed);

  return dayKeys.map((dayKey) => {
    const winStart = new Date(fromLocal(dayKey, workStart, off)).getTime();
    const winEnd = new Date(fromLocal(dayKey, workEnd, off)).getTime();

    // Busy intervals clipped to the working window, sorted and merged.
    const busy = timed
      .map((e) => [new Date(e.start).getTime(), new Date(e.end).getTime()])
      .filter(([s, e]) => e > winStart && s < winEnd)
      .map(([s, e]) => [Math.max(s, winStart), Math.min(e, winEnd)])
      .sort((a, b) => a[0] - b[0]);

    const merged = [];
    for (const [s, e] of busy) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }

    const slots = [];
    let cursor = winStart;
    for (const [s, e] of merged) {
      if (s - cursor >= minSlotMinutes * 60000) {
        slots.push({ start: new Date(cursor).toISOString(), end: new Date(s).toISOString(), minutes: Math.round((s - cursor) / 60000) });
      }
      cursor = Math.max(cursor, e);
    }
    if (winEnd - cursor >= minSlotMinutes * 60000) {
      slots.push({ start: new Date(cursor).toISOString(), end: new Date(winEnd).toISOString(), minutes: Math.round((winEnd - cursor) / 60000) });
    }
    return { dayKey, slots };
  });
}

/** The UTC window [start, end] spanning the working hours of every dayKey. */
function coveringWindow(dayKeys, ruleOverrides = {}) {
  const rules = resolveRules(ruleOverrides);
  const off = rules.tzOffsetMinutes;
  const workStart = parseHM(rules.workday.start);
  const workEnd = parseHM(rules.workday.end);
  const starts = dayKeys.map((k) => new Date(fromLocal(k, workStart, off)).getTime());
  const ends = dayKeys.map((k) => new Date(fromLocal(k, workEnd, off)).getTime());
  return {
    start: new Date(Math.min(...starts)).toISOString(),
    end: new Date(Math.max(...ends)).toISOString(),
  };
}

module.exports = { freeForDays, coveringWindow, weekdayKeys, localDayKey };
