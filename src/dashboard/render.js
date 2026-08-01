'use strict';

// Pure terminal-rendering helpers for the dashboard. No I/O, no side effects —
// everything here is a (data) -> string transform so it can be unit-tested.

const COL = 40; // width of each schedule column
const TITLE = 26; // max title chars

const C = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
};

function paint(str, code, on) {
  return on ? `${code}${str}${C.reset}` : str;
}

/** Local minute-of-day helpers (events are UTC ISO; display is local). */
function localHM(iso, offsetMin) {
  const d = new Date(new Date(iso).getTime() + offsetMin * 60000);
  return d.toISOString().slice(11, 16);
}
function localDayKey(iso, offsetMin) {
  const d = new Date(new Date(iso).getTime() + offsetMin * 60000);
  return d.toISOString().slice(0, 10);
}
function weekdayLabel(dayKey) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

function truncate(str, n) {
  const s = str || '(untitled)';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One event -> "HH:MM-HH:MM  Title" (or "all-day  Title"). */
function formatEvent(ev, offsetMin) {
  const timed = ev.start.includes('T');
  const time = timed ? `${localHM(ev.start, offsetMin)}-${localHM(ev.end, offsetMin)}` : 'all-day    ';
  return `${time.padEnd(12)}${truncate(ev.title, TITLE)}`;
}

/**
 * Applies a set of proposed moves to a copy of the events (pure) — used to
 * render the "After" column without mutating the originals.
 */
function applyMoves(events, moves) {
  const byId = new Map(moves.map((m) => [m.id, m.to]));
  return events.map((e) => (byId.has(e.id) ? { ...e, start: byId.get(e.id).start, end: byId.get(e.id).end } : e));
}

function eventsByDay(events, offsetMin) {
  const map = new Map();
  for (const ev of events) {
    const key = localDayKey(ev.start, offsetMin);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ev);
  }
  for (const list of map.values()) list.sort((a, b) => new Date(a.start) - new Date(b.start));
  return map;
}

/**
 * Renders a side-by-side Before/After view of the schedule, grouped by day.
 * Changed events in the After column are marked with "▸".
 */
function renderSideBySide(before, after, rules, opts = {}) {
  const off = rules.tzOffsetMinutes || 0;
  const color = Boolean(opts.color);
  const beforeById = new Map(before.map((e) => [e.id, e]));
  const changed = new Set(
    after.filter((e) => {
      const b = beforeById.get(e.id);
      return b && (b.start !== e.start || b.end !== e.end);
    }).map((e) => e.id)
  );

  const beforeDays = eventsByDay(before, off);
  const afterDays = eventsByDay(after, off);
  const dayKeys = [...new Set([...beforeDays.keys(), ...afterDays.keys()])].sort();

  const lines = [];
  lines.push(`${paint('BEFORE'.padEnd(COL), C.bold, color)} │ ${paint('AFTER', C.bold, color)}`);
  lines.push(`${'─'.repeat(COL)}─┼─${'─'.repeat(COL)}`);

  for (const key of dayKeys) {
    lines.push(paint(`${weekdayLabel(key)} ${key}`, C.cyan, color));
    const bl = (beforeDays.get(key) || []).map((e) => formatEvent(e, off));
    const al = (afterDays.get(key) || []).map((e) => {
      const marker = changed.has(e.id) ? '▸ ' : '  ';
      const line = marker + formatEvent(e, off);
      return changed.has(e.id) ? paint(line, C.green, color) : line;
    });
    if (bl.length === 0) bl.push(paint('(no events)', C.dim, color));
    if (al.length === 0) al.push(paint('(no events)', C.dim, color));
    const rows = Math.max(bl.length, al.length);
    for (let i = 0; i < rows; i += 1) {
      const left = (bl[i] || '').padEnd(COL);
      const right = al[i] || '';
      lines.push(`${left} │ ${right}`);
    }
  }
  return lines.join('\n');
}

/** Short analysis summary block. */
function renderAnalysis(analysis, opts = {}) {
  const color = Boolean(opts.color);
  const c = analysis.counts;
  const flag = (n) => (n > 0 ? paint(String(n), C.yellow, color) : paint(String(n), C.dim, color));
  return [
    paint('Analysis', C.bold, color),
    `  Conflicts / double-bookings: ${flag(c.conflicts)}`,
    `  Buffer violations:           ${flag(c.bufferIssues)}`,
    `  Fragmented gaps:             ${flag(c.fragmentedGaps)}`,
    `  Deep-work intrusions:        ${flag(c.deepWorkViolations)}`,
  ].join('\n');
}

/** Lists each proposed move with its reasons. */
function renderReasons(moves, rules, opts = {}) {
  const off = rules.tzOffsetMinutes || 0;
  const color = Boolean(opts.color);
  const out = [paint('Proposed changes', C.bold, color)];
  for (const m of moves) {
    const from = `${localHM(m.from.start, off)}-${localHM(m.from.end, off)}`;
    const to = `${localHM(m.to.start, off)}-${localHM(m.to.end, off)}`;
    out.push(`  • ${truncate(m.title, 30)}: ${from} → ${to}`);
    out.push(`      ${paint(m.reasons.join('; '), C.dim, color)}`);
  }
  return out.join('\n');
}

module.exports = {
  renderSideBySide,
  renderAnalysis,
  renderReasons,
  applyMoves,
  formatEvent,
  COL,
};
