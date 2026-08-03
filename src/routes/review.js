'use strict';

const express = require('express');
const calendar = require('../services/calendar');
const taskStore = require('../taskStore');
const settingsStore = require('../settingsStore');
const { computeReview } = require('../services/reviewService');
const { sendError } = require('../httpError');

const router = express.Router();

/**
 * GET /review/:provider?tzOffsetMinutes=
 * A read-only weekly look-back: meetings, focus time, deep-work protection,
 * task throughput, and habit streaks (last 7 days, with a trend vs the prior 7).
 */
router.get('/:provider', async (req, res) => {
  try {
    const tzOffsetMinutes = Number(req.query.tzOffsetMinutes) || 0;
    // Fetch ~6 weeks so we can compare weeks and draw the meeting-trend sparkline.
    const now = new Date();
    const start = new Date(now.getTime() - 45 * 86400000).toISOString();
    const end = new Date(now.getTime() + 86400000).toISOString();
    const events = await calendar.getEvents(req.params.provider, { start, end });
    res.json(computeReview(events, taskStore.list(), { tzOffsetMinutes, ruleOverrides: settingsStore.rules(tzOffsetMinutes) }));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
