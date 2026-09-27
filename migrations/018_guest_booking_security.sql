-- Avaia Studio: defense-in-depth for public guest booking.
-- The application server uses the Supabase service_role key, so these
-- revokes do not affect the server. They ensure a future accidental RLS
-- policy cannot turn the browser's anonymous Supabase role into a write
-- path for bookings, payments, or member data.

revoke all on table public.bookings,
  public.pending_bookings,
  public.pending_package_purchases,
  public.members,
  public.feedback,
  public.member_packages
  from anon;

revoke insert, update, delete, truncate on table public.bookings,
  public.pending_bookings,
  public.pending_package_purchases,
  public.members,
  public.feedback,
  public.member_packages
  from authenticated;

revoke insert, update, delete, truncate on table public.classes,
  public.memberships,
  public.schedule
  from anon, authenticated;
