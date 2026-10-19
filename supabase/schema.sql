-- ============================================================
-- PDF Wizard — full schema. Run this in the Supabase SQL editor.
-- Safe to run more than once. Projects created from an earlier version can
-- run it again, or just supabase/migrations/*.sql.
-- ============================================================

-- ---------- Tables ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  -- Informational; access comes from the columns below (see own_plan()).
  plan text not null default 'free' check (plan in ('free', 'pro', 'team')),
  -- Paystack subscription (card, renews monthly)
  subscription_plan text check (subscription_plan in ('pro', 'team')),
  subscription_status text
    check (subscription_status in ('active', 'non-renewing', 'attention', 'cancelled', 'complete')),
  current_period_end timestamptz,
  -- Prepaid once-off purchase
  prepaid_plan text check (prepaid_plan in ('pro', 'team')),
  paid_until timestamptz,
  paystack_customer_code text unique,
  paystack_subscription_code text unique,
  paystack_email_token text,
  created_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  storage_path text not null,
  size_bytes bigint not null default 0,
  page_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_owner_idx on public.documents (owner_id);

-- ---------- Row Level Security ----------

alter table public.profiles enable row level security;
alter table public.documents enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

-- ---------- updated_at trigger ----------

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ---------- Storage bucket ----------
-- Private bucket; files are namespaced under the owner's user id.

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- ---------- profiles: billing columns (upgrades older projects) ----------

alter table public.profiles
  add column if not exists subscription_plan text
    check (subscription_plan in ('pro', 'team')),
  add column if not exists subscription_status text
    check (subscription_status in ('active', 'non-renewing', 'attention', 'cancelled', 'complete')),
  add column if not exists current_period_end timestamptz,
  add column if not exists prepaid_plan text
    check (prepaid_plan in ('pro', 'team')),
  add column if not exists paid_until timestamptz,
  add column if not exists paystack_customer_code text unique,
  add column if not exists paystack_subscription_code text unique,
  add column if not exists paystack_email_token text;

create index if not exists profiles_email_idx on public.profiles (lower(email));

comment on column public.profiles.plan is
  'Last plan bought. Informational only: access is resolved from the subscription and prepaid columns at read time.';

-- Any plan granted by the old client-writable column was never paid for.
update public.profiles
   set plan = 'free'
 where plan <> 'free'
   and subscription_plan is null
   and prepaid_plan is null;

-- ---------- Old billing columns from before Paystack (dropped only when unused) ----------

do $$
declare
  in_use boolean;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles'
                and column_name = 'stripe_customer_id') then
    execute 'select exists (select 1 from public.profiles where stripe_customer_id is not null)'
      into in_use;
    if not in_use then
      execute 'alter table public.profiles drop column stripe_customer_id';
    end if;
  end if;

  if to_regclass('public.subscriptions') is not null then
    execute 'select exists (select 1 from public.subscriptions)' into in_use;
    if not in_use then
      execute 'drop table public.subscriptions';
    end if;
  end if;
end $$;

-- ---------- profiles: who may write what ----------

-- Column privileges: the browser may only create its own row and edit its
-- name. Everything else is written with the service role on the server.
revoke insert, update, delete, truncate, references, trigger on public.profiles from anon, authenticated;
grant insert (id, full_name) on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Belt and braces: whatever a browser sends, a row it creates starts on Free
-- with the account's real email, and it can never change billing columns.
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.plan := 'free';
    new.email := (select u.email from auth.users u where u.id = new.id);
    new.created_at := now();
    new.subscription_plan := null;
    new.subscription_status := null;
    new.current_period_end := null;
    new.prepaid_plan := null;
    new.paid_until := null;
    new.paystack_customer_code := null;
    new.paystack_subscription_code := null;
    new.paystack_email_token := null;
  else
    new.id := old.id;
    new.email := old.email;
    new.created_at := old.created_at;
    new.plan := old.plan;
    new.subscription_plan := old.subscription_plan;
    new.subscription_status := old.subscription_status;
    new.current_period_end := old.current_period_end;
    new.prepaid_plan := old.prepaid_plan;
    new.paid_until := old.paid_until;
    new.paystack_customer_code := old.paystack_customer_code;
    new.paystack_subscription_code := old.paystack_subscription_code;
    new.paystack_email_token := old.paystack_email_token;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_guard();

-- Create the profile when the account is created, and keep its email in step
-- with the account (webhooks match Paystack customers by email).
create or replace function public.handle_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.profiles (id, email, full_name)
    values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
    on conflict (id) do nothing;
  elsif new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user();

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_auth_user();

update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id and p.email is distinct from u.email;

-- ---------- Webhook idempotency ----------

create table if not exists public.billing_events (
  id text primary key,
  type text not null,
  created_at timestamptz not null default now()
);

alter table public.billing_events enable row level security;
revoke all on public.billing_events from anon, authenticated;
-- No policies: only the service role reads or writes it.

-- ---------- Team seats ----------

create table if not exists public.team_members (
  owner_id uuid not null references auth.users (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 254),
  created_at timestamptz not null default now(),
  primary key (owner_id, email)
);

create index if not exists team_members_email_idx on public.team_members (email);

alter table public.team_members enable row level security;
revoke all on public.team_members from anon, authenticated;
grant select on public.team_members to authenticated;

-- Owners can see their own list. Changes go through the server, which checks
-- the owner is on an active Team plan.
drop policy if exists "team_members_select_own" on public.team_members;
create policy "team_members_select_own" on public.team_members
  for select to authenticated using (auth.uid() = owner_id);

-- Team = the owner + 4 members, whoever inserts.
create or replace function public.team_members_limit()
returns trigger language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('team_members:' || new.owner_id::text));
  if (select count(*) from public.team_members where owner_id = new.owner_id) >= 4 then
    raise exception 'All team seats are taken.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists team_members_limit on public.team_members;
create trigger team_members_limit
  before insert on public.team_members
  for each row execute function public.team_members_limit();

-- ---------- Tester access codes ----------

-- Free Pro or Team time for chosen testers. The owner makes, lists and
-- revokes codes in the Supabase SQL editor (create_tester_code,
-- list_tester_codes, revoke_tester_code); the server redeems them for a
-- signed-in user (redeem_tester_code, service role only). Browsers can't
-- read a code or call any of these, and only a SHA-256 of each code is kept.
-- Tester time lives in its own table: subscriptions and prepaid terms are
-- never touched.

-- gen_random_bytes() for new codes. Supabase keeps pgcrypto in "extensions".
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create schema if not exists extensions;
    create extension pgcrypto with schema extensions;
  end if;
end $$;

create table if not exists public.access_codes (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 (hex) of the code in canonical form (tester_code_hash). Never the code.
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  plan text not null check (plan in ('pro', 'team')),
  -- Tester time each redemption gives.
  days integer not null check (days between 1 and 365),
  max_uses integer not null default 1 check (max_uses >= 1),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  -- The code can't be redeemed after this (access already given runs on).
  expires_at timestamptz not null,
  -- Who it's for.
  note text check (length(note) <= 200),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Who redeemed which code: once per person per code.
create table if not exists public.access_code_redemptions (
  code_id uuid not null references public.access_codes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (code_id, user_id)
);

create index if not exists access_code_redemptions_user_idx on public.access_code_redemptions (user_id);

-- Tester time per user. own_plan() counts it while `until` is in the future.
create table if not exists public.tester_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null check (plan in ('pro', 'team')),
  until timestamptz not null,
  -- The code redeemed last.
  code_id uuid references public.access_codes (id) on delete set null,
  granted_at timestamptz not null default now()
);

alter table public.access_codes enable row level security;
alter table public.access_code_redemptions enable row level security;
alter table public.tester_access enable row level security;

-- No policies on the code tables: browsers get nothing. A signed-in user may
-- read their own tester_access row (the app shows the end date); only the
-- functions below write it.
revoke all on public.access_codes from public, anon, authenticated;
revoke all on public.access_code_redemptions from public, anon, authenticated;
revoke all on public.tester_access from public, anon, authenticated;
grant select on public.tester_access to authenticated;

drop policy if exists "tester_access_select_own" on public.tester_access;
create policy "tester_access_select_own" on public.tester_access
  for select to authenticated using (auth.uid() = user_id);

-- A code as typed or pasted: letters and digits only, upper case. Same rule
-- as normalizeTesterCode() in lib/tester-access.ts.
create or replace function public.tester_code_normalize(code text)
returns text language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(code, ''), '[^0-9A-Za-z]', '', 'g'));
$$;

-- What is stored for a code: SHA-256 (hex) of its canonical form.
create or replace function public.tester_code_hash(code text)
returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(public.tester_code_normalize(code), 'UTF8')), 'hex');
$$;

-- Owner, in the SQL editor:  select * from create_tester_code(note => 'Thabo');
-- Returns the code and its link once; only the hash is kept. Codes are
-- XXXX-XXXX-XXXX-XXXX from 32 symbols without 0, O, 1 or I: 80 random bits.
create or replace function public.create_tester_code(
  plan text default 'pro',
  days integer default 30,
  max_uses integer default 1,
  note text default null,
  code_valid_days integer default 30,
  site_url text default null
)
returns table (code text, link text, ref text, gives text, uses_allowed integer, redeem_by timestamptz)
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bits bit(80);
  v_raw text;
  v_code text;
  v_id uuid;
  v_expires timestamptz;
  v_site text;
begin
  if create_tester_code.plan is null or create_tester_code.plan not in ('pro', 'team') then
    raise exception 'plan must be ''pro'' or ''team''' using errcode = '22023';
  end if;
  if create_tester_code.days is null or create_tester_code.days not between 1 and 365 then
    raise exception 'days must be from 1 to 365' using errcode = '22023';
  end if;
  if create_tester_code.max_uses is null or create_tester_code.max_uses < 1 then
    raise exception 'max_uses must be at least 1' using errcode = '22023';
  end if;
  if create_tester_code.code_valid_days is null or create_tester_code.code_valid_days not between 1 and 365 then
    raise exception 'code_valid_days must be from 1 to 365' using errcode = '22023';
  end if;
  if length(create_tester_code.note) > 200 then
    raise exception 'note can be up to 200 characters' using errcode = '22023';
  end if;

  v_expires := now() + make_interval(days => create_tester_code.code_valid_days);
  for attempt in 1..5 loop
    v_bits := ('x' || encode(gen_random_bytes(10), 'hex'))::bit(80);
    v_raw := '';
    for i in 0..15 loop
      v_raw := v_raw || substr(alphabet, substring(v_bits from i * 5 + 1 for 5)::integer + 1, 1);
    end loop;
    v_code := concat_ws('-', substr(v_raw, 1, 4), substr(v_raw, 5, 4), substr(v_raw, 9, 4), substr(v_raw, 13, 4));
    begin
      insert into public.access_codes (code_hash, plan, days, max_uses, expires_at, note)
      values (public.tester_code_hash(v_code), create_tester_code.plan, create_tester_code.days,
              create_tester_code.max_uses, v_expires, nullif(btrim(create_tester_code.note), ''))
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_id := null; -- the same code twice: draw again
    end;
  end loop;
  if v_id is null then
    raise exception 'could not make a new code, try again';
  end if;

  v_site := rtrim(coalesce(nullif(btrim(create_tester_code.site_url), ''),
                           nullif(current_setting('app.site_url', true), ''),
                           'https://pdfwizard.xyz'), '/');
  return query select
    v_code,
    v_site || '/redeem#' || v_code,
    left(v_id::text, 8),
    initcap(create_tester_code.plan) || ' for ' || create_tester_code.days
      || case when create_tester_code.days = 1 then ' day' else ' days' end,
    create_tester_code.max_uses,
    v_expires;
end;
$$;

-- Owner, in the SQL editor:  select * from list_tester_codes();
create or replace function public.list_tester_codes()
returns table (ref text, plan text, days integer, used integer, remaining integer,
               redeem_by timestamptz, status text, note text, used_by text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select left(c.id::text, 8), c.plan, c.days, c.uses, c.max_uses - c.uses, c.expires_at,
         case when c.revoked_at is not null then 'revoked'
              when c.expires_at <= now() then 'expired'
              when c.uses >= c.max_uses then 'used up'
              else 'active' end,
         c.note,
         (select string_agg(coalesce(u.email, r.user_id::text), ', ' order by r.redeemed_at)
            from public.access_code_redemptions r
            left join auth.users u on u.id = r.user_id
           where r.code_id = c.id),
         c.created_at
    from public.access_codes c
   order by c.created_at desc;
$$;

-- Owner, in the SQL editor:  select * from revoke_tester_code('<ref>');
-- Takes the ref from list_tester_codes() (or the start of the id, or the
-- code itself). The code can't be redeemed any more; with end_access => true
-- tester access ends now for everyone who redeemed it.
create or replace function public.revoke_tester_code(code_or_ref text, end_access boolean default false)
returns table (ref text, note text, revoked_at timestamptz, access_ended integer)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_key text := lower(btrim(coalesce(code_or_ref, '')));
  v_ids uuid[] := '{}';
  v_ended integer := 0;
begin
  if v_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_ids := array(select c.id from public.access_codes c where c.id = v_key::uuid);
  elsif v_key ~ '^[0-9a-f-]{6,35}$' then
    v_ids := array(select c.id from public.access_codes c where c.id::text like v_key || '%');
  end if;
  if cardinality(v_ids) = 0 then
    v_ids := array(select c.id from public.access_codes c where c.code_hash = public.tester_code_hash(code_or_ref));
  end if;
  if cardinality(v_ids) = 0 then
    raise exception 'no code matches %', code_or_ref using errcode = 'P0002';
  end if;
  if cardinality(v_ids) > 1 then
    raise exception 'more than one code starts with %: give more of the ref', code_or_ref using errcode = '21000';
  end if;

  update public.access_codes c set revoked_at = coalesce(c.revoked_at, now()) where c.id = v_ids[1];
  if end_access then
    update public.tester_access t
       set until = now()
     where t.until > now()
       and t.user_id in (select r.user_id from public.access_code_redemptions r where r.code_id = v_ids[1]);
    get diagnostics v_ended = row_count;
  end if;

  return query select left(c.id::text, 8), c.note, c.revoked_at, v_ended
                 from public.access_codes c where c.id = v_ids[1];
end;
$$;

-- Server only (service role), for the signed-in user `uid`. Errors (P0001):
-- invalid_code (unknown or revoked: the same answer, on the same path),
-- already_redeemed, code_expired, code_used_up. The code's row is locked, so
-- two people redeeming at once can't pass max_uses. Tester time adds on to
-- time still running and never shortens it. With dry_run nothing is written:
-- it says what the code would give. Returns {"plan", "until", "days"}.
create or replace function public.redeem_tester_code(uid uuid, code text, dry_run boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_norm text := public.tester_code_normalize(code);
  v_code public.access_codes%rowtype;
  v_plan text;
  v_until timestamptz;
begin
  if uid is null then
    raise exception 'uid is required' using errcode = '22004';
  end if;
  if v_norm !~ '^[2-9A-HJ-NP-Z]{16}$' then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;

  select * into v_code
    from public.access_codes c
   where c.code_hash = public.tester_code_hash(v_norm) and c.revoked_at is null
     for update;
  if not found then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.access_code_redemptions r where r.code_id = v_code.id and r.user_id = uid) then
    raise exception 'already_redeemed' using errcode = 'P0001';
  end if;
  if v_code.expires_at <= now() then
    raise exception 'code_expired' using errcode = 'P0001';
  end if;
  if v_code.uses >= v_code.max_uses then
    raise exception 'code_used_up' using errcode = 'P0001';
  end if;

  if dry_run then
    select case when t.until > now() and t.plan = 'team' then 'team' else v_code.plan end,
           greatest(t.until, now()) + make_interval(days => v_code.days)
      into v_plan, v_until
      from public.tester_access t
     where t.user_id = uid;
    if not found then
      v_plan := v_code.plan;
      v_until := now() + make_interval(days => v_code.days);
    end if;
  else
    insert into public.access_code_redemptions (code_id, user_id) values (v_code.id, uid);
    update public.access_codes c set uses = c.uses + 1 where c.id = v_code.id;
    -- Worked out against the stored row, so redemptions that race add up.
    insert into public.tester_access as t (user_id, plan, until, code_id, granted_at)
    values (uid, v_code.plan, now() + make_interval(days => v_code.days), v_code.id, now())
    on conflict (user_id) do update
      set plan = case when t.until > now() and t.plan = 'team' then 'team' else excluded.plan end,
          until = greatest(t.until, now()) + make_interval(days => v_code.days),
          code_id = excluded.code_id,
          granted_at = excluded.granted_at
    returning t.plan, t.until into v_plan, v_until;
  end if;

  return jsonb_build_object('plan', v_plan, 'until', v_until, 'days', v_code.days);
end;
$$;

revoke execute on function public.tester_code_normalize(text) from public, anon, authenticated;
revoke execute on function public.tester_code_hash(text) from public, anon, authenticated;
revoke execute on function public.create_tester_code(text, integer, integer, text, integer, text) from public, anon, authenticated;
revoke execute on function public.list_tester_codes() from public, anon, authenticated;
revoke execute on function public.revoke_tester_code(text, boolean) from public, anon, authenticated;
revoke execute on function public.redeem_tester_code(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.create_tester_code(text, integer, integer, text, integer, text) to service_role;
grant execute on function public.list_tester_codes() to service_role;
grant execute on function public.revoke_tester_code(text, boolean) to service_role;
grant execute on function public.redeem_tester_code(uuid, text, boolean) to service_role;

-- ---------- Plan resolution in SQL (mirrors lib/billing.ts) ----------

-- The user's own plan (not a Team seat), the highest of: an active
-- subscription (with a 3-day grace while a renewal is processed), an
-- unexpired prepaid term, and tester access that hasn't ended.
create or replace function public.own_plan(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
           when 'team' in (s, p, t) then 'team'
           when 'pro' in (s, p, t) then 'pro'
           else 'free'
         end
    from (
      select
        case when pr.subscription_plan is not null and (
               (pr.subscription_status in ('active', 'attention')
                  and pr.current_period_end + interval '3 days' > now())
               or (pr.subscription_status in ('non-renewing', 'cancelled', 'complete')
                  and pr.current_period_end > now()))
             then pr.subscription_plan end as s,
        case when pr.prepaid_plan is not null and pr.paid_until > now()
             then pr.prepaid_plan end as p,
        (select ta.plan from public.tester_access ta
          where ta.user_id = u.id and ta.until > now()) as t
        from (select uid as id) u
        left join public.profiles pr on pr.id = u.id
    ) x;
$$;

-- Own plan, or Team when a verified email is on an active Team owner's list.
create or replace function public.effective_plan(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
           when o.own = 'team' then 'team'
           when exists (
             select 1
               from auth.users u
               join public.team_members tm on tm.email = lower(u.email)
              where u.id = uid
                and u.email_confirmed_at is not null
                and tm.owner_id <> uid
                and public.own_plan(tm.owner_id) = 'team'
           ) then 'team'
           else o.own
         end
    from (select public.own_plan(uid) as own) o;
$$;

revoke execute on function public.own_plan(uuid) from public, anon, authenticated;
revoke execute on function public.effective_plan(uuid) from public, anon, authenticated;

-- ---------- documents ----------

-- Rows must point inside the owner's own storage folder.
drop policy if exists "documents_all_own" on public.documents;
create policy "documents_all_own" on public.documents
  for all to authenticated
  using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and split_part(storage_path, '/', 1) = owner_id::text
    and position('..' in storage_path) = 0
  );

-- Column privileges: visitors without a session get nothing (RLS would
-- already hide every row), and signed-in users may not truncate (RLS does not
-- apply to TRUNCATE) or move a row to another file or owner, which would
-- leave stored files outside the plan's document limit.
revoke all on public.documents from anon;
revoke all on public.documents from authenticated;
grant select, insert, delete on public.documents to authenticated;
grant update (name, size_bytes, page_count, updated_at) on public.documents to authenticated;

-- A row can only be deleted once its file is gone (the browser removes the
-- file first). Otherwise deleting rows would leave files behind, and a Free
-- account could store any number of them under its 5-document limit.
create or replace function public.documents_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.owner_id := old.owner_id;
    new.storage_path := old.storage_path;
    new.created_at := old.created_at;
    return new;
  end if;
  if exists (select 1 from storage.objects o
              where o.bucket_id = 'documents' and o.name = old.storage_path) then
    raise exception 'Delete the file before its document.' using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists documents_guard on public.documents;
create trigger documents_guard
  before update or delete on public.documents
  for each row execute function public.documents_guard();

-- The Free plan keeps 5 cloud documents of up to 50 MB; this used to be
-- enforced only in the browser. (size_bytes comes from the browser: the file
-- itself is checked again in storage, below.)
create or replace function public.documents_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('documents:' || new.owner_id::text));
  if public.effective_plan(new.owner_id) = 'free' then
    if (select count(*) from public.documents where owner_id = new.owner_id) >= 5 then
      raise exception 'The Free plan keeps 5 documents. Upgrade for more.' using errcode = 'P0001';
    end if;
    if new.size_bytes > 52428800 then
      raise exception 'Files up to 50 MB on your plan.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_limit on public.documents;
create trigger documents_limit
  before insert on public.documents
  for each row execute function public.documents_limit();

-- ---------- Storage ----------

-- PDFs only, 500 MB at most (the Pro file limit).
update storage.buckets
   set file_size_limit = 524288000,
       allowed_mime_types = array['application/pdf']
 where id = 'documents';

-- Free files up to 50 MB (lib/limits.ts). Storage writes the real size into
-- metadata once the file is in, and may write it as the service role, so
-- every write is checked, against the plan of the folder's owner.
create or replace function public.documents_file_size()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner text := (storage.foldername(new.name))[1];
  v_size numeric := case when jsonb_typeof(new.metadata -> 'size') = 'number'
                         then (new.metadata ->> 'size')::numeric end;
begin
  -- A file that was allowed (say, before a downgrade) can still be renamed.
  if tg_op = 'UPDATE' and (new.metadata -> 'size') is not distinct from (old.metadata -> 'size') then
    return new;
  end if;
  if new.bucket_id = 'documents' and v_size > 52428800
     and (case when v_owner ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
               then public.effective_plan(v_owner::uuid) = 'free'
               else true end) then
    raise exception 'Files up to 50 MB on your plan.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- On a project where the SQL editor's role can't add triggers to Storage's
-- table, the row check above still applies.
do $$
begin
  drop trigger if exists documents_file_size on storage.objects;
  create trigger documents_file_size
    before insert or update on storage.objects
    for each row execute function public.documents_file_size();
exception when insufficient_privilege then
  raise warning 'Could not add documents_file_size to storage.objects: %', sqlerrm;
end $$;

-- Uploads must belong to a document row the user owns, so storage can't be
-- used past the plan's document limit.
drop policy if exists "documents_storage_insert" on storage.objects;
create policy "documents_storage_insert" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.documents d
       where d.storage_path = objects.name and d.owner_id = auth.uid()
    )
  );

drop policy if exists "documents_storage_update" on storage.objects;
create policy "documents_storage_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.documents d
       where d.storage_path = objects.name and d.owner_id = auth.uid()
    )
  );

-- Reading (and signing a link to) a file needs its document row too, so a
-- file left behind without one can't be used as free hosting.
drop policy if exists "documents_storage_select" on storage.objects;
create policy "documents_storage_select" on storage.objects
  for select to authenticated using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.documents d
       where d.storage_path = objects.name and d.owner_id = auth.uid()
    )
  );

drop policy if exists "documents_storage_delete" on storage.objects;
create policy "documents_storage_delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------- Usage counters (AI answers, edits, downloads, imports) ----------

-- One row per subject, bucket and period. Subjects are "u:<user id>" or
-- "ip:<salted SHA-256>" (never a raw IP), or "site" for site-wide caps.
create table if not exists public.usage_counters (
  key text not null check (length(key) between 1 and 200),
  bucket text not null check (length(bucket) between 1 and 200),
  period text not null check (period in ('minute', 'day', 'month')),
  period_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  primary key (key, bucket, period, period_start)
);

create index if not exists usage_counters_period_start_idx on public.usage_counters (period_start);

alter table public.usage_counters enable row level security;
revoke all on public.usage_counters from public, anon, authenticated;
grant select, insert, update, delete on public.usage_counters to service_role;
-- No policies: only the server (service role, via the functions below) touches it.

-- Counts one use if the subject is under p_limit for the current UTC period.
-- Returns the uses left after this one, or -1 when the limit is reached
-- (nothing is counted then). Atomic: concurrent calls never overshoot.
create or replace function public.consume_usage(p_key text, p_bucket text, p_limit integer, p_window text default 'day')
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_start timestamptz;
  v_count integer;
begin
  if p_window is null or p_window not in ('minute', 'day', 'month') then
    raise exception 'consume_usage: unknown window %', p_window using errcode = '22023';
  end if;
  if p_limit is null or p_limit <= 0 then
    return -1;
  end if;
  v_start := date_trunc(p_window, now() at time zone 'utc') at time zone 'utc';

  insert into public.usage_counters as u (key, bucket, period, period_start, count)
  values (p_key, p_bucket, p_window, v_start, 1)
  on conflict (key, bucket, period, period_start)
    do update set count = u.count + 1 where u.count < p_limit
  returning u.count into v_count;

  if v_count is null then
    return -1;
  end if;

  -- First use this period: clear this subject's finished periods, and now
  -- and then a small batch of everyone's rows older than 40 days (guests who
  -- never came back). A month row is at most 31 days old while it counts.
  if v_count = 1 then
    delete from public.usage_counters
     where key = p_key
       and ((period = 'minute' and period_start < now() - interval '1 hour')
         or (period = 'day' and period_start < now() - interval '2 days')
         or (period = 'month' and period_start < now() - interval '40 days'));
    if random() < 0.02 then
      delete from public.usage_counters
       where ctid in (select ctid from public.usage_counters
                       where period_start < now() - interval '40 days' limit 500);
    end if;
  end if;

  return p_limit - v_count;
end;
$$;

-- Gives back one use in the current period (a request that failed).
create or replace function public.refund_usage(p_key text, p_bucket text, p_window text default 'day')
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  if p_window is null or p_window not in ('minute', 'day', 'month') then
    raise exception 'refund_usage: unknown window %', p_window using errcode = '22023';
  end if;
  update public.usage_counters
     set count = count - 1
   where key = p_key and bucket = p_bucket and period = p_window
     and period_start = date_trunc(p_window, now() at time zone 'utc') at time zone 'utc'
     and count > 0
  returning count into v_count;
  return coalesce(v_count, 0);
end;
$$;

-- Uses so far in the current period.
create or replace function public.usage_count(p_key text, p_bucket text, p_window text default 'day')
returns integer language sql stable security definer set search_path = public as $$
  select coalesce((
    select count from public.usage_counters
     where key = p_key and bucket = p_bucket and period = p_window
       and period_start = date_trunc(p_window, now() at time zone 'utc') at time zone 'utc'
  ), 0);
$$;

revoke execute on function public.consume_usage(text, text, integer, text) from public, anon, authenticated;
revoke execute on function public.refund_usage(text, text, text) from public, anon, authenticated;
revoke execute on function public.usage_count(text, text, text) from public, anon, authenticated;
grant execute on function public.consume_usage(text, text, integer, text) to service_role;
grant execute on function public.refund_usage(text, text, text) to service_role;
grant execute on function public.usage_count(text, text, text) to service_role;
