-- ============================================================
-- No table privileges for visitors without a session.
--
-- Run each migration once, in date order, in the Supabase SQL editor, on a
-- project created from an earlier supabase/schema.sql. Running one again
-- later is safe (scripts/test-rls.sh checks it). A new project only needs
-- supabase/schema.sql, which already includes everything here.
--
-- Supabase grants every new table to the anon role (the public key every
-- browser has). profiles kept that SELECT, so it was private only while RLS
-- was on: switching RLS off on it would have shown every user's email and
-- Paystack codes to anyone with the anon key. The app never reads a table
-- without a signed-in user, so anon now gets nothing on any table here, or
-- on tables created later from the SQL editor.
-- ============================================================

revoke all on public.profiles from anon;
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
