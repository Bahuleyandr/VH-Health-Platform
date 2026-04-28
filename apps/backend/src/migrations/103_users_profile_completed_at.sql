-- Migration 103: users.profile_completed_at
--
-- The /auth/firebase/complete-profile endpoint writes this column
-- (firebaseAuthService.completeUserProfile) but it never existed in
-- the users table. Result: every new-user signup landed on the
-- profile-setup form, submitted, then 500'd. The form's success
-- handler interpreted that as failure and the user got stuck.
--
-- Adding it as nullable so existing rows aren't required to backfill.
-- Useful for analytics ("how many users complete profile within 24h
-- of registering") and for surfacing a "complete your profile" CTA on
-- the dashboard for users with NULL here.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_completed_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_users_profile_completed_at_null
  ON users((profile_completed_at IS NULL))
  WHERE profile_completed_at IS NULL;

COMMIT;
