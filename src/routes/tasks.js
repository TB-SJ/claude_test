'use strict';

const express = require('express');
const taskStore = require('../taskStore');
const settingsStore = require('../settingsStore');
const calendar = require('../services/calendar');
const calendarUtils = require('../services/calendarUtils');
const { scheduleTasks } = require('../services/taskScheduler');
const { sendError } = require('../httpError');
const { validationError } = require('../errors');

const router = express.Router();

/** GET /tasks — list all tasks. */
router.get('/', (req, res) => {
  res.json({ tasks: taskStore.list() });
});

/** POST /tasks — create a task { title, estimatedMinutes?, priority?, deadline? }. */
router.post('/', async (req, res) => {
  try {
    const { title } = req.body || {};
    if (!title || !String(title).trim()) throw validationError('`title` is required.');
    const task = taskStore.add(req.body || {});
    await taskStore.flush();
    res.status(201).json({ task });
  } catch (err) {
    sendError(res, err);
  }
});

/** PATCH /tasks/:id — update a task (e.g. mark done). */
router.patch('/:id', async (req, res) => {
  const updated = taskStore.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });
  await taskStore.flush();
  res.json({ task: updated });
});

/** DELETE /tasks/:id — remove a task. */
router.delete('/:id', async (req, res) => {
  const ok = taskStore.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });
  await taskStore.flush();
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
    const { tzOffsetMinutes, date, priorityTag, order, exclude, floors } = req.body || {};
    const tz = Number(tzOffsetMinutes) || 0;
    const anchor = date || calendarUtils.localNoonAnchor(tz);
    const events = await calendar.getEvents(req.params.provider, { range: 'day', date: anchor, tzOffsetMinutes: tz });
    const plan = scheduleTasks(taskStore.list(), events, settingsStore.rules(tz), {
      date,
      priorityTag: calendarUtils.normTag(priorityTag),
      order: Array.isArray(order) ? order : null,
      exclude: Array.isArray(exclude) ? exclude : null,
      floors: floors && typeof floors === 'object' ? floors : null,
    });
    res.json(plan);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /tasks/commit/:provider  { slots: [{ title, start, end, taskId? }] }
 * Time-blocking: writes accepted task slots onto the calendar as events (titled
 * with a 📋 prefix so they're distinct). Explicit, opt-in — tasks otherwise stay
 * app-only. Committed tasks are marked done so they don't get re-planned.
 */
router.post('/commit/:provider', async (req, res) => {
  try {
    calendar.assertProvider(req.params.provider);
    const { slots } = req.body || {};
    if (!Array.isArray(slots) || slots.length === 0) {
      throw validationError('`slots` must be a non-empty array of { title, start, end }.');
    }
    const results = [];
    for (const s of slots) {
      if (!s || !s.title || !s.start || !s.end) {
        throw validationError('Each slot needs `title`, `start`, and `end`.');
      }
      try {
        const event = await calendar.createEvent(req.params.provider, {
          title: `📋 ${s.title}`,
          start: s.start,
          end: s.end,
          description: 'Time block for a task (created by Calendar Optimizer).',
        });
        if (s.taskId) taskStore.update(s.taskId, { done: true });
        results.push({ taskId: s.taskId || null, ok: true, event });
      } catch (err) {
        results.push({ taskId: s.taskId || null, ok: false, error: err.message, code: err.code });
      }
    }
    await taskStore.flush();
    const created = results.filter((r) => r.ok).length;
    res.json({ created, failed: results.length - created, results });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
