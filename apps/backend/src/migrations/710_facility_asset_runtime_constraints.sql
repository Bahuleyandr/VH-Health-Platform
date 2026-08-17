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

-- A retained 704 database could contain a cross-tenant, inactive, patient, or
-- role-less custodian because the original table had no relationship backstop.
-- Clear it before making the invariant durable, but preserve the same version
-- and append-only event guarantees as a runtime custody change.
WITH invalid_custody AS MATERIALIZED (
  SELECT asset.id,
         asset.tenant_id,
         asset.asset_tag,
         asset.name,
         asset.custodian_uid
    FROM facility_assets AS asset
   WHERE asset.custodian_uid IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM users AS custodian
        WHERE custodian.tenant_id = asset.tenant_id
          AND custodian.uid = asset.custodian_uid
          AND custodian.is_active IS TRUE
          AND custodian.role <> 'PATIENT'
     )
   FOR UPDATE
), cleared AS (
  UPDATE facility_assets AS asset
     SET custodian_uid = NULL,
         version = asset.version + 1,
         updated_at = NOW()
    FROM invalid_custody AS invalid
   WHERE asset.id = invalid.id
     AND asset.tenant_id = invalid.tenant_id
  RETURNING asset.id, asset.tenant_id, asset.asset_tag, asset.name
)
INSERT INTO facility_asset_events (
  tenant_id, asset_id, asset_tag_snapshot, asset_name_snapshot,
  event_type, details, notes
)
SELECT cleared.tenant_id,
       cleared.id,
       cleared.asset_tag,
       cleared.name,
       'custodian_assigned',
       jsonb_build_object(
         'from_custodian_uid', invalid.custodian_uid,
         'to_custodian_uid', NULL,
         'reason', 'migration_710_ineligible_custodian'
       ),
       'Custody cleared by migration 710 because the retained custodian was ineligible'
  FROM cleared
  JOIN invalid_custody AS invalid
    ON invalid.id = cleared.id AND invalid.tenant_id = cleared.tenant_id;

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

-- The composite FK proves tenant ownership but cannot express the runtime
-- eligibility rule. Keep the database boundary aligned with the service:
-- assignments to PATIENT or inactive users are rejected, while a later user
-- deactivation/role change clears custody without deleting the asset.
CREATE OR REPLACE FUNCTION facility_asset_validate_custodian()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.custodian_uid IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM users AS custodian
        WHERE custodian.tenant_id = NEW.tenant_id
          AND custodian.uid = NEW.custodian_uid
          AND custodian.is_active IS TRUE
          AND custodian.role <> 'PATIENT'
     ) THEN
    RAISE EXCEPTION
      'facility asset custodian must be an active non-patient user in the asset tenant'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_facility_asset_custodian_eligible';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_facility_asset_validate_custodian ON facility_assets;
CREATE TRIGGER trg_facility_asset_validate_custodian
BEFORE INSERT OR UPDATE OF tenant_id, custodian_uid
ON facility_assets
FOR EACH ROW
EXECUTE FUNCTION facility_asset_validate_custodian();

CREATE OR REPLACE FUNCTION facility_asset_clear_ineligible_custody()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  clear_reason TEXT;
  next_role TEXT;
  next_active BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    clear_reason := 'custodian_deleted';
    next_role := OLD.role;
    next_active := FALSE;
  ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.is_active IS NOT TRUE
        OR NEW.role IS NULL
        OR NEW.role = 'PATIENT' THEN
    clear_reason := 'custodian_became_ineligible';
    next_role := NEW.role;
    next_active := NEW.is_active;
  END IF;

  IF clear_reason IS NOT NULL THEN
    WITH cleared AS (
      UPDATE facility_assets
         SET custodian_uid = NULL,
             version = version + 1,
             updated_at = NOW()
       WHERE tenant_id = OLD.tenant_id
         AND custodian_uid = OLD.uid
      RETURNING id, tenant_id, asset_tag, name
    )
    INSERT INTO facility_asset_events (
      tenant_id, asset_id, asset_tag_snapshot, asset_name_snapshot,
      event_type, details, notes
    )
    SELECT tenant_id,
           id,
           asset_tag,
           name,
           'custodian_assigned',
           jsonb_build_object(
             'from_custodian_uid', OLD.uid,
             'to_custodian_uid', NULL,
             'reason', clear_reason,
             'custodian_role', next_role,
             'custodian_active', next_active
           ),
           'Custody cleared automatically because the custodian became ineligible'
      FROM cleared;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_facility_asset_clear_ineligible_custody ON users;
CREATE TRIGGER trg_facility_asset_clear_ineligible_custody
BEFORE UPDATE OF tenant_id, role, is_active
ON users
FOR EACH ROW
WHEN (
  OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
  OR OLD.role IS DISTINCT FROM NEW.role
  OR OLD.is_active IS DISTINCT FROM NEW.is_active
)
EXECUTE FUNCTION facility_asset_clear_ineligible_custody();

DROP TRIGGER IF EXISTS trg_facility_asset_clear_deleted_custody ON users;
CREATE TRIGGER trg_facility_asset_clear_deleted_custody
BEFORE DELETE
ON users
FOR EACH ROW
EXECUTE FUNCTION facility_asset_clear_ineligible_custody();

COMMENT ON COLUMN facility_assets.version IS
  'Optimistic-concurrency token for full-form edits and lifecycle transitions.';
COMMENT ON CONSTRAINT fk_facility_assets_custodian ON facility_assets IS
  'Tenant-safe current custodian. Deleting the user clears custodian_uid while preserving the asset tenant.';
COMMENT ON FUNCTION facility_asset_validate_custodian() IS
  'Rejects facility asset custody assigned to a patient, inactive user, or user outside the asset tenant.';
COMMENT ON FUNCTION facility_asset_clear_ineligible_custody() IS
  'Clears facility asset custody with version and event evidence when the referenced user is deleted, becomes inactive or role-less, becomes a patient, or changes tenant.';

COMMIT;
