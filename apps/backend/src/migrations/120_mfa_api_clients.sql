-- Migration 120: Phase B4 — TOTP MFA + DB-backed API client registry.
--
-- Closes top-10 gap #9 from HEALTHCARE_AI_SPEC_AUDIT.md §3 + §1.
-- - Today: SMS/email OTP exists; no TOTP (RFC 6238) for admin / clinician
--   workstations. apps/admin has totpRoutes.js but no schema behind it.
-- - Today: env-var API keys (API_KEY_PATIENT/STAFF/ADMIN) only; no
--   per-tenant DB-backed registry, no rotation, no scopes, no audit.
--
-- Tables:
--   1. mfa_devices            — TOTP devices (RFC 6238) per user. The
--                                shared secret is stored as ciphertext;
--                                a parallel ciphertext_hash lets us
--                                detect duplicate enrollments without
--                                round-tripping the plaintext.
--   2. mfa_backup_codes       — single-use recovery codes (hashed +
--                                salted). Generated once at enrollment.
--   3. mfa_challenges         — short-lived TOTP/backup-code challenge
--                                rows for replay prevention (window +
--                                step number tracking).
--   4. api_clients            — first-class machine consumer record
--                                per tenant with allowed scopes +
--                                allowed IPs + status state machine.
--   5. api_keys               — per-client API keys; key_hash only,
--                                never plaintext. Last-used + revoke
--                                lifecycle.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. mfa_devices
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mfa_devices (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_uid                    UUID NOT NULL,
  device_kind                 VARCHAR(20) NOT NULL DEFAULT 'totp'
    CHECK (device_kind IN ('totp', 'webauthn', 'sms', 'email')),
  display_name                VARCHAR(160),
  secret_ciphertext           TEXT,
  secret_ciphertext_hash      VARCHAR(64),
  algorithm                   VARCHAR(16) NOT NULL DEFAULT 'sha1'
    CHECK (algorithm IN ('sha1', 'sha256', 'sha512')),
  digits                      INTEGER NOT NULL DEFAULT 6 CHECK (digits IN (6, 8)),
  period_seconds              INTEGER NOT NULL DEFAULT 30 CHECK (period_seconds IN (30, 60)),
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'revoked')),
  verified_at                 TIMESTAMPTZ,
  revoked_at                  TIMESTAMPTZ,
  last_used_at                TIMESTAMPTZ,
  last_step                   BIGINT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mfa_devices_user
  ON mfa_devices (tenant_id, user_uid, status);
CREATE INDEX IF NOT EXISTS idx_mfa_devices_hash
  ON mfa_devices (tenant_id, secret_ciphertext_hash)
  WHERE secret_ciphertext_hash IS NOT NULL AND status = 'verified';

-- Only one verified TOTP device per user is allowed by default. Other
-- device_kinds (webauthn, etc.) can have multiple verified rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfa_user_verified_totp
  ON mfa_devices (tenant_id, user_uid)
  WHERE device_kind = 'totp' AND status = 'verified';

-- ---------------------------------------------------------------------------
-- 2. mfa_backup_codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mfa_device_id               INTEGER NOT NULL REFERENCES mfa_devices(id) ON DELETE CASCADE,
  user_uid                    UUID NOT NULL,
  code_hash                   VARCHAR(128) NOT NULL,
  code_salt                   VARCHAR(64) NOT NULL,
  used_at                     TIMESTAMPTZ,
  used_from_ip                VARCHAR(64),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_device
  ON mfa_backup_codes (mfa_device_id, used_at);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user
  ON mfa_backup_codes (tenant_id, user_uid, used_at)
  WHERE used_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. mfa_challenges (replay-prevention + step tracking)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_uid                    UUID NOT NULL,
  mfa_device_id               INTEGER REFERENCES mfa_devices(id) ON DELETE CASCADE,
  challenge_kind              VARCHAR(20) NOT NULL DEFAULT 'totp'
    CHECK (challenge_kind IN ('totp', 'backup_code', 'webauthn')),
  step                        BIGINT,
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'success', 'failure', 'expired')),
  attempts                    INTEGER NOT NULL DEFAULT 0,
  ip_address                  VARCHAR(64),
  user_agent                  VARCHAR(255),
  expires_at                  TIMESTAMPTZ NOT NULL,
  resolved_at                 TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user_status
  ON mfa_challenges (tenant_id, user_uid, status, expires_at);
-- Replay-prevention: the (device_id, step) tuple should be unique among
-- successful TOTP challenges. Backup codes have step=NULL; constraint
-- only fires when step is set + status='success'.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfa_challenges_step_unique
  ON mfa_challenges (mfa_device_id, step)
  WHERE step IS NOT NULL AND status = 'success';

-- ---------------------------------------------------------------------------
-- 4. api_clients
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_clients (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_code                 VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  description                 TEXT,
  client_kind                 VARCHAR(40) NOT NULL DEFAULT 'integration'
    CHECK (client_kind IN ('integration', 'webhook', 'mobile_app', 'partner', 'internal_service', 'other')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'revoked', 'archived')),
  scopes                      TEXT[] NOT NULL DEFAULT '{}',
  allowed_ips                 TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_profile          VARCHAR(40),
  contact_email               VARCHAR(255),
  contact_phone               VARCHAR(40),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, client_code)
);

CREATE INDEX IF NOT EXISTS idx_api_clients_tenant_status
  ON api_clients (tenant_id, status, display_name);
CREATE INDEX IF NOT EXISTS idx_api_clients_kind
  ON api_clients (tenant_id, client_kind, status);

-- ---------------------------------------------------------------------------
-- 5. api_keys
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_keys (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_client_id               INTEGER NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  key_hash                    VARCHAR(128) NOT NULL,
  key_prefix                  VARCHAR(16) NOT NULL,
  display_name                VARCHAR(255),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at                  TIMESTAMPTZ,
  last_used_at                TIMESTAMPTZ,
  last_used_ip                VARCHAR(64),
  revoked_at                  TIMESTAMPTZ,
  revoked_reason              TEXT,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (key_hash)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_client_status
  ON api_keys (api_client_id, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_status
  ON api_keys (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix
  ON api_keys (tenant_id, key_prefix);

COMMIT;
