-- ============================================================
-- Persistent usage counters.
--
-- Safe to run more than once. Run it in the Supabase SQL editor on a project
-- created from an earlier supabase/schema.sql. (A new project only needs
-- supabase/schema.sql, which already includes everything here.)
--
-- Daily AI answers, edits, media downloads and link imports used to be
-- counted in server memory, which resets per serverless instance. They are
-- now counted here, through functions only the service role can call.
-- ============================================================

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
