-- 370_tenant_terminology_settings.sql
--
-- NL-5 P1: per-tenant terminology UI settings.
--
-- Terminology content tables remain global reference data. This table is the
-- tenant-scoped control plane for which diagnosis systems the UI should prefer
-- or offer. Defaults reproduce today's behavior exactly.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_terminology_settings (
  tenant_id                  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  preferred_diagnosis_system VARCHAR(40) NOT NULL DEFAULT 'ICD11',
  enabled_systems            TEXT[] NOT NULL DEFAULT ARRAY['ICD10','ICD11','SNOMED_CT','LOINC','ATC']::TEXT[],
  snomed_pickers_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by                 UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_tenant_terminology_preferred_system
    CHECK (preferred_diagnosis_system IN ('ICD10','ICD11','SNOMED_CT','LOINC','ATC')),
  CONSTRAINT chk_tenant_terminology_enabled_systems
    CHECK (
      cardinality(enabled_systems) > 0
      AND enabled_systems <@ ARRAY['ICD10','ICD11','SNOMED_CT','LOINC','ATC']::TEXT[]
    )
);

-- Canonical tenant_isolation policy (Pattern A) — copied verbatim from
-- migration 351: full USING + WITH CHECK, four-branch predicate resolving
-- through the shared app_current_tenant_id_uuid() helper (migration 075).
-- SUPER_ADMIN cross-tenant reads keep working via `bypass`.
ALTER TABLE tenant_terminology_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_terminology_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_terminology_settings;
CREATE POLICY tenant_isolation ON tenant_terminology_settings
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
  'TENANT_TERMINOLOGY_SETTINGS_APPLIED',
  'tenant_terminology_settings',
  'tenant_terminology_settings',
  jsonb_build_object(
    'migration', '370_tenant_terminology_settings.sql',
    'program', 'NL-5 P1',
    'reason', 'Add inert per-tenant terminology preference and SNOMED picker controls.',
    'defaults', jsonb_build_object(
      'preferred_diagnosis_system', 'ICD11',
      'enabled_systems', ARRAY['ICD10','ICD11','SNOMED_CT','LOINC','ATC'],
      'snomed_pickers_enabled', false
    ),
    'rls_pattern', 'Pattern A copied from migration 351'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_TERMINOLOGY_SETTINGS_APPLIED'
    AND resource = 'tenant_terminology_settings'
);

COMMIT;
