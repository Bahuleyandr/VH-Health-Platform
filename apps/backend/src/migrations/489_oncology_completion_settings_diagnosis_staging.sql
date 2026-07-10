-- NL-13 P3: oncology completion settings, diagnoses, and owner-sourced staging.
-- Ships inert per tenant; AJCC/TNM source content is supplied by the operator.

BEGIN;

CREATE TABLE IF NOT EXISTS oncology_completion_settings (
  tenant_id                    UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled                      BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at                   TIMESTAMPTZ(6),
  enabled_by                   UUID,
  owner_source_policy_ref      TEXT,
  tumor_board_quorum_policy_ref TEXT,
  acceptance_snapshot          JSONB,
  created_at                   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oncology_diagnoses (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid                UUID NOT NULL,
  encounter_id               UUID,
  cancer_site                TEXT NOT NULL,
  morphology                 TEXT,
  laterality                 VARCHAR(40),
  diagnosis_date             DATE NOT NULL DEFAULT CURRENT_DATE,
  pathology_report_id        BIGINT,
  pathology_case_id          BIGINT,
  malignancy_flag_source     VARCHAR(80) NOT NULL,
  malignancy_flag            VARCHAR(40),
  synoptic_snapshot          JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_evidence_refs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                     VARCHAR(24) NOT NULL DEFAULT 'active',
  created_by                 UUID,
  updated_by                 UUID,
  canonical_timeline_event_id UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_oncology_diagnoses_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_oncology_diagnoses_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_diagnoses_pathology_report
    FOREIGN KEY (pathology_report_id) REFERENCES ap_reports(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_diagnoses_pathology_case
    FOREIGN KEY (pathology_case_id) REFERENCES ap_cases(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_diagnoses_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_oncology_diagnoses_status
    CHECK (status IN ('active', 'resolved', 'entered_in_error')),
  CONSTRAINT chk_oncology_diagnoses_synoptic_object
    CHECK (jsonb_typeof(synoptic_snapshot) = 'object'),
  CONSTRAINT chk_oncology_diagnoses_evidence_array
    CHECK (jsonb_typeof(source_evidence_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_oncology_diagnoses_patient
  ON oncology_diagnoses (tenant_id, patient_uid, diagnosis_date DESC);

CREATE INDEX IF NOT EXISTS idx_oncology_diagnoses_pathology
  ON oncology_diagnoses (tenant_id, pathology_report_id)
  WHERE pathology_report_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oncology_staging_records (
  id                         BIGSERIAL PRIMARY KEY,
  tenant_id                  UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  diagnosis_id               BIGINT NOT NULL,
  patient_uid                UUID NOT NULL,
  encounter_id               UUID,
  t_category                 VARCHAR(24),
  n_category                 VARCHAR(24),
  m_category                 VARCHAR(24),
  clinical_stage             VARCHAR(40),
  pathologic_stage           VARCHAR(40),
  ajcc_edition               VARCHAR(40),
  staging_source             TEXT,
  staging_source_version     VARCHAR(80),
  staging_source_attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  assessor_uid               UUID,
  assessor_role              VARCHAR(80),
  verification_status        VARCHAR(24) NOT NULL DEFAULT 'draft',
  verified_by                UUID,
  verified_at                TIMESTAMPTZ(6),
  verification_note          TEXT,
  canonical_timeline_event_id UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_oncology_staging_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_oncology_staging_diagnosis
    FOREIGN KEY (diagnosis_id) REFERENCES oncology_diagnoses(id) ON DELETE CASCADE,
  CONSTRAINT fk_oncology_staging_encounter
    FOREIGN KEY (encounter_id) REFERENCES patient_encounters(id) ON DELETE SET NULL,
  CONSTRAINT fk_oncology_staging_timeline
    FOREIGN KEY (canonical_timeline_event_id) REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  CONSTRAINT chk_oncology_staging_status
    CHECK (verification_status IN ('draft', 'verified', 'superseded', 'entered_in_error')),
  CONSTRAINT chk_oncology_staging_attachment_array
    CHECK (jsonb_typeof(staging_source_attachment_refs) = 'array'),
  CONSTRAINT chk_oncology_staging_patient_tenant
    UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_oncology_staging_diagnosis
  ON oncology_staging_records (tenant_id, diagnosis_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oncology_staging_patient
  ON oncology_staging_records (tenant_id, patient_uid, created_at DESC);

ALTER TABLE oncology_completion_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE oncology_completion_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE oncology_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE oncology_diagnoses FORCE ROW LEVEL SECURITY;
ALTER TABLE oncology_staging_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE oncology_staging_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON oncology_completion_settings;
CREATE POLICY tenant_isolation ON oncology_completion_settings
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

DROP POLICY IF EXISTS tenant_isolation ON oncology_diagnoses;
CREATE POLICY tenant_isolation ON oncology_diagnoses
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

DROP POLICY IF EXISTS tenant_isolation ON oncology_staging_records;
CREATE POLICY tenant_isolation ON oncology_staging_records
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
  'ONCOLOGY_COMPLETION_DIAGNOSIS_STAGING_APPLIED',
  'oncology_diagnoses',
  '489_oncology_completion_settings_diagnosis_staging.sql',
  jsonb_build_object(
    'migration', '489_oncology_completion_settings_diagnosis_staging.sql',
    'suite', 'NL-13 P3 oncology completion',
    'owner_sourced', true,
    'inert_by_default', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ONCOLOGY_COMPLETION_DIAGNOSIS_STAGING_APPLIED'
    AND resource_id = '489_oncology_completion_settings_diagnosis_staging.sql'
);

COMMIT;
