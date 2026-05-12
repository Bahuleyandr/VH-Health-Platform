-- 202_walkin_demographics_guardian_minor.sql
--
-- Wave-3 batch-2 — walk-in registration field gaps.
--
-- Closes the high-severity findings around walk-in intake silently dropping
-- demographics, guardian legal-ID, dependent-profile linkage, paediatric
-- weight, and the unidentified-ER path:
--
--   2026-05-08-obstetric-anc-receptionist-walkin-drops-anc-fields
--   2026-05-10-obstetric-anc-receptionist-walkin-ui-no-anc-fields
--   2026-05-08-pediatric-opd-receptionist-no-dob-no-gender-walkin
--   2026-05-08-pediatric-opd-receptionist-no-guardian-model
--   2026-05-10-pediatric-opd-receptionist-minor-guardian-id-not-structured
--   2026-05-11-pediatric-opd-receptionist-7501ae08
--   2026-05-09-pediatric-opd-patient-no-dependent-profile
--   2026-05-09-emergency-walk-in-receptionist-no-phone-optional-er-path
--
-- DOB (`birthday`), gender, guardian_name/phone/relationship already exist on
-- `users` after migration 189. LMP also exists (`pregnancy_lmp_date`). The
-- gaps this migration closes:
--
--   * weight_kg              — paediatric weight-based-dosing intake capture
--   * guardian_id_type       — structured legal-ID kind (aadhaar / pan / ...)
--   * guardian_id_reference  — masked legal-ID reference (last4 / hashed)
--   * guardian_user_id       — FK link to the guardian's own users row, so a
--                              mother with two children references one
--                              shared adult account (dependent-profile
--                              model — the family_members table covers
--                              non-account dependents, this column covers
--                              guardian-with-own-account)
--   * is_minor               — explicit flag (derivable from birthday but
--                              the UI/RBAC layer wants a cheap bool)
--   * is_unidentified        — emergency unidentified-patient flag; lets
--                              the walk-in endpoint mint a synthetic
--                              placeholder phone (UNIDENT-EMER-<ts>) without
--                              violating the existing UNIQUE(phone)
--                              constraint, and surfaces "merge me" candidates
--                              to a future identity-reconciliation flow
--
-- All additions are nullable / default-false so backfill is a no-op.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS weight_kg             NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS guardian_id_type      VARCHAR(30),
  ADD COLUMN IF NOT EXISTS guardian_id_reference VARCHAR(80),
  ADD COLUMN IF NOT EXISTS guardian_user_id      INTEGER,
  ADD COLUMN IF NOT EXISTS is_minor              BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_unidentified       BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_guardian_id_type_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_guardian_id_type_check
      CHECK (guardian_id_type IS NULL OR guardian_id_type IN (
        'aadhaar', 'pan', 'voter_id', 'passport', 'driving_licence',
        'ration_card', 'abha', 'other'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_guardian_user_fk'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_guardian_user_fk
      FOREIGN KEY (guardian_user_id) REFERENCES users(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

-- Backfill: anyone with a birthday < 18 years before today gets flagged
-- as a minor. Cheap to compute once; the walk-in path keeps it in sync
-- on insert / on birthday update.
UPDATE users
   SET is_minor = TRUE
 WHERE birthday IS NOT NULL
   AND birthday > (CURRENT_DATE - INTERVAL '18 years')
   AND is_minor = FALSE;

CREATE INDEX IF NOT EXISTS idx_users_guardian_user_id
  ON users(guardian_user_id)
  WHERE guardian_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_is_minor
  ON users(is_minor)
  WHERE is_minor = TRUE;

CREATE INDEX IF NOT EXISTS idx_users_is_unidentified
  ON users(is_unidentified)
  WHERE is_unidentified = TRUE;

COMMIT;
