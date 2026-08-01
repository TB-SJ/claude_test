'use strict';

/** Maps a typed application/service error to an HTTP status code. */
function statusFor(err) {
  switch (err && err.code) {
    case 'VALIDATION':
      return 400;
    case 'NOT_AUTHENTICATED':
      return 401;
    case 'NOT_CONFIGURED':
      return 503;
    case 'API_ERROR':
      return 502;
    default:
      return 500;
  }
}

/** Sends a consistent JSON error body with the mapped status code. */
function sendError(res, err) {
  res.status(statusFor(err)).json({
    error: err.message,
    code: err.code || 'INTERNAL',
    details: err.details,
  });
}

module.exports = { statusFor, sendError };
