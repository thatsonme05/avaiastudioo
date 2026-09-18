-- Avaia Studio — deterministic member login
-- Run once in Supabase SQL Editor.
alter table if exists public.members
  add column if not exists password_hash text;

create index if not exists idx_members_email_lower
  on public.members (lower(email));

create index if not exists idx_members_name_lower
  on public.members (lower(name));

-- Force PostgREST to pick up the new column immediately instead of waiting
-- for its next automatic schema-cache refresh.
notify pgrst, 'reload schema';
