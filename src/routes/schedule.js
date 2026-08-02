'use strict';

const express = require('express');
const calendar = require('../services/calendar');
const { optimize } = require('../services/scheduleOptimizer');
const claudeOptimizer = require('../services/claudeOptimizer');
const logger = require('../logger');
const { sendError } = require('../httpError');
const { validationError } = require('../errors');

const router = express.Router();

/** Serializes the optimize() result for JSON (drops the internal Map). */
function serialize(result, events, engine) {
  return {
    rules: result.rules,
    analysis: {
      counts: result.analysis.counts,
      conflicts: result.analysis.conflicts,
      bufferIssues: result.analysis.bufferIssues,
      fragmentedGaps: result.analysis.fragmentedGaps,
      deepWorkViolations: result.analysis.deepWorkViolations,
    },
    moves: result.moves,
    unplaceable: result.unplaceable,
    summary: result.summary,
    // Which engine produced the proposal: 'claude', 'rules', or 'rules-fallback'.
    engine,
    // The exact events analyzed, so a client can render Before/After without
    // a second fetch (and against the same snapshot).
    events,
  };
}

/**
 * POST /schedule/:provider/analyze  { date?, range?, rules? }
 * Read-only: returns the analysis + proposed moves. Never writes.
 */
router.post('/:provider/analyze', async (req, res) => {
  try {
    const { date, range, rules, engine } = req.body || {};
    const scope = range === 'day' ? 'day' : 'week';
    const events = await calendar.getEvents(req.params.provider, { range: scope, date });

    // Claude proposes; the deterministic engine validates. Any failure (not
    // configured, API error, or a proposal that breaks the rules) falls back to
    // the free rules optimizer — the calendar is never mutated here regardless.
    if (engine === 'claude' && claudeOptimizer.isEnabled()) {
      try {
        const result = await claudeOptimizer.optimizeWithClaude(events, rules || {}, {
          referenceDate: new Date(),
        });
        res.json(serialize(result, events, 'claude'));
        return;
      } catch (err) {
        logger.warn('Claude optimize failed; using rules engine', { message: err.message });
        res.json(serialize(optimize(events, rules || {}), events, 'rules-fallback'));
        return;
      }
    }

    res.json(serialize(optimize(events, rules || {}), events, 'rules'));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /schedule/:provider/apply  { moves: [...], confirm: true }
 * Applies a previously-proposed set of moves. Requires explicit confirm:true so
 * the calendar is never mutated without confirmation.
 */
router.post('/:provider/apply', async (req, res) => {
  try {
    const { moves, confirm } = req.body || {};
    calendar.assertProvider(req.params.provider);
    if (confirm !== true) {
      throw validationError('Refusing to apply without `confirm: true`.');
    }
    if (!Array.isArray(moves) || moves.length === 0) {
      throw validationError('`moves` must be a non-empty array.');
    }
    const results = [];
    for (const m of moves) {
      if (!m || !m.id || !m.to || !m.to.start || !m.to.end) {
        throw validationError('Each move needs `id` and `to.start`/`to.end`.');
      }
      try {
        const event = await calendar.updateEvent(req.params.provider, m.id, {
          start: m.to.start,
          end: m.to.end,
        });
        results.push({ id: m.id, ok: true, event });
      } catch (err) {
        results.push({ id: m.id, ok: false, error: err.message, code: err.code });
      }
    }
    const applied = results.filter((r) => r.ok).length;
    res.json({ applied, failed: results.length - applied, results });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
