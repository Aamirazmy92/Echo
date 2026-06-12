# Dictation Latency Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut hotkey-press → recording-start and hotkey-release → text-injected latency while keeping the pre-recording free-tier block intact.

**Architecture:** Three phases. Phase 1 removes blocking work (full-table scans, network calls) from the dictation hot path by switching the usage gate to a SQL aggregate and making entitlements refresh background-only. Phase 2 merges the cleanup LLM pass into the `/transcribe` edge function so cloud dictation costs one client round trip instead of two. Phase 3 replaces MediaRecorder with a continuous AudioWorklet PCM capture with pre-roll, eliminating start-clipping and the whole-clip Opus decode on stop.

**Tech Stack:** Electron main (Node/TS), React renderer, better-sqlite3, Supabase Edge Functions (Deno), Web Audio AudioWorklet, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-dictation-latency-design.md`

**Verification commands (run from `voicetype/`):** `npm test`, `npm run typecheck`, `npm run lint`

---

## Phase 1 — Non-blocking hot path

### Task 1: Extract week-window helper into a testable module

`getStartOfWeek` currently lives in `src/main/index.ts:334` (untestable — index.ts imports electron). Move it to its own module.

**Files:**
- Create: `src/main/usageWindow.ts`
- Create: `src/main/usageWindow.test.ts`
- Modify: `src/main/index.ts` (remove local copy, import instead)

- [ ] **Step 1: Write the failing test**

```ts
// src/main/usageWindow.test.ts
import { describe, expect, it } from 'vitest';
import { getStartOfWeek, getWeekStartIso } from './usageWindow';

describe('getStartOfWeek', () => {
  it('returns the preceding Monday at local midnight', () => {
    // Thursday 2026-06-11 15:30 local
    const start = getStartOfWeek(new Date(2026, 5, 11, 15, 30));
    expect(start.getDay()).toBe(1); // Monday
    expect(start.getDate()).toBe(8);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });

  it('returns the same day at midnight when called on a Monday', () => {
    const start = getStartOfWeek(new Date(2026, 5, 8, 9, 0));
    expect(start.getDate()).toBe(8);
    expect(start.getHours()).toBe(0);
  });

  it('treats Sunday as the last day of the week', () => {
    const start = getStartOfWeek(new Date(2026, 5, 14, 23, 59));
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(8);
  });
});

describe('getWeekStartIso', () => {
  it('returns an ISO string comparable to entry created_at values', () => {
    const iso = getWeekStartIso(new Date(2026, 5, 11, 15, 30));
    expect(iso).toBe(getStartOfWeek(new Date(2026, 5, 11, 15, 30)).toISOString());
    // ISO strings compare lexicographically in the same way as instants.
    expect(iso < new Date(2026, 5, 11, 16, 0).toISOString()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/usageWindow.test.ts`
Expected: FAIL — cannot resolve `./usageWindow`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/usageWindow.ts
// Week window used by the Basic-tier weekly word cap. The week starts
// Monday 00:00 local time; entries store created_at as UTC ISO strings,
// so the gate compares ISO strings (lexicographic order == time order).

export function getStartOfWeek(date: Date): Date {
  const start = new Date(date);
  const day = start.getDay();
  const daysSinceMonday = (day + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function getWeekStartIso(now: Date = new Date()): string {
  return getStartOfWeek(now).toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/usageWindow.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Point index.ts at the new module**

In `src/main/index.ts`: delete the local `getStartOfWeek` function (lines ~334–341) and add to the import block near the other `./` imports:

```ts
import { getWeekStartIso } from './usageWindow';
```

`countWordsThisWeek` still references `getStartOfWeek` — it is deleted in Task 3; for this commit, temporarily change its first line to:

```ts
  const weekStart = new Date(getWeekStartIso());
```

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npx vitest run src/main/usageWindow.test.ts`
Expected: clean typecheck, tests pass.

```bash
git add src/main/usageWindow.ts src/main/usageWindow.test.ts src/main/index.ts
git commit -m "refactor(usage): extract week-window helper into testable module"
```

### Task 2: SQL aggregate for weekly word count

**Files:**
- Modify: `src/main/history.ts`

- [ ] **Step 1: Add the index to the schema**

In `initHistory()` in `src/main/history.ts`, inside the big `db.exec(...)` template right after the `dictations` CREATE TABLE block (after line ~140), add:

```sql
    CREATE INDEX IF NOT EXISTS idx_dictations_created_at ON dictations(created_at);
```

- [ ] **Step 2: Add `getWeeklyWordCount`**

Add next to `getStats()` in `src/main/history.ts`:

```ts
/**
 * Sum of word_count for non-deleted dictations created at or after
 * `sinceIso` (UTC ISO string). Replaces the previous pattern of
 * materializing every row via getAllEntries() just to count words —
 * this is an indexed aggregate and runs in well under a millisecond.
 */
export function getWeeklyWordCount(sinceIso: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(word_count), 0) AS total FROM dictations WHERE deleted_at IS NULL AND created_at >= ?')
    .get(sinceIso) as { total: number };
  return row.total;
}
```

Note: `deleted_at` is the soft-delete column used by `getAllEntries` (`history.ts:372`). If typecheck complains the column may not exist on old DBs, it does exist — the sync migration adds it; mirror whatever guard `getAllEntries` uses (it uses none).

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: clean. (No new unit test: `history.ts` imports `electron` at module top and cannot load under vitest; coverage comes from the existing manual end-to-end check in Task 6.)

```bash
git add src/main/history.ts
git commit -m "perf(usage): indexed SQL aggregate for weekly word count"
```

### Task 3: Rewire usage gates to the aggregate

**Files:**
- Modify: `src/main/index.ts` (lines ~343–393, 643–646, 888)

- [ ] **Step 1: Replace the snapshot helpers**

In `src/main/index.ts`, delete `countWordsThisWeek` (~lines 343–350) and replace `getBasicUsageSnapshot` and `getBasicUsageSnapshotForGate` with:

```ts
type HistoryModule = Awaited<ReturnType<typeof ensureHistoryModule>>;

function getBasicUsageSnapshot(history: HistoryModule): BasicUsageSnapshot {
  const tier = getEntitlementsSnapshot().tier;
  const used = history.getWeeklyWordCount(getWeekStartIso());
  const remaining = Math.max(0, BASIC_WEEKLY_WORD_CAP - used);
  return {
    tier,
    used,
    cap: BASIC_WEEKLY_WORD_CAP,
    remaining,
    exhausted: tier !== 'pro' && used >= BASIC_WEEKLY_WORD_CAP,
  };
}

async function getBasicUsageSnapshotForGate(history: HistoryModule): Promise<BasicUsageSnapshot> {
  let snapshot = getBasicUsageSnapshot(history);
  if (!snapshot.exhausted) return snapshot;

  // Only the already-blocked path pays for a network refresh — the user
  // cannot record anyway, so latency here is acceptable and it gives a
  // just-upgraded Pro user an immediate unblock.
  try {
    await refreshEntitlements();
  } catch (err) {
    logWarn('usage-limit', 'Entitlements refresh failed before Basic usage gate', err);
  }

  snapshot = getBasicUsageSnapshot(history);
  return snapshot;
}
```

If `ensureHistoryModule`'s return type makes the `HistoryModule` alias awkward, use `typeof import('./history')` instead.

- [ ] **Step 2: Update the call sites**

`src/main/index.ts:643` (`basic-usage-get` handler):

```ts
  ipcMain.handle('basic-usage-get', async () => {
    const history = await ensureHistoryModule();
    return getBasicUsageSnapshotForGate(history);
  });
```

`src/main/index.ts:888` (transcribe handler):

```ts
      const currentBasicUsage = await getBasicUsageSnapshotForGate(history);
```

The post-transcription word-cap check at line ~990 (`currentBasicUsage.used + wordCount > BASIC_WEEKLY_WORD_CAP`) is unchanged.

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm test && npm run lint`
Expected: clean.

```bash
git add src/main/index.ts
git commit -m "perf(usage): gate reads indexed weekly count instead of scanning all history"
```

### Task 4: Background-only entitlements refresh

**Files:**
- Modify: `src/main/entitlements.ts`
- Modify: `src/main/transcribe.ts` (delete `refreshEntitlementsForRouting`)

- [ ] **Step 1: Add a staleness-aware background refresh to entitlements.ts**

Append to `src/main/entitlements.ts`:

```ts
/**
 * Fire-and-forget refresh used from latency-critical paths (recording
 * start). Skips the network entirely when the cached snapshot is fresh,
 * and never throws — callers must not await this on the hot path.
 */
export function refreshEntitlementsInBackground(maxAgeMs = 60_000): void {
  if (current.loading) return;
  if (Date.now() - current.fetchedAt < maxAgeMs) return;
  void refreshEntitlements().catch((err) => {
    logWarn('entitlements', 'background refresh failed', err);
  });
}
```

- [ ] **Step 2: Remove the await from the transcription path**

In `src/main/transcribe.ts`:
- Delete the whole `refreshEntitlementsForRouting` function (lines ~119–128).
- Delete its call inside `transcribeAudio` (`await refreshEntitlementsForRouting();` at line ~261).
- Update the import at the top: `import { isProUser } from './entitlements';` (drop `refreshEntitlements`).
- Update the routing comment above `useProxy` to say routing uses the cached entitlement snapshot, refreshed in the background on recording start.

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: clean (`transcribe.test.ts` exercises pure text helpers; unaffected).

```bash
git add src/main/entitlements.ts src/main/transcribe.ts
git commit -m "perf(entitlements): cache-only routing; refresh in background off the hot path"
```

### Task 5: Warm entitlements + cloud connection on recording start

**Files:**
- Modify: `src/main/cloud.ts`
- Modify: `src/main/hotkey.ts` (`startRecording`, ~line 454)

- [ ] **Step 1: Add `prewarmCloudConnection` to cloud.ts**

Append to `src/main/cloud.ts`:

```ts
/**
 * Best-effort preflight so DNS + TLS to the functions host are already
 * warm when the dictation upload starts on hotkey release. OPTIONS hits
 * the edge CORS handler — no auth, no body, no side effects.
 */
export function prewarmCloudConnection(): void {
  if (!isCloudConfigured()) return;
  void fetch(`${functionsBaseUrl()}/transcribe`, { method: 'OPTIONS' }).catch(() => {
    // Connection warming is opportunistic; errors are expected offline.
  });
}
```

- [ ] **Step 2: Call both warmers from `startRecording` in hotkey.ts**

In `src/main/hotkey.ts`, add imports:

```ts
import { refreshEntitlementsInBackground } from './entitlements';
import { hasCloudSession, prewarmCloudConnection } from './cloud';
```

In `startRecording(...)` (after the existing `prewarmInjectHelper()` block, ~line 477), add:

```ts
  // While the user is speaking: make sure the entitlement snapshot the
  // router will consult is fresh, and open the TLS connection the upload
  // will ride on. Both are fire-and-forget — never awaited here.
  refreshEntitlementsInBackground();
  if (hasCloudSession()) {
    prewarmCloudConnection();
  }
```

Check for import cycles: `hotkey.ts` ← `index.ts`, and `cloud.ts`/`entitlements.ts` do not import `hotkey.ts` — safe.

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

```bash
git add src/main/cloud.ts src/main/hotkey.ts
git commit -m "perf(hotkey): warm entitlements and cloud connection while user speaks"
```

### Task 6: Phase 1 end-to-end verification

- [ ] **Step 1: Run the app and dictate**

Run: `npm start`. With a signed-in account: hold the hotkey, speak, release. Confirm:
- Text lands in the focused app (cloud path).
- With `aiCleanup`/cloud off, local path still works.
- Settings → usage display still shows correct weekly word usage (it flows through `basic-usage-get`).

- [ ] **Step 2: Verify the exhausted block still blocks**

Temporarily set `const BASIC_WEEKLY_WORD_CAP = 1;` in `index.ts`, restart, dictate once, then press the hotkey again — recording must NOT start and the limit toast must appear. Revert the constant afterward and confirm `git diff` is clean of the test hack.

---

## Phase 2 — One cloud round trip

### Task 7: Server-side optional cleanup in the transcribe edge function

**Files:**
- Modify: `supabase/functions/transcribe/index.ts`

- [ ] **Step 1: Add cleanup constants and helper near the top of the file (below existing consts)**

```ts
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CLEANUP_ALLOWED_MODELS = new Set(['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
const CLEANUP_MAX_SYSTEM_PROMPT_CHARS = 8_000;
const CLEANUP_MAX_TOKENS = 2_048;

// Must mirror USER_PROMPT_TEMPLATE in src/main/cleanup.ts.
function buildCleanupUserPrompt(rawText: string): string {
  return `Dictated text to rewrite exactly as instructed below:\n<<<DICTATION\n${rawText}\nDICTATION>>>`;
}

async function runServerCleanup(args: {
  groqApiKey: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  transcriptText: string;
}): Promise<{ cleanedText: string | null; tokensIn: number; tokensOut: number }> {
  const maxTokens = Math.min(Math.max(256, args.transcriptText.length * 2), CLEANUP_MAX_TOKENS);
  const res = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: args.model,
      temperature: args.temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: buildCleanupUserPrompt(args.transcriptText) },
      ],
    }),
  });
  if (!res.ok) {
    console.warn('[transcribe] inline cleanup groq error', res.status, await res.text());
    return { cleanedText: null, tokensIn: 0, tokensOut: 0 };
  }
  const parsed = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    cleanedText: parsed.choices?.[0]?.message?.content?.trim() ?? null,
    tokensIn: parsed.usage?.prompt_tokens ?? 0,
    tokensOut: parsed.usage?.completion_tokens ?? 0,
  };
}
```

- [ ] **Step 2: Read the optional cleanup fields from the inbound form (after the `language` parsing, ~line 124)**

```ts
    const cleanupSystemPromptValue = inbound.get('cleanup_system_prompt');
    const cleanupModelValue = inbound.get('cleanup_model');
    const cleanupTemperatureValue = inbound.get('cleanup_temperature');
    const cleanupRequested =
      typeof cleanupSystemPromptValue === 'string' &&
      cleanupSystemPromptValue.length > 0 &&
      cleanupSystemPromptValue.length <= CLEANUP_MAX_SYSTEM_PROMPT_CHARS;
    const cleanupModel =
      typeof cleanupModelValue === 'string' && CLEANUP_ALLOWED_MODELS.has(cleanupModelValue)
        ? cleanupModelValue
        : 'llama-3.1-8b-instant';
    const cleanupTemperatureParsed = Number(cleanupTemperatureValue);
    const cleanupTemperature = Number.isFinite(cleanupTemperatureParsed)
      ? Math.min(1, Math.max(0, cleanupTemperatureParsed))
      : 0.1;
```

- [ ] **Step 3: Run the cleanup pass and merge it into the response**

Replace the success tail of the handler (from `// Best-effort usage log` through the final `return new Response(text, ...)`) with:

```ts
    // Optional inline cleanup pass: one client round trip instead of two.
    // Failures degrade silently — the client falls back to its local
    // post-processing when cleaned_text is absent.
    let cleanedText: string | null = null;
    if (cleanupRequested) {
      try {
        const verbose = JSON.parse(text) as { text?: string };
        const transcriptText = typeof verbose.text === 'string' ? verbose.text.trim() : '';
        const fairUseBlocked =
          ent.fairUseRemainingSeconds === 0 && ent.status !== 'developer' && ent.status !== 'admin';
        if (transcriptText && !fairUseBlocked) {
          const cleanup = await runServerCleanup({
            groqApiKey,
            model: cleanupModel,
            systemPrompt: cleanupSystemPromptValue as string,
            temperature: cleanupTemperature,
            transcriptText,
          });
          cleanedText = cleanup.cleanedText;
          if (cleanedText !== null) {
            logUsage(admin, user.id, 'cleanup', {
              tokensIn: cleanup.tokensIn,
              tokensOut: cleanup.tokensOut,
            }).catch((err) => console.warn('[transcribe] cleanup usage log failed', err));
          }
        }
      } catch (err) {
        console.warn('[transcribe] inline cleanup failed', err);
      }
    }

    logUsage(admin, user.id, 'transcribe', { audioSeconds }).catch((err) => {
      console.warn('[transcribe] usage log failed', err);
    });
    console.info('[transcribe] completed', user.id, audioSeconds, cleanedText !== null ? 'with-cleanup' : 'no-cleanup');

    if (cleanedText === null) {
      return new Response(text, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const merged = JSON.parse(text) as Record<string, unknown>;
    merged.cleaned_text = cleanedText;
    return new Response(JSON.stringify(merged), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
```

- [ ] **Step 4: Commit (deploy happens in Task 10)**

```bash
git add supabase/functions/transcribe/index.ts
git commit -m "feat(edge): optional inline cleanup pass in /transcribe (one client RTT)"
```

### Task 8: Expose cleanup plan + finalizer from cleanup.ts

**Files:**
- Modify: `src/main/cleanup.ts`
- Test: `src/main/cleanup.test.ts` (extend the existing file)

- [ ] **Step 1: Write the failing tests**

Append to `src/main/cleanup.test.ts` (match the file's existing import style; it already imports from `./cleanup`):

```ts
import { buildCleanupPlan, finalizeCleanup } from './cleanup';
import type { Settings } from '../shared/types';

const baseSettings = { aiCleanup: true, useCloudTranscription: true } as unknown as Settings;

describe('buildCleanupPlan', () => {
  it('returns null when aiCleanup is disabled', () => {
    expect(buildCleanupPlan(null, { ...baseSettings, aiCleanup: false } as Settings)).toBeNull();
  });

  it('returns model, systemPrompt and temperature for the default tone', () => {
    const plan = buildCleanupPlan(null, baseSettings);
    expect(plan).not.toBeNull();
    expect(plan!.model).toBe('llama-3.1-8b-instant');
    expect(plan!.systemPrompt).toContain('text rewriter for speech dictation');
    expect(typeof plan!.temperature).toBe('number');
  });
});

describe('finalizeCleanup', () => {
  it('keeps the cleaned text when it is sane', () => {
    expect(finalizeCleanup('hello world um', 'Hello world.', null)).toBe('Hello world.');
  });

  it('falls back to raw text when the model replied like an assistant', () => {
    expect(
      finalizeCleanup('please fix the bug', "I don't see any images attached to this conversation", null)
    ).toBe('please fix the bug');
  });

  it('falls back to raw text when cleaned text is empty', () => {
    expect(finalizeCleanup('keep me', '', null)).toBe('keep me');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/cleanup.test.ts`
Expected: FAIL — `buildCleanupPlan` / `finalizeCleanup` not exported.

- [ ] **Step 3: Implement in cleanup.ts**

Add to `src/main/cleanup.ts` (below `buildSystemPrompt`); then refactor `cleanupText` to reuse `finalizeCleanup` for its post-LLM tail so the safety logic exists once:

```ts
export interface CleanupPlan {
  model: string;
  systemPrompt: string;
  temperature: number;
}

/**
 * The request the cloud transcribe call can carry so the server runs the
 * cleanup pass inline. Returns null when AI cleanup is off. Language
 * guardrail uses the pre-transcription form (no detected language yet).
 */
export function buildCleanupPlan(toneId: GlobalStyleId | null, settings: Settings): CleanupPlan | null {
  if (!settings.aiCleanup) return null;
  const config = toneId
    ? getGlobalStyleConfig(toneId)
    : {
        model: 'llama-3.1-8b-instant',
        prompt:
          'Rewrite this dictation with light cleanup only. Remove transcription noise and filler words when they are clearly accidental, fix spacing and punctuation, and preserve the original meaning and tone.',
        temperature: 0.1,
      };
  return {
    model: config.model,
    systemPrompt: buildSystemPrompt(toneId, config.prompt, settings),
    temperature: config.temperature,
  };
}

/**
 * Shared post-LLM tail: assistant-reply safety check + tone post-process.
 * Used both for server-side inline cleanup results and the legacy
 * two-step path.
 */
export function finalizeCleanup(rawText: string, cleanedText: string | null, toneId: GlobalStyleId | null): string {
  const finalText = cleanedText?.trim() || rawText;
  if (looksLikeAssistantReply(rawText, finalText)) {
    console.warn('[cleanup] Discarded assistant-style cleanup response and kept raw dictation.');
    return postProcessToneOutput(rawText, toneId);
  }
  return postProcessToneOutput(finalText, toneId);
}
```

Inside `cleanupText`, replace the block after the proxy call (`const finalText = cleaned || rawText; ... return postProcessToneOutput(finalText, toneId);`) with:

```ts
    return finalizeCleanup(rawText, cleaned, toneId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/cleanup.test.ts && npm run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/main/cleanup.ts src/main/cleanup.test.ts
git commit -m "feat(cleanup): exportable cleanup plan + shared finalizer for inline server cleanup"
```

### Task 9: Thread the cleanup plan through the cloud transcription call

**Files:**
- Modify: `src/main/cloud.ts` (`proxyTranscribe`)
- Modify: `src/main/cloudTranscribe.ts`
- Modify: `src/main/transcribe.ts`
- Modify: `src/main/index.ts` (transcribe handler, ~lines 901–945)

- [ ] **Step 1: cloud.ts — send cleanup form fields, surface `cleaned_text`**

Update `ProxyTranscribeResult` and `proxyTranscribe`:

```ts
export interface ProxyTranscribeResult {
  text?: string;
  language?: string;
  cleaned_text?: string;
}

export interface ProxyCleanupPlan {
  model: string;
  systemPrompt: string;
  temperature: number;
}

export async function proxyTranscribe(args: {
  wavBuffer: Buffer;
  language: string;
  durationMs: number;
  cleanup?: ProxyCleanupPlan;
  signal?: AbortSignal;
}): Promise<ProxyTranscribeResult> {
  const form = new FormData();
  const ab = args.wavBuffer.buffer.slice(
    args.wavBuffer.byteOffset,
    args.wavBuffer.byteOffset + args.wavBuffer.byteLength,
  ) as ArrayBuffer;
  form.append('file', new Blob([ab], { type: 'audio/wav' }), 'audio.wav');
  form.append('language', args.language);
  form.append('duration_ms', String(Math.max(0, Math.round(args.durationMs))));
  if (args.cleanup) {
    form.append('cleanup_model', args.cleanup.model);
    form.append('cleanup_system_prompt', args.cleanup.systemPrompt);
    form.append('cleanup_temperature', String(args.cleanup.temperature));
  }

  return call<ProxyTranscribeResult>('/transcribe', {
    body: form,
    signal: args.signal,
  });
}
```

- [ ] **Step 2: cloudTranscribe.ts — accept and return the new fields**

```ts
export async function transcribeWithCloudProxy(
  audioBuffer: ArrayBuffer,
  language: string,
  cleanup?: ProxyCleanupPlan,
): Promise<{ text: string; detectedLanguage?: string; cleanedText?: string }> {
```

Add `import type { ProxyCleanupPlan } from './cloud';` and pass `cleanup` through to `proxyTranscribe({ ... , cleanup, ... })`. Extend the return:

```ts
    return {
      text: String(result.text ?? '').replace(/\s+/g, ' ').trim(),
      detectedLanguage: typeof result.language === 'string' ? result.language.trim() : undefined,
      cleanedText: typeof result.cleaned_text === 'string' ? result.cleaned_text : undefined,
    };
```

- [ ] **Step 3: transcribe.ts — carry `cleanedText` outward**

- Add to `TranscribeResult`: `cleanedText?: string;`
- Change the signature: `transcribeAudio(audioBuffer, settings, durationMs?, speechMetrics?, cleanup?: ProxyCleanupPlan)` with `import type { ProxyCleanupPlan } from './cloud';`
- In the `useProxy` branch:

```ts
        const cloudResult = await transcribeWithCloudProxy(audioBuffer, recognitionLanguage, cleanup);
        raw = cloudResult.text;
        detectedLanguage = cloudResult.detectedLanguage;
        cleanedFromServer = cloudResult.cleanedText;
        method = 'cloud';
```

with `let cleanedFromServer: string | undefined;` declared beside `cloudError`, and include `cleanedText: cleanedFromServer` in every successful return object. Important: when the *artifact-stripped* `text` differs from raw, the server cleaned the ORIGINAL transcript — that's fine, cleanup operates on meaning, not on the artifact stripping. But when `text` is empty/phantom, return WITHOUT `cleanedText` so empty dictations stay empty.

- [ ] **Step 4: index.ts — build the plan before transcription, skip the second RTT when served**

In the `transcribe-audio` handler, move the style/tone resolution up to just before the transcription call and pass the plan (cleanup module is already being loaded in parallel):

```ts
      const { transcribeAudio } = await transcribeModulePromise;
      const cleanupModule = await cleanupModulePromise;
      const resolvedStyle = resolveGlobalStyle(settings);
      const toneId = resolvedStyle.toneId;
      const cleanupPlan =
        settings.useCloudTranscription ? cleanupModule.buildCleanupPlan(toneId, settings) : null;

      const appName = getActiveAppName();

      const result = await withTimeout(
        transcribeAudio(sanitizedAudioBuffer, settings, sanitizedDurationMs, sanitizedSpeechMetrics, cleanupPlan ?? undefined),
        TRANSCRIPTION_TIMEOUT_MS,
        'Transcription'
      );
```

Then replace the cleanup block (`const resolvedStyle = ...` through the `cleaned` assignment) with:

```ts
      let cleaned: string;
      if (result.method === 'cloud' && result.cleanedText !== undefined) {
        // Server ran the cleanup pass inline — no second round trip.
        cleaned = cleanupModule.finalizeCleanup(rawText, result.cleanedText, toneId);
      } else {
        cleaned = await withTimeout(
          cleanupModule.cleanupText(rawText, toneId, settings, result.detectedLanguage),
          CLEANUP_TIMEOUT_MS,
          'Cleanup'
        );
      }
```

(Remove the now-duplicated `resolvedStyle`/`toneId` declarations further down; `resolvedStyle.key` is still used for the history entry's `mode`.)

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test && npm run lint`
Expected: clean.

```bash
git add src/main/cloud.ts src/main/cloudTranscribe.ts src/main/transcribe.ts src/main/index.ts
git commit -m "perf(cloud): inline cleanup rides the transcribe request — one RTT per dictation"
```

### Task 10: Deploy the edge function and verify Phase 2 end-to-end

- [ ] **Step 1: Deploy**

Run: `npx supabase functions deploy transcribe` (same project the app points at; check `supabase/config.toml` or ask the user for the project ref if the CLI isn't linked).

- [ ] **Step 2: Verify combined path**

`npm start`, signed in as Pro, AI cleanup ON, dictate. Check `%APPDATA%\Echo\dictation.log` / console: no `/cleanup` request fired; transcript arrives cleaned. Then dictate with AI cleanup OFF and confirm raw-but-post-processed text. Finally, verify graceful fallback: it must also work against a NOT-yet-deployed function (the response simply lacks `cleaned_text` → client runs `cleanupText` as before) — this was exercised before the deploy step.

---

## Phase 3 — AudioWorklet capture with pre-roll

### Task 11: Pure capture buffers (TDD)

**Files:**
- Create: `src/renderer/lib/pcmCapture.ts`
- Create: `src/renderer/lib/pcmCapture.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/lib/pcmCapture.test.ts
import { describe, expect, it } from 'vitest';
import { PreRollBuffer, concatFloat32 } from './pcmCapture';

function chunk(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe('concatFloat32', () => {
  it('concatenates chunks in order', () => {
    const out = concatFloat32([chunk(1, 2), chunk(3), chunk(4, 5)]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns an empty array for no chunks', () => {
    expect(concatFloat32([]).length).toBe(0);
  });
});

describe('PreRollBuffer', () => {
  it('keeps at most maxSamples (plus at most one partial chunk)', () => {
    const buffer = new PreRollBuffer(4);
    buffer.push(chunk(1, 2));
    buffer.push(chunk(3, 4));
    buffer.push(chunk(5, 6));
    // Evicts [1,2] — remaining [3,4,5,6] is exactly maxSamples.
    expect(Array.from(buffer.snapshot(4))).toEqual([3, 4, 5, 6]);
  });

  it('snapshot returns only the newest maxSamples when asked for fewer', () => {
    const buffer = new PreRollBuffer(8);
    buffer.push(chunk(1, 2, 3, 4));
    buffer.push(chunk(5, 6, 7, 8));
    expect(Array.from(buffer.snapshot(3))).toEqual([6, 7, 8]);
  });

  it('snapshot returns everything when asked for more than stored', () => {
    const buffer = new PreRollBuffer(8);
    buffer.push(chunk(1, 2));
    expect(Array.from(buffer.snapshot(100))).toEqual([1, 2]);
  });

  it('clear empties the buffer', () => {
    const buffer = new PreRollBuffer(8);
    buffer.push(chunk(1, 2));
    buffer.clear();
    expect(buffer.snapshot(8).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/lib/pcmCapture.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/renderer/lib/pcmCapture.ts
// Pure building blocks for the AudioWorklet PCM capture path. Kept free
// of Web Audio types so they unit-test under Node.

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Rolling buffer of the most recent PCM. While armed (graph warm, not
 * recording) the worklet keeps pushing here; on recording start the last
 * few hundred ms are prepended so hotkey-handling latency never clips
 * the first word.
 */
export class PreRollBuffer {
  private chunks: Float32Array[] = [];
  private total = 0;

  constructor(private readonly maxSamples: number) {}

  push(chunk: Float32Array): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.chunks.length > 1 && this.total - this.chunks[0].length >= this.maxSamples) {
      this.total -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  /** Newest `maxSamples` samples, oldest first. */
  snapshot(maxSamples: number): Float32Array {
    const all = concatFloat32(this.chunks);
    if (all.length <= maxSamples) return all;
    return all.slice(all.length - maxSamples);
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/lib/pcmCapture.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/pcmCapture.ts src/renderer/lib/pcmCapture.test.ts
git commit -m "feat(audio): pre-roll ring buffer + PCM concat helpers"
```

### Task 12: PcmRecorder — worklet wrapper

**Files:**
- Create: `src/renderer/lib/pcmRecorder.ts`

- [ ] **Step 1: Implement the recorder**

```ts
// src/renderer/lib/pcmRecorder.ts
// Continuous AudioWorklet capture. The worklet mixes input channels to
// mono and posts ~21 ms Float32 chunks. While idle the chunks feed a
// pre-roll ring; while recording they accumulate. stop() returns the
// pre-roll + recording at the context's native sample rate — no
// container encode/decode anywhere.

import { PreRollBuffer, concatFloat32 } from './pcmCapture';

const WORKLET_NAME = 'echo-pcm-capture';
const CHUNK_SAMPLES = 1024;
const PRE_ROLL_MS = 300;
const PRE_ROLL_CAPACITY_MS = 1000;

const WORKLET_SOURCE = `
class EchoPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(${CHUNK_SAMPLES});
    this._offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this._buffer[this._offset++] = sum / channels.length;
      if (this._offset === this._buffer.length) {
        const out = this._buffer;
        this.port.postMessage(out, [out.buffer]);
        this._buffer = new Float32Array(${CHUNK_SAMPLES});
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', EchoPcmCaptureProcessor);
`;

const moduleLoadedContexts = new WeakSet<AudioContext>();

async function ensureWorkletModule(context: AudioContext): Promise<void> {
  if (moduleLoadedContexts.has(context)) return;
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(blobUrl);
    moduleLoadedContexts.add(context);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export class PcmRecorder {
  private node: AudioWorkletNode;
  private silentSink: GainNode;
  private preRoll: PreRollBuffer;
  private recordedChunks: Float32Array[] = [];
  private recording = false;
  private disposed = false;

  readonly sampleRate: number;

  private constructor(private readonly context: AudioContext, node: AudioWorkletNode) {
    this.node = node;
    this.sampleRate = context.sampleRate;
    this.preRoll = new PreRollBuffer(Math.round((PRE_ROLL_CAPACITY_MS / 1000) * context.sampleRate));

    // A worklet node with unconnected output may be skipped by the
    // renderer; route it through a muted gain to keep it pumping.
    this.silentSink = context.createGain();
    this.silentSink.gain.value = 0;
    this.node.connect(this.silentSink);
    this.silentSink.connect(context.destination);

    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.disposed) return;
      const chunk = event.data;
      if (this.recording) {
        this.recordedChunks.push(chunk);
      } else {
        this.preRoll.push(chunk);
      }
    };
  }

  static async attach(context: AudioContext, source: MediaStreamAudioSourceNode): Promise<PcmRecorder> {
    await ensureWorkletModule(context);
    const node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'max',
    });
    const recorder = new PcmRecorder(context, node);
    source.connect(node);
    return recorder;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  start(preRollMs: number = PRE_ROLL_MS): void {
    if (this.recording || this.disposed) return;
    const preRollSamples = Math.round((preRollMs / 1000) * this.sampleRate);
    this.recordedChunks = [this.preRoll.snapshot(preRollSamples)];
    this.preRoll.clear();
    this.recording = true;
  }

  /** Synchronous: everything captured so far is already in memory. */
  stop(): { samples: Float32Array; sampleRate: number } {
    this.recording = false;
    const samples = concatFloat32(this.recordedChunks);
    this.recordedChunks = [];
    return { samples, sampleRate: this.sampleRate };
  }

  /** Drop any captured audio without producing a result. */
  discard(): void {
    this.recording = false;
    this.recordedChunks = [];
  }

  dispose(): void {
    this.disposed = true;
    this.node.port.onmessage = null;
    try {
      this.node.disconnect();
      this.silentSink.disconnect();
    } catch {
      // Context may already be closed.
    }
  }
}
```

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/renderer/lib/pcmRecorder.ts
git commit -m "feat(audio): AudioWorklet PCM recorder with pre-roll"
```

### Task 13: Wire PcmRecorder into App.tsx (MediaRecorder stays as fallback)

**Files:**
- Modify: `src/renderer/App.tsx` (`ensureAudioGraph` ~line 605, `onStart` ~line 725, `onStop` ~line 933, `teardownAudioGraph` ~line 595, cancel/discard paths)

- [ ] **Step 1: Add the recorder ref and attach during graph setup**

Near the other refs (~line 402):

```ts
  const pcmRecorderRef = useRef<PcmRecorder | null>(null);
```

with `import { PcmRecorder } from './lib/pcmRecorder';` and `import { downsampleFloat32Buffer, normalizeAudioForTranscription }` left as-is (they're in-file).

In `ensureAudioGraph`, after the analyser wiring (`analyserRef.current = analyser;`):

```ts
        try {
          pcmRecorderRef.current = await PcmRecorder.attach(audioContext, source);
        } catch (error) {
          // Worklet unavailable — onStart falls back to MediaRecorder.
          console.warn('PCM worklet attach failed; using MediaRecorder fallback:', error);
          pcmRecorderRef.current = null;
        }
```

In `teardownAudioGraph` (and in the mic-test teardown path at ~line 1010), before closing the context:

```ts
      pcmRecorderRef.current?.dispose();
      pcmRecorderRef.current = null;
```

- [ ] **Step 2: Branch `onStart` on worklet availability**

Inside `onStart`, after `await ensureAudioGraph(desiredDeviceId);` and the stale-attempt re-check, wrap the existing MediaRecorder block:

```ts
        const pcmRecorder = pcmRecorderRef.current;
        if (pcmRecorder) {
          recordingStartRef.current = Date.now();
          pcmRecorder.start();
          discardPendingRecordingRef.current = false;
        } else {
          // ---- existing MediaRecorder block, unchanged ----
        }
```

The speech-metrics `levelIntervalRef` loop reads the analyser only — keep it running for BOTH branches (move it above the branch if it sits inside the MediaRecorder block; it currently starts before `recorder.ondataavailable` and is branch-independent).

The trailing stale-attempt guard (`if (!recordingIntentRef.current || ...)` after `recorder.start(250)`) gets a worklet twin:

```ts
        if (pcmRecorder && (!recordingIntentRef.current || startAttempt !== startAttemptRef.current)) {
          pcmRecorder.discard();
          updateAppState('idle');
        }
```

- [ ] **Step 3: Branch `onStop`**

At the top of the `onStop` recording-teardown logic, before the `recorderRef.current` branch:

```ts
      const pcmRecorder = pcmRecorderRef.current;
      if (pcmRecorder?.isRecording) {
        beginProcessingTimeout();
        updateAppState('processing');
        // Finalize the metric averages exactly as MediaRecorder's onstop does:
        speechMetrics.averageBand = speechMetrics.frameCount > 0 ? totalBand / speechMetrics.frameCount : 0;
        speechMetrics.averageRms = speechMetrics.frameCount > 0 ? totalRms / speechMetrics.frameCount : 0;
        try {
          const { samples, sampleRate } = pcmRecorder.stop();
          const downsampled = downsampleFloat32Buffer(samples, sampleRate, OFFLINE_SAMPLE_RATE);
          normalizeAudioForTranscription(downsampled);
          const audioBytes = new Uint8Array(downsampled.buffer, downsampled.byteOffset, downsampled.byteLength);
          const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
          new Uint8Array(audioBuffer).set(audioBytes);
          const durationMs = Math.max(0, Date.now() - recordingStartRef.current);
          void window.api.transcribeAudio(audioBuffer, durationMs, speechMetrics).catch((error: unknown) => {
            console.error('Transcription IPC error:', error);
            clearProcessingTimeout();
            void window.api.cancelRecordingStart?.();
            enterTransientErrorState('Transcription failed. Please try again.');
          });
        } catch (error) {
          console.error('PCM capture error:', error);
          clearProcessingTimeout();
          void window.api.cancelRecordingStart?.();
          enterTransientErrorState('Failed to process recorded audio.', 3000);
        }
        return;
      }
```

Implementation notes for this step (the executor must resolve these against the real file, not paste blindly):
- `speechMetrics` and `totalBand`/`totalRms` live in `onStart`'s closure. Lift them to refs (`speechMetricsRef`, etc.) or compute the averages in the level-interval loop, so `onStop` can read them in the worklet branch. The MediaRecorder branch currently finalizes `averageBand`/`averageRms` inside `recorder.onstop` — replicate that exact computation before sending.
- The `RECORDER_STOP_TIMEOUT_MS` watchdog exists because MediaRecorder's stop is async; the worklet branch is synchronous and must NOT arm it.
- Cancel path (`cancelCurrentDictation` / `discardPendingRecordingRef`): in the worklet branch call `pcmRecorder.discard()`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run lint`
Expected: clean.

- [ ] **Step 5: Manual end-to-end (both paths)**

`npm start`:
1. Dictate normally — text lands; check console for no worklet errors.
2. Speak *immediately* as you press the hotkey — first word must not be clipped (pre-roll working).
3. Long dictation (30+ s) — release-to-text gap should be visibly shorter than before (no decode).
4. Cancel hotkey mid-dictation — nothing injected, state returns to idle.
5. Mic test in Settings still works, and dictation works after it (graph rebuild path).
6. Force the fallback: temporarily make `PcmRecorder.attach` throw, confirm MediaRecorder path still dictates, then revert.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "perf(audio): worklet PCM capture with pre-roll replaces MediaRecorder hot path"
```

### Task 14: Final verification

- [ ] **Step 1: Full suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all clean.

- [ ] **Step 2: Spec conformance sweep**

Re-read `docs/superpowers/specs/2026-06-12-dictation-latency-design.md` and confirm each Phase 1/2/3 bullet maps to shipped code. Two intentional deviations to record in the spec if confirmed during implementation: (a) downsampling happens once at stop (measured trivially cheap with raw PCM in hand) instead of incrementally; (b) cloud upload stays WAV — Opus upload would break the server's WAV-header duration validation that billing relies on; noted as future work.

- [ ] **Step 3: Update spec deviations + commit docs**

```bash
git add docs/superpowers/specs/2026-06-12-dictation-latency-design.md
git commit -m "docs: record implementation deviations in latency spec"
```
