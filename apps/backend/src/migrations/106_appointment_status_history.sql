-- Migration 106: appointment_status_history audit table.
--
-- The appointment workflow controller (confirm, no-show, complete, cancel,
-- walk-in registration, getAppointmentHistory) and the admin audit fetch
-- have all been writing to / reading from `appointment_status_history`,
-- which never existed in any prior migration. Every staff-side appointment
-- lifecycle action 500'd as a result. This adds the table with the columns
-- the controllers already write to + the JOIN getAppointmentHistory needs.
--
-- Mirrors investigation_booking_history (migration 098) in shape.

BEGIN;

CREATE TABLE IF NOT EXISTS appointment_status_history (
  id              BIGSERIAL PRIMARY KEY,
  appointment_id  INTEGER NOT NULL,
  from_status     VARCHAR(40),
  to_status       VARCHAR(40) NOT NULL,
  changed_by      INTEGER,
  changed_by_role VARCHAR(40),
  reason          TEXT,
  created_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT appt_status_hist_appointment_fk
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT appt_status_hist_user_fk
    FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_appt_status_hist_appointment_id_time
  ON appointment_status_history(appointment_id, created_at);

COMMIT;
