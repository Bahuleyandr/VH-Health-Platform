-- Migration 428: NL-11 S2 developer portal audit trail.
--
-- Append-only tenant-scoped audit for API-client/key lifecycle operations and
-- portal documentation access. This is an integration/admin trail, not a
-- patient clinical timeline event.

BEGIN;

CREATE TABLE IF NOT EXISTS developer_portal_audit_events (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT COALESCE(
                   NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
                   '00000000-0000-4000-8000-000000000001'::uuid
                 ) REFERENCES tenants(id) ON DELETE CASCADE,
  api_client_id  INTEGER REFERENCES api_clients(id) ON DELETE SET NULL,
  api_key_id     INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  event_type     VARCHAR(60) NOT NULL,
  outcome        VARCHAR(20) NOT NULL DEFAULT 'success'
                   CHECK (outcome IN ('success', 'failure', 'skipped')),
  actor_uid      UUID,
  actor_role     VARCHAR(80),
  ip_address     VARCHAR(64),
  user_agent     VARCHAR(255),
  summary        TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT developer_portal_audit_events_type_chk
    CHECK (event_type IN (
      'client.created',
      'client.updated',
      'client.status_changed',
      'key.issued',
      'key.rotated',
      'key.revoked',
      'openapi.downloaded',
      'guide.viewed',
      'scope_dictionary.viewed'
    ))
);

CREATE INDEX IF NOT EXISTS idx_developer_portal_audit_tenant_time
  ON developer_portal_audit_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_developer_portal_audit_client_time
  ON developer_portal_audit_events (tenant_id, api_client_id, created_at DESC)
  WHERE api_client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_developer_portal_audit_type_time
  ON developer_portal_audit_events (tenant_id, event_type, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_developer_portal_audit_events_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'developer_portal_audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_developer_portal_audit_events_no_update
  ON developer_portal_audit_events;
CREATE TRIGGER trg_developer_portal_audit_events_no_update
  BEFORE UPDATE ON developer_portal_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_developer_portal_audit_events_mutation();

DROP TRIGGER IF EXISTS trg_developer_portal_audit_events_no_delete
  ON developer_portal_audit_events;
CREATE TRIGGER trg_developer_portal_audit_events_no_delete
  BEFORE DELETE ON developer_portal_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_developer_portal_audit_events_mutation();

ALTER TABLE developer_portal_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_portal_audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON developer_portal_audit_events;
CREATE POLICY tenant_isolation ON developer_portal_audit_events
  USING (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    )
  );

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
VALUES (
  'nl11_s2_developer_portal_audit_events',
  'database_migration',
  '428',
  jsonb_build_object(
    'scope', 'Developer portal API-client lifecycle audit trail',
    'tables', ARRAY['developer_portal_audit_events'],
    'append_only', true
  ),
  NOW()
) ON CONFLICT DO NOTHING;

COMMIT;
