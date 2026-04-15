-- Tag patient_vitals rows with their origin so HealthKit / Google Fit background
-- syncs can be reconciled without double-posting. `recorded_at_source` is the
-- wearable's own timestamp (distinct from `recorded_at`, which is insert time);
-- clients use it to compute deltas since last sync per source.

ALTER TABLE patient_vitals
  ADD COLUMN IF NOT EXISTS source              VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS recorded_at_source  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_patient_vitals_source_time
  ON patient_vitals(patient_uid, source, recorded_at_source DESC);
