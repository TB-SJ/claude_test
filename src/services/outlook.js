'use strict';

const msal = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
const { config } = require('../config');
const tokenStore = require('../tokenStore');

const PROVIDER = 'outlook';
const GRAPH_SCOPES = ['Calendars.Read', 'User.Read'];

/**
 * MSAL cache plugin backed by our encrypted token store. MSAL serializes its
 * token cache (access + refresh tokens, accounts) to a string; we persist that
 * string encrypted at rest so refresh tokens never touch disk in plaintext and
 * the app stays logged in across restarts.
 */
const cachePlugin = {
  async beforeCacheAccess(cacheContext) {
    const stored = tokenStore.getTokens(PROVIDER);
    if (stored && stored.cache) {
      cacheContext.tokenCache.deserialize(stored.cache);
    }
  },
  async afterCacheAccess(cacheContext) {
    if (cacheContext.cacheHasChanged) {
      tokenStore.saveTokens(PROVIDER, { cache: cacheContext.tokenCache.serialize() });
    }
  },
};

let cachedApp = null;

/** Lazily builds the MSAL confidential client application (singleton). */
function getApp() {
  if (cachedApp) return cachedApp;
  cachedApp = new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.outlook.clientId,
      clientSecret: config.outlook.clientSecret,
      authority: `https://login.microsoftonline.com/${config.outlook.tenantId}`,
    },
    cache: { cachePlugin },
  });
  return cachedApp;
}

/** Returns the Microsoft consent-screen URL to start the OAuth flow. */
function getAuthUrl(state) {
  return getApp().getAuthCodeUrl({
    scopes: GRAPH_SCOPES,
    redirectUri: config.outlook.redirectUri,
    state,
  });
}

/** Exchanges an authorization code for tokens; MSAL persists them via cache plugin. */
async function handleCallback(code) {
  const result = await getApp().acquireTokenByCode({
    code,
    scopes: GRAPH_SCOPES,
    redirectUri: config.outlook.redirectUri,
  });
  return result;
}

/** Returns the first cached account, or null if the user is not authenticated. */
async function getAccount() {
  const accounts = await getApp().getTokenCache().getAllAccounts();
  return accounts && accounts.length ? accounts[0] : null;
}

/**
 * Acquires an access token silently (using the cached refresh token). Returns
 * null when there is no usable session.
 */
async function getAccessToken() {
  const account = await getAccount();
  if (!account) return null;
  const result = await getApp().acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
  return result ? result.accessToken : null;
}

/** Builds a Microsoft Graph client authenticated with a fresh access token. */
async function getGraphClient() {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  return Client.init({ authProvider: (done) => done(null, accessToken) });
}

/**
 * Lightweight connectivity check: lists the user's Outlook calendars via Graph.
 */
async function checkConnection() {
  if (!tokenStore.hasTokens(PROVIDER)) {
    return { provider: PROVIDER, connected: false, reason: 'not_authenticated' };
  }
  try {
    const client = await getGraphClient();
    if (!client) {
      return { provider: PROVIDER, connected: false, reason: 'not_authenticated' };
    }
    const res = await client.api('/me/calendars').top(1).get();
    return {
      provider: PROVIDER,
      connected: true,
      calendars: res && res.value ? res.value.length : 0,
    };
  } catch (err) {
    return { provider: PROVIDER, connected: false, reason: 'api_error', error: err.message };
  }
}

module.exports = { getAuthUrl, handleCallback, getGraphClient, checkConnection, PROVIDER };
