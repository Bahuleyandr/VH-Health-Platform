-- NL-13 P1f: owner-configured radiation-dose / contrast alert thresholds.
--
-- Per-tenant settings following the migration-351 composition_search_settings
-- pattern: tenant_id is the PK with NO GUC default (writers always supply it),
-- read path is per-tenant and fail-closed. Every threshold column is NULLABLE;
-- NULL means "the owner has not configured this threshold yet" and the rollup
-- service reports thresholds_pending instead of flagging outliers. Dose limits
-- are NEVER seeded or defaulted here — clinical thresholds are an owner
-- decision, not model knowledge.
--
-- The dose values themselves already live in cath_contrast_radiation_records
-- (migration 485: contrast_volume_ml, fluoroscopy_time_min,
-- dose_area_product_gy_cm2, air_kerma_mgy) — no procedure-log columns needed.

CREATE TABLE IF NOT EXISTS cath_dose_alert_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  fluoro_time_alert_min NUMERIC(10,2),
  dap_alert_gy_cm2 NUMERIC(12,3),
  air_kerma_alert_mgy NUMERIC(12,3),
  contrast_volume_alert_ml NUMERIC(10,2),
  notes TEXT,
  configured_by UUID,
  configured_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cath_dose_alert_settings_positive_check
    CHECK (
      (fluoro_time_alert_min IS NULL OR fluoro_time_alert_min > 0)
      AND (dap_alert_gy_cm2 IS NULL OR dap_alert_gy_cm2 > 0)
      AND (air_kerma_alert_mgy IS NULL OR air_kerma_alert_mgy > 0)
      AND (contrast_volume_alert_ml IS NULL OR contrast_volume_alert_ml > 0)
    )
);

ALTER TABLE cath_dose_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_dose_alert_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_dose_alert_settings;
CREATE POLICY tenant_isolation ON cath_dose_alert_settings
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
