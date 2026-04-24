-- 077_fix_dev_schema_drift.sql
-- Closes schema-drift gaps between the committed src/migrations/ tree and
-- what the backend code actually queries. These columns had existed in the
-- legacy apps/backend/migrations/ tree (and so in prod) but were never
-- ported into src/migrations/ when that became the canonical tree.
--
-- Fixes three observed runtime errors:
--
--   1. `column "encrypted_password" of relation "users" does not exist`
--      (src/services/auth/staffAuthService.js — used for staff password
--      comparison, never reachable via app boot in dev before now).
--
--   2. `column "user_id" of relation "audit_log" does not exist`
--      plus adjacent missing columns. src/middleware/auditLog.js writes a
--      rich audit row on every request; in dev the INSERT silently fell
--      through to the Winston file fallback, polluting logs.
--
--   3. Indirectly — the `s.user_id = u.id` JOIN bugs across the staff /
--      payroll / HR service surfaces are code-side fixes in the same
--      commit; this migration only closes the column-level gaps.
--
-- All three ALTER TABLE statements are `IF NOT EXISTS` so the migration is
-- safe to run against prod databases that already have any of the columns.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS encrypted_password TEXT,
  ADD COLUMN IF NOT EXISTS last_sign_in_at    TIMESTAMPTZ;

-- Staff columns referenced across staffAuthService, staffService, HR + payroll
-- services. Dev schema had only `shift`/`salary`/minimal fields; prod had the
-- richer set. Add the gaps so list/auth/profile/HR queries resolve.
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS shift_type             VARCHAR(50),
  ADD COLUMN IF NOT EXISTS employment_type        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS last_check_in          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_check_out         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_overtime_hours   NUMERIC(8,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sick_days_used         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vacation_days_used     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS training_completed     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS date_of_joining        DATE;

-- Backfill shift_type from the legacy `shift` column so existing rows answer
-- both query shapes while code converges.
UPDATE staff SET shift_type = shift WHERE shift_type IS NULL AND shift IS NOT NULL;

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS user_id          INTEGER,
  ADD COLUMN IF NOT EXISTS user_name        VARCHAR(255),
  ADD COLUMN IF NOT EXISTS user_role        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS method           VARCHAR(10),
  ADD COLUMN IF NOT EXISTS path             VARCHAR(500),
  ADD COLUMN IF NOT EXISTS module           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS query_params     JSONB,
  ADD COLUMN IF NOT EXISTS request_summary  TEXT,
  ADD COLUMN IF NOT EXISTS status_code      INTEGER,
  ADD COLUMN IF NOT EXISTS response_time_ms INTEGER,
  ADD COLUMN IF NOT EXISTS success          BOOLEAN,
  ADD COLUMN IF NOT EXISTS user_agent       VARCHAR(500);

-- Index commonly-filtered columns so admin audit queries don't table-scan
CREATE INDEX IF NOT EXISTS audit_log_user_id_idx ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS audit_log_status_code_idx ON audit_log(status_code);
CREATE INDEX IF NOT EXISTS audit_log_path_idx ON audit_log(path);
