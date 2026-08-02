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
