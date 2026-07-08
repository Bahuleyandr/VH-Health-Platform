-- 448_siem_export_targets.sql
--
-- NL12-S2: SIEM export target registry and source cursors.
-- The operator still chooses the real SIEM/SOC target; this schema records the
-- transport contract and cursor state without exporting raw clinical payloads.

BEGIN;

CREATE TABLE IF NOT EXISTS siem_export_targets (
  id                       BIGSERIAL PRIMARY KEY,
  uid                      UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  target_key               VARCHAR(80) NOT NULL,
  display_name             VARCHAR(160) NOT NULL,
  transport                VARCHAR(40) NOT NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'draft',
  min_severity             VARCHAR(20) NOT NULL DEFAULT 'high',
  endpoint_url             TEXT,
  syslog_host              TEXT,
  syslog_port              INTEGER,
  object_drop_uri          TEXT,
  redaction_policy_version VARCHAR(80) NOT NULL DEFAULT 'nl12-s2-phi-min-v1',
  config                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by               UUID,
  updated_by               UUID,
  last_drill_at            TIMESTAMPTZ(6),
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_siem_export_targets_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT uq_siem_export_targets_uid UNIQUE (uid),
  CONSTRAINT uq_siem_export_targets_key UNIQUE (tenant_id, target_key),
  CONSTRAINT siem_export_targets_transport_check
    CHECK (transport IN ('webhook', 'syslog', 'object_drop')),
  CONSTRAINT siem_export_targets_status_check
    CHECK (status IN ('draft', 'active', 'paused', 'retired')),
  CONSTRAINT siem_export_targets_min_severity_check
    CHECK (min_severity IN ('high', 'critical')),
  CONSTRAINT siem_export_targets_syslog_port_check
    CHECK (syslog_port IS NULL OR (syslog_port >= 1 AND syslog_port <= 65535)),
  CONSTRAINT siem_export_targets_active_config_check
    CHECK (
      status <> 'active'
      OR (
        (transport = 'webhook' AND NULLIF(BTRIM(COALESCE(endpoint_url, '')), '') IS NOT NULL)
        OR (transport = 'syslog' AND NULLIF(BTRIM(COALESCE(syslog_host, '')), '') IS NOT NULL)
        OR (transport = 'object_drop' AND NULLIF(BTRIM(COALESCE(object_drop_uri, '')), '') IS NOT NULL)
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_siem_export_targets_tenant_status
  ON siem_export_targets (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_siem_export_targets_transport
  ON siem_export_targets (tenant_id, transport, status);

ALTER TABLE siem_export_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE siem_export_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON siem_export_targets;
CREATE POLICY tenant_isolation ON siem_export_targets
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

CREATE TABLE IF NOT EXISTS siem_export_cursors (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  source_name         VARCHAR(80) NOT NULL,
  cursor_key          VARCHAR(160) NOT NULL DEFAULT 'global',
  last_source_id      BIGINT,
  last_source_ref     TEXT,
  last_source_at      TIMESTAMPTZ(6),
  last_exported_at    TIMESTAMPTZ(6),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_siem_export_cursors_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT uq_siem_export_cursors_source UNIQUE (tenant_id, source_name, cursor_key)
);

CREATE INDEX IF NOT EXISTS idx_siem_export_cursors_source
  ON siem_export_cursors (tenant_id, source_name, updated_at DESC);

ALTER TABLE siem_export_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE siem_export_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON siem_export_cursors;
CREATE POLICY tenant_isolation ON siem_export_cursors
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

INSERT INTO data_retention_policies (
  tenant_id, policy_code, applies_to_table, display_name, description,
  retention_days, action, basis, legal_hold_aware,
  data_processing_activity_id, status, metadata, created_at, updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  rows.policy_code,
  rows.applies_to_table,
  rows.display_name,
  'NL12-S2 SIEM export seam metadata; hospital security owner may approve longer retention.',
  365,
  'archive',
  'CERT-In and ISO/SOC 2 security-monitoring evidence; raw clinical payloads are not exported by default.',
  true,
  dpa.id,
  'active',
  rows.metadata || '{"baseline":"nl12_s2_siem_export","minimum_days":180}'::jsonb,
  NOW(),
  NOW()
FROM (
  VALUES
    ('INDIA_SIEM_TARGETS_RETENTION', 'siem_export_targets', 'SIEM export target registry retention', '{"control":"SIEM_ALERTS_ONCALL"}'::jsonb),
    ('INDIA_SIEM_CURSORS_RETENTION', 'siem_export_cursors', 'SIEM export cursor retention', '{"control":"SIEM_ALERTS_ONCALL"}'::jsonb)
) AS rows(policy_code, applies_to_table, display_name, metadata)
LEFT JOIN data_processing_activities dpa
  ON dpa.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 AND dpa.activity_code = 'INDIA_AUDIT_SECURITY'
ON CONFLICT (tenant_id, applies_to_table) DO UPDATE SET
  metadata = data_retention_policies.metadata || EXCLUDED.metadata,
  updated_at = NOW();

UPDATE india_compliance_evidence
   SET status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END,
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'siem_export_target_contract', 'webhook/syslog/object_drop',
         'siem_export_cursor_table', 'siem_export_cursors',
         'redaction_policy_version', 'nl12-s2-phi-min-v1',
         'operator_target_required', true
       ),
       updated_at = NOW()
 WHERE control_code = 'SIEM_ALERTS_ONCALL';

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NL12_S2_SIEM_TARGETS_CREATED',
  'siem_export_targets',
  '448',
  jsonb_build_object(
    'migration', '448_siem_export_targets.sql',
    'transports', jsonb_build_array('webhook', 'syslog', 'object_drop'),
    'phi_minimization', 'raw clinical payloads are not exported by default'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1
    FROM audit_logs
   WHERE action = 'NL12_S2_SIEM_TARGETS_CREATED'
     AND resource = 'siem_export_targets'
     AND resource_id = '448'
);

COMMIT;
