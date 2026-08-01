'use strict';

const { google } = require('googleapis');
const { config } = require('../config');
const tokenStore = require('../tokenStore');

const PROVIDER = 'google';

/** Builds a fresh OAuth2 client bound to our credentials + redirect URI. */
function createOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

/** Returns the Google consent-screen URL to start the OAuth flow. */
function getAuthUrl(state) {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // request a refresh token
    prompt: 'consent', // ensure a refresh token is returned on re-auth
    scope: config.google.scopes,
    state,
  });
}

/** Exchanges an authorization code for tokens and persists them (encrypted). */
async function handleCallback(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  // Preserve any previously stored refresh token if Google omits it on re-auth.
  const existing = tokenStore.getTokens(PROVIDER) || {};
  const merged = { ...existing, ...tokens };
  tokenStore.saveTokens(PROVIDER, merged);
  return merged;
}

/**
 * Returns an authenticated OAuth2 client using stored tokens, refreshing the
 * access token as needed. googleapis refreshes automatically; we listen for
 * new tokens and persist them so the app stays logged in.
 */
function getAuthenticatedClient() {
  const stored = tokenStore.getTokens(PROVIDER);
  if (!stored) return null;
  const client = createOAuthClient();
  client.setCredentials(stored);
  client.on('tokens', (tokens) => {
    tokenStore.saveTokens(PROVIDER, tokens);
  });
  return client;
}

/**
 * Lightweight connectivity check: lists the user's calendars. Returns a status
 * object describing whether the Google Calendar connection is live.
 */
async function checkConnection() {
  if (!tokenStore.hasTokens(PROVIDER)) {
    return { provider: PROVIDER, connected: false, reason: 'not_authenticated' };
  }
  try {
    const auth = getAuthenticatedClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.calendarList.list({ maxResults: 1 });
    return {
      provider: PROVIDER,
      connected: true,
      calendars: res.data.items ? res.data.items.length : 0,
    };
  } catch (err) {
    return { provider: PROVIDER, connected: false, reason: 'api_error', error: err.message };
  }
}

module.exports = { getAuthUrl, handleCallback, getAuthenticatedClient, checkConnection, PROVIDER };
