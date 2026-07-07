-- N6-1: radiology structured report templates.
-- Templates are tenant-scoped and drive ordered report sections while keeping
-- the legacy radiology_orders.report text blob as the compatibility surface.

CREATE TABLE IF NOT EXISTS radiology_report_templates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  template_code VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  modality VARCHAR(50) NOT NULL,
  body_part VARCHAR(100),
  sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  coded_fields_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_radiology_report_templates_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT radiology_report_templates_sections_array
    CHECK (jsonb_typeof(sections) = 'array'),
  CONSTRAINT radiology_report_templates_coded_schema_object
    CHECK (jsonb_typeof(coded_fields_schema) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_radiology_report_templates_code
  ON radiology_report_templates (tenant_id, template_code);

CREATE INDEX IF NOT EXISTS idx_radiology_report_templates_lookup
  ON radiology_report_templates (tenant_id, modality, body_part)
  WHERE is_active = TRUE;

ALTER TABLE radiology_report_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiology_report_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON radiology_report_templates;
CREATE POLICY tenant_isolation ON radiology_report_templates
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

INSERT INTO radiology_report_templates
  (tenant_id, template_code, name, modality, body_part, sections, coded_fields_schema)
VALUES
  (
    '00000000-0000-4000-8000-000000000001'::uuid,
    'XRAY_CHEST_STANDARD_V1',
    'Chest X-ray standard report',
    'xray',
    'chest',
    '[
      {"key":"findings","title":"Findings","required":true,"order":1},
      {"key":"impression","title":"Impression","required":true,"order":2}
    ]'::jsonb,
    '{
      "type":"object",
      "properties":{
        "view":{"type":"string","enum":["pa","ap","lateral","portable"]},
        "comparison_available":{"type":"boolean"}
      }
    }'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000001'::uuid,
    'US_ABDOMEN_STANDARD_V1',
    'Ultrasound abdomen standard report',
    'ultrasound',
    'abdomen',
    '[
      {"key":"liver","title":"Liver","required":false,"order":1},
      {"key":"gallbladder","title":"Gallbladder","required":false,"order":2},
      {"key":"kidneys","title":"Kidneys","required":false,"order":3},
      {"key":"findings","title":"Findings","required":true,"order":4},
      {"key":"impression","title":"Impression","required":true,"order":5}
    ]'::jsonb,
    '{
      "type":"object",
      "properties":{
        "exam_limited":{"type":"boolean"},
        "biliary_dilatation":{"type":"boolean"}
      }
    }'::jsonb
  )
ON CONFLICT (tenant_id, template_code) DO UPDATE SET
  name = EXCLUDED.name,
  modality = EXCLUDED.modality,
  body_part = EXCLUDED.body_part,
  sections = EXCLUDED.sections,
  coded_fields_schema = EXCLUDED.coded_fields_schema,
  is_active = TRUE,
  updated_at = NOW();
