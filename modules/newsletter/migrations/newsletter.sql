-- Email list (the newsletter module): who said yes to updates, and a log of what was sent. Safe to run more than once.
--
-- A person can read their own subscription. All changes go through the app's server, which checks who is signed in
-- first. The "unsubscribe_token_hash" is a fingerprint of the person's unsubscribe link, never the link itself.

create table if not exists public.newsletter_subscribers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  -- 'subscribed' (said yes) or 'unsubscribed'. Nobody is emailed unless 'subscribed' and consent_at is set.
  status text not null check (status in ('subscribed', 'unsubscribed')),
  -- When they said yes, and where: 'signup' (the box on the sign-up form) or 'settings'.
  consent_at timestamptz,
  consent_source text check (consent_source is null or consent_source in ('signup', 'settings')),
  unsubscribed_at timestamptz,
  unsubscribe_token_hash text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every update that was sent, for your own records.
create table if not exists public.newsletter_sends (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  body_md text not null,
  sent_by uuid references auth.users (id) on delete set null,
  test boolean not null default false,
  recipients integer not null default 0,
  sent_at timestamptz not null default now()
);

create index if not exists newsletter_sends_sent_at_idx on public.newsletter_sends (sent_at desc);

alter table public.newsletter_subscribers enable row level security;
alter table public.newsletter_sends enable row level security;

-- Start from nothing, then give back only what is needed.
revoke all on public.newsletter_subscribers, public.newsletter_sends from anon, authenticated;
grant select on public.newsletter_subscribers to authenticated;
grant all on public.newsletter_subscribers, public.newsletter_sends to service_role;

drop policy if exists newsletter_subscribers_select_own on public.newsletter_subscribers;
create policy newsletter_subscribers_select_own on public.newsletter_subscribers
  for select to authenticated
  using (user_id = (select auth.uid()));

-- newsletter_sends has no policy on purpose: only the secret key can read or write it.
