-- Avaia Studio: Supabase-only staff authentication fix
-- Run once in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  username text not null unique,
  email text default '',
  password text not null,
  role text not null check (role in ('admin','instructor')),
  bio text default '',
  specialty text default '',
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);

-- Make sure the default admin exists. Password is admin123.
insert into public.staff (name, username, email, password, role, status)
values (
  'Administrator',
  'admin',
  'admin@gmail.com',
  crypt('admin123', gen_salt('bf', 10)),
  'admin',
  'active'
)
on conflict (username) do update set
  email = excluded.email,
  password = excluded.password,
  role = 'admin',
  status = 'active';

alter table public.staff enable row level security;

grant all on table public.staff to service_role;
notify pgrst, 'reload schema';
