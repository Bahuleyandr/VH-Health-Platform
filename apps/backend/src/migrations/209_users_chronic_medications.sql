-- 209_users_chronic_medications.sql
--
-- Wave-4B-1 — structured chronic medications surface on users for discharge
-- medication reconciliation.
--
-- Closes finding:
--   2026-05-10-inpatient-admission-discharge-drug-reconciliation-drops-chronic-meds
--
-- Background: the discharge medication draft built by `dischargeSummaryGenerator`
-- iterates active inpatient `clinical_orders` of type 'medication' but has no
-- view of the patient's *chronic* meds (Metformin, Atorvastatin, Levothyroxine,
-- etc.) that should continue after discharge. The patient app stored these as
-- free-text in `users.medical_history`, which is unstructured and not
-- reconciliable. Silent omission risks stopped chronic therapy after discharge.
--
-- We add a structured surface on `users`:
--   * chronic_medications JSONB     — array of {name, dose, frequency,
--                                     started_at, indication, reconciled_at}.
--                                     Default '[]' so existing reads stay safe.
--   * chronic_medications_updated_at TIMESTAMPTZ — last reconciliation timestamp.
--
-- The discharge service merges this list into the discharge medication draft
-- with a `reconciliation_status` per entry (continue / stop / hold / restart /
-- missing-warn-on-omit). A new safety flag CHRONIC_MED_NOT_RECONCILED fires
-- when chronic meds are present but absent from the discharge list.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS chronic_medications            JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS chronic_medications_updated_at TIMESTAMPTZ;

-- The chronic_medications column is array-shaped; a GIN index makes any
-- future "find patients on Atorvastatin" query cheap. Optional, low cost.
CREATE INDEX IF NOT EXISTS idx_users_chronic_medications_gin
  ON users USING GIN (chronic_medications);

COMMIT;
