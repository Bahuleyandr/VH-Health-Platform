-- Clinical Service Continuity C3.2a: edge access and recovered-log receipts.
--
-- @no-transaction
--
-- This migration is additive and inert. It does not seed a policy, grant,
-- revocation, receipt, credential, or activation row. Statements are guarded
-- because the boot runner commits no-transaction migrations statement by
-- statement while ci-setup-db can wrap the same file.

SET lock_timeout = '10s';
SET statement_timeout = '60s';

CREATE SEQUENCE IF NOT EXISTS clinical_continuity_edge_access_revision_seq
  AS BIGINT
  MINVALUE 1
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

DO $cc_edge_tables$
BEGIN
  EXECUTE $table$
    CREATE TABLE IF NOT EXISTS clinical_continuity_edge_access_grants (
      id                              UUID NOT NULL DEFAULT gen_random_uuid(),
      tenant_id                       UUID NOT NULL,
      facility_id                     INTEGER NOT NULL,
      location_type                   VARCHAR(32) NOT NULL,
      location_identifier             VARCHAR(160) NOT NULL,
      staff_uid                       UUID NOT NULL,
      device_id                       VARCHAR(160) NOT NULL,
      client_certificate_sha256       CHAR(64) NOT NULL,
      valid_from                      TIMESTAMPTZ(6) NOT NULL,
      valid_until                     TIMESTAMPTZ(6) NOT NULL,
      policy_version_id               UUID NOT NULL,
      policy_version                  BIGINT NOT NULL,
      access_revision                 BIGINT NOT NULL
        DEFAULT nextval('clinical_continuity_edge_access_revision_seq'),
      created_by                      UUID NOT NULL,
      created_at                      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

      CONSTRAINT clinical_continuity_edge_access_grants_pkey
        PRIMARY KEY (tenant_id, facility_id, id),
      CONSTRAINT cc_edge_grant_no_default_tenant_check
        CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
      CONSTRAINT cc_edge_grant_location_type_check
        CHECK (location_type IN ('ward', 'paeds', 'ed_board', 'opd_day')),
      CONSTRAINT cc_edge_grant_location_identifier_check
        CHECK (
          NULLIF(BTRIM(location_identifier), '') IS NOT NULL
          AND location_identifier !~ '[/\\]'
          AND location_identifier NOT IN ('.', '..')
        ),
      CONSTRAINT cc_edge_grant_device_id_check
        CHECK (
          NULLIF(BTRIM(device_id), '') IS NOT NULL
          AND device_id !~ '[[:cntrl:]]'
        ),
      CONSTRAINT cc_edge_grant_certificate_check
        CHECK (client_certificate_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT cc_edge_grant_validity_check
        CHECK (valid_until > valid_from),
      CONSTRAINT cc_edge_grant_policy_version_check
        CHECK (policy_version > 0),
      CONSTRAINT cc_edge_grant_access_revision_check
        CHECK (access_revision > 0)
    )
  $table$;

  EXECUTE $table$
    CREATE TABLE IF NOT EXISTS clinical_continuity_edge_access_revocations (
      id                              UUID NOT NULL DEFAULT gen_random_uuid(),
      tenant_id                       UUID NOT NULL,
      facility_id                     INTEGER NOT NULL,
      grant_id                        UUID NOT NULL,
      access_revision                 BIGINT NOT NULL
        DEFAULT nextval('clinical_continuity_edge_access_revision_seq'),
      revoked_by                      UUID NOT NULL,
      revoked_at                      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
      reason                          VARCHAR(500) NOT NULL,

      CONSTRAINT clinical_continuity_edge_access_revocations_pkey
        PRIMARY KEY (tenant_id, facility_id, id),
      CONSTRAINT cc_edge_revocation_no_default_tenant_check
        CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
      CONSTRAINT cc_edge_revocation_access_revision_check
        CHECK (access_revision > 0),
      CONSTRAINT cc_edge_revocation_reason_check
        CHECK (
          NULLIF(BTRIM(reason), '') IS NOT NULL
          AND reason !~ '[[:cntrl:]]'
        )
    )
  $table$;

  EXECUTE $table$
    CREATE TABLE IF NOT EXISTS clinical_continuity_edge_log_receipts (
      id                              UUID NOT NULL DEFAULT gen_random_uuid(),
      tenant_id                       UUID NOT NULL,
      facility_id                     INTEGER NOT NULL,
      device_id                       VARCHAR(160) NOT NULL,
      grant_id                        UUID NOT NULL,
      client_certificate_sha256       CHAR(64) NOT NULL,
      policy_version_id               UUID NOT NULL,
      policy_version                  BIGINT NOT NULL,
      access_revision                 BIGINT NOT NULL,
      batch_id                        VARCHAR(160) NOT NULL,
      previous_batch_sha256           CHAR(64),
      batch_sha256                    CHAR(64) NOT NULL,
      event_count                     INTEGER NOT NULL,
      first_event_sequence            BIGINT NOT NULL,
      last_event_sequence             BIGINT NOT NULL,
      first_event_at                  TIMESTAMPTZ(6) NOT NULL,
      last_event_at                   TIMESTAMPTZ(6) NOT NULL,
      signature_algorithm             VARCHAR(24) NOT NULL DEFAULT 'ed25519',
      signature_sha256                CHAR(64) NOT NULL,
      imported_by                     UUID NOT NULL,
      received_at                     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

      CONSTRAINT clinical_continuity_edge_log_receipts_pkey
        PRIMARY KEY (tenant_id, facility_id, id),
      CONSTRAINT cc_edge_receipt_no_default_tenant_check
        CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
      CONSTRAINT cc_edge_receipt_device_id_check
        CHECK (
          NULLIF(BTRIM(device_id), '') IS NOT NULL
          AND device_id !~ '[[:cntrl:]]'
        ),
      CONSTRAINT cc_edge_receipt_batch_id_check
        CHECK (
          NULLIF(BTRIM(batch_id), '') IS NOT NULL
          AND batch_id !~ '[[:cntrl:]]'
        ),
      CONSTRAINT cc_edge_receipt_hashes_check
        CHECK (
          client_certificate_sha256 ~ '^[0-9a-f]{64}$'
          AND (previous_batch_sha256 IS NULL OR previous_batch_sha256 ~ '^[0-9a-f]{64}$')
          AND batch_sha256 ~ '^[0-9a-f]{64}$'
          AND signature_sha256 ~ '^[0-9a-f]{64}$'
        ),
      CONSTRAINT cc_edge_receipt_signature_algorithm_check
        CHECK (LOWER(signature_algorithm) = 'ed25519'),
      CONSTRAINT cc_edge_receipt_policy_version_check
        CHECK (policy_version > 0),
      CONSTRAINT cc_edge_receipt_access_revision_check
        CHECK (access_revision > 0),
      CONSTRAINT cc_edge_receipt_event_range_check
        CHECK (
          event_count > 0
          AND first_event_sequence >= 1
          AND last_event_sequence >= first_event_sequence
          AND last_event_sequence - first_event_sequence + 1 = event_count
          AND last_event_at >= first_event_at
        )
    )
  $table$;
END
$cc_edge_tables$;

DO $cc_edge_primary_keys$
DECLARE
  target_table TEXT;
  primary_name TEXT;
  primary_definition TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'clinical_continuity_edge_access_grants',
    'clinical_continuity_edge_access_revocations',
    'clinical_continuity_edge_log_receipts'
  ]::TEXT[] LOOP
    SELECT constraint_row.conname,
           pg_get_constraintdef(constraint_row.oid)
      INTO primary_name, primary_definition
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = target_table::regclass
       AND constraint_row.contype = 'p';

    IF primary_name IS NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ADD PRIMARY KEY (tenant_id, facility_id, id)',
        target_table
      );
    ELSIF primary_definition <> 'PRIMARY KEY (tenant_id, facility_id, id)' THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target_table, primary_name);
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (tenant_id, facility_id, id)',
        target_table,
        primary_name
      );
    END IF;
  END LOOP;
END
$cc_edge_primary_keys$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_edge_grant_tenant_facility_id
  ON clinical_continuity_edge_access_grants (tenant_id, facility_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_edge_grant_tenant_facility_revision
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, access_revision
  );

CREATE INDEX IF NOT EXISTS idx_cc_edge_grant_export
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, access_revision, id
  );

CREATE INDEX IF NOT EXISTS idx_cc_edge_grant_location
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, location_type, location_identifier,
    access_revision
  );

CREATE INDEX IF NOT EXISTS idx_cc_edge_grant_subject
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, staff_uid, device_id,
    client_certificate_sha256, access_revision
  );

CREATE INDEX IF NOT EXISTS idx_cc_edge_grant_policy
  ON clinical_continuity_edge_access_grants (
    tenant_id, facility_id, policy_version_id, policy_version,
    access_revision
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_edge_revocation_tenant_facility_id
  ON clinical_continuity_edge_access_revocations (tenant_id, facility_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_edge_revocation_grant
  ON clinical_continuity_edge_access_revocations (
    tenant_id, facility_id, grant_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_edge_revocation_revision
  ON clinical_continuity_edge_access_revocations (
    tenant_id, facility_id, access_revision
  );

CREATE INDEX IF NOT EXISTS idx_cc_edge_revocation_export
  ON clinical_continuity_edge_access_revocations (
    tenant_id, facility_id, access_revision, grant_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_edge_receipt_tenant_facility_id
  ON clinical_continuity_edge_log_receipts (tenant_id, facility_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_edge_receipt_device_batch
  ON clinical_continuity_edge_log_receipts (
    tenant_id, facility_id, device_id, batch_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_edge_receipt_device_hash
  ON clinical_continuity_edge_log_receipts (
    tenant_id, facility_id, device_id, batch_sha256
  );

CREATE INDEX IF NOT EXISTS idx_cc_edge_receipt_chain
  ON clinical_continuity_edge_log_receipts (
    tenant_id, facility_id, device_id, last_event_sequence DESC,
    received_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_cc_edge_receipt_grant
  ON clinical_continuity_edge_log_receipts (
    tenant_id, facility_id, grant_id, access_revision
  );

DO $cc_edge_preflight$
DECLARE
  bad_grants BIGINT;
  bad_revocations BIGINT;
  bad_receipts BIGINT;
  grant_samples TEXT;
  revocation_samples TEXT;
  receipt_samples TEXT;
BEGIN
  SELECT COUNT(*),
         (
           SELECT string_agg(
             format(
               'grant id=%s tenant=%s facility=%s staff=%s policy=%s/%s',
               sample.id,
               sample.tenant_id,
               sample.facility_id,
               sample.staff_uid,
               sample.policy_version_id,
               sample.policy_version
             ),
             E'\n'
           )
             FROM (
               SELECT grant_row.id,
                      grant_row.tenant_id,
                      grant_row.facility_id,
                      grant_row.staff_uid,
                      grant_row.policy_version_id,
                      grant_row.policy_version
                 FROM clinical_continuity_edge_access_grants AS grant_row
                 LEFT JOIN facilities AS facility
                   ON facility.tenant_id = grant_row.tenant_id
                  AND facility.id = grant_row.facility_id
                 LEFT JOIN users AS staff
                   ON staff.tenant_id = grant_row.tenant_id
                  AND staff.uid = grant_row.staff_uid
                 LEFT JOIN users AS creator
                   ON creator.tenant_id = grant_row.tenant_id
                  AND creator.uid = grant_row.created_by
                 LEFT JOIN clinical_continuity_policy_versions AS policy
                   ON policy.tenant_id = grant_row.tenant_id
                  AND policy.facility_id = grant_row.facility_id
                  AND policy.id = grant_row.policy_version_id
                  AND policy.policy_version = grant_row.policy_version
                WHERE facility.id IS NULL
                   OR staff.uid IS NULL
                   OR creator.uid IS NULL
                   OR policy.id IS NULL
                ORDER BY grant_row.id
                LIMIT 20
             ) AS sample
         )
    INTO bad_grants, grant_samples
    FROM clinical_continuity_edge_access_grants AS grant_row
    LEFT JOIN facilities AS facility
      ON facility.tenant_id = grant_row.tenant_id
     AND facility.id = grant_row.facility_id
    LEFT JOIN users AS staff
      ON staff.tenant_id = grant_row.tenant_id
     AND staff.uid = grant_row.staff_uid
    LEFT JOIN users AS creator
      ON creator.tenant_id = grant_row.tenant_id
     AND creator.uid = grant_row.created_by
    LEFT JOIN clinical_continuity_policy_versions AS policy
      ON policy.tenant_id = grant_row.tenant_id
     AND policy.facility_id = grant_row.facility_id
     AND policy.id = grant_row.policy_version_id
     AND policy.policy_version = grant_row.policy_version
   WHERE facility.id IS NULL
      OR staff.uid IS NULL
      OR creator.uid IS NULL
      OR policy.id IS NULL;

  SELECT COUNT(*),
         (
           SELECT string_agg(
             format(
               'revocation id=%s tenant=%s facility=%s grant=%s actor=%s',
               sample.id,
               sample.tenant_id,
               sample.facility_id,
               sample.grant_id,
               sample.revoked_by
             ),
             E'\n'
           )
             FROM (
               SELECT revocation.id,
                      revocation.tenant_id,
                      revocation.facility_id,
                      revocation.grant_id,
                      revocation.revoked_by
                 FROM clinical_continuity_edge_access_revocations AS revocation
                 LEFT JOIN clinical_continuity_edge_access_grants AS grant_row
                   ON grant_row.tenant_id = revocation.tenant_id
                  AND grant_row.facility_id = revocation.facility_id
                  AND grant_row.id = revocation.grant_id
                 LEFT JOIN users AS actor
                   ON actor.tenant_id = revocation.tenant_id
                  AND actor.uid = revocation.revoked_by
                WHERE grant_row.id IS NULL OR actor.uid IS NULL
                ORDER BY revocation.id
                LIMIT 20
             ) AS sample
         )
    INTO bad_revocations, revocation_samples
    FROM clinical_continuity_edge_access_revocations AS revocation
    LEFT JOIN clinical_continuity_edge_access_grants AS grant_row
      ON grant_row.tenant_id = revocation.tenant_id
     AND grant_row.facility_id = revocation.facility_id
     AND grant_row.id = revocation.grant_id
    LEFT JOIN users AS actor
      ON actor.tenant_id = revocation.tenant_id
     AND actor.uid = revocation.revoked_by
   WHERE grant_row.id IS NULL OR actor.uid IS NULL;

  SELECT COUNT(*),
         (
           SELECT string_agg(
             format(
               'receipt id=%s tenant=%s facility=%s grant=%s actor=%s',
               sample.id,
               sample.tenant_id,
               sample.facility_id,
               sample.grant_id,
               sample.imported_by
             ),
             E'\n'
           )
             FROM (
               SELECT receipt.id,
                      receipt.tenant_id,
                      receipt.facility_id,
                      receipt.grant_id,
                      receipt.imported_by
                 FROM clinical_continuity_edge_log_receipts AS receipt
                 LEFT JOIN clinical_continuity_edge_access_grants AS grant_row
                   ON grant_row.tenant_id = receipt.tenant_id
                  AND grant_row.facility_id = receipt.facility_id
                  AND grant_row.id = receipt.grant_id
                 LEFT JOIN clinical_continuity_policy_versions AS policy
                   ON policy.tenant_id = receipt.tenant_id
                  AND policy.facility_id = receipt.facility_id
                  AND policy.id = receipt.policy_version_id
                  AND policy.policy_version = receipt.policy_version
                 LEFT JOIN users AS actor
                   ON actor.tenant_id = receipt.tenant_id
                  AND actor.uid = receipt.imported_by
                WHERE grant_row.id IS NULL
                   OR policy.id IS NULL
                   OR actor.uid IS NULL
                ORDER BY receipt.id
                LIMIT 20
             ) AS sample
         )
    INTO bad_receipts, receipt_samples
    FROM clinical_continuity_edge_log_receipts AS receipt
    LEFT JOIN clinical_continuity_edge_access_grants AS grant_row
      ON grant_row.tenant_id = receipt.tenant_id
     AND grant_row.facility_id = receipt.facility_id
     AND grant_row.id = receipt.grant_id
    LEFT JOIN clinical_continuity_policy_versions AS policy
      ON policy.tenant_id = receipt.tenant_id
     AND policy.facility_id = receipt.facility_id
     AND policy.id = receipt.policy_version_id
     AND policy.policy_version = receipt.policy_version
    LEFT JOIN users AS actor
      ON actor.tenant_id = receipt.tenant_id
     AND actor.uid = receipt.imported_by
   WHERE grant_row.id IS NULL
      OR policy.id IS NULL
      OR actor.uid IS NULL;

  IF bad_grants + bad_revocations + bad_receipts > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        E'migration 601 blocked: %s invalid grants, %s invalid revocations, %s invalid receipts\n%s%s%s',
        bad_grants,
        bad_revocations,
        bad_receipts,
        COALESCE(grant_samples || E'\n', ''),
        COALESCE(revocation_samples || E'\n', ''),
        COALESCE(receipt_samples, '')
      ),
      HINT = 'Reconcile each row from authoritative operator evidence. This migration never guesses, widens scope, or deletes evidence.';
  END IF;
END
$cc_edge_preflight$;

DO $cc_edge_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_grants'::regclass
       AND conname = 'cc_edge_grant_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_grants
      ADD CONSTRAINT cc_edge_grant_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_grants'::regclass
       AND conname = 'cc_edge_grant_facility_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_grants
      ADD CONSTRAINT cc_edge_grant_facility_tenant_fk
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_grants'::regclass
       AND conname = 'cc_edge_grant_staff_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_grants
      ADD CONSTRAINT cc_edge_grant_staff_tenant_fk
      FOREIGN KEY (tenant_id, staff_uid)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_grants'::regclass
       AND conname = 'cc_edge_grant_creator_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_grants
      ADD CONSTRAINT cc_edge_grant_creator_tenant_fk
      FOREIGN KEY (tenant_id, created_by)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_grants'::regclass
       AND conname = 'cc_edge_grant_policy_tenant_facility_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_grants
      ADD CONSTRAINT cc_edge_grant_policy_tenant_facility_fk
      FOREIGN KEY (
        tenant_id, facility_id, policy_version_id, policy_version
      )
      REFERENCES clinical_continuity_policy_versions (
        tenant_id, facility_id, id, policy_version
      )
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_revocations'::regclass
       AND conname = 'cc_edge_revocation_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_revocations
      ADD CONSTRAINT cc_edge_revocation_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_revocations'::regclass
       AND conname = 'cc_edge_revocation_facility_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_revocations
      ADD CONSTRAINT cc_edge_revocation_facility_tenant_fk
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_revocations'::regclass
       AND conname = 'cc_edge_revocation_grant_tenant_facility_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_revocations
      ADD CONSTRAINT cc_edge_revocation_grant_tenant_facility_fk
      FOREIGN KEY (tenant_id, facility_id, grant_id)
      REFERENCES clinical_continuity_edge_access_grants (
        tenant_id, facility_id, id
      )
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_access_revocations'::regclass
       AND conname = 'cc_edge_revocation_actor_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_access_revocations
      ADD CONSTRAINT cc_edge_revocation_actor_tenant_fk
      FOREIGN KEY (tenant_id, revoked_by)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_log_receipts'::regclass
       AND conname = 'cc_edge_receipt_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_log_receipts
      ADD CONSTRAINT cc_edge_receipt_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_log_receipts'::regclass
       AND conname = 'cc_edge_receipt_facility_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_log_receipts
      ADD CONSTRAINT cc_edge_receipt_facility_tenant_fk
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_log_receipts'::regclass
       AND conname = 'cc_edge_receipt_grant_tenant_facility_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_log_receipts
      ADD CONSTRAINT cc_edge_receipt_grant_tenant_facility_fk
      FOREIGN KEY (tenant_id, facility_id, grant_id)
      REFERENCES clinical_continuity_edge_access_grants (
        tenant_id, facility_id, id
      )
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_log_receipts'::regclass
       AND conname = 'cc_edge_receipt_policy_tenant_facility_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_log_receipts
      ADD CONSTRAINT cc_edge_receipt_policy_tenant_facility_fk
      FOREIGN KEY (
        tenant_id, facility_id, policy_version_id, policy_version
      )
      REFERENCES clinical_continuity_policy_versions (
        tenant_id, facility_id, id, policy_version
      )
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_edge_log_receipts'::regclass
       AND conname = 'cc_edge_receipt_actor_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_edge_log_receipts
      ADD CONSTRAINT cc_edge_receipt_actor_tenant_fk
      FOREIGN KEY (tenant_id, imported_by)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;
END
$cc_edge_fks$;

CREATE OR REPLACE FUNCTION clinical_continuity_edge_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format(
      '%s is append-only; %s is forbidden',
      TG_TABLE_NAME,
      TG_OP
    ),
    HINT = CASE
      WHEN TG_TABLE_NAME = 'clinical_continuity_edge_access_grants'
        THEN 'Renewal creates a new grant row. Revocation creates a revocation row.'
      ELSE 'Append new evidence instead of mutating or deleting an existing row.'
    END;
END
$function$;

DO $cc_edge_triggers$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_edge_grant_immutable
             ON clinical_continuity_edge_access_grants';
  EXECUTE $trigger$
    CREATE TRIGGER trg_cc_edge_grant_immutable
      BEFORE UPDATE OR DELETE
      ON clinical_continuity_edge_access_grants
      FOR EACH ROW
      EXECUTE FUNCTION clinical_continuity_edge_block_mutation()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_edge_revocation_immutable
             ON clinical_continuity_edge_access_revocations';
  EXECUTE $trigger$
    CREATE TRIGGER trg_cc_edge_revocation_immutable
      BEFORE UPDATE OR DELETE
      ON clinical_continuity_edge_access_revocations
      FOR EACH ROW
      EXECUTE FUNCTION clinical_continuity_edge_block_mutation()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_edge_receipt_immutable
             ON clinical_continuity_edge_log_receipts';
  EXECUTE $trigger$
    CREATE TRIGGER trg_cc_edge_receipt_immutable
      BEFORE UPDATE OR DELETE
      ON clinical_continuity_edge_log_receipts
      FOR EACH ROW
      EXECUTE FUNCTION clinical_continuity_edge_block_mutation()
  $trigger$;
END
$cc_edge_triggers$;

ALTER TABLE clinical_continuity_edge_access_grants
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_continuity_edge_access_grants
  FORCE ROW LEVEL SECURITY;

ALTER TABLE clinical_continuity_edge_access_revocations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_continuity_edge_access_revocations
  FORCE ROW LEVEL SECURITY;

ALTER TABLE clinical_continuity_edge_log_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_continuity_edge_log_receipts
  FORCE ROW LEVEL SECURITY;

DO $cc_edge_policies$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation
             ON clinical_continuity_edge_access_grants';
  EXECUTE $policy$
    CREATE POLICY tenant_isolation
      ON clinical_continuity_edge_access_grants
      AS PERMISSIVE
      FOR ALL
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
      )
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS cc_edge_grant_explicit_context
             ON clinical_continuity_edge_access_grants';
  EXECUTE $policy$
    CREATE POLICY cc_edge_grant_explicit_context
      ON clinical_continuity_edge_access_grants
      AS RESTRICTIVE
      FOR ALL
      USING (tenant_id = app_current_tenant_id_uuid())
      WITH CHECK (tenant_id = app_current_tenant_id_uuid())
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation
             ON clinical_continuity_edge_access_revocations';
  EXECUTE $policy$
    CREATE POLICY tenant_isolation
      ON clinical_continuity_edge_access_revocations
      AS PERMISSIVE
      FOR ALL
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
      )
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS cc_edge_revocation_explicit_context
             ON clinical_continuity_edge_access_revocations';
  EXECUTE $policy$
    CREATE POLICY cc_edge_revocation_explicit_context
      ON clinical_continuity_edge_access_revocations
      AS RESTRICTIVE
      FOR ALL
      USING (tenant_id = app_current_tenant_id_uuid())
      WITH CHECK (tenant_id = app_current_tenant_id_uuid())
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation
             ON clinical_continuity_edge_log_receipts';
  EXECUTE $policy$
    CREATE POLICY tenant_isolation
      ON clinical_continuity_edge_log_receipts
      AS PERMISSIVE
      FOR ALL
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
      )
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS cc_edge_receipt_explicit_context
             ON clinical_continuity_edge_log_receipts';
  EXECUTE $policy$
    CREATE POLICY cc_edge_receipt_explicit_context
      ON clinical_continuity_edge_log_receipts
      AS RESTRICTIVE
      FOR ALL
      USING (tenant_id = app_current_tenant_id_uuid())
      WITH CHECK (tenant_id = app_current_tenant_id_uuid())
  $policy$;
END
$cc_edge_policies$;

REVOKE ALL PRIVILEGES
  ON TABLE clinical_continuity_edge_access_grants,
           clinical_continuity_edge_access_revocations,
           clinical_continuity_edge_log_receipts
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON SEQUENCE clinical_continuity_edge_access_revision_seq
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_edge_block_mutation()
  FROM PUBLIC;

DO $cc_edge_runtime_grants$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT ON TABLE clinical_continuity_edge_access_grants,
                               clinical_continuity_edge_access_revocations,
                               clinical_continuity_edge_log_receipts
           TO %I',
        role_name
      );

      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE
           ON TABLE clinical_continuity_edge_access_grants,
                    clinical_continuity_edge_access_revocations,
                    clinical_continuity_edge_log_receipts
         FROM %I',
        role_name
      );

      EXECUTE format(
        'GRANT INSERT (
           tenant_id, facility_id, location_type, location_identifier,
           staff_uid, device_id, client_certificate_sha256,
           valid_from, valid_until, policy_version_id, policy_version,
           created_by
         ) ON clinical_continuity_edge_access_grants TO %I',
        role_name
      );

      EXECUTE format(
        'GRANT INSERT (
           tenant_id, facility_id, grant_id, revoked_by, reason
         ) ON clinical_continuity_edge_access_revocations TO %I',
        role_name
      );

      EXECUTE format(
        'GRANT INSERT (
           tenant_id, facility_id, device_id, grant_id,
           client_certificate_sha256, policy_version_id, policy_version,
           access_revision, batch_id, previous_batch_sha256, batch_sha256,
           event_count, first_event_sequence, last_event_sequence,
           first_event_at, last_event_at, signature_algorithm,
           signature_sha256, imported_by
         ) ON clinical_continuity_edge_log_receipts TO %I',
        role_name
      );

      EXECUTE format(
        'GRANT USAGE, SELECT
           ON SEQUENCE clinical_continuity_edge_access_revision_seq
           TO %I',
        role_name
      );

      EXECUTE format(
        'REVOKE UPDATE
           ON SEQUENCE clinical_continuity_edge_access_revision_seq
           FROM %I',
        role_name
      );

      EXECUTE format(
        'REVOKE ALL PRIVILEGES
           ON FUNCTION clinical_continuity_edge_block_mutation()
           FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$cc_edge_runtime_grants$;
