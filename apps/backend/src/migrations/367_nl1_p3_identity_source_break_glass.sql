-- 367_nl1_p3_identity_source_break_glass.sql
--
-- NL-1 P3 ownership model. Local CRUD remains available, but SCIM-managed
-- identities carry explicit source/provenance fields and named break-glass
-- accounts are excluded from SCIM deactivation.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS identity_source varchar(20) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS scim_external_id text,
  ADD COLUMN IF NOT EXISTS scim_provider_id bigint,
  ADD COLUMN IF NOT EXISTS scim_last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_break_glass_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS break_glass_name varchar(160),
  ADD COLUMN IF NOT EXISTS break_glass_reason text;

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS identity_source varchar(20) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS scim_external_id text,
  ADD COLUMN IF NOT EXISTS scim_provider_id bigint,
  ADD COLUMN IF NOT EXISTS scim_last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_break_glass_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS break_glass_name varchar(160),
  ADD COLUMN IF NOT EXISTS break_glass_reason text;

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS identity_source varchar(20) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS scim_external_id text,
  ADD COLUMN IF NOT EXISTS scim_provider_id bigint,
  ADD COLUMN IF NOT EXISTS scim_last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS pin_hash text;

ALTER TABLE staff_devices
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS biometric_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamp(6) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_identity_source_chk;
ALTER TABLE users
  ADD CONSTRAINT users_identity_source_chk
  CHECK (identity_source IN ('local', 'scim', 'hybrid'));

ALTER TABLE admins
  DROP CONSTRAINT IF EXISTS admins_identity_source_chk;
ALTER TABLE admins
  ADD CONSTRAINT admins_identity_source_chk
  CHECK (identity_source IN ('local', 'scim', 'hybrid'));

ALTER TABLE staff
  DROP CONSTRAINT IF EXISTS staff_identity_source_chk;
ALTER TABLE staff
  ADD CONSTRAINT staff_identity_source_chk
  CHECK (identity_source IN ('local', 'scim', 'hybrid'));

CREATE INDEX IF NOT EXISTS idx_users_scim_provider_external
  ON users (tenant_id, scim_provider_id, scim_external_id)
  WHERE scim_provider_id IS NOT NULL AND scim_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admins_scim_provider_external
  ON admins (tenant_id, scim_provider_id, scim_external_id)
  WHERE scim_provider_id IS NOT NULL AND scim_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_scim_provider_external
  ON staff (tenant_id, scim_provider_id, scim_external_id)
  WHERE scim_provider_id IS NOT NULL AND scim_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_break_glass_accounts
  ON users (tenant_id, is_break_glass_account)
  WHERE is_break_glass_account = true;

CREATE INDEX IF NOT EXISTS idx_admins_break_glass_accounts
  ON admins (tenant_id, is_break_glass_account)
  WHERE is_break_glass_account = true;

COMMIT;
