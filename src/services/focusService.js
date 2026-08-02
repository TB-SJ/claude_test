'use strict';

const { resolveRules, parseHM } = require('./scheduleRules');
const { localParts, fromLocal } = require('./scheduleOptimizer');
const { taskOrder } = require('./taskScheduler');
const { isPending } = require('../taskStore');

function isTimed(ev) {
  return Boolean(ev.start && ev.end && ev.start.includes('T') && ev.end.includes('T') && ev.status !== 'cancelled');
}

/**
 * "What should I do now?" — looks at the free window from this moment until the
 * next event (or end of the day) and picks the best-fitting pending task.
 * Pure. Returns a small status object the client renders.
 */
function suggestNext(events, tasks, { tzOffsetMinutes = 0, referenceDate = new Date() } = {}) {
  const rules = resolveRules({ tzOffsetMinutes });
  const off = rules.tzOffsetMinutes;
  const now = referenceDate.getTime();
  const todayKey = localParts(referenceDate.toISOString(), off).dayKey;
  const nowMin = localParts(referenceDate.toISOString(), off).minute;
  const workStart = parseHM(rules.workday.start);
  const workEnd = parseHM(rules.workday.end);

  const timed = events
    .filter((e) => isTimed(e) && localParts(e.start, off).dayKey === todayKey)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  // In a meeting right now?
  const ongoing = timed.find((e) => new Date(e.start).getTime() <= now && now < new Date(e.end).getTime());
  if (ongoing) {
    return { status: 'busy', event: { title: ongoing.title, end: ongoing.end } };
  }

  if (nowMin >= workEnd) return { status: 'no_time', reason: 'day_over' };
  const startMin = Math.max(nowMin, workStart);

  // Free until the next event's start (or end of the workday).
  const upcomingMins = timed
    .map((e) => localParts(e.start, off).minute)
    .filter((m) => m > startMin);
  const endMin = Math.min(upcomingMins.length ? Math.min(...upcomingMins) : workEnd, workEnd);
  const availableMinutes = endMin - startMin;
  const until = fromLocal(todayKey, endMin, off);

  if (availableMinutes < 5) return { status: 'no_time', reason: 'busy_soon', until };

  const pending = tasks.filter((t) => isPending(t, todayKey)).slice().sort((a, b) => taskOrder(a, b, todayKey));
  if (!pending.length) return { status: 'free_no_tasks', availableMinutes, until };

  const fitting = pending.find((t) => (t.estimatedMinutes || 30) <= availableMinutes);
  const task = fitting || pending[0];
  return {
    status: 'ok',
    availableMinutes,
    until,
    fits: Boolean(fitting),
    task: {
      id: task.id,
      title: task.title,
      estimatedMinutes: task.estimatedMinutes || 30,
      priority: task.priority,
      category: task.category || null,
    },
  };
}

module.exports = { suggestNext };
