-- ============================================================
-- Database audit: what a browser could reach that it shouldn't.
--
-- Paste into the Supabase SQL editor and run it after any change made
-- outside supabase/schema.sql and the migrations (a table added by hand, a
-- bucket, a function, a policy). It only reads. No rows means nothing is
-- open; each row names a problem and the object. scripts/test-rls.sh runs
-- it on every push and expects no rows.
--
-- Nothing here is meant to be public. If you ever add something that is (a
-- bucket of public images, say), add its name to the list in that check.
-- ============================================================
with ext as (
  select objid from pg_depend where deptype = 'e'
),
rels as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.reloptions, n.nspname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where (n.nspname = 'public' or (n.nspname = 'storage' and c.relname in ('objects', 'buckets')))
     and c.oid not in (select objid from ext)
),
funcs as (
  select p.oid, p.prosecdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
     and p.oid not in (select objid from ext)
)
select 'table without Row Level Security' as problem, format('%I.%I', nspname, relname) as object
  from rels where relkind in ('r', 'p') and not relrowsecurity
union all
select 'view that skips the reader''s RLS (set security_invoker = true)', format('%I.%I', nspname, relname)
  from rels
 where nspname = 'public' and relkind = 'v'
   and not coalesce(reloptions::text[] && array['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false)
union all
select 'the public key (anon) has a privilege on it', format('%I.%I', nspname, relname)
  from rels
 where nspname = 'public' and relkind in ('r', 'p', 'v', 'm', 'f')
   and has_table_privilege('anon', oid, 'select, insert, update, delete, truncate, references, trigger')
union all
select 'materialized view signed-in users can read (it has no RLS)', format('%I.%I', nspname, relname)
  from rels where nspname = 'public' and relkind = 'm' and has_table_privilege('authenticated', oid, 'select')
union all
select 'SECURITY DEFINER function browsers can call', oid::regprocedure::text
  from funcs
 where prosecdef
   and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))
union all
select 'function the public key (anon) can call', oid::regprocedure::text
  from funcs where not prosecdef and has_function_privilege('anon', oid, 'execute')
union all
select 'policy that lets every row through (true)', format('%s on %I.%I', policyname, schemaname, tablename)
  from pg_policies
 where schemaname in ('public', 'storage')
   and (coalesce(qual, '') ~* '^\(?true\)?$' or coalesce(with_check, '') ~* '^\(?true\)?$')
union all
select 'storage policy for visitors without a session', format('%s on storage.%I', policyname, tablename)
  from pg_policies
 where schemaname = 'storage' and roles && array['anon', 'public']::name[]
union all
select 'public bucket (anyone can download its files by name)', id
  from storage.buckets
 where public and id not in ('')  -- names of buckets meant to be public
union all
select 'new ' || case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' else 'objects' end
       || ' are granted to browsers by default', pg_get_userbyid(d.defaclrole)
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
 where n.nspname = 'public' and pg_get_userbyid(d.defaclrole) = current_user
   and exists (select 1 from aclexplode(d.defaclacl) a
                where a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))
union all
select 'event trigger missing or off: new tables won''t get RLS by themselves', 'private_by_default'
 where not exists (select 1 from pg_event_trigger where evtname = 'private_by_default' and evtenabled <> 'D')
order by 1, 2;
