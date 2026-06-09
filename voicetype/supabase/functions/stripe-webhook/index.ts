// @ts-nocheck — Deno runtime; type-checked at deploy time, not by Node tsc.
// POST /functions/v1/stripe-webhook
//
// Stripe sends subscription lifecycle events here. We verify the
// signature, then upsert the matching row in public.subscriptions.
//
// Configure in Stripe Dashboard → Developers → Webhooks with these
// events:
//   checkout.session.completed
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.payment_failed
//   invoice.payment_succeeded

import Stripe from 'https://esm.sh/stripe@16.12.0?target=denonext';
import { adminClient } from '../_shared/auth.ts';
import { stripe, planFromPriceId } from '../_shared/stripe.ts';

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
if (!webhookSecret) console.warn('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set');

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('method_not_allowed', { status: 405 });
  }

  const signature = req.headers.get('stripe-signature') ?? '';
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed', err);
    return new Response(`Webhook Error: ${err instanceof Error ? err.message : 'unknown'}`, { status: 400 });
  }

  try {
    await handleEvent(event);
    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[stripe-webhook] handler failed', err);
    // Return 500 so Stripe retries; transient DB errors should not be
    // silently dropped.
    return new Response(`Handler Error: ${err instanceof Error ? err.message : 'unknown'}`, { status: 500 });
  }
});

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = (session.client_reference_id || session.metadata?.supabase_user_id) ?? null;
      if (!userId || !session.subscription) return;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await upsertSubscription(userId, subscription);
      return;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = await resolveUserId(subscription);
      if (!userId) return;
      await upsertSubscription(userId, subscription);
      return;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.subscription) return;
      const subscriptionId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription.id;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const userId = await resolveUserId(subscription);
      if (!userId) return;
      await upsertSubscription(userId, subscription);
      return;
    }

    case 'invoice.payment_succeeded': {
      // Reactivation after a failed-payment recovery flips the
      // subscription back to active; rerun the upsert so we mirror
      // current_period_end, status, etc.
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.subscription) return;
      const subscriptionId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription.id;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const userId = await resolveUserId(subscription);
      if (!userId) return;
      await upsertSubscription(userId, subscription);
      return;
    }

    default:
      // Unhandled events are ignored; Stripe still considers a 2xx ack.
      return;
  }
}

async function resolveUserId(subscription: Stripe.Subscription): Promise<string | null> {
  // Prefer metadata we set at checkout time …
  const metaId = (subscription.metadata?.supabase_user_id as string | undefined) ?? null;
  if (metaId) return metaId;

  // … then fall back to the existing row keyed by stripe_customer_id.
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id;
  const admin = adminClient();
  const { data } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data?.user_id ?? null;
}

async function upsertSubscription(userId: string, subscription: Stripe.Subscription): Promise<void> {
  const admin = adminClient();
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id;
  const item = subscription.items.data[0];
  const plan = planFromPriceId(item?.price?.id ?? null);

  await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      status: subscription.status as string,
      plan,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
      trial_end: subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
    },
    { onConflict: 'user_id' },
  );
}
