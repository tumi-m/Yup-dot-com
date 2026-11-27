-- ============================================================
-- Second subscriptions: one checkout link at a time, and a second paid
-- subscription kept for a refund instead of renewing beside the first.
--
-- Run each migration once, in date order, in the Supabase SQL editor, on a
-- project created from an earlier supabase/schema.sql. Running one again
-- later is safe (scripts/test-rls.sh checks it). A new project only needs
-- supabase/schema.sql, which already includes everything here.
--
-- Two checkouts started in two tabs before either was paid could both be
-- paid: Paystack then ran two subscriptions, charging the card twice every
-- month, and the second couldn't be managed. Now the same subscription asked
-- for again within 30 minutes gets the same checkout link
-- (pending_checkouts), and a second one paid anyway isn't applied: its
-- charge is kept here for the owner to refund, and its subscription is
-- stopped in Paystack when Paystack creates it.
-- ============================================================

-- ---------- Checkout links ----------

-- Each account's last subscription checkout link, handed out again for the
-- same plan within 30 minutes.
create table if not exists public.pending_checkouts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  request text not null check (length(request) between 1 and 64),
  reference text not null check (reference ~ '^pw_[0-9a-f]{24}$'),
  url text not null check (url ~ '^https://' and length(url) <= 500),
  created_at timestamptz not null default now()
);

alter table public.pending_checkouts enable row level security;
revoke all on public.pending_checkouts from public, anon, authenticated;
grant select, insert, update, delete on public.pending_checkouts to service_role;
-- No policies: only the server (service role) reads or writes it.

-- ---------- Second subscriptions ----------

-- A subscription's first charge paid while the account already had a live
-- subscription. It was not applied: refund it in Paystack (Transactions,
-- search the reference). subscription_code and stopped_at are filled in
-- once its subscription is stopped so it never renews.
--   select reference, user_id, plan, amount / 100.0 as rand, created_at, subscription_code, stopped_at
--     from public.duplicate_subscription_starts order by created_at desc;
create table if not exists public.duplicate_subscription_starts (
  reference text primary key check (reference ~ '^pw_[0-9a-f]{24}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan text not null check (plan in ('pro', 'team')),
  authorization_hash text check (authorization_hash ~ '^[0-9a-f]{64}$'),
  amount integer not null check (amount >= 0),
  created_at timestamptz not null default now(),
  subscription_code text,
  stopped_at timestamptz
);

create index if not exists duplicate_subscription_starts_user_idx on public.duplicate_subscription_starts (user_id);

alter table public.duplicate_subscription_starts enable row level security;
revoke all on public.duplicate_subscription_starts from public, anon, authenticated;
grant select, insert, update, delete on public.duplicate_subscription_starts to service_role;
-- No policies: only the server (service role) reads or writes it.
