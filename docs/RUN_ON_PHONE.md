# Running the dashboard on your phone (Phase 1)

The app runs on a **computer**; your **phone opens a web page** tunneled to that
computer via ngrok. The computer must stay on and running while you use it.
Phone and computer do **not** need the same Wi‑Fi (works over cellular).

There are two parts: **A) one-time setup**, then **B) every-time startup**.

---

## Part A — one-time setup (~30 min)

### A1. Install the tools

You need **Node.js 18+**, **git**, and **ngrok**.

- **macOS** (with [Homebrew](https://brew.sh)):
  ```bash
  brew install node git ngrok
  ```
- **Windows** (in PowerShell):
  ```powershell
  winget install OpenJS.NodeJS.LTS Git.Git ngrok.ngrok
  ```
  (or download installers: [nodejs.org](https://nodejs.org), [git-scm.com](https://git-scm.com), [ngrok.com/download](https://ngrok.com/download))

Verify:
```bash
node -v      # should print v18 or higher
git --version
ngrok version
```

### A2. Get a free ngrok account + a static domain

1. Sign up at [ngrok.com](https://ngrok.com) (free).
2. Copy your authtoken from the dashboard and run:
   ```bash
   ngrok config add-authtoken YOUR_AUTHTOKEN
   ```
3. In the ngrok dashboard, open **Domains** and create your free **static domain**
   (looks like `your-name.ngrok-free.app`). A static domain means you configure
   Google **once** and the URL never changes.

Write down your domain — you'll use it below. Example used here:
`myschedule.ngrok-free.app`

### A3. Download the code

```bash
git clone https://github.com/TB-SJ/claude_test.git
cd claude_test
git checkout claude/nodejs-calendar-oauth-setup-5d7rj5
npm install
```

### A4 (Outlook). Create a Microsoft/Azure app registration

Use this if you're connecting an **Outlook** calendar. (For Google, skip to
"A4 (Google)" below instead.)

> **Account type note:** a **personal** `outlook.com`/`hotmail`/`live` account
> works fine. A **work/school** account managed by an employer may block app
> registration or require an admin's consent — if that happens, that's an IT
> restriction on your account, not a bug.

1. Go to the [Azure Portal](https://portal.azure.com) → search **App registrations** → **New registration**.
2. **Name**: anything (e.g. "Calendar Optimizer").
3. **Supported account types**: choose **"Accounts in any organizational directory (any tenant) and personal Microsoft accounts"** (this is required for a personal Outlook account).
4. **Redirect URI**: platform **Web**, value (use your ngrok domain):
   ```
   https://myschedule.ngrok-free.app/auth/outlook/callback
   ```
   → **Register**.
5. On the app's **Overview** page, copy the **Application (client) ID** → this is `MS_CLIENT_ID`.
6. **Certificates & secrets → New client secret** → add → **immediately copy the secret _Value_** (not the Secret ID; Azure only shows it once) → this is `MS_CLIENT_SECRET`.
7. **API permissions → Add a permission → Microsoft Graph → Delegated permissions** → check **Calendars.ReadWrite** → **Add permissions**. (`User.Read` is already there; `offline_access` is handled automatically.)

Then use the **Outlook** `.env` template in A5. ✅ You're done with A4 — skip the Google section.

### A4 (Google). Create Google OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. **Create a project** (top bar → project dropdown → *New Project* → name it → *Create*).
3. **Enable the Calendar API**: *APIs & Services → Library →* search **Google Calendar API** → **Enable**.
4. **OAuth consent screen**: *APIs & Services → OAuth consent screen*
   - User type: **External** → *Create*
   - Fill *App name*, *User support email*, *Developer contact email* → *Save and continue*
   - *Scopes*: just *Save and continue*
   - *Test users*: **Add users** → add **your own Google email** → *Save and continue*
5. **Create the client**: *APIs & Services → Credentials → Create Credentials → OAuth client ID*
   - Application type: **Web application**
   - Under **Authorized redirect URIs**, add exactly (use your ngrok domain):
     ```
     https://myschedule.ngrok-free.app/auth/google/callback
     ```
   - *Create* → copy the **Client ID** and **Client secret**.

### A5. Create your `.env`

Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the template and edit it:
```bash
cp .env.example .env      # Windows: copy .env.example .env
```

Set these values in `.env` (leave everything else as-is; OpenAI/audio are not
needed for Phase 1). **Use the block for the calendar you're connecting.**

**Outlook:**
```ini
PORT=3000
BASE_URL=https://myschedule.ngrok-free.app
TOKEN_ENCRYPTION_KEY=<paste the generated key>
MS_CLIENT_ID=<Application (client) ID from A4>
MS_CLIENT_SECRET=<client secret VALUE from A4>
MS_TENANT_ID=common
APP_PASSWORD=<choose a password you'll type on your phone>
```

**Google:**
```ini
PORT=3000
BASE_URL=https://myschedule.ngrok-free.app
TOKEN_ENCRYPTION_KEY=<paste the generated key>
GOOGLE_CLIENT_ID=<from step A4>
GOOGLE_CLIENT_SECRET=<from step A4>
APP_PASSWORD=<choose a password you'll type on your phone>
```

> `BASE_URL` must match your ngrok domain exactly (no trailing slash), and the
> redirect URI in Azure/Google must be `BASE_URL` + `/auth/outlook/callback`
> (or `/auth/google/callback`). The dashboard auto-detects whichever calendar
> you connect.

---

## Part B — every time you want to use it

Open **two terminals** in the `claude_test` folder.

**Terminal 1 — start the app:**
```bash
npm start
```
You should see `calendar-oauth-server listening` and (because APP_PASSWORD is set)
**no** "NO login gate" warning.

**Terminal 2 — start the tunnel** (use your domain):
```bash
ngrok http --domain=myschedule.ngrok-free.app 3000
```

**On your phone:**
1. Open `https://myschedule.ngrok-free.app` in your browser.
2. If ngrok shows a blue "You are about to visit…" page, tap **Visit Site** (once per session).
3. Enter your **APP_PASSWORD** → *Sign in*.
4. Tap **Connect Outlook Calendar** (or Google) → sign in to your account and **Accept** the permissions.
   - Google only: you'll first see "Google hasn't verified this app" — tap **Advanced → Go to (your app) → Allow**.
5. You land back on the app showing **Connected ✓** and today's schedule.
6. Tap **Optimize my day** → review **Before / After** → **Apply changes**.

That's it. 🎉 Add the page to your home screen for quick access
(Chrome → ⋮ → *Add to Home screen*).

---

## Part C — troubleshooting

| Symptom | Fix |
| --- | --- |
| **`redirect_uri_mismatch`** | The redirect URI must exactly equal `https://<your-domain>/auth/outlook/callback` (or `/auth/google/callback`), and `.env` `BASE_URL` must be `https://<your-domain>` (no trailing slash). Restart `npm start` after editing `.env`. |
| **Outlook: "account doesn't exist in tenant"** | In Azure, set **Supported account types** to include **personal Microsoft accounts** (re-register if you picked single-tenant), and keep `MS_TENANT_ID=common`. |
| **"App isn't verified"** | Expected for a personal app. *Advanced → Go to … → Allow*. Make sure your email is added as a **Test user** (step A4.4). |
| **`access_denied` / blocked** | Add your Google email as a Test user on the OAuth consent screen. |
| **ngrok warning page every time** | Free ngrok shows it once per browser session — tap *Visit Site*. |
| **Logged out after ~7 days** | Google *Testing* mode expires refresh tokens after 7 days. Either reconnect weekly, or on the OAuth consent screen click **Publish app** (→ *In production*) to stop the expiry. |
| **`Port 3000 already in use`** | Something else uses 3000. Set `PORT=3001` in `.env` and run `ngrok http --domain=… 3001`. |
| **Phone can't reach the page** | Make sure both `npm start` and `ngrok` are running, and the computer isn't asleep (disable sleep while using it). |
| **No events show** | Confirm you actually have events today; try the **Week** toggle. |

To stop: press **Ctrl+C** in both terminals.
