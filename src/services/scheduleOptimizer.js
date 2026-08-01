'use strict';

const { diffMinutes } = require('./calendarUtils');
const { resolveRules, parseHM, formatHM } = require('./scheduleRules');

// ---------------------------------------------------------------------------
// Local-time helpers (events are UTC ISO; rules are local wall-clock).
// ---------------------------------------------------------------------------

/** Decomposes a UTC ISO instant into local { dayKey, minute, weekday }. */
function localParts(iso, offsetMin) {
  const shifted = new Date(new Date(iso).getTime() + offsetMin * 60000);
  return {
    dayKey: shifted.toISOString().slice(0, 10),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Builds a UTC ISO instant from a local day + minute-of-day. */
function fromLocal(dayKey, minute, offsetMin) {
  const utcMs = Date.parse(`${dayKey}T00:00:00Z`) + minute * 60000 - offsetMin * 60000;
  return new Date(utcMs).toISOString();
}

/** Weekday (0=Sun) for a local YYYY-MM-DD key. */
function weekdayOf(dayKey) {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/** Timed events have a dateTime (contain 'T'); all-day events are date-only. */
function isTimed(ev) {
  return Boolean(ev.start && ev.end && ev.start.includes('T') && ev.end.includes('T'));
}

function isCancelled(ev) {
  return ev.status === 'cancelled';
}

function isPinned(ev, rules) {
  return (rules.pinnedTitlePatterns || []).some((p) => {
    try {
      return new RegExp(p, 'i').test(ev.title || '');
    } catch (_) {
      return false;
    }
  });
}

/** True when two events overlap in absolute time. */
function overlaps(a, b) {
  return new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Inspects the week for conflicts, double-bookings, buffer violations,
 * fragmented gaps, and deep-work intrusions. Pure — takes normalized events.
 *
 * @returns {object} analysis report with issue lists + per-event violation map.
 */
function analyze(events, ruleOverrides = {}) {
  const rules = resolveRules(ruleOverrides);
  const off = rules.tzOffsetMinutes;
  const timed = events
    .filter((e) => isTimed(e) && !isCancelled(e))
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const conflicts = [];
  const bufferIssues = [];
  const fragmentedGaps = [];
  const deepWorkViolations = [];
  const outsideWindow = [];
  // Per-event set of violation tags, used later to explain moves.
  const byEvent = new Map();
  const tag = (id, t) => {
    if (!byEvent.has(id)) byEvent.set(id, new Set());
    byEvent.get(id).add(t);
  };

  // Pairwise overlaps (double-bookings / conflicts).
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      if (overlaps(timed[i], timed[j])) {
        conflicts.push({ a: summarize(timed[i]), b: summarize(timed[j]) });
        tag(timed[i].id, 'conflict');
        tag(timed[j].id, 'conflict');
      }
    }
  }

  // Deep-work intrusions + preferred-window checks.
  const dwStart = parseHM(rules.deepWork.start);
  const dwEnd = parseHM(rules.deepWork.end);
  const winStart = parseHM(rules.meetingWindow.start);
  const winEnd = parseHM(rules.meetingWindow.end);
  for (const ev of timed) {
    const s = localParts(ev.start, off);
    const e = localParts(ev.end, off);
    if (
      rules.deepWork.enabled &&
      rules.deepWork.days.includes(s.weekday) &&
      s.dayKey === e.dayKey &&
      s.minute < dwEnd &&
      e.minute > dwStart
    ) {
      deepWorkViolations.push(summarize(ev));
      tag(ev.id, 'deep-work');
    }
    if (rules.meetingWindow.enabled && (s.minute < winStart || e.minute > winEnd)) {
      outsideWindow.push(summarize(ev));
      tag(ev.id, 'outside-window');
    }
  }

  // Adjacent-gap checks per local day (buffer + fragmentation).
  const days = groupByDay(timed, off);
  for (const dayEvents of days.values()) {
    for (let i = 0; i < dayEvents.length - 1; i += 1) {
      const cur = dayEvents[i];
      const next = dayEvents[i + 1];
      const gap = diffMinutes(cur.start, next.start) - diffMinutes(cur.start, cur.end);
      if (gap < 0) continue; // overlap already recorded as a conflict
      if (gap < rules.bufferMinutes) {
        bufferIssues.push({ after: summarize(cur), before: summarize(next), gapMinutes: gap });
        tag(cur.id, 'buffer');
        tag(next.id, 'buffer');
      } else if (gap > rules.bufferMinutes && gap < rules.minUsefulGapMinutes) {
        // A gap equal to the buffer is the intended transition, not waste.
        fragmentedGaps.push({ after: summarize(cur), before: summarize(next), gapMinutes: gap });
        tag(next.id, 'fragmented');
      }
    }
  }

  return {
    rules,
    counts: {
      events: timed.length,
      conflicts: conflicts.length,
      bufferIssues: bufferIssues.length,
      fragmentedGaps: fragmentedGaps.length,
      deepWorkViolations: deepWorkViolations.length,
    },
    conflicts,
    bufferIssues,
    fragmentedGaps,
    deepWorkViolations,
    outsideWindow,
    violationsByEvent: byEvent,
  };
}

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------

/**
 * Finds the earliest start >= `from` where a `duration`-minute event fits
 * without violating `buffer` around any busy interval, bounded by `bound`.
 * Returns the start minute, or null if nothing fits.
 */
function earliestSlot(from, duration, busy, bound, buffer) {
  let c = from;
  const sorted = busy.slice().sort((a, b) => a[0] - b[0]);
  for (const [b0, b1] of sorted) {
    if (c + duration <= b0 - buffer) return c; // fits before this busy block
    if (c < b1 + buffer) c = b1 + buffer; // otherwise jump past it (+ buffer)
  }
  return c + duration <= bound ? c : null;
}

/** Places one day's movable events around fixed blocks per the rules. */
function planDay(dayKey, movable, fixed, rules) {
  const off = rules.tzOffsetMinutes;
  const workStart = parseHM(rules.workday.start);
  const workEnd = parseHM(rules.workday.end);
  const weekday = weekdayOf(dayKey);

  // Seed busy intervals: deep-work block + fixed events.
  const busy = [];
  if (rules.deepWork.enabled && rules.deepWork.days.includes(weekday)) {
    busy.push([parseHM(rules.deepWork.start), parseHM(rules.deepWork.end)]);
  }
  for (const f of fixed) {
    busy.push([localParts(f.start, off).minute, localParts(f.end, off).minute]);
  }

  const windowStart = rules.meetingWindow.enabled ? parseHM(rules.meetingWindow.start) : workStart;
  // Earliest a movable meeting may start after the morning deep-work block.
  const afterDeep =
    rules.deepWork.enabled && rules.deepWork.days.includes(weekday)
      ? parseHM(rules.deepWork.end)
      : workStart;

  const ordered = movable.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
  const placements = new Map();
  const unplaceable = [];
  let cursor = windowStart;

  for (const ev of ordered) {
    const duration = diffMinutes(ev.start, ev.end);
    let slot = earliestSlot(cursor, duration, busy, workEnd, rules.bufferMinutes);
    if (slot == null) {
      // Overflow: try to use a morning gap after the deep-work block.
      slot = earliestSlot(Math.max(workStart, afterDeep), duration, busy, workEnd, rules.bufferMinutes);
    }
    if (slot == null) {
      unplaceable.push(summarize(ev));
      continue;
    }
    placements.set(ev.id, { startMin: slot, endMin: slot + duration });
    busy.push([slot, slot + duration]);
    cursor = slot + duration + rules.bufferMinutes;
  }

  return { placements, unplaceable, weekday, windowStart };
}

/** Maps an event's violation tags + placement to human reasons for a move. */
function reasonsFor(tags, newStartMin, windowStart, movedEarlierThanWindow) {
  const reasons = [];
  if (tags.has('conflict')) reasons.push('Resolve double-booking / conflict');
  if (tags.has('deep-work')) reasons.push('Protect 9–11 AM deep-work block');
  if (tags.has('buffer')) reasons.push('Add buffer between events');
  if (tags.has('outside-window') && newStartMin >= windowStart) {
    reasons.push('Group into afternoon meeting block');
  }
  if (tags.has('fragmented')) reasons.push('Reduce fragmented gap');
  if (reasons.length === 0) {
    reasons.push(movedEarlierThanWindow ? 'Repack to honor rules' : 'Group into meeting block');
  }
  return reasons;
}

/**
 * Produces an optimized rearrangement of the week. Movable events are re-placed
 * within their original day around fixed blocks and the deep-work window, packed
 * into the preferred meeting window with buffers. Durations are always preserved.
 *
 * @returns {object} { rules, moves, unplaceable, unchanged, summary }
 */
function optimize(events, ruleOverrides = {}) {
  const rules = resolveRules(ruleOverrides);
  const off = rules.tzOffsetMinutes;
  const analysis = analyze(events, ruleOverrides);

  const timed = events.filter((e) => isTimed(e) && !isCancelled(e));
  const movable = timed.filter((e) => !isPinned(e, rules));
  const fixed = timed.filter((e) => isPinned(e, rules));

  const movableByDay = groupByDay(movable, off);
  const fixedByDay = groupByDay(fixed, off);

  const moves = [];
  const unplaceable = [];
  let unchanged = 0;

  for (const [dayKey, dayMovable] of movableByDay) {
    const dayFixed = fixedByDay.get(dayKey) || [];
    const { placements, unplaceable: dayUnplaceable, windowStart } = planDay(
      dayKey,
      dayMovable,
      dayFixed,
      rules
    );
    unplaceable.push(...dayUnplaceable);

    for (const ev of dayMovable) {
      const placed = placements.get(ev.id);
      if (!placed) continue;
      const newStart = fromLocal(dayKey, placed.startMin, off);
      const newEnd = fromLocal(dayKey, placed.endMin, off);
      if (newStart === ev.start && newEnd === ev.end) {
        unchanged += 1;
        continue;
      }
      const tags = analysis.violationsByEvent.get(ev.id) || new Set();
      moves.push({
        id: ev.id,
        provider: ev.provider,
        title: ev.title,
        from: { start: ev.start, end: ev.end },
        to: { start: newStart, end: newEnd },
        reasons: reasonsFor(tags, placed.startMin, windowStart, placed.startMin < windowStart),
      });
    }
  }

  // Stable order: chronological by target start.
  moves.sort((a, b) => new Date(a.to.start) - new Date(b.to.start));

  return {
    rules,
    analysis,
    moves,
    unplaceable,
    summary: {
      totalEvents: timed.length,
      movable: movable.length,
      pinned: fixed.length,
      proposedMoves: moves.length,
      unchanged,
      unplaceable: unplaceable.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function summarize(ev) {
  return { id: ev.id, title: ev.title, start: ev.start, end: ev.end, provider: ev.provider };
}

/** Groups timed events by local day key, each list sorted by start. */
function groupByDay(events, offsetMin) {
  const map = new Map();
  for (const ev of events) {
    const key = localParts(ev.start, offsetMin).dayKey;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ev);
  }
  for (const list of map.values()) list.sort((a, b) => new Date(a.start) - new Date(b.start));
  return map;
}

module.exports = {
  analyze,
  optimize,
  // exported for tests:
  localParts,
  fromLocal,
  earliestSlot,
  formatHM,
};
