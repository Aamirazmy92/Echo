# Dictation Latency Optimization — Design

**Date:** 2026-06-12
**Goal:** Minimize hotkey-press → recording-start latency and hotkey-release → text-injected latency, without weakening the free-tier usage gate: a user who has hit the weekly word cap must still be blocked from starting a recording.

## Background — measured hot path today

Start side (hotkey press → audio capture):

1. `App.tsx` `onStart` awaits `basicUsageGet()` IPC before recording starts. The handler calls `history.getAllEntries()` (full SQLite table scan) and, when usage looks exhausted, a network `refreshEntitlements()` — all before the mic starts. First words are clipped by this window.
2. After the 10-minute idle teardown, `getUserMedia` cold start adds 100–500 ms (clipped speech).

Stop side (hotkey release → injection):

3. The webm/opus blob is decoded (`decodeAudioData`), downsampled, and normalized after stop — cost proportional to clip length.
4. `getAllEntries()` scans the table again in the `transcribe-audio` handler.
5. For free users, `refreshEntitlementsForRouting()` may put a network round trip before local transcription.
6. Two sequential cloud round trips: client→Supabase→Groq Whisper→client, then client→Supabase→Groq Llama (cleanup)→client. The second leg re-pays full client↔Supabase RTT (~300–800 ms).
7. Audio is uploaded as uncompressed 16-bit 16 kHz WAV (~32 KB/s of speech) even though Opus (~5 KB/s) was already produced by MediaRecorder.

Already good (keep as-is): persistent prewarmed SendInput helper, persistent whisper-server, audio graph prewarm, parallel module warm-up in the transcribe handler, clipboard-paste injection.

## Design

Three phases, each independently shippable. All current behavior (free/pro gating including the pre-recording block, local fallback, silence guards, tones, snippets, dictionary) is preserved — only *when* and *where* work happens changes.

### Phase 1 — Make the hot path non-blocking

**1a. Cached weekly usage counter.** The history module maintains an in-memory weekly word count: computed once at init via a SQL `SUM(wordCount)` over the current week (not `getAllEntries()`), incremented on `addEntry`, recomputed on week rollover and on history deletion/clear. `basic-usage-get` and the stop-side gate read this cache synchronously.

- The **pre-recording gate stays** in `App.tsx` `onStart`, but now resolves from cache in ~0 ms for users under the cap.
- When the cache says *exhausted*, keep today's behavior: refresh entitlements (network) before final verdict. That path only runs when recording is already going to be blocked, so its latency is acceptable.

**1b. Entitlements refresh leaves the hot path.** `refreshEntitlementsForRouting()` no longer awaits a network call inside `transcribeAudio`. Entitlements are refreshed in the background: on app start, on recording **start** (concurrent with the user speaking), and on the existing periodic/billing triggers. Routing uses the cached entitlement state.

**1c. Connection prewarm.** On recording start, fire a lightweight preflight request (`OPTIONS`/`HEAD`) to the Supabase functions base URL so DNS + TLS are warm when the upload starts on hotkey release. Best-effort, errors ignored.

### Phase 2 — One cloud round trip instead of two

Extend the `/transcribe` edge function to optionally run the cleanup LLM pass server-side and return the final text in the same response. The client sends the tone/cleanup parameters (model, system prompt, temperature, max tokens) along with the audio. Supabase→Groq→Groq stays in-region, deleting one full client RTT per cloud dictation.

- Client detects support via the response shape and **falls back to the existing two-step path** if the deployed function predates the change.
- The client-side assistant-reply safety check (`looksLikeAssistantReply`) and `postProcessToneOutput` still run client-side on the returned text.

### Phase 3 — Capture pipeline: never clip a word, nothing to decode on stop

Replace MediaRecorder-as-source-of-truth with a continuous **AudioWorklet** capture:

- While the audio graph is warm, PCM flows into a small ring buffer (~1 s capacity).
- On hotkey press, recording starts by snapshotting ~300 ms of pre-roll from the ring — worst-case start latency clips nothing.
- Downsampling to 16 kHz happens incrementally per chunk during recording; on hotkey release the final PCM is already complete: zero decode, immediate IPC to main.
- The analyser/levels/speech-metrics logic moves onto the same graph (it already shares the AudioContext).
- Cloud upload size: prefer uploading Opus (either encode from PCM or retain a parallel MediaRecorder used only for the cloud payload — pick the simpler at implementation time). WAV remains the fallback; the local whisper path keeps consuming raw 16 kHz PCM unchanged.

## Error handling

- Cache desync: usage counter recomputes from SQL on any history mutation outside `addEntry` (delete, clear, import).
- Stale entitlements: background refresh failures keep the last-known state, same as today's catch-and-continue.
- Phase 2 server mismatch: silent fallback to two-step; cleanup failure still degrades to `postProcessToneOutput(rawText)` as today.
- Phase 3 worklet failure: fall back to the current MediaRecorder path.

## Testing

- Existing Vitest suite stays green (`npm test`, `npm run typecheck`, `npm run lint`).
- New unit tests: weekly usage counter (rollover, increment, recompute-on-delete), incremental resampler, ring-buffer pre-roll snapshot.
- Per-phase manual end-to-end dictation check on the real app (cloud and local paths), including the exhausted-cap block on recording start.

## Implementation deviations (recorded 2026-06-12)

- **Downsampling is one-pass at stop, not incremental.** With raw PCM already in memory (no container decode), a single downsample pass over even a 30 s clip costs ~10–20 ms — incremental chunk-wise resampling added statefulness for no measurable gain.
- **Cloud upload stays WAV; Opus deferred.** The `/transcribe` edge function derives billing duration from the WAV header (`getWavDurationSeconds`) for fair-use integrity. Switching to Opus requires a server-side duration validation strategy for WebM/Ogg first. Noted as future work.
- **Edge function not yet deployed.** The combined transcribe+cleanup function is committed but `npx supabase functions deploy transcribe` requires explicit operator action. Until deployed, clients silently use the two-step path.

## Out of scope

Streaming/partial transcription during recording, replacing the PowerShell hotkey/inject helpers, per-app profiles, UI redesign.
