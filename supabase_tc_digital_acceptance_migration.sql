-- ─────────────────────────────────────────────────────────────────────
-- T&C digital signature — audit trail for acceptances
--
-- Records HOW a Terms & Conditions acceptance was signed:
--   • signature_name — the name the guardian TYPED to sign. In the admin
--     app this must match the on-file guardian name; on the public intake
--     form it is the guardian name entered on the form.
--   • signed_via     — which surface produced the acceptance ('app' for the
--     scheduler's T&C tab, 'intake' for the public registration form).
--   • user_agent     — the signing browser's user-agent string (trimmed),
--     for a light-weight non-repudiation trail.
--
-- All three columns are NULLABLE with no default, so any deployment still
-- running the pre-migration app keeps working: those writes fall back to the
-- legacy row shape (see saveTcAcceptance in app.js and handleSubmit in
-- intake.js — try full row → catch missing-column → retry legacy row).
-- This migration only ADDS columns; no existing data is altered or dropped.
-- ─────────────────────────────────────────────────────────────────────

alter table tc_acceptances
  add column if not exists signature_name text,
  add column if not exists signed_via     text,
  add column if not exists user_agent     text;
