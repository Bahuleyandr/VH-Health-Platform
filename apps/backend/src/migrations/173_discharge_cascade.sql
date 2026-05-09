-- 173_discharge_cascade.sql
--
-- Discharge cascade — the orchestrated flow from "mark for discharge" to
-- "patient walked out". Lifecycle markers on admissions for efficiency
-- tracking; new discharge_consults table for the dietary + physiotherapy
-- (and future) referrals that fire on mark-for-discharge; jsonb snapshot
-- of attending doctors on the discharge_summaries header (computed from
-- the actual doctors who entered notes during the admission, not a
-- single static field).
--
-- Per project decision 2026-05-09:
--   - Mark-for-discharge auto-generates the draft summary, closes
--     billing (soft freeze), opens dietary + physio consults, and
--     generates the TPA final claim if insurance applies.
--   - Time markers: T0 mark, T1 first edit, T2 sign, T3 drugs
--     dispensed, T4 patient physically left.
--   - Procedures section in the summary takes the FULL verbatim body
--     from the procedure clinical_notes — no truncation.
--   - Billing close is soft in v1 (column + UI flag); hard enforcement
--     across all invoice-creation paths is a separate follow-up.
--
-- Findings: derived from product conversation 2026-05-09 (no swarm
-- finding; this is the broader architectural item D2 we agreed to ship).

BEGIN;

-- Lifecycle time markers on the admission.
ALTER TABLE admissions
  -- T0: when "mark for discharge" was called. Stamps soft-billing-close
  -- + draft-summary generation + consult opening at the same moment.
  ADD COLUMN IF NOT EXISTS discharge_initiated_at      TIMESTAMPTZ,
  -- Soft billing-close flag. Downstream invoice-create paths SHOULD
  -- check this; today only the cashier UI surfaces "billing closed".
  -- Hard middleware enforcement is a follow-up.
  ADD COLUMN IF NOT EXISTS billing_closed_at           TIMESTAMPTZ,
  -- T1: first edit on the auto-generated draft. Stamped by
  -- saveDischargeSummary on the first non-empty save after T0.
  ADD COLUMN IF NOT EXISTS summary_first_edit_at       TIMESTAMPTZ,
  -- T2: doctor countersigned the summary (mirrors
  -- discharge_summaries.signed_at — denormalized so admissions queries
  -- don't need to join).
  ADD COLUMN IF NOT EXISTS summary_signed_at           TIMESTAMPTZ,
  -- T3: pharmacy dispensed the discharge takeaway drugs.
  ADD COLUMN IF NOT EXISTS discharge_drugs_dispensed_at TIMESTAMPTZ;
-- T4: existing admissions.discharged_at — semantics tightened to
-- "patient physically left the hospital" (not "discharge initiated").
-- No column change needed.

CREATE INDEX IF NOT EXISTS idx_admissions_discharge_initiated
  ON admissions(discharge_initiated_at)
  WHERE discharge_initiated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admissions_billing_closed
  ON admissions(billing_closed_at)
  WHERE billing_closed_at IS NOT NULL;

-- Discharge consults — referrals that open when a patient is marked
-- for discharge. Today: dietary, physiotherapy. Schema is generic so
-- pharmacist counselling, social worker, etc. can plug in later
-- without a migration.
CREATE TABLE IF NOT EXISTS discharge_consults (
  id              SERIAL PRIMARY KEY,
  admission_id    INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  patient_uid     UUID NOT NULL,
  consult_type    VARCHAR(40) NOT NULL,
    -- 'dietary' | 'physiotherapy' | 'pharmacist_counselling' | 'social_worker' | …
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by    UUID,        -- the staff uid that flipped mark-for-discharge
  completed_at    TIMESTAMPTZ,
  completed_by    UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (admission_id, consult_type)
);

CREATE INDEX IF NOT EXISTS idx_discharge_consults_admission
  ON discharge_consults(admission_id);
CREATE INDEX IF NOT EXISTS idx_discharge_consults_pending
  ON discharge_consults(consult_type, requested_at DESC)
  WHERE completed_at IS NULL;

-- Attending-doctors snapshot lives inside clinical_notes.content as
-- attending_doctors_snapshot — the existing dischargeSummaryGenerator
-- persists the structured draft summary to clinical_notes.content
-- (not the migration-159 discharge_summaries table, which the running
-- code doesn't write to today). Storing the snapshot in the same
-- JSONB blob keeps the draft self-contained.
--
-- The snapshot is a JSON array of:
--   { uid, name, designation, first_seen_at, last_seen_at, note_count }
-- computed from clinical_notes authored during the admission window
-- (each round / progress note in the system records its author).

COMMIT;
