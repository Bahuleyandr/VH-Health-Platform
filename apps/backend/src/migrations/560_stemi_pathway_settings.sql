-- NL-13 P1c: owner-governed, tenant-scoped Code-STEMI settings.
-- Targets and activation criteria are intentionally unseeded and inert. A
-- tenant may enable the pathway without targets; its SLA rows then remain
-- targets_pending and cannot be marked breached.

BEGIN;

CREATE TABLE IF NOT EXISTS stemi_pathway_settings (
  tenant_id UUID PRIMARY KEY DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at TIMESTAMPTZ(6),
  enabled_by UUID,
  clock_definition_source TEXT,
  clock_definition_version TEXT,
  clock_definition_attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  activation_criteria_source TEXT,
  activation_criteria_version TEXT,
  activation_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  door_to_ecg_target_minutes INTEGER,
  door_to_lab_target_minutes INTEGER,
  door_to_balloon_target_minutes INTEGER,
  notification_role_codes TEXT[] NOT NULL DEFAULT ARRAY['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF']::text[],
  acceptance_snapshot JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stemi_pathway_settings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT stemi_pathway_settings_targets_positive CHECK (
    (door_to_ecg_target_minutes IS NULL OR door_to_ecg_target_minutes > 0)
    AND (door_to_lab_target_minutes IS NULL OR door_to_lab_target_minutes > 0)
    AND (door_to_balloon_target_minutes IS NULL OR door_to_balloon_target_minutes > 0)
  ),
  CONSTRAINT stemi_pathway_settings_json_shapes CHECK (
    jsonb_typeof(clock_definition_attachment_refs) = 'array'
    AND jsonb_typeof(activation_criteria) = 'object'
    AND jsonb_typeof(metadata) = 'object'
    AND (acceptance_snapshot IS NULL OR jsonb_typeof(acceptance_snapshot) = 'object')
  ),
  CONSTRAINT stemi_pathway_settings_roles_not_empty CHECK (
    cardinality(notification_role_codes) > 0
    AND notification_role_codes <@ ARRAY['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF']::text[]
  ),
  CONSTRAINT stemi_pathway_settings_enabled_owner_metadata CHECK (
    enabled = FALSE
    OR (
      NULLIF(BTRIM(COALESCE(clock_definition_source, '')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(clock_definition_version, '')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(activation_criteria_source, '')), '') IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(activation_criteria_version, '')), '') IS NOT NULL
      AND enabled_by IS NOT NULL
      AND enabled_at IS NOT NULL
    )
  )
);

ALTER TABLE stemi_pathway_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE stemi_pathway_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON stemi_pathway_settings;
CREATE POLICY tenant_isolation ON stemi_pathway_settings
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
