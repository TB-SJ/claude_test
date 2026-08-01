# calendar-oauth-server

A local Node.js + Express server that connects to **Google Calendar** and
**Outlook / Microsoft Graph** over OAuth2. Authentication tokens (including
refresh tokens) are stored locally **encrypted at rest** so the app stays
logged in across restarts, and a `/health` endpoint confirms each connection
works.

## Features

- **Express** server with a landing page, `/health`, and OAuth routes.
- **Google Calendar** integration via the official `googleapis` client.
- **Outlook / Microsoft Graph** integration via the official `@azure/msal-node`
  and `@microsoft/microsoft-graph-client` libraries.
- **Encrypted token storage** — tokens are serialized, encrypted with
  **AES-256-GCM** using a key from `.env`, and written to `data/tokens.enc`
  (never committed). Refresh tokens never touch disk in plaintext.
- **Health check** that performs a live per-provider connectivity test.

## Requirements

- Node.js 18+ (developed on Node 22).

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

3. Generate a 32-byte encryption key and paste it into `.env` as
   `TOKEN_ENCRYPTION_KEY`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. Register OAuth credentials and add them to `.env`:

   **Google** — [Google Cloud Console](https://console.cloud.google.com/) →
   *APIs & Services* → enable the *Google Calendar API* → *Credentials* →
   create an *OAuth client ID* (type *Web application*). Add the redirect URI:

   ```
   http://localhost:3000/auth/google/callback
   ```

   Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

   **Outlook** — [Azure Portal](https://portal.azure.com/) → *App
   registrations* → *New registration*. Add a *Web* redirect URI:

   ```
   http://localhost:3000/auth/outlook/callback
   ```

   Under *Certificates & secrets* create a client secret. Under *API
   permissions* add the delegated Microsoft Graph permissions `Calendars.Read`
   and `User.Read`. Set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `MS_TENANT_ID`
   (`common` for personal + work/school accounts).

## Run

```bash
npm start      # or: npm run dev  (auto-restart on file changes)
```

The server prints its endpoints on startup.

## Usage

| Endpoint | Description |
| --- | --- |
| `GET /` | Landing page listing available endpoints. |
| `GET /health` | Liveness + live connection status for each provider. |
| `GET /auth/google` | Start the Google OAuth flow (redirects to consent). |
| `GET /auth/outlook` | Start the Outlook OAuth flow (redirects to consent). |
| `POST /auth/:provider/logout` | Delete stored tokens for a provider. |
| `GET /calendar/:provider/events` | List events for a day or week. |
| `POST /calendar/:provider/events` | Create an event. |
| `PATCH /calendar/:provider/events/:id` | Update an event's time/duration. |
| `DELETE /calendar/:provider/events/:id` | Delete an event by ID. |

`:provider` is `google` or `outlook`.

## Calendar API helpers

The backend calendar helpers live in `src/services/calendar.js` (a
provider-agnostic dispatcher) and the per-provider implementations in
`src/services/google.js` and `src/services/outlook.js`. All four operations
return a normalized event shape and log precise, structured errors (provider,
operation, HTTP status, API message, and context) on any API failure.

```js
const calendar = require('./src/services/calendar');

// 1) Fetch all events for a given day or week
await calendar.getEvents('google', { range: 'day', date: '2026-08-05' });
await calendar.getEvents('outlook', { range: 'week', date: '2026-08-05' });
await calendar.getEvents('google', { start: '2026-08-01T00:00:00Z', end: '2026-08-02T00:00:00Z' });

// 2) Add a new event with a title, time, and description
await calendar.createEvent('google', {
  title: 'Design review',
  start: '2026-08-05T15:00:00Z',
  duration: 45,                       // minutes; or pass an explicit `end`
  description: 'Q3 roadmap sync',
  location: 'Room 4',
});

// 3) Delete an event using its ID
await calendar.deleteEvent('google', eventId);

// 4) Update an existing event's time or duration
await calendar.updateEvent('google', eventId, { start: '2026-08-05T16:00:00Z' }); // move, keep duration
await calendar.updateEvent('google', eventId, { duration: 30 });                  // resize in place
await calendar.updateEvent('google', eventId, { start: '...', end: '...' });      // set both
```

The same operations are exposed over HTTP:

```bash
# List a week of Google events
curl "http://localhost:3000/calendar/google/events?range=week&date=2026-08-05"

# Create an Outlook event
curl -X POST http://localhost:3000/calendar/outlook/events \
  -H 'Content-Type: application/json' \
  -d '{"title":"Standup","start":"2026-08-05T09:00:00Z","duration":15,"description":"Daily"}'

# Update an event's time (duration preserved)
curl -X PATCH http://localhost:3000/calendar/google/events/EVENT_ID \
  -H 'Content-Type: application/json' -d '{"start":"2026-08-05T16:00:00Z"}'

# Delete an event
curl -X DELETE http://localhost:3000/calendar/google/events/EVENT_ID
```

Error responses use `400` (invalid input), `401` (not authenticated), and
`502` (upstream API error, with `details`), each carrying a JSON `{ error, code }`.

> **Note:** these helpers need read/write calendar scopes
> (`https://www.googleapis.com/auth/calendar`, Graph `Calendars.ReadWrite`). If
> you authorized an earlier read-only build, re-run the OAuth flow to re-consent.

**Connect an account:** open `http://localhost:3000/auth/google` (or
`/auth/outlook`) in a browser, complete consent, and you'll be redirected back
and see a `connected` confirmation.

**Confirm it works:**

```bash
curl http://localhost:3000/health
```

```jsonc
{
  "status": "ok",
  "uptime": 12.3,
  "timestamp": "2026-08-01T01:10:05.278Z",
  "providers": {
    "google":  { "provider": "google",  "connected": true, "calendars": 1 },
    "outlook": { "provider": "outlook", "connected": true, "calendars": 1 }
  }
}
```

A provider reports `connected: false` with a `reason` of `not_configured`
(missing credentials), `not_authenticated` (no OAuth flow completed yet), or
`api_error` (credentials present but the API call failed).

## How token storage works

- On successful OAuth, tokens are handed to `src/tokenStore.js`.
- The full token document is JSON-serialized and encrypted with AES-256-GCM
  (`src/crypto.js`) using `TOKEN_ENCRYPTION_KEY`.
- The ciphertext is written to `data/tokens.enc` with `0600` permissions and is
  git-ignored.
- Google tokens auto-refresh via `googleapis`; Outlook tokens auto-refresh via
  the MSAL silent flow. New tokens are re-encrypted and persisted, keeping the
  app logged in.

> Losing or changing `TOKEN_ENCRYPTION_KEY` makes existing stored tokens
> unreadable — you'll need to re-authenticate.

## Project structure

```
src/
  index.js            # Express app + startup
  config.js           # Env loading + validation
  crypto.js           # AES-256-GCM encrypt/decrypt
  tokenStore.js       # Encrypted-at-rest token persistence
  routes/
    health.js         # GET /health
    auth.js           # OAuth start/callback/logout
  services/
    google.js         # Google Calendar (googleapis)
    outlook.js        # Microsoft Graph (msal-node)
```
