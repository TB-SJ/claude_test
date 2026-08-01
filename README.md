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
