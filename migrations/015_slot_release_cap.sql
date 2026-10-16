-- Avaia Studio: prevent a repeated/late cancellation from increasing a
-- session's available slots beyond the class capacity.
-- Run after migrations/008_payment_flow_hardening.sql.

create or replace function public.release_slot(sched_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.schedule s
     set slots = least(
       s.slots + 1,
       coalesce(
         (select c.capacity from public.classes c where c.id = s.class_id),
         s.slots + 1
       )
     )
   where s.id = sched_id;
  return found;
end;
$$;

revoke all on function public.release_slot(uuid) from public, anon, authenticated;
grant execute on function public.release_slot(uuid) to service_role;
