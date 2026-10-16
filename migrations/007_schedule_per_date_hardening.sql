-- Avaia Studio: harden date-specific schedule behavior.
-- Run once after 006_schedule_per_date.sql.

-- Prevent duplicate sessions for the same class/date/time.
create unique index if not exists ux_schedule_class_date_time
on public.schedule (class_id, session_date, time);

-- Fast lookup for the public schedule page and admin calendar.
create index if not exists idx_schedule_session_date
on public.schedule (session_date);

comment on column public.schedule.session_date is
  'Exact calendar date for this class session. Every row is a one-off session; no automatic weekly recurrence.';
