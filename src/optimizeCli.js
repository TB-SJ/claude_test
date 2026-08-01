#!/usr/bin/env node
'use strict';

/**
 * Automatic schedule optimization engine (CLI).
 *
 * Fetches your upcoming week, analyzes it for conflicts, double-bookings, and
 * fragmented gaps, proposes a rearranged schedule per the active rules, and asks
 * for confirmation before applying the updates via the calendar API.
 *
 *   node src/optimizeCli.js [--provider google] [--date 2026-08-03]
 *                           [--tz-offset -420] [--rules ./rules.json]
 *                           [--yes] [--dry-run]
 */

const fs = require('fs');
const readline = require('readline');
const calendar = require('../src/services/calendar');
const { optimize } = require('./services/scheduleOptimizer');
const { describeRules } = require('./services/scheduleRules');

function parseArgs(argv) {
  const args = { provider: 'google', yes: false, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--provider') args.provider = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--tz-offset') args.tzOffset = parseInt(argv[++i], 10);
    else if (a === '--rules') args.rulesPath = argv[++i];
  }
  return args;
}

function loadRuleOverrides(args) {
  const overrides = {};
  if (args.rulesPath) {
    Object.assign(overrides, JSON.parse(fs.readFileSync(args.rulesPath, 'utf8')));
  }
  if (Number.isInteger(args.tzOffset)) overrides.tzOffsetMinutes = args.tzOffset;
  return overrides;
}

function fmt(iso, offsetMin) {
  const d = new Date(new Date(iso).getTime() + offsetMin * 60000);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const hm = d.toISOString().slice(11, 16);
  return `${day} ${hm}`;
}

function printAnalysis(analysis) {
  const c = analysis.counts;
  console.log('\n=== Weekly analysis ===');
  console.log(`  Events analyzed:      ${c.events}`);
  console.log(`  Conflicts / dbl-book: ${c.conflicts}`);
  console.log(`  Buffer violations:    ${c.bufferIssues}`);
  console.log(`  Fragmented gaps:      ${c.fragmentedGaps}`);
  console.log(`  Deep-work intrusions: ${c.deepWorkViolations}`);

  if (analysis.conflicts.length) {
    console.log('\n  Conflicts:');
    for (const x of analysis.conflicts) console.log(`    • "${x.a.title}" overlaps "${x.b.title}"`);
  }
  if (analysis.deepWorkViolations.length) {
    console.log('\n  In protected deep-work window:');
    for (const x of analysis.deepWorkViolations) console.log(`    • "${x.title}"`);
  }
}

function printProposal(result, offsetMin) {
  console.log('\n=== Proposed schedule ===');
  if (result.moves.length === 0) {
    console.log('  No changes needed — your week already satisfies the rules. ✅');
    return;
  }
  for (const m of result.moves) {
    console.log(`  ${m.title}`);
    console.log(`      ${fmt(m.from.start, offsetMin)}–${fmt(m.from.end, offsetMin).slice(-5)}` +
      `  →  ${fmt(m.to.start, offsetMin)}–${fmt(m.to.end, offsetMin).slice(-5)}`);
    console.log(`      ↳ ${m.reasons.join('; ')}`);
  }
  if (result.unplaceable.length) {
    console.log('\n  ⚠ Could not fit within work hours (left as-is):');
    for (const x of result.unplaceable) console.log(`    • "${x.title}"`);
  }
  const s = result.summary;
  console.log(`\n  Summary: ${s.proposedMoves} move(s), ${s.unchanged} unchanged, ` +
    `${s.pinned} pinned, ${s.unplaceable} unplaceable.`);
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function applyMoves(provider, moves) {
  console.log('\nApplying changes...');
  let ok = 0;
  let failed = 0;
  for (const m of moves) {
    try {
      await calendar.updateEvent(provider, m.id, { start: m.to.start, end: m.to.end });
      console.log(`  ✓ ${m.title}`);
      ok += 1;
    } catch (err) {
      console.error(`  ✗ ${m.title}: [${err.code || 'ERROR'}] ${err.message}`);
      failed += 1;
    }
  }
  console.log(`\nDone. ${ok} updated, ${failed} failed.`);
  return failed === 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const overrides = loadRuleOverrides(args);
  const offset = overrides.tzOffsetMinutes || 0;

  console.log(`Fetching ${args.provider} events for the week` + (args.date ? ` of ${args.date}` : '') + '...');
  const events = await calendar.getEvents(args.provider, { range: 'week', date: args.date });

  const result = optimize(events, overrides);

  console.log('\nActive rules:');
  for (const line of describeRules(result.rules)) console.log(`  • ${line}`);

  printAnalysis(result.analysis);
  printProposal(result, offset);

  if (result.moves.length === 0) return;
  if (args.dryRun) {
    console.log('\n(dry run — no changes applied)');
    return;
  }

  const proceed = args.yes || (await confirm(`\nApply these ${result.moves.length} change(s)? [y/N] `));
  if (!proceed) {
    console.log('Aborted — no changes made.');
    return;
  }
  const success = await applyMoves(args.provider, result.moves);
  process.exitCode = success ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nSchedule optimization failed [${err.code || 'ERROR'}]: ${err.message}`);
  process.exit(1);
});
