// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// POST /functions/v1/stripe-create-checkout
//
// Body: { plan: 'pro_monthly' | 'pro_yearly' }
// Auth: Supabase access token (Authorization: Bearer ...)
//
// Returns: { url } — open this in the user's browser. On success Stripe
// redirects to ECHO_BILLING_SUCCESS_URL (default echo://billing/success);
// on cancel, ECHO_BILLING_CANCEL_URL (default echo://billing/cancel).

import { requireUser, HttpError } from '../_shared/auth.ts';
import { handleCorsPreflight, jsonResponse } from '../_shared/cors.ts';
import { stripe, getPriceIdForPlan } from '../_shared/stripe.ts';

const SUCCESS_URL = Deno.env.get('ECHO_BILLING_SUCCESS_URL') ?? 'echo://billing/success';
const CANCEL_URL  = Deno.env.get('ECHO_BILLING_CANCEL_URL')  ?? 'echo://billing/cancel';

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const { user, admin } = await requireUser(req);
    const body = await req.json().catch(() => ({})) as { plan?: string };
    if (body.plan !== 'pro_monthly' && body.plan !== 'pro_yearly') {
      throw new HttpError(400, 'invalid_plan', 'Plan must be pro_monthly or pro_yearly.');
    }
    const priceId = getPriceIdForPlan(body.plan);

    // Look up an existing Stripe customer for this user so we don't
    // create duplicates on repeat checkouts.
    const { data: existing } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    let customerId = existing?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      // Upsert so the webhook can later patch this row in place.
      await admin.from('subscriptions').upsert({
        user_id: user.id,
        stripe_customer_id: customerId,
        status: 'free',
      }, { onConflict: 'user_id' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url:  CANCEL_URL,
      allow_promotion_codes: true,
      client_reference_id: user.id,
      metadata: { supabase_user_id: user.id, plan: body.plan },
      subscription_data: {
        metadata: { supabase_user_id: user.id, plan: body.plan },
      },
    });

    if (!session.url) {
      throw new Error('Stripe did not return a checkout URL.');
    }
    return jsonResponse({ url: session.url });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.code, message: err.message }, { status: err.status });
    }
    console.error('[stripe-create-checkout] failed', err);
    return jsonResponse(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
