-- ─────────────────────────────────────────────────────────────────────
-- Public Website Projections — Schedule Preview + Pricing
--
-- Design: the marketing site NEVER reads the real scheduling tables.
-- It reads only:
--   • public_schedule_preview  (VIEW — sanitised projection, no names)
--   • public_pricing           (marketing-owned table, decoupled from packages)
-- Admin control lives in:
--   • public_schedule_settings (single-row switchboard)
--
-- The view's SELECT list is the privacy guarantee: student names,
-- instructor names and IDs are structurally absent — they cannot leak
-- because the projection never carries them.
-- ─────────────────────────────────────────────────────────────────────

-- 1) Switchboard ------------------------------------------------------
create table if not exists public_schedule_settings (
  id                      int primary key default 1 check (id = 1),
  enabled                 boolean not null default false,
  visible_lesson_type_ids uuid[]  not null default '{}',  -- explicit opt-in
  visible_branch_ids      uuid[]  not null default '{}',  -- empty = all branches
  updated_at              timestamptz not null default now()
);
insert into public_schedule_settings (id) values (1) on conflict (id) do nothing;

-- 2) Pricing cards ----------------------------------------------------
create table if not exists public_pricing (
  id           bigint generated always as identity primary key,
  category     text    not null default 'General',   -- e.g. 'Toddlers', 'LTS Children'
  title        text    not null,
  subtitle     text,
  price        numeric(10,2) not null default 0,
  unit         text    default '/month',
  features     text[]  not null default '{}',
  badge        text,                                  -- e.g. 'Most Popular'
  sort_order   int     not null default 0,
  is_published boolean not null default false,
  created_at   timestamptz default now()
);

-- 3) Sanitised schedule projection -----------------------------------
-- Weekday convention matches the app: 1 = Monday … 7 = Sunday.
-- Capacity mirrors sessionCapacity() in app.js:
--   max = students_per_instructor × max(1, assigned instructor count)
-- Status: full ≥ max · limited ≥ 80% · else available (or available when
-- no ratio configured). Zero-swimmer sessions appear as fully available.
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
    when cap.max_cap <= 0                                then 'available'
    when cnt.booked >= cap.max_cap                       then 'full'
    when cnt.booked::numeric / cap.max_cap >= 0.8        then 'limited'
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

-- 4) Access -----------------------------------------------------------
alter table public_schedule_settings enable row level security;
drop policy if exists public_schedule_settings_all on public_schedule_settings;
create policy public_schedule_settings_all on public_schedule_settings
  for all using (true) with check (true);

alter table public_pricing enable row level security;
drop policy if exists public_pricing_all on public_pricing;
create policy public_pricing_all on public_pricing
  for all using (true) with check (true);

grant select on public_schedule_preview to anon;
grant select on public_pricing to anon;
