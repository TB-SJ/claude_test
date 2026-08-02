'use strict';

const path = require('path');
const express = require('express');
const { config, validate, providerConfigured } = require('./config');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const calendarRouter = require('./routes/calendar');
const voiceRouter = require('./routes/voice');
const scheduleRouter = require('./routes/schedule');
const tasksRouter = require('./routes/tasks');
const briefRouter = require('./routes/brief');
const tokenStore = require('./tokenStore');
const taskStore = require('./taskStore');
const webAuth = require('./webAuth');

const app = express();
app.set('trust proxy', 1); // respect X-Forwarded-Proto behind ngrok/cloud proxies
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// --- Static assets (login page, app shell, css, js). No auth: these carry no
// data; the data lives behind the gated API below. index:false so "/" is routed
// explicitly (auth-gated) rather than auto-serving index.html. `no-cache` forces
// the browser to revalidate, so app updates show up on refresh (no stale JS/CSS).
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

// --- Login gate (single-user). No-op when APP_PASSWORD is unset.
app.get('/login', (req, res) => {
  if (webAuth.isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.post('/login', (req, res) => {
  if (!webAuth.checkPassword(req.body && req.body.password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  webAuth.setSessionCookie(req, res);
  res.json({ ok: true });
});
app.post('/logout', (req, res) => {
  webAuth.clearSessionCookie(res);
  res.json({ ok: true });
});

// --- The app shell (mobile dashboard).
app.get('/', webAuth.requireAuthPage, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
});

// --- Machine-readable API index (handy for debugging).
app.get('/api', (req, res) => {
  res.json({
    name: 'calendar-oauth-server',
    endpoints: {
      health: 'GET /health',
      connectGoogle: 'GET /auth/google',
      listEvents: 'GET /calendar/:provider/events?range=day|week&date=YYYY-MM-DD',
      analyzeSchedule: 'POST /schedule/:provider/analyze',
      applySchedule: 'POST /schedule/:provider/apply',
    },
  });
});

// --- Health is public (useful for host uptime pings). Everything else that
// touches your calendar is gated.
app.use('/health', healthRouter);
app.use('/auth', webAuth.requireAuthApi, authRouter);
app.use('/calendar', webAuth.requireAuthApi, calendarRouter);
app.use('/voice', webAuth.requireAuthApi, voiceRouter);
app.use('/schedule', webAuth.requireAuthApi, scheduleRouter);
app.use('/tasks', webAuth.requireAuthApi, tasksRouter);
app.use('/brief', webAuth.requireAuthApi, briefRouter);

// 404 + error handlers.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// Only start listening when run directly (keeps the app importable in tests).
if (require.main === module) {
  (async () => {
    const warnings = validate();
    warnings.forEach((w) => console.warn(`[config] ${w}`));
    if (!webAuth.enabled()) {
      console.warn('[config] APP_PASSWORD is not set — the web dashboard has NO login gate. Set it before hosting.');
    }

    // Load the persistent stores before serving. In Supabase mode this fetches
    // the token/task documents; in file mode it's a no-op.
    if (providerConfigured.supabase()) {
      try {
        await Promise.all([tokenStore.init(), taskStore.init()]);
        console.log('[storage] Using Supabase for token + task persistence.');
      } catch (err) {
        console.error(`[storage] Supabase init failed: ${err.message}`);
        if (/permission denied|42501/.test(err.message)) {
          console.error('[storage] Fix: run the GRANT in docs/DEPLOY.md (Step 1b):');
          console.error('         grant select, insert, update, delete on table public.app_state to service_role;');
        }
        // Exit non-zero without a hard process.exit() (which can trip a libuv
        // assertion on Windows while the failed request's socket is closing).
        process.exitCode = 1;
        return;
      }
    } else {
      console.log('[storage] Using local files (data/) for persistence.');
    }

    app.listen(config.port, () => {
      console.log(`calendar-oauth-server listening on ${config.baseUrl}`);
      console.log(`  Dashboard:   ${config.baseUrl}/`);
      console.log(`  Health:      ${config.baseUrl}/health`);
    });
  })();
}

module.exports = app;
