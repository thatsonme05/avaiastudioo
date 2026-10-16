-- Avaia Studio: make manual membership activation idempotent under races.
-- Run after migrations/009_manual_membership_admin.sql.

alter table public.member_packages
  add column if not exists manual_fingerprint text;

-- Existing manual rows intentionally remain NULL and are not changed or
-- merged here. New rows receive a fingerprint from server.js; the partial
-- index blocks only exact duplicate submissions going forward.
create unique index if not exists member_packages_manual_fingerprint_uidx
  on public.member_packages(manual_fingerprint)
  where manual_fingerprint is not null;
