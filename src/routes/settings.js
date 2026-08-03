'use strict';

const express = require('express');
const settingsStore = require('../settingsStore');
const taskStore = require('../taskStore');
const { sendError } = require('../httpError');

const router = express.Router();

/** GET /settings — the current user settings (scheduling rules, brief, prefs). */
router.get('/', (req, res) => {
  res.json({ settings: settingsStore.current(), defaults: settingsStore.DEFAULTS });
});

/** PUT /settings — validate + persist a patch. Returns the merged settings. */
router.put('/', async (req, res) => {
  try {
    const next = await settingsStore.save(req.body || {});
    res.json({ settings: next });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /settings/export — a JSON backup of everything the app stores locally
 * (tasks + settings). Downloadable so nothing is lost if the host is reset.
 */
router.get('/export', (req, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    settings: settingsStore.current(),
    tasks: taskStore.list(),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="calendar-optimizer-backup.json"');
  res.json(payload);
});

module.exports = router;
