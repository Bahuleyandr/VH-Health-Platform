-- Migration 105: investigation_bookings.sla_confirm_target.
--
-- The lab-staff queue endpoint (`getBookingQueue`) marks bookings as
-- SLA-breached when `NOW() > sla_confirm_target AND status='BOOKED'`,
-- and the analytics endpoint groups by the same column. Migration 098
-- created sla_dispatch_target / sla_collect_target / sla_result_target
-- but missed sla_confirm_target — so every queue load 500'd with
-- `column "ib.sla_confirm_target" does not exist`.
--
-- Default: NOW() + 30 min on insert via trigger (matches the implicit
-- "lab should confirm new bookings within 30 min" SLA the analytics
-- code assumes). Existing rows get NULL — they're stale demo data
-- and would never be flagged as breached anyway.

BEGIN;

ALTER TABLE investigation_bookings
  ADD COLUMN IF NOT EXISTS sla_confirm_target TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_invbook_sla_breached
  ON investigation_bookings(sla_confirm_target)
  WHERE status = 'BOOKED' AND sla_confirm_target IS NOT NULL;

-- Backfill default for new bookings via the existing booking-number trigger.
CREATE OR REPLACE FUNCTION investigation_bookings_set_number()
RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.booking_number IS NULL OR NEW.booking_number = '' THEN
    NEW.booking_number := 'INV-' || to_char(CURRENT_DATE, 'YYYYMMDD')
                          || '-' || lpad(nextval('investigation_bookings_number_seq')::text, 5, '0');
  END IF;
  IF NEW.sla_confirm_target IS NULL THEN
    NEW.sla_confirm_target := NOW() + INTERVAL '30 minutes';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

COMMIT;
