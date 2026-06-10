-- 297_clinical_code_bindings.sql
--
-- WHO ICD-11 integration foundation. The platform already has a global
-- terminology catalogue, but diagnoses and problem-list rows only had fixed
-- ICD-10/SNOMED columns. This table stores the structured codings selected
-- by clinicians while keeping legacy ICD-10 columns intact for payer/reporting
-- flows.

BEGIN;

CREATE TABLE IF NOT EXISTS clinical_code_bindings (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  patient_uid       UUID,
  resource_type     VARCHAR(40) NOT NULL,
  resource_id       VARCHAR(120) NOT NULL,
  system_key        VARCHAR(40) NOT NULL REFERENCES terminology_code_systems(system_key) ON UPDATE CASCADE,
  code              VARCHAR(120) NOT NULL,
  display           TEXT,
  release_id        VARCHAR(80),
  language          VARCHAR(12),
  linearization_uri TEXT,
  foundation_uri    TEXT,
  coding_role       VARCHAR(40) NOT NULL DEFAULT 'diagnosis',
  source            VARCHAR(40) NOT NULL DEFAULT 'manual',
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by        UUID,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_clinical_code_bindings_resource_type
    CHECK (resource_type IN ('diagnosis', 'patient_problem')),
  CONSTRAINT chk_clinical_code_bindings_source
    CHECK (source IN ('manual', 'who_icd_api', 'fhir_import', 'legacy', 'system'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_clinical_code_bindings_resource_code
  ON clinical_code_bindings (resource_type, resource_id, system_key, code, coding_role);

CREATE INDEX IF NOT EXISTS idx_clinical_code_bindings_resource
  ON clinical_code_bindings (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_clinical_code_bindings_patient
  ON clinical_code_bindings (tenant_id, patient_uid, system_key, code)
  WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_code_bindings_code
  ON clinical_code_bindings (system_key, code);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE clinical_code_bindings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE clinical_code_bindings FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON clinical_code_bindings';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON clinical_code_bindings
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
      )
  $f$;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'CLINICAL_CODE_BINDINGS_APPLIED',
  'clinical_code_bindings',
  'clinical_code_bindings',
  jsonb_build_object(
    'migration', '297_clinical_code_bindings.sql',
    'reason', 'Structured ICD-11/ICD-10/SNOMED codings for diagnosis and problem-list resources.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'CLINICAL_CODE_BINDINGS_APPLIED'
    AND resource = 'clinical_code_bindings'
);

COMMIT;
