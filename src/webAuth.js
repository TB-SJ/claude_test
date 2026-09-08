'use strict';

const crypto = require('crypto');
const { config } = require('./config');

// ---------------------------------------------------------------------------
// Single-user password gate with a signed session cookie.
//
// If APP_PASSWORD is unset, the gate is DISABLED (open) — convenient for local
// use. Set APP_PASSWORD before hosting to require login. The session cookie is
// an HMAC-signed token; the signing secret is derived from the password (so
// changing the password invalidates existing sessions).
// ---------------------------------------------------------------------------

const COOKIE = 'sid';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function enabled() {
  return Boolean(config.app.password);
}

function sessionSecret() {
  if (config.app.sessionSecret) return config.app.sessionSecret;
  // Derive a stable secret from the password when none is provided.
  return crypto.createHash('sha256').update(`session:${config.app.password}`).digest('hex');
}

/** Creates a signed session token: base64url(payload).base64url(hmac). */
function issueToken() {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now() })).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** Verifies a session token's signature and age. */
function validToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return false;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { iat } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof iat === 'number' && Date.now() - iat < MAX_AGE_MS;
  } catch (_) {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!enabled()) return true;
  return validToken(parseCookies(req)[COOKIE]);
}

/** Verifies a submitted password in constant time. Both sides are trimmed so a
 *  stray leading/trailing space (paste artifact) doesn't cause a false reject. */
function checkPassword(input) {
  if (!enabled()) return true;
  const a = Buffer.from(String(input || '').trim());
  const b = Buffer.from(config.app.password); // already trimmed at config load
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setSessionCookie(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = [
    `${COOKIE}=${issueToken()}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

/** Middleware for API routers: 401 JSON when not authenticated. */
function requireAuthApi(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'Not authenticated', code: 'LOGIN_REQUIRED' });
}

/** Middleware for pages: redirect to /login when not authenticated. */
function requireAuthPage(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect('/login');
}

module.exports = {
  enabled,
  checkPassword,
  setSessionCookie,
  clearSessionCookie,
  requireAuthApi,
  requireAuthPage,
  isAuthed,
};
