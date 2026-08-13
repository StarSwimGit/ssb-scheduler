-- ─────────────────────────────────────────────────────────────────────
-- RLS Phase 0 — lock app_users away from the public anon key
--
-- ⚠️  APPLY LAST.  Run this ONLY after BOTH are true:
--       1. The `login` and `admin-users` edge functions are deployed, and
--       2. The app.js wiring that calls them is LIVE on www.mystarswim.com.
--     Applying this while the old app.js is still deployed WILL break staff
--     login (the current login reads app_users with the anon key).
--
-- What it does: enables Row-Level Security on app_users and adds NO policy for
-- anon/authenticated, so the public anon key can no longer read (or write)
-- password hashes and salts. The edge functions use the SERVICE ROLE, which
-- bypasses RLS, so login and user management keep working through them.
--
-- Rollback (instant): alter table app_users disable row level security;
-- ─────────────────────────────────────────────────────────────────────

alter table app_users enable row level security;

-- Belt-and-suspenders: drop any table-level grants the anon/authenticated
-- roles may have inherited. (RLS-with-no-policy already denies row access;
-- this removes the underlying privilege too.)
revoke all on table app_users from anon;
revoke all on table app_users from authenticated;

-- No CREATE POLICY statements: with RLS enabled and no permissive policy, the
-- anon and authenticated roles get zero rows and no writes. Only the service
-- role (used by the edge functions) can touch the table.

-- ── Verify after applying ──────────────────────────────────────────────
-- With the anon key, this should now return NO rows / permission denied:
--     select * from app_users;
-- And the app should still log in and manage users via the edge functions.
