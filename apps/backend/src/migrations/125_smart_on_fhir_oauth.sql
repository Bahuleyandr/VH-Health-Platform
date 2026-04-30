-- Migration 125: Phase D3 — SMART-on-FHIR OAuth scopes.
--
-- HEALTHCARE_AI_SPEC_AUDIT.md §21: FHIR adapter ✅; SMART-on-FHIR
-- OAuth scopes 🔴 missing. ABDM HIP/HIU + CDS Hooks (Phases D1, D2)
-- are now in place; the remaining piece for SMART-app interoperability
-- is the OAuth surface that grants resource-scoped tokens.
--
-- Tables:
--   1. smart_apps              — registered SMART app per tenant
--                                  (client_id, redirect URIs, allowed
--                                  scopes, JWKS URL for backend
--                                  services).
--   2. smart_authz_codes       — short-lived authorization codes
--                                  issued during the auth code grant.
--                                  PKCE code_challenge captured.
--   3. smart_access_tokens     — issued access + refresh tokens with
--                                  resolved scope set, patient/encounter
--                                  context, and expiry.
--
-- All three tables are environment-aware (sandbox / production) and
-- tenant-scoped.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. smart_apps
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS smart_apps (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id                   VARCHAR(120) NOT NULL,
  display_name                VARCHAR(255) NOT NULL,
  description                 TEXT,
  app_kind                    VARCHAR(20) NOT NULL DEFAULT 'public'
    CHECK (app_kind IN ('public', 'confidential', 'backend_service')),
  redirect_uris               TEXT[] NOT NULL DEFAULT '{}',
  allowed_scopes              TEXT[] NOT NULL DEFAULT '{}',
  launch_uri                  TEXT,
  jwks_url                    TEXT,
  client_secret_ciphertext    TEXT,
  client_secret_hash          VARCHAR(128),
  fhir_version                VARCHAR(20) NOT NULL DEFAULT 'R4',
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'revoked', 'archived')),
  environment                 VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, client_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_smart_apps_tenant_status
  ON smart_apps (tenant_id, status, environment);
CREATE INDEX IF NOT EXISTS idx_smart_apps_kind
  ON smart_apps (tenant_id, app_kind);

-- ---------------------------------------------------------------------------
-- 2. smart_authz_codes (short-lived; PKCE-aware)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS smart_authz_codes (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  smart_app_id                INTEGER NOT NULL REFERENCES smart_apps(id) ON DELETE CASCADE,
  code_hash                   VARCHAR(128) NOT NULL,
  redirect_uri                TEXT NOT NULL,
  requested_scopes            TEXT[] NOT NULL DEFAULT '{}',
  granted_scopes              TEXT[] NOT NULL DEFAULT '{}',
  patient_uid                 UUID,
  encounter_id                INTEGER,
  user_uid                    UUID,
  user_role                   VARCHAR(80),
  pkce_code_challenge         VARCHAR(255),
  pkce_method                 VARCHAR(20)
    CHECK (pkce_method IS NULL OR pkce_method IN ('S256', 'plain')),
  state                       VARCHAR(255),
  status                      VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired', 'revoked')),
  expires_at                  TIMESTAMPTZ NOT NULL,
  consumed_at                 TIMESTAMPTZ,
  environment                 VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (code_hash)
);

CREATE INDEX IF NOT EXISTS idx_smart_authz_app_status
  ON smart_authz_codes (smart_app_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_smart_authz_tenant_pending
  ON smart_authz_codes (tenant_id, expires_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- 3. smart_access_tokens (issued tokens; refresh flow tracked)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS smart_access_tokens (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  smart_app_id                INTEGER NOT NULL REFERENCES smart_apps(id) ON DELETE CASCADE,
  authz_code_id               INTEGER REFERENCES smart_authz_codes(id) ON DELETE SET NULL,
  access_token_hash           VARCHAR(128) NOT NULL,
  refresh_token_hash          VARCHAR(128),
  granted_scopes              TEXT[] NOT NULL DEFAULT '{}',
  patient_uid                 UUID,
  encounter_id                INTEGER,
  user_uid                    UUID,
  user_role                   VARCHAR(80),
  parent_token_id             INTEGER REFERENCES smart_access_tokens(id) ON DELETE SET NULL,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired', 'rotated')),
  issued_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_expires_at           TIMESTAMPTZ NOT NULL,
  refresh_expires_at          TIMESTAMPTZ,
  revoked_at                  TIMESTAMPTZ,
  revoked_reason              TEXT,
  last_used_at                TIMESTAMPTZ,
  last_used_ip                VARCHAR(64),
  environment                 VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (access_token_hash)
);

CREATE INDEX IF NOT EXISTS idx_smart_tokens_app_status
  ON smart_access_tokens (smart_app_id, status, access_expires_at);
CREATE INDEX IF NOT EXISTS idx_smart_tokens_tenant_active
  ON smart_access_tokens (tenant_id, status, access_expires_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_smart_tokens_refresh
  ON smart_access_tokens (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

COMMIT;
