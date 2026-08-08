do $$
declare
  t text;
  tables text[] := array[
    'classes','schedule','memberships','members','bookings',
    'pending_bookings','member_packages','pending_package_purchases',
    'feedback','notifications','settings','staff'
  ];
begin
  grant usage on schema public to anon, authenticated, service_role;

  foreach t in array tables loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      execute format('grant all on table public.%I to service_role', t);
      raise notice 'Granted: %', t;
    else
      raise notice 'SKIPPED (table does not exist yet): %', t;
    end if;
  end loop;
end $$;

grant usage, select on all sequences in schema public to service_role;

notify pgrst, 'reload schema';
