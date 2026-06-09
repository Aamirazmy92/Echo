// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// Server-side entitlement checks shared by the transcribe and cleanup
// proxy functions. Calls the public.entitlements() RPC under the
// caller's identity so RLS still applies.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export type EntitlementTier = 'anonymous' | 'free' | 'pro';

export interface Entitlements {
  tier: EntitlementTier;
  status: string;
  plan: string | null;
  fairUseExceeded: boolean;
  fairUseRemainingSeconds: number;
}

export async function getEntitlements(client: SupabaseClient): Promise<Entitlements> {
  const { data, error } = await client.rpc('entitlements');
  if (error) throw new Error(`entitlements rpc failed: ${error.message}`);
  if (!data || typeof data !== 'object') throw new Error('entitlements rpc returned no data');
  return data as Entitlements;
}

export function requirePro(ent: Entitlements): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (ent.tier !== 'pro') {
    return {
      ok: false,
      status: 402,
      code: 'upgrade_required',
      message: 'Echo Pro is required for cloud features. Upgrade in the desktop app.',
    };
  }
  if (ent.fairUseExceeded) {
    return {
      ok: false,
      status: 429,
      code: 'fair_use_exceeded',
      message: 'You have hit the Pro fair-use cap for this 30-day window. Try again later or contact support.',
    };
  }
  return { ok: true };
}

export async function logUsage(
  admin: SupabaseClient,
  userId: string,
  kind: 'transcribe' | 'cleanup',
  payload: { audioSeconds?: number; tokensIn?: number; tokensOut?: number },
): Promise<void> {
  await admin.from('usage_events').insert({
    user_id: userId,
    kind,
    audio_seconds: payload.audioSeconds ?? null,
    tokens_in:     payload.tokensIn     ?? null,
    tokens_out:    payload.tokensOut    ?? null,
  });
}
