-- 354_investigation_specimen_bedside_scan.sql
--
-- Batch 4 item 1 — specimen bedside scanning. The existing collection flow
-- minted/stored the tube barcode in investigations.sample_barcode but did not
-- capture the patient wristband scan used at bedside. Add MAR-style scan
-- evidence columns without making legacy no-scan collection clients fail.

BEGIN;

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS collection_scanned_patient_uid UUID,
  ADD COLUMN IF NOT EXISTS collection_patient_match BOOLEAN,
  ADD COLUMN IF NOT EXISTS patient_scanned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tube_scanned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_investigations_specimen_patient_scan
  ON investigations(collection_scanned_patient_uid, patient_scanned_at DESC)
  WHERE collection_scanned_patient_uid IS NOT NULL;

COMMIT;
