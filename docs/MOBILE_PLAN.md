# Mobile Plan — Making the Calendar Optimizer usable on a phone

> Status: **proposal for review** (no app code written yet). This documents the
> approach, the concrete changes, hosting options, risks, and open decisions.

## TL;DR

The current app is a **local command-line tool**: a terminal dashboard, a
server-side microphone, and `localhost`-only endpoints. None of that is reachable
from a phone. The valuable core — OAuth, encrypted tokens, calendar CRUD, the
optimization engine, intent parsing — is reusable as-is. To go mobile we replace
the *shell*: a **hosted mobile web app (PWA)** instead of a terminal, and
**browser voice** instead of a server microphone.

Recommendation: build **tap-first** (buttons), add voice as an enhancement, test
on a real phone via **ngrok** first, then deploy to **Render** if you keep it.

## What carries over vs. what changes

| Piece | Reuse? | Notes |
| --- | --- | --- |
| Optimization engine (`scheduleOptimizer`, `scheduleRules`) | ✅ as-is | Pure functions; the real value |
| `/schedule/:provider/analyze` + `/apply` routes | ✅ as-is | UI calls these directly (analyze is read-only; apply is confirm-gated) |
| Calendar CRUD (`calendar`, `google`, `outlook`) | ✅ as-is | |
| OAuth + encrypted token store | ✅ mostly | Callback must redirect to the web app; token storage must survive hosting (see Risks) |
| Intent extraction (`intent`) | ✅ as-is | Used by the voice path |
| Terminal dashboard (`dashboardCli`, `dashboard/*`) | ❌ | Terminal-only; replaced by the web UI. The reusable logic (`routeCommand`, Before/After model) can be ported to the browser |
| Server-side mic (`audio.js`, `node-record-lpcm16`) | ❌ for mobile | Phone can't reach the server's mic; capture moves into the browser |

## Phase 1 — Mobile web dashboard (tap-first)  ← the core mobile experience

A single responsive page served by the existing Express app.

**User flow**
1. Open the URL on your phone → if not connected, a **"Connect Google Calendar"** button starts the OAuth flow.
2. Connected → see **today's schedule** as a list.
3. Tap **"Optimize my day"** (with a day/week toggle) → calls `POST /schedule/google/analyze`.
4. See a **Before / After** view (stacked vertically on mobile, not side-by-side) with each change and its reason.
5. Tap **"Apply changes"** → `POST /schedule/google/apply` with `{ confirm: true, moves }` → success confirmation.

**Backend changes (small)**
- Serve a static frontend (`express.static` + an `/app` route).
- Change the OAuth callback to **redirect back to the app page** instead of returning JSON.
- Accept the **timezone from the browser** (`new Date().getTimezoneOffset()`) on analyze/apply, so the 9–11 AM deep-work rules use *your* local time automatically. (This removes the manual `--tz-offset` gotcha.)
- Add a minimal **auth gate** (see Risks) — required before hosting.

**Frontend**: plain HTML/CSS/JS, mobile-first, no build step (keeps it simple and
dependency-light). Can add a framework later if it grows.

## Phase 2 — Browser voice (enhancement)

Add a mic button that captures on the **phone's** microphone:
- **Primary:** the browser's built-in `SpeechRecognition` (Web Speech API) —
  free, on-device, no OpenAI key. Great on Android Chrome.
- **Fallback:** `MediaRecorder` → upload the audio to a new
  `POST /voice/transcribe` endpoint that runs Whisper (reuses `transcribe.js`),
  for browsers where Web Speech is missing/unreliable (notably iOS Safari).
- Recognized text → the existing `routeCommand` logic → analyze/apply or add/move.

The spoken "Optimize my day" then does exactly what the button does.

## Phase 3 — Polish

- PWA manifest + service worker → installable, "Add to Home Screen," app-like.
- Better visuals / theming.
- Login/auth if more than one person uses it.

## Hosting — how you'll actually run it on a phone

The driver is **just you** vs. **others too**.

### Option A — ngrok tunnel (recommended to start)
Run `npm start` locally; expose port 3000 with a public HTTPS URL; set that URL as
the OAuth redirect. **Best for the first real-phone test.**
- ➕ Zero deploy, works in minutes, proves the mobile UX.
- ➖ Only up while your laptop runs; free URL changes each restart (set the OAuth redirect each time, or use a reserved domain).

### Option B — Cloud host: Render / Railway / Fly (recommended if you keep it)
Deploy the Express app for a permanent 24/7 HTTPS URL.
- ➕ Always available on your phone; stable OAuth redirect.
- ➖ Requires two real changes:
  1. **Token persistence.** The encrypted token file lives on disk; most cloud
     filesystems are ephemeral and wiped on redeploy. Move tokens to durable
     storage (a Render persistent disk, a small KV/DB, or — for single-user —
     an encrypted value in an env var).
  2. **Secrets as env vars** and the OAuth redirect set to the deployed URL.

**My recommendation:** ngrok now to validate the experience on your actual phone,
then Render if you decide to live with it.

## Risks & decisions to settle before building

1. **Security / auth (biggest).** The endpoints are currently **unauthenticated** —
   fine on localhost, but once hosted, anyone with the URL could read your
   calendar and apply changes. Phase 1 (hosted) needs at least a password/shared-secret gate. **Decision:** simple gate now vs. proper login.
2. **Single-user vs. multi-user.** Everything today assumes one user / one token
   file. If others use it, we need per-user tokens + login — a real scope jump.
   **Decision:** confirm it's just you (keeps this simple).
3. **iOS voice.** Web Speech API is inconsistent on iOS Safari; the Whisper-upload
   fallback keeps the OpenAI dependency for those devices. **Decision:** is iOS a
   must-have for voice?
4. **Token durability on cloud** (see Hosting Option B) — needed if we deploy.

## Rough effort

- **Phase 1:** the bulk — responsive page + small backend tweaks (static serving,
  callback redirect, tz passthrough, auth gate). Reuses analyze/apply.
- **Phase 2:** small–moderate, with the iOS caveat.
- **Phase 3:** small.

## Open questions for you

- Is this **just for you**, or will others use it? (drives auth/multi-user)
- **iOS or Android** (or both) on the phone? (drives the voice fallback)
- Start with **ngrok** (fastest test) or go straight to **Render** (permanent)?
