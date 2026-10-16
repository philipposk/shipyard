-- 0003_email_lookup.sql
-- Server-only helper: find a user's id from their email. Only the secret server key (service_role) may call it;
-- the browser's public key cannot, so nobody can use it to check which emails have accounts.
-- Safe to run more than once.

create or replace function public.auth_user_id_by_email(email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users as u where lower(u.email) = lower(trim($1)) limit 1;
$$;

revoke execute on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;
