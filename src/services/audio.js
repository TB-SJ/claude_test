'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const recorder = require('node-record-lpcm16');
const { config } = require('../config');
const { validationError } = require('../errors');
const logger = require('../logger');

/**
 * Records `seconds` of mono audio from the default microphone to a temporary
 * WAV file and resolves with its path. Uses node-record-lpcm16, which shells
 * out to a system recorder (`sox`/`rec` or `arecord`) — see README for setup.
 *
 * The caller owns the returned file and should delete it when done.
 */
function recordToFile({ seconds, sampleRate, recorderProgram } = {}) {
  const durationSec = seconds || config.audio.seconds;
  if (!(durationSec > 0)) {
    return Promise.reject(validationError('`seconds` must be a positive number.'));
  }
  const rate = sampleRate || config.audio.sampleRate;
  const program = recorderProgram || config.audio.recorder;
  const filePath = path.join(os.tmpdir(), `voice-${crypto.randomUUID()}.wav`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const out = fs.createWriteStream(filePath, { encoding: 'binary' });
    logger.info('voice.record starting', { seconds: durationSec, sampleRate: rate, recorder: program });

    let recording;
    try {
      recording = recorder.record({
        sampleRate: rate,
        channels: 1,
        audioType: 'wav',
        recorder: program,
      });
    } catch (err) {
      return finish(reject, wrapRecorderError(err));
    }

    const stream = recording.stream();
    stream.on('error', (err) => finish(reject, wrapRecorderError(err)));
    out.on('error', (err) => finish(reject, wrapRecorderError(err)));
    stream.pipe(out);

    const timer = setTimeout(() => {
      try {
        recording.stop();
      } catch (_) {
        /* stop is best-effort */
      }
    }, durationSec * 1000);

    out.on('finish', () => {
      clearTimeout(timer);
      logger.info('voice.record finished', { filePath });
      finish(resolve, filePath);
    });
  });
}

/** Normalizes recorder failures (e.g. missing sox/arecord) into a clear error. */
function wrapRecorderError(err) {
  const wrapped = new Error(
    `Microphone capture failed: ${err.message}. ` +
      'Ensure a recorder is installed (SoX: `sox`/`rec`, or ALSA: `arecord`) and a mic is available.'
  );
  wrapped.code = 'API_ERROR';
  wrapped.details = { message: err.message };
  logger.error('voice.record failed', { message: err.message });
  return wrapped;
}

module.exports = { recordToFile };
