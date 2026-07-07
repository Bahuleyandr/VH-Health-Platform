-- N6-4: anatomic pathology case accessioning and grossing.

CREATE TABLE IF NOT EXISTS ap_cases (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ap_case_uid UUID NOT NULL DEFAULT gen_random_uuid(),
  case_number VARCHAR(80) NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  source_investigation_id INTEGER,
  primary_specimen_id INTEGER,
  case_kind VARCHAR(40) NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'routine',
  status VARCHAR(40) NOT NULL DEFAULT 'accessioned',
  clinical_history TEXT,
  accessioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accessioned_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ap_cases_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_ap_cases_investigation
    FOREIGN KEY (source_investigation_id) REFERENCES investigations(id) ON DELETE SET NULL,
  CONSTRAINT fk_ap_cases_primary_specimen
    FOREIGN KEY (primary_specimen_id) REFERENCES lab_specimens(id) ON DELETE SET NULL,
  CONSTRAINT ap_cases_kind_check
    CHECK (case_kind IN ('histopathology', 'cytology', 'frozen_section')),
  CONSTRAINT ap_cases_priority_check
    CHECK (priority IN ('routine', 'urgent', 'stat')),
  CONSTRAINT ap_cases_status_check
    CHECK (status IN ('accessioned', 'grossing', 'processing', 'slides_ready', 'reported', 'signed', 'amended', 'cancelled')),
  CONSTRAINT ap_cases_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_cases_case_number
  ON ap_cases (tenant_id, case_number);

CREATE INDEX IF NOT EXISTS idx_ap_cases_patient
  ON ap_cases (tenant_id, patient_uid, accessioned_at DESC);

CREATE INDEX IF NOT EXISTS idx_ap_cases_worklist
  ON ap_cases (tenant_id, status, priority, accessioned_at DESC);

CREATE TABLE IF NOT EXISTS ap_case_specimens (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ap_case_id BIGINT NOT NULL,
  specimen_id INTEGER NOT NULL,
  specimen_role VARCHAR(40) NOT NULL DEFAULT 'primary',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ap_case_specimens_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_ap_case_specimens_case
    FOREIGN KEY (ap_case_id) REFERENCES ap_cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_ap_case_specimens_specimen
    FOREIGN KEY (specimen_id) REFERENCES lab_specimens(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_case_specimens_case_specimen
  ON ap_case_specimens (tenant_id, ap_case_id, specimen_id);

CREATE INDEX IF NOT EXISTS idx_ap_case_specimens_specimen
  ON ap_case_specimens (tenant_id, specimen_id);

CREATE TABLE IF NOT EXISTS ap_gross_records (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ap_case_id BIGINT NOT NULL,
  gross_text TEXT NOT NULL,
  specimen_weight_g NUMERIC(10, 3),
  dimensions_text VARCHAR(255),
  cassette_count INTEGER,
  dictation_ref VARCHAR(160),
  recorded_by UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ap_gross_records_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_ap_gross_records_case
    FOREIGN KEY (ap_case_id) REFERENCES ap_cases(id) ON DELETE CASCADE,
  CONSTRAINT ap_gross_records_cassette_count_check
    CHECK (cassette_count IS NULL OR cassette_count >= 0),
  CONSTRAINT ap_gross_records_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_ap_gross_records_case
  ON ap_gross_records (tenant_id, ap_case_id, recorded_at DESC);

ALTER TABLE ap_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE ap_case_specimens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_case_specimens FORCE ROW LEVEL SECURITY;
ALTER TABLE ap_gross_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_gross_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ap_cases;
CREATE POLICY tenant_isolation ON ap_cases
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

DROP POLICY IF EXISTS tenant_isolation ON ap_case_specimens;
CREATE POLICY tenant_isolation ON ap_case_specimens
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

DROP POLICY IF EXISTS tenant_isolation ON ap_gross_records;
CREATE POLICY tenant_isolation ON ap_gross_records
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
