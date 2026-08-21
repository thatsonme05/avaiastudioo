-- Run this once in Supabase → SQL Editor.
-- Creates the staff table (admin & instructor accounts) and seeds the
-- default admin login so you can still get into /admin after migrating.

create table if not exists staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  username    text not null unique,
  email       text default '',
  password    text not null,
  role        text not null check (role in ('admin','instructor')),
  bio         text default '',
  specialty   text default '',
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at  timestamptz not null default now()
);

-- Default admin login: username "admin@gmail.com", password "admin123".
-- Change this password from Admin → Security as soon as you log in.
insert into staff (name, username, password, role, status)
values (
  'Administrator',
  'admin@gmail.com',
  '$2b$10$xWT6EEwWdqEY8fOtch722O.W1GEZ0RgDnj1u3QMEpIKmur/gWlB5m',
  'admin',
  'active'
)
on conflict (username) do nothing;

-- Row Level Security: the app talks to this table using the Supabase secret
-- key (which bypasses RLS), so policies here are a defense-in-depth backstop,
-- not what the app itself relies on. Enabling RLS with no public policies
-- means anon/publishable-key access is blocked entirely by default.
alter table staff enable row level security;
