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
insert into staff (name, username, password, role, status)
values (
  'Administrator',
  'admin@gmail.com',
  '$2b$10$xWT6EEwWdqEY8fOtch722O.W1GEZ0RgDnj1u3QMEpIKmur/gWlB5m',
  'admin',
  'active'
)
on conflict (username) do nothing;
alter table staff enable row level security;
