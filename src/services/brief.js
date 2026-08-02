'use strict';

const { resolveRules, parseHM } = require('./scheduleRules');
const { localParts } = require('./scheduleOptimizer');
const { diffMinutes } = require('./calendarUtils');
const { freeForDays } = require('./freeTime');
const { taskOrder, taskUrgency } = require('./taskScheduler');
const { isPending, isRecurring } = require('../taskStore');

function isTimed(ev) {
  return Boolean(ev.start && ev.end && ev.start.includes('T') && ev.end.includes('T') && ev.status !== 'cancelled');
}

function weekdayOf(dayKey) {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

/** Formats minutes as "2h 15m" / "45m". */
function fmtDur(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

/**
 * Composes a compact "how's my day" brief from the day's events + tasks. Pure —
 * reads nothing, writes nothing. Returns structured data plus human-readable
 * `lines` (used by the voice reply and a simple render).
 */
function composeBrief(events, tasks, { tzOffsetMinutes = 0, referenceDate = new Date() } = {}) {
  const rules = resolveRules({ tzOffsetMinutes });
  const off = rules.tzOffsetMinutes;
  const nowMs = referenceDate.getTime();
  const todayKey = localParts(referenceDate.toISOString(), off).dayKey;

  const timedToday = events
    .filter((e) => isTimed(e) && localParts(e.start, off).dayKey === todayKey)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const meetingMinutes = timedToday.reduce((sum, e) => sum + diffMinutes(e.start, e.end), 0);
  const nextEvent = timedToday.find((e) => new Date(e.start).getTime() > nowMs) || null;

  const freeSlots = freeForDays(events, [todayKey], { tzOffsetMinutes }, { referenceDate }).find((d) => d.dayKey === todayKey);
  const freeMinutes = (freeSlots ? freeSlots.slots : []).reduce((sum, s) => sum + s.minutes, 0);

  // Deep-work protection for today.
  const dw = rules.deepWork;
  let deepWorkClear = null; // null = no deep-work block today
  if (dw.enabled && dw.days.includes(weekdayOf(todayKey))) {
    const dwS = parseHM(dw.start);
    const dwE = parseHM(dw.end);
    deepWorkClear = !timedToday.some((e) => {
      const s = localParts(e.start, off).minute;
      const en = localParts(e.end, off).minute;
      return s < dwE && en > dwS;
    });
  }

  const pending = tasks.filter((t) => isPending(t, todayKey)).slice().sort((a, b) => taskOrder(a, b, todayKey));
  const topTask = pending[0] || null;
  const atRisk = pending
    .map((t) => ({ task: t, urg: taskUrgency(t, todayKey) }))
    .filter(({ urg }) => urg.overdue || urg.dueToday || urg.dueTomorrow)
    .map(({ task, urg }) => ({
      id: task.id,
      title: task.title,
      when: urg.overdue ? 'overdue' : urg.dueToday ? 'due today' : 'due tomorrow',
    }));

  const lines = [];
  lines.push(
    timedToday.length
      ? `🗓 ${timedToday.length} meeting${timedToday.length === 1 ? '' : 's'} · ${fmtDur(meetingMinutes)} booked`
      : '🗓 No meetings today'
  );
  lines.push(`🎯 ${fmtDur(freeMinutes)} free${deepWorkClear === true ? ' · deep-work protected ✓' : deepWorkClear === false ? ' · deep-work has a meeting ⚠️' : ''}`);
  if (nextEvent) lines.push(`⏭ Next: ${nextEvent.title}`);
  if (topTask) lines.push(`✅ Top task: ${topTask.title} (${fmtDur(topTask.estimatedMinutes || 30)}${topTask.priority === 'high' ? ', High' : ''})`);
  for (const r of atRisk.slice(0, 3)) lines.push(`⚠️ ${r.title} — ${r.when}`);

  return {
    dayKey: todayKey,
    meetingCount: timedToday.length,
    meetingMinutes,
    freeMinutes,
    deepWorkClear,
    nextEvent: nextEvent ? { id: nextEvent.id, title: nextEvent.title, start: nextEvent.start, end: nextEvent.end } : null,
    pendingTaskCount: pending.length,
    topTask: topTask ? { id: topTask.id, title: topTask.title, estimatedMinutes: topTask.estimatedMinutes, priority: topTask.priority, deadline: topTask.deadline } : null,
    atRisk,
    events: timedToday,
    lines,
  };
}

module.exports = { composeBrief };
