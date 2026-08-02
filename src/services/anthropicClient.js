'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');
const { notConfiguredError } = require('../errors');

let client = null;

/**
 * Lazily-constructed Anthropic (Claude) client. Throws NOT_CONFIGURED when no
 * API key is set so callers can fall back cleanly.
 */
function getAnthropic() {
  if (!config.anthropic.apiKey) {
    throw notConfiguredError('Claude is not configured — set ANTHROPIC_API_KEY.');
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return client;
}

module.exports = { getAnthropic };
