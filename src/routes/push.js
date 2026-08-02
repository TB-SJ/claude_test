'use strict';

const express = require('express');
const push = require('../services/push');
const pushStore = require('../pushStore');
const { sendError } = require('../httpError');
const { validationError, notConfiguredError } = require('../errors');

const router = express.Router();

/** GET /push/key — the VAPID public key + whether push is enabled. */
router.get('/key', (req, res) => {
  res.json({ enabled: push.isEnabled(), publicKey: push.isEnabled() ? push.publicKey() : null });
});

/** GET /push/status — how many devices are subscribed. */
router.get('/status', async (req, res) => {
  try {
    const doc = await pushStore.load();
    res.json({ enabled: push.isEnabled(), subscriptions: doc.subscriptions.length });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /push/subscribe  { subscription, tzOffsetMinutes } */
router.post('/subscribe', async (req, res) => {
  try {
    if (!push.isEnabled()) throw notConfiguredError('Push is not configured on the server.');
    const { subscription, tzOffsetMinutes } = req.body || {};
    if (!subscription || !subscription.endpoint) throw validationError('A valid `subscription` is required.');
    await pushStore.addSubscription(subscription, Number(tzOffsetMinutes) || 0);
    res.status(201).json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /push/unsubscribe  { endpoint } */
router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) throw validationError('`endpoint` is required.');
    await pushStore.removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /push/test — send a test notification to every subscribed device. */
router.post('/test', async (req, res) => {
  try {
    if (!push.isEnabled()) throw notConfiguredError('Push is not configured on the server.');
    const doc = await pushStore.load();
    let sent = 0;
    const stillValid = [];
    for (const sub of doc.subscriptions) {
      const result = await push.sendTo(sub, { title: '🔔 Test', body: 'Notifications are working.', url: '/', tag: 'test' });
      if (result.gone) continue;
      stillValid.push(sub);
      sent += 1;
    }
    if (stillValid.length !== doc.subscriptions.length) {
      await pushStore.save({ ...doc, subscriptions: stillValid });
    }
    res.json({ sent });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
