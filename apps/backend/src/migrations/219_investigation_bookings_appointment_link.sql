-- Migration 219 — investigation_bookings.appointment_id FK.
--
-- Ref: finding 2026-05-09-lab-walk-in-receptionist-booking-not-linked-to-appointment
--
-- Lab bookings created from a walk-in / OPD visit had no way to record
-- which visit produced them. Receptionist couldn't tell the lab counter
-- "this visit links to booking INV-…" through the system, and the lab
-- worklist couldn't surface the ordering-visit token. Adds:
--   * appointment_id INT — FK -> appointments(id) ON DELETE SET NULL.
--   * idx_invbook_appointment_id for cross-reference lookups.
--
-- Nullable + additive — historic bookings keep NULL; the receptionist
-- + patient self-book paths can now persist the link when supplied.

BEGIN;

ALTER TABLE investigation_bookings
  ADD COLUMN IF NOT EXISTS appointment_id INTEGER;

ALTER TABLE investigation_bookings
  DROP CONSTRAINT IF EXISTS investigation_bookings_appointment_fk;

ALTER TABLE investigation_bookings
  ADD CONSTRAINT investigation_bookings_appointment_fk
    FOREIGN KEY (appointment_id) REFERENCES appointments(id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

CREATE INDEX IF NOT EXISTS idx_invbook_appointment_id
  ON investigation_bookings(appointment_id);

COMMIT;
