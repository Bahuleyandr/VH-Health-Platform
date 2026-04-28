-- Migration 097: add wellness-tracking columns to prescriptions.
--
-- The gamification wellness service (services/gamification/wellnessService.js)
-- and the patient dashboard's WellnessScoreWidget query
-- prescriptions.duration_days + issued_at to compute medication-compliance.
-- Neither column was ever added to the schema, so /gamification/wellness-score
-- 500s every dashboard load. Same family of misses as 093 (clinical_protocols),
-- 094 (gdpr_erasure_log), 096 (medication_reminders) — feature in code,
-- table/columns never migrated.

BEGIN;

ALTER TABLE prescriptions
  ADD COLUMN IF NOT EXISTS duration_days INTEGER,
  ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_status_issued
  ON prescriptions(patient_uid, status, issued_at);

COMMIT;
