-- N6-4: anatomic pathology reports, addenda, and TAT metrics.

CREATE TABLE IF NOT EXISTS ap_reports (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ap_case_id BIGINT NOT NULL,
  report_status VARCHAR(40) NOT NULL DEFAULT 'draft',
  gross_text TEXT,
  microscopic_text TEXT,
  diagnosis_text TEXT,
  synoptic_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  malignancy_flag VARCHAR(40) NOT NULL DEFAULT 'not_assessed',
  report_author_uid UUID,
  preliminary_at TIMESTAMPTZ,
  preliminary_by UUID,
  signed_at TIMESTAMPTZ,
  signed_by UUID,
  amended_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ap_reports_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_ap_reports_case
    FOREIGN KEY (ap_case_id) REFERENCES ap_cases(id) ON DELETE CASCADE,
  CONSTRAINT ap_reports_status_check
    CHECK (report_status IN ('draft', 'preliminary', 'final', 'amended')),
  CONSTRAINT ap_reports_malignancy_check
    CHECK (malignancy_flag IN ('not_assessed', 'benign', 'premalignant', 'malignant', 'suspicious', 'inadequate')),
  CONSTRAINT ap_reports_synoptic_object
    CHECK (jsonb_typeof(synoptic_fields) = 'object'),
  CONSTRAINT ap_reports_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_reports_case
  ON ap_reports (tenant_id, ap_case_id);

CREATE INDEX IF NOT EXISTS idx_ap_reports_status
  ON ap_reports (tenant_id, report_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ap_report_addenda (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ap_report_id BIGINT NOT NULL,
  addendum_text TEXT NOT NULL,
  addendum_by UUID,
  addendum_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ap_report_addenda_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_ap_report_addenda_report
    FOREIGN KEY (ap_report_id) REFERENCES ap_reports(id) ON DELETE CASCADE,
  CONSTRAINT ap_report_addenda_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_ap_report_addenda_report
  ON ap_report_addenda (tenant_id, ap_report_id, addendum_at DESC);

CREATE TABLE IF NOT EXISTS ap_tat_thresholds (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_kind VARCHAR(40) NOT NULL,
  priority VARCHAR(20) NOT NULL,
  target_hours NUMERIC(8, 2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ap_tat_thresholds_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT ap_tat_thresholds_kind_check
    CHECK (case_kind IN ('histopathology', 'cytology', 'frozen_section')),
  CONSTRAINT ap_tat_thresholds_priority_check
    CHECK (priority IN ('routine', 'urgent', 'stat')),
  CONSTRAINT ap_tat_thresholds_target_check
    CHECK (target_hours > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_tat_thresholds_scope
  ON ap_tat_thresholds (tenant_id, case_kind, priority);

CREATE INDEX IF NOT EXISTS idx_ap_tat_thresholds_active
  ON ap_tat_thresholds (tenant_id, case_kind, priority)
  WHERE is_active = TRUE;

ALTER TABLE ap_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE ap_report_addenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_report_addenda FORCE ROW LEVEL SECURITY;
ALTER TABLE ap_tat_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_tat_thresholds FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ap_reports;
CREATE POLICY tenant_isolation ON ap_reports
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

DROP POLICY IF EXISTS tenant_isolation ON ap_report_addenda;
CREATE POLICY tenant_isolation ON ap_report_addenda
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

DROP POLICY IF EXISTS tenant_isolation ON ap_tat_thresholds;
CREATE POLICY tenant_isolation ON ap_tat_thresholds
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

INSERT INTO ap_tat_thresholds
  (tenant_id, case_kind, priority, target_hours)
VALUES
  ('00000000-0000-4000-8000-000000000001'::uuid, 'histopathology', 'routine', 72),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'histopathology', 'urgent', 36),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'histopathology', 'stat', 24),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'cytology', 'routine', 48),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'cytology', 'urgent', 24),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'cytology', 'stat', 12),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'frozen_section', 'routine', 2),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'frozen_section', 'urgent', 1),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'frozen_section', 'stat', 0.75)
ON CONFLICT (tenant_id, case_kind, priority) DO UPDATE SET
  target_hours = EXCLUDED.target_hours,
  is_active = TRUE,
  updated_at = NOW();

CREATE OR REPLACE VIEW ap_tat_metrics AS
SELECT
  c.tenant_id,
  c.id AS ap_case_id,
  c.case_number,
  c.patient_uid,
  c.case_kind,
  c.priority,
  c.status AS case_status,
  c.accessioned_at,
  MIN(g.recorded_at) AS gross_recorded_at,
  MIN(b.created_at) AS first_block_created_at,
  MIN(s.created_at) AS first_slide_created_at,
  r.created_at AS report_created_at,
  r.preliminary_at,
  r.signed_at,
  r.report_status,
  th.target_hours,
  ROUND(EXTRACT(EPOCH FROM (COALESCE(r.signed_at, NOW()) - c.accessioned_at)) / 3600.0, 2) AS elapsed_hours,
  CASE
    WHEN r.signed_at IS NOT NULL THEN 'signed'
    WHEN r.id IS NOT NULL THEN 'reported'
    WHEN COUNT(s.id) > 0 THEN 'slides_ready'
    WHEN COUNT(b.id) > 0 THEN 'processing'
    WHEN COUNT(g.id) > 0 THEN 'grossing'
    ELSE 'accessioned'
  END AS current_tat_stage,
  CASE
    WHEN th.target_hours IS NULL THEN FALSE
    ELSE (COALESCE(r.signed_at, NOW()) - c.accessioned_at) > (th.target_hours * INTERVAL '1 hour')
  END AS breached
FROM ap_cases c
LEFT JOIN ap_gross_records g
  ON g.tenant_id = c.tenant_id AND g.ap_case_id = c.id
LEFT JOIN ap_blocks b
  ON b.tenant_id = c.tenant_id AND b.ap_case_id = c.id
LEFT JOIN ap_slides s
  ON s.tenant_id = c.tenant_id AND s.ap_case_id = c.id
LEFT JOIN ap_reports r
  ON r.tenant_id = c.tenant_id AND r.ap_case_id = c.id
LEFT JOIN ap_tat_thresholds th
  ON th.tenant_id = c.tenant_id
  AND th.case_kind = c.case_kind
  AND th.priority = c.priority
  AND th.is_active = TRUE
GROUP BY
  c.tenant_id, c.id, c.case_number, c.patient_uid, c.case_kind, c.priority,
  c.status, c.accessioned_at, r.id, r.created_at, r.preliminary_at, r.signed_at,
  r.report_status, th.target_hours;
