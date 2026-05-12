-- 201_pharmacy_dispense_payload_columns.sql
--
-- Wave-3 batch-1 — counter-dispense payload plumbing. Closes:
--   2026-05-09-pediatric-opd-pharmacy-zero-bill-no-items
--   2026-05-10-pediatric-opd-pharmacy-dispense-payload-label-payment-dropped
--   2026-05-10-walk-in-opd-pharmacy-partial-dispense-payment-ignored
--
-- The counter-dispense endpoint accepted a payment+label+partial payload
-- but never wrote it down. Add explicit columns so the data survives the
-- request and a `GET /:id/detail` (and the upcoming label endpoint) can
-- read it back without re-parsing free-text confirmation_notes.
--
--   payment_mode         cash | corporate_tpa | insurance | upi | card
--   amount_collected     numeric — cash actually taken at counter
--   partial_dispense     true when dispensed_qty < ordered_qty on any line
--   partial_reason       free-text "why partial" (low stock, allergy, etc.)
--   receipt_delivery     phone | print | none
--   payment_metadata     jsonb — insurer / policy_number / package_deduction
--                          / TPA reference / guardian acknowledgement
--   dispense_label       jsonb — rendered label snapshot for reprint
--                          (patient name/weight, items, instructions)

BEGIN;

ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS payment_mode      VARCHAR(40),
  ADD COLUMN IF NOT EXISTS amount_collected  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS partial_dispense  BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS partial_reason    TEXT,
  ADD COLUMN IF NOT EXISTS receipt_delivery  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS payment_metadata  JSONB,
  ADD COLUMN IF NOT EXISTS dispense_label    JSONB;

-- Backfill the boolean default explicitly for any rows that pre-date
-- the column (ALTER TABLE ADD COLUMN with DEFAULT FALSE already does
-- this in PG12+, but keep the UPDATE as a safety net for partial rollouts).
UPDATE pharmacy_orders SET partial_dispense = FALSE WHERE partial_dispense IS NULL;

COMMIT;
