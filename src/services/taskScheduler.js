'use strict';

const { resolveRules, parseHM } = require('./scheduleRules');
const { localParts, fromLocal, earliestSlot } = require('./scheduleOptimizer');

const PRIORITY_RANK = { high: 0, med: 1, low: 2 };

/** Orders tasks: highest priority first, then soonest deadline, then longest. */
function taskOrder(a, b) {
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
  const dayKey = date || localParts(referenceDate.toISOString(), off).dayKey;
  const workStart = parseHM(rules.workday.start);
  const workEnd = parseHM(rules.workday.end);

  // Busy = real events on that local day (clamped to the work window).
  const busy = [];
  for (const ev of events) {
    if (!isTimed(ev)) continue;
    const s = localParts(ev.start, off);
    const e = localParts(ev.end, off);
    if (s.dayKey !== dayKey) continue;
    busy.push([Math.max(s.minute, 0), e.dayKey === dayKey ? e.minute : workEnd]);
  }

  const pending = tasks.filter((t) => !t.done).slice().sort(taskOrder);
  const slots = [];
  const unscheduled = [];
  const placed = busy.slice();

  for (const t of pending) {
    const dur = t.estimatedMinutes || 30;
    const slot = earliestSlot(workStart, dur, placed, workEnd, rules.bufferMinutes);
    if (slot == null) {
      unscheduled.push(t);
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

  return { dayKey, slots, unscheduled, events };
}

module.exports = { scheduleTasks, taskOrder };
