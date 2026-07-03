-- 355_patient_account_deletion.sql
--
-- Patient self-service account deletion keeps the users row as the stable
-- clinical/audit identity anchor while clearing direct identity fields.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT;

ALTER TABLE users
  ALTER COLUMN phone DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON users (deleted_at)
  WHERE is_deleted = TRUE;
