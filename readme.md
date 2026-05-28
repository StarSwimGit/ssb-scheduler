SSB Scheduler v4

This build is mapped to your current Supabase schema:
- weekly_sessions
- weekly_session_students
- calendar_remarks
- scheduler_instructors
- scheduler_lesson_types
- scheduler_durations

Deploy to Netlify:
1. Unzip this package.
2. Drag the folder contents into Netlify.
3. Open the site.

Notes:
- No SQL changes are required for this build.
- Existing Supabase URL and publishable key are already in config.js.
- Weekly grid runs 8:00 AM to 8:00 PM.
- Weekly weekday mapping is Monday=1 through Sunday=7 in Supabase.
- Monthly remarks are one-off by calendar_date.


Update in v4.2:
- Supports adding multiple parallel sessions in the same weekly time slot.
- Open any existing weekly session and click "Add Another Session Same Time" to create a second lesson at that same day/time.
- Parallel sessions render side by side in the weekly grid.


Week-scoped scheduler update:
- weekly sessions now save against a specific week_start_date
- classes do not auto-repeat into future weeks
- Weekly view includes Duplicate Previous Week and Remove all classes per day (future weeks only)
- run supabase_week_scope_migration.sql once before deploying this build
