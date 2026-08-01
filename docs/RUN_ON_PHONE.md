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

### A4. Create Google OAuth credentials

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

Set these values in `.env` (leave everything else as-is; Outlook/OpenAI/audio are
not needed for Phase 1):
```ini
PORT=3000
BASE_URL=https://myschedule.ngrok-free.app
TOKEN_ENCRYPTION_KEY=<paste the generated key>
GOOGLE_CLIENT_ID=<from step A4>
GOOGLE_CLIENT_SECRET=<from step A4>
APP_PASSWORD=<choose a password you'll type on your phone>
```

> `BASE_URL` must match your ngrok domain exactly, and the Google redirect URI must
> be `BASE_URL` + `/auth/google/callback`. No trailing slash on `BASE_URL`.

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
4. Tap **Connect Google Calendar** → choose your Google account.
5. You'll see **"Google hasn't verified this app"** — tap **Advanced → Go to (your app)**,
   then **Allow**. (This is normal for a personal app; you added yourself as a test user.)
6. You land back on the app showing **Connected ✓** and today's schedule.
7. Tap **Optimize my day** → review **Before / After** → **Apply changes**.

That's it. 🎉 Add the page to your home screen for quick access
(Chrome → ⋮ → *Add to Home screen*).

---

## Part C — troubleshooting

| Symptom | Fix |
| --- | --- |
| **`redirect_uri_mismatch`** | The Google redirect URI must exactly equal `https://<your-domain>/auth/google/callback`, and `.env` `BASE_URL` must be `https://<your-domain>` (no trailing slash). Restart `npm start` after editing `.env`. |
| **"App isn't verified"** | Expected for a personal app. *Advanced → Go to … → Allow*. Make sure your email is added as a **Test user** (step A4.4). |
| **`access_denied` / blocked** | Add your Google email as a Test user on the OAuth consent screen. |
| **ngrok warning page every time** | Free ngrok shows it once per browser session — tap *Visit Site*. |
| **Logged out after ~7 days** | Google *Testing* mode expires refresh tokens after 7 days. Either reconnect weekly, or on the OAuth consent screen click **Publish app** (→ *In production*) to stop the expiry. |
| **`Port 3000 already in use`** | Something else uses 3000. Set `PORT=3001` in `.env` and run `ngrok http --domain=… 3001`. |
| **Phone can't reach the page** | Make sure both `npm start` and `ngrok` are running, and the computer isn't asleep (disable sleep while using it). |
| **No events show** | Confirm you actually have events today; try the **Week** toggle. |

To stop: press **Ctrl+C** in both terminals.
