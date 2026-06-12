// Thin client that calls our Supabase Edge Functions with the
// signed-in user's access token. Used for the Pro cloud proxy
// (transcribe, cleanup, billing endpoints).
//
// Why: the desktop app must NOT talk to Groq directly. Cloud routes
// through our backend so a single server-side GROQ_API_KEY can serve
// entitled users, with usage metering and entitlement gating.

import { ensureCurrentSession, getCurrentSession } from './auth';
import { logWarn } from './logger';

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const SUPABASE_URL = viteEnv.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';

export class CloudHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudHttpError';
  }
}

export function isCloudConfigured(): boolean {
  return !!SUPABASE_URL;
}

/**
 * The user is "cloud-eligible" when they're signed in. The actual
 * Pro/Free gating happens server-side in the entitlements RPC, but we
 * still need an access token to even call the proxy.
 */
export function hasCloudSession(): boolean {
  return !!getCurrentSession()?.access_token;
}

function functionsBaseUrl(): string {
  // Strips trailing slashes so we don't accidentally produce double slashes.
  return SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1';
}

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

async function call<TResult>(
  path: string,
  init: { method?: 'POST' | 'GET'; body?: BodyInit | null; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<TResult> {
  if (!isCloudConfigured()) {
    throw new CloudHttpError(0, 'not_configured', 'Cloud sync is not configured in this build.');
  }
  const session = getCurrentSession() ?? await ensureCurrentSession();
  if (!session?.access_token) {
    throw new CloudHttpError(401, 'not_signed_in', 'Sign in to use Echo cloud.');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.access_token}`,
    ...(init.headers ?? {}),
  };

  const res = await fetch(`${functionsBaseUrl()}${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body ?? null,
    signal: init.signal,
  });

  // Functions return JSON for the common cases. Read once as text and
  // parse here so the caller doesn't have to clone the response.
  const responseText = await res.text();
  let parsed: unknown = null;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    // Non-JSON bodies (e.g. truncated proxy errors) — fall through.
  }

  if (!res.ok) {
    const code = (parsed as { error?: string })?.error ?? `http_${res.status}`;
    const message = (parsed as { message?: string })?.message ?? responseText ?? `Cloud request failed (${res.status})`;
    throw new CloudHttpError(res.status, code, message);
  }

  return parsed as TResult;
}

// ─────────────────── Billing ──────────────────────────────────────

export async function startCheckout(plan: 'pro_monthly' | 'pro_yearly'): Promise<string> {
  const result = await call<{ url: string }>('/stripe-create-checkout', {
    body: JSON.stringify({ plan }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!result?.url) {
    throw new CloudHttpError(500, 'no_url', 'Checkout did not return a URL.');
  }
  return result.url;
}

export async function openCustomerPortal(): Promise<string> {
  const result = await call<{ url: string }>('/stripe-create-portal', {
    method: 'POST',
  });
  if (!result?.url) {
    throw new CloudHttpError(500, 'no_url', 'Portal did not return a URL.');
  }
  return result.url;
}

// ─────────────────── Cloud Groq proxy ─────────────────────────────

export interface ProxyTranscribeResult {
  text?: string;
  language?: string;
}

export async function proxyTranscribe(args: {
  wavBuffer: Buffer;
  language: string;
  durationMs: number;
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

  return call<ProxyTranscribeResult>('/transcribe', {
    body: form,
    signal: args.signal,
  });
}

export interface ProxyCleanupResult {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function proxyCleanup(args: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<ProxyCleanupResult> {
  return call<ProxyCleanupResult>('/cleanup', {
    body: JSON.stringify({
      model: args.model,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
    }),
    headers: { 'Content-Type': 'application/json' },
    signal: args.signal,
  });
}

// ─────────────────── Entitlements ─────────────────────────────────

export interface RawEntitlementsRpcResult {
  tier: 'anonymous' | 'free' | 'pro';
  status: string;
  plan: 'pro_monthly' | 'pro_yearly' | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  fairUseCapSeconds: number;
  fairUseUsedSeconds: number;
  fairUseRemainingSeconds: number;
  fairUseExceeded: boolean;
}

/**
 * Fetches the public.entitlements() RPC via Supabase REST. We don't
 * use the SDK here so we stay in our `cloud.ts` boundary — auth.ts
 * already owns the SDK client and we don't want a second one.
 */
export async function fetchEntitlements(): Promise<RawEntitlementsRpcResult> {
  if (!isCloudConfigured()) {
    throw new CloudHttpError(0, 'not_configured', 'Cloud sync is not configured.');
  }
  const session = getCurrentSession() ?? await ensureCurrentSession();
  if (!session?.access_token) {
    throw new CloudHttpError(401, 'not_signed_in', 'Sign in to load entitlements.');
  }
  const apikey = viteEnv.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';

  const res = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/entitlements`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  const responseText = await res.text();
  if (!res.ok) {
    logWarn('cloud', `entitlements rpc failed (${res.status})`, responseText);
    throw new CloudHttpError(res.status, 'entitlements_failed', responseText || 'Failed to load entitlements.');
  }
  return JSON.parse(responseText) as RawEntitlementsRpcResult;
}
