-- NL-6 N6-2 BB-A: donor screening questionnaire and deferral register.

BEGIN;

CREATE TABLE IF NOT EXISTS donor_screenings (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  donor_id INTEGER NOT NULL,
  screening_date TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  questionnaire JSONB NOT NULL DEFAULT '{}'::jsonb,
  vitals JSONB NOT NULL DEFAULT '{}'::jsonb,
  weight_kg NUMERIC(5,2),
  hemoglobin_g_dl NUMERIC(4,1),
  systolic_bp INTEGER,
  diastolic_bp INTEGER,
  pulse_per_min INTEGER,
  temperature_c NUMERIC(4,1),
  verdict VARCHAR(30) NOT NULL,
  verdict_reason TEXT,
  deferral_reason_code VARCHAR(60),
  deferral_until DATE,
  permanent_deferral BOOLEAN NOT NULL DEFAULT false,
  screened_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_donor_screenings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_donor_screenings_donor
    FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE,
  CONSTRAINT chk_donor_screenings_verdict
    CHECK (verdict IN ('eligible', 'deferred_temporary', 'deferred_permanent', 'requires_review'))
);

CREATE TABLE IF NOT EXISTS donor_deferrals (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  donor_id INTEGER NOT NULL,
  screening_id INTEGER,
  reason_code VARCHAR(60) NOT NULL,
  reason_text TEXT NOT NULL,
  deferred_until DATE,
  permanent BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  source VARCHAR(20) NOT NULL DEFAULT 'auto',
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  reactivated_at TIMESTAMPTZ(6),
  reactivated_by UUID,
  reactivation_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_donor_deferrals_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_donor_deferrals_donor
    FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE,
  CONSTRAINT fk_donor_deferrals_screening
    FOREIGN KEY (screening_id) REFERENCES donor_screenings(id) ON DELETE SET NULL,
  CONSTRAINT chk_donor_deferrals_status
    CHECK (status IN ('active', 'reactivated', 'expired')),
  CONSTRAINT chk_donor_deferrals_source
    CHECK (source IN ('auto', 'manual', 'tti'))
);

CREATE INDEX IF NOT EXISTS idx_donor_screenings_donor_time
  ON donor_screenings (tenant_id, donor_id, screening_date DESC);

CREATE INDEX IF NOT EXISTS idx_donor_screenings_verdict
  ON donor_screenings (tenant_id, verdict, screening_date DESC);

CREATE INDEX IF NOT EXISTS idx_donor_deferrals_active
  ON donor_deferrals (tenant_id, status, permanent, deferred_until)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_donor_deferrals_donor_time
  ON donor_deferrals (tenant_id, donor_id, created_at DESC);

ALTER TABLE donor_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE donor_screenings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON donor_screenings;
CREATE POLICY tenant_isolation ON donor_screenings
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

ALTER TABLE donor_deferrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE donor_deferrals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON donor_deferrals;
CREATE POLICY tenant_isolation ON donor_deferrals
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
