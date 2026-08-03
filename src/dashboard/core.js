'use strict';

const { optimize } = require('../services/scheduleOptimizer');
const { fromLocal } = require('../services/scheduleOptimizer');
const { parseHM } = require('../services/scheduleRules');
const { renderSideBySide, renderAnalysis, renderReasons, applyMoves } = require('./render');

/**
 * Classifies a transcript (and optional parsed intent) into a dashboard command.
 * "Optimize my day/week/schedule" is the headline command; add/remove/move fall
 * back to the voice intent; plus help/quit.
 */
function routeCommand(transcript, intent) {
  const t = (transcript || '').toLowerCase().trim();
  if (!t) return { type: 'unknown', transcript };
  if (/\b(quit|exit|goodbye|good bye|stop listening|shut ?down)\b/.test(t)) return { type: 'quit' };
  if (/\b(help|what can you do|commands)\b/.test(t)) return { type: 'help' };
  if (/optimi[sz]e/.test(t)) {
    const scope = /\bweek\b/.test(t) ? 'week' : 'day';
    return { type: 'optimize', scope };
  }
  if (intent && intent.action) return { type: 'event', intent };
  return { type: 'unknown', transcript };
}

/** Composes a UTC ISO instant from a local date + "HH:MM" time. */
function composeISO(date, time, offsetMin) {
  return fromLocal(date, parseHM(time), offsetMin);
}

/** Finds timed events whose title contains `hint` (case-insensitive). */
function resolveEvents(events, hint) {
  const q = (hint || '').toLowerCase().trim();
  if (!q) return [];
  return events.filter((e) => e.start.includes('T') && (e.title || '').toLowerCase().includes(q));
}

const HELP = [
  'You can say:',
  '  • "Optimize my day"   — analyze & rearrange today',
  '  • "Optimize my week"  — analyze & rearrange the week',
  '  • "Add <title> on <date> at <time>"',
  '  • "Remove <title>"  /  "Move <title> to <time>"',
  '  • "Quit"',
].join('\n');

/**
 * The interactive dashboard. All I/O and integrations are injected so the whole
 * loop can be driven end-to-end in tests without a real mic, API, or calendar.
 *
 * @param {object} deps
 * @param {object} deps.io        { print, waitForHotkey, confirm }
 * @param {object} deps.voice     { listen(): Promise<{transcript, intent}> }
 * @param {object} deps.calendar  { getEvents, createEvent, deleteEvent, updateEvent }
 * @param {string} deps.provider  'google' | 'outlook'
 * @param {object} [deps.ruleOverrides]
 * @param {string} [deps.date]    anchor date for range queries
 * @param {boolean}[deps.color]
 */
class Dashboard {
  constructor(deps) {
    this.io = deps.io;
    this.voice = deps.voice;
    this.calendar = deps.calendar;
    this.provider = deps.provider || 'google';
    this.ruleOverrides = deps.ruleOverrides || {};
    this.date = deps.date;
    // Optional fixed "now" for the current-time-aware optimizer (tests inject it).
    this.referenceDate = deps.referenceDate;
    this.renderOpts = { color: Boolean(deps.color) };
    this.quit = false;
  }

  /** Main loop: wait for hotkey -> listen -> route -> handle, until quit. */
  async run() {
    this.io.print('╭──────────────────────────────────────────────╮');
    this.io.print('│   🗓  Calendar Voice Dashboard                 │');
    this.io.print('│   Press SPACE to talk · say "quit" to exit    │');
    this.io.print('╰──────────────────────────────────────────────╯');
    while (!this.quit) {
      const key = await this.io.waitForHotkey('\n▶ Press SPACE to talk (q to quit): ');
      if (key === 'q') break;
      await this.handleUtterance();
    }
    this.io.print('\nGoodbye. 👋');
  }

  async handleUtterance() {
    this.io.print('🎙  Listening…');
    let result;
    try {
      result = await this.voice.listen();
    } catch (err) {
      this.io.print(`   ✗ Voice error [${err.code || 'ERROR'}]: ${err.message}`);
      return;
    }
    const transcript = (result && result.transcript) || '';
    this.io.print(`   Heard: "${transcript}"`);
    const cmd = routeCommand(transcript, result && result.intent);
    await this.dispatch(cmd);
  }

  async dispatch(cmd) {
    switch (cmd.type) {
      case 'quit':
        this.quit = true;
        return;
      case 'help':
        this.io.print(HELP);
        return;
      case 'optimize':
        return this.optimizeCommand(cmd.scope);
      case 'event':
        return this.eventCommand(cmd.intent);
      default:
        this.io.print('   🤔 Sorry, I didn\'t catch a command. Say "help" for options.');
    }
  }

  /** Headline flow: analyze -> Before/After -> confirm -> save. */
  async optimizeCommand(scope) {
    let events;
    try {
      events = await this.calendar.getEvents(this.provider, { range: scope, date: this.date });
    } catch (err) {
      this.io.print(`   ✗ Could not fetch calendar [${err.code || 'ERROR'}]: ${err.message}`);
      return;
    }

    const result = optimize(events, this.ruleOverrides, this.referenceDate ? { referenceDate: this.referenceDate } : {});
    this.io.print('');
    this.io.print(renderAnalysis(result.analysis, this.renderOpts));

    if (result.moves.length === 0) {
      this.io.print(`\n✅ Your ${scope} is already optimized — nothing to change.`);
      return;
    }

    const after = applyMoves(events, result.moves);
    this.io.print('');
    this.io.print(renderSideBySide(events, after, result.rules, this.renderOpts));
    this.io.print('');
    this.io.print(renderReasons(result.moves, result.rules, this.renderOpts));

    const ok = await this.io.confirm(`\nApply these ${result.moves.length} change(s)? [y/N] `);
    if (!ok) {
      this.io.print('   No changes made.');
      return;
    }
    await this.applyMoves(result.moves);
  }

  async applyMoves(moves) {
    let okCount = 0;
    let failCount = 0;
    for (const m of moves) {
      try {
        await this.calendar.updateEvent(this.provider, m.id, { start: m.to.start, end: m.to.end });
        okCount += 1;
      } catch (err) {
        this.io.print(`   ✗ ${m.title}: [${err.code || 'ERROR'}] ${err.message}`);
        failCount += 1;
      }
    }
    this.io.print(`   💾 Saved: ${okCount} updated, ${failCount} failed.`);
  }

  /** Secondary flow: voice add/remove/move for a single event. */
  async eventCommand(intent) {
    const off = this.ruleOverrides.tzOffsetMinutes || 0;
    const d = intent.event_details || {};
    if (intent.action === 'add') {
      if (!d.title || !d.date || !d.start_time) {
        this.io.print('   Need at least a title, date, and start time to add an event.');
        return;
      }
      const start = composeISO(d.date, d.start_time, off);
      const end = d.end_time ? composeISO(d.date, d.end_time, off) : undefined;
      const ok = await this.io.confirm(`   Add "${d.title}" on ${d.date} at ${d.start_time}? [y/N] `);
      if (!ok) return this.io.print('   Cancelled.');
      try {
        await this.calendar.createEvent(this.provider, { title: d.title, start, end });
        this.io.print('   ✅ Event added.');
      } catch (err) {
        this.io.print(`   ✗ Add failed [${err.code || 'ERROR'}]: ${err.message}`);
      }
      return;
    }

    // remove / move: resolve the target by title within the week.
    let events;
    try {
      events = await this.calendar.getEvents(this.provider, { range: 'week', date: this.date });
    } catch (err) {
      this.io.print(`   ✗ Could not fetch calendar: ${err.message}`);
      return;
    }
    const matches = resolveEvents(events, d.title);
    if (matches.length === 0) {
      this.io.print(`   🤔 Couldn't find an event matching "${d.title || ''}".`);
      return;
    }
    if (matches.length > 1) {
      this.io.print(`   ⚠ "${d.title}" matches ${matches.length} events — please be more specific.`);
      return;
    }
    const target = matches[0];

    if (intent.action === 'remove') {
      const ok = await this.io.confirm(`   Remove "${target.title}"? [y/N] `);
      if (!ok) return this.io.print('   Cancelled.');
      try {
        await this.calendar.deleteEvent(this.provider, target.id);
        this.io.print('   ✅ Event removed.');
      } catch (err) {
        this.io.print(`   ✗ Remove failed [${err.code || 'ERROR'}]: ${err.message}`);
      }
      return;
    }

    if (intent.action === 'move') {
      const date = d.date || target.start.slice(0, 10);
      if (!d.start_time) {
        this.io.print('   Need a new time to move the event to.');
        return;
      }
      const start = composeISO(date, d.start_time, off);
      const end = d.end_time ? composeISO(date, d.end_time, off) : undefined;
      const ok = await this.io.confirm(`   Move "${target.title}" to ${date} ${d.start_time}? [y/N] `);
      if (!ok) return this.io.print('   Cancelled.');
      try {
        await this.calendar.updateEvent(this.provider, target.id, end ? { start, end } : { start });
        this.io.print('   ✅ Event moved.');
      } catch (err) {
        this.io.print(`   ✗ Move failed [${err.code || 'ERROR'}]: ${err.message}`);
      }
    }
  }
}

module.exports = { Dashboard, routeCommand, composeISO, resolveEvents };
