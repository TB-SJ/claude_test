'use strict';

const webpush = require('web-push');
const { config, providerConfigured } = require('../config');
const { notConfiguredError } = require('../errors');

let configured = false;

function ensureConfigured() {
  if (!providerConfigured.push()) {
    throw notConfiguredError('Push is not configured — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.');
  }
  if (!configured) {
    webpush.setVapidDetails(config.notify.vapidSubject, config.notify.vapidPublic, config.notify.vapidPrivate);
    configured = true;
  }
}

function isEnabled() {
  return providerConfigured.push();
}

/**
 * Sends one push. Returns { ok } on success or { gone: true } when the
 * subscription is expired/invalid (HTTP 404/410) so the caller can prune it.
 */
async function sendTo(subscription, payload) {
  ensureConfigured();
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) return { gone: true };
    throw err;
  }
}

module.exports = { isEnabled, sendTo, publicKey: () => config.notify.vapidPublic };
