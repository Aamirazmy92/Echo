// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// Centralizes Stripe client construction so each function picks up the
// same secret + API version. We keep the API version pinned so a future
// upstream change can't silently break the webhook.

import Stripe from 'https://esm.sh/stripe@16.12.0?target=denonext';

const stripeSecret = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
if (!stripeSecret) console.warn('[stripe] STRIPE_SECRET_KEY is not set');

export const stripe = new Stripe(stripeSecret, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

export function getPriceIdForPlan(plan: 'pro_monthly' | 'pro_yearly'): string {
  const priceId =
    plan === 'pro_monthly'
      ? Deno.env.get('STRIPE_PRICE_PRO_MONTHLY')
      : Deno.env.get('STRIPE_PRICE_PRO_YEARLY');
  if (!priceId) {
    throw new Error(`Missing Stripe price id env var for plan ${plan}`);
  }
  return priceId;
}

export function planFromPriceId(priceId: string | null | undefined): 'pro_monthly' | 'pro_yearly' | null {
  if (!priceId) return null;
  if (priceId === Deno.env.get('STRIPE_PRICE_PRO_MONTHLY')) return 'pro_monthly';
  if (priceId === Deno.env.get('STRIPE_PRICE_PRO_YEARLY')) return 'pro_yearly';
  return null;
}
