-- 341_totp_challenge_attempts.sql
--
-- Audit 2026-06-22 M3: the login 2FA challenge (totp_challenges) had no
-- per-challenge attempt counter, and mfaVerifyChallenge did NOT consume the
-- challenge on a failed verify — only on success. So a single challenge token
-- could be retried with an unlimited number of codes within its expiry window,
-- making the 6-digit TOTP brute-forceable. Add an attempts column so each verify
-- can atomically reserve an attempt (UPDATE ... WHERE attempts < cap) and the
-- challenge is burned once the cap is hit.
ALTER TABLE totp_challenges
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
