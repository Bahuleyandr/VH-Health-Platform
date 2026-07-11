BEGIN;

CREATE TABLE IF NOT EXISTS burn_tbsa_references (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  reference_key VARCHAR(120) NOT NULL,
  title VARCHAR(255) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  age_template_key VARCHAR(80),
  age_min_months INTEGER,
  age_max_months INTEGER,
  region_weights JSONB NOT NULL,
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
  CONSTRAINT fk_burn_tbsa_references_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT chk_burn_tbsa_references_weights_object
    CHECK (jsonb_typeof(region_weights) = 'object'),
  CONSTRAINT chk_burn_tbsa_references_age_range
    CHECK (age_min_months IS NULL OR age_max_months IS NULL OR age_min_months <= age_max_months)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_burn_tbsa_references_version
  ON burn_tbsa_references (tenant_id, reference_key, version);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_burn_tbsa_references_active
  ON burn_tbsa_references (tenant_id, reference_key)
  WHERE active = true;

ALTER TABLE burn_tbsa_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_tbsa_references FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON burn_tbsa_references;
CREATE POLICY tenant_isolation ON burn_tbsa_references
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

CREATE TABLE IF NOT EXISTS burn_wound_regions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  burn_chart_id BIGINT NOT NULL REFERENCES burn_charts(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  body_region_code VARCHAR(80) NOT NULL,
  body_region_label VARCHAR(160) NOT NULL,
  side VARCHAR(20) CHECK (side IS NULL OR side IN ('left', 'right', 'midline', 'bilateral', 'not_applicable')),
  surface VARCHAR(40),
  depth VARCHAR(40) NOT NULL
    CHECK (depth IN ('superficial', 'partial_thickness', 'deep_partial', 'full_thickness', 'mixed', 'unknown')),
  area_percent NUMERIC(5,2) NOT NULL CHECK (area_percent >= 0 AND area_percent <= 100),
  reference_id BIGINT REFERENCES burn_tbsa_references(id) ON DELETE RESTRICT,
  reference_key VARCHAR(120),
  reference_version INTEGER,
  age_template_key VARCHAR(80),
  clinician_override_percent NUMERIC(5,2)
    CHECK (clinician_override_percent IS NULL OR (clinician_override_percent >= 0 AND clinician_override_percent <= 100)),
  override_reason TEXT,
  override_by UUID,
  override_at TIMESTAMPTZ,
  decision_support_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_burn_wound_regions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT chk_burn_wound_regions_payload_object
    CHECK (jsonb_typeof(decision_support_payload) = 'object'),
  CONSTRAINT chk_burn_wound_regions_override_reason
    CHECK (clinician_override_percent IS NULL OR NULLIF(TRIM(COALESCE(override_reason, '')), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_burn_wound_regions_chart
  ON burn_wound_regions (tenant_id, burn_chart_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_wound_regions_patient
  ON burn_wound_regions (tenant_id, patient_uid, recorded_at DESC);

ALTER TABLE burn_wound_regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_wound_regions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON burn_wound_regions;
CREATE POLICY tenant_isolation ON burn_wound_regions
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
