-- Migration 141: create staff_shifts + staff_shift_assignments tables.
--
-- Same orphaned-schema pattern as staff_messages (mig 140) and
-- data_breaches (mig 126b): seeded via early prisma db push so production
-- environments have it silently, but no migration ever created it.
-- A fresh runner-only deploy (verified on dalekdefender 2026-05-02)
-- crashes attendance check-in with `relation "staff_shifts" does not
-- exist` — every staff member gets HTTP 500 on /staff/attendance because
-- attendanceService calls getStaffShift() to classify the punch (on-time
-- / late / overtime) and the lookup hits a missing table.
--
-- Schema mirrors apps/backend/docs/schema-dump.sql exactly. CREATE
-- statements use IF NOT EXISTS so re-running on environments that
-- already have the tables is a no-op.
--
-- Service callers: shiftService.js (getStaffShift), attendanceService.js
-- (classifyAttendance + calculateOvertime), and the HR admin shift-
-- planning surface.

BEGIN;

-- Master shift definitions (Morning / Afternoon / Night / etc.)
--
-- Schema additions over the base schema-dump shape:
--   * is_preset BOOLEAN — distinguishes the seeded "Morning/Afternoon/
--     Night" rows (immutable) from custom rows the HR admin creates.
--     shiftService.createCustomShift sets is_preset=false; presets are
--     not editable / deletable. Service files reference this column;
--     it was missing from the original prisma db push schema.
--   * grace_minutes INTEGER — alias of grace_period_minutes used by
--     getStaffShift's SELECT (other parts of the service use the
--     longer name). Kept as a separate column rather than a view so
--     ALTER TABLE migrations stay idempotent across hospitals that
--     might have one or the other.
CREATE TABLE IF NOT EXISTS staff_shifts (
  id                       SERIAL PRIMARY KEY,
  name                     VARCHAR(100) NOT NULL,
  start_time               TIME NOT NULL,
  end_time                 TIME NOT NULL,
  grace_period_minutes     INTEGER DEFAULT 15,
  late_threshold_minutes   INTEGER DEFAULT 30,
  absent_threshold_minutes INTEGER DEFAULT 60,
  department               VARCHAR(100),
  is_active                BOOLEAN DEFAULT true,
  is_preset                BOOLEAN DEFAULT false,
  grace_minutes            INTEGER DEFAULT 15,
  created_at               TIMESTAMP DEFAULT NOW()
);

-- Backfill the new columns on environments where the table existed
-- before this migration. ALTER TABLE IF NOT EXISTS handles re-running
-- on hospitals that have the rich schema already (no-op).
ALTER TABLE staff_shifts
  ADD COLUMN IF NOT EXISTS is_preset     BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS grace_minutes INTEGER DEFAULT 15;

CREATE INDEX IF NOT EXISTS idx_staff_shifts_active
  ON staff_shifts(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_staff_shifts_department
  ON staff_shifts(department) WHERE department IS NOT NULL;

-- Per-staff shift assignment with effective-date validity window.
CREATE TABLE IF NOT EXISTS staff_shift_assignments (
  id              SERIAL PRIMARY KEY,
  staff_id        INTEGER,
  shift_id        INTEGER,
  effective_from  DATE DEFAULT CURRENT_DATE,
  effective_to    DATE,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_shift_assignments_staff
  ON staff_shift_assignments(staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_shift_assignments_active
  ON staff_shift_assignments(staff_id, effective_from, effective_to);

-- Seed three default shifts so attendance classification (on-time /
-- late / overtime) has SOMETHING to compare against on a fresh dev rig.
-- Idempotent via the WHERE NOT EXISTS guard — re-running migrations on
-- a hospital that already has its own custom shifts seeded won't double
-- up. Same threshold defaults as the column-level DEFAULTs above.
INSERT INTO staff_shifts (name, start_time, end_time, department, is_active, is_preset, grace_minutes)
SELECT * FROM (VALUES
  ('Morning'::VARCHAR(100),   '08:00'::TIME, '16:00'::TIME, NULL::VARCHAR(100), true, true, 15),
  ('Afternoon'::VARCHAR(100), '14:00'::TIME, '22:00'::TIME, NULL::VARCHAR(100), true, true, 15),
  ('Night'::VARCHAR(100),     '22:00'::TIME, '06:00'::TIME, NULL::VARCHAR(100), true, true, 15)
) AS seed(name, start_time, end_time, department, is_active, is_preset, grace_minutes)
WHERE NOT EXISTS (SELECT 1 FROM staff_shifts);

COMMIT;
