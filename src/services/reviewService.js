'use strict';

const { resolveRules, parseHM } = require('./scheduleRules');
const { localParts } = require('./scheduleOptimizer');
const { diffMinutes } = require('./calendarUtils');
const { freeForDays } = require('./freeTime');
const { isRecurring } = require('../taskStore');

function isTimed(ev) {
  return Boolean(ev.start && ev.end && ev.start.includes('T') && ev.end.includes('T') && ev.status !== 'cancelled');
}

function fmtHours(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

/** `count` local day keys ending at (and including) `endKey`. */
function keysEndingAt(endKey, count) {
  const end = new Date(`${endKey}T00:00:00Z`);
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

function meetingMinutes(timed, off, dayKeySet) {
  return timed
    .filter((e) => dayKeySet.has(localParts(e.start, off).dayKey))
    .reduce((sum, e) => sum + diffMinutes(e.start, e.end), 0);
}

/**
 * Computes a look-back review over the last 7 local days (with a trend vs the
 * prior 7). Pure — takes events covering ~14 days and the current tasks.
 */
function computeReview(events, tasks, { tzOffsetMinutes = 0, referenceDate = new Date() } = {}) {
  const rules = resolveRules({ tzOffsetMinutes });
  const off = rules.tzOffsetMinutes;
  const todayKey = localParts(referenceDate.toISOString(), off).dayKey;

  const thisWeek = keysEndingAt(todayKey, 7);
  const priorEnd = keysEndingAt(todayKey, 8)[0]; // the day before thisWeek starts
  const lastWeek = keysEndingAt(priorEnd, 7);
  const thisSet = new Set(thisWeek);
  const lastSet = new Set(lastWeek);

  const timed = events.filter(isTimed);
  const thisMeetingMin = meetingMinutes(timed, off, thisSet);
  const lastMeetingMin = meetingMinutes(timed, off, lastSet);
  const meetingCount = timed.filter((e) => thisSet.has(localParts(e.start, off).dayKey)).length;

  // Busiest day by meeting minutes.
  const perDay = thisWeek.map((k) => ({
    key: k,
    min: timed.filter((e) => localParts(e.start, off).dayKey === k).reduce((s, e) => s + diffMinutes(e.start, e.end), 0),
  }));
  const busiest = perDay.reduce((a, b) => (b.min > a.min ? b : a), { key: null, min: 0 });

  // Free/focus time available this week (no now-flooring: anchor before the window).
  const anchor = new Date(`${thisWeek[0]}T00:00:00Z`);
  const freeMin = freeForDays(events, thisWeek, { tzOffsetMinutes }, { referenceDate: anchor })
    .reduce((sum, d) => sum + d.slots.reduce((s, x) => s + x.minutes, 0), 0);

  // Deep-work protection across the week's deep-work days.
  const dw = rules.deepWork;
  const dwStart = parseHM(dw.start);
  const dwEnd = parseHM(dw.end);
  let dwDays = 0;
  let dwProtected = 0;
  if (dw.enabled) {
    for (const k of thisWeek) {
      const weekday = new Date(`${k}T00:00:00Z`).getUTCDay();
      if (!dw.days.includes(weekday)) continue;
      dwDays += 1;
      const intruded = timed.some((e) => {
        const s = localParts(e.start, off);
        if (s.dayKey !== k) return false;
        const en = localParts(e.end, off).minute;
        return s.minute < dwEnd && en > dwStart;
      });
      if (!intruded) dwProtected += 1;
    }
  }

  // Tasks.
  const openOneOff = tasks.filter((t) => !isRecurring(t) && !t.done);
  const overdue = openOneOff.filter((t) => t.deadline && t.deadline < todayKey);
  const completedThisWeek =
    tasks.filter((t) => !isRecurring(t) && t.completedAt && thisSet.has(t.completedAt.slice(0, 10))).length +
    tasks.filter((t) => isRecurring(t) && t.lastDone && thisSet.has(t.lastDone)).length;
  const habits = tasks
    .filter((t) => isRecurring(t) && (t.streak || 0) > 0)
    .map((t) => ({ title: t.title, streak: t.streak }))
    .sort((a, b) => b.streak - a.streak);

  const trendMin = thisMeetingMin - lastMeetingMin;
  const trend = trendMin === 0 ? 'flat' : trendMin > 0 ? 'up' : 'down';

  const lines = [];
  lines.push(`🗓 ${meetingCount} meeting${meetingCount === 1 ? '' : 's'} · ${fmtHours(thisMeetingMin)} (last week ${fmtHours(lastMeetingMin)}, ${trend === 'flat' ? 'no change' : `${trend} ${fmtHours(Math.abs(trendMin))}`})`);
  lines.push(`🎯 ${fmtHours(freeMin)} free/focus time in work hours`);
  if (dwDays) lines.push(`🧠 Deep-work protected ${dwProtected}/${dwDays} weekdays`);
  if (busiest.key) lines.push(`📈 Busiest: ${new Date(`${busiest.key}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} (${fmtHours(busiest.min)})`);
  lines.push(`✅ ${completedThisWeek} task${completedThisWeek === 1 ? '' : 's'} completed · ${openOneOff.length} open${overdue.length ? ` · ⚠️ ${overdue.length} overdue` : ''}`);
  for (const h of habits.slice(0, 5)) lines.push(`🔥 ${h.title}: ${h.streak}-day streak`);

  return {
    range: { from: thisWeek[0], to: todayKey },
    meetings: { count: meetingCount, minutes: thisMeetingMin, lastWeekMinutes: lastMeetingMin, trend, trendMinutes: trendMin },
    freeMinutes: freeMin,
    deepWork: { protected: dwProtected, days: dwDays },
    busiestDay: busiest.key,
    tasks: { open: openOneOff.length, overdue: overdue.length, completedThisWeek },
    habits,
    lines,
  };
}

module.exports = { computeReview };
