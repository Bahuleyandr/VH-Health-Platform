-- 216_billing_invoice_items_tpa_decision.sql
--
-- Wave-5 batch-3 — TPA non-payable proactive disclosure.
--
-- Background. Today the non-payable component of an IPD bill (room
-- upgrade delta, pharmacy over-cap, attendant charges, premium-IOL
-- delta on a cataract package, etc.) is computed manually by the
-- TPA desk only at discharge. The patient learns about it when the
-- cashier presents the final bill — far too late to dispute or
-- choose differently. Migration 199 added source-ref columns to
-- billing_invoice_items so each line can be traced back to its
-- producing record; this migration adds the TPA-decision columns
-- so the line itself carries its payable/non-payable verdict and
-- can be surfaced on the patient portal as it accumulates.
--
-- Findings:
--   2026-05-09-tpa-insurance-claim-discharge-nonpayable-not-disclosed-proactively
--   2026-05-10-surgical-day-care-billing-package-not-itemised-iol-delta-opaque
--
-- Columns added to billing_invoice_items:
--   * tpa_decision         — 'payable' | 'non_payable' | 'partial' | 'pending'
--                            (default 'pending' for new lines, NULL for
--                            historicals — backfilled by service layer).
--   * tpa_non_payable_reason — short text (e.g. 'room_upgrade_delta',
--                            'over_cap_pharmacy', 'attendant_charges',
--                            'cosmetic', 'package_addon').
--   * tpa_decided_at       — when the decision was recorded.
--   * tpa_decided_by       — uuid of the TPA desk operator who recorded
--                            it (or null for the auto-itemizer's
--                            algorithmic default).

BEGIN;

ALTER TABLE billing_invoice_items
  ADD COLUMN IF NOT EXISTS tpa_decision           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS tpa_non_payable_reason VARCHAR(60),
  ADD COLUMN IF NOT EXISTS tpa_decided_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tpa_decided_by         UUID;

-- Partial index for the patient-portal "non-payable preview" query
-- and the cashier's discharge-time reconciliation. Most lines are
-- payable; only flag the exceptions.
CREATE INDEX IF NOT EXISTS idx_billing_invoice_items_non_payable
  ON billing_invoice_items(invoice_id)
  WHERE tpa_decision IN ('non_payable', 'partial');

COMMIT;
