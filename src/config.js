'use strict';

require('dotenv').config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const config = {
  port: PORT,
  baseUrl: BASE_URL,

  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: `${BASE_URL}/auth/google/callback`,
    // Read-only calendar access is enough for a health check; widen if needed.
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
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
    // logged in. `Calendars.Read` covers the calendar health check.
    scopes: ['offline_access', 'Calendars.Read', 'User.Read'],
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
  return warnings;
}

const providerConfigured = {
  google: () => Boolean(config.google.clientId && config.google.clientSecret),
  outlook: () => Boolean(config.outlook.clientId && config.outlook.clientSecret),
};

module.exports = { config, validate, providerConfigured };
