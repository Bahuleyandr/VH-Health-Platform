-- Migration 115: Phase A3 — webhook + integration registry foundation.
--
-- The structural audit (HEALTHCARE_AI_SPEC_AUDIT.md §27) flagged the
-- complete lack of a first-class integration registry as the next gap
-- after multi-identifier patient. Hospitals expect to subscribe to
-- internal events (patient admitted, lab result finalised, claim
-- denied) and receive signed webhooks at their own systems —
-- currently every integration is bespoke per-vendor.
--
-- This migration creates the foundation tables. The CRUD service +
-- signing helper land in this PR's service layer; the delivery
-- dispatcher (cron + retry-with-backoff + dead-lettering) lands in
-- PR2. Admin UI follows.
--
-- Tables:
--   1. integrations             — top-level "VH Health → Vendor" record
--                                   keyed by tenant + name. Status
--                                   gates whether deliveries are sent.
--   2. integration_credentials  — per-integration secrets, stored as
--                                   ciphertext + KMS key_id placeholder
--                                   so the schema is right today even
--                                   though the prod encryption layer
--                                   lands as a separate task.
--   3. webhook_subscriptions    — what event types the integration
--                                   wants delivered to which URL,
--                                   with consecutive-failure tracking
--                                   so a wedged endpoint auto-pauses.
--   4. webhook_deliveries       — every delivery attempt with status,
--                                   HTTP code, response excerpt, and
--                                   next_retry_at for the dispatcher.
--   5. external_system_mappings — internal-resource-id → external-id
--                                   bidirectional mapping (FHIR
--                                   patient.id, EHR encounter.id, etc).
--   6. integration_logs         — append-only event log per integration
--                                   for ops + audit.
--
-- Decision-support only: nothing here auto-emits events. The dispatcher
-- (PR2) reads from event_outbox, looks up matching subscriptions, and
-- enqueues deliveries. Admins inspect / pause / replay through the
-- admin routes — production traffic is never directly exposed.

BEGIN;

CREATE TABLE IF NOT EXISTS integrations (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                VARCHAR(160) NOT NULL,
  description         TEXT,
  integration_type    VARCHAR(80) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'failed', 'archived')),
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          UUID,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_integrations_tenant_status
  ON integrations (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrations_tenant_type
  ON integrations (tenant_id, integration_type);

CREATE TABLE IF NOT EXISTS integration_credentials (
  id                  SERIAL PRIMARY KEY,
  integration_id      INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credential_key      VARCHAR(80) NOT NULL,
  ciphertext          TEXT,
  ciphertext_hash     VARCHAR(64),
  kms_key_id          VARCHAR(160),
  expires_at          TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          UUID,
  rotated_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (integration_id, credential_key)
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_tenant
  ON integration_credentials (tenant_id, integration_id);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                          SERIAL PRIMARY KEY,
  integration_id              INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type                  VARCHAR(120) NOT NULL,
  event_filter                JSONB NOT NULL DEFAULT '{}'::jsonb,
  endpoint_url                TEXT NOT NULL,
  signing_credential_id       INTEGER REFERENCES integration_credentials(id) ON DELETE SET NULL,
  signing_algorithm           VARCHAR(40) NOT NULL DEFAULT 'hmac-sha256'
    CHECK (signing_algorithm IN ('hmac-sha256', 'hmac-sha512', 'none')),
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  last_delivered_at           TIMESTAMPTZ,
  last_failure_at             TIMESTAMPTZ,
  consecutive_failures        INTEGER NOT NULL DEFAULT 0,
  max_consecutive_failures    INTEGER NOT NULL DEFAULT 10,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (integration_id, event_type, endpoint_url)
);

CREATE INDEX IF NOT EXISTS idx_webhook_subs_tenant_event
  ON webhook_subscriptions (tenant_id, event_type, is_active)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhook_subs_integration
  ON webhook_subscriptions (integration_id, is_active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                      SERIAL PRIMARY KEY,
  subscription_id         INTEGER REFERENCES webhook_subscriptions(id) ON DELETE SET NULL,
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_outbox_id         INTEGER,
  event_type              VARCHAR(120) NOT NULL,
  payload                 JSONB NOT NULL,
  attempt_number          INTEGER NOT NULL DEFAULT 0,
  status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed', 'dead')),
  http_status             INTEGER,
  response_excerpt        TEXT,
  error_message           TEXT,
  signature               VARCHAR(255),
  request_id              VARCHAR(64),
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  next_retry_at           TIMESTAMPTZ,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant_status
  ON webhook_deliveries (tenant_id, status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription_time
  ON webhook_deliveries (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event_outbox
  ON webhook_deliveries (event_outbox_id) WHERE event_outbox_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS external_system_mappings (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id              INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  internal_resource_type      VARCHAR(60) NOT NULL,
  internal_id                 VARCHAR(120) NOT NULL,
  external_system_id          VARCHAR(255) NOT NULL,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stale', 'archived')),
  last_synced_at              TIMESTAMPTZ,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, integration_id, internal_resource_type, internal_id)
);

CREATE INDEX IF NOT EXISTS idx_external_mappings_external
  ON external_system_mappings (tenant_id, integration_id, external_system_id);
CREATE INDEX IF NOT EXISTS idx_external_mappings_internal
  ON external_system_mappings (tenant_id, internal_resource_type, internal_id);

CREATE TABLE IF NOT EXISTS integration_logs (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id      INTEGER REFERENCES integrations(id) ON DELETE SET NULL,
  log_type            VARCHAR(40) NOT NULL
    CHECK (log_type IN (
      'config_change', 'auth_refresh', 'webhook_send', 'webhook_receive',
      'mapping_sync', 'health_check', 'error'
    )),
  severity            VARCHAR(20) NOT NULL DEFAULT 'info'
    CHECK (severity IN ('debug', 'info', 'warn', 'error')),
  message             TEXT,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_logs_tenant_time
  ON integration_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_logs_integration_time
  ON integration_logs (integration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_logs_severity_time
  ON integration_logs (severity, created_at DESC) WHERE severity IN ('warn', 'error');

COMMIT;
