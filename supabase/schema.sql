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
returns trigger language plpgsql as $$
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
returns trigger language plpgsql as $$
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

-- ---------- Plan resolution in SQL (mirrors lib/billing.ts) ----------

-- The plan a user pays for: an active subscription (with a 3-day grace while
-- a renewal is processed) or an unexpired prepaid term.
create or replace function public.own_plan(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
             when 'team' in (s, p) then 'team'
             when 'pro' in (s, p) then 'pro'
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
               then pr.prepaid_plan end as p
          from public.profiles pr
         where pr.id = uid
      ) x
  ), 'free');
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

-- The Free plan keeps 5 cloud documents; this used to be enforced only in the
-- browser.
create or replace function public.documents_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('documents:' || new.owner_id::text));
  if public.effective_plan(new.owner_id) = 'free'
     and (select count(*) from public.documents where owner_id = new.owner_id) >= 5 then
    raise exception 'The Free plan keeps 5 documents. Upgrade for more.' using errcode = 'P0001';
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

drop policy if exists "documents_storage_select" on storage.objects;
create policy "documents_storage_select" on storage.objects
  for select to authenticated using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
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
