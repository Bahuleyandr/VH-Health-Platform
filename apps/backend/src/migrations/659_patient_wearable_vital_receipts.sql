-- 659_patient_wearable_vital_receipts.sql
--
-- @no-transaction
-- @statement_timeout: 0
--
-- Durable, tenant/user/source/sample-scoped receipts for patient wearable
-- vitals. A mobile process can die after the database commits but before its
-- local checkpoint advances; the unique receipt makes that replay return the
-- original row instead of creating a second clinical write.

ALTER TABLE public.patient_vitals
  ADD COLUMN IF NOT EXISTS source_record_id VARCHAR(180),
  ADD COLUMN IF NOT EXISTS source_record_hash CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.patient_vitals'::regclass
       AND conname = 'chk_patient_vitals_source_receipt_pair'
  ) THEN
    ALTER TABLE public.patient_vitals
      ADD CONSTRAINT chk_patient_vitals_source_receipt_pair
      CHECK (
        (source_record_id IS NULL AND source_record_hash IS NULL)
        OR (
          source_record_id IS NOT NULL
          AND source_record_id ~ '^[A-Za-z0-9_.:-]{1,180}$'
          AND source_record_hash ~ '^[0-9a-f]{64}$'
          AND source IN ('healthkit', 'health_connect', 'google_fit')
          AND recorded_at_source IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.patient_vitals
  VALIDATE CONSTRAINT chk_patient_vitals_source_receipt_pair;

DROP INDEX CONCURRENTLY IF EXISTS public.ux_patient_vitals_wearable_receipt_invalid_rebuild;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index
     WHERE indexrelid = to_regclass('public.ux_patient_vitals_wearable_receipt')
       AND NOT indisvalid
  ) THEN
    ALTER INDEX public.ux_patient_vitals_wearable_receipt
      RENAME TO ux_patient_vitals_wearable_receipt_invalid_rebuild;
  END IF;
END $$;
DROP INDEX CONCURRENTLY IF EXISTS public.ux_patient_vitals_wearable_receipt_invalid_rebuild;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_patient_vitals_wearable_receipt
  ON public.patient_vitals (tenant_id, patient_uid, source, source_record_id)
  WHERE source_record_id IS NOT NULL;
