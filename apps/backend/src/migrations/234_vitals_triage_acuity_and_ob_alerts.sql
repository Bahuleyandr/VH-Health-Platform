-- Vitals triage acuity spine.
-- Findings:
--   2026-05-16-emergency-walk-in-nurse-44a9ace1
--   2026-05-16-pediatric-opd-nurse-b7cc7e3d
--   2026-05-16-obstetric-anc-nurse-680a3424

ALTER TABLE vitals_chart
  ADD COLUMN IF NOT EXISTS triage_acuity SMALLINT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS triage_acuity SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_vitals_chart_triage_acuity'
  ) THEN
    ALTER TABLE vitals_chart
      ADD CONSTRAINT chk_vitals_chart_triage_acuity
      CHECK (triage_acuity IS NULL OR triage_acuity BETWEEN 1 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_appointments_triage_acuity'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT chk_appointments_triage_acuity
      CHECK (triage_acuity IS NULL OR triage_acuity BETWEEN 1 AND 5);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vitals_chart_triage_acuity
  ON vitals_chart (patient_uid, recorded_at DESC)
  WHERE triage_acuity IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_emergency_triage_acuity
  ON appointments (triage_acuity ASC NULLS LAST, appointment_date, appointment_time)
  WHERE triage_acuity IS NOT NULL;
