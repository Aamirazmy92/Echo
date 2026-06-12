// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// POST /functions/v1/transcribe
//
// Multipart form body with:
//   file:           audio file (wav/m4a/webm/etc)
//   language:       optional BCP-47 code, '' for auto
//   duration_ms:    optional client-reported duration (number)
//
// Auth: Supabase access token. Pro entitlement required. Forwards to
// Groq Whisper using a server-side key and returns the JSON Groq returns
// to the client. Logs usage_events on success.

import { requireUser, HttpError } from '../_shared/auth.ts';
import { handleCorsPreflight, jsonResponse, corsHeaders } from '../_shared/cors.ts';
import { getEntitlements, requirePro, logUsage } from '../_shared/entitlements.ts';
import { resolveGroqApiKey } from '../_shared/groq.ts';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = Deno.env.get('GROQ_TRANSCRIBE_MODEL') ?? 'whisper-large-v3-turbo';
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 15 * 60;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

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

function getContentLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function getWavDurationSeconds(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') return null;

  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > view.byteLength) return null;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      byteRate = view.getUint32(chunkDataOffset + 8, true);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || byteRate <= 0 || dataBytes === null) return null;
  return dataBytes / byteRate;
}

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const contentLength = getContentLength(req);
    if (contentLength !== null && contentLength > MAX_AUDIO_BYTES + 4096) {
      throw new HttpError(413, 'audio_too_large', 'Audio upload is too large.');
    }

    const { user, client, admin } = await requireUser(req);

    // Authenticate the entitlement check against the caller's JWT-aware
    // client so RLS still applies for the rpc; admin client used only
    // for the post-call usage write.
    const ent = await getEntitlements(client);
    const gate = requirePro(ent);
    if (!gate.ok) {
      console.warn('[transcribe] entitlement gate denied', user.id, gate.code);
      return jsonResponse({ error: gate.code, message: gate.message }, { status: gate.status });
    }
    const groqApiKey = resolveGroqApiKey(user, ent, 'transcribe');

    const inbound = await req.formData();
    const audio = inbound.get('file');
    if (!(audio instanceof File) && !(audio instanceof Blob)) {
      throw new HttpError(400, 'missing_file', 'multipart "file" field is required.');
    }
    if (audio.size <= 0) {
      throw new HttpError(400, 'empty_audio', 'Audio upload is empty.');
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      throw new HttpError(413, 'audio_too_large', 'Audio upload is too large.');
    }

    const audioBuffer = await audio.arrayBuffer();
    const derivedSeconds = getWavDurationSeconds(audioBuffer);
    if (derivedSeconds === null) {
      throw new HttpError(400, 'unsupported_audio', 'Echo cloud transcription expects a WAV upload.');
    }
    if (derivedSeconds <= 0 || derivedSeconds > MAX_AUDIO_SECONDS) {
      throw new HttpError(413, 'audio_duration_invalid', `Audio must be between 1 second and ${MAX_AUDIO_SECONDS} seconds.`);
    }
    const audioSeconds = Math.max(1, Math.ceil(derivedSeconds));
    if (ent.fairUseRemainingSeconds > 0 && audioSeconds > ent.fairUseRemainingSeconds) {
      return jsonResponse(
        { error: 'fair_use_remaining_too_low', message: 'This recording exceeds your remaining Pro fair-use allowance.' },
        { status: 429 },
      );
    }

    const languageValue = inbound.get('language');
    const language = typeof languageValue === 'string' ? languageValue.trim() : '';
    if (language && language !== 'auto' && !LANGUAGE_PATTERN.test(language)) {
      throw new HttpError(400, 'invalid_language', 'Invalid language code.');
    }

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

    const groqForm = new FormData();
    const fileName = audio instanceof File && audio.name ? audio.name : 'audio.wav';
    groqForm.append('file', new File([audioBuffer], fileName, { type: audio.type || 'audio/wav' }));
    groqForm.append('model', GROQ_MODEL);
    groqForm.append('response_format', 'verbose_json');
    if (language && language !== 'auto') groqForm.append('language', language);
    groqForm.append('temperature', '0');

    const groqRes = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}` },
      body: groqForm,
    });

    const text = await groqRes.text();
    if (!groqRes.ok) {
      console.warn('[transcribe] groq error', groqRes.status, text);
      return new Response(text, {
        status: groqRes.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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

    // Best-effort usage log; never block response on logging failure.
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
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[transcribe] failed', err);
    return jsonResponse(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
