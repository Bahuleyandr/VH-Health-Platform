-- 303_password_reset_otp_hash_and_attempts.sql
--
-- B0.3 / SEC-1: admin password-reset OTPs must be stored hashed (bcrypt), not
-- in plaintext, and each OTP must carry a failed-attempt counter so it can be
-- locked after N wrong guesses (mirrors otp_sessions.attempts).
--
-- Two additive, idempotent changes to password_reset_otps:
--   1. Widen `otp` from VARCHAR(10) (plaintext code) to VARCHAR(72) so the
--      column can hold a 60-char bcrypt hash without truncation (matches the
--      otp_sessions widening in 298_otp_session_hash_width.sql).
--   2. Add `attempts INT NOT NULL DEFAULT 0` for the per-OTP failed-attempt
--      counter used to invalidate the OTP after too many wrong guesses.

BEGIN;

ALTER TABLE password_reset_otps
  ALTER COLUMN otp TYPE VARCHAR(72);

ALTER TABLE password_reset_otps
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

COMMIT;
