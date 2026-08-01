'use strict';

/**
 * Minimal structured logger. Writes a timestamped, leveled line plus an
 * optional JSON metadata object so failures carry precise, greppable context.
 */
function emit(level, msg, meta) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  const sink = level === 'error' ? console.error : console.log;
  if (meta && Object.keys(meta).length > 0) {
    sink(`${line} ${JSON.stringify(meta)}`);
  } else {
    sink(line);
  }
}

module.exports = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};
