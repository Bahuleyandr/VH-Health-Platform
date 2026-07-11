-- NL-13 P1b: cath-lab procedure reports, lifecycle, and append-only addenda.

CREATE TABLE IF NOT EXISTS cath_procedure_reports (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE RESTRICT,
  procedure_log_id BIGINT REFERENCES cath_procedure_logs(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  report_type VARCHAR(40) NOT NULL,
  template_id BIGINT NOT NULL REFERENCES cath_report_templates(id) ON DELETE RESTRICT,
  template_version INTEGER NOT NULL,
  narrative_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  coded_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  findings_summary TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  viewer_study_accession VARCHAR(160),
  preliminary_by UUID,
  preliminary_at TIMESTAMPTZ(6),
  signed_by UUID,
  signed_at TIMESTAMPTZ(6),
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_cath_procedure_reports_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_procedure_reports_type_check
    CHECK (report_type IN ('angiogram', 'ptca', 'ppi', 'device_implant', 'ep_study', 'procedure_note', 'other')),
  CONSTRAINT cath_procedure_reports_status_check
    CHECK (status IN ('draft', 'preliminary', 'signed')),
  CONSTRAINT cath_procedure_reports_sections_array
    CHECK (jsonb_typeof(narrative_sections) = 'array'),
  CONSTRAINT cath_procedure_reports_coded_fields_object
    CHECK (jsonb_typeof(coded_fields) = 'object'),
  CONSTRAINT cath_procedure_reports_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT cath_procedure_reports_template_version_positive
    CHECK (template_version > 0),
  CONSTRAINT cath_procedure_reports_preliminary_stamp_check
    CHECK (
      (status = 'draft' AND preliminary_by IS NULL AND preliminary_at IS NULL)
      OR (status IN ('preliminary', 'signed') AND preliminary_by IS NOT NULL AND preliminary_at IS NOT NULL)
    ),
  CONSTRAINT cath_procedure_reports_signed_stamp_check
    CHECK (
      (status <> 'signed' AND signed_by IS NULL AND signed_at IS NULL)
      OR (status = 'signed' AND signed_by IS NOT NULL AND signed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_cath_procedure_reports_case
  ON cath_procedure_reports (tenant_id, case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_procedure_reports_patient
  ON cath_procedure_reports (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_procedure_reports_status
  ON cath_procedure_reports (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_procedure_reports_template
  ON cath_procedure_reports (tenant_id, template_id, template_version);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_procedure_reports_signed_procedure_type
  ON cath_procedure_reports (tenant_id, procedure_log_id, report_type)
  WHERE status = 'signed' AND procedure_log_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cath_report_addenda (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  report_id BIGINT NOT NULL REFERENCES cath_procedure_reports(id) ON DELETE RESTRICT,
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE RESTRICT,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  author_uid UUID NOT NULL,
  reason TEXT NOT NULL,
  narrative TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_cath_report_addenda_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_report_addenda_reason_present
    CHECK (length(btrim(reason)) > 0),
  CONSTRAINT cath_report_addenda_narrative_present
    CHECK (length(btrim(narrative)) > 0),
  CONSTRAINT cath_report_addenda_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_cath_report_addenda_report
  ON cath_report_addenda (tenant_id, report_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_cath_report_addenda_patient
  ON cath_report_addenda (tenant_id, patient_uid, created_at DESC);

CREATE OR REPLACE FUNCTION cath_report_addendum_validate_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent cath_procedure_reports%ROWTYPE;
BEGIN
  SELECT * INTO parent
    FROM cath_procedure_reports
   WHERE id = NEW.report_id
     AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR parent.status <> 'signed' THEN
    RAISE EXCEPTION 'cath report addenda require a signed report in the same tenant'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.case_id IS DISTINCT FROM parent.case_id
     OR NEW.patient_uid IS DISTINCT FROM parent.patient_uid
     OR NEW.encounter_id IS DISTINCT FROM parent.encounter_id THEN
    RAISE EXCEPTION 'cath report addendum subject must match its parent report'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cath_report_addendum_validate_parent ON cath_report_addenda;
CREATE TRIGGER trg_cath_report_addendum_validate_parent
  BEFORE INSERT ON cath_report_addenda
  FOR EACH ROW EXECUTE FUNCTION cath_report_addendum_validate_parent();

CREATE OR REPLACE FUNCTION cath_signed_report_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.cath_report_mutation_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION
      'signed cath procedure reports are immutable: % is not allowed; append a cath_report_addenda row instead',
      TG_OP
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_cath_signed_report_immutable ON cath_procedure_reports;
CREATE TRIGGER trg_cath_signed_report_immutable
  BEFORE UPDATE OR DELETE ON cath_procedure_reports
  FOR EACH ROW EXECUTE FUNCTION cath_signed_report_block_mutation();

CREATE OR REPLACE FUNCTION cath_report_addenda_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.cath_report_mutation_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'cath_report_addenda is append-only: % is not allowed',
    TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS trg_cath_report_addenda_append_only ON cath_report_addenda;
CREATE TRIGGER trg_cath_report_addenda_append_only
  BEFORE UPDATE OR DELETE ON cath_report_addenda
  FOR EACH ROW EXECUTE FUNCTION cath_report_addenda_block_mutation();

ALTER TABLE cath_procedure_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_procedure_reports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_procedure_reports;
CREATE POLICY tenant_isolation ON cath_procedure_reports
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

ALTER TABLE cath_report_addenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_report_addenda FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_report_addenda;
CREATE POLICY tenant_isolation ON cath_report_addenda
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
