-- 028_patient_vitals.sql
-- Patient self-reported vitals (from the patient app Vitals screen)

CREATE TABLE IF NOT EXISTS patient_vitals (
  id            SERIAL PRIMARY KEY,
  patient_uid   UUID NOT NULL,
  blood_pressure JSONB,          -- {"systolic": 120, "diastolic": 80}
  heart_rate    INT,
  temperature   NUMERIC(5,2),    -- e.g. 98.60
  blood_sugar   INT,
  weight        NUMERIC(5,2),    -- kg
  spo2          INT,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_vitals_uid ON patient_vitals (patient_uid);
CREATE INDEX IF NOT EXISTS idx_patient_vitals_recorded ON patient_vitals (patient_uid, recorded_at DESC);
