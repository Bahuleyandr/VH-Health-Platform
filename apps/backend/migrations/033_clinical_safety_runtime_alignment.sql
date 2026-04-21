-- 033_clinical_safety_runtime_alignment.sql
-- Align raw-SQL clinical safety tables with the MAR/CDS runtime services.

ALTER TABLE medication_administrations
  ADD COLUMN IF NOT EXISTS hold_reason         TEXT,
  ADD COLUMN IF NOT EXISTS refusal_reason      TEXT,
  ADD COLUMN IF NOT EXISTS witness_uid         UUID,
  ADD COLUMN IF NOT EXISTS scanned_patient_uid UUID,
  ADD COLUMN IF NOT EXISTS scanned_barcode     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS rights_passed       JSONB,
  ADD COLUMN IF NOT EXISTS all_rights_passed   BOOLEAN,
  ADD COLUMN IF NOT EXISTS override_reason     TEXT,
  ADD COLUMN IF NOT EXISTS medication_index    INTEGER;

CREATE INDEX IF NOT EXISTS idx_med_admin_patient_time
  ON medication_administrations(patient_uid, administered_at DESC);

ALTER TABLE clinical_protocols
  ADD COLUMN IF NOT EXISTS trigger_conditions JSONB,
  ADD COLUMN IF NOT EXISTS recommendations    JSONB,
  ADD COLUMN IF NOT EXISTS priority           VARCHAR(20) DEFAULT 'medium';

CREATE INDEX IF NOT EXISTS idx_clinical_protocols_active
  ON clinical_protocols(is_active);
