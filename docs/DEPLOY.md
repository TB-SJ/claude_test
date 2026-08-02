# Deploying (free stack)

Goal: run the app 24/7 for **$0**, with reliable notifications, without leaving
your PC on. The plan:

| Piece | Service | Cost |
| --- | --- | --- |
| App (Express server) | Render free | $0 |
| Storage (tokens + tasks) | **Supabase** (personal, free plan) | $0 |
| Reminder scheduler | GitHub Actions cron → `/cron` endpoint | $0 |
| Push delivery | Web Push (VAPID) | $0 |

This guide is built up step by step. **Step 1 (storage) is ready now.**

---

## Step 1 — Persistent storage on Supabase

Free container hosts wipe their disk on every redeploy, which would erase your
saved Google login and tasks. So we keep that tiny bit of data in Supabase
instead. Your tokens stay **AES-256 encrypted** — only ciphertext is stored, and
the encryption key never leaves the app.

### 1a. Create a free, personal Supabase project

> Use a **personal** email, not your work account — a project in a paid work org
> costs money, and this keeps personal calendar data out of company infrastructure.

1. Go to <https://supabase.com> → sign up / log in with a personal email.
2. **New project** → name it e.g. `calendar-optimizer`, pick a region near you,
   set a database password (save it somewhere), and create it (Free plan).
3. Wait ~2 minutes for it to provision.

### 1b. Create the table

In the project: **SQL Editor → New query**, paste this, and **Run**:

```sql
create table if not exists app_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz default now()
);

-- The app connects with the service_role key and bypasses row-level security,
-- but enabling RLS with no policies blocks the public anon key just in case.
alter table app_state enable row level security;

-- Newer projects don't always auto-grant table privileges to service_role.
-- Without this you'll get: "permission denied for table app_state" (code 42501).
grant select, insert, update, delete on table public.app_state to service_role;
```

### 1c. Grab your two values

**Project Settings → API**:

- **Project URL** → `SUPABASE_URL` (e.g. `https://abcdefgh.supabase.co`)
- **`service_role` secret** (under *Project API keys* — click *reveal*) →
  `SUPABASE_SERVICE_KEY`

> ⚠️ The `service_role` key is a full-access admin key. Keep it secret — it goes
> only in server env vars, never in the browser or the repo.

### 1d. Use it

- **Locally (optional):** add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to your
  `.env`, restart, and `GET /health` should report `"storage":"supabase"`.
  Without them, the app uses local files exactly as before.
- **On the host:** you'll set the same two env vars there (Step 2).

That's it for storage. Steps 2–4 (Render deploy, the reminder cron, and web
push) build on top of this.

---

## Step 2 — Deploy to Render (free)

The repo has a `render.yaml` Blueprint that defines the service. Persistence is
Supabase (Step 1), so no disk is needed and the **free plan** works.

### 2a. Create the service

1. Go to <https://render.com> → sign up (log in with GitHub is easiest).
2. **New → Blueprint**.
3. Connect your GitHub and pick the **`tb-sj/claude_test`** repo.
4. Choose the branch that has the code (`claude/nodejs-calendar-oauth-setup-5d7rj5`,
   or `main` if you've merged). Render reads `render.yaml` and shows the service.

### 2b. Enter the secret env vars

Render will prompt for each `sync: false` variable. Paste these in:

| Variable | Where it comes from |
| --- | --- |
| `TOKEN_ENCRYPTION_KEY` | the same 32-byte hex key from your local `.env` — **must match**, or the tokens already saved in Supabase can't be decrypted |
| `APP_PASSWORD` | the dashboard login password you choose (set one — it's public now) |
| `GOOGLE_CLIENT_ID` | from your local `.env` (Google Cloud Console) |
| `GOOGLE_CLIENT_SECRET` | from your local `.env` |
| `ANTHROPIC_API_KEY` | from your local `.env` (optional — omit to disable Claude) |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | your Supabase `service_role` secret |

> `BASE_URL` and `PORT` are handled automatically — don't set them.

Click **Apply / Deploy**. First build takes a few minutes.

### 2c. Point Google OAuth at the new URL

Once live you'll have a URL like `https://calendar-optimizer.onrender.com`.

In **Google Cloud Console → APIs & Services → Credentials → your OAuth client**:

- Under **Authorized redirect URIs**, add:
  `https://<your-app>.onrender.com/auth/google/callback`
- Save. (The app derives this path from its own URL automatically — you just
  have to allow-list it on Google's side.)

### 2d. Verify

1. Open `https://<your-app>.onrender.com` → log in with `APP_PASSWORD`.
2. Visit `https://<your-app>.onrender.com/health` — confirm `"storage":"supabase"`.
3. Connect Google (`/auth/google`) once. Because tokens live in Supabase now,
   this connection survives redeploys.

> **Free-tier note:** the service sleeps after ~15 min idle, so the first open
> after a while takes ~30–60s to wake. Step 3 (the reminder cron) also keeps it
> warm around notification times.

---

## Step 3 — Push notifications (daily brief + reminders)

Two parts: the app sends Web Push; an external scheduler pings it every ~15 min.

### 3a. Generate keys and set env vars

Locally, run:

```bash
npm run vapid
```

It prints `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, a `VAPID_SUBJECT`, and a random
`CRON_SECRET`. Add all of them as env vars **on Render** (and to your local `.env`
if you want to test locally). Optionally set `BRIEF_TIME` (default `07:00`, your
local time) and `REMINDER_LEAD_MINUTES` (default `10`). Redeploy.

Verify: `GET /health` now shows `"push":true`.

### 3b. Turn it on from your phone

Open the app → tap **🔔 Reminders** in the Today card → allow notifications. You'll
get a test push confirming it works. (Android Chrome supported; iOS needs the app
added to the home screen first.)

### 3c. Schedule the pings

The app exposes `POST /cron/tick` (guarded by `CRON_SECRET`). Point any free
scheduler at it every ~15 min. Two options:

**Option A — GitHub Actions** (in-repo, `.github/workflows/reminders.yml`):
scheduled workflows only run from the **default branch**, so merge to `main`
first. Then add two repo secrets (Settings → Secrets and variables → Actions):
`APP_URL` (your Render URL) and `CRON_SECRET` (same value as the env var).

**Option B — cron-job.org** (works immediately, no merge needed): create a free
job that POSTs to `https://<your-app>.onrender.com/cron/tick` every 15 minutes
with a header `x-cron-secret: <your CRON_SECRET>`.

> The scheduler ping doubles as a keep-warm, so the brief and reminders fire even
> though the free tier sleeps. GitHub cron can run a few minutes late under load —
> fine for a personal brief; cron-job.org is more punctual.
