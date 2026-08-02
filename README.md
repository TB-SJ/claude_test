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

### Smarter rearrangement with Claude (optional)

If `ANTHROPIC_API_KEY` is set, the dashboard shows a **🧠 Claude** toggle next to
the Optimize button. When on, the week is sent to **Claude Sonnet 5**
(`src/services/claudeOptimizer.js`), which proposes a rearrangement that can be
more context-aware than the greedy rules engine (keeping lunch near midday,
clustering related meetings, leaving larger free blocks).

Crucially, **Claude only suggests — it never bypasses the rules.** Every proposal
is fed back through the deterministic `analyze()` gate and is **discarded unless
it has zero conflicts, zero buffer violations, and zero deep-work intrusions**,
stays within work hours, keeps each event on its day, and preserves durations. If
the proposal fails validation, the API errors, or no key is set, it **falls back
to the free rules optimizer** automatically. Nothing is ever written to your
calendar without the same Before/After confirmation.

- **Cost:** one bounded API call per Optimize tap (~$0.02), only when the toggle
  is on — draws from the same `ANTHROPIC_API_KEY` as the voice layer. Toggle off
  for the free rules engine. Response reports which engine ran (`claude`,
  `rules`, or `rules-fallback`).

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

## Mobile web dashboard (Phase 1)

A phone-friendly web UI served by the same Express app: connect Google, view your
day/week, tap **Optimize my day**, review a **Before / After** of your calendar,
and **Apply** — all from a browser. Timezone is detected from the browser, so the
9–11 AM deep-work rules use your local time automatically.

```bash
# Local (no login gate):
npm start                      # open http://localhost:3000

# Exposed to a phone — set a password first:
APP_PASSWORD='choose-one' npm start
```

- **Quick-add (typed, free).** Both the schedule and Tasks cards have a **＋ Add**
  button that opens structured fields — event: title, date, start time, duration;
  task: title, minutes, priority, deadline. These POST **straight to the calendar
  and task routes with no parsing**, so they cost **zero** API credits (no Claude,
  no rules parser). Use them instead of voice when you want to save on cost.
- **Single-user login gate.** If `APP_PASSWORD` is set, the app requires it and
  keeps a signed session cookie; if unset, the gate is disabled (fine for
  localhost, and the server warns you at startup). **Always set it before hosting.**
- Endpoints that touch your calendar (`/calendar`, `/schedule`, `/voice`,
  `/auth`) are gated; the login page and static assets are not.

### Putting it on your phone

**Option A — ngrok (quickest test):**
```bash
APP_PASSWORD='choose-one' npm start          # terminal 1
ngrok http 3000                               # terminal 2 -> gives an https URL
```
Add `https://<id>.ngrok.app/auth/google/callback` as an authorized redirect URI
in the Google Cloud Console, set `BASE_URL=https://<id>.ngrok.app` in `.env`, then
open the ngrok URL on your phone.

**Option B — cloud host (Render/Railway/Fly)** for a permanent URL — see
`docs/MOBILE_PLAN.md` (note: move the encrypted token file to durable storage,
since cloud disks are wiped on redeploy).

## Voice dashboard (terminal)

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

### Voice commands (mobile)

The mobile dashboard has a floating 🎤 button that uses the browser's built-in
speech recognition (free, no OpenAI key; works in Android Chrome). Speak a
command and it's parsed server-side (`src/services/voiceCommand.js`, using
`chrono-node` for natural dates) into one of:

- **"Optimize my day / week"** → runs the optimizer, shows Before/After.
- **"Add dentist tomorrow at 2pm"** → creates an event.
- **"Move my standup to 4pm"** → reschedules (keeps duration; time-only keeps the day).
- **"Rename standup to team sync"** / **"make the review 30 minutes"** → edits an event.
- **"Cancel the roadmap sync"** → removes it.
- **"Add a task to draft the budget for 45 minutes by Friday"** → creates a flexible task.
- **"Mark budget review as done"** / **"change budget to high priority"** → edits a task.
- **"Show me my schedule for Friday"** / **"what do I have this week"** → read-only agenda view.
- **"When am I free tomorrow"** / **"show my free time this week"** → free-time view (gaps within work hours).
- **"How's my day"** / **"brief me"** → the daily brief (see below).

Every write (add/remove/move/edit) shows a **confirmation card** first; the two
**"show …"** queries are read-only and just display a result card. The endpoint is
`POST /voice/command { provider, transcript, tzOffsetMinutes }`, which never
writes — the client confirms, then calls the normal calendar/task routes.

**Manual editing** (no voice): every event and task row has a **✎** button that
opens the same inline form prefilled, so you can edit by typing too — events save
via `PATCH /calendar/:provider/events/:id` (title, time, duration, notes), tasks
via `PATCH /tasks/:id`.

### Daily brief

A **🌅 Today** card at the top summarizes your day at a glance: meeting count and
booked time, free/focus time remaining, whether the deep-work block is protected,
your next event, your top task, and any **at-risk deadlines** (overdue / due today
/ due tomorrow, shown in amber). It loads automatically and you can ask for it by
voice ("how's my day"). Endpoint: `GET /brief/:provider?tzOffsetMinutes=&date=` —
read-only. Tasks are ordered **deadline-aware**: anything due within two days (or
overdue) jumps ahead of priority, so pressing deadlines never get buried.

### Time-blocking (opt-in)

**"Plan my day"** suggests when to do your flexible tasks around real events. If
the plan looks good, tap **"＋ Add these blocks to my calendar"** to commit those
task slots as real events (titled with a 📋 prefix). Committed tasks are marked
done so they aren't re-planned. This is the only path that writes tasks to the
calendar — otherwise tasks stay app-only. Endpoint: `POST /tasks/commit/:provider`.

#### Smarter understanding with Claude (optional)

By default commands are parsed by a deterministic **rules parser** (keywords +
`chrono-node`). If you set `ANTHROPIC_API_KEY` in `.env`, the same transcript is
first sent to **Claude Sonnet 5** (`src/services/claudeIntent.js`), which handles
looser, more natural phrasing ("push my 3 o'clock back an hour", "pencil in a
budget review for Thursday") and returns the same structured intent.

- **Zero-regression:** with no key set, nothing changes — the rules parser runs
  exactly as before.
- **Automatic fallback:** if the Claude call errors for any reason, it silently
  falls back to the rules parser, so voice never breaks.
- A small **🧠 Claude** badge appears on the confirmation/heard line when Claude
  did the parsing.

Setup: create a key at [console.anthropic.com](https://console.anthropic.com)
(pay-as-you-go API billing, **separate** from a Claude.ai/Max subscription), add
`ANTHROPIC_API_KEY=...` to `.env`, `npm install`, and restart. Each command is a
tiny request (~$0.0001), so real-world cost is negligible.

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
  webAuth.js          # Single-user password gate + signed session cookie
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
public/                   # Mobile web dashboard (Phase 1)
  app.html  app.js  login.html  styles.css
test/
  dashboard.e2e.test.js   # End-to-end loop test (node --test)
  webAuth.test.js         # Session/password gate unit test
```
