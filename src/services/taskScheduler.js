'use strict';

const { resolveRules, parseHM } = require('./scheduleRules');
const { localParts, fromLocal, earliestSlot } = require('./scheduleOptimizer');

const PRIORITY_RANK = { high: 0, med: 1, low: 2 };

/** Whole days from `todayKey` (YYYY-MM-DD) until a deadline (negative = past). */
function daysUntil(deadline, todayKey) {
  if (!deadline) return Infinity;
  return Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86400000);
}

/** Classifies how pressing a task's deadline is, relative to today. */
function taskUrgency(task, todayKey) {
  const d = daysUntil(task.deadline, todayKey);
  return {
    daysLeft: d,
    overdue: d < 0,
    dueToday: d === 0,
    dueTomorrow: d === 1,
    dueSoon: d <= 2, // today, tomorrow, or overdue
  };
}

/**
 * Orders tasks so imminent deadlines are never buried behind priority. Tasks due
 * within 2 days (or overdue) come first — soonest deadline wins; then by priority
 * for everything else; then soonest deadline; then longest.
 */
function taskOrder(a, b, todayKey) {
  // Deadline-urgent tasks jump the queue, ordered by how soon they're due.
  const ua = todayKey ? taskUrgency(a, todayKey).dueSoon : false;
  const ub = todayKey ? taskUrgency(b, todayKey).dueSoon : false;
  if (ua !== ub) return ua ? -1 : 1;
  if (ua && ub) {
    const da = daysUntil(a.deadline, todayKey);
    const db = daysUntil(b.deadline, todayKey);
    if (da !== db) return da - db;
  }
  const pr = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
  if (pr !== 0) return pr;
  const ad = a.deadline || '9999-12-31';
  const bd = b.deadline || '9999-12-31';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return (b.estimatedMinutes || 30) - (a.estimatedMinutes || 30);
}

function isTimed(ev) {
  return Boolean(ev.start && ev.end && ev.start.includes('T') && ev.end.includes('T'));
}

/**
 * Suggests when to do flexible tasks by slotting them into the day's free time
 * around real calendar events. Pure — returns a plan; writes nothing. Tasks are
 * allowed to use the deep-work block (it's your focus time), but never overlap
 * real events, and stay within work hours with the configured buffer.
 *
 * @returns {{ dayKey, slots:[{taskId,title,start,end,priority}], unscheduled:[task], events }}
 */
function scheduleTasks(tasks, events, ruleOverrides = {}, { referenceDate = new Date(), date } = {}) {
  const rules = resolveRules(ruleOverrides);
  const off = rules.tzOffsetMinutes;
  const todayKey = localParts(referenceDate.toISOString(), off).dayKey;
  const dayKey = date || todayKey;
  const workStart = parseHM(rules.workday.start);
  const workEnd = parseHM(rules.workday.end);

  // Current-time awareness: when planning today, don't suggest slots in the past.
  // Round "now" up to the next 5 minutes for tidy start times.
  const nowMin = Math.ceil(localParts(referenceDate.toISOString(), off).minute / 5) * 5;
  const earliest = dayKey === todayKey ? Math.max(workStart, nowMin) : workStart;

  // Busy = real events on that local day (clamped to the work window).
  const busy = [];
  for (const ev of events) {
    if (!isTimed(ev)) continue;
    const s = localParts(ev.start, off);
    const e = localParts(ev.end, off);
    if (s.dayKey !== dayKey) continue;
    busy.push([Math.max(s.minute, 0), e.dayKey === dayKey ? e.minute : workEnd]);
  }

  const pending = tasks.filter((t) => !t.done).slice().sort((a, b) => taskOrder(a, b, dayKey));
  const slots = [];
  const unscheduled = [];
  const placed = busy.slice();

  for (const t of pending) {
    const dur = t.estimatedMinutes || 30;
    const slot = earliestSlot(earliest, dur, placed, workEnd, rules.bufferMinutes);
    if (slot == null) {
      // Couldn't fit today — flag it as at-risk if its deadline is pressing.
      const urg = taskUrgency(t, dayKey);
      unscheduled.push({ ...t, atRisk: urg.dueSoon });
      continue;
    }
    slots.push({
      taskId: t.id,
      title: t.title,
      priority: t.priority,
      start: fromLocal(dayKey, slot, off),
      end: fromLocal(dayKey, slot + dur, off),
    });
    placed.push([slot, slot + dur]);
  }

  // For a forward-looking plan of TODAY, don't show events that already ended —
  // only what's left of the day. (All-day and future-day plans keep everything.)
  const now = referenceDate.getTime();
  const visibleEvents = dayKey === todayKey
    ? events.filter((e) => !isTimed(e) || new Date(e.end).getTime() > now)
    : events;

  return { dayKey, slots, unscheduled, events: visibleEvents };
}

module.exports = { scheduleTasks, taskOrder, taskUrgency };
