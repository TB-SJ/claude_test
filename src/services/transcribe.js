'use strict';

const fs = require('fs');
const { getOpenAI } = require('./openaiClient');
const { config } = require('../config');
const { apiError, validationError } = require('../errors');
const logger = require('../logger');

/**
 * Transcribes an audio file to text using the OpenAI Whisper API.
 *
 * @param {string} filePath  Path to an audio file (wav/mp3/m4a/webm/...).
 * @returns {Promise<string>} The transcribed text.
 */
async function transcribeFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw validationError(`Audio file not found: ${filePath}`);
  }
  try {
    const client = getOpenAI();
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: config.openai.whisperModel,
    });
    const text = (result.text || '').trim();
    logger.info('voice.transcribe complete', { chars: text.length });
    return text;
  } catch (err) {
    throw apiError('whisper', 'transcribeFile', err, { filePath });
  }
}

module.exports = { transcribeFile };
