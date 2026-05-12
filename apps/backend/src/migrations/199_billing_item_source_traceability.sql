-- 199_billing_item_source_traceability.sql
--
-- Bug: the IPD final bill collapses every charge into a single
-- untraceable package line. The cashier can't prove which services
-- were charged, the TPA desk can't reconcile the bill against
-- approved caps, and the patient/family has no breakdown to review.
-- billing_invoice_items has description + line_total but no pointer
-- back to the source order/indent/room-day that produced the charge.
-- Finding:
--   2026-05-10-inpatient-admission-billing-final-bill-untraceable-package-line
--
-- This migration adds two columns:
--   * source_ref_type — the producing record type
--                       ('lab_order' | 'radiology_order' | 'pharmacy_order'
--                        | 'ward_indent' | 'room_day' | 'discharge_consult'
--                        | 'theatre_case' | 'admission_package'
--                        | 'package' | 'manual')
--   * source_ref_id   — the producing record's int id (nullable; 'manual'
--                       and 'package' rows legitimately have no source).
--
-- A partial index supports the readiness gate / itemizer joining back
-- from the source side. Existing rows get source_ref_type='manual' as
-- a backfill so the validity check in code can be tightened later
-- without breaking historicals.

BEGIN;

ALTER TABLE billing_invoice_items
  ADD COLUMN IF NOT EXISTS source_ref_type VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source_ref_id   INTEGER;

UPDATE billing_invoice_items
   SET source_ref_type = 'manual'
 WHERE source_ref_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_source_ref
  ON billing_invoice_items(source_ref_type, source_ref_id)
  WHERE source_ref_type IS NOT NULL AND source_ref_id IS NOT NULL;

COMMIT;
