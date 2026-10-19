-- ============================================================
-- Security hardening: stored files and document privileges.
--
-- Run each migration once, in date order, in the Supabase SQL editor, on a
-- project created from an earlier supabase/schema.sql. Running one again
-- later is safe (scripts/test-rls.sh checks it). A new project only needs
-- supabase/schema.sql, which already includes everything here.
--
-- Before this, a signed-in Free user could keep any number of files in the
-- documents bucket: the 5-document limit counts rows, and deleting a row (or
-- pointing it at another path) left its file behind, still readable by its
-- owner. Now a row can't be moved, can only be deleted after its file, and a
-- file without a row can't be read or signed.
--
-- Also: no privileges on documents for visitors without a session, no
-- TRUNCATE for anyone in the browser (RLS doesn't apply to it), and a fixed
-- search_path on the two remaining trigger functions.
--
-- Files already left behind stay in the bucket. To list them:
--   select o.name, o.created_at, (o.metadata ->> 'size')::bigint as bytes
--     from storage.objects o
--    where o.bucket_id = 'documents'
--      and not exists (select 1 from public.documents d where d.storage_path = o.name);
-- and delete them from the Storage page of the Supabase dashboard (or with
-- the service role through the Storage API), not with SQL.
-- ============================================================

-- ---------- documents: who may write what ----------

revoke all on public.documents from anon;
revoke all on public.documents from authenticated;
grant select, insert, delete on public.documents to authenticated;
grant update (name, size_bytes, page_count, updated_at) on public.documents to authenticated;

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

-- ---------- Storage: a file is readable only while its document exists ----------

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

-- ---------- Fixed search_path on trigger functions ----------

alter function public.set_updated_at() set search_path = public;
alter function public.team_members_limit() set search_path = public;
