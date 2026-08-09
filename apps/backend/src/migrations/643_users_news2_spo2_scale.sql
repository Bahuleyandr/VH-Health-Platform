-- 643: patient-level NEWS2 SpO2 scale flag (C-M7).
--
-- RCP NEWS2 (2017): SpO2 Scale 2 (target saturation 88-92%) applies ONLY to
-- patients with a clinically confirmed hypercapnic-respiratory-failure risk
-- (e.g. COPD with documented CO2 retention). Until now the scale was whatever
-- each API caller supplied per reading, and the primary vitals path never
-- supplied one — every patient was force-scored on Scale 1. This column is the
-- patient-level source of truth the scorer resolves when a caller supplies no
-- explicit scale (news2Service.resolveSpo2ScaleForPatient). Mirrors the
-- users.is_pregnant cohort-flag precedent from migration 169.
--
-- Default 1 (Scale 1) is the clinically safe default: Scale 2's relaxed
-- low-saturation bands must never apply to a patient without the documented
-- risk decision.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS news2_spo2_scale SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_news2_spo2_scale;
ALTER TABLE users
  ADD CONSTRAINT chk_users_news2_spo2_scale CHECK (news2_spo2_scale IN (1, 2));

-- Scale-2 patients are a small cohort; partial index mirrors idx_users_is_pregnant.
CREATE INDEX IF NOT EXISTS idx_users_news2_spo2_scale
  ON users (news2_spo2_scale)
  WHERE news2_spo2_scale = 2;
