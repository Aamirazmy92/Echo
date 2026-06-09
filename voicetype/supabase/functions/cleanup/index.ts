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
    if (typeof body.model !== 'string' || !body.model.trim()) {
      throw new HttpError(400, 'missing_model', 'model is required.');
    }
    if (typeof body.systemPrompt !== 'string' || typeof body.userPrompt !== 'string') {
      throw new HttpError(400, 'missing_prompts', 'systemPrompt and userPrompt are required.');
    }

    const groqRes = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: body.model,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.1,
        max_tokens: typeof body.maxTokens === 'number' ? body.maxTokens : 1024,
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
