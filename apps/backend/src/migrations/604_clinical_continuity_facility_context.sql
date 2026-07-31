-- Clinical Service Continuity C4: device and session facility context.
--
-- @no-transaction
--
-- This migration is additive and inert. It creates no capture grant,
-- enrollment, context, policy, key, activation, or owner decision. Existing
-- C3.2 edge rows are classified as edge_read without changing their canonical
-- export content or edge authorization semantics.

SET lock_timeout = '10s';
SET statement_timeout = '60s';

CREATE SEQUENCE IF NOT EXISTS clinical_continuity_capture_revision_seq
  AS BIGINT
  MINVALUE 1
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

CREATE SEQUENCE IF NOT EXISTS clinical_continuity_context_revision_seq
  AS BIGINT
  MINVALUE 1
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

ALTER TABLE clinical_continuity_edge_access_grants
  ADD COLUMN IF NOT EXISTS grant_purpose VARCHAR(32) NOT NULL DEFAULT 'edge_read',
  ADD COLUMN IF NOT EXISTS subject_kind VARCHAR(32) NOT NULL DEFAULT 'staff_device',
  ADD COLUMN IF NOT EXISTS device_public_key_raw BYTEA,
  ADD COLUMN IF NOT EXISTS device_credential_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS capture_revision BIGINT;

ALTER TABLE clinical_continuity_edge_access_grants
  ALTER COLUMN location_type DROP NOT NULL,
  ALTER COLUMN location_identifier DROP NOT NULL,
  ALTER COLUMN staff_uid DROP NOT NULL,
  ALTER COLUMN client_certificate_sha256 DROP NOT NULL,
  ALTER COLUMN access_revision DROP NOT NULL;

ALTER TABLE clinical_continuity_edge_access_revocations
  ADD COLUMN IF NOT EXISTS grant_purpose VARCHAR(32) NOT NULL DEFAULT 'edge_read',
  ADD COLUMN IF NOT EXISTS capture_revision BIGINT;

ALTER TABLE clinical_continuity_edge_access_revocations
  ALTER COLUMN access_revision DROP NOT NULL;

ALTER TABLE clinical_continuity_edge_log_receipts
  ADD COLUMN IF NOT EXISTS grant_purpose VARCHAR(32) NOT NULL DEFAULT 'edge_read';

DO $cc_facility_purpose_constraints$
BEGIN
  ALTER TABLE clinical_continuity_edge_access_grants
    DROP CONSTRAINT IF EXISTS cc_edge_grant_access_revision_check;
  ALTER TABLE clinical_continuity_edge_access_grants
    DROP CONSTRAINT IF EXISTS cc_edge_grant_location_identifier_check;
  ALTER TABLE clinical_continuity_edge_access_grants
    DROP CONSTRAINT IF EXISTS cc_facility_grant_purpose_check;
  ALTER TABLE clinical_continuity_edge_access_grants
    DROP CONSTRAINT IF EXISTS cc_facility_grant_subject_kind_check;
  ALTER TABLE clinical_continuity_edge_access_grants
    DROP CONSTRAINT IF EXISTS cc_facility_grant_purpose_shape_check;

  ALTER TABLE clinical_continuity_edge_access_grants
    ADD CONSTRAINT cc_facility_grant_purpose_check
      CHECK (
        grant_purpose IN (
          'edge_read',
          'capture_fixed_device',
          'capture_staff_facility'
        )
      ),
    ADD CONSTRAINT cc_facility_grant_subject_kind_check
      CHECK (subject_kind IN ('device', 'staff_device')),
    ADD CONSTRAINT cc_edge_grant_location_identifier_check
      CHECK (
        location_identifier IS NULL
        OR (
          NULLIF(BTRIM(location_identifier), '') IS NOT NULL
          AND location_identifier !~ '[/\\]'
          AND location_identifier NOT IN ('.', '..')
        )
      ),
    ADD CONSTRAINT cc_facility_grant_purpose_shape_check
      CHECK (
        (
          grant_purpose = 'edge_read'
          AND subject_kind = 'staff_device'
          AND location_type IS NOT NULL
          AND location_identifier IS NOT NULL
          AND staff_uid IS NOT NULL
          AND client_certificate_sha256 IS NOT NULL
          AND client_certificate_sha256 ~ '^[0-9a-f]{64}$'
          AND device_public_key_raw IS NULL
          AND device_credential_sha256 IS NULL
          AND access_revision IS NOT NULL
          AND access_revision > 0
          AND capture_revision IS NULL
        )
        OR
        (
          grant_purpose = 'capture_fixed_device'
          AND subject_kind = 'device'
          AND location_type IS NULL
          AND location_identifier IS NULL
          AND staff_uid IS NULL
          AND client_certificate_sha256 IS NULL
          AND device_public_key_raw IS NOT NULL
          AND OCTET_LENGTH(device_public_key_raw) = 32
          AND device_credential_sha256 IS NOT NULL
          AND device_credential_sha256 ~ '^[0-9a-f]{64}$'
          AND device_credential_sha256 =
                encode(digest(device_public_key_raw, 'sha256'), 'hex')
          AND access_revision IS NULL
          AND capture_revision IS NOT NULL
          AND capture_revision > 0
        )
        OR
        (
          grant_purpose = 'capture_staff_facility'
          AND subject_kind = 'staff_device'
          AND location_type IS NULL
          AND location_identifier IS NULL
          AND staff_uid IS NOT NULL
          AND client_certificate_sha256 IS NULL
          AND device_public_key_raw IS NOT NULL
          AND OCTET_LENGTH(device_public_key_raw) = 32
          AND device_credential_sha256 IS NOT NULL
          AND device_credential_sha256 ~ '^[0-9a-f]{64}$'
          AND device_credential_sha256 =
                encode(digest(device_public_key_raw, 'sha256'), 'hex')
          AND access_revision IS NULL
          AND capture_revision IS NOT NULL
          AND capture_revision > 0
        )
      );

  ALTER TABLE clinical_continuity_edge_access_revocations
    DROP CONSTRAINT IF EXISTS cc_edge_revocation_access_revision_check;
  ALTER TABLE clinical_continuity_edge_access_revocations
    DROP CONSTRAINT IF EXISTS cc_facility_revocation_purpose_check;
  ALTER TABLE clinical_continuity_edge_access_revocations
    DROP CONSTRAINT IF EXISTS cc_facility_revocation_revision_shape_check;

  ALTER TABLE clinical_continuity_edge_access_revocations
    ADD CONSTRAINT cc_facility_revocation_purpose_check
      CHECK (
        grant_purpose IN (
          'edge_read',
          'capture_fixed_device',
          'capture_staff_facility'
        )
      ),
    ADD CONSTRAINT cc_facility_revocation_revision_shape_check
      CHECK (
        (
          grant_purpose = 'edge_read'
          AND access_revision IS NOT NULL
          AND access_revision > 0
          AND capture_revision IS NULL
        )
        OR
        (
          grant_purpose IN (
            'capture_fixed_device',
            'capture_staff_facility'
          )
          AND access_revision IS NULL
          AND capture_revision IS NOT NULL
          AND capture_revision > 0
        )
      );

  ALTER TABLE clinical_continuity_edge_log_receipts
    DROP CONSTRAINT IF EXISTS cc_facility_receipt_edge_only_check;
  ALTER TABLE clinical_continuity_edge_log_receipts
    ADD CONSTRAINT cc_facility_receipt_edge_only_check
      CHECK (grant_purpose = 'edge_read');
END
$cc_facility_purpose_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_grant_tenant_facility_id_purpose
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, id, grant_purpose
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_grant_capture_revision
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, capture_revision
  )
  WHERE capture_revision IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cc_grant_capture_device
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, grant_purpose, device_id, capture_revision
  )
  WHERE grant_purpose <> 'edge_read';

CREATE INDEX IF NOT EXISTS idx_cc_grant_capture_staff
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, staff_uid, device_id, capture_revision
  )
  WHERE grant_purpose = 'capture_staff_facility';

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_revocation_capture_revision
  ON clinical_continuity_edge_access_revocations (
    tenant_id, facility_id, capture_revision
  )
  WHERE capture_revision IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_revocation_grant_purpose
  ON clinical_continuity_edge_access_revocations (
    tenant_id, facility_id, grant_id, grant_purpose
  );

CREATE INDEX IF NOT EXISTS idx_cc_revocation_capture_grant
  ON clinical_continuity_edge_access_revocations (
    tenant_id, facility_id, grant_purpose, grant_id, capture_revision
  )
  WHERE grant_purpose <> 'edge_read';

DO $cc_facility_purpose_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_revocations'::regclass
       AND conname = 'cc_edge_revocation_grant_purpose_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_revocations
      ADD CONSTRAINT cc_edge_revocation_grant_purpose_fk
      FOREIGN KEY (
        tenant_id, facility_id, grant_id, grant_purpose
      )
      REFERENCES clinical_continuity_edge_access_grants (
        tenant_id, facility_id, id, grant_purpose
      )
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_log_receipts'::regclass
       AND conname = 'cc_edge_receipt_grant_purpose_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_log_receipts
      ADD CONSTRAINT cc_edge_receipt_grant_purpose_fk
      FOREIGN KEY (
        tenant_id, facility_id, grant_id, grant_purpose
      )
      REFERENCES clinical_continuity_edge_access_grants (
        tenant_id, facility_id, id, grant_purpose
      )
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;
END
$cc_facility_purpose_fks$;

CREATE OR REPLACE FUNCTION clinical_continuity_fixed_device_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.grant_purpose <> 'capture_fixed_device' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.tenant_id::text || ':' || NEW.device_id, 0)
  );

  IF EXISTS (
    SELECT 1
      FROM clinical_continuity_edge_access_grants AS existing
      LEFT JOIN clinical_continuity_edge_access_revocations AS revocation
        ON revocation.tenant_id = existing.tenant_id
       AND revocation.facility_id = existing.facility_id
       AND revocation.grant_id = existing.id
       AND revocation.grant_purpose = existing.grant_purpose
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.device_id = NEW.device_id
       AND existing.grant_purpose = 'capture_fixed_device'
       AND existing.id <> NEW.id
       AND revocation.id IS NULL
       AND tstzrange(
             existing.valid_from,
             existing.valid_until,
             '[)'
           ) && tstzrange(NEW.valid_from, NEW.valid_until, '[)')
  ) THEN
    RAISE EXCEPTION
      'a fixed continuity device cannot have overlapping active facility grants'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DO $cc_facility_overlap_trigger$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_fixed_device_no_overlap
             ON clinical_continuity_edge_access_grants';
  EXECUTE $trigger$
    CREATE CONSTRAINT TRIGGER trg_cc_fixed_device_no_overlap
      AFTER INSERT
      ON clinical_continuity_edge_access_grants
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION clinical_continuity_fixed_device_no_overlap()
  $trigger$;
END
$cc_facility_overlap_trigger$;

ALTER TABLE user_devices
  ADD COLUMN IF NOT EXISTS facility_id INTEGER,
  ADD COLUMN IF NOT EXISTS continuity_grant_id UUID,
  ADD COLUMN IF NOT EXISTS continuity_grant_purpose VARCHAR(32),
  ADD COLUMN IF NOT EXISTS continuity_capture_revision BIGINT,
  ADD COLUMN IF NOT EXISTS continuity_context_id UUID,
  ADD COLUMN IF NOT EXISTS continuity_context_revision BIGINT,
  ADD COLUMN IF NOT EXISTS continuity_session_jti_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS continuity_issued_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS continuity_expires_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS continuity_validated_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS continuity_validation_state VARCHAR(32);

DO $cc_facility_user_device_indexes$
BEGIN
  ALTER TABLE user_devices
    DROP CONSTRAINT IF EXISTS user_devices_user_uid_device_id_key;
  DROP INDEX IF EXISTS user_devices_user_uid_device_id_key;
END
$cc_facility_user_device_indexes$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_devices_tenant_user_device
  ON user_devices (tenant_id, user_uid, device_id);

CREATE INDEX IF NOT EXISTS idx_user_devices_continuity_context
  ON user_devices (
    tenant_id, facility_id, continuity_context_id,
    continuity_context_revision
  )
  WHERE continuity_context_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_devices_continuity_grant
  ON user_devices (
    tenant_id, facility_id, continuity_grant_id,
    continuity_capture_revision
  )
  WHERE continuity_grant_id IS NOT NULL;

DO $cc_facility_user_device_constraints$
BEGIN
  ALTER TABLE user_devices
    DROP CONSTRAINT IF EXISTS cc_user_device_continuity_projection_check;
  ALTER TABLE user_devices
    ADD CONSTRAINT cc_user_device_continuity_projection_check
      CHECK (
        (
          facility_id IS NULL
          AND continuity_grant_id IS NULL
          AND continuity_grant_purpose IS NULL
          AND continuity_capture_revision IS NULL
          AND continuity_context_id IS NULL
          AND continuity_context_revision IS NULL
          AND continuity_session_jti_sha256 IS NULL
          AND continuity_issued_at IS NULL
          AND continuity_expires_at IS NULL
          AND continuity_validated_at IS NULL
          AND continuity_validation_state IS NULL
        )
        OR
        (
          tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid
          AND facility_id IS NOT NULL
          AND continuity_grant_id IS NOT NULL
          AND continuity_grant_purpose IN (
            'capture_fixed_device',
            'capture_staff_facility'
          )
          AND continuity_capture_revision > 0
          AND continuity_context_id IS NOT NULL
          AND continuity_context_revision > 0
          AND continuity_session_jti_sha256 ~ '^[0-9a-f]{64}$'
          AND continuity_issued_at IS NOT NULL
          AND continuity_expires_at > continuity_issued_at
          AND continuity_validated_at >= continuity_issued_at
          AND continuity_validation_state IN (
            'active',
            'expired',
            'revoked',
            'invalid'
          )
        )
      );
END
$cc_facility_user_device_constraints$;

DO $cc_facility_user_device_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_devices'::regclass
       AND conname = 'cc_user_devices_user_tenant_fk'
  ) THEN
    ALTER TABLE user_devices
      ADD CONSTRAINT cc_user_devices_user_tenant_fk
      FOREIGN KEY (tenant_id, user_uid)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_devices'::regclass
       AND conname = 'cc_user_devices_facility_tenant_fk'
  ) THEN
    ALTER TABLE user_devices
      ADD CONSTRAINT cc_user_devices_facility_tenant_fk
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_devices'::regclass
       AND conname = 'cc_user_devices_grant_tenant_fk'
  ) THEN
    ALTER TABLE user_devices
      ADD CONSTRAINT cc_user_devices_grant_tenant_fk
      FOREIGN KEY (
        tenant_id, facility_id, continuity_grant_id,
        continuity_grant_purpose
      )
      REFERENCES clinical_continuity_edge_access_grants (
        tenant_id, facility_id, id, grant_purpose
      )
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;
END
$cc_facility_user_device_fks$;

ALTER TABLE staff_devices
  ADD COLUMN IF NOT EXISTS user_uid UUID;

UPDATE staff_devices AS device
   SET user_uid = app_user.uid
  FROM users AS app_user
 WHERE device.user_uid IS NULL
   AND device.staff_id = app_user.id
   AND device.tenant_id = app_user.tenant_id;

INSERT INTO user_devices (
  tenant_id,
  user_uid,
  device_id,
  device_name,
  last_active,
  created_at,
  updated_at,
  device_type
)
SELECT device.tenant_id,
       device.user_uid,
       device.device_id,
       device.device_name,
       device.last_used,
       device.created_at,
       COALESCE(device.last_used, device.created_at),
       'staff'
  FROM staff_devices AS device
 WHERE device.user_uid IS NOT NULL
ON CONFLICT DO NOTHING;

DO $cc_facility_staff_device_link$
BEGIN
  ALTER TABLE staff_devices
    DROP CONSTRAINT IF EXISTS cc_staff_device_user_shape_check;
  ALTER TABLE staff_devices
    ADD CONSTRAINT cc_staff_device_user_shape_check
      CHECK (
        (staff_id IS NULL AND user_uid IS NULL)
        OR
        (staff_id IS NOT NULL AND user_uid IS NOT NULL)
      );

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'staff_devices'::regclass
       AND conname = 'cc_staff_device_user_tenant_fk'
  ) THEN
    ALTER TABLE staff_devices
      ADD CONSTRAINT cc_staff_device_user_tenant_fk
      FOREIGN KEY (tenant_id, user_uid)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'staff_devices'::regclass
       AND conname = 'cc_staff_device_projection_fk'
  ) THEN
    ALTER TABLE staff_devices
      ADD CONSTRAINT cc_staff_device_projection_fk
      FOREIGN KEY (tenant_id, user_uid, device_id)
      REFERENCES user_devices (tenant_id, user_uid, device_id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;
END
$cc_facility_staff_device_link$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_devices_tenant_user_device
  ON staff_devices (tenant_id, user_uid, device_id);

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices FORCE ROW LEVEL SECURITY;

DO $cc_facility_user_device_rls$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS cc_user_devices_explicit_context
             ON user_devices';
  EXECUTE $policy$
    CREATE POLICY cc_user_devices_explicit_context
      ON user_devices
      AS RESTRICTIVE
      FOR ALL
      USING (tenant_id = app_current_tenant_id_uuid())
      WITH CHECK (tenant_id = app_current_tenant_id_uuid())
  $policy$;
END
$cc_facility_user_device_rls$;

REVOKE ALL PRIVILEGES
  ON SEQUENCE clinical_continuity_capture_revision_seq
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON SEQUENCE clinical_continuity_context_revision_seq
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_fixed_device_no_overlap()
  FROM PUBLIC;

-- Runtime roles remain unable to issue capture grants while C-D14 is open.
-- Their migration-601 edge insert columns and edge sequence privileges are
-- unchanged; capture columns and the capture revision sequence are not
-- granted here. A later owner-cleared activation slice must grant them
-- explicitly.
DO $cc_facility_runtime_capture_lock$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE INSERT (
           grant_purpose, subject_kind, device_public_key_raw,
           device_credential_sha256, capture_revision
         ) ON clinical_continuity_edge_access_grants FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE INSERT (
           grant_purpose, capture_revision
         ) ON clinical_continuity_edge_access_revocations FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES
           ON SEQUENCE clinical_continuity_capture_revision_seq
           FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES
           ON SEQUENCE clinical_continuity_context_revision_seq
           FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES
           ON FUNCTION clinical_continuity_fixed_device_no_overlap()
           FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$cc_facility_runtime_capture_lock$;

RESET lock_timeout;
RESET statement_timeout;
