-- Migration 462: NL11-S8 one-time SMART launch contexts.
-- Public /authorize consumes these server-issued launch tokens instead of
-- trusting patient or encounter identifiers from a public request.

BEGIN;

CREATE TABLE IF NOT EXISTS smart_launch_contexts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  smart_app_id INTEGER NOT NULL REFERENCES smart_apps(id) ON DELETE CASCADE,
  launch_token_hash VARCHAR(128) NOT NULL UNIQUE,
  requested_scopes TEXT[] NOT NULL DEFAULT '{}',
  patient_uid UUID,
  encounter_id INTEGER,
  user_uid UUID,
  user_role VARCHAR(80),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT smart_launch_contexts_status_chk
    CHECK (status IN ('pending', 'consumed', 'expired', 'revoked')),
  CONSTRAINT smart_launch_contexts_environment_chk
    CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT fk_smart_launch_contexts_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_smart_launch_contexts_app_status
  ON smart_launch_contexts (smart_app_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_smart_launch_contexts_tenant_pending
  ON smart_launch_contexts (tenant_id, expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_smart_launch_contexts_patient
  ON smart_launch_contexts (tenant_id, patient_uid, created_at DESC)
  WHERE patient_uid IS NOT NULL;

ALTER TABLE smart_launch_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_launch_contexts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON smart_launch_contexts;
CREATE POLICY tenant_isolation ON smart_launch_contexts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMIT;
