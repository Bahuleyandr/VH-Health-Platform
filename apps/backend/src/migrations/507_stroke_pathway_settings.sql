-- NL-13 P2: tenant owner settings for stroke pathway enablement.
-- This intentionally does NOT seed stroke thrombolysis privilege_catalog keys:
-- no owner-confirmed privilege key was provided in the build prompt, so the
-- approver gate is wired by code and fails closed until configured.

CREATE TABLE IF NOT EXISTS stroke_pathway_settings (
  tenant_id UUID PRIMARY KEY DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at TIMESTAMPTZ,
  enabled_by UUID,
  clock_definition_source TEXT,
  clock_definition_version TEXT,
  clock_definition_attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  nihss_source TEXT,
  nihss_version TEXT,
  nihss_attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  thrombolysis_protocol_source TEXT,
  thrombolysis_protocol_version TEXT,
  thrombolysis_protocol_attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  thrombolysis_approver_privilege_key VARCHAR(120),
  door_to_ct_target_minutes INTEGER,
  door_to_needle_target_minutes INTEGER,
  acceptance_snapshot JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stroke_pathway_settings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT stroke_pathway_settings_targets_positive
    CHECK (
      (door_to_ct_target_minutes IS NULL OR door_to_ct_target_minutes > 0)
      AND (door_to_needle_target_minutes IS NULL OR door_to_needle_target_minutes > 0)
    ),
  CONSTRAINT stroke_pathway_settings_attachments_arrays
    CHECK (
      jsonb_typeof(clock_definition_attachment_refs) = 'array'
      AND jsonb_typeof(nihss_attachment_refs) = 'array'
      AND jsonb_typeof(thrombolysis_protocol_attachment_refs) = 'array'
    ),
  CONSTRAINT stroke_pathway_settings_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT stroke_pathway_settings_acceptance_object
    CHECK (acceptance_snapshot IS NULL OR jsonb_typeof(acceptance_snapshot) = 'object'),
  CONSTRAINT stroke_pathway_settings_enabled_owner_metadata
    CHECK (
      enabled = FALSE
      OR (
        NULLIF(BTRIM(COALESCE(clock_definition_source, '')), '') IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(clock_definition_version, '')), '') IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(nihss_source, '')), '') IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(nihss_version, '')), '') IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(thrombolysis_protocol_source, '')), '') IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(thrombolysis_protocol_version, '')), '') IS NOT NULL
        AND door_to_ct_target_minutes IS NOT NULL
        AND door_to_needle_target_minutes IS NOT NULL
        AND enabled_by IS NOT NULL
        AND enabled_at IS NOT NULL
      )
    )
);

ALTER TABLE stroke_pathway_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE stroke_pathway_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stroke_pathway_settings;
CREATE POLICY tenant_isolation ON stroke_pathway_settings
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
SELECT 'NL13_P2_STROKE_PRIVILEGE_GATE_LEFT_UNSEEDED',
       'stroke_pathway_settings',
       'stroke_thrombolysis_approver_privilege_key',
       jsonb_build_object(
         'migration', '507_stroke_pathway_settings.sql',
         'reason', 'No owner-confirmed thrombolysis approver privilege key was supplied; code gate remains fail-closed until tenant settings provide one.'
       ),
       NOW()
WHERE EXISTS (
  SELECT 1
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1
    FROM audit_logs
   WHERE action = 'NL13_P2_STROKE_PRIVILEGE_GATE_LEFT_UNSEEDED'
);
