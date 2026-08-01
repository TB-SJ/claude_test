'use strict';

const fs = require('fs');
const { recordToFile } = require('./audio');
const { transcribeFile } = require('./transcribe');
const { extractIntent } = require('./intent');
const { getOpenAI } = require('./openaiClient');
const logger = require('../logger');

/** Best-effort cleanup of a temp recording. */
function removeQuietly(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {
    /* already gone */
  });
}

/**
 * Full voice pipeline: record from the mic -> Whisper transcription ->
 * language-model intent extraction. Returns both the transcript and the
 * structured intent.
 *
 * @param {object} [opts]
 * @param {number} [opts.seconds]  Recording length; defaults to config.audio.seconds.
 * @returns {Promise<{transcript: string, intent: object}>}
 */
async function captureIntent({ seconds } = {}) {
  // Fail fast if OpenAI isn't configured, before touching the microphone.
  getOpenAI();

  let filePath;
  try {
    filePath = await recordToFile({ seconds });
    const transcript = await transcribeFile(filePath);
    const intent = await extractIntent(transcript);
    logger.info('voice.captureIntent complete', { action: intent.action });
    return { transcript, intent };
  } finally {
    removeQuietly(filePath);
  }
}

/**
 * Transcribe-only variant for an already-recorded file (no mic capture).
 * @returns {Promise<{transcript: string, intent: object}>}
 */
async function processAudioFile(filePath, { keepFile = true } = {}) {
  try {
    const transcript = await transcribeFile(filePath);
    const intent = await extractIntent(transcript);
    return { transcript, intent };
  } finally {
    if (!keepFile) removeQuietly(filePath);
  }
}

module.exports = { captureIntent, processAudioFile };
