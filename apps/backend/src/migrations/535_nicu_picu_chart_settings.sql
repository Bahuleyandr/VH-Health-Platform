-- NL-14 P3: per-tenant NICU/PICU specialty chart settings (fail-closed).
--
-- Deploy stays HELD: the whole NICU/PICU specialty surface ships inert behind
-- this per-tenant flag (mig-351 composition_search_settings +
-- compositionFeatureService fail-closed pattern; same enable-gate shape as
-- the P1 icu_chart_settings, mig 495). NICU-specific chart writes are
-- rejected until an operator enables the tenant with an acceptance snapshot.
-- device_fleet_snapshot is the owner-decision evidence slot for the NICU
-- device fleet (spec §6.4) — empty until the operator supplies it; NL-14
-- never assumes a fleet. Per-user NICU/PICU UI preferences reuse the P1
-- icu_chart_ui_preferences table (mig 501), which already scopes by unit_code.

BEGIN;

CREATE TABLE IF NOT EXISTS nicu_picu_chart_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  specialty_view_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  scoring_governance JSONB NOT NULL DEFAULT '{}'::jsonb,
  device_fleet_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_source VARCHAR(80) NOT NULL DEFAULT 'nl5_content_studio',
  enabled_at TIMESTAMPTZ(6),
  enabled_by UUID,
  acceptance_snapshot JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT nicu_picu_chart_settings_content_source_check
    CHECK (content_source IN ('nl5_content_studio', 'operator_supplied', 'unavailable')),
  CONSTRAINT nicu_picu_chart_settings_enable_gate_check
    CHECK (
      enabled = FALSE
      OR (acceptance_snapshot IS NOT NULL AND enabled_at IS NOT NULL AND enabled_by IS NOT NULL)
    )
);

ALTER TABLE nicu_picu_chart_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_picu_chart_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_picu_chart_settings;
CREATE POLICY tenant_isolation ON nicu_picu_chart_settings
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
