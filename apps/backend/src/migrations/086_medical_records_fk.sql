-- 086_medical_records_fk.sql
--
-- Declares the medical_records.doctor_id FK so Prisma introspection
-- produces an include-capable relation — same pattern as batches 082,
-- 083, 084, 085 across investigations / pharmacy_orders / appointments /
-- referrals.
--
-- Not in this migration:
--   * medical_records.patient_id → users.uid — the existing
--     recordService.js raw SQL has two inconsistent interpretations of
--     this column (some queries treat it as uuid, others as int). The
--     DB schema says uuid, but createMedicalRecord passes parseInt().
--     Adding the FK now would surface that drift as a test failure; the
--     four-query rewrite in this same batch lands on the uuid semantics
--     but leaving the FK off until a dedicated cleanup batch can run a
--     patient_id audit.
--   * health_records — the healthRecordService.js raw SQL references
--     columns (patient_id, recorded_by, recorded_date, vital_signs,
--     measurements, symptoms, notes) that do not exist on the live
--     health_records table (which is actually a file-upload table with
--     phone + uid + file_key etc.). The service is known-broken but
--     out of scope for a SELECT+JOIN migration. Flagged for a
--     dedicated drift-resolution batch.
--
-- Pre-flight on dev (medical_records, 2026-04-24):
--   * 0 rows total (table is unused on this DB)
--   * 0 orphan doctor_id rows
-- → FK validates trivially.

ALTER TABLE medical_records
  DROP CONSTRAINT IF EXISTS medical_records_doctor_id_fkey,
  ADD CONSTRAINT medical_records_doctor_id_fkey
    FOREIGN KEY (doctor_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
