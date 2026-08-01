'use strict';

const express = require('express');
const { captureIntent } = require('../services/voice');
const { extractIntent } = require('../services/intent');
const { sendError } = require('../httpError');

const router = express.Router();

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
