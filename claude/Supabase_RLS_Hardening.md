# Supabase Auth + RLS Hardening — Plan & Phase 0

**Status:** Draft for Anthony's review · **Owner:** SSB Dev · **Target architecture:** Supabase Auth
**Scope:** `mystarswim.com` scheduler app + public site, Supabase project `prnewflgecpjbavnrirm`

> ⚠️ **Nothing in this document has been applied to production.** The edge
> functions and SQL that ship alongside it are inert until deployed and wired.
> Apply order matters — see "Phase 0 rollout" — applying the SQL early **will
> break staff login**.

---

## 1. Executive summary

The app has **no server-side trust boundary**. Every browser — staff and public
alike — talks to the database with the **same anon key**, which is embedded in
the deployed JavaScript and therefore public. Row-Level Security (RLS) is
currently **open** on all tables, so that public key has full read/write/delete
on ~40 tables.

The single most urgent exposure:

> **The staff login reads the `app_users` table with the anon key and checks
> the password hash in the browser (`app.js:13003`). Anyone with the anon key
> can run `SELECT * FROM app_users` and download every staff password hash and
> salt.** The hashes are single-round SHA-256 (no stretching), and the shared
> staff password is weak — so they would crack in seconds.

RLS alone cannot fix this: the database cannot distinguish a staff browser from
an attacker because **both present the identical anon key**. Hardening therefore
requires introducing a real authentication boundary first. The chosen target is
**Supabase Auth** (staff get real JWTs; RLS policies key off `auth` claims).

This document lays out a three-phase path and ships **Phase 0**, which closes
the `app_users` exposure independently of the larger migration.

---

## 2. Current state (as mapped from the code)

### 2.1 Authentication model
- **No Supabase Auth.** Staff auth is a custom `app_users` table
  (`username`, `password_salt`, `password_hash` = `SHA-256(salt + password)`,
  `role`, `is_active`).
- **Verification happens in the browser.** `LoginView.submit` (`app.js:12998`)
  fetches the user row via the anon key and compares the hash client-side.
- Session is a plain JSON blob in `localStorage['ssb.auth']`
  (`{id, username, displayName, role, ts}`), 7-day TTL. It is **not signed** —
  a user could edit their own role in localStorage; today that only affects
  client-side UI gating, because the DB enforces nothing anyway.
- Roles: `sysadmin`, `schedule_admin`, `admin`.

### 2.2 The anon key is the only credential
- Defined in `config.js` (`window.APP_CONFIG.supabaseAnonKey`), shipped in every
  page. Public by design.
- With RLS open, it grants full CRUD on every table.

### 2.3 Surface → table access map

**Public pages** (small, clean — easy to lock down):

| Page | Reads | Writes |
|---|---|---|
| `index.html` | `promos`, `public_pricing`, `public_schedule_preview` | `contact_messages` |
| `schedule.html` | `public_pricing`, `public_schedule_preview` | — |
| `intake.html` / `intake.js` | `branches` | `students`, `tc_acceptances` (+ patch `students`) |

**Admin app** (`app.js`) touches ~40 tables, including the sensitive ones:
`app_users`, `invoices`, `invoice_lines`, `payments`, `pending_credits`,
`invoice_settings`, `students`, `student_enrollments`, `student_credit_balances`,
`credit_purchases`, `subscriptions`, `family_groups`, `family_group_members`,
`admin_companies`, `admin_employees`, `admin_payees`, `admin_payment_vouchers`,
`admin_contacts`, `admin_categories`, `voucher_amendments`, `promos`,
`packages`, `products`, `payment_methods`, `billing_terms`, `branches`, `pools`,
`operating_hours`, `weekly_sessions`, `weekly_session_students`,
`session_instructors`, `scheduler_lesson_types`, `scheduler_instructors`,
`scheduler_durations`, `scheduler_codes`, `programme_sessions`,
`programme_categories`, `calendar_remarks`, `replacement_pending`,
`contact_messages`, `public_pricing`, `public_schedule_settings`,
`tc_acceptances`, `app_users`.

### 2.4 Existing public projections (already the right shape)
- `public_schedule_preview` — view, granted to `anon` (see
  `supabase_marked_full_migration.sql`). Exposes only timetable status, no PII.
- `public_pricing`, `public_schedule_settings` — marketing content.
- `branches` — read by intake for the branch picker + per-branch Terms.

---

## 3. Target architecture — Supabase Auth

**End state:**
- **`anon` role** → may reach only the public projections and the intake write
  path. Nothing else.
- **`authenticated` role** (staff, via Supabase Auth JWT) → admin access,
  scoped by role claims in RLS policies.
- **`app_users`** → password material removed entirely; Supabase Auth
  (`auth.users`, bcrypt, never anon-readable) holds credentials. `app_users`
  becomes a thin profile/roles table keyed to the auth uid.
- The admin app attaches the signed-in user's JWT (not the anon key) to admin
  requests, so PostgREST evaluates RLS as `authenticated` with real claims.

**Why this over an edge-function proxy:** RLS does the enforcement natively, no
per-call proxy to maintain, and it's the idiomatic Supabase pattern. Cost is a
one-time change to the app's request layer (attach JWT) and a credential
migration for existing staff.

---

## 4. Phased plan

### Phase 0 — Close the `app_users` exposure  ← **ships with this doc**
Move credential handling server-side so the browser never reads password
material, then lock `app_users` from the anon key. Self-contained; does not
require the full Supabase Auth migration.

**Delivered artifacts (in this repo, not yet deployed):**
- `supabase/functions/login/index.ts` — verifies credentials with the service
  role, returns a safe profile + a signed session token. No hash/salt leaves
  the server.
- `supabase/functions/admin-users/index.ts` — sysadmin-only user management
  (list / create / reset password / set-active / delete), gated on the signed
  session token, executed with the service role.
- `supabase_rls_phase0_lock_app_users.sql` — enables RLS on `app_users` and
  revokes anon access. **Apply LAST.**
- App wiring (see §6) — **not yet applied**; this is the reviewed next step.

**Phase 0 rollout order (must be followed):**
1. Deploy both edge functions to Supabase
   (`supabase functions deploy login` / `... admin-users`).
2. Set the function secret `SESSION_JWT_SECRET` to a long random string
   (`supabase secrets set SESSION_JWT_SECRET=…`). `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
3. Ship the `app.js` wiring from §6 (login + user panel call the functions).
   Verify login and user management work end-to-end.
4. **Only now** apply `supabase_rls_phase0_lock_app_users.sql`.
5. Verify: with the anon key, `select * from app_users` returns **zero rows**;
   the app still logs in and manages users (through the functions).

**Rollback:** if step 4 breaks anything, `alter table app_users disable row
level security;` restores the prior behaviour instantly while we diagnose.

### Phase 1 — Public least-privilege
Lock `anon` to exactly the public surface from §2.3:
- Keep anon `SELECT` on `public_schedule_preview`, `public_pricing`,
  `public_schedule_settings`, and a **narrow projection of `branches`**
  (id, name, code, terms_content, is_active, sort_order — no internal columns).
- Keep anon `SELECT` on `promos` **only if** the public site needs it (it reads
  promo validity) — otherwise move promo validation behind a function too.
- Keep anon `INSERT` on `contact_messages`, `students`, `tc_acceptances`
  (the only public writes), with column-scoped policies and no `SELECT`/`UPDATE`
  /`DELETE`.
- Enable RLS on every other table with **no anon policy** (denied to anon).
  This is safe to stage **after** Phase 2 wiring, because until the admin app
  sends a JWT, enabling RLS on admin tables would lock the admin app out too.

### Phase 2 — Admin behind Supabase Auth
1. Migrate staff into Supabase Auth (create `auth.users` for each active
   `app_users` row; set initial passwords; keep `app_users` as a profile table
   linked by uid, drop `password_hash`/`password_salt`).
2. Swap the app's request layer to attach the signed-in user's Supabase JWT for
   admin calls (the anon key stays only for public reads).
3. Author RLS policies on the admin tables keyed to role claims
   (`sysadmin` / `schedule_admin` / `admin`), then enable RLS across the board.
4. Verify each role sees exactly what it should; verify anon sees only §2.3.

---

## 5. Risk notes
- **Ordering is the main hazard.** Enabling RLS on a table the app still reaches
  with the anon key locks the app out of that table. Every phase above enables
  RLS **after** the corresponding request-path change is live.
- **Service role stays server-side only.** It lives in edge-function secrets,
  never in any shipped file. Do not put it in `config.js`.
- **`SESSION_JWT_SECRET`** must be long and random, and is server-only.
- Keep the migration-compat habit: additive, reversible steps; each phase has a
  one-line RLS disable as rollback.

---

## 6. Phase 0 app wiring (reviewed next step — NOT yet applied)

Replace the direct `app_users` reads/writes in `app.js` with function calls.

**Login (`LoginView.submit`, ~`app.js:13003`):**
```js
// Before: reads app_users with the anon key and hashes in the browser.
// After: server verifies; browser only receives a safe profile + token.
const res = await fetch(`${cfg.supabaseUrl}/functions/v1/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
  body: JSON.stringify({ username: u, password }),
});
if (!res.ok) { setErr('Incorrect username or password.'); setBusy(false); return; }
const { user, token } = await res.json();
const auth = { id: user.id, username: user.username, displayName: user.displayName,
               role: user.role, token, ts: Date.now() };
localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
// …existing role gate + onLogin(auth)…
```

**User management panel** (`addAppUser` / `resetPassword` / `updateAppUser` /
`deleteAppUser` / the `app_users` list load) → each becomes a POST to
`/functions/v1/admin-users` with `Authorization: Bearer <token>` and an
`action` field (`list` / `create` / `reset` / `set_active` / `delete`). The
function verifies the token is a `sysadmin` session before acting.

Once §6 is live and verified, apply the Phase 0 SQL (§4, step 4).

---

## 7. Open decisions for Anthony
- **Phase 0 session token vs Supabase Auth token.** Phase 0 issues a lightweight
  signed session token (enough to gate the admin-users function). Phase 2
  replaces it with a real Supabase Auth JWT. Confirmed direction: Supabase Auth.
- **`promos` public read** — keep anon SELECT, or move promo validation behind a
  function in Phase 1? (Leaning: keep read-only anon SELECT; promos are not PII.)
- **Staff credential migration** — for Phase 2, reset everyone to a fresh strong
  password during the Supabase Auth cutover (also clears backlog item #11), or
  preserve current passwords via an admin-set flow?
