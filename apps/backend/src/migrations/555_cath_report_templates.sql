-- NL-13 P1b: versioned cath-lab report templates.

CREATE TABLE IF NOT EXISTS cath_report_templates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  template_code VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  report_type VARCHAR(40) NOT NULL,
  sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  coded_fields_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  supersedes_template_id BIGINT REFERENCES cath_report_templates(id) ON DELETE SET NULL,
  superseded_at TIMESTAMPTZ(6),
  superseded_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_cath_report_templates_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_report_templates_type_check
    CHECK (report_type IN ('angiogram', 'ptca', 'ppi', 'device_implant', 'ep_study', 'procedure_note', 'other')),
  CONSTRAINT cath_report_templates_sections_array
    CHECK (jsonb_typeof(sections) = 'array'),
  CONSTRAINT cath_report_templates_coded_schema_object
    CHECK (jsonb_typeof(coded_fields_schema) = 'object'),
  CONSTRAINT cath_report_templates_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT cath_report_templates_version_positive
    CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_report_templates_version
  ON cath_report_templates (tenant_id, template_code, version);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_report_templates_active
  ON cath_report_templates (tenant_id, template_code)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_cath_report_templates_lookup
  ON cath_report_templates (tenant_id, report_type, name, version DESC)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_cath_report_templates_supersedes
  ON cath_report_templates (tenant_id, supersedes_template_id)
  WHERE supersedes_template_id IS NOT NULL;

ALTER TABLE cath_report_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_report_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_report_templates;
CREATE POLICY tenant_isolation ON cath_report_templates
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

WITH starter_templates (
  template_code,
  name,
  report_type,
  sections,
  coded_fields_schema
) AS (
  VALUES
    (
      'CATH_ANGIOGRAM_STARTER',
      'Angiogram starter report',
      'angiogram',
      '[
        {"key":"indication","title":"Indication","required":true,"order":1},
        {"key":"access","title":"Access","required":false,"order":2},
        {"key":"findings","title":"Findings","required":true,"order":3},
        {"key":"result","title":"Result","required":true,"order":4},
        {"key":"recommendations","title":"Recommendations","required":false,"order":5}
      ]'::jsonb,
      '{
        "type":"object",
        "properties":{
          "vessels":{"type":"array","items":{"type":"object"}},
          "lesions":{"type":"array","items":{"type":"object"}},
          "hemodynamics":{"type":"object"}
        }
      }'::jsonb
    ),
    (
      'CATH_PTCA_STARTER',
      'PTCA starter report',
      'ptca',
      '[
        {"key":"indication","title":"Indication","required":true,"order":1},
        {"key":"access","title":"Access","required":false,"order":2},
        {"key":"findings","title":"Findings","required":true,"order":3},
        {"key":"intervention","title":"Intervention","required":true,"order":4},
        {"key":"result","title":"Result","required":true,"order":5},
        {"key":"recommendations","title":"Recommendations","required":false,"order":6}
      ]'::jsonb,
      '{
        "type":"object",
        "properties":{
          "vessels_treated":{"type":"array","items":{"type":"string"}},
          "lesions":{"type":"array","items":{"type":"object"}},
          "stents":{"type":"array","items":{"type":"object"}},
          "hemodynamics":{"type":"object"}
        }
      }'::jsonb
    ),
    (
      'CATH_PPI_STARTER',
      'PPI starter report',
      'ppi',
      '[
        {"key":"indication","title":"Indication","required":true,"order":1},
        {"key":"access","title":"Access","required":false,"order":2},
        {"key":"findings","title":"Findings","required":true,"order":3},
        {"key":"implant","title":"Implant","required":true,"order":4},
        {"key":"result","title":"Result","required":true,"order":5},
        {"key":"recommendations","title":"Recommendations","required":false,"order":6}
      ]'::jsonb,
      '{
        "type":"object",
        "properties":{
          "device":{"type":"object"},
          "device_model":{"type":"string"},
          "lead_parameters":{"type":"array","items":{"type":"object"}}
        }
      }'::jsonb
    ),
    (
      'CATH_DEVICE_IMPLANT_STARTER',
      'Device implant starter report',
      'device_implant',
      '[
        {"key":"indication","title":"Indication","required":true,"order":1},
        {"key":"access","title":"Access","required":false,"order":2},
        {"key":"findings","title":"Findings","required":true,"order":3},
        {"key":"implant","title":"Implant","required":true,"order":4},
        {"key":"result","title":"Result","required":true,"order":5},
        {"key":"recommendations","title":"Recommendations","required":false,"order":6}
      ]'::jsonb,
      '{
        "type":"object",
        "properties":{
          "device":{"type":"object"},
          "device_model":{"type":"string"},
          "lead_parameters":{"type":"array","items":{"type":"object"}}
        }
      }'::jsonb
    ),
    (
      'CATH_EP_STUDY_STARTER',
      'EP study starter report',
      'ep_study',
      '[
        {"key":"indication","title":"Indication","required":true,"order":1},
        {"key":"access","title":"Access","required":false,"order":2},
        {"key":"findings","title":"Findings","required":true,"order":3},
        {"key":"result","title":"Result","required":true,"order":4},
        {"key":"recommendations","title":"Recommendations","required":false,"order":5}
      ]'::jsonb,
      '{
        "type":"object",
        "properties":{
          "measurements":{"type":"array","items":{"type":"object"}},
          "induced_rhythms":{"type":"array","items":{"type":"object"}}
        }
      }'::jsonb
    ),
    (
      'CATH_PROCEDURE_NOTE_STARTER',
      'Cath procedure note starter',
      'procedure_note',
      '[
        {"key":"indication","title":"Indication","required":true,"order":1},
        {"key":"access","title":"Access","required":false,"order":2},
        {"key":"findings","title":"Findings","required":true,"order":3},
        {"key":"result","title":"Result","required":true,"order":4},
        {"key":"recommendations","title":"Recommendations","required":false,"order":5}
      ]'::jsonb,
      '{"type":"object","properties":{"procedure_details":{"type":"object"}}}'::jsonb
    ),
    (
      'CATH_OTHER_STARTER',
      'Other cath report starter',
      'other',
      '[
        {"key":"indication","title":"Indication","required":true,"order":1},
        {"key":"access","title":"Access","required":false,"order":2},
        {"key":"findings","title":"Findings","required":true,"order":3},
        {"key":"result","title":"Result","required":true,"order":4},
        {"key":"recommendations","title":"Recommendations","required":false,"order":5}
      ]'::jsonb,
      '{"type":"object","properties":{}}'::jsonb
    )
)
INSERT INTO cath_report_templates (
  tenant_id,
  template_code,
  name,
  report_type,
  sections,
  coded_fields_schema,
  version,
  is_active,
  metadata
)
SELECT
  t.id,
  s.template_code,
  s.name,
  s.report_type,
  s.sections,
  s.coded_fields_schema,
  1,
  TRUE,
  jsonb_build_object('starter', TRUE, 'source', 'NL-13 P1b')
FROM tenants t
CROSS JOIN starter_templates s
ON CONFLICT (tenant_id, template_code, version) DO NOTHING;
