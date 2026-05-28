-- Multi-recipient housekeeping task fan-out.
--
-- housekeeping_requests has a single assigned_to column for backward
-- compatibility, but roster-based ward cleaning often needs to alert more
-- than one staff member plus the housekeeping incharge. This table keeps the
-- one canonical work item while allowing My Tasks and notifications to include
-- every intended recipient.

BEGIN;

CREATE TABLE IF NOT EXISTS housekeeping_request_recipients (
  id              SERIAL PRIMARY KEY,
  request_id      INTEGER NOT NULL REFERENCES housekeeping_requests(id) ON DELETE CASCADE,
  staff_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_uid       UUID REFERENCES users(uid) ON DELETE SET NULL,
  recipient_kind  VARCHAR(40) NOT NULL DEFAULT 'assignee',
  source          VARCHAR(80) NOT NULL DEFAULT 'manual',
  notified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT housekeeping_request_recipients_unique
    UNIQUE (request_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_housekeeping_request_recipients_request
  ON housekeeping_request_recipients(request_id);

CREATE INDEX IF NOT EXISTS idx_housekeeping_request_recipients_staff
  ON housekeeping_request_recipients(staff_id, request_id);

COMMIT;
