#!/usr/bin/env node
'use strict';

/**
 * Interactive CLI dashboard that ties the whole app together:
 *   launch -> wait for hotkey -> listen (mic -> Whisper -> intent) ->
 *   run the command (e.g. "Optimize my day") -> Before/After view -> save.
 *
 *   node src/dashboardCli.js [--provider google] [--date 2026-08-03]
 *                            [--tz-offset -420] [--rules ./rules.json]
 */

const fs = require('fs');
const readline = require('readline');
const calendar = require('./services/calendar');
const voiceService = require('./services/voice');
const { Dashboard } = require('./dashboard/core');

/** Terminal I/O adapter: hotkey capture (raw mode) + line confirmation. */
const terminalIO = {
  print(msg = '') {
    process.stdout.write(`${msg}\n`);
  },

  waitForHotkey(prompt) {
    return new Promise((resolve) => {
      process.stdout.write(prompt);
      const stdin = process.stdin;
      const rawCapable = Boolean(stdin.isTTY && stdin.setRawMode);
      const onData = (buf) => {
        const key = buf.toString();
        stdin.removeListener('data', onData);
        if (rawCapable) stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        if (key === '' || key === 'q' || key === 'Q') {
          if (key === '') process.exit(0); // Ctrl-C
          return resolve('q');
        }
        resolve('go');
      };
      if (rawCapable) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    });
  },

  confirm(question) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
  },
};

/** Real voice source: record from mic -> Whisper -> intent. */
const voiceSource = {
  listen: () => voiceService.captureIntent({}),
};

function parseArgs(argv) {
  const args = { provider: 'google' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--provider') args.provider = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--tz-offset') args.tzOffset = parseInt(argv[++i], 10);
    else if (a === '--rules') args.rulesPath = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const ruleOverrides = {};
  if (args.rulesPath) Object.assign(ruleOverrides, JSON.parse(fs.readFileSync(args.rulesPath, 'utf8')));
  if (Number.isInteger(args.tzOffset)) ruleOverrides.tzOffsetMinutes = args.tzOffset;

  const dashboard = new Dashboard({
    io: terminalIO,
    voice: voiceSource,
    calendar,
    provider: args.provider,
    ruleOverrides,
    date: args.date,
    color: process.stdout.isTTY && !process.env.NO_COLOR,
  });

  await dashboard.run();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`\nDashboard error [${err.code || 'ERROR'}]: ${err.message}\n`);
  process.exit(1);
});
