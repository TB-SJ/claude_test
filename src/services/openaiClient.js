'use strict';

const OpenAI = require('openai');
const { config } = require('../config');
const { notConfiguredError } = require('../errors');

let client = null;

/**
 * Returns a lazily-constructed OpenAI client. Throws a NOT_CONFIGURED error
 * (mapped to HTTP 503) when no API key is set so callers fail fast with a clear
 * message rather than an opaque auth error from the SDK.
 */
function getOpenAI() {
  if (!config.openai.apiKey) {
    throw notConfiguredError('OpenAI is not configured — set OPENAI_API_KEY to use the voice interface.');
  }
  if (!client) {
    client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return client;
}

module.exports = { getOpenAI };
