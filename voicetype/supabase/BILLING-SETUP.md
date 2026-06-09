# Echo Pro — Stripe billing & cloud proxy setup

This document walks through wiring up the **Pro subscription** + **Groq cloud proxy** that lives in `supabase/billing.sql` and `supabase/functions/`.

You only need to do this once per Supabase project. Total time ~30 minutes.

---

## 1. Apply the billing schema

1. In Supabase Dashboard: **SQL Editor → New query**.
2. Paste the entire contents of `supabase/billing.sql`.
3. Run. You should see `Success. No rows returned.`.

Re-running is safe.

---

## 2. Stripe products

In the Stripe Dashboard (start in **test mode**):

1. **Products → + Add product**.
   - Name: `Echo Pro`
   - Pricing: `Recurring`
2. Add **two prices**:
   - **Monthly** — e.g. $9.00 USD / month → copy the price id (`price_…`).
   - **Yearly**  — e.g. $79.00 USD / year → copy the price id.
3. **Settings → Billing → Customer portal**: turn it on, allow plan switching, payment method updates, cancellation. Save.

---

## 3. Stripe webhook endpoint

1. **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook`.
3. Listen to events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.payment_succeeded`
4. Copy the **Signing secret** (`whsec_…`).

---

## 4. Edge Function secrets

Install the Supabase CLI if you haven't:

```powershell
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>
```

Set the function secrets (these never ship to clients):

```powershell
supabase secrets set `
  STRIPE_SECRET_KEY=sk_test_xxx `
  STRIPE_WEBHOOK_SECRET=whsec_xxx `
  STRIPE_PRICE_PRO_MONTHLY=price_xxx_monthly `
  STRIPE_PRICE_PRO_YEARLY=price_xxx_yearly `
  GROQ_API_KEY=gsk_xxx `
  ECHO_BILLING_SUCCESS_URL=echo://billing/success `
  ECHO_BILLING_CANCEL_URL=echo://billing/cancel `
  ECHO_BILLING_PORTAL_RETURN_URL=echo://billing/return
```

> The `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` env vars are auto-injected into Edge Functions; you do **not** need to set them manually.

Optional: developer/admin accounts can use their own server-side Groq keys
instead of the shared `GROQ_API_KEY`. Map either the Supabase user id or the
lowercase email to a key:

```powershell
supabase secrets set `
  GROQ_DEVELOPER_KEYS_JSON='{"aamirazmy92@gmail.com":"gsk_developer_xxx","00000000-0000-0000-0000-000000000000":"gsk_other_dev_xxx"}'
```

Only users whose `public.entitlements()` status is `developer` or `admin` can
use this map. Normal Pro users always use the default `GROQ_API_KEY`, and the
desktop app never sees any Groq key.

---

## 5. Deploy the functions

From `voicetype/`:

```powershell
supabase functions deploy stripe-create-checkout
supabase functions deploy stripe-create-portal
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy transcribe
supabase functions deploy cleanup
```

Notes:

- `stripe-webhook` uses `--no-verify-jwt` because Stripe doesn't send a Supabase JWT — we verify the signature inside the handler instead.
- `transcribe` and `cleanup` rely on Supabase JWT auth (default).

---

## 6. Smoke test

### Webhook
1. In Stripe → Webhooks → your endpoint → **Send test webhook** → `checkout.session.completed`. The Stripe UI should show `200`. You won't see a row in `subscriptions` for this synthetic event because there's no matching `client_reference_id`, but a 200 confirms the signature/secret are correct.

### End-to-end (after the desktop client is wired in Phase 3)
1. Click **Upgrade to Pro** → completes Stripe Checkout in test mode (`4242 4242 4242 4242`).
2. Webhook upserts the row.
3. App calls `entitlements()` → returns `{ tier: 'pro', status: 'active' }`.
4. Cloud transcription works without a Groq key in Settings.

---

## 7. Going live

When you flip Stripe to live mode:

1. Recreate the same products + prices in **live mode**.
2. Update `supabase secrets set …` with the live keys (`sk_live_…`, `whsec_live_…`, live price ids).
3. Redeploy the Edge Functions so they pick up the new secrets:
   ```powershell
   supabase functions deploy stripe-create-checkout stripe-create-portal stripe-webhook transcribe cleanup
   ```
4. Update the Stripe webhook endpoint URL to point at the live deployment (same URL, different mode toggle in the dashboard).

---

## Troubleshooting

- **Stripe webhook 400 "signature verification failed"** — secret mismatch. Re-copy `whsec_…` from Stripe → Webhooks → your endpoint and `supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_…`, then redeploy `stripe-webhook`.
- **`/transcribe` returns 402 `upgrade_required`** — entitlements RPC says the caller is not Pro. Check `select * from public.subscriptions` and confirm `status` is `active` or `trialing`.
- **`/transcribe` returns 429 `fair_use_exceeded`** — Pro is over the 50 hr/30 day soft cap. Either bump `fair_use_cap` in `billing.sql` or wait for the rolling window.
- **Function deploys but every call 500s** — check `supabase functions logs <name>` for missing env vars; most often `GROQ_API_KEY` or `STRIPE_PRICE_PRO_*`.
