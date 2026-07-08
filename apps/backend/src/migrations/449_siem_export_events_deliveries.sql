-- 449_siem_export_events_deliveries.sql
--
-- NL12-S2: normalized SIEM events and delivery-attempt evidence.
-- The payload snapshot is intentionally minimized and redacted; patient names,
-- phone numbers, notes, diagnoses, and raw clinical payloads do not belong here.

BEGIN;

CREATE TABLE IF NOT EXISTS siem_export_events (
  id                       BIGSERIAL PRIMARY KEY,
  uid                      UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  source_name              VARCHAR(80) NOT NULL,
  source_id                TEXT NOT NULL,
  source_created_at        TIMESTAMPTZ(6),
  event_type               VARCHAR(120) NOT NULL,
  severity                 VARCHAR(20) NOT NULL,
  category                 VARCHAR(80) NOT NULL DEFAULT 'security',
  actor_hash               CHAR(64),
  subject_hash             CHAR(64),
  ip_hash                  CHAR(64),
  request_id               VARCHAR(100),
  resource_type            VARCHAR(100),
  resource_hash            CHAR(64),
  redaction_policy_version VARCHAR(80) NOT NULL DEFAULT 'nl12-s2-phi-min-v1',
  minimized_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_sha256           CHAR(64) NOT NULL,
  export_status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  synthetic                BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_siem_export_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT uq_siem_export_events_uid UNIQUE (uid),
  CONSTRAINT uq_siem_export_events_source UNIQUE (tenant_id, source_name, source_id),
  CONSTRAINT siem_export_events_source_check
    CHECK (source_name IN ('audit_log', 'identity_audit_events', 'clinical_audit_events', 'synthetic')),
  CONSTRAINT siem_export_events_severity_check
    CHECK (severity IN ('high', 'critical')),
  CONSTRAINT siem_export_events_status_check
    CHECK (export_status IN ('pending', 'enqueued', 'succeeded', 'failed', 'dead')),
  CONSTRAINT siem_export_events_payload_object_check
    CHECK (jsonb_typeof(minimized_payload) = 'object'),
  CONSTRAINT siem_export_events_no_raw_payload_check
    CHECK (COALESCE((minimized_payload #>> '{redaction,raw_payload_exported}')::boolean, false) = false)
);

CREATE INDEX IF NOT EXISTS idx_siem_export_events_tenant_status
  ON siem_export_events (tenant_id, export_status, created_at);

CREATE INDEX IF NOT EXISTS idx_siem_export_events_source
  ON siem_export_events (tenant_id, source_name, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_siem_export_events_severity
  ON siem_export_events (tenant_id, severity, created_at DESC);

ALTER TABLE siem_export_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE siem_export_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON siem_export_events;
CREATE POLICY tenant_isolation ON siem_export_events
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

CREATE TABLE IF NOT EXISTS siem_export_delivery_attempts (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  event_id           BIGINT NOT NULL REFERENCES siem_export_events(id) ON DELETE CASCADE,
  target_id          BIGINT NOT NULL REFERENCES siem_export_targets(id) ON DELETE CASCADE,
  transport          VARCHAR(40) NOT NULL,
  attempt_number     INTEGER NOT NULL DEFAULT 1,
  status             VARCHAR(20) NOT NULL DEFAULT 'pending',
  payload_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_sha256     CHAR(64) NOT NULL,
  http_status        INTEGER,
  response_excerpt   TEXT,
  error_message      TEXT,
  evidence_uri       TEXT,
  request_id         VARCHAR(100),
  next_retry_at      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ(6),
  completed_at       TIMESTAMPTZ(6),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_siem_export_delivery_attempts_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT siem_export_delivery_attempts_transport_check
    CHECK (transport IN ('webhook', 'syslog', 'object_drop')),
  CONSTRAINT siem_export_delivery_attempts_status_check
    CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed', 'dead')),
  CONSTRAINT siem_export_delivery_attempts_attempt_check
    CHECK (attempt_number >= 1),
  CONSTRAINT siem_export_delivery_attempts_payload_object_check
    CHECK (jsonb_typeof(payload_snapshot) = 'object'),
  CONSTRAINT siem_export_delivery_attempts_no_raw_payload_check
    CHECK (COALESCE((payload_snapshot #>> '{redaction,raw_payload_exported}')::boolean, false) = false),
  CONSTRAINT uq_siem_export_delivery_attempt
    UNIQUE (event_id, target_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_siem_delivery_attempts_tenant_status
  ON siem_export_delivery_attempts (tenant_id, status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_siem_delivery_attempts_event
  ON siem_export_delivery_attempts (event_id, attempt_number);

CREATE INDEX IF NOT EXISTS idx_siem_delivery_attempts_target
  ON siem_export_delivery_attempts (target_id, created_at DESC);

ALTER TABLE siem_export_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE siem_export_delivery_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON siem_export_delivery_attempts;
CREATE POLICY tenant_isolation ON siem_export_delivery_attempts
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
  'NL12-S2 SIEM export event and delivery evidence; contains minimized security metadata only.',
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
    ('INDIA_SIEM_EVENTS_RETENTION', 'siem_export_events', 'SIEM normalized event retention', '{"control":"SIEM_ALERTS_ONCALL"}'::jsonb),
    ('INDIA_SIEM_DELIVERY_ATTEMPTS_RETENTION', 'siem_export_delivery_attempts', 'SIEM delivery-attempt evidence retention', '{"control":"SIEM_ALERTS_ONCALL"}'::jsonb)
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
         'siem_export_event_table', 'siem_export_events',
         'siem_export_delivery_table', 'siem_export_delivery_attempts',
         'synthetic_drill_required', true,
         'phi_minimization', 'raw clinical payloads are not exported by default'
       ),
       updated_at = NOW()
 WHERE control_code = 'SIEM_ALERTS_ONCALL';

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NL12_S2_SIEM_EVENTS_CREATED',
  'siem_export_events',
  '449',
  jsonb_build_object(
    'migration', '449_siem_export_events_deliveries.sql',
    'event_table', 'siem_export_events',
    'delivery_table', 'siem_export_delivery_attempts',
    'redaction_policy_version', 'nl12-s2-phi-min-v1'
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
   WHERE action = 'NL12_S2_SIEM_EVENTS_CREATED'
     AND resource = 'siem_export_events'
     AND resource_id = '449'
);

COMMIT;
