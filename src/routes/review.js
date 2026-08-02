'use strict';

const express = require('express');
const calendar = require('../services/calendar');
const taskStore = require('../taskStore');
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
    // Fetch ~15 days so we can compare this week to the previous week.
    const now = new Date();
    const start = new Date(now.getTime() - 15 * 86400000).toISOString();
    const end = new Date(now.getTime() + 86400000).toISOString();
    const events = await calendar.getEvents(req.params.provider, { start, end });
    res.json(computeReview(events, taskStore.list(), { tzOffsetMinutes }));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
