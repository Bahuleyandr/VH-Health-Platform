-- 189_paediatric_subsystem_polish.sql
--
-- E-9 — paediatric subsystem polish.
--
-- Closes:
--   2026-05-08-pediatric-opd-receptionist-doctor-list-no-age-filter
--     doctors gain age_range so /doctors?age_range=paediatric returns
--     only paediatricians + family-med doctors who see kids.
--
--   2026-05-08-pediatric-opd-receptionist-no-guardian-model
--     users gain guardian_name / guardian_phone / guardian_relationship
--     so a 2-year-old's chart links to the parent who signed consent.
--
-- The other two paediatric findings (no-dob-no-gender-walkin,
-- quickstart-walkin-path-stale) are UI-side — backend already accepts
-- patient_birthday + patient_gender in /appointments/walk-in.

BEGIN;

-- 1. Doctor age range
ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS age_range VARCHAR(20) NOT NULL DEFAULT 'all';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'doctors_age_range_check'
  ) THEN
    ALTER TABLE doctors
      ADD CONSTRAINT doctors_age_range_check
      CHECK (age_range IN ('paediatric', 'adult', 'all'));
  END IF;
END $$;

-- Backfill: doctors flagged as paediatricians by specialty get
-- 'paediatric'. Everyone else stays 'all' (the conservative default).
UPDATE doctors
   SET age_range = 'paediatric'
 WHERE LOWER(COALESCE(specialty, '')) IN
   ('paediatrics', 'pediatrics', 'paediatric', 'pediatric', 'neonatology');

CREATE INDEX IF NOT EXISTS idx_doctors_age_range
  ON doctors(age_range)
  WHERE age_range != 'all';

-- 2. Guardian fields on users (for minor patients)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS guardian_name         VARCHAR(160),
  ADD COLUMN IF NOT EXISTS guardian_phone        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS guardian_relationship VARCHAR(40);
  -- 'mother' | 'father' | 'grandparent' | 'legal_guardian' | 'other'

CREATE INDEX IF NOT EXISTS idx_users_guardian_phone
  ON users(guardian_phone)
  WHERE guardian_phone IS NOT NULL;

COMMIT;
