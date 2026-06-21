-- 325_totp_challenges.sql
--
-- Admin 2FA TOTP challenge store. Referenced by:
--   - authService.adminLogin            INSERT (admin_id, challenge_token, expires_at, created_at)
--   - adminAuthController MFA verify     SELECT admin_id WHERE challenge_token=$1 AND expires_at>NOW()
--   - adminAuthController MFA verify     DELETE WHERE challenge_token=$1  (single-use consume)
--
-- No migration ever actually created this table (the in-code comment citing
-- "migrations 023/026/032" is stale — none of them create it). Admin 2FA
-- challenge persistence therefore failed at runtime with 42P01; the pre-audit
-- code masked it by "falling through to normal login", and the 2026-06-18 audit
-- (§ auth) flagged that fall-through as a 2FA-bypass-by-DB-error. The W1a fix made
-- adminLogin fail CLOSED on a challenge-store failure, which surfaced the missing
-- table. This migration creates it so admin 2FA challenge persistence works and
-- the fail-closed path only triggers on a genuine outage.
--
-- Not tenant-scoped / not PHI: admins are a global identity (the `admins` table,
-- not tenant-scoped), and a challenge token is short-lived auth state — so no
-- tenant_id column / RLS policy (consistent with other admin-auth tables).

CREATE TABLE IF NOT EXISTS totp_challenges (
  id              BIGSERIAL PRIMARY KEY,
  admin_id        UUID NOT NULL,
  challenge_token VARCHAR(255) NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- challenge_token is the single-use lookup key (SELECT/DELETE by it) — unique.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_totp_challenges_token
  ON totp_challenges (challenge_token);

-- supports the expiry predicate + a cheap sweep of stale rows.
CREATE INDEX IF NOT EXISTS idx_totp_challenges_expires_at
  ON totp_challenges (expires_at);

CREATE INDEX IF NOT EXISTS idx_totp_challenges_admin_id
  ON totp_challenges (admin_id);
