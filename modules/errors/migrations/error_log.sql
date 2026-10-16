-- Error log (the errors module): what went wrong behind a friendly message a visitor saw. Safe to run more than once.
--
-- The app's server writes one row per problem (at most one a minute for the same problem). Only the secret server
-- key can read or write this table: privacy rules are on and nobody signed in gets any access. You read it on the
-- /admin/logs page. A row never holds a password, key or whole request.
--
-- Old rows (90 days) are deleted once a day by Supabase Cron when it is switched on. This file tries to switch it
-- on and never fails if it cannot: the scheduled health check deletes old rows too.

create table if not exists public.error_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- Where it happened, for example "api:checkout" or "client".
  area text not null check (char_length(area) <= 100),
  -- Same fingerprint = same problem. The admin page groups by it.
  fingerprint text not null check (char_length(fingerprint) <= 300),
  message text not null check (char_length(message) <= 4000),
  -- The signed-in person it happened to, if any. Set to empty when that account is deleted.
  user_id uuid references auth.users (id) on delete set null,
  detail jsonb,
  -- Set when the owner presses "Mark resolved". A problem that comes back is a new row.
  resolved_at timestamptz
);

create index if not exists error_log_fingerprint_created_idx on public.error_log (fingerprint, created_at desc);
create index if not exists error_log_created_idx on public.error_log (created_at desc);

alter table public.error_log enable row level security;

-- Start from nothing. There is no policy on purpose: only the secret key can use this table.
revoke all on public.error_log from anon, authenticated;
grant all on public.error_log to service_role;

create or replace function public.error_log_delete_old()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.error_log
  where created_at < now() - interval '90 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke execute on function public.error_log_delete_old() from public, anon, authenticated;
grant execute on function public.error_log_delete_old() to service_role;

-- Daily at 03:41 UTC with Supabase Cron (the pg_cron extension). Supabase's own install line is
-- "create extension pg_cron with schema pg_catalog" (or Dashboard, Integrations, Cron). If the extension is not
-- there and cannot be switched on from here, this only prints a notice. Running it again updates the same job.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      execute 'create extension if not exists pg_cron with schema pg_catalog';
    exception when others then
      raise notice 'Could not switch on pg_cron (%). Old error rows are cleaned up by the scheduled health check instead.', sqlerrm;
    end;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      execute 'select cron.schedule(''error-log-retention'', ''41 3 * * *'', ''select public.error_log_delete_old()'')';
    exception when others then
      raise notice 'Could not schedule the daily clean-up (%). Old error rows are cleaned up by the scheduled health check instead.', sqlerrm;
    end;
  else
    raise notice 'pg_cron is not enabled. Old error rows are cleaned up by the scheduled health check instead. To do it in the database, switch on Cron in the Supabase dashboard (Integrations, Cron) and run this file again.';
  end if;
end;
$$;
