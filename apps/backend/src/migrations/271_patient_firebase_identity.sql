-- Migration 271: patient Firebase OTP identity columns
--
-- The patient app signs in with Firebase phone OTP and then calls
-- /auth/firebase/firebase-login. That backend service links the Firebase UID
-- to users and tracks token revocation metadata, but older live databases did
-- not have those users columns. Keep this idempotent for Dalekdefender and CI.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128),
  ADD COLUMN IF NOT EXISTS firebase_tokens_revoked_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_firebase_uid
  ON users(firebase_uid)
  WHERE firebase_uid IS NOT NULL;

COMMIT;
