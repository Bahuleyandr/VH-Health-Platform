-- 032_admin_totp_columns.sql
-- Adds the remaining TOTP/2FA columns to the `admins` table. `totp_enabled`
-- already exists (migration 026). These columns complete the MFA enrollment
-- flow consumed by the admin portal.
--
-- * totp_secret_encrypted — AES-256-GCM ciphertext of the shared TOTP secret
--   (see src/utils/totpUtils.js encryptSecret/decryptSecret). Hex-encoded as
--   "iv:tag:ciphertext".
-- * totp_backup_codes    — JSON array of bcrypt-hashed single-use recovery
--   codes. When an admin redeems a code we null it out of the array.
-- * totp_enrolled_at     — audit timestamp for the most recent enrollment.

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS totp_backup_codes     JSONB,
  ADD COLUMN IF NOT EXISTS totp_enrolled_at      TIMESTAMPTZ;
