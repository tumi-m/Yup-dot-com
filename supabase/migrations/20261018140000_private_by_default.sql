-- ============================================================
-- Private by default: tables, views and functions added later.
--
-- Run each migration once, in date order, in the Supabase SQL editor, on a
-- project created from an earlier supabase/schema.sql. Running one again
-- later is safe (scripts/test-rls.sh checks it). A new project only needs
-- supabase/schema.sql, which already includes everything here.
--
-- Supabase gives every new table in public to the signed-in role too, and
-- every new function to everyone, and anyone can sign up. So a table made in
-- the SQL editor without RLS was readable by every account, and a new
-- SECURITY DEFINER function could be called with the public key. From now on:
--   - new tables get Row Level Security switched on as they are created,
--     and it can't be switched off on a table in public;
--   - new views check RLS as the person asking (security_invoker);
--   - browsers get no privilege on new tables, views or sequences, and can't
--     run new functions (CREATE OR REPLACE takes the right away again). To
--     open one up, GRANT it on purpose after creating it, with a policy for
--     the rows; a helper function used inside a policy needs
--     GRANT EXECUTE ... TO authenticated too.
-- Run supabase/audit.sql afterwards: it lists anything still open.
-- ============================================================

-- Visitors without a session get nothing on any table (as in the previous
-- migration, again here in case one was granted since), and new objects get
-- no privileges for visitors or signed-in users unless granted.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- Existing functions: none is called from the browser (the server uses the
-- service role), so nobody else may run them. Functions that belong to an
-- extension are left alone. Triggers still fire: Postgres checks EXECUTE
-- when a trigger is created, not when it runs.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
grant execute on function public.consume_usage(text, text, integer, text) to service_role;
grant execute on function public.refund_usage(text, text, text) to service_role;
grant execute on function public.usage_count(text, text, text) to service_role;

-- Existing tables without RLS get it now (with no policy, only the server's
-- service role can reach them), and existing views check RLS as the caller.
do $$
declare
  t record;
begin
  for t in
    select c.oid::regclass as rel, c.relkind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
       and ((c.relkind in ('r', 'p') and not c.relrowsecurity)
         or (c.relkind = 'v' and not coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false)))
  loop
    if t.relkind = 'v' then
      execute format('alter view %s set (security_invoker = true)', t.rel);
      raise notice 'View % now checks RLS as the caller.', t.rel;
    else
      execute format('alter table %s enable row level security', t.rel);
      raise notice 'Row Level Security switched on for %.', t.rel;
    end if;
  end loop;
end $$;

-- From now on, as each object is created in public.
create or replace function public.private_by_default()
returns event_trigger language plpgsql set search_path = pg_catalog as $$
declare
  obj record;
begin
  for obj in
    select * from pg_event_trigger_ddl_commands()
     where schema_name = 'public' and not in_extension
  loop
    if obj.command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') and obj.object_type = 'table' then
      execute format('alter table %s enable row level security', obj.object_identity);
    elsif obj.command_tag = 'CREATE VIEW' and obj.object_type = 'view' then
      execute format('alter view %s set (security_invoker = true)', obj.object_identity);
    elsif obj.command_tag = 'CREATE MATERIALIZED VIEW' then
      -- No RLS on materialized views: only the server may read them.
      execute format('revoke all on %s from anon, authenticated', obj.object_identity);
    elsif obj.command_tag = 'CREATE FUNCTION' and obj.object_type = 'function' then
      execute format('revoke execute on function %s from public, anon, authenticated', obj.object_identity);
    elsif obj.command_tag = 'ALTER TABLE' and obj.object_type = 'table' then
      if exists (select 1 from pg_class c
                  where c.oid = obj.objid and c.relkind in ('r', 'p') and not c.relrowsecurity) then
        raise exception 'Row Level Security must stay on for %. Add a policy instead of switching it off.', obj.object_identity
          using errcode = '42501';
      end if;
    elsif obj.command_tag = 'ALTER VIEW' and obj.object_type = 'view' then
      if exists (select 1 from pg_class c
                  where c.oid = obj.objid
                    and not coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false)) then
        raise exception 'View % must keep security_invoker, so RLS applies to whoever reads it.', obj.object_identity
          using errcode = '42501';
      end if;
    end if;
  end loop;
end;
$$;
revoke execute on function public.private_by_default() from public, anon, authenticated;

-- Supabase lets the SQL editor's role add event triggers; if a project
-- doesn't, everything above still holds for what exists today, and
-- supabase/audit.sql shows anything added later.
do $$
begin
  drop event trigger if exists private_by_default;
  create event trigger private_by_default on ddl_command_end
    when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'CREATE VIEW', 'CREATE MATERIALIZED VIEW',
                 'CREATE FUNCTION', 'ALTER TABLE', 'ALTER VIEW')
    execute function public.private_by_default();
exception when insufficient_privilege then
  raise warning 'Could not add the private_by_default event trigger (%). Run supabase/audit.sql after every change.', sqlerrm;
end $$;
