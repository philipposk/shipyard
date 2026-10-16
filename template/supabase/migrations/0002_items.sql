-- 0002_items.sql
-- Example table: a personal list. Every row belongs to one person, and only that person can see or change it.
-- Copy this pattern for each new table: user_id column, RLS on, one policy per action, an index on user_id,
-- and an entry in supabase/isolation.json so `verify` tests it.
-- Safe to run more than once.

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  created_at timestamptz default now()
);

alter table public.items enable row level security;

drop policy if exists "items select own" on public.items;
create policy "items select own" on public.items
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "items insert own" on public.items;
create policy "items insert own" on public.items
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "items update own" on public.items;
create policy "items update own" on public.items
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "items delete own" on public.items;
create policy "items delete own" on public.items
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.items from anon;
grant select, insert, update, delete on public.items to authenticated;

create index if not exists items_user_id_idx on public.items (user_id);
