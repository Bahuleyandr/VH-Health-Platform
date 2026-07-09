-- Migration 463: NL11-S8 SMART FHIR resource-by-resource write plan.
-- Records which FHIR write interactions are active, planned, or deferred and
-- points reviewers at the golden fixture used for each active write resource.

BEGIN;

CREATE TABLE IF NOT EXISTS smart_fhir_write_resource_plan (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  resource_type VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'planned',
  required_scope VARCHAR(160) NOT NULL,
  fixture_path TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT smart_fhir_write_resource_plan_status_chk
    CHECK (status IN ('active', 'planned', 'deferred', 'blocked')),
  CONSTRAINT smart_fhir_write_resource_plan_resource_chk
    CHECK (resource_type ~ '^[A-Z][A-Za-z]+$'),
  CONSTRAINT smart_fhir_write_resource_plan_scope_chk
    CHECK (required_scope ~ '^(patient|user|system)/[A-Za-z*]+\.(read|write|\*)$'),
  CONSTRAINT fk_smart_fhir_write_resource_plan_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, resource_type)
);

CREATE INDEX IF NOT EXISTS idx_smart_fhir_write_resource_plan_status
  ON smart_fhir_write_resource_plan (tenant_id, status, resource_type);

ALTER TABLE smart_fhir_write_resource_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_fhir_write_resource_plan FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON smart_fhir_write_resource_plan;
CREATE POLICY tenant_isolation ON smart_fhir_write_resource_plan
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

INSERT INTO smart_fhir_write_resource_plan
  (tenant_id, resource_type, status, required_scope, fixture_path, notes)
SELECT t.id, v.resource_type, v.status, v.required_scope, v.fixture_path, v.notes
FROM tenants t
CROSS JOIN (VALUES
  ('Observation', 'active', 'patient/Observation.write', 'apps/backend/src/tests/fixtures/fhir/smart-observation-create.json', 'Vitals-backed Observation create is active.'),
  ('Condition', 'active', 'patient/Condition.write', 'apps/backend/src/tests/fixtures/fhir/smart-condition-create.json', 'Problem-list-backed Condition create is active.'),
  ('AllergyIntolerance', 'active', 'patient/AllergyIntolerance.write', 'apps/backend/src/tests/fixtures/fhir/smart-allergy-create.json', 'Structured allergy create is active.'),
  ('MedicationRequest', 'planned', 'patient/MedicationRequest.write', NULL, 'Prescription write mapping is planned after medication safety review.'),
  ('ServiceRequest', 'planned', 'patient/ServiceRequest.write', NULL, 'Referral/order write mapping is planned.'),
  ('Procedure', 'planned', 'patient/Procedure.write', NULL, 'Procedure write mapping is planned.'),
  ('DiagnosticReport', 'planned', 'patient/DiagnosticReport.write', NULL, 'Result write mapping is planned.'),
  ('Encounter', 'planned', 'patient/Encounter.write', NULL, 'Encounter/admission write mapping is planned.'),
  ('DocumentReference', 'planned', 'patient/DocumentReference.write', NULL, 'Document write mapping is planned after attachment policy review.'),
  ('Patient', 'deferred', 'patient/Patient.write', NULL, 'Patient demographic writes stay deferred to migration/import governance.')
) AS v(resource_type, status, required_scope, fixture_path, notes)
ON CONFLICT (tenant_id, resource_type) DO NOTHING;

COMMIT;
