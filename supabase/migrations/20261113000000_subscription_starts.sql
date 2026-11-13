-- ============================================================
-- Subscription codes go only to the subscription our checkout started.
--
-- Run each migration once, in date order, in the Supabase SQL editor, on a
-- project created from an earlier supabase/schema.sql. Running one again
-- later is safe (scripts/test-rls.sh checks it). A new project only needs
-- supabase/schema.sql, which already includes everything here.
--
-- Paystack keeps one customer per email, so anyone paying with someone's
-- email can start a subscription on their customer. Its subscription.create
-- was taken up by that account's row whenever its own signed first charge
-- was waiting on the same plan, so the account's own cancel was then
-- ignored. Now the create must be paid with the same card as the signed
-- first charge, and this table keeps that card (hashed) per account.
-- ============================================================

-- ---------- Subscription starts ----------

-- A hash of the card authorization of each account's latest signed first
-- subscription charge. The authorization code itself is never stored: with
-- the secret key it can charge the card again.
create table if not exists public.subscription_starts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  authorization_hash text not null check (authorization_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

alter table public.subscription_starts enable row level security;
revoke all on public.subscription_starts from public, anon, authenticated;
grant select, insert, update, delete on public.subscription_starts to service_role;
-- No policies: only the server (service role) reads or writes it.
