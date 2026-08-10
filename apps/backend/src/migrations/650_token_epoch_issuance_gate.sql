-- 650: per-identity token-generation epoch — issuance-time revocation gate (R1).
--
-- Problem: logout / revoke-all / SCIM deprovision wrote only (a) per-jti
-- blacklist rows and (b) a `user:<uid>` revoke-all watermark that jwtMiddleware
-- compares against a token's iat at VERIFY time. Nothing consulted revocation
-- state at ISSUANCE time, so a refresh token retained across logout could be
-- rotated into a brand-new access+refresh pair whose iat=NOW post-dates the
-- watermark — laundering the revocation. A retained Firebase session had the
-- same laundering property: re-login minted fresh tokens with no check that the
-- Firebase authentication (auth_time) predated the revoke-all.
--
-- Fix: a monotonically increasing per-identity `token_epoch`, bumped by every
-- revoke-all (logout, force-revoke, SCIM deprovision — see
-- utils/tokenBlacklist.revokeAllUserTokens). Refresh tokens are stamped with
-- the epoch under which they were minted (`token_epoch` claim); the refresh
-- endpoints refuse any refresh token whose stamped epoch is older than the
-- identity's current epoch. `token_epoch_bumped_at` records WHEN the last bump
-- happened so the Firebase login path can refuse ID tokens whose `auth_time`
-- predates the bump (retained-Firebase-session laundering).
--
-- Both identity realms get the columns: patients/staff live in `users`,
-- admins in `admins` (separate realm — see loginSessionHelper).
--
-- Default 0 = "never revoked". Legacy refresh tokens carry no epoch claim and
-- are treated as epoch 0, so nothing changes for identities that have never
-- had a revoke-all; the first bump (epoch 1) retires every pre-bump credential.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_epoch_bumped_at TIMESTAMPTZ;

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS token_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS token_epoch_bumped_at TIMESTAMPTZ;

-- The epoch can only move forward — a decrement would resurrect revoked
-- credentials. Cheap CHECK-level backstop for the non-negative floor.
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_token_epoch_nonnegative;
ALTER TABLE users
  ADD CONSTRAINT chk_users_token_epoch_nonnegative CHECK (token_epoch >= 0);
ALTER TABLE admins DROP CONSTRAINT IF EXISTS chk_admins_token_epoch_nonnegative;
ALTER TABLE admins
  ADD CONSTRAINT chk_admins_token_epoch_nonnegative CHECK (token_epoch >= 0);
