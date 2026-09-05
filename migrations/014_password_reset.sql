-- Avaia Studio — forgot / reset password support for member accounts.
-- Run once in Supabase SQL Editor.
--
-- Members log in with a bcrypt hash in members.password_hash (see migration
-- 010) instead of Supabase Auth, so there is no Supabase-provided "forgot
-- password" flow to rely on either. This adds our own reset-token storage:
-- a request for a reset link stores a HASH of a random token (never the
-- token itself) plus an expiry, and the reset endpoint clears both once used
-- so a link only ever works once.
alter table public.members
  add column if not exists reset_token_hash text,
  add column if not exists reset_token_expires timestamptz;

create index if not exists idx_members_reset_token_hash
  on public.members (reset_token_hash);

notify pgrst, 'reload schema';
