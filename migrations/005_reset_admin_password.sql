-- OPTIONAL ONE-TIME ADMIN PASSWORD RESET
-- Run this ONLY if the existing admin password is unknown/wrong.
-- After running it, the admin credentials are:
-- username: admin
-- email: admin@gmail.com
-- password: admin123
-- This script intentionally does not run automatically.

create extension if not exists pgcrypto;

update public.staff
set password = crypt('admin123', gen_salt('bf', 10)),
    email = 'admin@gmail.com',
    role = 'admin',
    status = 'active'
where username = 'admin';

-- If the admin row does not exist, create it.
insert into public.staff (name, username, email, password, role, status)
select 'Administrator', 'admin', 'admin@gmail.com', crypt('admin123', gen_salt('bf', 10)), 'admin', 'active'
where not exists (select 1 from public.staff where username = 'admin');

notify pgrst, 'reload schema';
