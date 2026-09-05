-- Avaia Studio — remove the legacy members -> auth.users foreign key.
-- Run once in Supabase SQL Editor.
--
-- WHY: members.id used to always equal the Supabase Auth user id for that
-- member (from the old email-confirmation signup flow), and at some point a
-- foreign key ("members_id_fkey") was added — most likely by hand in the
-- Supabase dashboard's Table Editor rather than in a tracked migration —
-- requiring every members.id to exist in auth.users.id.
--
-- Migration 010 changed registration to be fully independent of Supabase
-- Auth: POST /api/auth/register now generates its own random id (uuidv4())
-- for every new member and stores the password as members.password_hash.
-- That id has no corresponding auth.users row, so the old constraint now
-- rejects every new signup with:
--   insert or update on table "members" violates foreign key
--   constraint "members_id_fkey"
--
-- This drops that constraint. It does not delete any data or change any
-- existing member's id — it only stops requiring members.id to also exist
-- in auth.users, which is no longer how member accounts are created.
alter table public.members
  drop constraint if exists members_id_fkey;

notify pgrst, 'reload schema';
