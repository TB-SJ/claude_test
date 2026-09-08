'use strict';

require('dotenv').config();

const PORT = parseInt(process.env.PORT || '3000', 10);
// Prefer an explicit BASE_URL; on Render fall back to the URL it injects
// (RENDER_EXTERNAL_URL) so OAuth redirect URIs are correct without hardcoding.
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const config = {
  port: PORT,
  baseUrl: BASE_URL,

  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: `${BASE_URL}/auth/google/callback`,
    // Full calendar access: list/read events plus create, update, and delete.
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'openid',
      'email',
    ],
  },

  outlook: {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: `${BASE_URL}/auth/outlook/callback`,
    // `offline_access` is required to receive a refresh token so the app stays
    // logged in. `Calendars.ReadWrite` covers reading and mutating events.
    scopes: ['offline_access', 'Calendars.ReadWrite', 'User.Read'],
  },

  // Voice interface: OpenAI Whisper (speech-to-text) + a chat model (intent).
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    chatModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
  },

  // Optional Claude layer for natural-language voice understanding. When set,
  // it becomes the primary intent engine; the rules parser stays as a fallback.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  },

  // Web dashboard single-user gate. Leave APP_PASSWORD empty to disable the
  // login gate (fine for localhost); set it before hosting.
  app: {
    // Trimmed so a stray trailing space/newline in the hosted env var (a common
    // copy-paste artifact) doesn't silently break the exact password check.
    password: (process.env.APP_PASSWORD || '').trim(),
    sessionSecret: process.env.APP_SESSION_SECRET || '',
  },

  // Optional Supabase-backed persistence. When both are set, the token and task
  // stores use a Supabase table instead of local files (needed on hosts with an
  // ephemeral disk). Unset = local files (default, for local dev).
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
  },

  // Optional push notifications (daily brief + event reminders). VAPID keys
  // enable Web Push; CRON_SECRET guards the /cron/tick endpoint an external
  // scheduler calls. Times are local (the subscriber's tz offset is stored).
  notify: {
    vapidPublic: process.env.VAPID_PUBLIC_KEY || '',
    vapidPrivate: process.env.VAPID_PRIVATE_KEY || '',
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:calendar@example.com',
    cronSecret: process.env.CRON_SECRET || '',
    briefTime: process.env.BRIEF_TIME || '07:00', // local HH:MM for the morning brief
    reminderLeadMinutes: parseInt(process.env.REMINDER_LEAD_MINUTES || '10', 10),
  },

  // Microphone capture (node-record-lpcm16 shells out to sox/rec/arecord).
  audio: {
    sampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE || '16000', 10),
    seconds: parseInt(process.env.AUDIO_SECONDS || '5', 10),
    recorder: process.env.AUDIO_RECORDER || 'sox',
  },
};

/**
 * Returns a list of human-readable warnings for any missing configuration so
 * the operator knows which providers are usable. The server still boots so the
 * health endpoint remains reachable.
 */
function validate() {
  const warnings = [];
  if (!config.encryptionKey || Buffer.from(config.encryptionKey, 'hex').length !== 32) {
    warnings.push(
      'TOKEN_ENCRYPTION_KEY is missing or not a 32-byte hex string. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!config.google.clientId || !config.google.clientSecret) {
    warnings.push('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }
  if (!config.outlook.clientId || !config.outlook.clientSecret) {
    warnings.push('Outlook OAuth is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET).');
  }
  if (!config.openai.apiKey) {
    warnings.push('Voice interface is disabled (OPENAI_API_KEY is not set).');
  }
  return warnings;
}

const providerConfigured = {
  google: () => Boolean(config.google.clientId && config.google.clientSecret),
  outlook: () => Boolean(config.outlook.clientId && config.outlook.clientSecret),
  openai: () => Boolean(config.openai.apiKey),
  anthropic: () => Boolean(config.anthropic.apiKey),
  supabase: () => Boolean(config.supabase.url && config.supabase.serviceKey),
  push: () => Boolean(config.notify.vapidPublic && config.notify.vapidPrivate),
};

module.exports = { config, validate, providerConfigured };
