'use strict';

const logger = require('./logger');

/** Client-side validation failure (bad/missing input). Maps to HTTP 400. */
function validationError(message) {
  const err = new Error(message);
  err.code = 'VALIDATION';
  return err;
}

/** No stored/valid OAuth session for the provider. Maps to HTTP 401. */
function notAuthenticatedError(provider) {
  const err = new Error(`${provider} is not authenticated — complete the OAuth flow first.`);
  err.code = 'NOT_AUTHENTICATED';
  err.provider = provider;
  return err;
}

/** A required integration is not configured (e.g. missing key). Maps to HTTP 503. */
function notConfiguredError(message) {
  const err = new Error(message);
  err.code = 'NOT_CONFIGURED';
  return err;
}

/**
 * Pulls precise details out of a provider SDK error. Handles both the
 * googleapis/gaxios shape (`err.response.data.error`) and the Microsoft Graph
 * shape (`err.statusCode` + `err.body`).
 */
function extractDetails(err) {
  const details = { message: err.message };
  if (err.code != null) details.code = err.code;

  // googleapis / gaxios
  if (err.response) {
    if (err.response.status != null) details.status = err.response.status;
    const data = err.response.data;
    if (data && data.error) {
      if (typeof data.error === 'string') {
        details.apiMessage = data.error;
      } else {
        details.apiMessage = data.error.message;
        if (Array.isArray(data.error.errors)) {
          details.reasons = data.error.errors.map((e) => e.reason).filter(Boolean);
        }
      }
    }
  }

  // OpenAI SDK (APIError)
  if (err.status != null && details.status == null) details.status = err.status;
  if (err.error && err.error.message) details.apiMessage = err.error.message;
  if (err.type) details.type = err.type;

  // Microsoft Graph (GraphError)
  if (err.statusCode != null) details.status = err.statusCode;
  if (err.body) {
    try {
      const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
      if (body && body.error) {
        details.code = body.error.code || details.code;
        details.apiMessage = body.error.message || details.apiMessage;
      }
    } catch (_) {
      details.body = String(err.body).slice(0, 500);
    }
  }
  if (err.requestId) details.requestId = err.requestId;
  return details;
}

/**
 * Logs a precise, structured error for a failed calendar API call and returns a
 * wrapped Error carrying those details for the caller to surface. Always throw
 * the returned value so the stack originates at the call site.
 */
function apiError(provider, operation, err, context = {}) {
  // Don't re-wrap our own typed errors (e.g. an auth/config check that ran
  // inside the try block) — let them keep their code so routes map correctly.
  if (err && ['NOT_AUTHENTICATED', 'VALIDATION', 'NOT_CONFIGURED'].includes(err.code)) {
    return err;
  }
  const details = extractDetails(err);
  logger.error(`${provider}.${operation} API call failed`, { provider, operation, ...context, ...details });
  const wrapped = new Error(
    `[${provider}] ${operation} failed` +
      (details.status ? ` (HTTP ${details.status})` : '') +
      `: ${details.apiMessage || details.message}`
  );
  wrapped.code = 'API_ERROR';
  wrapped.provider = provider;
  wrapped.operation = operation;
  wrapped.status = details.status;
  wrapped.details = details;
  return wrapped;
}

module.exports = { validationError, notAuthenticatedError, notConfiguredError, apiError };
