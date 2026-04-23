-- 076_admin_totp_columns.sql
-- Ports the TOTP/2FA columns previously tracked only in the legacy
-- `migrations/` directory (032_admin_totp_columns.sql) into the canonical
-- `src/migrations/` tree that the test DB setup applies. Prod already has
-- these columns; idempotent IF NOT EXISTS keeps the migration safe to run
-- against prod databases too.
--
-- * totp_secret_encrypted — AES-256-GCM ciphertext of the shared TOTP secret
--   (see src/utils/totpUtils.js encryptSecret/decryptSecret). Hex-encoded as
--   "iv:tag:ciphertext".
-- * totp_backup_codes    — JSON array of bcrypt-hashed single-use recovery
--   codes. Redeemed codes are nulled out of the array.
-- * totp_enrolled_at     — audit timestamp for the most recent enrollment.

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS totp_backup_codes     JSONB,
  ADD COLUMN IF NOT EXISTS totp_enrolled_at      TIMESTAMPTZ;
