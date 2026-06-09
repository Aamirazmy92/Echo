# Echo

**Voice dictation for Windows.** Hold a hotkey, speak, and Echo types the transcript straight into whatever app currently has focus — your editor, browser, chat, terminal, anywhere.

Echo also includes a built-in **Notepad** with detachable sticky-note windows, a searchable dictation **History**, reusable **Snippets**, and a **Style** engine that rewrites your speech into the tone you want.

> Personal project. Not licensed for redistribution.

---

## Download & install

1. Grab the latest installer from the [**Releases**](https://github.com/Aamirazmy92/Echo/releases/latest) page (`Echo-Setup-x.y.z.exe`).
2. Run it. Windows SmartScreen may warn about an "Unknown publisher" because the build is unsigned — click **More info → Run anyway**.
3. Launch Echo and follow the onboarding (microphone + hotkey).

Echo auto-updates: installed copies check Releases on launch and apply updates on quit.

**Requirements:** Windows 10 or 11, a microphone, and either a free [Groq API key](https://console.groq.com/keys) (cloud transcription) or ~150 MB of disk for the local Whisper model (offline mode).

---

## Features

- **Push-to-talk or toggle dictation.** Default hotkey is **Win + Space**. Speak, release, and the text is injected into the focused window.
- **Cloud or offline transcription.** Cloud runs on Groq's Whisper-Large-v3-Turbo; offline runs `whisper.cpp` locally with no network.
- **Notepad with detachable windows.** Open notes as sticky-note windows, tear tabs out into their own windows, and drag them back together — tabs merge into the window you drop them on.
- **History.** Every dictation is saved to a local searchable database you can copy from or reuse.
- **Snippets & dictionary.** Define shortcuts and custom spellings so Echo gets your jargon right.
- **Style / tone rewriting.** Automatically clean up filler words or rewrite into a chosen tone.
- **Private by default.** Settings and your API key are encrypted at rest (Windows DPAPI); history stays on your machine.

---

## First-run setup

1. Pick your microphone and hotkey in onboarding.
2. Open **Settings → API**, paste your Groq key, click **Test**, then **Save**.
3. (Optional) Enable offline transcription in **Settings → Advanced** — Echo downloads `ggml-base.bin` (~142 MB) the first time.

---

## Where your data lives

| Path | Contents |
| --- | --- |
| `%APPDATA%\Echo\config.json` | Settings (encrypted Groq key, hotkeys, language, tone). |
| `%APPDATA%\Echo\history.db` | Dictation history, dictionary, and snippets. |
| `%APPDATA%\Echo\dictation.log` | Rolling error log. |
| `%APPDATA%\Echo\whispercpp\models\` | Local Whisper model after download. |

Uninstalling leaves these in place — delete `%APPDATA%\Echo\` for a clean reset.

---

## Building from source

The app lives in [`voicetype/`](voicetype). See the [developer guide](voicetype/README.md) for the full toolchain, scripts, architecture map, and release process.

```powershell
cd voicetype
npm install
npm start
```

---

## License

Private/unlicensed. All rights reserved.
