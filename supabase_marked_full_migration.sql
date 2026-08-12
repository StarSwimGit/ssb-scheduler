-- ─────────────────────────────────────────────────────────────────────
-- "Mark as full" — manual per-session lock
--
-- Lets a scheduler declare a class full below numeric capacity (e.g. a
-- wide skill spread means the instructor can't absorb another swimmer).
-- While locked: the app blocks roster additions, and the PUBLIC schedule
-- shows the slot as Full regardless of headcount. Unlocking temporarily
-- (e.g. to slot in a trial) is one checkbox in the session editor.
-- ─────────────────────────────────────────────────────────────────────

alter table weekly_sessions
  add column if not exists marked_full boolean not null default false;

-- Recreate the public projection: manual lock wins the status.
create or replace view public_schedule_preview as
select
  s.weekday,
  s.start_minute,
  lpad((s.start_minute/60)::text,2,'0') || ':' || lpad((s.start_minute%60)::text,2,'0')
    as start_time,
  lpad(((s.start_minute + coalesce(s.duration_minutes,60))/60)::text,2,'0') || ':' ||
  lpad(((s.start_minute + coalesce(s.duration_minutes,60))%60)::text,2,'0')
    as end_time,
  lt.name  as lesson_type,
  b.name   as branch,
  case
    when s.marked_full                                    then 'full'
    when cap.max_cap <= 0                                 then 'available'
    when cnt.booked >= cap.max_cap                        then 'full'
    when cnt.booked::numeric / cap.max_cap >= 0.8         then 'limited'
    else 'available'
  end as status
from weekly_sessions s
join public_schedule_settings ps
  on ps.id = 1 and ps.enabled
join scheduler_lesson_types lt
  on lt.id = s.lesson_type_id
 and lt.id = any(ps.visible_lesson_type_ids)
left join pools    p on p.id = s.pool_id
left join branches b on b.id = p.branch_id
left join lateral (
  select count(*)::int as booked
  from weekly_session_students w
  where w.session_id = s.id
) cnt on true
left join lateral (
  select (coalesce(lt.students_per_instructor,0)
          * greatest(1,(select count(*) from session_instructors si
                        where si.session_id = s.id)))::int as max_cap
) cap on true
where s.week_start_date = date_trunc('week',(now() at time zone 'Asia/Kuala_Lumpur'))::date
  and (cardinality(ps.visible_branch_ids) = 0 or b.id = any(ps.visible_branch_ids))
order by s.weekday, s.start_minute;

grant select on public_schedule_preview to anon;
