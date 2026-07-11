BEGIN;

CREATE TABLE IF NOT EXISTS burn_charts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  emergency_visit_id INTEGER REFERENCES emergency_visits(id) ON DELETE SET NULL,
  admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  mlc_record_id INTEGER REFERENCES mlc_records(id) ON DELETE SET NULL,
  encounter_id UUID,
  mechanism VARCHAR(120) NOT NULL,
  injury_at TIMESTAMPTZ,
  presentation_at TIMESTAMPTZ,
  first_aid TEXT,
  inhalation_risk BOOLEAN NOT NULL DEFAULT false,
  circumferential_burns BOOLEAN NOT NULL DEFAULT false,
  comorbid_risks TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  wound_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'reviewed', 'closed', 'cancelled')),
  recorded_by UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  governance_owner_uid UUID,
  governance_owner_role VARCHAR(80),
  reviewer_signoff_uid UUID,
  reviewer_signoff_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_burn_charts_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT chk_burn_charts_linked_context
    CHECK (emergency_visit_id IS NOT NULL OR admission_id IS NOT NULL OR mlc_record_id IS NOT NULL),
  CONSTRAINT chk_burn_charts_wound_summary_array
    CHECK (jsonb_typeof(wound_summary) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_burn_charts_tenant_patient
  ON burn_charts (tenant_id, patient_uid, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_charts_emergency_visit
  ON burn_charts (tenant_id, emergency_visit_id)
  WHERE emergency_visit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_burn_charts_admission
  ON burn_charts (tenant_id, admission_id)
  WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_burn_charts_mlc
  ON burn_charts (tenant_id, mlc_record_id)
  WHERE mlc_record_id IS NOT NULL;

ALTER TABLE burn_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_charts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON burn_charts;
CREATE POLICY tenant_isolation ON burn_charts
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
