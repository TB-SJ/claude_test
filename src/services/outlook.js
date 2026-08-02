'use strict';

const msal = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
const { config } = require('../config');
const tokenStore = require('../tokenStore');
const { apiError, notAuthenticatedError } = require('../errors');
const { resolveEventTimes } = require('./calendarUtils');

const PROVIDER = 'outlook';
const GRAPH_SCOPES = ['Calendars.ReadWrite', 'User.Read'];
const UTC_PREFER = 'outlook.timezone="UTC"';

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

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

/** Returns an authenticated Graph client, or throws if not logged in. */
async function graphOrThrow() {
  const client = await getGraphClient();
  if (!client) throw notAuthenticatedError(PROVIDER);
  return client;
}

/** Graph returns { dateTime, timeZone }; normalize to a UTC ISO string. */
function graphToIso(dt) {
  if (!dt || !dt.dateTime) return null;
  const raw = dt.dateTime;
  // With Prefer: outlook.timezone="UTC" the value has no offset; treat as UTC.
  const withZone = /(Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : `${raw}Z`;
  return new Date(withZone).toISOString();
}

/** Graph wants a naive local dateTime paired with a timeZone; strip the Z. */
function toGraphDateTime(iso) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

/** Maps a Graph event resource to the app's normalized event shape. */
function normalizeEvent(ev) {
  return {
    id: ev.id,
    provider: PROVIDER,
    title: ev.subject || '',
    description: ev.bodyPreview || (ev.body && ev.body.content) || '',
    location: (ev.location && ev.location.displayName) || '',
    start: graphToIso(ev.start),
    end: graphToIso(ev.end),
    status: ev.showAs,
    htmlLink: ev.webLink,
  };
}

/** Fetches a single event (used to resolve relative time/duration updates). */
async function getEventById(eventId) {
  try {
    const ev = await graphOrThrow().then((c) =>
      c.api(`/me/events/${eventId}`).header('Prefer', UTC_PREFER).get()
    );
    return normalizeEvent(ev);
  } catch (err) {
    throw apiError(PROVIDER, 'getEvent', err, { eventId });
  }
}

/** 1) Lists events within an ISO time window [start, end). */
async function listEvents({ start, end }) {
  try {
    const client = await graphOrThrow();
    const res = await client
      .api('/me/calendarView')
      .header('Prefer', UTC_PREFER)
      .query({ startDateTime: start, endDateTime: end })
      .orderby('start/dateTime')
      .top(1000)
      .get();
    return (res.value || []).map(normalizeEvent);
  } catch (err) {
    throw apiError(PROVIDER, 'listEvents', err, { start, end });
  }
}

/** 2) Creates an event. Expects fully-resolved ISO `start`/`end`. */
async function createEvent({ title, start, end, description, location }) {
  try {
    const client = await graphOrThrow();
    const ev = await client.api('/me/events').post({
      subject: title,
      body: { contentType: 'text', content: description || '' },
      start: { dateTime: toGraphDateTime(start), timeZone: 'UTC' },
      end: { dateTime: toGraphDateTime(end), timeZone: 'UTC' },
      location: location ? { displayName: location } : undefined,
    });
    return normalizeEvent(ev);
  } catch (err) {
    throw apiError(PROVIDER, 'createEvent', err, { title, start, end });
  }
}

/** 3) Deletes an event by ID. */
async function deleteEvent(eventId) {
  try {
    const client = await graphOrThrow();
    await client.api(`/me/events/${eventId}`).delete();
    return { id: eventId, provider: PROVIDER, deleted: true };
  } catch (err) {
    throw apiError(PROVIDER, 'deleteEvent', err, { eventId });
  }
}

/** 4) Updates an existing event's time, duration, title, and/or description. */
async function updateEvent(eventId, { start, end, duration, title, description } = {}) {
  const existing = await getEventById(eventId);
  const patch = {};
  let times = null;
  if (start != null || end != null || duration != null) {
    times = resolveEventTimes({ start, end, duration }, existing);
    patch.start = { dateTime: toGraphDateTime(times.start), timeZone: 'UTC' };
    patch.end = { dateTime: toGraphDateTime(times.end), timeZone: 'UTC' };
  }
  if (title != null) patch.subject = String(title).trim();
  if (description != null) patch.body = { contentType: 'text', content: String(description) };
  try {
    const client = await graphOrThrow();
    const ev = await client.api(`/me/events/${eventId}`).patch(patch);
    return normalizeEvent(ev);
  } catch (err) {
    throw apiError(PROVIDER, 'updateEvent', err, { eventId, ...(times || {}) });
  }
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getGraphClient,
  checkConnection,
  listEvents,
  createEvent,
  deleteEvent,
  updateEvent,
  getEventById,
  PROVIDER,
};
