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
| `POST /voice/capture` | Record from the mic → transcribe → intent JSON. |
| `POST /voice/intent` | Extract intent JSON from already-transcribed text. |

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

## Voice interface

Speak a calendar command; the app captures your microphone, transcribes it with
**OpenAI Whisper**, and passes the text to a language model that extracts a
structured intent.

**Setup:** set `OPENAI_API_KEY` in `.env`, and install a system recorder for
microphone capture:

```bash
# macOS
brew install sox
# Debian/Ubuntu
sudo apt-get install sox          # or: alsa-utils (arecord); set AUDIO_RECORDER=arecord
```

**Pipeline** (`src/services/voice.js`):

1. `audio.recordToFile()` — capture mic audio via `node-record-lpcm16`.
2. `transcribe.transcribeFile()` — Whisper speech-to-text.
3. `intent.extractIntent()` — language model → structured intent.

**Intent output schema:**

```jsonc
{
  "action": "add" | "remove" | "move" | null,
  "event_details": {
    "title":      "string | null",
    "date":       "YYYY-MM-DD | null",
    "start_time": "HH:MM | null",   // 24-hour
    "end_time":   "HH:MM | null"
  }
}
```

The model resolves relative dates ("tomorrow", "next Friday") against today, and
`normalizeIntent()` guarantees the exact shape (mapping synonyms like
*schedule → add*, *cancel → remove*, *reschedule → move*, coercing times to
24-hour, defaulting unknowns to `null`).

**CLI** — record and print the intent:

```bash
npm run voice -- 6      # listen for 6 seconds
# Heard: "reschedule my dentist appointment to next Monday at 3pm"
# { "action": "move", "event_details": { "title": "dentist appointment",
#   "date": "2026-08-10", "start_time": "15:00", "end_time": null } }
```

**HTTP:**

```bash
# Text you already have (no audio) -> intent
curl -X POST http://localhost:3000/voice/intent \
  -H 'Content-Type: application/json' \
  -d '{"text":"add a team sync tomorrow from 10 to 10:30am"}'

# Record from the server's microphone, then transcribe + parse
curl -X POST http://localhost:3000/voice/capture \
  -H 'Content-Type: application/json' -d '{"seconds":5}'
```

Both return `{ "transcript": "...", "intent": { ... } }`. Errors map to `400`
(bad input), `502` (Whisper/LLM API error), and `503` (`OPENAI_API_KEY` unset).
Because `action` aligns with the calendar helpers (`add`→`createEvent`,
`remove`→`deleteEvent`, `move`→`updateEvent`), the intent can be fed straight
into the calendar layer to execute the command.

## Schedule optimization engine

Analyzes your upcoming week for **conflicts, double-bookings, and fragmented
gaps**, then proposes a rearranged schedule that honors a set of rules — and
**asks for confirmation before applying** any change via the calendar API.

**Rules** (`src/services/scheduleRules.js`, all configurable):

| Rule | Default |
| --- | --- |
| Work hours | 09:00–17:00 |
| Buffer between events | 15 min |
| Fragmented-gap threshold | gaps > buffer and < 30 min |
| Protect deep-work block | 09:00–11:00, weekdays |
| Group meetings into window | 13:00–17:00 (afternoon) |
| Pinned events (never moved) | none (regex title patterns) |

The engine (`src/services/scheduleOptimizer.js`) is pure and testable:
`analyze(events, rules)` returns the issue report; `optimize(events, rules)`
returns a set of proposed **moves** (each with the reasons it was moved).
Movable events are re-placed **within their original day**, around fixed blocks
and the deep-work window, packed into the meeting window with buffers —
**durations are always preserved**.

> **Timezone:** rule times are local wall-clock. Since events are stored in UTC,
> pass `--tz-offset` (minutes; local = UTC + offset, e.g. `-420` for US Pacific
> DST). Default `0` treats UTC as local.

**CLI** — analyze, propose, and confirm before applying:

```bash
# Preview only (never writes)
npm run optimize -- --provider google --dry-run

# Full run: prints analysis + proposal, then prompts [y/N] before applying
npm run optimize -- --provider google --tz-offset -420

# Options: --date 2026-08-03  --rules ./my-rules.json  --yes (skip prompt)
```

Sample output:

```text
=== Weekly analysis ===
  Conflicts / dbl-book: 1
  Deep-work intrusions: 2

=== Proposed schedule ===
  Standup
      Mon 09:30–09:45  →  Mon 13:00–13:15
      ↳ Protect 9–11 AM deep-work block; Group into afternoon meeting block
  ...
Apply these 5 change(s)? [y/N]
```

**HTTP** (confirm-gated):

```bash
# Read-only: analysis + proposed moves, never writes
curl -X POST http://localhost:3000/schedule/google/analyze \
  -H 'Content-Type: application/json' -d '{"date":"2026-08-03"}'

# Apply — requires confirm:true, else 400
curl -X POST http://localhost:3000/schedule/google/apply \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true,"moves":[ /* moves from /analyze */ ]}'
```

## Voice dashboard (main entry point)

An interactive CLI that ties the whole app together into one loop:

```
launch → wait for hotkey → 🎙 listen (mic → Whisper → intent)
       → run command → (for "Optimize my day") show Before/After → confirm → save
```

```bash
npm run dashboard -- --provider google --tz-offset -420
```

- Press **SPACE** to start listening; say a command; press **q** to quit.
- **"Optimize my day"** (or *my week*) runs the optimization engine and prints a
  side-by-side **Before / After** view of your calendar, with each change and the
  reason for it, then asks for confirmation **before** writing anything.
- Also understands **"add … "**, **"remove … "**, **"move … "** (via the voice
  intent extractor), and **"help"** / **"quit"**.

```text
BEFORE                                   │ AFTER
─────────────────────────────────────────┼─────────────────────────────────
Mon 2026-08-03
09:30-09:45 Standup                      │ ▸ 13:00-13:15 Standup
10:00-11:00 Design review                │ ▸ 13:30-14:30 Design review
13:00-13:30 1:1 with Alice               │ ▸ 14:45-15:15 1:1 with Alice
...
Apply these 5 change(s)? [y/N]
```

The dashboard core (`src/dashboard/core.js`) takes its I/O, voice, and calendar
as **injected dependencies**, so the whole loop is driven end-to-end in tests
without a real microphone, API key, or calendar auth.

## Testing

```bash
npm test        # node --test
```

`test/dashboard.e2e.test.js` exercises the full loop with in-memory fakes:
hotkey → "Optimize my day" → Before/After → confirm → the fake calendar is
verified to be rewritten to a conflict-free, deep-work-clear schedule. It also
covers the abort path (calendar untouched), an already-optimized week (no
changes proposed), voice "add", and command routing.

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
  logger.js           # Structured logging
  errors.js           # Typed errors + precise API-error extraction/logging
  httpError.js        # Maps typed errors to HTTP status codes
  voiceCli.js         # CLI: mic -> intent JSON
  optimizeCli.js      # CLI: analyze week -> propose -> confirm -> apply
  dashboardCli.js     # Interactive dashboard (main entry point)
  dashboard/
    core.js           # Injectable dashboard loop + command routing
    render.js         # Before/After side-by-side rendering
  routes/
    health.js         # GET /health
    auth.js           # OAuth start/callback/logout
    calendar.js       # Event CRUD endpoints
    voice.js          # Voice capture + intent endpoints
    schedule.js       # Schedule analyze + confirm-gated apply
  services/
    google.js         # Google Calendar (googleapis)
    outlook.js        # Microsoft Graph (msal-node)
    calendar.js       # Provider-agnostic calendar dispatcher
    calendarUtils.js  # Date-range + time-resolution helpers
    openaiClient.js   # Lazy OpenAI client
    audio.js          # Microphone capture (node-record-lpcm16)
    transcribe.js     # Whisper speech-to-text
    intent.js         # LLM intent extraction (+ normalizeIntent)
    voice.js          # record -> transcribe -> intent pipeline
    scheduleRules.js  # Optimization ruleset + helpers
    scheduleOptimizer.js  # analyze() + optimize() engine
test/
  dashboard.e2e.test.js   # End-to-end loop test (node --test)
```
