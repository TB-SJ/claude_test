'use strict';

const { resolveRules, parseHM } = require('./scheduleRules');
const { localParts, fromLocal, earliestSlot } = require('./scheduleOptimizer');
const { isPending } = require('../taskStore');

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
function scheduleTasks(tasks, events, ruleOverrides = {}, { referenceDate = new Date(), date, priorityTag = null, order = null, exclude = null, floors = null } = {}) {
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

  // `exclude` drops specific tasks from this plan entirely (the user removed them
  // from the layout); they stay in the task list, just aren't scheduled here.
  const excluded = new Set(Array.isArray(exclude) ? exclude : []);
  // Ordering: an explicit manual `order` (list of task ids) wins outright; else
  // an optional `priorityTag` floats that tag to the front; else deadline/priority.
  const pending = tasks.filter((t) => isPending(t, dayKey) && !excluded.has(t.id)).slice();
  if (Array.isArray(order) && order.length) {
    const idx = new Map(order.map((id, i) => [id, i]));
    pending.sort((a, b) => {
      const ai = idx.has(a.id) ? idx.get(a.id) : Infinity;
      const bi = idx.has(b.id) ? idx.get(b.id) : Infinity;
      if (ai !== bi) return ai - bi;
      return taskOrder(a, b, dayKey); // stable fallback for any not listed
    });
  } else {
    pending.sort((a, b) => {
      // Same-day time-bound tasks ("do by 5pm") lead, soonest deadline first —
      // they have the tightest window, so they get first pick of the free slots.
      const abt = a.byTime ? parseHM(a.byTime) : null;
      const bbt = b.byTime ? parseHM(b.byTime) : null;
      if ((abt == null) !== (bbt == null)) return abt == null ? 1 : -1;
      if (abt != null && bbt != null && abt !== bbt) return abt - bbt;
      if (priorityTag) {
        const at = a.tag === priorityTag ? 0 : 1;
        const bt = b.tag === priorityTag ? 0 : 1;
        if (at !== bt) return at - bt;
      }
      return taskOrder(a, b, dayKey);
    });
  }
  const slots = [];
  const unscheduled = [];
  const placed = busy.slice();

  // A per-task start floor (local minutes) lets the user push a task past an
  // event even when earlier free time exists — it just won't start before it.
  const floorFor = (t) => {
    const f = floors && floors[t.id] != null ? Number(floors[t.id]) : null;
    return Number.isFinite(f) ? Math.max(earliest, f) : earliest;
  };

  for (const t of pending) {
    const dur = t.estimatedMinutes || 30;
    // A "do by HH:MM" task must finish by that clock time, so cap its slot end.
    const bound = t.byTime ? Math.min(workEnd, parseHM(t.byTime)) : workEnd;
    const slot = earliestSlot(floorFor(t), dur, placed, bound, rules.bufferMinutes);
    if (slot == null) {
      // Couldn't fit today — flag it as at-risk if its deadline is pressing or
      // it had a same-day time bound we couldn't honor.
      const urg = taskUrgency(t, dayKey);
      unscheduled.push({ ...t, atRisk: urg.dueSoon || Boolean(t.byTime) });
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
