-- 0001_profiles.sql
-- One profile row per person: display name, bio, whether they finished setup, and an admin flag.
-- Privacy rules (RLS): people can read and write only their own row, and they cannot make themselves admin.
-- Safe to run more than once.

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  bio text,
  onboarding_complete boolean not null default false,
  is_admin boolean not null default false,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Column-level permissions: a row policy alone cannot stop someone changing `is_admin` on their own row.
-- Signed-in users may write only the columns below; `is_admin` can only be changed from the Supabase dashboard
-- or with the server key.
revoke all on public.profiles from anon;
revoke insert, update on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant insert (id, display_name, bio, onboarding_complete) on public.profiles to authenticated;
grant update (display_name, bio, onboarding_complete) on public.profiles to authenticated;
-- The server (secret key) role needs its own grant: a schema other than public does not give it one automatically.
grant all on public.profiles to service_role;

-- shipyard:auth-trigger:start
-- Creates the profile row automatically when someone signs up.
-- Everything between these two marker lines is left out when the app shares a Supabase project with other apps
-- (Shipyard "shared" mode): a trigger on auth.users runs for every app's sign-ups, so an app there must not add one.
-- The app creates the row itself instead (ensureProfile in src/lib/auth/ensure-profile.ts). Do not add other
-- auth.users triggers, and keep them inside these markers if you ever must.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'User'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
-- shipyard:auth-trigger:end
