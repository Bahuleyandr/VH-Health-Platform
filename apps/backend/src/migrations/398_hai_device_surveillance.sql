-- 398_hai_device_surveillance.sql
--
-- N6-6 infection-control depth: device presence denominators and typed HAI
-- cases over infection_cases.

BEGIN;

CREATE TABLE IF NOT EXISTS device_presence_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  admission_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  device_type VARCHAR(40) NOT NULL,
  device_label VARCHAR(120),
  started_at TIMESTAMPTZ(6) NOT NULL,
  stopped_at TIMESTAMPTZ(6),
  inserted_by UUID,
  removed_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT device_presence_type_check
    CHECK (device_type IN ('urinary_catheter', 'central_line', 'ventilator')),
  CONSTRAINT device_presence_time_check
    CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  CONSTRAINT fk_device_presence_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_device_presence_admission
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE CASCADE,
  CONSTRAINT fk_device_presence_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS hai_cases (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  infection_case_id INTEGER NOT NULL,
  admission_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  hai_type VARCHAR(20) NOT NULL,
  device_type VARCHAR(40),
  onset_date DATE NOT NULL,
  numerator_count INTEGER NOT NULL DEFAULT 1,
  denominator_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributed_by UUID NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT hai_cases_type_check
    CHECK (hai_type IN ('CAUTI', 'CLABSI', 'VAP', 'SSI', 'OTHER')),
  CONSTRAINT hai_cases_device_check
    CHECK (device_type IS NULL OR device_type IN ('urinary_catheter', 'central_line', 'ventilator')),
  CONSTRAINT uq_hai_case_type
    UNIQUE (tenant_id, infection_case_id, hai_type),
  CONSTRAINT fk_hai_cases_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_hai_cases_infection_case
    FOREIGN KEY (infection_case_id) REFERENCES infection_cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_hai_cases_admission
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE CASCADE,
  CONSTRAINT fk_hai_cases_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_device_presence_period
  ON device_presence_logs (tenant_id, device_type, started_at, stopped_at);

CREATE INDEX IF NOT EXISTS idx_device_presence_admission
  ON device_presence_logs (tenant_id, admission_id, device_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_hai_cases_period
  ON hai_cases (tenant_id, hai_type, onset_date DESC);

CREATE INDEX IF NOT EXISTS idx_hai_cases_patient
  ON hai_cases (tenant_id, patient_uid, onset_date DESC);

ALTER TABLE device_presence_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_presence_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON device_presence_logs;
CREATE POLICY tenant_isolation ON device_presence_logs
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

ALTER TABLE hai_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE hai_cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hai_cases;
CREATE POLICY tenant_isolation ON hai_cases
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
