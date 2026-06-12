// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// POST /functions/v1/cleanup
//
// Body (JSON):
//   {
//     model:        e.g. "llama-3.1-8b-instant"
//     systemPrompt: string,
//     userPrompt:   string,
//     temperature:  number (0..1)
//     maxTokens:    number
//   }
//
// Auth: Supabase access token. Pro entitlement required. Forwards to
// Groq /v1/chat/completions using a server-side key and returns the raw
// Groq JSON. Logs token usage on success.

import { requireUser, HttpError } from '../_shared/auth.ts';
import { handleCorsPreflight, jsonResponse, corsHeaders } from '../_shared/cors.ts';
import { getEntitlements, requirePro, logUsage } from '../_shared/entitlements.ts';
import { resolveGroqApiKey } from '../_shared/groq.ts';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const ALLOWED_MODELS = new Set([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
]);
const MAX_SYSTEM_PROMPT_CHARS = 8_000;
const MAX_USER_PROMPT_CHARS = 24_000;
const MAX_TOKENS = 2_048;
const MAX_CLEANUP_CALLS_WHEN_REMAINING_ZERO = 0;

interface CleanupRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const { user, client, admin } = await requireUser(req);

    const ent = await getEntitlements(client);
    const gate = requirePro(ent);
    if (!gate.ok) {
      console.warn('[cleanup] entitlement gate denied', user.id, gate.code);
      return jsonResponse({ error: gate.code, message: gate.message }, { status: gate.status });
    }
    const groqApiKey = resolveGroqApiKey(user, ent, 'cleanup');

    const body = await req.json() as Partial<CleanupRequest>;
    if (typeof body.systemPrompt !== 'string' || typeof body.userPrompt !== 'string') {
      throw new HttpError(400, 'missing_prompts', 'systemPrompt and userPrompt are required.');
    }
    if (body.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS || body.userPrompt.length > MAX_USER_PROMPT_CHARS) {
      throw new HttpError(413, 'prompt_too_large', 'Cleanup prompt is too large.');
    }

    const model = typeof body.model === 'string' && ALLOWED_MODELS.has(body.model)
      ? body.model
      : DEFAULT_MODEL;
    const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature)
      ? Math.min(1, Math.max(0, body.temperature))
      : 0.1;
    const maxTokens = typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens)
      ? Math.min(MAX_TOKENS, Math.max(1, Math.trunc(body.maxTokens)))
      : 1024;
    if (ent.fairUseRemainingSeconds === MAX_CLEANUP_CALLS_WHEN_REMAINING_ZERO && ent.status !== 'developer' && ent.status !== 'admin') {
      return jsonResponse(
        { error: 'fair_use_exceeded', message: 'You have hit the Pro fair-use cap for this 30-day window.' },
        { status: 429 },
      );
    }

    const groqRes = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: body.systemPrompt },
          { role: 'user',   content: body.userPrompt },
        ],
      }),
    });

    const responseText = await groqRes.text();
    if (!groqRes.ok) {
      console.warn('[cleanup] groq error', groqRes.status, responseText);
      return new Response(responseText, {
        status: groqRes.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Pull token counts from the Groq response if present so usage_events
    // captures something useful even though cleanup doesn't have audio.
    let tokensIn  = 0;
    let tokensOut = 0;
    try {
      const parsed = JSON.parse(responseText) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      tokensIn  = parsed.usage?.prompt_tokens     ?? 0;
      tokensOut = parsed.usage?.completion_tokens ?? 0;
    } catch {
      // ignore — still log a row with zeros so we know the call happened.
    }
    logUsage(admin, user.id, 'cleanup', { tokensIn, tokensOut }).catch((err) => {
      console.warn('[cleanup] usage log failed', err);
    });
    console.info('[cleanup] completed', user.id, tokensIn, tokensOut);

    return new Response(responseText, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[cleanup] failed', err);
    return jsonResponse(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
