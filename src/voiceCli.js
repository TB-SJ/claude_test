#!/usr/bin/env node
'use strict';

/**
 * CLI: record a spoken calendar command from the microphone and print the
 * structured intent JSON.
 *
 *   node src/voiceCli.js [seconds]
 *   npm run voice -- 6
 */

const { captureIntent } = require('./services/voice');

(async () => {
  const seconds = parseInt(process.argv[2], 10) || undefined;
  try {
    console.error(`Listening${seconds ? ` for ${seconds}s` : ''}... speak now.`);
    const result = await captureIntent({ seconds });
    console.error(`Heard: "${result.transcript}"`);
    console.log(JSON.stringify(result.intent, null, 2));
  } catch (err) {
    console.error(`Voice capture failed [${err.code || 'ERROR'}]: ${err.message}`);
    process.exit(1);
  }
})();
