-- 169_swarm_bug_followups.sql
--
-- Schema additions to back the second swarm bug-fix batch
-- (fix/swarm-bug-followups-2026-05-09):
--
--   1. appointments.visit_type
--      A first-class flag for new vs follow-up vs review (vs lab-only,
--      radiology-only, etc.). Free-text reason no longer the only signal.
--      Finding: 2026-05-08-follow-up-opd-doctor-no-visit-type-flag.
--
--   2. appointments.advised_for_admission_{at,by}
--      OPD→IPD bridge — a doctor flips this on a visit, the admission
--      counter sees the new advice in their queue.
--      Finding: 2026-05-08-inpatient-admission-receptionist-no-advise-admission-workflow.
--
--   3. insurance_claims.{non_payable_amount, disallowed_reason,
--      parent_claim_id, stage}
--      Caps the partial-approval gap (settled-partial vs settled-full
--      states need real columns to live in) and threads the
--      enhancement → preauth lineage. parent_claim_id is a self-FK so a
--      claim can point at its predecessor.
--      Findings: 2026-05-08-tpa-insurance-claim-billing-no-settled-partial-state,
--                2026-05-08-tpa-insurance-claim-doctor-enhancement-workflow-absent.
--
--   4. vitals_chart.{fhr, fundal_height_cm}
--      OB-specific vital fields. Existing vitals_chart had no slot for
--      these so OB nurses had no structured place to record them.
--      Finding: 2026-05-08-obstetric-anc-nurse-no-fhr-fundal-fields.
--
--   5. users.{is_pregnant, pregnancy_lmp_date}
--      Pregnancy state for the BP / pre-eclampsia threshold check. A
--      separate maternity_pregnancies subsystem is the real long-term
--      home; for now this is the minimal flag-and-LMP we need so vital-
--      sign monitoring can pick the right thresholds.
--      Finding: 2026-05-08-obstetric-anc-nurse-bp-no-preeclampsia-alert.
--
-- All columns are nullable / additive. No backfill, no destructive ops.

BEGIN;

-- 1. visit_type
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS visit_type VARCHAR(50);

-- 2. advise-for-admission bridge
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS advised_for_admission_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS advised_for_admission_by UUID,
  ADD COLUMN IF NOT EXISTS advised_for_admission_note TEXT;

-- 3. insurance_claims financial-state additions
ALTER TABLE insurance_claims
  ADD COLUMN IF NOT EXISTS non_payable_amount NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS disallowed_reason TEXT,
  ADD COLUMN IF NOT EXISTS parent_claim_id INTEGER REFERENCES insurance_claims(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_insurance_claims_parent
  ON insurance_claims(parent_claim_id)
  WHERE parent_claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_insurance_claims_stage
  ON insurance_claims(stage)
  WHERE stage IS NOT NULL;

-- 4. OB-specific vitals
ALTER TABLE vitals_chart
  ADD COLUMN IF NOT EXISTS fhr INTEGER,
  ADD COLUMN IF NOT EXISTS fundal_height_cm NUMERIC(5, 2);

-- 5. Pregnancy flag on users (interim until maternity_pregnancies subsystem)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_pregnant BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pregnancy_lmp_date DATE;

CREATE INDEX IF NOT EXISTS idx_users_is_pregnant
  ON users(is_pregnant)
  WHERE is_pregnant = TRUE;

COMMIT;
