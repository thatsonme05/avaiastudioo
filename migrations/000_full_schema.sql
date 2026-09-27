-- ═══════════════════════════════════════════════════════════
-- Avaia Studio — Complete Supabase Schema
-- Run this once in Supabase → SQL Editor.
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE,
-- so running it again later won't touch tables that already exist
-- or data that's already there.
-- ═══════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- CLASSES ------------------------------------------------------
create table if not exists classes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  instructor text not null,
  level      text not null default 'All Levels',
  duration   text not null default '60 minutes',
  capacity   integer not null default 12,
  price      integer not null default 0
);

-- SCHEDULE -------------------------------------------------------
create table if not exists schedule (
  id       uuid primary key default gen_random_uuid(),
  day      text not null,
  class_id uuid references classes(id) on delete cascade,
  time     text not null,
  slots    integer not null default 0
);

-- MEMBERSHIPS (packages for sale on /pricing) ---------------------
create table if not exists memberships (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  price         integer not null default 0,
  duration      text default '',
  credits       integer not null default 1,
  validity_days integer not null default 30,
  features      text[] default '{}',
  status        text not null default 'active'
);

-- MEMBERS (profile row — id matches the Supabase Auth user id) ---
create table if not exists members (
  id              uuid primary key,
  name            text not null,
  email           text not null,
  phone           text default '',
  joined          timestamptz not null default now(),
  membership_type text default 'drop-in',
  status          text not null default 'active'
);

-- BOOKINGS ---------------------------------------------------------
-- id is text, not uuid — it's either a Midtrans order id or a short
-- "b########" id from Excel import, set by the app itself.
create table if not exists bookings (
  id                text primary key,
  name              text not null,
  email             text not null,
  phone             text default '',
  class             text not null,
  date              text not null,
  time              text not null,
  note              text default '',
  schedule_id       uuid references schedule(id) on delete set null,
  member_id         uuid references members(id) on delete set null,
  member_package_id uuid,
  status            text not null default 'confirmed',
  amount            integer default 0,
  payment_type      text default '',
  paid_at           timestamptz,
  created_at        timestamptz not null default now()
);

-- PENDING_BOOKINGS (created on checkout, removed once paid) --------
create table if not exists pending_bookings (
  id          text primary key,
  name        text not null,
  email       text not null,
  phone       text default '',
  class       text not null,
  date        text not null,
  time        text not null,
  note        text default '',
  schedule_id uuid references schedule(id) on delete set null,
  member_id   uuid references members(id) on delete set null,
  status      text not null default 'pending',
  amount      integer default 0,
  created_at  timestamptz not null default now()
);

-- MEMBER_PACKAGES (a member's active, paid-for package) -------------
create table if not exists member_packages (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid references members(id) on delete cascade,
  member_email  text,
  member_name   text,
  package_name  text not null,
  price_paid    integer default 0,
  credits_total integer not null default 1,
  credits_used  integer not null default 0,
  payment_type  text default '',
  purchased_at  timestamptz not null default now(),
  expires_at    timestamptz,
  status        text not null default 'active'
);

-- PENDING_PACKAGE_PURCHASES (created on checkout, removed once paid) -
create table if not exists pending_package_purchases (
  id            text primary key,
  member_id     uuid references members(id) on delete set null,
  member_email  text,
  member_name   text,
  member_phone  text default '',
  package_id    uuid references memberships(id) on delete set null,
  package_name  text not null,
  price         integer default 0,
  credits_total integer not null default 1,
  validity_days integer not null default 30,
  status        text not null default 'pending',
  created_at    timestamptz not null default now()
);

-- FEEDBACK -----------------------------------------------------------
create table if not exists feedback (
  id         uuid primary key default gen_random_uuid(),
  name       text default 'Anonymous',
  email      text default '',
  type       text default 'suggestion',
  message    text not null,
  rating     integer,
  status     text not null default 'unread',
  created_at timestamptz not null default now()
);

-- NOTIFICATIONS (admin bell icon) --------------------------------------
-- Quoted, camelCase column names — this matches the exact keys the
-- app sends (lib/notify.js), so leave the quotes as-is.
create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  audience      text not null,
  "memberId"    uuid,
  "memberEmail" text,
  type          text default 'info',
  title         text not null,
  message       text not null,
  link          text,
  read          boolean not null default false,
  created_at    timestamptz not null default now()
);

-- SETTINGS (single row of studio configuration) --------------------------
-- Also quoted camelCase, matching the app's settings object exactly.
create table if not exists settings (
  id             int primary key default 1,
  "studioName"   text default 'Avaia Studio',
  tagline        text default 'Find peace in every movement',
  "primaryColor" text default '#5D3A24',
  "accentColor"  text default '#9C6B3D',
  "bgColor"      text default '#FDF8F6',
  "heroImage"    text,
  "heroImage2"   text,
  "heroImage3"   text,
  "aboutImage"   text,
  address        text default '',
  phone          text default '',
  email          text default '',
  hours          text default '',
  "mapEmbed"     text default '',
  about1         text default '',
  about2         text default '',
  about3         text default '',
  constraint settings_single_row check (id = 1)
);
insert into settings (id) values (1) on conflict (id) do nothing;

-- FUNCTIONS ------------------------------------------------------------
-- Atomic slot adjustment — avoids a race condition where two people
-- booking the same slot at the same instant could both succeed.
create or replace function decrement_slots(sched_id uuid)
returns void as $$
begin
  update schedule set slots = greatest(slots - 1, 0) where id = sched_id;
end;
$$ language plpgsql;

create or replace function increment_slots(sched_id uuid)
returns void as $$
begin
  update schedule set slots = slots + 1 where id = sched_id;
end;
$$ language plpgsql;

-- SECURITY ---------------------------------------------------------------
-- The app talks to Supabase using the secret key, which bypasses RLS —
-- so the app itself doesn't depend on these policies. Enabling RLS with
-- no permissive policies just means the anon/publishable key (if it ever
-- leaked, or if you add client-side Supabase access later) can't read or
-- write anything by default. Defense in depth, not something the app needs.
alter table classes                     enable row level security;
alter table schedule                    enable row level security;
alter table memberships                 enable row level security;
alter table members                     enable row level security;
alter table bookings                    enable row level security;
alter table pending_bookings            enable row level security;
alter table member_packages             enable row level security;
alter table pending_package_purchases   enable row level security;
alter table feedback                    enable row level security;
alter table notifications               enable row level security;
alter table settings                    enable row level security;
