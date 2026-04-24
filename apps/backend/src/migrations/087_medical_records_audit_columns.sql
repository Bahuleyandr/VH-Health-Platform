-- 087_medical_records_audit_columns.sql
--
-- Closes the write-path drift flagged in batch 43's commit. The
-- recordService write functions
-- (createMedicalRecord / updateMedicalRecord / softDeleteRecord) already
-- write to these columns, but they don't exist on the live table — so
-- any real call to those endpoints would 500 with "column does not
-- exist". The table is empty on dev, which is why the drift has been
-- latent.
--
-- Also adds:
--   * FK on medical_records.patient_id → users.uid (UUID→UUID); migration
--     086 deliberately skipped this because the write path treats
--     patient_id as an int and would have failed the FK validation.
--     Batch 46 rewrites the service to resolve int → uuid first, so the
--     constraint is now safe to add.
--   * FK on medical_records.created_by / updated_by / deleted_by →
--     users.uid for the three audit columns that are / will be uuid.
--
-- Pre-flight on dev (2026-04-24):
--   * 0 rows total — all ALTERs validate trivially.

ALTER TABLE medical_records
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by UUID,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE medical_records
  DROP CONSTRAINT IF EXISTS medical_records_patient_id_fkey,
  ADD CONSTRAINT medical_records_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

ALTER TABLE medical_records
  DROP CONSTRAINT IF EXISTS medical_records_created_by_fkey,
  ADD CONSTRAINT medical_records_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

ALTER TABLE medical_records
  DROP CONSTRAINT IF EXISTS medical_records_updated_by_fkey,
  ADD CONSTRAINT medical_records_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

ALTER TABLE medical_records
  DROP CONSTRAINT IF EXISTS medical_records_deleted_by_fkey,
  ADD CONSTRAINT medical_records_deleted_by_fkey
    FOREIGN KEY (deleted_by) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

-- Index for soft-delete filtering (is_active = true predicate becomes
-- the primary filter for list views).
CREATE INDEX IF NOT EXISTS idx_medical_records_is_active
  ON medical_records (is_active)
  WHERE is_active = false;
