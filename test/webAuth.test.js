'use strict';

// Must set the password BEFORE requiring config/webAuth (env read at load).
process.env.APP_PASSWORD = 'testpw';

const { test } = require('node:test');
const assert = require('node:assert');
const webAuth = require('../src/webAuth');

test('gate is enabled and password check is exact', () => {
  assert.equal(webAuth.enabled(), true);
  assert.equal(webAuth.checkPassword('testpw'), true);
  assert.equal(webAuth.checkPassword('wrong'), false);
  assert.equal(webAuth.checkPassword(''), false);
});

test('session cookie round-trips and rejects tampering', () => {
  let cookieHeader = '';
  const res = { setHeader: (k, v) => { if (k === 'Set-Cookie') cookieHeader = v; } };
  webAuth.setSessionCookie({ secure: false, headers: {} }, res);

  const sid = cookieHeader.split(';')[0]; // "sid=<token>"
  assert.ok(sid.startsWith('sid='));

  // Valid cookie authenticates.
  assert.equal(webAuth.isAuthed({ headers: { cookie: sid } }), true);

  // Tampered signature (same length) is rejected.
  const tampered = `${sid.slice(0, -2)}xx`;
  assert.equal(webAuth.isAuthed({ headers: { cookie: tampered } }), false);

  // Missing cookie is rejected when the gate is enabled.
  assert.equal(webAuth.isAuthed({ headers: {} }), false);
});
