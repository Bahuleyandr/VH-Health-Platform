-- NL-13 P6: transplant programs plus inert per-tenant enablement settings.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transplant_organ_type') THEN
    CREATE TYPE transplant_organ_type AS ENUM (
      'heart',
      'liver',
      'lung',
      'kidney',
      'small_bowel',
      'multivisceral'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS transplant_program_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at TIMESTAMPTZ(6),
  enabled_by UUID,
  acceptance_snapshot JSONB,
  owner_evidence_reference TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE transplant_program_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_program_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_program_settings;
CREATE POLICY tenant_isolation ON transplant_program_settings
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

CREATE TABLE IF NOT EXISTS transplant_programs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  organ transplant_organ_type NOT NULL,
  service_line VARCHAR(120) NOT NULL,
  site VARCHAR(160) NOT NULL,
  program_owner_uid UUID,
  program_owner_role VARCHAR(80),
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  notto_evidence_owner_uid UUID,
  notto_evidence_owner_role VARCHAR(80),
  notto_evidence_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT transplant_programs_status_check
    CHECK (status IN ('draft', 'active', 'paused', 'retired')),
  CONSTRAINT fk_transplant_programs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_transplant_programs_organ_site
  ON transplant_programs (tenant_id, organ, lower(site));

CREATE INDEX IF NOT EXISTS idx_transplant_programs_status
  ON transplant_programs (tenant_id, status, organ);

ALTER TABLE transplant_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_programs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_programs;
CREATE POLICY tenant_isolation ON transplant_programs
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
