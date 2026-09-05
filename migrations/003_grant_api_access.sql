-- Run this in Supabase → SQL Editor.
--
-- Fixes: "Could not find the table 'public.xxx' in the schema cache"
--
-- Since around April 2026, Supabase no longer automatically exposes newly
-- created tables to the Data API (PostgREST) — they need an explicit GRANT
-- first, then a schema cache reload. This is a platform-level change, not
-- something specific to this project's schema.
--
-- This version skips any table that doesn't exist yet instead of failing
-- outright, and prints a NOTICE for each one it skips — check the
-- "Messages" / output panel after running this to see if anything is
-- missing. If something is skipped, re-run migrations/000_full_schema.sql
-- first (it's safe to re-run), then run this file again.
--
-- Safe to re-run any time (e.g. after adding a new table later).

do $$
declare
  t text;
  tables text[] := array[
    'classes','schedule','memberships','members','bookings',
    'pending_bookings','member_packages','pending_package_purchases',
    'feedback','notifications','settings','staff'
  ];
begin
  grant usage on schema public to anon, authenticated, service_role;

  foreach t in array tables loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      execute format('grant all on table public.%I to service_role', t);
      raise notice 'Granted: %', t;
    else
      raise notice 'SKIPPED (table does not exist yet): %', t;
    end if;
  end loop;
end $$;

grant usage, select on all sequences in schema public to service_role;

notify pgrst, 'reload schema';
