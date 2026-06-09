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

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
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
    const language = (inbound.get('language') ?? '') as string;
    const durationMsRaw = inbound.get('duration_ms');
    const durationMs = typeof durationMsRaw === 'string' ? Number(durationMsRaw) : 0;
    const audioSeconds = Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs / 1000 : 0));

    const groqForm = new FormData();
    groqForm.append('file', audio, (audio as File).name ?? 'audio.webm');
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
