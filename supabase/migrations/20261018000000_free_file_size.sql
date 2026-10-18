-- ============================================================
-- Free plan file size (50 MB) for the cloud library.
--
-- Safe to run more than once. Run it in the Supabase SQL editor on a project
-- created from an earlier supabase/schema.sql. (A new project only needs
-- supabase/schema.sql, which already includes everything here.)
--
-- The documents bucket allows 500 MB (the Pro limit), and only the browser
-- checked the Free plan's 50 MB, so a Free account could keep files up to
-- 500 MB. Now a Free account's document row may not claim more than 50 MB,
-- and a file over 50 MB can't be stored for it, whatever its row says.
-- ============================================================

-- The Free plan keeps 5 cloud documents of up to 50 MB each (lib/limits.ts);
-- this used to be enforced only in the browser.
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
      raise exception 'The Free plan keeps files up to 50 MB. Upgrade for larger files.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_limit on public.documents;
create trigger documents_limit
  before insert on public.documents
  for each row execute function public.documents_limit();

-- The stored file itself, whatever size its row claims: Storage records the
-- size in metadata when it saves a file (as its own role, so no role check).
-- The bucket allows 500 MB, the Pro limit.
create or replace function public.documents_file_size()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  folder text := split_part(new.name, '/', 1);
  bytes text := new.metadata ->> 'size';
begin
  if new.bucket_id is distinct from 'documents' or coalesce(bytes, '') !~ '^[0-9]{1,18}$'
     or folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return new;
  end if;
  if bytes::bigint > 52428800 and public.effective_plan(folder::uuid) = 'free' then
    raise exception 'The Free plan keeps files up to 50 MB. Upgrade for larger files.' using errcode = 'P0001';
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
