-- Add week-based scheduling to weekly_sessions without deleting existing data
alter table public.weekly_sessions
  add column if not exists week_start_date date;

-- Backfill existing rows into the current week so the current schedule is preserved
update public.weekly_sessions
set week_start_date = date_trunc('week', current_date)::date
where week_start_date is null;

create index if not exists idx_weekly_sessions_week_start_date
  on public.weekly_sessions (week_start_date, weekday, start_minute);

-- Refresh schema cache for PostgREST
notify pgrst, 'reload schema';
