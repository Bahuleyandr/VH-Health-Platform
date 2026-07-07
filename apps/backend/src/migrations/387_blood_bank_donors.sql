-- NL-6 N6-2 BB-A: donor registry foundation.

BEGIN;

CREATE TABLE IF NOT EXISTS donors (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  donor_uid UUID NOT NULL DEFAULT gen_random_uuid(),
  full_name VARCHAR(160) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  gender VARCHAR(20),
  date_of_birth DATE,
  age_years INTEGER,
  address TEXT,
  government_id_type VARCHAR(40),
  government_id_ref VARCHAR(120),
  abo_group VARCHAR(2),
  rh_factor VARCHAR(8),
  blood_group VARCHAR(5),
  status VARCHAR(30) NOT NULL DEFAULT 'registered',
  eligibility_status VARCHAR(30) NOT NULL DEFAULT 'not_screened',
  last_screened_at TIMESTAMPTZ(6),
  last_donated_at TIMESTAMPTZ(6),
  duplicate_override_reason TEXT,
  duplicate_reviewed_by UUID,
  registered_by UUID,
  registered_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_donors_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT ux_donors_tenant_uid UNIQUE (tenant_id, donor_uid),
  CONSTRAINT chk_donors_abo_group
    CHECK (abo_group IS NULL OR abo_group IN ('A', 'B', 'AB', 'O')),
  CONSTRAINT chk_donors_rh_factor
    CHECK (rh_factor IS NULL OR rh_factor IN ('positive', 'negative')),
  CONSTRAINT chk_donors_blood_group
    CHECK (blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  CONSTRAINT chk_donors_status
    CHECK (status IN ('registered', 'active', 'deferred_temporary', 'deferred_permanent', 'inactive')),
  CONSTRAINT chk_donors_eligibility
    CHECK (eligibility_status IN ('not_screened', 'eligible', 'deferred_temporary', 'deferred_permanent', 'reactivated', 'collected'))
);

CREATE INDEX IF NOT EXISTS idx_donors_tenant_status
  ON donors (tenant_id, status, eligibility_status, registered_at DESC);

CREATE INDEX IF NOT EXISTS idx_donors_tenant_phone
  ON donors (tenant_id, phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_donors_tenant_name_dob
  ON donors (tenant_id, full_name, date_of_birth)
  WHERE date_of_birth IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_donors_tenant_government_ref
  ON donors (tenant_id, government_id_type, government_id_ref)
  WHERE government_id_ref IS NOT NULL;

ALTER TABLE donors ENABLE ROW LEVEL SECURITY;
ALTER TABLE donors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON donors;
CREATE POLICY tenant_isolation ON donors
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'BLOOD_BANK_DONORS_REGISTRY_APPLIED',
  'donors',
  '387_blood_bank_donors.sql',
  jsonb_build_object(
    'program', 'NL-6 N6-2',
    'scope', 'BB-A donor registry with tenant RLS and duplicate-review fields'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'BLOOD_BANK_DONORS_REGISTRY_APPLIED'
    AND resource_id = '387_blood_bank_donors.sql'
);

COMMIT;
