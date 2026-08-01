'use strict';

const express = require('express');
const calendar = require('../services/calendar');
const { sendError } = require('../httpError');

const router = express.Router();

/** GET /calendar/:provider/events?range=day|week&date=YYYY-MM-DD  (or ?start=&end=) */
router.get('/:provider/events', async (req, res) => {
  try {
    const { range, date, start, end } = req.query;
    const events = await calendar.getEvents(req.params.provider, { range, date, start, end });
    res.json({ provider: req.params.provider, count: events.length, events });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /calendar/:provider/events  { title, start, end|duration, description, location } */
router.post('/:provider/events', async (req, res) => {
  try {
    const event = await calendar.createEvent(req.params.provider, req.body || {});
    res.status(201).json({ provider: req.params.provider, event });
  } catch (err) {
    sendError(res, err);
  }
});

/** PATCH /calendar/:provider/events/:id  { start?, end?, duration? } */
router.patch('/:provider/events/:id', async (req, res) => {
  try {
    const event = await calendar.updateEvent(req.params.provider, req.params.id, req.body || {});
    res.json({ provider: req.params.provider, event });
  } catch (err) {
    sendError(res, err);
  }
});

/** DELETE /calendar/:provider/events/:id */
router.delete('/:provider/events/:id', async (req, res) => {
  try {
    const result = await calendar.deleteEvent(req.params.provider, req.params.id);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
