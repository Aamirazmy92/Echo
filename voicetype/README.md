# Echo

A Windows-only voice dictation app. Hold a hotkey, speak, and the transcript is typed into whatever app currently has focus. Cloud transcription runs through Groq's Whisper-Large-v3-Turbo; offline mode runs whisper.cpp locally.

> Personal/private project. Not licensed for redistribution.

---

## Requirements

- **Windows 10 or 11** (PowerShell 5+ available; the hotkey watcher and SendInput helper both shell out to `powershell.exe`).
- **Node.js 20+** and npm.
- A microphone.
- Either:
  - A Groq API key (free at [console.groq.com/keys](https://console.groq.com/keys)) for cloud transcription, **or**
  - ~150 MB free disk for the local Whisper model that gets downloaded on first use.

---

## Quick start (development)

```powershell
npm install
npm start
```

`npm start` runs the dev supervisor which restarts the Electron main/preload bundles when those files change. The renderer hot-reloads without a restart.

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm start` | Dev mode with auto-restart for main/preload edits. |
| `npm run start:forge` | Plain Electron Forge dev (no auto-restart). |
| `npm run typecheck` | TypeScript check, no emit. |
| `npm run lint` | ESLint over `src/`. |
| `npm test` | Vitest (currently no tests). |
| `npm run package` | Produce an unpacked `out/echo-win32-x64/` folder. |
| `npm run make` | Produce a Squirrel installer at `out/make/squirrel.windows/x64/`. |
| `npm run publish` | Build + upload a GitHub Release (auto-update source). |
| `node scripts/generate-icons.cjs` | Regenerate tray + app icons. |

---

## First-run setup

1. Launch Echo. The onboarding screen guides you through:
   - Microphone selection
   - Hotkey choice (push-to-talk vs. toggle)
2. Open Settings (sidebar bottom-left) → **API** and paste your Groq key. Hit **Test** to verify, then **Save**. The key is encrypted at rest with `safeStorage` (DPAPI on Windows).
3. Optionally enable offline transcription in Settings → **Advanced**. Echo downloads `ggml-base.bin` (~142 MB) the first time you toggle it on.

Default hotkey is **Win + Space** (push-to-talk).

---

## Where Echo stores data

| Path | Contents |
| --- | --- |
| `%APPDATA%\Echo\config.json` | Settings (encrypted Groq key, hotkeys, language, tone, etc.). |
| `%APPDATA%\Echo\history.db` | SQLite history of dictations + dictionary + snippets. |
| `%APPDATA%\Echo\dictation.log` | Rolling 1 MB error log (rotates to `dictation.log.1`). |
| `%APPDATA%\Echo\whispercpp\models\ggml-base.bin` | Local model after download. |
| `%LOCALAPPDATA%\Echo\session-data\` | Chromium cache (safe to delete; recreated on next launch). |

Uninstalling via the Squirrel installer leaves these in place. Delete them manually if you want a clean slate.

---

## Building a release for distribution

The repo is wired to publish Squirrel `.exe` installers to a private GitHub repo, which `electron-updater` polls for updates.

### One-time setup

1. Create a (private is fine) GitHub repo at `Aamirazmy92/Echo` to match `forge.config.ts`. Push this codebase to it.
2. Generate a GitHub Personal Access Token with `repo` scope.

### Each release

```powershell
# 1. Bump the version in package.json (e.g. 1.0.0 -> 1.0.1).
# 2. Commit and tag.
git add package.json
git commit -m "v1.0.1"
git tag v1.0.1

# 3. Publish.
$env:GITHUB_TOKEN = "ghp_yourPATtokenhere"
npm run publish
```

This runs `verify-release-assets.cjs`, builds the installer, signs it (only if `SIGNING_CERT_PATH` and `SIGNING_CERT_PASSWORD` are set), and uploads `Echo-Setup.exe` + `RELEASES` to the GitHub release.

Already-installed copies will check for the new release on next launch and download it in the background. The update applies on app quit.

### What about code signing?

Builds run unsigned by default. SmartScreen will warn the first time each user installs ("Unknown publisher" — click **More info → Run anyway**). For five users that's fine. To sign, set the env vars before `npm run make`:

```powershell
$env:SIGNING_CERT_PATH = "C:\path\to\cert.pfx"
$env:SIGNING_CERT_PASSWORD = "..."
npm run make
```

---

## Architecture quick map

```
src/
  main/        Electron main process. Hotkey watcher, transcription
               pipeline (cloud + local whisper.cpp), text injection,
               history DB, encrypted settings store, tray, overlay.
  renderer/    React 18 app. Tabs: Dashboard / Insights / History /
               Snippets / Style. Settings opens in a portal-modal.
  shared/      Types, hotkey/language utilities — used by both sides.

scripts/
  dev-supervisor.cjs        Restarts Forge when main bundles change.
  verify-release-assets.cjs Pre-flight check for `make`/`publish`.
  generate-icons.cjs        Regenerates tray PNGs + icon.ico from
                            procedural drawing (no Sharp dependency).

vendor/
  whispercpp/blas-bin/      Bundled whisper-server.exe + DLLs.
                            ggml-base.bin is downloaded on first use.

assets/
  icon.ico, icon.png        Brand icon (16/32/48/256 multi-res).
  tray-*.png                Tray state icons (16x16).
```

The hotkey watcher and SendInput helper run as long-lived PowerShell child processes. Both are shut down via `before-quit`; if Echo ever crashes hard you can clean up orphan helpers in Task Manager (look for `powershell.exe` parented to a now-dead `Echo.exe`).

---

## Troubleshooting

- **Hotkey doesn't fire.** Check Settings → Hotkeys for a conflict with another app. Some games / RDP sessions intercept global hotkeys.
- **"Groq API key invalid" toast.** Open Settings → API → click **Test**. The error message will be more specific. Re-paste a fresh key from console.groq.com if needed.
- **App opens then disappears.** It's hidden to tray on close. Click the tray icon (mic glyph) to reopen.
- **"Update failed" in `dictation.log`.** Most often a GitHub rate-limit if you're not signed in. Auto-update is best-effort; manual reinstall always works.
- **Want a clean reset.** Delete `%APPDATA%\Echo\` and relaunch.
