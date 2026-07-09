-- Migration 461: NL11-S8 SMART app registration policy.
-- Sandbox apps can be tenant-admin initiated; production activation records
-- platform super-admin approval and a signed integration contract reference.

BEGIN;

ALTER TABLE smart_apps
  ADD COLUMN IF NOT EXISTS registration_status VARCHAR(30) NOT NULL DEFAULT 'sandbox_approved',
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS production_contract_ref TEXT,
  ADD COLUMN IF NOT EXISTS approval_notes TEXT;

ALTER TABLE smart_apps
  DROP CONSTRAINT IF EXISTS smart_apps_registration_status_chk;

ALTER TABLE smart_apps
  ADD CONSTRAINT smart_apps_registration_status_chk
  CHECK (registration_status IN (
    'sandbox_pending',
    'sandbox_approved',
    'production_pending',
    'production_approved',
    'rejected'
  ));

CREATE INDEX IF NOT EXISTS idx_smart_apps_registration_policy
  ON smart_apps (tenant_id, environment, registration_status, status);

CREATE INDEX IF NOT EXISTS idx_smart_apps_production_contract
  ON smart_apps (tenant_id, production_contract_ref)
  WHERE production_contract_ref IS NOT NULL;

COMMIT;
