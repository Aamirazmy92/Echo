-- Echo cloud sync schema.
--
-- Paste the entire file into the Supabase SQL editor (Dashboard →
-- SQL editor → New query → paste → Run) once after creating your
-- project. It's idempotent: running it again on an existing project
-- is safe.
--
-- Conventions:
--   * Every user-owned table has a `user_id uuid` foreign key into
--     `auth.users` and `on delete cascade` so deleting an account
--     wipes all their rows in one go.
--   * Every row has `updated_at` (set by trigger) and `deleted_at`
--     (soft-delete tombstone) so cross-device deletes propagate
--     instead of vanishing on next pull.
--   * Row-Level Security (RLS) policies enforce that even with a
--     leaked anon key + JWT, an attacker can only ever see / mutate
--     their own rows.

-- ───────────────────────── helper trigger ──────────────────────────
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────── profiles ───────────────────────────────
-- One row per user, mirroring auth.users with the extras we want to
-- show in the Account panel. Auto-populated on signup via a trigger.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────── settings ───────────────────────────────
-- One row per user. JSONB blob mirrors the renderer Settings type
-- (minus API keys, mic ID, window state — those stay device-local).
create table if not exists public.settings (
  user_id uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

-- ─────────────────────────── history ────────────────────────────────
create table if not exists public.history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  text text not null,
  raw_text text not null default '',
  word_count int not null default 0,
  duration_ms int not null default 0,
  app_name text,
  mode text not null default 'standard',
  method text not null default 'local',
  client_created_at timestamptz not null,
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists history_user_id_idx        on public.history (user_id);
create index if not exists history_user_updated_at_idx on public.history (user_id, updated_at desc);
drop trigger if exists history_set_updated_at on public.history;
create trigger history_set_updated_at before update on public.history
  for each row execute function public.set_updated_at();

-- ─────────────────────────── dictionary ─────────────────────────────
create table if not exists public.dictionary (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  phrase text not null,
  misspelling text,
  correct_misspelling boolean not null default false,
  shared boolean not null default false,
  client_created_at timestamptz not null,
  updated_at timestamptz default now(),
  deleted_at timestamptz,
  unique (user_id, phrase, deleted_at)
);

create index if not exists dictionary_user_id_idx        on public.dictionary (user_id);
create index if not exists dictionary_user_updated_at_idx on public.dictionary (user_id, updated_at desc);
drop trigger if exists dictionary_set_updated_at on public.dictionary;
create trigger dictionary_set_updated_at before update on public.dictionary
  for each row execute function public.set_updated_at();

-- ─────────────────────────── snippets ───────────────────────────────
create table if not exists public.snippets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  trigger text not null,
  expansion text not null,
  category text not null default '',
  shared boolean not null default false,
  client_created_at timestamptz not null,
  updated_at timestamptz default now(),
  deleted_at timestamptz,
  unique (user_id, trigger, deleted_at)
);

create index if not exists snippets_user_id_idx        on public.snippets (user_id);
create index if not exists snippets_user_updated_at_idx on public.snippets (user_id, updated_at desc);
drop trigger if exists snippets_set_updated_at on public.snippets;
create trigger snippets_set_updated_at before update on public.snippets
  for each row execute function public.set_updated_at();

-- ─────────────────────────── custom_styles ──────────────────────────
create table if not exists public.custom_styles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  prompt text not null,
  client_created_at timestamptz not null,
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

create index if not exists custom_styles_user_id_idx        on public.custom_styles (user_id);
create index if not exists custom_styles_user_updated_at_idx on public.custom_styles (user_id, updated_at desc);
drop trigger if exists custom_styles_set_updated_at on public.custom_styles;
create trigger custom_styles_set_updated_at before update on public.custom_styles
  for each row execute function public.set_updated_at();

-- ─────────────────────────── RLS ────────────────────────────────────
alter table public.profiles      enable row level security;
alter table public.settings      enable row level security;
alter table public.history       enable row level security;
alter table public.dictionary    enable row level security;
alter table public.snippets      enable row level security;
alter table public.custom_styles enable row level security;

-- Profiles: users can read & update only their own row. Inserts are
-- handled by the on_auth_user_created trigger above.
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles for select using (auth.uid() = id);
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- For all data tables: full CRUD restricted to the row owner.
do $$
declare
  t text;
begin
  for t in select unnest(array['settings','history','dictionary','snippets','custom_styles']) loop
    execute format('drop policy if exists %I_self_all on public.%I', t, t);
    execute format(
      'create policy %I_self_all on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t, t
    );
  end loop;
end$$;

-- ─────────────────── self-service account deletion ──────────────────
-- Lets a signed-in user permanently delete their own auth.users row +
-- every linked data row. The on-delete-cascade FKs on history,
-- snippets, dictionary, custom_styles, settings, profiles take care of
-- wiping the data when auth.users is deleted.
--
-- Why SECURITY DEFINER: the auth.users table is owned by `supabase_auth_admin`
-- and ordinary authenticated users can't touch it. By marking this
-- function `security definer` and having it owned by `postgres`
-- (which Supabase grants admin access), the function inherits the
-- owner's privileges. The internal `auth.uid()` check ensures users
-- can ONLY delete themselves — they can't pass an arbitrary uuid in.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
