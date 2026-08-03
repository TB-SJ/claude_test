'use strict';

const express = require('express');
const { config, providerConfigured } = require('../config');
const calendar = require('../services/calendar');
const tokenStore = require('../tokenStore');
const push = require('../services/push');
const pushStore = require('../pushStore');
const { composeBrief } = require('../services/brief');
const { planNotifications } = require('../services/reminderEngine');
const logger = require('../logger');
const taskStore = require('../taskStore');
const settingsStore = require('../settingsStore');

const router = express.Router();

/** The connected calendar provider, or null. */
function activeProvider() {
  for (const p of ['google', 'outlook']) {
    if (providerConfigured[p] && providerConfigured[p]() && tokenStore.hasTokens(p)) return p;
  }
  return null;
}

/**
 * POST|GET /cron/tick?secret=…  (or header x-cron-secret)
 * Called every ~15 min by an external scheduler. Sends the daily brief and any
 * due event reminders via Web Push. Secured by CRON_SECRET (not the login gate,
 * since the caller has no session). Idempotent via stored state.
 */
async function tick(req, res) {
  try {
    const secret = req.get('x-cron-secret') || (req.query && req.query.secret) || '';
    if (!config.notify.cronSecret || secret !== config.notify.cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!push.isEnabled()) return res.json({ ok: true, skipped: 'push_not_configured' });

    const doc = await pushStore.load();
    if (doc.subscriptions.length === 0) return res.json({ ok: true, sent: 0, note: 'no subscriptions' });

    const provider = activeProvider();
    if (!provider) return res.json({ ok: true, sent: 0, note: 'no calendar connected' });

    const tz = doc.tzOffsetMinutes || 0;
    const events = await calendar.getEvents(provider, { range: 'day' });
    const brief = composeBrief(events, taskStore.list(), { tzOffsetMinutes: tz, ruleOverrides: settingsStore.rules(tz) });

    // User-saved notification timing overrides the env defaults.
    const notif = settingsStore.notify();
    const { notifications, state } = planNotifications({
      now: new Date(),
      tzOffsetMinutes: tz,
      briefTime: notif.briefTime || config.notify.briefTime,
      leadMinutes: notif.reminderLeadMinutes != null ? notif.reminderLeadMinutes : config.notify.reminderLeadMinutes,
      brief,
      appUrl: `${config.baseUrl}/`,
      state: doc.state,
    });

    let sent = 0;
    const stillValid = [];
    const goneEndpoints = new Set();
    for (const sub of doc.subscriptions) {
      let alive = true;
      for (const n of notifications) {
        const result = await push.sendTo(sub, n).catch((err) => {
          logger.warn('push send failed', { message: err.message });
          return { ok: true }; // transient — keep the subscription, try next tick
        });
        if (result.gone) { alive = false; break; }
        sent += 1;
      }
      if (alive) stillValid.push(sub);
      else goneEndpoints.add(sub.endpoint);
    }

    await pushStore.save({ ...doc, subscriptions: stillValid, state });
    res.json({ sent, notifications: notifications.length, pruned: goneEndpoints.size });
  } catch (err) {
    logger.error('cron tick failed', { message: err.message });
    res.status(500).json({ error: err.message });
  }
}

router.post('/tick', tick);
router.get('/tick', tick);

module.exports = router;
