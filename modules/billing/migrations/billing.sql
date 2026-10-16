-- Payments (the billing module): who is a Stripe customer, what plan they have, and which Stripe messages were handled.
-- Safe to run more than once.
--
-- People can read their own rows and nothing else. Nobody signed in or signed out can add, change or delete a row:
-- only the app's server, using the secret key after it has checked a message really came from Stripe.

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- The plan id from src/lib/billing/plans.ts.
  plan_id text not null,
  -- Stripe's word for the state: active, trialing, past_due, canceled, unpaid, ...
  status text not null check (status ~ '^[a-z_]{1,40}$'),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  stripe_subscription_id text unique,
  -- Stripe's time stamp of the last message applied. An older message never overwrites newer data.
  updated_from_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ids of the Stripe messages already handled, so a message that arrives twice is only applied once.
create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.stripe_events enable row level security;

-- Start from nothing, then give back only what is needed.
revoke all on public.billing_customers, public.subscriptions, public.stripe_events from anon, authenticated;
grant select on public.billing_customers, public.subscriptions to authenticated;
grant all on public.billing_customers, public.subscriptions, public.stripe_events to service_role;

drop policy if exists billing_customers_select_own on public.billing_customers;
create policy billing_customers_select_own on public.billing_customers
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()));

-- stripe_events has no policy on purpose: only the secret key can read or write it.
