-- NL-13 P3: oncology registry export evidence trail.
-- Registry exports are audit/register records only, not patient timeline events.

BEGIN;

CREATE TABLE IF NOT EXISTS oncology_registry_exports (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  registry_name              VARCHAR(160) NOT NULL,
  export_period_start        DATE NOT NULL,
  export_period_end          DATE NOT NULL,
  export_status              VARCHAR(24) NOT NULL DEFAULT 'draft',
  evidence_refs              JSONB NOT NULL DEFAULT '[]'::jsonb,
  filter_snapshot            JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count                  INTEGER NOT NULL DEFAULT 0,
  reviewed_by                UUID,
  reviewed_at                TIMESTAMPTZ(6),
  review_note                TEXT,
  clinical_audit_event_id    UUID,
  created_by                 UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_oncology_registry_exports_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_oncology_registry_exports_audit
    FOREIGN KEY (clinical_audit_event_id) REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_oncology_registry_exports_status
    CHECK (export_status IN ('draft', 'reviewed', 'released', 'cancelled')),
  CONSTRAINT chk_oncology_registry_exports_period
    CHECK (export_period_end >= export_period_start),
  CONSTRAINT chk_oncology_registry_exports_evidence_array
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT chk_oncology_registry_exports_filter_object
    CHECK (jsonb_typeof(filter_snapshot) = 'object'),
  CONSTRAINT chk_oncology_registry_exports_row_count
    CHECK (row_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_oncology_registry_exports_period
  ON oncology_registry_exports (tenant_id, registry_name, export_period_start DESC, export_period_end DESC);

ALTER TABLE oncology_registry_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE oncology_registry_exports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oncology_registry_exports;
CREATE POLICY tenant_isolation ON oncology_registry_exports
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'ONCOLOGY_REGISTRY_EXPORTS_APPLIED',
  'oncology_registry_exports',
  '492_oncology_registry_exports.sql',
  jsonb_build_object(
    'migration', '492_oncology_registry_exports.sql',
    'suite', 'NL-13 P3 oncology completion',
    'patient_timeline_subject', false
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ONCOLOGY_REGISTRY_EXPORTS_APPLIED'
    AND resource_id = '492_oncology_registry_exports.sql'
);

COMMIT;
