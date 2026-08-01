'use strict';

const express = require('express');
const { providerConfigured } = require('../config');
const googleService = require('../services/google');
const outlookService = require('../services/outlook');

const router = express.Router();

/**
 * GET /health — basic liveness plus a live connectivity check for each
 * configured provider. Returns HTTP 200 whenever the server is up; the body
 * reports per-provider connection status so a caller can confirm the OAuth
 * links actually work.
 */
router.get('/', async (req, res) => {
  const providers = {};

  if (providerConfigured.google()) {
    providers.google = await googleService.checkConnection();
  } else {
    providers.google = { provider: 'google', connected: false, reason: 'not_configured' };
  }

  if (providerConfigured.outlook()) {
    providers.outlook = await outlookService.checkConnection();
  } else {
    providers.outlook = { provider: 'outlook', connected: false, reason: 'not_configured' };
  }

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    providers,
  });
});

module.exports = router;
