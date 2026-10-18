-- ============================================================
-- Free files up to 50 MB in the cloud library.
--
-- Safe to run more than once. Run it in the Supabase SQL editor on a project
-- created from an earlier supabase/schema.sql. (A new project only needs
-- supabase/schema.sql, which already includes everything here.)
--
-- The documents bucket allows 500 MB (the Pro limit) for everyone, and the
-- 50 MB Free limit was only checked in the browser, so a Free account could
-- store files up to 500 MB. Now the database refuses a Free document over
-- 50 MB, and storage refuses the file itself.
-- =====================================================create or replace function public.documents_limit()
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

-- ---------- Storage: the file itself ----------

-- Storage writes the real size into metadata once the file is in, and may
-- write it as the service role, so every write is checked, against the plan
-- of the folder's owner.
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
