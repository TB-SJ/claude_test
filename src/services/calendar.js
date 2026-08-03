'use strict';

const google = require('./google');
const outlook = require('./outlook');
const { validationError } = require('../errors');
const { resolveRange, resolveEventTimes, recurrenceFromInput, normTag } = require('./calendarUtils');

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
 * @param {object} input  { title, start, end?, duration?, description?, location?, timeZone?,
 *                          repeat?, repeatCount?, recurrence? }
 *                        Provide `end` or `duration` (minutes); defaults to 60 min.
 *                        `repeat` is a preset key (e.g. 'weekly', 'biweekly') or a
 *                        spec object; `recurrence` is a raw RRULE array.
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
  const recurrence = recurrenceFromInput(input);
  return service(provider).createEvent({
    title: String(input.title).trim(),
    description: input.description,
    location: input.location,
    timeZone: input.timeZone,
    start,
    end,
    recurrence,
    tag: normTag(input.tag),
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
 * 4) Update an existing event's time, duration, title, or description.
 *
 * @param {object} changes  { start?, end?, duration?, title?, description? }
 *                          — at least one required.
 */
async function updateEvent(provider, eventId, changes = {}) {
  if (!eventId) throw validationError('`eventId` is required.');
  const { start, end, duration, title, description, tag } = changes;
  if (start == null && end == null && duration == null && title == null && description == null && tag === undefined) {
    throw validationError('Provide at least one of `start`, `end`, `duration`, `title`, `description`, or `tag` to update.');
  }
  if (title != null && !String(title).trim()) {
    throw validationError('`title` cannot be empty.');
  }
  // Normalize the tag; empty string clears it.
  const normedTag = tag === undefined ? undefined : (tag === '' ? '' : normTag(tag));
  return service(provider).updateEvent(eventId, { start, end, duration, title, description, tag: normedTag });
}

/** Throws a 400-style error if `provider` is not a known calendar provider. */
function assertProvider(provider) {
  service(provider);
}

module.exports = { getEvents, createEvent, deleteEvent, updateEvent, assertProvider };
