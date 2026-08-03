'use strict';

const express = require('express');
const calendar = require('../services/calendar');
const taskStore = require('../taskStore');
const settingsStore = require('../settingsStore');
const calendarUtils = require('../services/calendarUtils');
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
    const anchor = calendarUtils.localNoonAnchor(tzOffsetMinutes);
    const events = await calendar.getEvents(req.params.provider, { range: 'day', date: anchor, tzOffsetMinutes });
    res.json(suggestNext(events, taskStore.list(), { tzOffsetMinutes, ruleOverrides: settingsStore.rules(tzOffsetMinutes) }));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
