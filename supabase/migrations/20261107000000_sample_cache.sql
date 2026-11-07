-- ============================================================
-- Sample Finder cache.
--
-- Run each migration once, in date order, in the Supabase SQL editor, on a
-- project created from an earlier supabase/schema.sql. Running one again
-- later is safe (scripts/test-rls.sh checks it). A new project only needs
-- supabase/schema.sql, which already includes everything here.
--
-- The Sample Finder caches what it reads from YouTube (a video's title) and
-- MusicBrainz (searches and a song's connections), so a song looked up once
-- answers at once for everyone for a while, and MusicBrainz is asked as
-- little as possible. Without this table the cache is per server instance.
-- ============================================================

-- ---------- Sample Finder cache ----------

-- Video titles from YouTube and MusicBrainz answers, keyed by the video or
-- song only (yt:<id>, mbq:<hash of the query>, mbrec:<id>), and the pause after
-- MusicBrainz refuses (mb:pause): who asked is never stored.
-- Expired rows are deleted when read, and now and then all at once.
create table if not exists public.sample_cache (
  key text primary key check (length(key) between 1 and 400),
  value jsonb not null,
  expires_at timestamptz not null
);

create index if not exists sample_cache_expires_at_idx on public.sample_cache (expires_at);

alter table public.sample_cache enable row level security;
revoke all on public.sample_cache from public, anon, authenticated;
grant select, insert, update, delete on public.sample_cache to service_role;
-- No policies: only the server (service role) reads or writes it.
