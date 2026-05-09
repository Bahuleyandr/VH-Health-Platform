-- 184_icu_subsystem_polish.sql
--
-- E-4 — ICU subsystem polish.
--
-- Adds the operational fields the ICU nurse needs but the schema didn't
-- carry: monitoring interval (15-min vs hourly cadence), NPO/fasting
-- window, pre-op status. Closes:
--
--   2026-05-08-emergency-walk-in-nurse-no-15min-interval
--     ICU flowsheet had no concept of monitoring interval; couldn't
--     schedule 15-min vitals vs hourly. Default 60 min keeps existing
--     rows valid; admit time can override.
--
--   2026-05-08-emergency-walk-in-nurse-no-fasting-no-io-no-mar-handoff
--     No NPO/fasting flag, no pre_op_status. (I/O endpoint + MAR
--     handoff land in the service layer, not this migration.)
--
-- Architectural item E-4.

BEGIN;

ALTER TABLE icu_admissions
  ADD COLUMN IF NOT EXISTS monitoring_interval_minutes INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS npo_from        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fasting_until   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_op_status   VARCHAR(40);

-- Soft check on the interval — common cadences are 5, 15, 30, 60, 120, 240 min.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'icu_admissions_monitoring_interval_check'
  ) THEN
    ALTER TABLE icu_admissions
      ADD CONSTRAINT icu_admissions_monitoring_interval_check
      CHECK (monitoring_interval_minutes IN (5, 10, 15, 30, 60, 120, 240, 480));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_icu_admissions_npo_active
  ON icu_admissions(npo_from)
  WHERE npo_from IS NOT NULL AND fasting_until IS NULL;

COMMIT;
