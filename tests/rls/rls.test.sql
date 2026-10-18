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

\o /dev/null
-- psql variables are not expanded inside $$ strings, so checks build their
-- SQL with format() and %L.

-- ---------- Anonymous visitor (public anon key, no session) ----------
select rlstest.expect('anon: read profiles',            'anon', null, 'select count(*) from public.profiles', 'value:0');
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
