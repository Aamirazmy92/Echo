// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// POST /functions/v1/stripe-create-portal
//
// Auth: Supabase access token.
// Returns: { url } — Stripe-hosted Customer Portal URL the desktop
// client opens via shell.openExternal.

import { requireUser, HttpError } from '../_shared/auth.ts';
import { handleCorsPreflight, jsonResponse } from '../_shared/cors.ts';
import { stripe } from '../_shared/stripe.ts';

const RETURN_URL = Deno.env.get('ECHO_BILLING_PORTAL_RETURN_URL') ?? 'echo://billing/return';

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const { user, admin } = await requireUser(req);

    const { data: sub } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      throw new HttpError(409, 'no_customer', 'No Stripe customer for this account yet. Start a checkout first.');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: RETURN_URL,
    });

    return jsonResponse({ url: session.url });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[stripe-create-portal] failed', err);
    return jsonResponse(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
