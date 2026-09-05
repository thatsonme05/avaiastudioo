# Avaia Studio — deterministic member login fix (2026-08-24)

## What changed
Member registration/login no longer depends on Supabase Auth email confirmation.
A member password is stored only as a bcrypt hash in `members.password_hash`.

## Required Supabase SQL
Run:

```sql
alter table if exists public.members
  add column if not exists password_hash text;
create index if not exists idx_members_email_lower on public.members (lower(email));
create index if not exists idx_members_name_lower on public.members (lower(name));
```

The exact SQL is also in `migrations/010_member_password_hash.sql`.

## Hostinger deployment
1. Upload the project files from this ZIP to the SAME Node.js application directory that actually runs Avaia Studio.
2. Restart/redeploy the Node.js application.
3. Open:
   `/api/auth/diagnostic`
4. Confirm the JSON contains:
   - `build`: `member-login-deterministic-20260824-01`
   - `supabase`: `true`
   - `membersPasswordColumn`: `true`
5. Create a brand-new account from the website and then log in using the same email/password.

## Important
Do not copy the `public` folder from an older ZIP over this project after deployment. The frontend and backend must come from this same build.
