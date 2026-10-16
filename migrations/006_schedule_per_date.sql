-- Avaia Studio: schedule sessions are date-specific.
-- Run once in Supabase SQL Editor. Existing recurring rows are assigned to their
-- next calendar occurrence based on the stored weekday, so they become one-off
-- sessions instead of repeating every week. New sessions must provide session_date.

alter table public.schedule
  add column if not exists session_date date;

update public.schedule
set session_date = case day
  when 'Sunday' then current_date + ((0 - extract(dow from current_date)::int + 7) % 7)
  when 'Monday' then current_date + ((1 - extract(dow from current_date)::int + 7) % 7)
  when 'Tuesday' then current_date + ((2 - extract(dow from current_date)::int + 7) % 7)
  when 'Wednesday' then current_date + ((3 - extract(dow from current_date)::int + 7) % 7)
  when 'Thursday' then current_date + ((4 - extract(dow from current_date)::int + 7) % 7)
  when 'Friday' then current_date + ((5 - extract(dow from current_date)::int + 7) % 7)
  when 'Saturday' then current_date + ((6 - extract(dow from current_date)::int + 7) % 7)
  else current_date
end
where session_date is null;

create index if not exists idx_schedule_session_date_time
on public.schedule(session_date, time);

comment on column public.schedule.session_date is
  'Exact calendar date for this class session. New schedule entries are one-off sessions and do not repeat automatically.';
