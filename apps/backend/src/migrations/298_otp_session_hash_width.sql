-- 298_otp_session_hash_width.sql
--
-- OTP sessions store bcrypt hashes, not plaintext OTP codes. Bcrypt hashes are
-- 60 characters today; keep the column comfortably sized so the database
-- enforces hashed-at-rest storage without truncation/runtime failures.

BEGIN;

ALTER TABLE otp_sessions
  ALTER COLUMN otp TYPE VARCHAR(72);

COMMIT;
