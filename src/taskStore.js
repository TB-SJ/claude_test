'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tasks are app-only (never written to the calendar). Stored locally as JSON.
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'tasks.json');

const PRIORITIES = ['high', 'med', 'low'];

function readAll() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8') || '[]');
  } catch (_) {
    return [];
  }
}

function writeAll(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

function clampMinutes(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, 8 * 60); // cap at a workday
}

function normPriority(p) {
  const s = String(p || '').toLowerCase();
  return PRIORITIES.includes(s) ? s : 'med';
}

function list() {
  return readAll();
}

function add({ title, estimatedMinutes, priority, deadline }) {
  const t = {
    id: crypto.randomUUID(),
    title: String(title || '').trim(),
    estimatedMinutes: clampMinutes(estimatedMinutes),
    priority: normPriority(priority),
    deadline: deadline || null, // YYYY-MM-DD or null
    done: false,
    createdAt: new Date().toISOString(),
  };
  const all = readAll();
  all.push(t);
  writeAll(all);
  return t;
}

function update(id, patch = {}) {
  const all = readAll();
  const i = all.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const clean = {};
  if (patch.title != null) clean.title = String(patch.title).trim();
  if (patch.estimatedMinutes != null) clean.estimatedMinutes = clampMinutes(patch.estimatedMinutes);
  if (patch.priority != null) clean.priority = normPriority(patch.priority);
  if (patch.deadline !== undefined) clean.deadline = patch.deadline || null;
  if (patch.done != null) clean.done = Boolean(patch.done);
  all[i] = { ...all[i], ...clean };
  writeAll(all);
  return all[i];
}

function remove(id) {
  const all = readAll();
  const next = all.filter((t) => t.id !== id);
  writeAll(next);
  return next.length !== all.length;
}

module.exports = { list, add, update, remove, PRIORITIES };
