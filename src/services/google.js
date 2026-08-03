'use strict';

const { google } = require('googleapis');
const { config } = require('../config');
const tokenStore = require('../tokenStore');
const { apiError, notAuthenticatedError } = require('../errors');
const { resolveEventTimes } = require('./calendarUtils');

const PROVIDER = 'google';
const CALENDAR_ID = 'primary';

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

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

/** Returns an authenticated Calendar API client, or throws if not logged in. */
function calendarApi() {
  const auth = getAuthenticatedClient();
  if (!auth) throw notAuthenticatedError(PROVIDER);
  return google.calendar({ version: 'v3', auth });
}

/** Maps a Google event resource to the app's normalized event shape. */
function normalizeEvent(ev) {
  return {
    id: ev.id,
    provider: PROVIDER,
    title: ev.summary || '',
    description: ev.description || '',
    location: ev.location || '',
    // All-day events use `date`; timed events use `dateTime`.
    start: (ev.start && (ev.start.dateTime || ev.start.date)) || null,
    end: (ev.end && (ev.end.dateTime || ev.end.date)) || null,
    status: ev.status,
    htmlLink: ev.htmlLink,
    // Our own work/personal tag, stored as a private extended property.
    tag: (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.tag) || null,
  };
}

/** Fetches a single event (used to resolve relative time/duration updates). */
async function getEventById(eventId) {
  try {
    const res = await calendarApi().events.get({ calendarId: CALENDAR_ID, eventId });
    return normalizeEvent(res.data);
  } catch (err) {
    throw apiError(PROVIDER, 'getEvent', err, { eventId });
  }
}

/** 1) Lists events within an ISO time window [start, end). */
async function listEvents({ start, end }) {
  try {
    const res = await calendarApi().events.list({
      calendarId: CALENDAR_ID,
      timeMin: start,
      timeMax: end,
      singleEvents: true, // expand recurring events into instances
      orderBy: 'startTime',
      maxResults: 2500,
    });
    return (res.data.items || []).map(normalizeEvent);
  } catch (err) {
    throw apiError(PROVIDER, 'listEvents', err, { start, end });
  }
}

/** 2) Creates an event. Expects fully-resolved ISO `start`/`end`. `recurrence`
 * is an optional RRULE array; recurring events need a timeZone (so DST is
 * handled), falling back to UTC when the client didn't send one. */
async function createEvent({ title, start, end, description, location, timeZone, recurrence, tag }) {
  try {
    const tz = recurrence && recurrence.length ? (timeZone || 'UTC') : timeZone;
    const requestBody = {
      summary: title,
      description,
      location,
      start: { dateTime: start, timeZone: tz },
      end: { dateTime: end, timeZone: tz },
    };
    if (recurrence && recurrence.length) requestBody.recurrence = recurrence;
    if (tag) requestBody.extendedProperties = { private: { tag } };
    const res = await calendarApi().events.insert({ calendarId: CALENDAR_ID, requestBody });
    return normalizeEvent(res.data);
  } catch (err) {
    throw apiError(PROVIDER, 'createEvent', err, { title, start, end });
  }
}

/** 3) Deletes an event by ID. */
async function deleteEvent(eventId) {
  try {
    await calendarApi().events.delete({ calendarId: CALENDAR_ID, eventId });
    return { id: eventId, provider: PROVIDER, deleted: true };
  } catch (err) {
    throw apiError(PROVIDER, 'deleteEvent', err, { eventId });
  }
}

/** 4) Updates an existing event's time, duration, title, and/or description. */
async function updateEvent(eventId, { start, end, duration, title, description, tag } = {}) {
  const existing = await getEventById(eventId);
  const requestBody = {};
  let times = null;
  if (start != null || end != null || duration != null) {
    times = resolveEventTimes({ start, end, duration }, existing);
    requestBody.start = { dateTime: times.start };
    requestBody.end = { dateTime: times.end };
  }
  if (title != null) requestBody.summary = String(title).trim();
  if (description != null) requestBody.description = String(description);
  // Set/clear our work/personal tag (empty string clears it).
  if (tag !== undefined) requestBody.extendedProperties = { private: { tag: tag || null } };
  try {
    const res = await calendarApi().events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody,
    });
    return normalizeEvent(res.data);
  } catch (err) {
    throw apiError(PROVIDER, 'updateEvent', err, { eventId, ...(times || {}) });
  }
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getAuthenticatedClient,
  checkConnection,
  listEvents,
  createEvent,
  deleteEvent,
  updateEvent,
  getEventById,
  PROVIDER,
};
