-- Central duty roster preference requests.
--
-- Staff can request preferred duty dates/shifts/areas ahead of roster
-- publication. The request is reviewed by the department incharge or HR, and
-- every state transition is audit logged. Approved requests are advisory
-- signals for the roster board; they do not silently alter a published roster.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_shift_roster_requests (
  id                      SERIAL PRIMARY KEY,
  request_type            VARCHAR(40) NOT NULL DEFAULT 'duty_preference',
  staff_id                INTEGER NOT NULL,
  staff_uid               UUID,
  department              VARCHAR(80) NOT NULL,
  requested_start_date    DATE NOT NULL,
  requested_end_date      DATE NOT NULL,
  period_type             VARCHAR(20) NOT NULL DEFAULT 'day',
  shift_id                INTEGER,
  shift_label             VARCHAR(80),
  assignment_target_type  VARCHAR(80),
  assignment_target_id    INTEGER,
  assignment_target_label VARCHAR(255),
  floor                   VARCHAR(80),
  building                VARCHAR(120),
  priority                VARCHAR(20) NOT NULL DEFAULT 'normal',
  reason                  TEXT,
  status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by             INTEGER,
  reviewed_by_uid         UUID,
  reviewed_at             TIMESTAMPTZ,
  review_notes            TEXT,
  roster_board_id         INTEGER,
  roster_assignment_id    INTEGER,
  source_type             VARCHAR(40),
  source_id               INTEGER,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_shift_roster_requests_date_chk
    CHECK (requested_end_date >= requested_start_date),
  CONSTRAINT staff_shift_roster_requests_type_chk
    CHECK (request_type IN ('duty_preference', 'avoid_duty', 'coverage_request')),
  CONSTRAINT staff_shift_roster_requests_period_chk
    CHECK (period_type IN ('day', 'week', 'month', 'custom')),
  CONSTRAINT staff_shift_roster_requests_priority_chk
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT staff_shift_roster_requests_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'applied'))
);

CREATE TABLE IF NOT EXISTS staff_shift_roster_request_audit (
  id              SERIAL PRIMARY KEY,
  request_id      INTEGER,
  actor_id        INTEGER,
  actor_uid       UUID,
  action          VARCHAR(40) NOT NULL,
  reason          TEXT,
  before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_requests_staff
  ON staff_shift_roster_requests(staff_id, requested_start_date DESC);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_requests_dept_window
  ON staff_shift_roster_requests(department, status, requested_start_date, requested_end_date);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_requests_target
  ON staff_shift_roster_requests(assignment_target_type, assignment_target_id, status);

CREATE INDEX IF NOT EXISTS idx_staff_shift_roster_request_audit_request
  ON staff_shift_roster_request_audit(request_id, created_at DESC);

COMMIT;
