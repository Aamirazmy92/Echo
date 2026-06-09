-- Echo Pro billing schema.
--
-- Apply this AFTER `schema.sql` in the Supabase SQL editor. Idempotent —
-- re-running on an existing project is safe.
--
-- Adds:
--   * subscriptions    — one row per user, mirrors current Stripe state.
--                        Service role (webhook) writes; users read their
--                        own row only.
--   * admin_entitlements — internal developer/admin grants for lifetime
--                        Pro cloud access. Service role/admin SQL writes;
--                        desktop users never read it directly.
--   * usage_events     — append-only log of cloud calls; powers fair-use
--                        metering. Service role writes; users read their
--                        own rows.
--   * usage_monthly    — convenience view rolling usage_events up to
--                        the current Stripe billing month.
--   * public.entitlements()   — RPC the desktop app calls to find out
--                        what the signed-in user can access.

-- ───────────────────────── subscriptions ──────────────────────────
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  status text not null default 'free'
    check (status in ('free', 'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid', 'paused')),
  plan text
    check (plan is null or plan in ('pro_monthly', 'pro_yearly')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_end timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_status_idx
  on public.subscriptions (status);
create index if not exists subscriptions_customer_idx
  on public.subscriptions (stripe_customer_id);

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ─────────────────────── admin_entitlements ───────────────────────
create table if not exists public.admin_entitlements (
  user_id uuid primary key references auth.users on delete cascade,
  role text not null default 'developer'
    check (role in ('developer', 'admin')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_entitlements_role_idx
  on public.admin_entitlements (role);

drop trigger if exists admin_entitlements_set_updated_at on public.admin_entitlements;
create trigger admin_entitlements_set_updated_at
  before update on public.admin_entitlements
  for each row execute function public.set_updated_at();

-- Grant yourself lifetime Pro cloud access:
-- insert into public.admin_entitlements (user_id, role, note)
-- select id, 'developer', 'Aamir developer account'
-- from auth.users
-- where email = 'you@example.com'
-- on conflict (user_id) do update set role = excluded.role, note = excluded.note;

-- ───────────────────────── usage_events ───────────────────────────
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('transcribe', 'cleanup')),
  audio_seconds integer,
  tokens_in     integer,
  tokens_out    integer,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_user_kind_created_idx
  on public.usage_events (user_id, kind, created_at desc);

-- Rolling 30-day usage view. We use 30d sliding window rather than the
-- exact Stripe billing period to keep the RPC simple — the fair-use cap
-- is a soft guard, not a hard meter the user pays against.
create or replace view public.usage_monthly as
  select
    user_id,
    coalesce(sum(case when kind = 'transcribe' then audio_seconds end), 0)::bigint as audio_seconds_30d,
    count(*) filter (where kind = 'transcribe')::bigint as transcribe_calls_30d,
    count(*) filter (where kind = 'cleanup')::bigint    as cleanup_calls_30d
  from public.usage_events
  where created_at > now() - interval '30 days'
  group by user_id;

-- ─────────────────────────── RLS ──────────────────────────────────
alter table public.subscriptions enable row level security;
alter table public.admin_entitlements enable row level security;
alter table public.usage_events  enable row level security;

drop policy if exists subscriptions_self_select on public.subscriptions;
create policy subscriptions_self_select
  on public.subscriptions for select using (auth.uid() = user_id);

-- No insert/update policies for `authenticated` — only the service role
-- (used by the stripe-webhook function) ever writes to this table.
-- No policies for admin_entitlements: users cannot read/write internal
-- grants directly. The security-definer entitlements RPC reads only the
-- caller's own grant.

drop policy if exists usage_events_self_select on public.usage_events;
create policy usage_events_self_select
  on public.usage_events for select using (auth.uid() = user_id);

-- ───────────────────────── entitlements RPC ───────────────────────
-- Single source of truth the desktop client calls. Returns a JSON
-- object describing the caller's plan, status, and remaining fair-use
-- budget. `security definer` so it can read subscriptions even when
-- the caller's RLS would otherwise hide other users' rows (we still
-- only ever read the caller's own row).
--
-- FAIR_USE_AUDIO_SECONDS = 50 hours/30 days = 180_000 seconds.
create or replace function public.entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  fair_use_cap constant bigint := 50 * 60 * 60;  -- 50 hours in seconds
  admin_grant record;
  sub record;
  used bigint;
  remaining bigint;
  is_pro boolean;
begin
  if uid is null then
    return jsonb_build_object('tier', 'anonymous');
  end if;

  select * into admin_grant
    from public.admin_entitlements
    where user_id = uid;

  if admin_grant.user_id is not null then
    return jsonb_build_object(
      'tier',                  'pro',
      'status',                admin_grant.role,
      'plan',                  null,
      'currentPeriodEnd',      null,
      'cancelAtPeriodEnd',     false,
      'trialEnd',              null,
      'fairUseCapSeconds',     0,
      'fairUseUsedSeconds',    0,
      'fairUseRemainingSeconds', 0,
      'fairUseExceeded',       false
    );
  end if;

  select * into sub
    from public.subscriptions
    where user_id = uid;

  is_pro := sub.status in ('active', 'trialing');

  select coalesce(audio_seconds_30d, 0) into used
    from public.usage_monthly
    where user_id = uid;
  used := coalesce(used, 0);
  remaining := greatest(fair_use_cap - used, 0);

  return jsonb_build_object(
    'tier',                  case when is_pro then 'pro' else 'free' end,
    'status',                coalesce(sub.status, 'free'),
    'plan',                  sub.plan,
    'currentPeriodEnd',      sub.current_period_end,
    'cancelAtPeriodEnd',     coalesce(sub.cancel_at_period_end, false),
    'trialEnd',              sub.trial_end,
    'fairUseCapSeconds',     fair_use_cap,
    'fairUseUsedSeconds',    used,
    'fairUseRemainingSeconds', remaining,
    'fairUseExceeded',       is_pro and used >= fair_use_cap
  );
end;
$$;

revoke all on function public.entitlements() from public;
grant  execute on function public.entitlements() to authenticated;
