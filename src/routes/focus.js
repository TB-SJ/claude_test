'use strict';

const express = require('express');
const calendar = require('../services/calendar');
const taskStore = require('../taskStore');
const { suggestNext } = require('../services/focusService');
const { sendError } = require('../httpError');

const router = express.Router();

/**
 * GET /focus/:provider?tzOffsetMinutes=
 * "What should I do now?" — suggests the best pending task for the free time
 * available right now. Read-only.
 */
router.get('/:provider', async (req, res) => {
  try {
    const tzOffsetMinutes = Number(req.query.tzOffsetMinutes) || 0;
    const events = await calendar.getEvents(req.params.provider, { range: 'day' });
    res.json(suggestNext(events, taskStore.list(), { tzOffsetMinutes }));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
