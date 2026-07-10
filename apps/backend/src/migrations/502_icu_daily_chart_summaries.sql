-- NL-14 P1: optional ICU daily chart summary cache.
--
-- The live chart hydrator remains authoritative. This cache is inert until a
-- future scheduler/materializer writes bounded daily summary rows.

BEGIN;

CREATE TABLE IF NOT EXISTS icu_daily_chart_summaries (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  summary_date DATE NOT NULL,
  manual_flowsheet_count INTEGER NOT NULL DEFAULT 0,
  device_vitals_count INTEGER NOT NULL DEFAULT 0,
  unverified_device_vitals_count INTEGER NOT NULL DEFAULT 0,
  active_denominator_devices JSONB NOT NULL DEFAULT '[]'::jsonb,
  ventilation_minutes INTEGER NOT NULL DEFAULT 0,
  sbt_trials_count INTEGER NOT NULL DEFAULT 0,
  scoring_outputs_count INTEGER NOT NULL DEFAULT 0,
  net_balance_ml INTEGER,
  summary_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  materialized_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_icu_daily_chart_summaries_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT uq_icu_daily_chart_summaries_day
    UNIQUE (tenant_id, icu_admission_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_icu_daily_chart_summaries_patient
  ON icu_daily_chart_summaries (tenant_id, patient_uid, summary_date DESC);

ALTER TABLE icu_daily_chart_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_daily_chart_summaries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_daily_chart_summaries;
CREATE POLICY tenant_isolation ON icu_daily_chart_summaries
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
