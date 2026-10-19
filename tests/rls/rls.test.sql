-- ============================================================
-- Row Level Security and privilege tests for supabase/schema.sql.
--
-- Plays the same requests a browser can make with the public anon key
-- (PostgREST runs them as role anon / authenticated with the JWT claims in
-- request.jwt.claims) and asserts each attack is refused, plus a few
-- positive controls so a test can't pass just because everything fails.
--
-- Run with scripts/test-rls.sh (CI does). Needs a fresh database that has
-- tests/rls/supabase-stub.sql and the app schema applied.
-- ============================================================
\set ON_ERROR_STOP 1
\set VERBOSITY terse
\pset pager off

create schema rlstest;
create table rlstest.results (
  n serial primary key,
  name text not null,
  expected text not null,
  got text not null,
  pass boolean not null
);

-- Runs p_sql as p_role (with a JWT for p_sub, if given) and returns:
--   'value:<first column>' for a SELECT, 'rows:<n>' for anything else,
--   'denied' for a permission or RLS refusal (SQLSTATE 42501),
--   'error:<SQLSTATE>:<message>' for any other error.
create function rlstest.run(p_role text, p_sub uuid, p_sql text) returns text
language plpgsql as $$
declare
  v text;
  n bigint;
  result text;
begin
  if p_role <> 'postgres' then
    perform set_config('request.jwt.claims',
      case when p_sub is null then json_build_object('role', p_role)::text
           else json_build_object('sub', p_sub, 'role', p_role, 'aud', 'authenticated')::text end,
      true);
    execute format('set local role %I', p_role);
  end if;
  begin
    if p_sql ~* '^\s*select' then
      execute p_sql into v;
      result := 'value:' || coalesce(v, 'null');
    else
      execute p_sql;
      get diagnostics n = row_count;
      result := 'rows:' || n;
    end if;
  exception
    when insufficient_privilege then result := 'denied';
    when others then result := 'error:' || sqlstate || ':' || sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return result;
end $$;

-- Records one check. `expected` matches exactly, or as a prefix when it ends
-- in ':' (e.g. 'error:P0001:').
create function rlstest.expect(p_name text, p_role text, p_sub uuid, p_sql text, p_expected text) returns void
language plpgsql as $$
declare
  got text := rlstest.run(p_role, p_sub, p_sql);
begin
  insert into rlstest.results (name, expected, got, pass)
  values (p_name, p_expected, got,
          case when right(p_expected, 1) = ':' then got like p_expected || '%' else got = p_expected end);
end $$;

-- ---------- Seed (as the database owner, like the service role) ----------
-- A: Free. B: Team owner with a document, a stored file, and two members.
-- C: on B's list but email not confirmed. E: on B's list and confirmed.
-- D: Free, used for the storage tests.
\set A 'aaaaaaaa-0000-4000-8000-00000000000a'
\set B 'bbbbbbbb-0000-4000-8000-00000000000b'
\set C 'cccccccc-0000-4000-8000-00000000000c'
\set D 'dddddddd-0000-4000-8000-00000000000d'
\set E 'eeeeeeee-0000-4000-8000-00000000000e'

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  (:'A', 'alice@example.com', now(), '{"full_name":"Alice"}'),
  (:'B', 'bob@example.com', now(), '{"full_name":"Bob"}'),
  (:'C', 'carol@example.com', null, '{}'),
  (:'D', 'dave@example.com', now(), '{}'),
  (:'E', 'erin@example.com', now(), '{}');
update public.profiles
   set prepaid_plan = 'team', paid_until = now() + interval '30 days', plan = 'team',
       paystack_customer_code = 'CUS_bob', paystack_email_token = 'tok_bob'
 where id = :'B';
insert into public.team_members (owner_id, email) values
  (:'B', 'carol@example.com'), (:'B', 'erin@example.com');
insert into public.documents (id, owner_id, name, storage_path) values
  ('00000000-0000-4000-8000-0000000000b1', :'B', 'bob-secret', :'B' || '/secret.pdf');
insert into storage.objects (bucket_id, name, owner) values ('documents', :'B' || '/secret.pdf', :'B');
insert into public.billing_events (id, type) values ('charge:ref_1', 'charge.success');
select public.consume_usage('u:' || :'B', 'ai', 10, 'day');

-- Tester access. T1: Free tester. T2: a second tester. T3: prepaid Pro to
-- 2030, then a Team tester code. T4: Team tester who lists M (confirmed) as a
-- member. T5 and T6: Pro and Team codes mixed. T7: two codes at once.
-- S1: a Pro subscription that renews. S2: a Pro subscription that ends in 10
-- days. Codes are made the way the owner makes them in the SQL editor.
\set T1 '11111111-0000-4000-8000-000000000001'
\set T2 '22222222-0000-4000-8000-000000000002'
\set T3 '33333333-0000-4000-8000-000000000003'
\set T4 '44444444-0000-4000-8000-000000000004'
\set M '55555555-0000-4000-8000-000000000005'
\set T5 '66666666-0000-4000-8000-000000000006'
\set T6 '77777777-0000-4000-8000-000000000007'
\set T7 '88888888-0000-4000-8000-000000000008'
\set S1 '99999999-0000-4000-8000-000000000009'
\set S2 '99999999-0000-4000-8000-000000000010'
insert into auth.users (id, email, email_confirmed_at) values
  (:'T1', 'tess@example.com', now()), (:'T2', 'tom@example.com', now()),
  (:'T3', 'tina@example.com', now()), (:'T4', 'theo@example.com', now()),
  (:'M', 'mia@example.com', now()), (:'T5', 'tia@example.com', now()),
  (:'T6', 'ted@example.com', now()), (:'T7', 'tim@example.com', now()),
  (:'S1', 'sam@example.com', now()), (:'S2', 'sue@example.com', now());
update public.profiles set prepaid_plan = 'pro', paid_until = '2030-01-01T00:00:00Z', plan = 'pro' where id = :'T3';
update public.profiles set subscription_plan = 'pro', subscription_status = 'active', current_period_end = now() + interval '20 days' where id = :'S1';
update public.profiles set subscription_plan = 'pro', subscription_status = 'non-renewing', current_period_end = now() + interval '10 days' where id = :'S2';
insert into public.team_members (owner_id, email) values (:'T4', 'mia@example.com');
select code as code_pro, link as link_pro from public.create_tester_code(note => 'Tess') \gset
select code as code_team from public.create_tester_code('team', 10, 5, 'Team trial') \gset
select code as code_team4 from public.create_tester_code(plan => 'team', days => 30, note => 'Theo') \gset
select code as code_pro5 from public.create_tester_code(days => 5) \gset
select code as code_race from public.create_tester_code(note => 'race') \gset
select code as code_exp from public.create_tester_code(note => 'expired') \gset
update public.access_codes set expires_at = now() - interval '1 second' where code_hash = public.tester_code_hash(:'code_exp');
select code as code_rev from public.create_tester_code(note => 'revoked') \gset
select ref as revoked_ref from public.revoke_tester_code(:'code_rev') \gset
select code as code_team1 from public.create_tester_code(plan => 'team', days => 1) \gset
select code as code_team14 from public.create_tester_code(plan => 'team', days => 14) \gset
select code as code_mix from public.create_tester_code(max_uses => 2, note => 'mix') \gset
select code as code_late from public.create_tester_code(days => 5, max_uses => 2, note => 'late') \gset
select code as code_r30 from public.create_tester_code(note => 'same user 1') \gset
select code as code_r5 from public.create_tester_code(days => 5, note => 'same user 2') \gset
select code as code_team7 from public.create_tester_code(plan => 'team', days => 7) \gset

-- The code's plan as the server sees it (or its whole answer), the plan
-- with tester time set to given ends, the days left of one plan's tester
-- time, and a refusal with its DETAIL.
create function rlstest.redeem(p_uid uuid, p_code text, p_dry boolean default false) returns text
language sql as $$ select public.redeem_tester_code(p_uid, p_code, p_dry) ->> 'plan' $$;
create function rlstest.redeem_json(p_uid uuid, p_code text, p_dry boolean default false) returns jsonb
language sql as $$ select public.redeem_tester_code(p_uid, p_code, p_dry) $$;
grant usage on schema rlstest to service_role; -- for rlstest.redeem, run as the server
create function rlstest.plan_with(p_uid uuid, p_team timestamptz, p_pro timestamptz) returns text
language plpgsql as $$
begin
  update public.tester_access set team_until = p_team, pro_until = p_pro where user_id = p_uid;
  return public.effective_plan(p_uid);
end $$;
-- The plan if tester time had the given ends, leaving the row as it was.
create function rlstest.plan_if(p_uid uuid, p_team timestamptz, p_pro timestamptz) returns text
language plpgsql as $$
declare
  v text;
begin
  begin
    update public.tester_access set team_until = p_team, pro_until = p_pro where user_id = p_uid;
    v := public.effective_plan(p_uid);
    raise exception 'undo' using errcode = 'RLSUN';
  exception when sqlstate 'RLSUN' then
    null;
  end;
  return v;
end $$;
create function rlstest.days_left(p_uid uuid, p_plan text) returns numeric
language sql as $$
  select round(extract(epoch from (case p_plan when 'team' then team_until else pro_until end) - now()) / 86400, 2)
    from public.tester_access where user_id = p_uid
$$;
create function rlstest.refusal(p_uid uuid, p_code text, p_dry boolean) returns text
language plpgsql as $$
declare
  v_detail text;
begin
  perform public.redeem_tester_code(p_uid, p_code, p_dry);
  return 'redeemed';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return sqlstate || ':' || sqlerrm || ':' || coalesce(v_detail, '');
end $$;

-- Two connections of their own, for redeeming at the same moment.
create extension if not exists dblink schema rlstest;
select format('dbname=%s port=%s user=%s%s', current_database(), current_setting('port'), current_user,
              coalesce(' host=' || nullif(split_part(current_setting('unix_socket_directories'), ',', 1), ''), '')) as race_conn \gset
create function rlstest.race_result(p_conn text) returns text
language plpgsql as $$
declare
  v text;
  msg text;
begin
  perform set_config('client_min_messages', 'warning', true);
  select t.r into v from rlstest.dblink_get_result(p_conn, false) as t(r text);
  msg := rlstest.dblink_error_message(p_conn);
  perform 1 from rlstest.dblink_get_result(p_conn, false) as t(r text);
  return case when msg = 'OK' then 'value:' || v else 'error:' || substring(msg from 'ERROR:\s+(\S+)') end;
end $$;

\o /dev/null
-- psql variables are not expanded inside $$ strings, so checks build their
-- SQL with format() and %L.

-- ---------- Anonymous visitor (public anon key, no session) ----------
select rlstest.expect('anon: read profiles',            'anon', null, 'select count(*) from public.profiles', 'denied');
select rlstest.expect('anon: read documents',           'anon', null, 'select count(*) from public.documents', 'denied');
select rlstest.expect('anon: read billing_events',      'anon', null, 'select count(*) from public.billing_events', 'denied');
select rlstest.expect('anon: read team_members',        'anon', null, 'select count(*) from public.team_members', 'denied');
select rlstest.expect('anon: read usage_counters',      'anon', null, 'select count(*) from public.usage_counters', 'denied');
select rlstest.expect('anon: read auth.users',          'anon', null, 'select count(*) from auth.users', 'denied');
select rlstest.expect('anon: list stored files',        'anon', null, 'select count(*) from storage.objects', 'value:0');
select rlstest.expect('anon: list buckets',             'anon', null, 'select count(*) from storage.buckets', 'value:0');
select rlstest.expect('anon: create a Team profile',    'anon', null, format('insert into public.profiles (id, plan) values (%L, %L)', :'C', 'team'), 'denied');
select rlstest.expect('anon: edit profiles',            'anon', null, 'update public.profiles set full_name = $q$x$q$', 'denied');
select rlstest.expect('anon: add a document for B',     'anon', null, format('insert into public.documents (owner_id, name, storage_path) values (%L, %L, %L)', :'B', 'x', :'B' || '/x.pdf'), 'denied');
select rlstest.expect('anon: delete documents',         'anon', null, 'delete from public.documents', 'denied');
select rlstest.expect('anon: truncate documents',       'anon', null, 'truncate public.documents', 'denied');
select rlstest.expect('anon: upload into B''s folder',  'anon', null, format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'documents', :'B' || '/evil.pdf'), 'denied');
select rlstest.expect('anon: make the bucket public',   'anon', null, 'update storage.buckets set public = true', 'rows:0');
select rlstest.expect('anon: create a public bucket',   'anon', null, 'insert into storage.buckets (id, name, public) values ($q$pub$q$, $q$pub$q$, true)', 'denied');
select rlstest.expect('anon: write billing_events',     'anon', null, 'insert into public.billing_events values ($q$charge:x$q$, $q$charge.success$q$)', 'denied');
select rlstest.expect('anon: write usage_counters',     'anon', null, 'insert into public.usage_counters values ($q$k$q$, $q$b$q$, $q$day$q$, now(), 0)', 'denied');
select rlstest.expect('anon: rpc own_plan',             'anon', null, format('select public.own_plan(%L)', :'B'), 'denied');
select rlstest.expect('anon: rpc effective_plan',       'anon', null, format('select public.effective_plan(%L)', :'B'), 'denied');
select rlstest.expect('anon: rpc consume_usage',        'anon', null, 'select public.consume_usage($q$x$q$, $q$y$q$, 100, $q$day$q$)', 'denied');
select rlstest.expect('anon: rpc refund_usage',         'anon', null, format('select public.refund_usage(%L, %L, %L)', 'u:' || :'B', 'ai', 'day'), 'denied');
select rlstest.expect('anon: rpc usage_count',          'anon', null, format('select public.usage_count(%L, %L, %L)', 'u:' || :'B', 'ai', 'day'), 'denied');
select rlstest.expect('anon: read access_codes',        'anon', null, 'select count(*) from public.access_codes', 'denied');
select rlstest.expect('anon: read code redemptions',    'anon', null, 'select count(*) from public.access_code_redemptions', 'denied');
select rlstest.expect('anon: read tester_access',       'anon', null, 'select count(*) from public.tester_access', 'denied');
select rlstest.expect('anon: give someone tester access', 'anon', null, format('insert into public.tester_access (user_id, team_until) values (%L, now() + interval %L)', :'C', '1 year'), 'denied');
select rlstest.expect('anon: rpc create_tester_code',   'anon', null, 'select count(*) from public.create_tester_code()', 'denied');
select rlstest.expect('anon: rpc list_tester_codes',    'anon', null, 'select count(*) from public.list_tester_codes()', 'denied');
select rlstest.expect('anon: rpc revoke_tester_code',   'anon', null, format('select count(*) from public.revoke_tester_code(%L)', :'code_pro'), 'denied');
select rlstest.expect('anon: rpc redeem_tester_code',   'anon', null, format('select public.redeem_tester_code(%L, %L)', :'C', :'code_pro'), 'denied');
select rlstest.expect('anon: rpc tester_code_hash',     'anon', null, format('select public.tester_code_hash(%L)', :'code_pro'), 'denied');

-- ---------- Signed-in user A against user B ----------
select rlstest.expect('A: sees only own profile',       'authenticated', :'A', 'select count(*) from public.profiles', 'value:1');
select rlstest.expect('A: read B''s profile',           'authenticated', :'A', format('select count(*) from public.profiles where id = %L', :'B'), 'value:0');
select rlstest.expect('A: read B''s team list',         'authenticated', :'A', 'select count(*) from public.team_members', 'value:0');
select rlstest.expect('A: read B''s documents',         'authenticated', :'A', 'select count(*) from public.documents', 'value:0');
select rlstest.expect('A: list B''s files',             'authenticated', :'A', 'select count(*) from storage.objects', 'value:0');
select rlstest.expect('A: update B''s document',        'authenticated', :'A', 'update public.documents set name = $q$pwn$q$', 'rows:0');
select rlstest.expect('A: delete B''s document',        'authenticated', :'A', 'delete from public.documents', 'rows:0');
select rlstest.expect('A: delete B''s file',            'authenticated', :'A', 'delete from storage.objects', 'rows:0');
select rlstest.expect('A: overwrite B''s file',         'authenticated', :'A', 'update storage.objects set name = name', 'rows:0');
select rlstest.expect('A: add a document owned by B',   'authenticated', :'A', format('insert into public.documents (owner_id, name, storage_path) values (%L, %L, %L)', :'B', 'x', :'B' || '/x.pdf'), 'denied');
select rlstest.expect('A: own row in B''s folder',      'authenticated', :'A', format('insert into public.documents (owner_id, name, storage_path) values (%L, %L, %L)', :'A', 'x', :'B' || '/secret.pdf'), 'denied');
select rlstest.expect('A: ../ path traversal',          'authenticated', :'A', format('insert into public.documents (owner_id, name, storage_path) values (%L, %L, %L)', :'A', 'x', :'A' || '/../' || :'B' || '/secret.pdf'), 'denied');
select rlstest.expect('A: upload into B''s folder',     'authenticated', :'A', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'documents', :'B' || '/evil.pdf'), 'denied');
select rlstest.expect('A: upload without a document',   'authenticated', :'A', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'documents', :'A' || '/norow.pdf'), 'denied');
select rlstest.expect('A: make the bucket public',      'authenticated', :'A', 'update storage.buckets set public = true, file_size_limit = null', 'rows:0');
select rlstest.expect('A: create a bucket',             'authenticated', :'A', 'insert into storage.buckets (id, name, public) values ($q$pub$q$, $q$pub$q$, true)', 'denied');
select rlstest.expect('A: truncate documents',          'authenticated', :'A', 'truncate public.documents', 'denied');

-- Billing: a user must never be able to give themselves a paid plan.
select rlstest.expect('A: set own plan',                'authenticated', :'A', 'update public.profiles set plan = $q$team$q$ where id = auth.uid()', 'denied');
select rlstest.expect('A: set own prepaid term',        'authenticated', :'A', 'update public.profiles set prepaid_plan = $q$team$q$, paid_until = now() + interval $q$1 year$q$ where id = auth.uid()', 'denied');
select rlstest.expect('A: set own subscription',        'authenticated', :'A', 'update public.profiles set subscription_plan = $q$pro$q$, subscription_status = $q$active$q$ where id = auth.uid()', 'denied');
select rlstest.expect('A: change own email',            'authenticated', :'A', 'update public.profiles set email = $q$bob@example.com$q$ where id = auth.uid()', 'denied');
select rlstest.expect('A: upsert own profile as Pro',   'authenticated', :'A', format('insert into public.profiles (id, plan) values (%L, %L) on conflict (id) do update set plan = excluded.plan', :'A', 'pro'), 'denied');
select rlstest.expect('A: create a profile for C',      'authenticated', :'A', format('insert into public.profiles (id, full_name) values (%L, %L)', :'C', 'x'), 'denied');
select rlstest.expect('A: delete own profile',          'authenticated', :'A', 'delete from public.profiles where id = auth.uid()', 'denied');
select rlstest.expect('A: rename self (allowed)',       'authenticated', :'A', 'update public.profiles set full_name = $q$Alice A$q$ where id = auth.uid()', 'rows:1');
select rlstest.expect('A: still on Free',               'postgres', null, format('select public.effective_plan(%L)', :'A'), 'value:free');
select rlstest.expect('A: join B''s team',              'authenticated', :'A', format('insert into public.team_members (owner_id, email) values (%L, %L)', :'B', 'alice@example.com'), 'denied');
select rlstest.expect('A: remove B''s members',         'authenticated', :'A', 'delete from public.team_members', 'denied');
select rlstest.expect('A: read billing_events',         'authenticated', :'A', 'select count(*) from public.billing_events', 'denied');
select rlstest.expect('A: forge a billing event',       'authenticated', :'A', 'insert into public.billing_events values ($q$charge:x$q$, $q$charge.success$q$)', 'denied');
select rlstest.expect('A: read usage_counters',         'authenticated', :'A', 'select count(*) from public.usage_counters', 'denied');
select rlstest.expect('A: rpc effective_plan',          'authenticated', :'A', format('select public.effective_plan(%L)', :'A'), 'denied');
select rlstest.expect('A: rpc refund_usage',            'authenticated', :'A', format('select public.refund_usage(%L, %L, %L)', 'u:' || :'A', 'ai', 'day'), 'denied');
select rlstest.expect('A: rpc consume_usage',           'authenticated', :'A', 'select public.consume_usage($q$x$q$, $q$y$q$, 100, $q$day$q$)', 'denied');

-- Tester codes: made, listed, revoked and redeemed only by the owner and the
-- server. A signed-in user can't read a code, redeem one for themselves, or
-- write their own tester time.
select rlstest.expect('A: read access_codes',           'authenticated', :'A', 'select count(*) from public.access_codes', 'denied');
select rlstest.expect('A: read code redemptions',       'authenticated', :'A', 'select count(*) from public.access_code_redemptions', 'denied');
select rlstest.expect('A: rpc create_tester_code',      'authenticated', :'A', format('select count(*) from public.create_tester_code(%L, 365, 100)', 'team'), 'denied');
select rlstest.expect('A: rpc list_tester_codes',       'authenticated', :'A', 'select count(*) from public.list_tester_codes()', 'denied');
select rlstest.expect('A: rpc revoke_tester_code',      'authenticated', :'A', format('select count(*) from public.revoke_tester_code(%L, true)', :'code_team'), 'denied');
select rlstest.expect('A: rpc redeem_tester_code',      'authenticated', :'A', format('select public.redeem_tester_code(%L, %L)', :'A', :'code_pro'), 'denied');
select rlstest.expect('A: rpc tester_code_hash',        'authenticated', :'A', format('select public.tester_code_hash(%L)', :'code_pro'), 'denied');
select rlstest.expect('A: give self tester access',     'authenticated', :'A', format('insert into public.tester_access (user_id, team_until) values (%L, now() + interval %L)', :'A', '1 year'), 'denied');
select rlstest.expect('A: record a redemption',         'authenticated', :'A', format('insert into public.access_code_redemptions (code_id, user_id) select id, %L from public.access_codes', :'A'), 'denied');
select rlstest.expect('A: add a code',                  'authenticated', :'A', format('insert into public.access_codes (code_hash, plan, days, expires_at) values (%L, %L, 365, now() + interval %L)', repeat('a', 64), 'team', '1 year'), 'denied');
select rlstest.expect('A: still Free after all that',   'postgres', null, format('select public.effective_plan(%L)', :'A'), 'value:free');

-- Team seats need a confirmed email.
select rlstest.expect('unconfirmed email on a team: Free', 'postgres', null, format('select public.effective_plan(%L)', :'C'), 'value:free');
select rlstest.expect('confirmed email on a team: Team',   'postgres', null, format('select public.effective_plan(%L)', :'E'), 'value:team');

-- ---------- Own documents and files ----------
select rlstest.expect('A: add own document',            'authenticated', :'A', format('insert into public.documents (id, owner_id, name, storage_path) values (%L, %L, %L, %L)', '00000000-0000-4000-8000-0000000000a1', :'A', 'a1', :'A' || '/a1.pdf'), 'rows:1');
select rlstest.expect('A: upload its file',             'authenticated', :'A', format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'documents', :'A' || '/a1.pdf', :'A'), 'rows:1');
select rlstest.expect('A: sees own file',               'authenticated', :'A', 'select count(*) from storage.objects', 'value:1');
select rlstest.expect('A: save edits (allowed columns)', 'authenticated', :'A', 'update public.documents set name = $q$a1 v2$q$, page_count = 3, size_bytes = 10, updated_at = now() where owner_id = auth.uid()', 'rows:1');
select rlstest.expect('A: repoint a row at another path', 'authenticated', :'A', format('update public.documents set storage_path = %L where owner_id = auth.uid()', :'A' || '/other.pdf'), 'denied');
select rlstest.expect('A: give a row to B',             'authenticated', :'A', format('update public.documents set owner_id = %L where owner_id = auth.uid()', :'B'), 'denied');
-- Deleting the row first would leave the file behind, outside the plan limit.
select rlstest.expect('A: delete a row, keep its file', 'authenticated', :'A', 'delete from public.documents where owner_id = auth.uid()', 'error:P0001:');
select rlstest.expect('A: delete the file',             'authenticated', :'A', format('delete from storage.objects where name = %L', :'A' || '/a1.pdf'), 'rows:1');
select rlstest.expect('A: then the row',                'authenticated', :'A', 'delete from public.documents where owner_id = auth.uid()', 'rows:1');

-- Free keeps files up to 50 MB; the bucket allows Pro's 500 MB. Storage
-- records the real size in metadata, and may write it as the service role.
select rlstest.expect('A: a 60 MB document on Free',    'authenticated', :'A', format('insert into public.documents (owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %L)', :'A', 'big', :'A' || '/big.pdf', 62914560), 'error:P0001:');
select rlstest.expect('A: a 50 MB document on Free',    'authenticated', :'A', format('insert into public.documents (id, owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %L, %L)', '00000000-0000-4000-8000-0000000000a2', :'A', 'a2', :'A' || '/a2.pdf', 52428800), 'rows:1');
select rlstest.expect('A: its 50 MB file',              'authenticated', :'A', format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)', 'documents', :'A' || '/a2.pdf', :'A', '{"size": 52428800}'), 'rows:1');
select rlstest.expect('A: replace it with 60 MB',       'authenticated', :'A', format('update storage.objects set metadata = %L where name = %L', '{"size": 62914560}', :'A' || '/a2.pdf'), 'error:P0001:');
select rlstest.expect('A: rename it (size unchanged)',  'authenticated', :'A', format('update storage.objects set metadata = metadata || %L where name = %L', '{"mimetype": "application/pdf"}', :'A' || '/a2.pdf'), 'rows:1');
select rlstest.expect('A: a small document, 60 MB file', 'authenticated', :'A', format('insert into public.documents (id, owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %L, %L)', '00000000-0000-4000-8000-0000000000a3', :'A', 'a3', :'A' || '/a3.pdf', 10), 'rows:1');
select rlstest.expect('A: upload the 60 MB file',       'authenticated', :'A', format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)', 'documents', :'A' || '/a3.pdf', :'A', '{"size": 62914560}'), 'error:P0001:');
select rlstest.expect('storage (service role): A''s 60 MB file', 'service_role', null, format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)', 'documents', :'A' || '/a3.pdf', :'A', '{"size": 62914560}'), 'error:P0001:');
select rlstest.expect('A: clean up the 50 MB file',     'authenticated', :'A', format('delete from storage.objects where name = %L', :'A' || '/a2.pdf'), 'rows:1');
select rlstest.expect('A: clean up its documents',      'authenticated', :'A', 'delete from public.documents where owner_id = auth.uid()', 'rows:2');
select rlstest.expect('B (Team): a 60 MB document',     'authenticated', :'B', format('insert into public.documents (id, owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %L, %L)', '00000000-0000-4000-8000-0000000000b2', :'B', 'b2', :'B' || '/b2.pdf', 62914560), 'rows:1');
select rlstest.expect('storage (service role): B''s 60 MB file', 'service_role', null, format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)', 'documents', :'B' || '/b2.pdf', :'B', '{"size": 62914560}'), 'rows:1');
select rlstest.expect('E (on B''s team): a 60 MB file',  'authenticated', :'E', format('insert into public.documents (owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %L)', :'E', 'e1', :'E' || '/e1.pdf', 62914560), 'rows:1');
select rlstest.expect('E: upload it',                   'authenticated', :'E', format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)', 'documents', :'E' || '/e1.pdf', :'E', '{"size": 62914560}'), 'rows:1');

-- Free keeps 5 documents.
select rlstest.expect('A: 5 documents on Free',         'authenticated', :'A', format('insert into public.documents (owner_id, name, storage_path) select %L, %L || i, %L || i || %L from generate_series(1, 5) i', :'A', 'f', :'A' || '/f', '.pdf'), 'rows:5');
select rlstest.expect('A: a 6th on Free',               'authenticated', :'A', format('insert into public.documents (owner_id, name, storage_path) values (%L, %L, %L)', :'A', 'f6', :'A' || '/f6.pdf'), 'error:P0001:');

-- Files left without a row (from before this was fixed) can't be read or
-- signed by their owner.
insert into storage.objects (bucket_id, name, owner) values ('documents', :'D' || '/orphan.pdf', :'D');
select rlstest.expect('D: read an orphaned file',       'authenticated', :'D', 'select count(*) from storage.objects', 'value:0');
select rlstest.expect('D: upload to an orphan''s path', 'authenticated', :'D', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'documents', :'D' || '/orphan2.pdf'), 'denied');

-- Free keeps files up to 50 MB (the bucket allows Pro's 500 MB): checked on
-- the row, and on the stored file whatever the row says. Storage saves the
-- file's size as its own role, which 'postgres' stands in for here.
select rlstest.expect('D: a 60 MB document on Free',   'authenticated', :'D', format('insert into public.documents (owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %s)', :'D', 'big', :'D' || '/big.pdf', 62934872), 'error:P0001:');
select rlstest.expect('D: a 50 MB document on Free',   'authenticated', :'D', format('insert into public.documents (owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %s)', :'D', 'd50', :'D' || '/d50.pdf', 52428800), 'rows:1');
select rlstest.expect('D: its 50 MB file is stored',   'postgres', null, format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)', 'documents', :'D' || '/d50.pdf', :'D', '{"size": 52428800}'), 'rows:1');
select rlstest.expect('D: a 60 MB file, whatever its row', 'postgres', null, format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)', 'documents', :'D' || '/d60.pdf', :'D', '{"size": 62934872}'), 'error:P0001:');
select rlstest.expect('D: replace the file with 60 MB', 'postgres', null, format('update storage.objects set metadata = %L where name = %L', '{"size": 62934872}', :'D' || '/d50.pdf'), 'error:P0001:');
select rlstest.expect('B: a 400 MB document on Team', 'authenticated', :'B', format('insert into public.documents (owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %s)', :'B', 'big', :'B' || '/big.pdf', 419430400), 'rows:1');
select rlstest.expect('B: its 400 MB file is stored',  'postgres', null, format('insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L)', 'documents', :'B' || '/big.pdf', :'B', '{"size": 419430400}'), 'rows:1');

-- ---------- Server (service role) ----------
select rlstest.expect('server: 3rd team member',        'service_role', null, format('insert into public.team_members (owner_id, email) values (%L, %L)', :'B', 'm3@example.com'), 'rows:1');
select rlstest.expect('server: 4th team member',        'service_role', null, format('insert into public.team_members (owner_id, email) values (%L, %L)', :'B', 'm4@example.com'), 'rows:1');
select rlstest.expect('server: 5th team member',        'service_role', null, format('insert into public.team_members (owner_id, email) values (%L, %L)', :'B', 'm5@example.com'), 'error:P0001:');
select rlstest.expect('server: mixed-case member email', 'service_role', null, format('insert into public.team_members (owner_id, email) values (%L, %L)', :'D', ' Mixed@Example.com'), 'error:23514:');
select rlstest.expect('server: usage limit holds',      'service_role', null, 'select public.consume_usage($q$u:t$q$, $q$ai$q$, 1, $q$day$q$) + public.consume_usage($q$u:t$q$, $q$ai$q$, 1, $q$day$q$)', 'value:-1');
select rlstest.expect('server: billing update allowed', 'service_role', null, format('update public.profiles set prepaid_plan = %L, paid_until = now() + interval %L where id = %L', 'pro', '1 day', :'D'), 'rows:1');

-- ---------- Tester access codes ----------
-- Codes: 16 symbols without 0, O, 1 or I; only their hash is stored; the
-- hash is the one lib/tester-access.ts computes.
select rlstest.expect('codes look like XXXX-XXXX-XXXX-XXXX', 'postgres', null, format('select %L ~ %L', :'code_pro', '^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$'), 'value:true');
select rlstest.expect('the link carries the code after #', 'postgres', null, format('select %L = %L', :'link_pro', 'https://pdfwizard.xyz/redeem#' || :'code_pro'), 'value:true');
select rlstest.expect('the code itself is not stored',  'postgres', null, format('select count(*) from public.access_codes c where c::text ilike %L or c::text ilike %L', '%' || :'code_pro' || '%', '%' || replace(:'code_pro', '-', '') || '%'), 'value:0');
select rlstest.expect('its SHA-256 is',                 'postgres', null, format('select count(*) from public.access_codes where code_hash = encode(sha256(convert_to(%L, %L)), %L)', replace(:'code_pro', '-', ''), 'UTF8', 'hex'), 'value:1');
select rlstest.expect('same hash as the app (lib/tester-access.ts)', 'postgres', null, 'select public.tester_code_hash($q$abcd efgh-jkmn pqrs$q$)', 'value:f598056127fcd4387651a49b3a4235d8ce50d71f4091068df51511cfc10f388f');
select rlstest.expect('the owner lists codes without them', 'postgres', null, format('select count(*) from public.list_tester_codes() l where l::text ilike %L', '%' || replace(:'code_pro', '-', '') || '%'), 'value:0');
select rlstest.expect('create: plan must be pro or team', 'postgres', null, 'select count(*) from public.create_tester_code($q$gold$q$)', 'error:22023:');
select rlstest.expect('create: 1 to 365 days',          'postgres', null, 'select count(*) from public.create_tester_code(days => 0)', 'error:22023:');
select rlstest.expect('create: at least one use',       'postgres', null, 'select count(*) from public.create_tester_code(max_uses => 0)', 'error:22023:');
select rlstest.expect('server (service role) can make one', 'service_role', null, 'select count(*) from public.create_tester_code(note => $q$from the server$q$)', 'value:1');

-- Redeeming (the server, with the service role).
select rlstest.expect('T1: check a code (dry run)',     'service_role', null, format('select rlstest.redeem(%L, %L, true)', :'T1', lower(:'code_pro')), 'value:pro');
select rlstest.expect('T1: a dry run writes nothing',   'postgres', null, format('select count(*) from public.tester_access where user_id = %L', :'T1'), 'value:0');
select rlstest.expect('T1: redeem it, typed loosely',   'service_role', null, format('select rlstest.redeem(%L, %L)', :'T1', ' ' || lower(replace(:'code_pro', '-', ' ')) || ' '), 'value:pro');
select rlstest.expect('T1: now on Pro',                 'postgres', null, format('select public.effective_plan(%L)', :'T1'), 'value:pro');
select rlstest.expect('T1: for 30 days',                'postgres', null, format('select rlstest.days_left(%L, %L) between 29.99 and 30', :'T1', 'pro'), 'value:true');
select rlstest.expect('T1: billing untouched',          'postgres', null, format('select plan || coalesce(subscription_plan, $q$-$q$) || coalesce(prepaid_plan, $q$-$q$) || coalesce(paid_until::text, $q$-$q$) from public.profiles where id = %L', :'T1'), 'value:free---');
select rlstest.expect('T1: sees own tester row',        'authenticated', :'T1', 'select pro_until > now() and team_until is null from public.tester_access', 'value:true');
select rlstest.expect('A: can''t see T1''s tester row', 'authenticated', :'A', format('select count(*) from public.tester_access where user_id = %L', :'T1'), 'value:0');
select rlstest.expect('T1: change own tester time',     'authenticated', :'T1', 'update public.tester_access set pro_until = pro_until + interval $q$1 year$q$', 'denied');
select rlstest.expect('T1: delete own tester row',      'authenticated', :'T1', 'delete from public.tester_access', 'denied');
select rlstest.expect('T1: the same code again',        'service_role', null, format('select rlstest.redeem(%L, %L)', :'T1', :'code_pro'), 'error:P0001:already_redeemed');
select rlstest.expect('T2: a one-use code, used',       'service_role', null, format('select rlstest.redeem(%L, %L)', :'T2', :'code_pro'), 'error:P0001:code_used_up');
select rlstest.expect('T2: an expired code',            'service_role', null, format('select rlstest.redeem(%L, %L)', :'T2', :'code_exp'), 'error:P0001:code_expired');
-- A revoked code and one that never existed get the same answer.
select rlstest.expect('T2: a revoked code',             'service_role', null, format('select rlstest.redeem(%L, %L)', :'T2', :'code_rev'), 'error:P0001:invalid_code');
select rlstest.expect('T2: a code that doesn''t exist', 'service_role', null, format('select rlstest.redeem(%L, %L)', :'T2', 'ABCD-EFGH-JKMN-PQRS'), 'error:P0001:invalid_code');
select rlstest.expect('T2: not a code at all',          'service_role', null, format('select rlstest.redeem(%L, %L)', :'T2', 'hello'), 'error:P0001:invalid_code');
select rlstest.expect('T2: still Free',                 'postgres', null, format('select public.effective_plan(%L)', :'T2'), 'value:free');
select rlstest.expect('the used code counts one use',   'postgres', null, format('select uses from public.access_codes where code_hash = public.tester_code_hash(%L)', :'code_pro'), 'value:1');

-- Tester time ends on its own, exactly at its end.
select rlstest.expect('T1: a second before the end: Pro', 'postgres', null, format('select rlstest.plan_with(%L, null, now() + interval %L)', :'T1', '1 second'), 'value:pro');
select rlstest.expect('T1: at the end: Free',           'postgres', null, format('select rlstest.plan_with(%L, null, now())', :'T1'), 'value:free');
-- After it ended, a new code counts from now: Team for 10 days.
select rlstest.expect('T1: a Team code after the end',  'service_role', null, format('select rlstest.redeem(%L, %L)', :'T1', :'code_team'), 'value:team');
select rlstest.expect('T1: Team, from now',             'postgres', null, format('select public.effective_plan(%L) || rlstest.days_left(%L, %L)::int', :'T1', :'T1', 'team'), 'value:team10');

-- Pro and Team codes mixed: each gives its own plan's days. Team time
-- comes first, then Pro, and a Pro code never adds Team time.
select rlstest.expect('T5: a 1-day Team code',          'service_role', null, format('select rlstest.redeem(%L, %L)', :'T5', :'code_team1'), 'value:team');
select rlstest.expect('T5: then a 30-day Pro code, starting when Team ends', 'postgres', null, format('select (rlstest.redeem_json(%L, %L) ->> %L)::timestamptz = (select team_until from public.tester_access where user_id = %L)', :'T5', :'code_mix', 'starts', :'T5'), 'value:true');
select rlstest.expect('T5: 1 day of Team, Pro to day 31', 'postgres', null, format('select rlstest.days_left(%L, %L)::int || $q$/$q$ || rlstest.days_left(%L, %L)::int', :'T5', 'team', :'T5', 'pro'), 'value:1/31');
select rlstest.expect('T5: Team now',                   'postgres', null, format('select public.effective_plan(%L)', :'T5'), 'value:team');
select rlstest.expect('T5: Pro once Team ends',         'postgres', null, format('select rlstest.plan_if(%L, now(), (select pro_until from public.tester_access where user_id = %L))', :'T5', :'T5'), 'value:pro');
select rlstest.expect('T6: a 30-day Pro code',          'service_role', null, format('select rlstest.redeem(%L, %L)', :'T6', :'code_mix'), 'value:pro');
select rlstest.expect('T6: then a 14-day Team code (check)', 'postgres', null, format('select rlstest.redeem_json(%L, %L, true) ->> %L', :'T6', :'code_team14', 'starts'), 'value:null');
select rlstest.expect('T6: redeem it',                  'service_role', null, format('select rlstest.redeem(%L, %L)', :'T6', :'code_team14'), 'value:team');
select rlstest.expect('T6: 14 days of Team, then the 30 of Pro', 'postgres', null, format('select rlstest.days_left(%L, %L)::int || $q$/$q$ || rlstest.days_left(%L, %L)::int', :'T6', 'team', :'T6', 'pro'), 'value:14/44');
select rlstest.expect('T6: Pro once Team ends',         'postgres', null, format('select rlstest.plan_if(%L, now(), (select pro_until from public.tester_access where user_id = %L))', :'T6', :'T6'), 'value:pro');

-- Paid and tester time side by side: the higher plan counts, tester time
-- starts after paid time of its plan that has an end date, and billing rows
-- stay exactly as they were.
select rlstest.expect('T3 (prepaid Pro): a Team code',  'service_role', null, format('select rlstest.redeem(%L, %L)', :'T3', :'code_team'), 'value:team');
select rlstest.expect('T3: Team while it runs',         'postgres', null, format('select public.effective_plan(%L)', :'T3'), 'value:team');
select rlstest.expect('T3: a 5-day Pro code (check): after the paid term', 'postgres', null, format('select (rlstest.redeem_json(%L, %L, true) ->> %L)::timestamptz = %L', :'T3', :'code_pro5', 'starts', '2030-01-01T00:00:00Z'), 'value:true');
select rlstest.expect('T3: redeem it',                  'service_role', null, format('select rlstest.redeem(%L, %L)', :'T3', :'code_pro5'), 'value:pro');
select rlstest.expect('T3: Team time unchanged, Pro tester time after 2030-01-01', 'postgres', null, format('select rlstest.days_left(%L, %L)::int || $q$ $q$ || (select pro_until = %L from public.tester_access where user_id = %L)', :'T3', 'team', '2030-01-06T00:00:00Z', :'T3'), 'value:10 true');
select rlstest.expect('T3: prepaid term untouched',     'postgres', null, format('select prepaid_plan || paid_until::date from public.profiles where id = %L', :'T3'), 'value:pro2030-01-01');
select rlstest.expect('T3: Team time over: paid Pro again', 'postgres', null, format('select rlstest.plan_with(%L, now() - interval %L, %L)', :'T3', '1 second', '2030-01-06T00:00:00Z'), 'value:pro');
select rlstest.expect('T3: (Team time back)',           'postgres', null, format('select rlstest.plan_with(%L, now() + interval %L, %L)', :'T3', '10 days', '2030-01-06T00:00:00Z'), 'value:team');
select rlstest.expect('T3: another Team code adds 7 days of Team', 'service_role', null, format('select rlstest.redeem(%L, %L)', :'T3', :'code_team7'), 'value:team');
select rlstest.expect('T3: and the Pro after the paid term stays put', 'postgres', null, format('select rlstest.days_left(%L, %L)::int || $q$ $q$ || (select pro_until = %L from public.tester_access where user_id = %L)', :'T3', 'team', '2030-01-06T00:00:00Z', :'T3'), 'value:17 true');
select rlstest.expect('S2 (Pro ending in 10 days): a 5-day Pro code', 'service_role', null, format('select rlstest.redeem(%L, %L)', :'S2', :'code_late'), 'value:pro');
select rlstest.expect('S2: starts when the subscription ends', 'postgres', null, format('select (select pro_until from public.tester_access where user_id = %L) = current_period_end + interval %L from public.profiles where id = %L', :'S2', '5 days', :'S2'), 'value:true');
select rlstest.expect('S2: subscription untouched',     'postgres', null, format('select subscription_status || current_period_end::date from public.profiles where id = %L', :'S2'), 'value:non-renewing' || (now() + interval '10 days')::date);

-- What renews, or a Team seat for a Pro code, already gives what the code
-- gives: the code is refused, says its plan, and isn't used.
select rlstest.expect('S1 (Pro that renews): a Pro code (check)', 'service_role', null, format('select rlstest.refusal(%L, %L, true)', :'S1', :'code_late'), 'value:P0001:already_covered:pro');
select rlstest.expect('S1: a Pro code',                 'service_role', null, format('select rlstest.redeem(%L, %L)', :'S1', :'code_late'), 'error:P0001:already_covered');
select rlstest.expect('S1: nothing written, not used',  'postgres', null, format('select (select count(*) from public.tester_access where user_id = %L) || $q$/$q$ || uses from public.access_codes where code_hash = public.tester_code_hash(%L)', :'S1', :'code_late'), 'value:0/1');
select rlstest.expect('S1: a Team code is still an upgrade', 'service_role', null, format('select rlstest.redeem(%L, %L, true)', :'S1', :'code_team'), 'value:team');
select rlstest.expect('E (Team seat): a Pro code',      'service_role', null, format('select rlstest.refusal(%L, %L, false)', :'E', :'code_late'), 'value:P0001:already_covered:pro');
select rlstest.expect('E: a Team code (their own Team, with seats)', 'service_role', null, format('select rlstest.redeem(%L, %L, true)', :'E', :'code_team'), 'value:team');

-- A Team tester's members get Team while it lasts.
select rlstest.expect('T4: a Team code',                'service_role', null, format('select rlstest.redeem(%L, %L)', :'T4', :'code_team4'), 'value:team');
select rlstest.expect('M (on T4''s team): Team',        'postgres', null, format('select public.effective_plan(%L)', :'M'), 'value:team');
select rlstest.expect('M: a 60 MB document on Team',    'authenticated', :'M', format('insert into public.documents (owner_id, name, storage_path, size_bytes) values (%L, %L, %L, %s)', :'M', 'm1', :'M' || '/m1.pdf', 62914560), 'rows:1');
select rlstest.expect('T4: tester time over',          'postgres', null, format('select rlstest.plan_with(%L, now(), null)', :'T4'), 'value:free');
select rlstest.expect('M: Free again with it',          'postgres', null, format('select public.effective_plan(%L)', :'M'), 'value:free');

-- Two people redeeming a one-use code at the same moment: the second waits
-- for the first, then finds it used up.
select rlstest.dblink_connect('race1', :'race_conn');
select rlstest.dblink_connect('race2', :'race_conn');
select rlstest.dblink_exec('race1', 'begin');
select rlstest.dblink_exec('race1', 'set local role service_role');
select rlstest.dblink_exec('race2', 'set role service_role');
select * from rlstest.dblink('race1', format('select public.redeem_tester_code(%L, %L)::text', :'T2', :'code_race')) as t(r text);
select rlstest.dblink_send_query('race2', format('select public.redeem_tester_code(%L, %L) ->> %L', :'A', :'code_race', 'plan'));
select pg_sleep(0.5);
select rlstest.expect('race: the second one waits',     'postgres', null, 'select rlstest.dblink_is_busy($q$race2$q$)', 'value:1');
select rlstest.dblink_exec('race1', 'commit');
select rlstest.expect('race: then finds it used up',    'postgres', null, 'select rlstest.race_result($q$race2$q$)', 'value:error:code_used_up');
select rlstest.expect('race: one use, one redemption',  'postgres', null, format('select c.uses || $q$/$q$ || (select count(*) from public.access_code_redemptions r where r.code_id = c.id) from public.access_codes c where c.code_hash = public.tester_code_hash(%L)', :'code_race'), 'value:1/1');
select rlstest.expect('race: T2 has Pro, A has nothing', 'postgres', null, format('select public.effective_plan(%L) || public.effective_plan(%L)', :'T2', :'A'), 'value:profree');

-- One person redeeming two codes at the same moment: the second waits for
-- the first, and both codes' days count.
select rlstest.dblink_exec('race1', 'begin');
select rlstest.dblink_exec('race1', 'set local role service_role');
select * from rlstest.dblink('race1', format('select public.redeem_tester_code(%L, %L)::text', :'T7', :'code_r30')) as t(r text);
select rlstest.dblink_send_query('race2', format('select public.redeem_tester_code(%L, %L) ->> %L', :'T7', :'code_r5', 'plan'));
select pg_sleep(0.5);
select rlstest.expect('same person, two codes: the second waits', 'postgres', null, 'select rlstest.dblink_is_busy($q$race2$q$)', 'value:1');
select rlstest.dblink_exec('race1', 'commit');
select rlstest.expect('same person, two codes: then redeems', 'postgres', null, 'select rlstest.race_result($q$race2$q$)', 'value:value:pro');
select rlstest.expect('same person, two codes: 35 days of Pro', 'postgres', null, format('select rlstest.days_left(%L, %L) between 34.99 and 35', :'T7', 'pro'), 'value:true');
select rlstest.dblink_disconnect('race1');
select rlstest.dblink_disconnect('race2');

-- Revoking: the owner can also end the access it gave, of that code's plan.
select rlstest.expect('owner: revoke the Team code and end its access', 'postgres', null, format('select access_ended from public.revoke_tester_code(%L, end_access => true)', (select left(c.id::text, 8) from public.access_codes c where c.code_hash = public.tester_code_hash(:'code_team'))), 'value:2');
select rlstest.expect('T1: back to Free',               'postgres', null, format('select public.effective_plan(%L)', :'T1'), 'value:free');
select rlstest.expect('T3: back to paid Pro',           'postgres', null, format('select public.effective_plan(%L)', :'T3'), 'value:pro');
select rlstest.expect('T3: Pro tester time after it is kept', 'postgres', null, format('select pro_until = %L from public.tester_access where user_id = %L', '2030-01-06T00:00:00Z', :'T3'), 'value:true');
select rlstest.expect('owner: end a Pro code''s access',  'postgres', null, format('select access_ended from public.revoke_tester_code(%L, end_access => true)', :'code_mix'), 'value:2');
select rlstest.expect('T6: its Pro time ended, its Team time runs on', 'postgres', null, format('select public.effective_plan(%L) || rlstest.days_left(%L, %L)::int || $q$/$q$ || rlstest.days_left(%L, %L)::int', :'T6', :'T6', 'team', :'T6', 'pro'), 'value:team14/0');
select rlstest.expect('T2: the revoked code is refused', 'service_role', null, format('select rlstest.redeem(%L, %L)', :'T2', :'code_team'), 'error:P0001:invalid_code');
select rlstest.expect('owner: listed as revoked, with who used it', 'postgres', null, format('select status || $q$ $q$ || used_by from public.list_tester_codes() where note = %L', 'Team trial'), 'value:revoked tess@example.com, tina@example.com');

-- ---------- Schema-wide rules ----------
select rlstest.expect('every public table has RLS on',  'postgres', null,
  $$select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity$$, 'value:0');
select rlstest.expect('no policy is simply "true"',     'postgres', null,
  $$select count(*) from pg_policies where schemaname in ('public', 'storage')
     and (coalesce(qual, '') ~* '^\(?true\)?$' or coalesce(with_check, '') ~* '^\(?true\)?$')$$, 'value:0');
select rlstest.expect('every public function pins search_path', 'postgres', null,
  $$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')$$, 'value:0');
select rlstest.expect('no SECURITY DEFINER function callable by browsers', 'postgres', null,
  $$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))$$, 'value:0');
select rlstest.expect('documents bucket is private',    'postgres', null, 'select public from storage.buckets where id = $q$documents$q$', 'value:false');
-- RLS is the main lock; table privileges are the second. With the anon key
-- alone nothing in public is reachable, even with RLS off on a table.
select rlstest.expect('anon has no privilege on any public table or view', 'postgres', null,
  $$select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')$$, 'value:0');
-- ---------- Added later, by hand in the SQL editor (as the owner) ----------
-- Supabase's defaults would give a new table to every signed-in user and a
-- new function to everyone, and anyone can sign up.
\set audit_sql `cat supabase/audit.sql`
select format('create view rlstest.audit as %s', rtrim(:'audit_sql', E'; \n\t')) \gexec
select rlstest.expect('audit (supabase/audit.sql): nothing open', 'postgres', null, 'select count(*) from rlstest.audit', 'value:0');

select rlstest.expect('owner: add a notes table, no RLS asked for', 'postgres', null, 'create table public.rlstest_notes (id serial, email text, note text)', 'rows:0');
insert into public.rlstest_notes (email, note) values ('victim@example.com', 'card ending 4242');
select rlstest.expect('  it gets RLS by itself',           'postgres', null, $$select relrowsecurity from pg_class where oid = 'public.rlstest_notes'::regclass$$, 'value:true');
select rlstest.expect('  anon reads it',                   'anon', null, 'select count(*) from public.rlstest_notes', 'denied');
select rlstest.expect('  any signed-up user reads it',     'authenticated', :'A', 'select count(*) from public.rlstest_notes', 'denied');
select rlstest.expect('  any signed-up user writes it',    'authenticated', :'A', 'insert into public.rlstest_notes (email) values ($q$x$q$)', 'denied');
select rlstest.expect('  owner switches RLS off',          'postgres', null, 'alter table public.rlstest_notes disable row level security', 'denied');
select rlstest.expect('  owner adds a column (allowed)',   'postgres', null, 'alter table public.rlstest_notes add column extra text', 'rows:0');
select rlstest.expect('  created with CREATE TABLE AS',    'postgres', null, 'create table public.rlstest_copy as select * from public.rlstest_notes', 'rows:1');
select rlstest.expect('  that one gets RLS too',           'postgres', null, $$select relrowsecurity from pg_class where oid = 'public.rlstest_copy'::regclass$$, 'value:true');
select rlstest.expect('owner: add a SECURITY DEFINER function', 'postgres', null,
  $$create function public.rlstest_list_emails() returns setof text language sql security definer set search_path = public as 'select email from public.profiles'$$, 'rows:0');
select rlstest.expect('  anon calls it',                   'anon', null, 'select count(*) from public.rlstest_list_emails()', 'denied');
select rlstest.expect('  a signed-in user calls it',       'authenticated', :'A', 'select count(*) from public.rlstest_list_emails()', 'denied');
select rlstest.expect('  CREATE OR REPLACE keeps it closed', 'postgres', null,
  $$create or replace function public.rlstest_list_emails() returns setof text language sql security definer set search_path = public as 'select email from public.profiles'$$, 'rows:0');
select rlstest.expect('  anon calls it again',             'anon', null, 'select count(*) from public.rlstest_list_emails()', 'denied');
select rlstest.expect('owner: add a view of profiles',     'postgres', null, 'create view public.rlstest_people as select id, email from public.profiles', 'rows:0');
select rlstest.expect('  it checks RLS as the reader',     'postgres', null, $$select reloptions::text from pg_class where oid = 'public.rlstest_people'::regclass$$, 'value:{security_invoker=true}');
grant select on public.rlstest_people to authenticated;
select rlstest.expect('  granted: a user sees only self',  'authenticated', :'A', 'select count(*) from public.rlstest_people', 'value:1');
select rlstest.expect('  owner turns security_invoker off', 'postgres', null, 'alter view public.rlstest_people set (security_invoker = false)', 'denied');
select rlstest.expect('a table added later gets nothing for anon or signed-in users', 'postgres', null,
  $$select has_table_privilege('anon', 'public.rlstest_notes', 'select, insert, update, delete')
        or has_table_privilege('authenticated', 'public.rlstest_notes', 'select, insert, update, delete')$$, 'value:false');
select rlstest.expect('audit: still nothing open',         'postgres', null, 'select count(*) from rlstest.audit', 'value:0');

-- The audit names each mistake when the event trigger isn't there to stop it
-- (a project where it couldn't be added, or one where it was dropped).
alter event trigger private_by_default disable;
create table public.rlstest_open (id serial primary key, email text);
grant select, insert on public.rlstest_open to anon;
create function public.rlstest_open_fn() returns int language sql security definer set search_path = public as 'select 1';
create view public.rlstest_open_view as select id, email from public.profiles;
insert into storage.buckets (id, name, public) values ('rlstest_avatars', 'rlstest_avatars', true);
create policy rlstest_avatars_list on storage.objects for select to anon using (bucket_id = 'rlstest_avatars');
select rlstest.expect('audit: table without RLS',          'postgres', null, $$select count(*) from rlstest.audit where problem like 'table without%' and object = 'public.rlstest_open'$$, 'value:1');
select rlstest.expect('audit: anon may read/write it',     'postgres', null, $$select count(*) from rlstest.audit where problem like 'the public key%' and object = 'public.rlstest_open'$$, 'value:1');
select rlstest.expect('audit: callable SECURITY DEFINER',  'postgres', null, $$select count(*) from rlstest.audit where problem like 'SECURITY DEFINER%' and object = 'rlstest_open_fn()'$$, 'value:1');
select rlstest.expect('audit: view that skips RLS',        'postgres', null, $$select count(*) from rlstest.audit where problem like 'view%' and object = 'public.rlstest_open_view'$$, 'value:1');
select rlstest.expect('audit: public bucket',              'postgres', null, $$select count(*) from rlstest.audit where problem like 'public bucket%' and object = 'rlstest_avatars'$$, 'value:1');
select rlstest.expect('audit: storage policy for anon',    'postgres', null, $$select count(*) from rlstest.audit where problem like 'storage policy%'$$, 'value:1');
select rlstest.expect('audit: event trigger off',          'postgres', null, $$select count(*) from rlstest.audit where problem like 'event trigger%'$$, 'value:1');
drop policy rlstest_avatars_list on storage.objects;
delete from storage.buckets where id = 'rlstest_avatars';
drop view public.rlstest_open_view;
drop function public.rlstest_open_fn();
drop table public.rlstest_open;
alter event trigger private_by_default enable;
drop view public.rlstest_people;
drop function public.rlstest_list_emails();
drop table public.rlstest_notes, public.rlstest_copy;
select rlstest.expect('audit: clean again',                'postgres', null, 'select count(*) from rlstest.audit', 'value:0');

-- ---------- Report ----------
\o
\pset format aligned
select n, case when pass then 'ok' else 'FAIL' end as result, name, expected, got
  from rlstest.results order by n;

do $$
declare
  failed int := (select count(*) from rlstest.results where not pass);
  total int := (select count(*) from rlstest.results);
begin
  if failed > 0 then
    raise exception '% of % RLS checks failed', failed, total;
  end if;
  raise notice 'All % RLS checks passed', total;
end $$;
