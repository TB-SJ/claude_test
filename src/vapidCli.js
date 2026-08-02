'use strict';

// Generates a VAPID key pair for Web Push. Run once and copy the two values
// into your env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). Keep them stable — the
// public key is baked into every device subscription, so changing it forces
// everyone to re-subscribe.
//
//   npm run vapid

const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();
process.stdout.write(
  [
    '# Add these to your env (Render dashboard, and your local .env):',
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    '# Also set a subject and a shared cron secret:',
    'VAPID_SUBJECT=mailto:you@example.com',
    `CRON_SECRET=${require('crypto').randomBytes(24).toString('hex')}`,
    '',
  ].join('\n')
);
