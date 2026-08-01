'use strict';

const google = require('./google');
const outlook = require('./outlook');
const { validationError } = require('../errors');
const { resolveRange, resolveEventTimes } = require('./calendarUtils');

const PROVIDERS = { google, outlook };

/** Resolves a provider service by name, or throws a 400-style error. */
function service(provider) {
  const svc = PROVIDERS[provider];
  if (!svc) {
    throw validationError(`Unknown provider: ${JSON.stringify(provider)} (expected "google" or "outlook").`);
  }
  return svc;
}

/**
 * 1) Fetch all events for a given day or week.
 *
 * @param {string} provider  'google' | 'outlook'
 * @param {object} opts      { range: 'day'|'week', date?, start?, end? }
 */
async function getEvents(provider, opts = {}) {
  const window = resolveRange(opts);
  return service(provider).listEvents(window);
}

/**
 * 2) Add a new event with a title, time, and description.
 *
 * @param {string} provider
 * @param {object} input  { title, start, end?, duration?, description?, location?, timeZone? }
 *                        Provide `end` or `duration` (minutes); defaults to 60 min.
 */
async function createEvent(provider, input = {}) {
  if (!input.title || !String(input.title).trim()) {
    throw validationError('`title` is required.');
  }
  if (!input.start) {
    throw validationError('`start` time is required.');
  }
  const duration = input.end == null && input.duration == null ? 60 : input.duration;
  const { start, end } = resolveEventTimes({ start: input.start, end: input.end, duration }, null);
  return service(provider).createEvent({
    title: String(input.title).trim(),
    description: input.description,
    location: input.location,
    timeZone: input.timeZone,
    start,
    end,
  });
}

/**
 * 3) Delete an event using its ID.
 */
async function deleteEvent(provider, eventId) {
  if (!eventId) throw validationError('`eventId` is required.');
  return service(provider).deleteEvent(eventId);
}

/**
 * 4) Update an existing event's time or duration.
 *
 * @param {object} changes  { start?, end?, duration? } — at least one required.
 */
async function updateEvent(provider, eventId, changes = {}) {
  if (!eventId) throw validationError('`eventId` is required.');
  const { start, end, duration } = changes;
  if (start == null && end == null && duration == null) {
    throw validationError('Provide at least one of `start`, `end`, or `duration` to update.');
  }
  return service(provider).updateEvent(eventId, { start, end, duration });
}

module.exports = { getEvents, createEvent, deleteEvent, updateEvent };
