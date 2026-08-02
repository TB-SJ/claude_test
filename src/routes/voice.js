'use strict';

const express = require('express');
const { captureIntent } = require('../services/voice');
const { extractIntent } = require('../services/intent');
const { buildCommand } = require('../services/voiceCommand');
const calendar = require('../services/calendar');
const { sendError } = require('../httpError');
const { validationError } = require('../errors');

const router = express.Router();

/**
 * POST /voice/command  { provider, transcript, tzOffsetMinutes }
 * Parses a spoken command (from the browser's speech recognition) into a
 * confirmable action. Read-only — the client confirms, then calls the normal
 * calendar/schedule endpoints to execute. No OpenAI key required.
 */
router.post('/command', async (req, res) => {
  try {
    const { provider, transcript, tzOffsetMinutes } = req.body || {};
    calendar.assertProvider(provider);
    if (!transcript || !String(transcript).trim()) {
      throw validationError('No speech was detected — try again.');
    }
    const result = await buildCommand(provider, String(transcript), {
      referenceDate: new Date(),
      tzOffsetMinutes: Number(tzOffsetMinutes) || 0,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /voice/capture  { seconds? }
 * Records from the server's microphone, transcribes with Whisper, and returns
 * the structured intent. (Server-side mic — for local/desktop use.)
 */
router.post('/capture', async (req, res) => {
  try {
    const seconds = req.body && req.body.seconds;
    const result = await captureIntent({ seconds });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /voice/intent  { text }
 * Extract structured intent from already-transcribed text (skips audio).
 */
router.post('/intent', async (req, res) => {
  try {
    const text = req.body && req.body.text;
    const intent = await extractIntent(text);
    res.json({ transcript: text, intent });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
