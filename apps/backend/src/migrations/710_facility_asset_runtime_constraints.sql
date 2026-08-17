-- Additive upgrade for the published 704 facility-asset schema.
--
-- Migration 704 was already tracked before optimistic concurrency and the
-- tenant-safe custodian relationship became runtime requirements. Never add
-- those requirements to 704: retained databases skip a recorded migration.
-- This migration converges both retained and fresh databases on the schema
-- expected by facilityAssetService.

BEGIN;

ALTER TABLE facility_assets
  ADD COLUMN IF NOT EXISTS version INTEGER;

UPDATE facility_assets
   SET version = 1
 WHERE version IS NULL OR version < 1;

ALTER TABLE facility_assets
  ALTER COLUMN version SET DEFAULT 1,
  ALTER COLUMN version SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'facility_assets'::regclass
       AND conname = 'chk_facility_asset_version'
  ) THEN
    ALTER TABLE facility_assets
      ADD CONSTRAINT chk_facility_asset_version
      CHECK (version > 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE facility_assets
  VALIDATE CONSTRAINT chk_facility_asset_version;

-- A retained 704 database could contain a custodian UID from another tenant
-- because the original table had no relationship backstop. Such a reference
-- is not valid custody evidence; clear it before making the invariant durable.
UPDATE facility_assets AS asset
   SET custodian_uid = NULL,
       updated_at = NOW()
 WHERE asset.custodian_uid IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM users AS custodian
      WHERE custodian.tenant_id = asset.tenant_id
        AND custodian.uid = asset.custodian_uid
   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'facility_assets'::regclass
       AND conname = 'fk_facility_assets_custodian'
  ) THEN
    ALTER TABLE facility_assets
      ADD CONSTRAINT fk_facility_assets_custodian
      FOREIGN KEY (tenant_id, custodian_uid)
      REFERENCES users (tenant_id, uid)
      ON DELETE SET NULL (custodian_uid)
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE facility_assets
  VALIDATE CONSTRAINT fk_facility_assets_custodian;

COMMENT ON COLUMN facility_assets.version IS
  'Optimistic-concurrency token for full-form edits and lifecycle transitions.';
COMMENT ON CONSTRAINT fk_facility_assets_custodian ON facility_assets IS
  'Tenant-safe current custodian. Deleting the user clears custodian_uid while preserving the asset tenant.';

COMMIT;
