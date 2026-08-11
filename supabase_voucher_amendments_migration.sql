-- ─────────────────────────────────────────────────────────────────────
-- Voucher Amendment Log
--
-- Every edit of an EXISTING payment voucher records a before/after
-- snapshot here. Rows are write-once: the app only inserts and reads —
-- never updates or deletes — so the trail can't be silently rewritten.
-- voucher_id is text to stay agnostic of the vouchers PK type.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists voucher_amendments (
  id             bigint generated always as identity primary key,
  voucher_id     text not null,
  voucher_no     text,
  status_at_edit text,
  edited_by      text,
  before_data    jsonb,
  after_data     jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists voucher_amendments_voucher_idx
  on voucher_amendments (voucher_id, created_at desc);

alter table voucher_amendments enable row level security;
drop policy if exists voucher_amendments_all on voucher_amendments;
create policy voucher_amendments_all on voucher_amendments
  for all using (true) with check (true);
