-- Avaia Studio — Payment flow hardening
-- Run once after the existing migrations.
-- Makes paid transactions idempotent, protects class capacity under concurrency,
-- and prevents membership credits from being consumed twice by duplicate webhooks.

alter table public.member_packages
  add column if not exists payment_order_id text;

alter table public.bookings
  add column if not exists package_credit_redeemed boolean not null default false;

alter table public.pending_bookings
  add column if not exists slot_reserved boolean not null default false,
  add column if not exists slot_released boolean not null default false;

create unique index if not exists member_packages_payment_order_id_uidx
  on public.member_packages(payment_order_id)
  where payment_order_id is not null;

-- Atomically reserve one slot. Returns true only when a slot was actually reserved.
create or replace function public.reserve_slot(sched_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed boolean;
begin
  update public.schedule
     set slots = slots - 1
   where id = sched_id
     and slots > 0;
  changed := found;
  return changed;
end;
$$;

-- Atomically release one previously reserved slot.
create or replace function public.release_slot(sched_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.schedule
     set slots = slots + 1
   where id = sched_id;
  return found;
end;
$$;

-- Atomically redeem exactly one package credit. It fails when the package is
-- expired, inactive, or already depleted.
create or replace function public.redeem_package_credit(pkg_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.member_packages
     set credits_used = credits_used + 1
   where id = pkg_id
     and status = 'active'
     and credits_used < credits_total
     and (expires_at is null or expires_at > now());
  return found;
end;
$$;

-- Restore one credit safely when a package-credit booking is cancelled.
create or replace function public.refund_package_credit(pkg_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.member_packages
     set credits_used = greatest(credits_used - 1, 0)
   where id = pkg_id;
  return found;
end;
$$;

-- The app uses the server-side secret key, so these functions are not intended
-- as a public client API. Restrict direct execution from exposed roles.
revoke all on function public.reserve_slot(uuid) from public, anon, authenticated;
revoke all on function public.release_slot(uuid) from public, anon, authenticated;
revoke all on function public.redeem_package_credit(uuid) from public, anon, authenticated;
revoke all on function public.refund_package_credit(uuid) from public, anon, authenticated;

grant execute on function public.reserve_slot(uuid) to service_role;
grant execute on function public.release_slot(uuid) to service_role;
grant execute on function public.redeem_package_credit(uuid) to service_role;
grant execute on function public.refund_package_credit(uuid) to service_role;
