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

    // Best-effort usage log; never block response on logging failure.
    logUsage(admin, user.id, 'transcribe', { audioSeconds }).catch((err) => {
      console.warn('[transcribe] usage log failed', err);
    });
    console.info('[transcribe] completed', user.id, audioSeconds);

    return new Response(text, {
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
