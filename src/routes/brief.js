'use strict';

const express = require('express');
const calendar = require('../services/calendar');
const taskStore = require('../taskStore');
const settingsStore = require('../settingsStore');
const { composeBrief } = require('../services/brief');
const { sendError } = require('../httpError');

const router = express.Router();

/**
 * GET /brief/:provider?tzOffsetMinutes=&date=
 * A read-only "how's my day" summary: meetings, free/focus time, next event,
 * top task, and at-risk deadlines. Writes nothing.
 */
router.get('/:provider', async (req, res) => {
  try {
    const tzOffsetMinutes = Number(req.query.tzOffsetMinutes) || 0;
    const { date } = req.query;
    const events = await calendar.getEvents(req.params.provider, { range: 'day', date, tzOffsetMinutes });
    const brief = composeBrief(events, taskStore.list(), { tzOffsetMinutes, ruleOverrides: settingsStore.rules(tzOffsetMinutes) });
    res.json(brief);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
