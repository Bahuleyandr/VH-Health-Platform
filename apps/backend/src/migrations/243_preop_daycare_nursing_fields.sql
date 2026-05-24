-- 243_preop_daycare_nursing_fields.sql
-- Preserve day-care pre-op nursing observations instead of dropping them.
BEGIN;

ALTER TABLE preop_checklists
  ADD COLUMN IF NOT EXISTS blood_glucose_mg_dl NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS blood_glucose_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eye_drops_given BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS eye_drops_given_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eye_drops_notes TEXT;

COMMIT;
