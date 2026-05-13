-- 211_tpa_claim_line_decisions.sql
-- Wave 5 batch 2 — patient bill disallowance breakdown
-- (finding 2026-05-09-tpa-insurance-claim-patient-bill-no-disallowance-breakdown).
--
-- The TPA cashless workflow already records aggregate `non_payable_amount`
-- on tpa_claims, plus `tpa_claim_correspondence` for the insurer's free-text
-- query / approval messages. What's missing is the **per-line decision**:
-- given a ₹78,000 bill where the TPA approved ₹58,000, which specific
-- billing_invoice_items lines were trimmed and why?
--
-- IRDAI requires itemised non-payable explanations to cashless patients at
-- discharge. The patient's own bill view today shows only totals + payments;
-- without per-line context the patient cannot reconcile "₹20,000
-- non-payable" against their policy.
--
-- This migration adds the join table so the staff TPA-coordinator can
-- record per-item decisions, and the patient bill endpoint can surface
-- them. No backfill — existing claims show only aggregate non_payable.

CREATE TABLE IF NOT EXISTS tpa_claim_line_decisions (
  id                  SERIAL PRIMARY KEY,
  claim_id            INTEGER NOT NULL
                        REFERENCES tpa_claims(id) ON DELETE CASCADE,
  invoice_item_id     INTEGER NOT NULL
                        REFERENCES billing_invoice_items(id) ON DELETE CASCADE,
  -- Constrained set of reason codes. Patient app maps to plain-language
  -- text — never shows the raw code. Keep extensible by widening the
  -- CHECK rather than swapping for an enum (cheaper future migrations).
  reason_code         VARCHAR(40) NOT NULL
                        CHECK (reason_code IN (
                          'room_upgrade',
                          'over_cap_pharmacy',
                          'over_cap_consumables',
                          'non_listed',
                          'partial_approval',
                          'co_pay',
                          'sub_limit',
                          'pre_existing_waiting',
                          'other'
                        )),
  -- Free-text reason from the insurer / TPA coordinator. May supplement
  -- or supersede the reason_code for the patient-visible explanation.
  reason_text         TEXT,
  -- The billed line amount the TPA approved. Defaults to 0 when the
  -- whole line was disallowed.
  approved_amount     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  -- The disallowed portion of the line. approved + non_payable should
  -- equal billing_invoice_items.line_total but we don't enforce that —
  -- partial co-pay can split the line three ways. App-layer validation.
  non_payable_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  recorded_by         UUID,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id           UUID NOT NULL
                        DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  -- Exactly one decision per (claim, line) pair. Editing a decision
  -- replaces in place (idempotent).
  UNIQUE (claim_id, invoice_item_id)
);

CREATE INDEX IF NOT EXISTS idx_tpa_claim_line_decisions_claim
  ON tpa_claim_line_decisions (claim_id);
CREATE INDEX IF NOT EXISTS idx_tpa_claim_line_decisions_invoice_item
  ON tpa_claim_line_decisions (invoice_item_id);

COMMENT ON TABLE tpa_claim_line_decisions IS
  'Per-line TPA decisions (approved vs non-payable) for a tpa_claims row. Surfaced on the patient bill so the patient can see which lines were disallowed and why. IRDAI itemised-disclosure requirement.';
COMMENT ON COLUMN tpa_claim_line_decisions.reason_code IS
  'Stable code the patient app maps to plain-language text (e.g. room_upgrade → "Room upgrade beyond policy entitlement").';
COMMENT ON COLUMN tpa_claim_line_decisions.reason_text IS
  'Free-text reason from the insurer / TPA coordinator (supplements reason_code; surfaced verbatim in the patient app).';
