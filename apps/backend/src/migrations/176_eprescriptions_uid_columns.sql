-- 176_eprescriptions_uid_columns.sql
--
-- Schema drift fix: prisma/schema.prisma declares
-- e_prescriptions.patient_uid + doctor_uid as nullable UUIDs, but no
-- migration creates them. Under-migrated DBs (the swarm tenant) lack
-- the columns entirely; ePrescriptionController.createPrescription was
-- written to skip both fields with the comment "those are joined in
-- via users.uid when needed", so every Rx had null UIDs even on
-- properly-migrated environments. Patient app's Rx-list filter (by
-- patient_uid) then returned empty for walk-ins.
--
-- Fix:
--   1. Idempotently add the two columns (UUID, nullable) so under-
--      migrated DBs catch up without breaking already-migrated ones.
--   2. Backfill historicals from joined users.id → uid.
--   3. Index both for the patient-app + pharmacy lookups.
--
-- Finding: 2026-05-08-walk-in-opd-doctor-prescription-uid-fields-null

BEGIN;

ALTER TABLE e_prescriptions
  ADD COLUMN IF NOT EXISTS patient_uid UUID,
  ADD COLUMN IF NOT EXISTS doctor_uid  UUID;

-- Backfill from int FKs. Safe to run repeatedly: the WHERE clause
-- only updates rows where the uid column is still null.
UPDATE e_prescriptions ep
   SET patient_uid = u.uid
  FROM users u
 WHERE ep.patient_uid IS NULL
   AND u.id = ep.patient_id;

UPDATE e_prescriptions ep
   SET doctor_uid = u.uid
  FROM users u
 WHERE ep.doctor_uid IS NULL
   AND u.id = ep.doctor_id;

CREATE INDEX IF NOT EXISTS idx_eprescriptions_patient_uid
  ON e_prescriptions(patient_uid)
  WHERE patient_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eprescriptions_doctor_uid
  ON e_prescriptions(doctor_uid)
  WHERE doctor_uid IS NOT NULL;

COMMIT;
