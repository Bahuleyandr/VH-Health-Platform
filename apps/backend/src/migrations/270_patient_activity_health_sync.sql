-- Patient-generated activity summaries from Health Connect / HealthKit /
-- future wearable connectors. Existing GPS walk sessions remain `manual`;
-- synced all-day summaries use one source-labelled row per patient/source/day.

ALTER TABLE step_sessions
  ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_day DATE,
  ADD COLUMN IF NOT EXISTS sleep_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_energy_kcal NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS source_device VARCHAR(120),
  ADD COLUMN IF NOT EXISTS source_app VARCHAR(120),
  ADD COLUMN IF NOT EXISTS recorded_at_source TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_step_sessions_user_source_day
  ON step_sessions (user_uid, source, source_day)
  WHERE source_day IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_step_sessions_source_day
  ON step_sessions (source, source_day DESC);

