-- ============================================================
-- Tester access codes: free Pro or Team time for chosen testers.
--
-- Safe to run more than once. Run it in the Supabase SQL editor on a project
-- created from an earlier supabase/schema.sql. (A new project only needs
-- supabase/schema.sql, which already includes everything here.)
--
-- Adds access_codes, access_code_redemptions and tester_access, the owner
-- functions create_tester_code(), list_tester_codes() and
-- revoke_tester_code() (SQL editor only), redeem_tester_code() (the server,
-- with the service role), and makes own_plan() count tester access. See
-- "Tester access" in the README for how to make and share a code.
-- ============================================================

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

-- Tester time per user, kept per plan: a Team code adds Team days only, and
-- Pro time comes after Team time. own_plan() counts Team while team_until
-- is in the future, else Pro while pro_until is.
create table if not exists public.tester_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  team_until timestamptz,
  pro_until timestamptz,
  -- The code redeemed last.
  code_id uuid references public.access_codes (id) on delete set null,
  granted_at timestamptz not null default now(),
  check (team_until is not null or pro_until is not null)
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
-- the code's plan of tester time (Pro or Team) ends now for everyone who
-- redeemed it.
create or replace function public.revoke_tester_code(code_or_ref text, end_access boolean default false)
returns table (ref text, note text, revoked_at timestamptz, access_ended integer)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_key text := lower(btrim(coalesce(code_or_ref, '')));
  v_ids uuid[] := '{}';
  v_plan text;
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

  update public.access_codes c set revoked_at = coalesce(c.revoked_at, now()) where c.id = v_ids[1]
  returning c.plan into v_plan;
  if end_access then
    update public.tester_access t
       set team_until = case when v_plan = 'team' then now() else t.team_until end,
           pro_until = case when v_plan = 'pro' then now() else t.pro_until end
     where (case when v_plan = 'team' then t.team_until else t.pro_until end) > now()
       and t.user_id in (select r.user_id from public.access_code_redemptions r where r.code_id = v_ids[1]);
    get diagnostics v_ended = row_count;
  end if;

  return query select left(c.id::text, 8), c.note, c.revoked_at, v_ended
                 from public.access_codes c where c.id = v_ids[1];
end;
$$;

-- Server only (service role), for the signed-in user `uid`. Errors (P0001):
-- invalid_code (unknown or revoked: the same answer, on the same path),
-- already_redeemed, code_expired, code_used_up, and already_covered (DETAIL:
-- the code's plan) when a renewing subscription, or a Team seat for a Pro
-- code, already gives what the code gives: the code is not used. The code's
-- row is locked, so two people redeeming at once can't pass max_uses.
--
-- Tester time is kept per plan and starts after time the user already has
-- of that plan or higher (tester time, a prepaid term, a subscription that
-- won't renew), so none of it is lost. A Team code adds Team days only, and
-- Pro tester time still to come moves back by as much. With dry_run nothing
-- is written: it says what the code would give. Returns {"plan", "days",
-- "until", "starts"}: the code's plan and days, when that time ends, and when
-- it starts (null: now).
create or replace function public.redeem_tester_code(uid uuid, code text, dry_run boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_norm text := public.tester_code_normalize(code);
  v_code public.access_codes%rowtype;
  v_prof public.profiles%rowtype;
  v_t public.tester_access%rowtype;
  v_paid_team timestamptz; -- paid Team time with an end date
  v_paid_pro timestamptz;  -- paid Pro or Team time with an end date
  v_from timestamptz;
  v_until timestamptz;
  v_team timestamptz;
  v_pro timestamptz;
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

  -- One redemption at a time per user, so codes redeemed together add up.
  if not dry_run then
    perform pg_advisory_xact_lock(hashtext('tester_access:' || uid::text));
  end if;
  select * into v_prof from public.profiles p where p.id = uid;
  select * into v_t from public.tester_access t where t.user_id = uid;

  -- What renews (or a seat in someone's Team) has no end to start after:
  -- the code would add nothing, so it isn't used.
  if (v_prof.subscription_status in ('active', 'attention')
        and v_prof.current_period_end + interval '3 days' > now()
        and v_prof.subscription_plan in ('team', v_code.plan))
     or (v_code.plan = 'pro' and exists (
           select 1
             from auth.users u
             join public.team_members tm on tm.email = lower(u.email)
            where u.id = uid
              and u.email_confirmed_at is not null
              and tm.owner_id <> uid
              and public.own_plan(tm.owner_id) = 'team')) then
    raise exception 'already_covered' using errcode = 'P0001', detail = v_code.plan;
  end if;

  -- Paid time with an end date (greatest() skips nulls).
  v_paid_team := greatest(
    case when v_prof.subscription_plan = 'team'
          and v_prof.subscription_status in ('non-renewing', 'cancelled', 'complete')
         then v_prof.current_period_end end,
    case when v_prof.prepaid_plan = 'team' then v_prof.paid_until end);
  v_paid_pro := greatest(v_paid_team,
    case when v_prof.subscription_plan = 'pro'
          and v_prof.subscription_status in ('non-renewing', 'cancelled', 'complete')
         then v_prof.current_period_end end,
    case when v_prof.prepaid_plan = 'pro' then v_prof.paid_until end);

  v_team := v_t.team_until;
  v_pro := v_t.pro_until;
  if v_code.plan = 'team' then
    v_from := greatest(now(), v_t.team_until, v_paid_team);
    v_until := v_from + make_interval(days => v_code.days);
    v_team := v_until;
    -- Pro tester time not yet used (it runs once nothing higher is left)
    -- keeps its length, after the new Team time.
    if v_t.pro_until > greatest(v_from, v_paid_pro) then
      v_pro := greatest(v_until, v_paid_pro) + (v_t.pro_until - greatest(v_from, v_paid_pro));
    end if;
  else
    v_from := greatest(now(), v_t.team_until, v_t.pro_until, v_paid_pro);
    v_until := v_from + make_interval(days => v_code.days);
    v_pro := v_until;
  end if;

  if not dry_run then
    insert into public.access_code_redemptions (code_id, user_id) values (v_code.id, uid);
    update public.access_codes c set uses = c.uses + 1 where c.id = v_code.id;
    insert into public.tester_access as t (user_id, team_until, pro_until, code_id, granted_at)
    values (uid, v_team, v_pro, v_code.id, now())
    on conflict (user_id) do update
      set team_until = excluded.team_until,
          pro_until = excluded.pro_until,
          code_id = excluded.code_id,
          granted_at = excluded.granted_at;
  end if;

  return jsonb_build_object('plan', v_code.plan, 'days', v_code.days, 'until', v_until,
                            'starts', case when v_from > now() then v_from end);
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
-- unexpired prepaid term, and tester time that hasn't ended (Team first,
-- then Pro).
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
        (select case when ta.team_until > now() then 'team'
                     when ta.pro_until > now() then 'pro' end
           from public.tester_access ta where ta.user_id = u.id) as t
        from (select uid as id) u
        left join public.profiles pr on pr.id = u.id
    ) x;
$$;

revoke execute on function public.own_plan(uuid) from public, anon, authenticated;
