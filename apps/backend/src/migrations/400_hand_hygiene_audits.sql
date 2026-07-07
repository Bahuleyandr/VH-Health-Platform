-- 400_hand_hygiene_audits.sql
--
-- N6-6 infection-control depth: hand-hygiene observation sessions, moments,
-- and compliance percentage capture.

BEGIN;

CREATE TABLE IF NOT EXISTS hand_hygiene_audits (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  audit_date DATE NOT NULL,
  ward VARCHAR(255),
  unit VARCHAR(120),
  session_label VARCHAR(160),
  observer_uid UUID NOT NULL,
  total_moments INTEGER NOT NULL DEFAULT 0,
  compliant_moments INTEGER NOT NULL DEFAULT 0,
  compliance_pct NUMERIC(5,2),
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT hand_hygiene_counts_check
    CHECK (total_moments >= 0 AND compliant_moments >= 0 AND compliant_moments <= total_moments),
  CONSTRAINT fk_hand_hygiene_audits_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS hand_hygiene_moments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  audit_id BIGINT NOT NULL,
  moment_code VARCHAR(60) NOT NULL,
  opportunity_count INTEGER NOT NULL DEFAULT 0,
  compliant_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT hand_hygiene_moment_counts_check
    CHECK (opportunity_count >= 0 AND compliant_count >= 0 AND compliant_count <= opportunity_count),
  CONSTRAINT uq_hand_hygiene_moment
    UNIQUE (tenant_id, audit_id, moment_code),
  CONSTRAINT fk_hand_hygiene_moments_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_hand_hygiene_moments_audit
    FOREIGN KEY (audit_id) REFERENCES hand_hygiene_audits(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hand_hygiene_audits_period
  ON hand_hygiene_audits (tenant_id, audit_date DESC, ward);

CREATE INDEX IF NOT EXISTS idx_hand_hygiene_moments_audit
  ON hand_hygiene_moments (tenant_id, audit_id);

ALTER TABLE hand_hygiene_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE hand_hygiene_audits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hand_hygiene_audits;
CREATE POLICY tenant_isolation ON hand_hygiene_audits
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

ALTER TABLE hand_hygiene_moments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hand_hygiene_moments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hand_hygiene_moments;
CREATE POLICY tenant_isolation ON hand_hygiene_moments
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
