# Echo cloud sync — Supabase setup

Echo v1.1.0 syncs history, settings, dictionary, snippets and styles
across every device a user signs in on. The backend is Supabase
(Postgres + auth) on the free tier.

You only need to do this **once**. Total time: ~15 minutes.

---

## 1. Create the Supabase project

1. Go to https://supabase.com and sign in / sign up.
2. **New project**:
   - Name: `echo`
   - Database password: anything (you won't need it day-to-day)
   - Region: closest to your friends
   - Plan: Free
3. Wait ~2 minutes for the project to provision.

## 2. Apply the schema

1. In the Supabase dashboard, open **SQL Editor → New query**.
2. Copy the entire contents of `voicetype/supabase/schema.sql` from
   this repo into the editor.
3. Click **Run**. You should see "Success. No rows returned." This
   creates the `profiles`, `settings`, `history`, `dictionary`,
   `snippets`, and `custom_styles` tables, plus the row-level security
   policies that prevent users from reading each other's data.

You can rerun the script later (e.g. after pulling schema updates) —
every statement is idempotent.

## 3. Enable email + Google auth

### Email + password (simplest, works out of the box)

1. **Authentication → Providers → Email**.
2. Toggle **Enable Email provider** → on.
3. Decide on **Confirm email**:
   - **On** (recommended): users must click a confirmation link before
     signing in. Blocks typo emails and bots.
   - **Off**: instant sign-in, lower friction.

### Google (optional but recommended)

1. In Google Cloud Console: **APIs & Services → Credentials → Create
   credentials → OAuth client ID → Web application**.
2. **Authorised redirect URI**:
   `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
   (you'll find the exact URL in Supabase under
   Authentication → Providers → Google → Callback URL).
3. Copy the Google **Client ID** and **Client secret**.
4. Back in Supabase: **Authentication → Providers → Google**, toggle
   on, paste the client ID + secret, **Save**.

### Set the redirect URL Echo uses

Supabase needs to know the deep-link scheme is allowed:

1. **Authentication → URL Configuration**.
2. **Site URL**: `echo://auth-callback`
3. **Redirect URLs** (add): `echo://auth-callback`

Without this, Google sign-in works but won't return into the app.

## 4. Wire the keys into Echo

1. In Supabase, go to **Project settings → API**.
2. Copy the **Project URL** (looks like
   `https://abcd1234.supabase.co`).
3. Copy the **anon / public** key (the long JWT-looking string).
4. In your local clone, edit `voicetype/.env` (created from
   `voicetype/.env.example`):
   ```
   VITE_SUPABASE_URL=https://abcd1234.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhb...
   VITE_SUPABASE_REDIRECT_URL=echo://auth-callback
   ```
5. The anon key is **safe to bake into the client**. Row-level security
   policies enforce per-user access. Don't paste the *service role* key
   though — that one bypasses RLS and is admin-level.

## 5. Build & publish

From the project root:

```powershell
npm --prefix D:\VoiceDT\voicetype run package
```

If the local package looks fine, publish a release:

```powershell
$env:GITHUB_TOKEN = "ghp_..."
npm --prefix D:\VoiceDT\voicetype run publish
```

Friends download `Echo-1.1.0 Setup.exe` from
https://github.com/Aamirazmy92/Echo/releases — the first launch shows a
sign-up screen instead of dropping straight into the app.

---

## How it behaves at runtime

* **Online sign-in / sign-up** — required on first launch. After that
  the session is cached in `%APPDATA%/Echo/auth-session.json` so users
  aren't prompted again until the refresh token expires (60 days).
* **Offline** — Echo still works. Local dictations, edits, and
  deletions queue up in `sync_queue` and replay when a connection
  returns.
* **Cross-device** — sign in with the same account on another machine
  and Echo pulls everything down. Last-write-wins resolves conflicts.
* **API keys (Groq) stay local** — never uploaded to Supabase. Each
  device has its own.
* **Account panel** — sidebar entry shows email, sync status, "Sign
  out" button, and a sync-now refresh.

## Troubleshooting

**"Cloud sync not configured" on the login screen.** The build
couldn't find `VITE_SUPABASE_URL`. Rebuild after editing `.env`.

**Google sign-in opens a browser tab but doesn't return into Echo.**
Confirm `echo://auth-callback` is in the Supabase redirect-URL
allowlist *and* that you ran the v1.1.0 installer (the older builds
didn't register the `echo://` protocol with Windows).

**Sign-up succeeds but sign-in says "Email not confirmed".** That's the
"Confirm email" toggle on the Email provider. Either click the link in
your inbox or disable that toggle.

**RLS error in the logs ("permission denied for table history").**
Means schema.sql didn't run cleanly. Re-run it; the policies are
idempotent.
