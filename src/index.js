'use strict';

const express = require('express');
const { config, validate } = require('./config');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const calendarRouter = require('./routes/calendar');
const voiceRouter = require('./routes/voice');

const app = express();
app.use(express.json());

// Landing page: quick pointers to the available endpoints.
app.get('/', (req, res) => {
  res.json({
    name: 'calendar-oauth-server',
    endpoints: {
      health: 'GET /health',
      connectGoogle: 'GET /auth/google',
      connectOutlook: 'GET /auth/outlook',
      logout: 'POST /auth/:provider/logout',
      listEvents: 'GET /calendar/:provider/events?range=day|week&date=YYYY-MM-DD',
      createEvent: 'POST /calendar/:provider/events',
      updateEvent: 'PATCH /calendar/:provider/events/:id',
      deleteEvent: 'DELETE /calendar/:provider/events/:id',
      voiceCapture: 'POST /voice/capture',
      voiceIntent: 'POST /voice/intent',
    },
  });
});

app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/calendar', calendarRouter);
app.use('/voice', voiceRouter);

// 404 + error handlers.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// Only start listening when run directly (keeps the app importable in tests).
if (require.main === module) {
  const warnings = validate();
  warnings.forEach((w) => console.warn(`[config] ${w}`));

  app.listen(config.port, () => {
    console.log(`calendar-oauth-server listening on ${config.baseUrl}`);
    console.log(`  Health check:    ${config.baseUrl}/health`);
    console.log(`  Connect Google:  ${config.baseUrl}/auth/google`);
    console.log(`  Connect Outlook: ${config.baseUrl}/auth/outlook`);
  });
}

module.exports = app;
