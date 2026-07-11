BEGIN;

CREATE TABLE IF NOT EXISTS burn_fluid_references (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  reference_key VARCHAR(120) NOT NULL,
  title VARCHAR(255) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  content_order_set_id INTEGER REFERENCES clinical_order_sets(id) ON DELETE RESTRICT,
  evidence_owner_uid UUID,
  evidence_source_uri TEXT,
  governance_owner_uid UUID,
  reviewer_signoff_uid UUID,
  reviewer_signoff_at TIMESTAMPTZ,
  status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'retired')),
  active BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_burn_fluid_references_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_burn_fluid_references_version
  ON burn_fluid_references (tenant_id, reference_key, version);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_burn_fluid_references_active
  ON burn_fluid_references (tenant_id, reference_key)
  WHERE active = true;

ALTER TABLE burn_fluid_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_fluid_references FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON burn_fluid_references;
CREATE POLICY tenant_isolation ON burn_fluid_references
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

CREATE TABLE IF NOT EXISTS burn_fluid_worksheets (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  burn_chart_id BIGINT NOT NULL REFERENCES burn_charts(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  weight_kg NUMERIC(6,2) CHECK (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg <= 500)),
  tbsa_percent NUMERIC(5,2) CHECK (tbsa_percent IS NULL OR (tbsa_percent >= 0 AND tbsa_percent <= 100)),
  protocol_reference_id BIGINT NOT NULL REFERENCES burn_fluid_references(id) ON DELETE RESTRICT,
  content_order_set_id INTEGER NOT NULL REFERENCES clinical_order_sets(id) ON DELETE RESTRICT,
  worksheet_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  clinician_decisions JSONB NOT NULL,
  decision_summary TEXT,
  protocol_unavailable BOOLEAN NOT NULL DEFAULT false,
  recorded_by UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_burn_fluid_worksheets_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT chk_burn_fluid_worksheets_inputs_object
    CHECK (jsonb_typeof(worksheet_inputs) = 'object'),
  CONSTRAINT chk_burn_fluid_worksheets_decisions_object
    CHECK (jsonb_typeof(clinician_decisions) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_burn_fluid_worksheets_chart
  ON burn_fluid_worksheets (tenant_id, burn_chart_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_fluid_worksheets_patient
  ON burn_fluid_worksheets (tenant_id, patient_uid, recorded_at DESC);

ALTER TABLE burn_fluid_worksheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_fluid_worksheets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON burn_fluid_worksheets;
CREATE POLICY tenant_isolation ON burn_fluid_worksheets
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
