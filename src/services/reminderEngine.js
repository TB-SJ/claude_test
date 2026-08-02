'use strict';

const { parseHM } = require('./scheduleRules');

/** Local date (YYYY-MM-DD) + minute-of-day for an instant, given a tz offset. */
function localParts(nowMs, offsetMin) {
  const shifted = new Date(nowMs + offsetMin * 60000);
  return { date: shifted.toISOString().slice(0, 10), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

/** "2:05 PM" for an ISO instant in the given tz offset. */
function fmtLocal(iso, offsetMin) {
  const d = new Date(new Date(iso).getTime() + offsetMin * 60000);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

/**
 * Decides which notifications to send on a given tick — pure and idempotent via
 * `state`. Returns the notifications plus the updated state to persist. Designed
 * to be called every ~15 min by an external scheduler:
 *  - the daily brief fires once, at/after `briefTime` local each day;
 *  - each event is reminded once, within a lookahead window before it starts.
 *
 * @returns {{ notifications: Array, state: object }}
 */
function planNotifications({
  now = new Date(),
  tzOffsetMinutes = 0,
  briefTime = '07:00',
  leadMinutes = 10,
  tickMinutes = 15,
  brief = null,
  appUrl = '/',
  state = {},
} = {}) {
  const off = tzOffsetMinutes;
  const nowMs = now.getTime();
  const lp = localParts(nowMs, off);
  const briefMin = parseHM(briefTime);

  const notifications = [];
  const next = {
    lastBriefDate: state.lastBriefDate || null,
    remindedDay: state.remindedDay || null,
    reminded: { ...(state.reminded || {}) },
  };

  // Daily brief — once, at/after the brief time each local day.
  if (lp.minute >= briefMin && next.lastBriefDate !== lp.date) {
    const body = (brief && Array.isArray(brief.lines) ? brief.lines : []).join('\n') || 'Have a great day.';
    notifications.push({ type: 'brief', title: '🌅 Your day', body, url: appUrl, tag: 'daily-brief' });
    next.lastBriefDate = lp.date;
  }

  // Roll the per-day reminded set at midnight (local).
  if (next.remindedDay !== lp.date) {
    next.remindedDay = lp.date;
    next.reminded = {};
  }

  // Event reminders — events starting within the lookahead window, once each.
  const windowMs = (leadMinutes + tickMinutes) * 60000;
  const events = brief && Array.isArray(brief.events) ? brief.events : [];
  for (const ev of events) {
    const startMs = new Date(ev.start).getTime();
    const delta = startMs - nowMs;
    if (delta > 0 && delta <= windowMs && !next.reminded[ev.id]) {
      notifications.push({
        type: 'reminder',
        eventId: ev.id,
        title: `⏰ ${ev.title || 'Event'}`,
        body: `Starts at ${fmtLocal(ev.start, off)} (in ${Math.round(delta / 60000)} min)`,
        url: appUrl,
        tag: `event-${ev.id}`,
      });
      next.reminded[ev.id] = true;
    }
  }

  return { notifications, state: next };
}

module.exports = { planNotifications };
