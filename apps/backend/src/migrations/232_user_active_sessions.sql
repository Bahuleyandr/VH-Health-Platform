-- Migration 232: user_active_sessions
--
-- Tracks the single currently-active access token per user across all auth
-- realms (staff, admin, patient). On every new login the login service calls
-- `claimUserSession`, which:
--   1. SELECTs the existing row for this user_uid (if any).
--   2. Blacklists the previous `jti` via tokenBlacklist.blacklistToken so
--      the old device's next API call returns 401.
--   3. Emits a `session:revoked` event via wsServer.sendToUser to the same
--      user_uid so the old device routes to /login immediately, not on the
--      next API call.
--   4. UPSERTs the new row.
--
-- This is distinct from `staff_auth_sessions` (refresh-token rotation per
-- staff device, multi-row by design). `user_active_sessions` is one-row-
-- per-user and gates access tokens uniformly across all three apps.

CREATE TABLE IF NOT EXISTS user_active_sessions (
  user_uid     UUID         PRIMARY KEY,
  jti          TEXT         NOT NULL,
  device_type  TEXT         NOT NULL,
  device_label TEXT,
  ip_address   TEXT,
  user_agent   TEXT,
  issued_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ  NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- jti lookups happen rarely (the row is keyed by user_uid for normal reads),
-- but an admin "find session by jti" tool path benefits from an index.
CREATE INDEX IF NOT EXISTS idx_user_active_sessions_jti
  ON user_active_sessions(jti);
