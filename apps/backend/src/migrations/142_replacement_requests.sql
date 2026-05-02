-- Migration 142: create replacement_requests + replacement_actions tables.
--
-- Same orphaned-schema pattern as data_breaches (mig 126b),
-- staff_messages (mig 140), and staff_shifts (mig 141): seeded via
-- early `prisma db push` so production environments have it silently,
-- but no migration ever created it. A fresh runner-only deploy
-- (verified on dalekdefender 2026-05-02) crashes the Leave screen's
-- replacement-picker workflow with `relation "replacement_requests"
-- does not exist` (Postgres 42P01) → backend 500 → screen renders
-- empty section + scary error pill on every clinical role.
--
-- Schema mirrors apps/backend/docs/schema-dump.sql exactly:
--
--   id, leave_request_id, requester_id, replacement_staff_id, dates,
--   status, requester_message, responder_message, requested_at,
--   responded_at, hr_approved_at, hr_approved_by
--
-- The controller (`controllers/staff/replacementController.js`) was
-- rewritten in the same PR as this migration to use these column
-- names directly — the previous SQL referenced legacy-schema columns
-- (original_staff_id, shift_date, reason, created_at) that never
-- existed in the schema-dump definition.
--
-- Service callers: hrController (replacement_picker on Leave screen),
-- replacementController (request / respond / pending / history /
-- hr-approve flows).

BEGIN;

CREATE TABLE IF NOT EXISTS replacement_requests (
  id                    SERIAL PRIMARY KEY,
  leave_request_id      INTEGER,
  requester_id          INTEGER,
  replacement_staff_id  INTEGER,
  dates                 TEXT NOT NULL,
  status                VARCHAR(20) DEFAULT 'pending',
  requester_message     TEXT,
  responder_message     TEXT,
  requested_at          TIMESTAMP DEFAULT NOW(),
  responded_at          TIMESTAMP,
  hr_approved_at        TIMESTAMP,
  hr_approved_by        INTEGER
);

-- Indexes mirroring the controller query patterns: lookups by the
-- replacement staff (pending queue), by requester (history), and
-- by status (HR queue). All conditional so re-runs are no-ops.
CREATE INDEX IF NOT EXISTS idx_replacement_requests_replacement_staff
  ON replacement_requests(replacement_staff_id, status)
  WHERE replacement_staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_replacement_requests_requester
  ON replacement_requests(requester_id, requested_at DESC)
  WHERE requester_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_replacement_requests_status
  ON replacement_requests(status, requested_at DESC);

COMMIT;
