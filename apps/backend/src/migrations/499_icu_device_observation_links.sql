-- NL-14 P1: ICU links to NL-7 governed device observations.
--
-- This table links ICU charting to already-persisted NL-7/vitals facts. It
-- never stores transport credentials, raw gateway frames, or bypass samples.

BEGIN;

CREATE TABLE IF NOT EXISTS icu_device_observation_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  link_kind VARCHAR(40) NOT NULL,
  vitals_chart_id INTEGER REFERENCES vitals_chart(id) ON DELETE CASCADE,
  sample_observation_id INTEGER REFERENCES device_vital_sample_observations(id) ON DELETE CASCADE,
  device_registry_id INTEGER REFERENCES device_registry(id) ON DELETE SET NULL,
  device_association_id INTEGER REFERENCES device_patient_associations(id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  linked_by UUID,
  context VARCHAR(80),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT icu_device_observation_link_kind_check
    CHECK (link_kind IN ('vitals_chart', 'sample_observation', 'device_association')),
  CONSTRAINT icu_device_observation_one_source_check CHECK (
    num_nonnulls(vitals_chart_id, sample_observation_id, device_association_id) = 1
  ),
  CONSTRAINT fk_icu_device_observation_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_icu_device_observation_vitals
  ON icu_device_observation_links (tenant_id, icu_admission_id, vitals_chart_id)
  WHERE vitals_chart_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_icu_device_observation_sample
  ON icu_device_observation_links (tenant_id, icu_admission_id, sample_observation_id)
  WHERE sample_observation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_icu_device_observation_admission
  ON icu_device_observation_links (tenant_id, icu_admission_id, linked_at DESC);

ALTER TABLE icu_device_observation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_device_observation_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_device_observation_links;
CREATE POLICY tenant_isolation ON icu_device_observation_links
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
