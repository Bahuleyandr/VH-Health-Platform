-- Migration 218 — tpa_claims.settled_partial status + disallowed_amount column.
--
-- Refs:
--   finding 2026-05-09-tpa-insurance-claim-billing-no-settled-partial-state
--   finding 2026-05-10-tpa-insurance-claim-billing-settlement-collapses-to-paid
--
-- A partially-paid claim today collapses to status='paid'. Finance
-- cannot tell a fully-paid claim from one the insurer short-paid by
-- INR 2000 — both surface in the aging view with bucket='paid'.
-- This blocks disallowance follow-up (TPA disputes are deadline-bound
-- per Indian payer norms — typically 30 days).
--
-- Adds:
--   * 'settled_partial' to the tpa_claims status CHECK.
--   * disallowed_amount NUMERIC(14,2) column to track what the
--     insurer refused at settlement. Distinct from non_payable_amount
--     (food/attendant exclusions known at claim time).
--   * tpa_claims_aging.aging_bucket = 'settled_partial' so the
--     coordinator dashboard can filter.

BEGIN;

ALTER TABLE tpa_claims
  DROP CONSTRAINT IF EXISTS tpa_claims_status_check;

ALTER TABLE tpa_claims
  ADD CONSTRAINT tpa_claims_status_check
  CHECK (status IN ('prepared', 'submitted', 'queried',
                    'approved', 'partially_approved', 'denied',
                    'paid', 'settled_partial', 'closed', 'cancelled'));

ALTER TABLE tpa_claims
  ADD COLUMN IF NOT EXISTS disallowed_amount NUMERIC(14, 2);

-- Postgres can't reshape a view in place when new columns are inserted
-- in the middle. DROP then CREATE; the view has no dependants today.
DROP VIEW IF EXISTS tpa_claims_aging;

CREATE VIEW tpa_claims_aging AS
SELECT
  c.id, c.claim_number, c.patient_uid, c.claim_type,
  c.status, c.claimed_amount, c.approved_amount, c.paid_amount,
  c.disallowed_amount, c.non_payable_amount,
  c.submitted_at,
  EXTRACT(EPOCH FROM (NOW() - COALESCE(c.submitted_at, c.created_at))) / 86400 AS days_since_submit,
  CASE
    WHEN c.status = 'paid' THEN 'paid'
    WHEN c.status = 'settled_partial' THEN 'settled_partial'
    WHEN c.status = 'denied' THEN 'denied'
    WHEN COALESCE(c.submitted_at, c.created_at) < NOW() - INTERVAL '30 days' THEN '30+_days_aging'
    WHEN COALESCE(c.submitted_at, c.created_at) < NOW() - INTERVAL '15 days' THEN '15-30_days_aging'
    ELSE 'fresh'
  END AS aging_bucket,
  p.policy_number, p.payer_id, p.tpa_id,
  c.tenant_id
FROM tpa_claims c
JOIN insurance_policies p ON p.id = c.policy_id;

COMMIT;
