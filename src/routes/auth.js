'use strict';

const crypto = require('crypto');
const express = require('express');
const { providerConfigured } = require('../config');
const tokenStore = require('../tokenStore');
const googleService = require('../services/google');
const outlookService = require('../services/outlook');

const router = express.Router();

// Short-lived, single-use OAuth `state` values for CSRF protection.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function issueState(provider) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { provider, expires: Date.now() + STATE_TTL_MS });
  return state;
}

function consumeState(state, provider) {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state);
  return entry.provider === provider && entry.expires > Date.now();
}

const services = { google: googleService, outlook: outlookService };

/** GET /auth/:provider — redirect the user to the provider's consent screen. */
router.get('/:provider', async (req, res) => {
  const { provider } = req.params;
  const service = services[provider];
  if (!service) return res.status(404).json({ error: `Unknown provider: ${provider}` });
  if (!providerConfigured[provider]()) {
    return res.status(503).json({ error: `${provider} OAuth is not configured on the server.` });
  }
  try {
    const state = issueState(provider);
    const url = await service.getAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: `Failed to start ${provider} auth`, detail: err.message });
  }
});

/** GET /auth/:provider/callback — exchange the code for tokens and store them. */
router.get('/:provider/callback', async (req, res) => {
  const { provider } = req.params;
  const service = services[provider];
  if (!service) return res.status(404).json({ error: `Unknown provider: ${provider}` });

  const { code, state, error, error_description: errorDescription } = req.query;
  // After the OAuth handshake, land the user back in the web app.
  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(String(errorDescription || error))}`);
  }
  if (!code) return res.redirect('/?auth_error=missing_code');
  if (!state || !consumeState(String(state), provider)) {
    return res.redirect('/?auth_error=invalid_state');
  }

  try {
    await service.handleCallback(String(code));
    res.redirect(`/?connected=${encodeURIComponent(provider)}`);
  } catch (err) {
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

/** POST /auth/:provider/logout — remove stored tokens for a provider. */
router.post('/:provider/logout', (req, res) => {
  const { provider } = req.params;
  if (!services[provider]) return res.status(404).json({ error: `Unknown provider: ${provider}` });
  tokenStore.clearTokens(provider);
  res.json({ status: 'disconnected', provider });
});

module.exports = router;
