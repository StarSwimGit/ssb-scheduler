-- ─────────────────────────────────────────────────────────────────────
-- Payment Methods — configurable list powering all payment dropdowns,
-- pills and filters in SSB Scheduler.
--
-- Design notes:
--  • GLOBAL (not branch-scoped) — cash is cash at every pool.
--  • `code` is what gets stored on payments.payment_method. It is
--    immutable once in use; only `label`, `is_active`, `sort_order`
--    are meant to change. Never DELETE a row — deactivate instead so
--    historical payments keep resolving their label.
--  • Seeds mirror the app's previous hard-coded list so existing
--    payment records keep their labels with zero data changes.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists payment_methods (
  id          bigint generated always as identity primary key,
  code        text not null unique,
  label       text not null,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Seed the six legacy methods (idempotent — safe to re-run)
insert into payment_methods (code, label, sort_order) values
  ('cash',          'Cash',          1),
  ('bank_transfer', 'Bank Transfer', 2),
  ('duitnow',       'DuitNow',       3),
  ('card',          'Card',          4),
  ('cheque',        'Cheque',        5),
  ('other',         'Other',         6)
on conflict (code) do nothing;

-- RLS: match the project's current unrestricted posture
alter table payment_methods enable row level security;
drop policy if exists payment_methods_all on payment_methods;
create policy payment_methods_all on payment_methods
  for all using (true) with check (true);
