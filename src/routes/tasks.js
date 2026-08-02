'use strict';

const express = require('express');
const taskStore = require('../taskStore');
const calendar = require('../services/calendar');
const { scheduleTasks } = require('../services/taskScheduler');
const { sendError } = require('../httpError');
const { validationError } = require('../errors');

const router = express.Router();

/** GET /tasks — list all tasks. */
router.get('/', (req, res) => {
  res.json({ tasks: taskStore.list() });
});

/** POST /tasks — create a task { title, estimatedMinutes?, priority?, deadline? }. */
router.post('/', (req, res) => {
  try {
    const { title } = req.body || {};
    if (!title || !String(title).trim()) throw validationError('`title` is required.');
    res.status(201).json({ task: taskStore.add(req.body || {}) });
  } catch (err) {
    sendError(res, err);
  }
});

/** PATCH /tasks/:id — update a task (e.g. mark done). */
router.patch('/:id', (req, res) => {
  const updated = taskStore.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });
  res.json({ task: updated });
});

/** DELETE /tasks/:id — remove a task. */
router.delete('/:id', (req, res) => {
  const ok = taskStore.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });
  res.json({ deleted: true, id: req.params.id });
});

/**
 * POST /tasks/plan/:provider  { tzOffsetMinutes?, date? }
 * Suggests when to do the pending tasks by fitting them into the day's free
 * time around real calendar events. Read-only — writes nothing.
 */
router.post('/plan/:provider', async (req, res) => {
  try {
    calendar.assertProvider(req.params.provider);
    const { tzOffsetMinutes, date } = req.body || {};
    const events = await calendar.getEvents(req.params.provider, { range: 'day', date });
    const plan = scheduleTasks(taskStore.list(), events, { tzOffsetMinutes: Number(tzOffsetMinutes) || 0 }, { date });
    res.json(plan);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
