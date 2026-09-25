-- Avaia Studio: prevent duplicate checkout rows and invalid money/credit data.
-- Apply after migrations/016_manual_membership_idempotency.sql.
-- Existing production duplicates must be reviewed/cleaned before these unique
-- indexes are applied; the current database was audited and cleaned first.

create unique index if not exists classes_name_normalized_uidx
  on public.classes (lower(btrim(name)));

create unique index if not exists memberships_name_normalized_uidx
  on public.memberships (lower(btrim(name)));

create unique index if not exists pending_bookings_identity_schedule_uidx
  on public.pending_bookings (
    schedule_id,
    lower(btrim(email)),
    lower(btrim(name)),
    regexp_replace(coalesce(phone,''),'\D','','g')
  )
  where schedule_id is not null
    and coalesce(status,'pending') not like 'cancelled%';

create unique index if not exists bookings_identity_schedule_uidx
  on public.bookings (
    schedule_id,
    lower(btrim(email)),
    lower(btrim(name)),
    regexp_replace(coalesce(phone,''),'\D','','g')
  )
  where schedule_id is not null
    and coalesce(status,'confirmed') not like 'cancelled%'
    and coalesce(status,'confirmed') <> 'rejected';

create index if not exists bookings_member_id_idx on public.bookings(member_id);
create index if not exists bookings_schedule_id_idx on public.bookings(schedule_id);

alter table public.pending_package_purchases
  add column if not exists request_fingerprint text;

create unique index if not exists pending_package_request_fingerprint_uidx
  on public.pending_package_purchases(request_fingerprint)
  where request_fingerprint is not null
    and coalesce(status,'pending') not like 'cancelled%';

alter function public.decrement_slots(uuid) set search_path to public;
alter function public.increment_slots(uuid) set search_path to public;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='classes_price_positive_chk' and conrelid='public.classes'::regclass) then
    alter table public.classes add constraint classes_price_positive_chk check (price > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='classes_capacity_positive_chk' and conrelid='public.classes'::regclass) then
    alter table public.classes add constraint classes_capacity_positive_chk check (capacity > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='memberships_price_positive_chk' and conrelid='public.memberships'::regclass) then
    alter table public.memberships add constraint memberships_price_positive_chk check (price > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='memberships_credits_positive_chk' and conrelid='public.memberships'::regclass) then
    alter table public.memberships add constraint memberships_credits_positive_chk check (credits > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='memberships_validity_positive_chk' and conrelid='public.memberships'::regclass) then
    alter table public.memberships add constraint memberships_validity_positive_chk check (validity_days > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='member_packages_price_positive_chk' and conrelid='public.member_packages'::regclass) then
    alter table public.member_packages add constraint member_packages_price_positive_chk check (price_paid > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='member_packages_credit_bounds_chk' and conrelid='public.member_packages'::regclass) then
    alter table public.member_packages add constraint member_packages_credit_bounds_chk check (credits_total > 0 and credits_used >= 0 and credits_used <= credits_total);
  end if;
  if not exists (select 1 from pg_constraint where conname='bookings_amount_integrity_chk' and conrelid='public.bookings'::regclass) then
    alter table public.bookings add constraint bookings_amount_integrity_chk check ((payment_type='package_credit' and amount=0) or (amount is not null and amount > 0));
  end if;
end $$;

drop policy if exists "Bookings insert" on public.bookings;
drop policy if exists "Pending insert" on public.pending_bookings;
drop policy if exists "Pending package insert" on public.pending_package_purchases;
drop policy if exists "Members insert own" on public.members;
drop policy if exists "Feedback insert" on public.feedback;

alter policy "Bookings own read" on public.bookings
  to authenticated using ((select auth.uid()) = member_id);
alter policy "Member packages own read" on public.member_packages
  to authenticated using ((select auth.uid()) = member_id);
alter policy "Members read own" on public.members
  to authenticated using ((select auth.uid()) = id);
alter policy "Notifications read own" on public.notifications
  to authenticated using (audience='member' and ((select auth.uid()) = "memberId" or (select auth.email()) = "memberEmail"));

alter policy "Classes public read" on public.classes to anon, authenticated;
alter policy "Memberships public read" on public.memberships to anon, authenticated;
alter policy "Schedule public read" on public.schedule to anon, authenticated;

alter policy "Bookings service all" on public.bookings to service_role using (true) with check (true);
alter policy "Classes service write" on public.classes to service_role using (true) with check (true);
alter policy "Feedback service all" on public.feedback to service_role using (true) with check (true);
alter policy "Member packages service all" on public.member_packages to service_role using (true) with check (true);
alter policy "Members service all" on public.members to service_role using (true) with check (true);
alter policy "Memberships service write" on public.memberships to service_role using (true) with check (true);
alter policy "Notifications service all" on public.notifications to service_role using (true) with check (true);
alter policy "Pending service all" on public.pending_bookings to service_role using (true) with check (true);
alter policy "Pending package service all" on public.pending_package_purchases to service_role using (true) with check (true);
alter policy "Schedule service write" on public.schedule to service_role using (true) with check (true);
