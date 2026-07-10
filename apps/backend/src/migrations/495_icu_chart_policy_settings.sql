-- NL-14 P1: ICU chart policy/settings foundation.
--
-- Per-tenant, fail-closed policy surfaces for ICU charting. This keeps alarm
-- policy, chart-density assumptions, and score/protocol governance as operator
-- supplied evidence instead of hardcoded clinical constants.

BEGIN;

CREATE TABLE IF NOT EXISTS icu_chart_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  charting_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  alarm_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  scoring_governance JSONB NOT NULL DEFAULT '{}'::jsonb,
  protocol_content_source VARCHAR(80) NOT NULL DEFAULT 'nl5_content_studio',
  enabled_at TIMESTAMPTZ(6),
  enabled_by UUID,
  acceptance_snapshot JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT icu_chart_settings_content_source_check
    CHECK (protocol_content_source IN ('nl5_content_studio', 'operator_supplied', 'unavailable')),
  CONSTRAINT icu_chart_settings_enable_gate_check
    CHECK (
      enabled = FALSE
      OR (acceptance_snapshot IS NOT NULL AND enabled_at IS NOT NULL AND enabled_by IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS icu_chart_policy_versions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  policy_kind VARCHAR(40) NOT NULL,
  version_label VARCHAR(80) NOT NULL,
  source VARCHAR(80) NOT NULL DEFAULT 'nl5_content_studio',
  reference_uri TEXT,
  reference_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_by UUID,
  approved_at TIMESTAMPTZ(6),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT icu_chart_policy_versions_kind_check
    CHECK (policy_kind IN ('charting', 'alarm', 'rass', 'cam_icu', 'cpot', 'sofa', 'sbt_readiness', 'sedation_weaning')),
  CONSTRAINT icu_chart_policy_versions_source_check
    CHECK (source IN ('nl5_content_studio', 'operator_supplied', 'external_reference')),
  CONSTRAINT icu_chart_policy_versions_approval_check
    CHECK (active = FALSE OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT fk_icu_chart_policy_versions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_icu_chart_policy_versions_label
  ON icu_chart_policy_versions (tenant_id, policy_kind, version_label);

CREATE UNIQUE INDEX IF NOT EXISTS ux_icu_chart_policy_versions_active
  ON icu_chart_policy_versions (tenant_id, policy_kind)
  WHERE active = TRUE;

ALTER TABLE icu_chart_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_chart_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_chart_settings;
CREATE POLICY tenant_isolation ON icu_chart_settings
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

ALTER TABLE icu_chart_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_chart_policy_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_chart_policy_versions;
CREATE POLICY tenant_isolation ON icu_chart_policy_versions
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
