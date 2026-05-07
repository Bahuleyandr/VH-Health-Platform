-- Migration 154: OR (Operating Room) operational layer (Sprint 6).
--
-- Migration 116 added the seven clinical documentation tables (preop
-- checklists, intraop notes, postop notes, anesthesia records,
-- implants, WHO 3-phase safety checklist, complication alerts), and
-- ot_schedules has been the canonical case record since the early
-- monorepo. What's still missing:
--
--   1. A canonical OR room master so room names don't drift across
--      typed-in free-text fields.
--   2. Standardized procedure codes / typical durations for the
--      booking screen.
--   3. A daily-throughput view the OR coordinator dashboard can hit
--      without joining six tables.
--   4. Booking conflict detection requires an explicit (room, date,
--      time-window) overlap check — handled in the service, but a
--      partial index speeds it up.

BEGIN;

-- ── 1. OR room master ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS or_rooms (
  id               SERIAL PRIMARY KEY,
  code             VARCHAR(40) UNIQUE NOT NULL,        -- "OT-1", "OT-MAIN-A"
  display_name     VARCHAR(120) NOT NULL,
  block            VARCHAR(40),                        -- "Main", "Maternity", "Day-Care"
  specialty_focus  VARCHAR(80),                        -- "general", "cardiac", "ortho", "obg"
  laminar_flow     BOOLEAN NOT NULL DEFAULT false,     -- HEPA/laminar — needed for ortho implants
  c_arm_available  BOOLEAN NOT NULL DEFAULT false,
  microscope       BOOLEAN NOT NULL DEFAULT false,
  prime_time_start TIME DEFAULT '08:00',
  prime_time_end   TIME DEFAULT '17:00',
  status           VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'maintenance', 'decommissioned')),
  notes            TEXT,
  tenant_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_or_rooms_status ON or_rooms(status, code);

-- Seed a small starter set so a fresh tenant can begin booking.
INSERT INTO or_rooms (code, display_name, block, specialty_focus, laminar_flow, c_arm_available)
SELECT v.code, v.display_name, v.block, v.specialty_focus, v.laminar_flow, v.c_arm
FROM (VALUES
  ('OT-MAIN-1', 'Main OT 1',     'Main',      'general',  true,  true),
  ('OT-MAIN-2', 'Main OT 2',     'Main',      'general',  false, true),
  ('OT-ORTHO',  'Ortho OT',      'Main',      'ortho',    true,  true),
  ('OT-CTVS',   'Cardiac OT',    'Cardiac',   'cardiac',  true,  true),
  ('OT-OBG-1',  'Labour OT 1',   'Maternity', 'obg',      false, false),
  ('OT-DC-1',   'Day-Care OT',   'Day-Care',  'general',  false, false)
) AS v(code, display_name, block, specialty_focus, laminar_flow, c_arm)
WHERE NOT EXISTS (SELECT 1 FROM or_rooms WHERE or_rooms.code = v.code);

-- ── 2. Standard procedure catalog ────────────────────────────────────
-- Surgeons pick from this when scheduling so duration estimates are
-- realistic and the booking conflict math has something to work with.
CREATE TABLE IF NOT EXISTS or_procedure_catalog (
  id                    SERIAL PRIMARY KEY,
  procedure_code        VARCHAR(50) UNIQUE NOT NULL,
  display_name          VARCHAR(255) NOT NULL,
  specialty             VARCHAR(80),
  typical_duration_min  INTEGER NOT NULL,             -- surgeon-to-surgeon variance is huge; this is a baseline
  setup_time_min        INTEGER NOT NULL DEFAULT 15,
  cleanup_time_min      INTEGER NOT NULL DEFAULT 15,
  requires_blood        BOOLEAN NOT NULL DEFAULT false,
  requires_icu_postop   BOOLEAN NOT NULL DEFAULT false,
  requires_laminar      BOOLEAN NOT NULL DEFAULT false,
  default_anesthesia    VARCHAR(40),                   -- ga / sa / la / mac
  notes                 TEXT,
  active                BOOLEAN NOT NULL DEFAULT true,
  tenant_id             UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_or_procedure_specialty
  ON or_procedure_catalog(specialty, active);

-- Seed common procedures (ICD/CPT-ish; hospitals customize later).
INSERT INTO or_procedure_catalog
  (procedure_code, display_name, specialty, typical_duration_min,
   setup_time_min, cleanup_time_min, requires_blood, requires_icu_postop,
   requires_laminar, default_anesthesia)
SELECT v.code, v.name, v.spec, v.dur, v.setup, v.cleanup,
       v.blood, v.icu, v.laminar, v.anaesth
FROM (VALUES
  ('APPENDECTOMY-LAP', 'Laparoscopic Appendectomy',  'general_surgery', 60,  15, 15, false, false, false, 'ga'),
  ('CHOLECYSTECTOMY-LAP', 'Laparoscopic Cholecystectomy', 'general_surgery', 75, 15, 15, false, false, false, 'ga'),
  ('HERNIA-OPEN', 'Open Inguinal Hernia Repair',      'general_surgery', 60,  15, 15, false, false, false, 'sa'),
  ('LSCS', 'Lower Segment Caesarean Section',          'obg',             45,  15, 15, true,  false, false, 'sa'),
  ('NORMAL-DELIVERY', 'Vaginal Delivery (assisted)',   'obg',             30,  10, 10, false, false, false, 'la'),
  ('TKR', 'Total Knee Replacement (unilateral)',       'orthopedics',    120,  20, 20, true,  false, true,  'sa'),
  ('THR', 'Total Hip Replacement',                     'orthopedics',    150,  20, 20, true,  false, true,  'sa'),
  ('CABG', 'Coronary Artery Bypass Grafting',          'cardiac',        300,  30, 30, true,  true,  true,  'ga'),
  ('CATARACT-PHACO', 'Cataract Phacoemulsification',   'ophthalmology',   30,  10, 10, false, false, false, 'la'),
  ('TONSILLECTOMY', 'Tonsillectomy',                   'ent',             45,  15, 15, false, false, false, 'ga'),
  ('TURP', 'Transurethral Resection of Prostate',      'urology',         75,  15, 15, true,  false, false, 'sa')
) AS v(code, name, spec, dur, setup, cleanup, blood, icu, laminar, anaesth)
WHERE NOT EXISTS (SELECT 1 FROM or_procedure_catalog WHERE procedure_code = v.code);

-- ── 3. Booking conflict helper index ────────────────────────────────
-- Speeds up the "is this room+window already booked" check used during
-- scheduling. Partial index on non-cancelled cases only.
CREATE INDEX IF NOT EXISTS idx_ot_schedules_room_date_time
  ON ot_schedules(ot_room, scheduled_date, scheduled_time)
  WHERE status NOT IN ('cancelled', 'completed');

-- ── 4. Daily throughput view ────────────────────────────────────────
-- Coordinator dashboard hits this for the daily room utilization
-- summary. Computed live; cheap because the source is small.
CREATE OR REPLACE VIEW or_throughput_daily AS
SELECT
  s.ot_room,
  s.scheduled_date,
  COUNT(*)::int AS scheduled_cases,
  SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END)::int AS completed_cases,
  SUM(CASE WHEN s.status = 'cancelled' THEN 1 ELSE 0 END)::int AS cancelled_cases,
  COALESCE(SUM(s.estimated_duration), 0)::int AS estimated_minutes,
  COALESCE(SUM(s.actual_duration), 0)::int    AS actual_minutes,
  CASE
    WHEN COALESCE(SUM(s.estimated_duration), 0) = 0 THEN NULL
    ELSE ROUND(
      (COALESCE(SUM(s.actual_duration), 0)::numeric /
       NULLIF(SUM(s.estimated_duration), 0)) * 100, 1)
  END AS minutes_efficiency_pct
FROM ot_schedules s
WHERE s.ot_room IS NOT NULL
GROUP BY s.ot_room, s.scheduled_date;

-- ── 5. WHO checklist completion view ────────────────────────────────
-- Quick "did this case complete sign-in / time-out / sign-out" lookup.
-- migration 116 created surgical_safety_checklists with phase column.
CREATE OR REPLACE VIEW or_safety_compliance AS
SELECT
  s.id AS ot_schedule_id,
  s.scheduled_date,
  s.ot_room,
  s.procedure_name,
  s.surgeon,
  s.status AS case_status,
  BOOL_OR(c.phase = 'sign_in'  AND c.status = 'complete') AS sign_in_complete,
  BOOL_OR(c.phase = 'time_out' AND c.status = 'complete') AS time_out_complete,
  BOOL_OR(c.phase = 'sign_out' AND c.status = 'complete') AS sign_out_complete,
  COUNT(c.id)::int AS phases_recorded
FROM ot_schedules s
LEFT JOIN surgical_safety_checklists c ON c.ot_schedule_id = s.id
GROUP BY s.id;

COMMIT;
