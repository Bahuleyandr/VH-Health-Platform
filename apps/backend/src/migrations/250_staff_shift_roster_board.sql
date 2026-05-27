-- Central shift roster board.
--
-- This is intentionally department-agnostic. Housekeeping is the first
-- consumer, but the same board/assignment/audit model can later power nursing,
-- reception, pharmacy, ambulance, and other shift deployment screens without
-- recreating department-specific roster tables.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_shift_roster_boards (
  id              SERIAL PRIMARY KEY,
  department      VARCHAR(80) NOT NULL,
  roster_date     DATE NOT NULL,
  shift_id        INTEGER,
  shift_label     VARCHAR(80) NOT NULL,
  shift_start     TIME NOT NULL,
  shift_end       TIME NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',
  notes           TEXT,
  created_by      INTEGER,
  created_by_uid  UUID,
  published_by    INTEGER,
  published_by_uid UUID,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_shift_roster_boards_status_chk
    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT staff_shift_roster_boards_unique_shift
    UNIQUE (department, roster_date, shift_label)
);

CREATE TABLE IF NOT EXISTS staff_shift_roster_assignments (
  id                      SERIAL PRIMARY KEY,
  roster_id               INTEGER NOT NULL REFERENCES staff_shift_roster_boards(id) ON DELETE CASCADE,
  staff_id                INTEGER NOT NULL,
  staff_uid               UUID,
  staff_role              VARCHAR(80),
  assignment_target_type  VARCHAR(80) NOT NULL,
  assignment_target_id    INTEGER,
  assignment_target_label VARCHAR(255),
  floor                   VARCHAR(80),
  building                VARCHAR(120),
  is_lead                 BOOLEAN NOT NULL DEFAULT FALSE,
  status                  VARCHAR(20) NOT NULL DEFAULT 'planned',
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_shift_roster_assignments_status_chk
    CHECK (status IN ('planned', 'published', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS staff_shift_roster_assignment_audit (
  id              SERIAL PRIMARY KEY,
  roster_id       INTEGER REFERENCES staff_shift_roster_boards(id) ON DELETE SET NULL,
  assignment_id   INTEGER REFERENCES staff_shift_roster_assignments(id) ON DELETE SET NULL,
  actor_id        INTEGER,
  actor_uid       UUID,
  action          VARCHAR(40) NOT NULL,
  reason          TEXT,
  before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_boards_dept_date
  ON staff_shift_roster_boards(department, roster_date, shift_label);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_boards_status
  ON staff_shift_roster_boards(status, roster_date);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_assignments_roster
  ON staff_shift_roster_assignments(roster_id);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_assignments_staff
  ON staff_shift_roster_assignments(staff_id, status);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_assignments_target
  ON staff_shift_roster_assignments(assignment_target_type, assignment_target_id, status);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_audit_roster
  ON staff_shift_roster_assignment_audit(roster_id, created_at DESC);

ALTER TABLE housekeeping_floor_assignments
  ADD COLUMN IF NOT EXISTS roster_board_id INTEGER,
  ADD COLUMN IF NOT EXISTS roster_assignment_id INTEGER,
  ADD COLUMN IF NOT EXISTS assignment_kind VARCHAR(30) NOT NULL DEFAULT 'redeploy';

CREATE INDEX IF NOT EXISTS idx_hk_floor_assignments_roster_projection
  ON housekeeping_floor_assignments(roster_board_id, roster_assignment_id, status);

CREATE INDEX IF NOT EXISTS idx_hk_floor_assignments_kind_active
  ON housekeeping_floor_assignments(assignment_kind, status, effective_from, effective_to);

COMMIT;
