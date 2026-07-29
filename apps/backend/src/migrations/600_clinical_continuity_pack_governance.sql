-- Clinical Service Continuity C3.1: signed pack governance and evidence.
--
-- @no-transaction
--
-- This migration is additive and inert. It does not seed a policy, register a
-- signing key, activate generation, serve a pack, or infer facility mappings.
-- Each statement is re-runnable because the boot runner commits no-transaction
-- migrations statement-by-statement while ci-setup-db wraps the same file.

SET lock_timeout = '10s';
SET statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Facility ownership required by the ward and ED producers.
-- ---------------------------------------------------------------------------

ALTER TABLE wards
  ADD COLUMN IF NOT EXISTS facility_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS ux_wards_tenant_id
  ON wards (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_wards_tenant_facility_id
  ON wards (tenant_id, facility_id, id);

CREATE INDEX IF NOT EXISTS idx_wards_tenant_facility
  ON wards (tenant_id, facility_id, id)
  WHERE facility_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ed_visits_tenant_facility_status
  ON emergency_visits (tenant_id, facility_id, status, arrival_at DESC)
  WHERE facility_id IS NOT NULL;

DO $cc_facility_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'wards'::regclass
       AND conname = 'fk_wards_facility_tenant'
  ) THEN
    ALTER TABLE wards
      ADD CONSTRAINT fk_wards_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE SET NULL (facility_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'emergency_visits'::regclass
       AND conname = 'fk_emergency_visits_facility_tenant'
  ) THEN
    ALTER TABLE emergency_visits
      ADD CONSTRAINT fk_emergency_visits_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE SET NULL (facility_id)
      NOT VALID;
  END IF;
END
$cc_facility_fks$;

DO $cc_facility_preflight$
DECLARE
  bad_wards BIGINT;
  bad_ed BIGINT;
  ward_samples TEXT;
  ed_samples TEXT;
BEGIN
  SELECT COUNT(*),
         (
           SELECT string_agg(
             format(
               'ward id=%s tenant=%s facility=%s facility_tenant=%s',
               sample.id,
               sample.tenant_id,
               sample.facility_id,
               COALESCE(sample.facility_tenant::text, '<missing>')
             ),
             E'\n'
           )
             FROM (
               SELECT w.id, w.tenant_id, w.facility_id, f.tenant_id AS facility_tenant
                 FROM wards AS w
                 LEFT JOIN facilities AS f ON f.id = w.facility_id
                WHERE w.facility_id IS NOT NULL
                  AND (f.id IS NULL OR f.tenant_id IS DISTINCT FROM w.tenant_id)
                ORDER BY w.id
                LIMIT 20
             ) AS sample
         )
    INTO bad_wards, ward_samples
    FROM wards AS w
    LEFT JOIN facilities AS f ON f.id = w.facility_id
   WHERE w.facility_id IS NOT NULL
     AND (f.id IS NULL OR f.tenant_id IS DISTINCT FROM w.tenant_id);

  SELECT COUNT(*),
         (
           SELECT string_agg(
             format(
               'emergency_visit id=%s tenant=%s facility=%s facility_tenant=%s',
               sample.id,
               sample.tenant_id,
               sample.facility_id,
               COALESCE(sample.facility_tenant::text, '<missing>')
             ),
             E'\n'
           )
             FROM (
               SELECT ev.id, ev.tenant_id, ev.facility_id, f.tenant_id AS facility_tenant
                 FROM emergency_visits AS ev
                 LEFT JOIN facilities AS f ON f.id = ev.facility_id
                WHERE ev.facility_id IS NOT NULL
                  AND (f.id IS NULL OR f.tenant_id IS DISTINCT FROM ev.tenant_id)
                ORDER BY ev.id
                LIMIT 20
             ) AS sample
         )
    INTO bad_ed, ed_samples
    FROM emergency_visits AS ev
    LEFT JOIN facilities AS f ON f.id = ev.facility_id
   WHERE ev.facility_id IS NOT NULL
     AND (f.id IS NULL OR f.tenant_id IS DISTINCT FROM ev.tenant_id);

  IF bad_wards + bad_ed > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        E'migration 600 blocked: %s ward and %s ED cross-tenant/orphan facility mappings found\n%s%s',
        bad_wards,
        bad_ed,
        COALESCE(ward_samples || E'\n', ''),
        COALESCE(ed_samples, '')
      ),
      HINT = 'Reconcile each facility mapping from authoritative owner evidence. This migration never guesses or backfills a facility.';
  END IF;
END
$cc_facility_preflight$;

ALTER TABLE wards
  VALIDATE CONSTRAINT fk_wards_facility_tenant;

ALTER TABLE emergency_visits
  VALIDATE CONSTRAINT fk_emergency_visits_facility_tenant;

-- ---------------------------------------------------------------------------
-- Append-only tenant/facility policy versions. Existing encryption_keys is the
-- only key registry; policy rows carry references and signed public metadata.
-- ---------------------------------------------------------------------------

DO $cc_policy_table_bootstrap$
DECLARE
  role_name TEXT;
BEGIN
  EXECUTE $table$
    CREATE TABLE IF NOT EXISTS clinical_continuity_policy_versions (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id                   UUID NOT NULL,
      facility_id                 INTEGER NOT NULL,
      policy_version              BIGINT NOT NULL,
      policy_schema_version       INTEGER NOT NULL,
      lifecycle_state             VARCHAR(20) NOT NULL DEFAULT 'draft',
      policy_document             JSONB NOT NULL,
      policy_checksum             CHAR(64) NOT NULL,
      canonicalization            VARCHAR(32) NOT NULL DEFAULT 'rfc8785-jcs',
      signature_algorithm         VARCHAR(24) NOT NULL DEFAULT 'ed25519',
      policy_signing_key_id       VARCHAR(64) NOT NULL,
      policy_signing_public_key_sha256 CHAR(64) NOT NULL,
      current_pack_signing_key_id VARCHAR(64) NOT NULL,
      current_pack_signing_public_key_sha256 CHAR(64) NOT NULL,
      next_pack_signing_key_id    VARCHAR(64),
      next_pack_signing_public_key_sha256 CHAR(64),
      policy_signature            BYTEA NOT NULL,
      revocation_epoch            BIGINT NOT NULL DEFAULT 0,
      revoked_key_ids             JSONB NOT NULL DEFAULT '[]'::jsonb,
      approval_id                 INTEGER,
      approved_by                 UUID,
      approved_at                 TIMESTAMPTZ(6),
      effective_from              TIMESTAMPTZ(6) NOT NULL,
      effective_until             TIMESTAMPTZ(6),
      supersedes_policy_id        UUID,
      retired_by                  UUID,
      retired_at                  TIMESTAMPTZ(6),
      retirement_reason           TEXT,
      created_at                  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

      CONSTRAINT cc_policy_no_default_tenant_check
        CHECK (tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid),
      CONSTRAINT cc_policy_version_check
        CHECK (policy_version > 0),
      CONSTRAINT cc_policy_schema_version_check
        CHECK (policy_schema_version > 0),
      CONSTRAINT cc_policy_revocation_epoch_check
        CHECK (revocation_epoch >= 0),
      CONSTRAINT cc_policy_state_check
        CHECK (lifecycle_state IN ('draft', 'approved', 'active', 'retired')),
      CONSTRAINT cc_policy_checksum_check
        CHECK (policy_checksum ~ '^[0-9a-f]{64}$'),
      CONSTRAINT cc_policy_signature_check
        CHECK (
          canonicalization = 'rfc8785-jcs'
          AND LOWER(signature_algorithm) = 'ed25519'
          AND OCTET_LENGTH(policy_signature) = 64
        ),
      CONSTRAINT cc_policy_effective_interval_check
        CHECK (effective_until IS NULL OR effective_until > effective_from),
      CONSTRAINT cc_policy_json_shapes_check
        CHECK (
          jsonb_typeof(policy_document) = 'object'
          AND jsonb_typeof(revoked_key_ids) = 'array'
          AND jsonb_array_length(revoked_key_ids) <= 100
        ),
      CONSTRAINT cc_policy_key_rotation_check
        CHECK (
          (
            next_pack_signing_key_id IS NULL
            AND next_pack_signing_public_key_sha256 IS NULL
          )
          OR (
            next_pack_signing_key_id IS NOT NULL
            AND next_pack_signing_key_id <> current_pack_signing_key_id
            AND next_pack_signing_public_key_sha256 ~ '^[0-9a-f]{64}$'
          )
        ),
      CONSTRAINT cc_policy_public_key_binding_check
        CHECK (
          policy_signing_public_key_sha256 ~ '^[0-9a-f]{64}$'
          AND current_pack_signing_public_key_sha256 ~ '^[0-9a-f]{64}$'
        ),
      CONSTRAINT cc_policy_approval_evidence_check
        CHECK (
          (
            lifecycle_state = 'draft'
            AND approval_id IS NULL
            AND approved_by IS NULL
            AND approved_at IS NULL
          )
          OR
          (
            lifecycle_state IN ('approved', 'active', 'retired')
            AND approval_id IS NOT NULL
            AND approved_by IS NOT NULL
            AND approved_at IS NOT NULL
          )
        ),
      CONSTRAINT cc_policy_retirement_evidence_check
        CHECK (
          (
            lifecycle_state = 'retired'
            AND retired_by IS NOT NULL
            AND retired_at IS NOT NULL
            AND NULLIF(BTRIM(retirement_reason), '') IS NOT NULL
            AND effective_until IS NOT NULL
            AND effective_until <= retired_at
            AND retired_at >= approved_at
          )
          OR
          (
            lifecycle_state <> 'retired'
            AND retired_by IS NULL
            AND retired_at IS NULL
            AND retirement_reason IS NULL
          )
      )
    )
  $table$;

  EXECUTE 'ALTER TABLE clinical_continuity_policy_versions
             ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE clinical_continuity_policy_versions
             FORCE ROW LEVEL SECURITY';

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policy
     WHERE polrelid = 'clinical_continuity_policy_versions'::regclass
       AND polname = 'tenant_isolation'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY tenant_isolation
        ON clinical_continuity_policy_versions
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
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policy
     WHERE polrelid = 'clinical_continuity_policy_versions'::regclass
       AND polname = 'cc_policy_explicit_context'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY cc_policy_explicit_context
        ON clinical_continuity_policy_versions
        AS RESTRICTIVE
        FOR ALL
        USING (
          tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          tenant_id = app_current_tenant_id_uuid()
        )
    $policy$;
  END IF;

  EXECUTE 'REVOKE ALL PRIVILEGES
             ON TABLE clinical_continuity_policy_versions
           FROM PUBLIC';

  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE
           ON TABLE clinical_continuity_policy_versions
         FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$cc_policy_table_bootstrap$;

ALTER TABLE clinical_continuity_policy_versions
  ADD COLUMN IF NOT EXISTS policy_signing_public_key_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS current_pack_signing_public_key_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS next_pack_signing_public_key_sha256 CHAR(64);

DO $cc_policy_key_binding_constraints$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM clinical_continuity_policy_versions
     WHERE policy_signing_public_key_sha256 IS NULL
        OR current_pack_signing_public_key_sha256 IS NULL
        OR (
          next_pack_signing_key_id IS NULL
          AND next_pack_signing_public_key_sha256 IS NOT NULL
        )
        OR (
          next_pack_signing_key_id IS NOT NULL
          AND next_pack_signing_public_key_sha256 IS NULL
        )
  ) THEN
    RAISE EXCEPTION
      'migration 600 replay blocked: existing policy rows lack signed public-key bindings'
      USING
        ERRCODE = '23514',
        HINT = 'No policy row may be backfilled implicitly because its existing signature did not bind these hashes.';
  END IF;

  ALTER TABLE clinical_continuity_policy_versions
    ALTER COLUMN policy_signing_public_key_sha256 SET NOT NULL,
    ALTER COLUMN current_pack_signing_public_key_sha256 SET NOT NULL;

  ALTER TABLE clinical_continuity_policy_versions
    DROP CONSTRAINT IF EXISTS cc_policy_key_rotation_check;
  ALTER TABLE clinical_continuity_policy_versions
    ADD CONSTRAINT cc_policy_key_rotation_check
    CHECK (
      (
        next_pack_signing_key_id IS NULL
        AND next_pack_signing_public_key_sha256 IS NULL
      )
      OR (
        next_pack_signing_key_id IS NOT NULL
        AND next_pack_signing_key_id <> current_pack_signing_key_id
        AND next_pack_signing_public_key_sha256 ~ '^[0-9a-f]{64}$'
      )
    );

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_public_key_binding_check'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_public_key_binding_check
      CHECK (
        policy_signing_public_key_sha256 ~ '^[0-9a-f]{64}$'
        AND current_pack_signing_public_key_sha256 ~ '^[0-9a-f]{64}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_revocation_epoch_check'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_revocation_epoch_check
      CHECK (revocation_epoch >= 0);
  END IF;
END
$cc_policy_key_binding_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_policy_tenant_facility_id
  ON clinical_continuity_policy_versions (tenant_id, facility_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_policy_tenant_facility_version
  ON clinical_continuity_policy_versions (tenant_id, facility_id, policy_version);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_policy_snapshot_pin
  ON clinical_continuity_policy_versions (
    tenant_id, facility_id, id, policy_version
  );

DO $cc_policy_active_index$
BEGIN
  DROP INDEX IF EXISTS ux_cc_policy_active;

  CREATE UNIQUE INDEX ux_cc_policy_active
    ON clinical_continuity_policy_versions (
      tenant_id, facility_id, lifecycle_state
    )
    WHERE lifecycle_state = 'active';
END
$cc_policy_active_index$;

CREATE INDEX IF NOT EXISTS idx_cc_policy_effective
  ON clinical_continuity_policy_versions (
    tenant_id, facility_id, lifecycle_state,
    effective_from DESC, policy_version DESC
  );

CREATE INDEX IF NOT EXISTS idx_cc_policy_current_key
  ON clinical_continuity_policy_versions (
    tenant_id, current_pack_signing_key_id
  );

CREATE INDEX IF NOT EXISTS idx_cc_policy_next_key
  ON clinical_continuity_policy_versions (
    tenant_id, next_pack_signing_key_id
  )
  WHERE next_pack_signing_key_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cc_policy_approval
  ON clinical_continuity_policy_versions (tenant_id, approval_id)
  WHERE approval_id IS NOT NULL;

DO $cc_policy_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_facility_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_facility_tenant_fk
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_approval_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_approval_tenant_fk
      FOREIGN KEY (tenant_id, approval_id)
      REFERENCES approvals (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_approved_by_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_approved_by_tenant_fk
      FOREIGN KEY (tenant_id, approved_by)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_retired_by_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_retired_by_tenant_fk
      FOREIGN KEY (tenant_id, retired_by)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_policy_key_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_policy_key_tenant_fk
      FOREIGN KEY (tenant_id, policy_signing_key_id)
      REFERENCES encryption_keys (tenant_id, key_id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_current_key_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_current_key_tenant_fk
      FOREIGN KEY (tenant_id, current_pack_signing_key_id)
      REFERENCES encryption_keys (tenant_id, key_id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_next_key_tenant_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_next_key_tenant_fk
      FOREIGN KEY (tenant_id, next_pack_signing_key_id)
      REFERENCES encryption_keys (tenant_id, key_id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clinical_continuity_policy_versions'::regclass
       AND conname = 'cc_policy_supersedes_tenant_facility_fk'
  ) THEN
    ALTER TABLE clinical_continuity_policy_versions
      ADD CONSTRAINT cc_policy_supersedes_tenant_facility_fk
      FOREIGN KEY (tenant_id, facility_id, supersedes_policy_id)
      REFERENCES clinical_continuity_policy_versions (tenant_id, facility_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;
END
$cc_policy_fks$;

-- ---------------------------------------------------------------------------
-- Add signed publication evidence to the existing downtime snapshot store.
-- ---------------------------------------------------------------------------

ALTER TABLE downtime_snapshots
  ADD COLUMN IF NOT EXISTS facility_id INTEGER,
  ADD COLUMN IF NOT EXISTS location_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS location_identifier VARCHAR(160),
  ADD COLUMN IF NOT EXISTS pack_schema_version INTEGER,
  ADD COLUMN IF NOT EXISTS policy_version_id UUID,
  ADD COLUMN IF NOT EXISTS policy_version BIGINT,
  ADD COLUMN IF NOT EXISTS publication_set_id UUID,
  ADD COLUMN IF NOT EXISTS manifest_version BIGINT,
  ADD COLUMN IF NOT EXISTS source_watermark JSONB,
  ADD COLUMN IF NOT EXISTS content_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS rendered_content_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS signature_algorithm VARCHAR(24),
  ADD COLUMN IF NOT EXISTS signing_key_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS signature BYTEA,
  ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS fresh_until TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS freshness_metadata JSONB,
  ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS payload_purged_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS payload_purge_reason TEXT;

CREATE SEQUENCE IF NOT EXISTS clinical_continuity_manifest_version_seq
  AS BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_downtime_snapshots_tenant_id
  ON downtime_snapshots (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_downtime_cc_manifest_location
  ON downtime_snapshots (
    tenant_id, facility_id, manifest_version,
    location_type, location_identifier
  )
  WHERE scope = 'clinical_continuity_pack';

CREATE UNIQUE INDEX IF NOT EXISTS ux_downtime_cc_set_location
  ON downtime_snapshots (
    tenant_id, facility_id, publication_set_id,
    location_type, location_identifier
  )
  WHERE scope = 'clinical_continuity_pack';

CREATE INDEX IF NOT EXISTS idx_downtime_cc_latest
  ON downtime_snapshots (
    tenant_id, facility_id, location_type,
    location_identifier, published_at DESC, id DESC
  )
  WHERE scope = 'clinical_continuity_pack';

CREATE INDEX IF NOT EXISTS idx_downtime_cc_retention
  ON downtime_snapshots (tenant_id, retention_until, id)
  WHERE scope = 'clinical_continuity_pack'
    AND payload_purged_at IS NULL;

DO $cc_snapshot_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'downtime_snapshots_cc_no_default_tenant'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT downtime_snapshots_cc_no_default_tenant
      CHECK (
        scope <> 'clinical_continuity_pack'
        OR tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'downtime_snapshots_continuity_shape_check'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT downtime_snapshots_continuity_shape_check
      CHECK (
        scope <> 'clinical_continuity_pack'
        OR (
          facility_id IS NOT NULL
          AND location_type IS NOT NULL
          AND NULLIF(BTRIM(location_identifier), '') IS NOT NULL
          AND pack_schema_version > 0
          AND policy_version_id IS NOT NULL
          AND policy_version > 0
          AND publication_set_id IS NOT NULL
          AND manifest_version > 0
          AND jsonb_typeof(payload) = 'object'
          AND jsonb_typeof(source_watermark) = 'object'
          AND jsonb_typeof(freshness_metadata) = 'object'
          AND content_hash IS NOT NULL
          AND rendered_content_hash IS NOT NULL
          AND signature_algorithm IS NOT NULL
          AND signing_key_id IS NOT NULL
          AND signature IS NOT NULL
          AND generated_at IS NOT NULL
          AND published_at IS NOT NULL
          AND fresh_until IS NOT NULL
          AND expires_at IS NOT NULL
          AND retention_until IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'downtime_snapshots_continuity_hash_check'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT downtime_snapshots_continuity_hash_check
      CHECK (
        scope <> 'clinical_continuity_pack'
        OR (
          content_hash ~ '^[0-9a-f]{64}$'
          AND rendered_content_hash ~ '^[0-9a-f]{64}$'
          AND LOWER(signature_algorithm) = 'ed25519'
          AND OCTET_LENGTH(signature) = 64
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'downtime_snapshots_continuity_time_check'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT downtime_snapshots_continuity_time_check
      CHECK (
        scope <> 'clinical_continuity_pack'
        OR (
          generated_at <= published_at
          AND published_at < expires_at
          AND fresh_until = generated_at + INTERVAL '15 minutes'
          AND expires_at = generated_at + INTERVAL '24 hours'
          AND expires_at <= retention_until
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'downtime_snapshots_continuity_location_check'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT downtime_snapshots_continuity_location_check
      CHECK (
        scope <> 'clinical_continuity_pack'
        OR (
          (location_type IN ('ward', 'paeds') AND ward_id IS NOT NULL)
          OR
          (location_type IN ('ed_board', 'opd_day') AND ward_id IS NULL)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'downtime_snapshots_continuity_purge_check'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT downtime_snapshots_continuity_purge_check
      CHECK (
        scope <> 'clinical_continuity_pack'
        OR (
          (
            payload_purged_at IS NULL
            AND payload_purge_reason IS NULL
          )
          OR
          (
            payload_purged_at IS NOT NULL
            AND payload_purged_at >= retention_until
            AND NULLIF(BTRIM(payload_purge_reason), '') IS NOT NULL
            AND payload = '{}'::jsonb
          )
        )
      );
  END IF;
END
$cc_snapshot_constraints$;

DO $cc_snapshot_target_check$
BEGIN
  ALTER TABLE downtime_snapshots
    DROP CONSTRAINT IF EXISTS downtime_snapshots_target_check;

  ALTER TABLE downtime_snapshots
    ADD CONSTRAINT downtime_snapshots_target_check
    CHECK (
      patient_uid IS NOT NULL
      OR ward_id IS NOT NULL
      OR (
        scope = 'clinical_continuity_pack'
        AND facility_id IS NOT NULL
        AND location_type IN ('ed_board', 'opd_day')
      )
    );
END
$cc_snapshot_target_check$;

DO $cc_snapshot_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'fk_downtime_snapshots_facility_tenant'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT fk_downtime_snapshots_facility_tenant
      FOREIGN KEY (tenant_id, facility_id)
      REFERENCES facilities (tenant_id, id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'fk_downtime_snapshots_cc_policy_pin'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT fk_downtime_snapshots_cc_policy_pin
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
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'fk_downtime_snapshots_cc_signing_key'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT fk_downtime_snapshots_cc_signing_key
      FOREIGN KEY (tenant_id, signing_key_id)
      REFERENCES encryption_keys (tenant_id, key_id)
      ON UPDATE NO ACTION ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'downtime_snapshots'::regclass
       AND conname = 'fk_downtime_snapshots_ward_facility_tenant'
  ) THEN
    ALTER TABLE downtime_snapshots
      ADD CONSTRAINT fk_downtime_snapshots_ward_facility_tenant
      FOREIGN KEY (tenant_id, facility_id, ward_id)
      REFERENCES wards (tenant_id, facility_id, id)
      ON UPDATE NO ACTION ON DELETE SET NULL (ward_id);
  END IF;
END
$cc_snapshot_fks$;

-- ---------------------------------------------------------------------------
-- Policy monotonicity, exact approval evidence, lifecycle immutability, and
-- one-way post-retention PHI erasure.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION clinical_continuity_parse_timestamp(value TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF NULLIF(BTRIM(value), '') IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_policy_guard_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_policy clinical_continuity_policy_versions%ROWTYPE;
BEGIN
  IF NEW.lifecycle_state <> 'draft' THEN
    RAISE EXCEPTION 'new clinical continuity policy versions must begin in draft'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.revoked_key_ids) AS revoked(value)
     WHERE jsonb_typeof(revoked.value) <> 'string'
        OR NULLIF(BTRIM(revoked.value #>> '{}'), '') IS NULL
        OR LENGTH(revoked.value #>> '{}') > 64
  )
     OR (
       SELECT COUNT(*) <> COUNT(DISTINCT revoked.value #>> '{}')
         FROM jsonb_array_elements(NEW.revoked_key_ids) AS revoked(value)
     )
  THEN
    RAISE EXCEPTION 'clinical continuity revoked key IDs must be unique non-empty strings'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.revoked_key_ids ? NEW.policy_signing_key_id
     OR NEW.revoked_key_ids ? NEW.current_pack_signing_key_id
     OR (
       NEW.next_pack_signing_key_id IS NOT NULL
       AND NEW.revoked_key_ids ? NEW.next_pack_signing_key_id
     )
  THEN
    RAISE EXCEPTION 'clinical continuity policy cannot select a revoked signing key'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.tenant_id::text || ':' || NEW.facility_id::text, 0)
  );

  SELECT policy.*
    INTO previous_policy
    FROM clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = NEW.tenant_id
     AND policy.facility_id = NEW.facility_id
   ORDER BY policy.policy_version DESC, policy.created_at DESC, policy.id DESC
   LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.supersedes_policy_id IS NOT NULL THEN
      RAISE EXCEPTION 'first clinical continuity policy version cannot supersede another row'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.policy_version <= previous_policy.policy_version THEN
      RAISE EXCEPTION 'clinical continuity policy version must increase monotonically'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes_policy_id IS DISTINCT FROM previous_policy.id THEN
      RAISE EXCEPTION 'clinical continuity policy must supersede the previous highest version'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revocation_epoch < previous_policy.revocation_epoch THEN
      RAISE EXCEPTION 'clinical continuity revocation epoch cannot roll back'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(previous_policy.revoked_key_ids) AS revoked(key_id)
       WHERE NOT NEW.revoked_key_ids ? revoked.key_id
    ) THEN
      RAISE EXCEPTION 'clinical continuity revoked key set cannot roll back'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revoked_key_ids IS DISTINCT FROM previous_policy.revoked_key_ids
       AND NEW.revocation_epoch <= previous_policy.revocation_epoch
    THEN
      RAISE EXCEPTION 'clinical continuity revocation changes require a higher epoch'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_assert_policy_approval(
  target_tenant_id UUID,
  target_policy_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  policy_record clinical_continuity_policy_versions%ROWTYPE;
  approval_record approvals%ROWTYPE;
  policy_key encryption_keys%ROWTYPE;
  current_key encryption_keys%ROWTYPE;
  next_key encryption_keys%ROWTYPE;
  vote_count INTEGER := 0;
  valid_vote_count INTEGER := 0;
  distinct_vote_count INTEGER := 0;
  deciding_actor_voted BOOLEAN := FALSE;
BEGIN
  SELECT policy.*
    INTO policy_record
    FROM clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = target_tenant_id
     AND policy.id = target_policy_id;

  IF NOT FOUND OR policy_record.lifecycle_state IN ('draft', 'retired') THEN
    RETURN;
  END IF;

  SELECT approval.*
    INTO approval_record
    FROM approvals AS approval
   WHERE approval.tenant_id = policy_record.tenant_id
     AND approval.id = policy_record.approval_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'published clinical continuity policy requires matching approval evidence'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(approval_record.approved_by) = 'array' THEN
    WITH votes AS (
      SELECT vote.entry,
             NULLIF(BTRIM(vote.entry ->> 'uid'), '') AS uid_text,
             clinical_continuity_parse_timestamp(vote.entry ->> 'at') AS vote_at
        FROM jsonb_array_elements(approval_record.approved_by) AS vote(entry)
    ), validated AS (
      SELECT votes.*,
             (
               jsonb_typeof(votes.entry) = 'object'
               AND votes.uid_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               AND votes.vote_at IS NOT NULL
               AND votes.vote_at <= approval_record.decided_at
             ) AS is_valid
        FROM votes
    )
    SELECT COUNT(*)::integer,
           COUNT(*) FILTER (WHERE is_valid)::integer,
           COUNT(DISTINCT uid_text) FILTER (WHERE is_valid)::integer,
           COALESCE(
             BOOL_OR(is_valid AND uid_text = approval_record.decided_by::text),
             FALSE
           )
      INTO vote_count, valid_vote_count, distinct_vote_count, deciding_actor_voted
      FROM validated;
  END IF;

  IF approval_record.status <> 'approved'
     OR approval_record.approval_kind <> 'clinical_continuity_policy_governance'
     OR approval_record.subject_resource_type IS DISTINCT FROM 'clinical_continuity_policy_version'
     OR approval_record.subject_resource_id IS DISTINCT FROM policy_record.id::text
     OR approval_record.decided_by IS NULL
     OR approval_record.decided_at IS NULL
     OR policy_record.approved_by IS DISTINCT FROM approval_record.decided_by
     OR policy_record.approved_at < approval_record.decided_at
     OR approval_record.required_approvers <= 0
     OR vote_count = 0
     OR vote_count <> valid_vote_count
     OR vote_count <> distinct_vote_count
     OR distinct_vote_count < approval_record.required_approvers
     OR NOT deciding_actor_voted
     OR approval_record.metadata #>> ARRAY[
          'clinical_continuity_policy_governance', 'policy_checksum'
        ] IS DISTINCT FROM policy_record.policy_checksum::text
     OR approval_record.metadata #>> ARRAY[
          'clinical_continuity_policy_governance', 'countersignature_complete'
        ] IS DISTINCT FROM 'true'
  THEN
    RAISE EXCEPTION 'clinical continuity policy has invalid approval or countersignature evidence'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(approval_record.approved_by) AS vote(entry)
      LEFT JOIN users AS voter
        ON voter.tenant_id = approval_record.tenant_id
       AND voter.uid::text = vote.entry ->> 'uid'
     WHERE voter.uid IS NULL
        OR voter.is_active IS DISTINCT FROM TRUE
        OR voter.status IS DISTINCT FROM 'active'
        OR voter.is_deleted IS DISTINCT FROM FALSE
        OR voter.deleted_at IS NOT NULL
        OR NULLIF(BTRIM(voter.role), '') IS NULL
        OR UPPER(voter.role) = 'PATIENT'
  ) THEN
    RAISE EXCEPTION 'clinical continuity approvers must be active non-patient tenant users'
      USING ERRCODE = '23514';
  END IF;

  SELECT key.*
    INTO policy_key
    FROM encryption_keys AS key
   WHERE key.tenant_id = policy_record.tenant_id
     AND key.key_id = policy_record.policy_signing_key_id;

  SELECT key.*
    INTO current_key
    FROM encryption_keys AS key
   WHERE key.tenant_id = policy_record.tenant_id
     AND key.key_id = policy_record.current_pack_signing_key_id;

  IF policy_key.id IS NULL
     OR LOWER(policy_key.algorithm) <> 'ed25519'
     OR policy_key.status NOT IN ('active', 'retiring')
     OR policy_key.metadata ->> 'purpose' IS DISTINCT FROM 'clinical_continuity_policy_signing'
     OR ENCODE(
          SHA256(CONVERT_TO(policy_key.metadata ->> 'public_key_spki_pem', 'UTF8')),
          'hex'
        ) IS DISTINCT FROM BTRIM(policy_record.policy_signing_public_key_sha256)
     OR current_key.id IS NULL
     OR LOWER(current_key.algorithm) <> 'ed25519'
     OR current_key.status NOT IN ('active', 'retiring')
     OR current_key.metadata ->> 'purpose' IS DISTINCT FROM 'clinical_continuity_pack_signing'
     OR ENCODE(
          SHA256(CONVERT_TO(current_key.metadata ->> 'public_key_spki_pem', 'UTF8')),
          'hex'
        ) IS DISTINCT FROM BTRIM(policy_record.current_pack_signing_public_key_sha256)
     OR policy_record.revoked_key_ids ? policy_record.policy_signing_key_id
     OR policy_record.revoked_key_ids ? policy_record.current_pack_signing_key_id
  THEN
    RAISE EXCEPTION 'clinical continuity policy references an unusable or revoked signing key'
      USING ERRCODE = '23514';
  END IF;

  IF policy_record.next_pack_signing_key_id IS NOT NULL THEN
    SELECT key.*
      INTO next_key
      FROM encryption_keys AS key
     WHERE key.tenant_id = policy_record.tenant_id
       AND key.key_id = policy_record.next_pack_signing_key_id;

    IF next_key.id IS NULL
       OR LOWER(next_key.algorithm) <> 'ed25519'
       OR next_key.status <> 'active'
       OR next_key.metadata ->> 'purpose' IS DISTINCT FROM 'clinical_continuity_pack_signing'
       OR ENCODE(
            SHA256(CONVERT_TO(next_key.metadata ->> 'public_key_spki_pem', 'UTF8')),
            'hex'
          ) IS DISTINCT FROM BTRIM(policy_record.next_pack_signing_public_key_sha256)
       OR policy_record.revoked_key_ids ? policy_record.next_pack_signing_key_id
    THEN
      RAISE EXCEPTION 'clinical continuity policy next signing key is unusable or revoked'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF policy_record.lifecycle_state = 'active'
     AND (
       current_key.status <> 'active'
       OR policy_record.effective_from > NOW()
       OR (
         policy_record.effective_until IS NOT NULL
         AND policy_record.effective_until <= NOW()
       )
     )
  THEN
    RAISE EXCEPTION 'active clinical continuity policy is outside its effective window or current key is not active'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_policy_approval_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM clinical_continuity_assert_policy_approval(NEW.tenant_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_policy_guard_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clinical continuity policy versions are append-only'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.policy_schema_version IS DISTINCT FROM OLD.policy_schema_version
     OR NEW.policy_document IS DISTINCT FROM OLD.policy_document
     OR NEW.policy_checksum IS DISTINCT FROM OLD.policy_checksum
     OR NEW.canonicalization IS DISTINCT FROM OLD.canonicalization
     OR NEW.signature_algorithm IS DISTINCT FROM OLD.signature_algorithm
     OR NEW.policy_signing_key_id IS DISTINCT FROM OLD.policy_signing_key_id
     OR NEW.policy_signing_public_key_sha256
          IS DISTINCT FROM OLD.policy_signing_public_key_sha256
     OR NEW.current_pack_signing_key_id IS DISTINCT FROM OLD.current_pack_signing_key_id
     OR NEW.current_pack_signing_public_key_sha256
          IS DISTINCT FROM OLD.current_pack_signing_public_key_sha256
     OR NEW.next_pack_signing_key_id IS DISTINCT FROM OLD.next_pack_signing_key_id
     OR NEW.next_pack_signing_public_key_sha256
          IS DISTINCT FROM OLD.next_pack_signing_public_key_sha256
     OR NEW.policy_signature IS DISTINCT FROM OLD.policy_signature
     OR NEW.revocation_epoch IS DISTINCT FROM OLD.revocation_epoch
     OR NEW.revoked_key_ids IS DISTINCT FROM OLD.revoked_key_ids
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.supersedes_policy_id IS DISTINCT FROM OLD.supersedes_policy_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'clinical continuity policy content and version identity are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.lifecycle_state <> 'draft'
     AND (
       NEW.approval_id IS DISTINCT FROM OLD.approval_id
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     )
  THEN
    RAISE EXCEPTION 'clinical continuity approval evidence is immutable after approval'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'approved' THEN
    IF NEW.effective_until IS DISTINCT FROM OLD.effective_until
       OR NEW.retired_by IS NOT NULL
       OR NEW.retired_at IS NOT NULL
       OR NEW.retirement_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'draft approval may change only lifecycle and approval evidence'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.lifecycle_state = 'approved' AND NEW.lifecycle_state = 'active' THEN
    IF NEW.effective_until IS DISTINCT FROM OLD.effective_until
       OR NEW.retired_by IS NOT NULL
       OR NEW.retired_at IS NOT NULL
       OR NEW.retirement_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'policy activation may change only lifecycle state'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.lifecycle_state IN ('approved', 'active')
        AND NEW.lifecycle_state = 'retired' THEN
    IF NEW.retired_by IS NULL
       OR NEW.retired_at IS NULL
       OR NULLIF(BTRIM(NEW.retirement_reason), '') IS NULL
       OR NEW.effective_until IS NULL
       OR NEW.effective_until > NEW.retired_at
       OR NOT EXISTS (
         SELECT 1
           FROM users AS retiring_actor
          WHERE retiring_actor.tenant_id = NEW.tenant_id
            AND retiring_actor.uid = NEW.retired_by
            AND retiring_actor.is_active = TRUE
            AND retiring_actor.status = 'active'
            AND retiring_actor.is_deleted = FALSE
            AND retiring_actor.deleted_at IS NULL
            AND NULLIF(BTRIM(retiring_actor.role), '') IS NOT NULL
            AND UPPER(retiring_actor.role) <> 'PATIENT'
       )
    THEN
      RAISE EXCEPTION 'policy retirement requires exact terminal evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid clinical continuity policy lifecycle transition'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_block_approval_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.approval_kind = 'clinical_continuity_policy_governance'
     AND OLD.status = 'approved'
  THEN
    RAISE EXCEPTION 'approved clinical continuity approval evidence is immutable'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_assert_snapshot_governance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  policy_record public.clinical_continuity_policy_versions%ROWTYPE;
  signing_key public.encryption_keys%ROWTYPE;
  expected_signing_public_key_sha256 TEXT;
BEGIN
  IF NEW.scope <> 'clinical_continuity_pack' THEN
    RETURN NEW;
  END IF;

  SELECT policy.*
    INTO policy_record
    FROM public.clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = NEW.tenant_id
     AND policy.facility_id = NEW.facility_id
     AND policy.id = NEW.policy_version_id
     AND policy.policy_version = NEW.policy_version
   FOR KEY SHARE;

  IF NOT FOUND
     OR policy_record.lifecycle_state <> 'active'
     OR policy_record.effective_from > NEW.generated_at
     OR policy_record.effective_from > NOW()
     OR (
       policy_record.effective_until IS NOT NULL
       AND (
         policy_record.effective_until <= NEW.published_at
         OR policy_record.effective_until <= NOW()
       )
     )
  THEN
    RAISE EXCEPTION 'clinical continuity publication requires the exact current effective policy'
      USING ERRCODE = '23514';
  END IF;

  IF (
       NEW.signing_key_id IS DISTINCT FROM policy_record.current_pack_signing_key_id
       AND NEW.signing_key_id IS DISTINCT FROM policy_record.next_pack_signing_key_id
     )
     OR policy_record.revoked_key_ids ? NEW.signing_key_id
  THEN
    RAISE EXCEPTION 'clinical continuity publication signing key is not authorized by policy'
      USING ERRCODE = '23514';
  END IF;

  expected_signing_public_key_sha256 := CASE
    WHEN NEW.signing_key_id = policy_record.current_pack_signing_key_id
      THEN BTRIM(policy_record.current_pack_signing_public_key_sha256)
    ELSE BTRIM(policy_record.next_pack_signing_public_key_sha256)
  END;

  SELECT key.*
    INTO signing_key
    FROM public.encryption_keys AS key
   WHERE key.tenant_id = NEW.tenant_id
     AND key.key_id = NEW.signing_key_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR LOWER(signing_key.algorithm) <> 'ed25519'
     OR signing_key.status <> 'active'
     OR signing_key.metadata ->> 'purpose'
          IS DISTINCT FROM 'clinical_continuity_pack_signing'
     OR ENCODE(
          SHA256(CONVERT_TO(signing_key.metadata ->> 'public_key_spki_pem', 'UTF8')),
          'hex'
        ) IS DISTINCT FROM expected_signing_public_key_sha256
  THEN
    RAISE EXCEPTION 'clinical continuity publication signing key is unusable or compromised'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_snapshot_guard_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.scope = 'clinical_continuity_pack' THEN
      RAISE EXCEPTION 'clinical continuity publication evidence cannot be deleted'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.scope <> 'clinical_continuity_pack'
     AND NEW.scope <> 'clinical_continuity_pack'
  THEN
    RETURN NEW;
  END IF;

  IF OLD.scope <> 'clinical_continuity_pack'
     OR NEW.scope <> 'clinical_continuity_pack'
     OR OLD.payload_purged_at IS NOT NULL
     OR NEW.payload <> '{}'::jsonb
     OR NEW.payload_purged_at IS NULL
     OR NEW.payload_purged_at < OLD.retention_until
     OR NOW() < OLD.retention_until
     OR NULLIF(BTRIM(NEW.payload_purge_reason), '') IS NULL
     OR (
       to_jsonb(NEW) - ARRAY['payload', 'payload_purged_at', 'payload_purge_reason']
     ) IS DISTINCT FROM (
       to_jsonb(OLD) - ARRAY['payload', 'payload_purged_at', 'payload_purge_reason']
     )
  THEN
    RAISE EXCEPTION 'clinical continuity snapshots are immutable except for governed post-retention PHI purge'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_purge_snapshot_payload(
  target_tenant_id UUID,
  target_facility_id INTEGER,
  target_snapshot_id INTEGER,
  purge_reason TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_id INTEGER;
BEGIN
  IF target_tenant_id IS NULL
     OR target_tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
     OR target_facility_id IS NULL
     OR NULLIF(BTRIM(purge_reason), '') IS NULL
  THEN
    RAISE EXCEPTION 'tenant, facility, snapshot, and purge reason are required'
      USING ERRCODE = '22023';
  END IF;

  UPDATE downtime_snapshots
     SET payload = '{}'::jsonb,
         payload_purged_at = NOW(),
         payload_purge_reason = BTRIM(purge_reason)
   WHERE id = target_snapshot_id
     AND tenant_id = target_tenant_id
     AND facility_id = target_facility_id
     AND scope = 'clinical_continuity_pack'
     AND payload_purged_at IS NULL
     AND retention_until <= NOW()
  RETURNING id INTO purged_id;

  IF purged_id IS NULL THEN
    RAISE EXCEPTION 'eligible clinical continuity snapshot not found for purge'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN purged_id;
END;
$$;

-- A no-transaction migration commits each top-level statement. Keep every
-- guard replacement inside one statement so a replay never exposes a table
-- between DROP and CREATE.
DO $cc_trigger_replacement$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_policy_version_monotonic
             ON clinical_continuity_policy_versions';
  EXECUTE $trigger$
    CREATE TRIGGER trg_cc_policy_version_monotonic
      BEFORE INSERT ON clinical_continuity_policy_versions
      FOR EACH ROW EXECUTE FUNCTION clinical_continuity_policy_guard_version()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_policy_lifecycle
             ON clinical_continuity_policy_versions';
  EXECUTE $trigger$
    CREATE TRIGGER trg_cc_policy_lifecycle
      BEFORE UPDATE OR DELETE ON clinical_continuity_policy_versions
      FOR EACH ROW EXECUTE FUNCTION clinical_continuity_policy_guard_lifecycle()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_policy_approval_evidence
             ON clinical_continuity_policy_versions';
  EXECUTE $trigger$
    CREATE CONSTRAINT TRIGGER trg_cc_policy_approval_evidence
      AFTER INSERT OR UPDATE ON clinical_continuity_policy_versions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION clinical_continuity_policy_approval_constraint()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_approvals_cc_policy_immutable
             ON approvals';
  EXECUTE $trigger$
    CREATE TRIGGER trg_approvals_cc_policy_immutable
      BEFORE UPDATE OR DELETE ON approvals
      FOR EACH ROW EXECUTE FUNCTION clinical_continuity_block_approval_mutation()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_downtime_cc_immutable
             ON downtime_snapshots';
  EXECUTE $trigger$
    CREATE TRIGGER trg_downtime_cc_immutable
      BEFORE UPDATE OR DELETE ON downtime_snapshots
      FOR EACH ROW EXECUTE FUNCTION clinical_continuity_snapshot_guard_mutation()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_downtime_cc_governance
             ON downtime_snapshots';
  EXECUTE $trigger$
    CREATE TRIGGER trg_downtime_cc_governance
      BEFORE INSERT ON downtime_snapshots
      FOR EACH ROW EXECUTE FUNCTION clinical_continuity_assert_snapshot_governance()
  $trigger$;
END
$cc_trigger_replacement$;

-- ---------------------------------------------------------------------------
-- Pattern-A RLS plus restrictive explicit-context policies.
-- ---------------------------------------------------------------------------

ALTER TABLE clinical_continuity_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_continuity_policy_versions FORCE ROW LEVEL SECURITY;

ALTER TABLE downtime_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE downtime_snapshots FORCE ROW LEVEL SECURITY;

DO $cc_policy_replacement$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation
             ON clinical_continuity_policy_versions';
  EXECUTE $policy$
    CREATE POLICY tenant_isolation
      ON clinical_continuity_policy_versions
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

  EXECUTE 'DROP POLICY IF EXISTS cc_policy_explicit_context
             ON clinical_continuity_policy_versions';
  EXECUTE $policy$
    CREATE POLICY cc_policy_explicit_context
      ON clinical_continuity_policy_versions
      AS RESTRICTIVE
      FOR ALL
      USING (
        tenant_id = app_current_tenant_id_uuid()
      )
      WITH CHECK (
        tenant_id = app_current_tenant_id_uuid()
      )
  $policy$;

  EXECUTE 'DROP POLICY IF EXISTS downtime_cc_explicit_tenant
             ON downtime_snapshots';
  EXECUTE $policy$
    CREATE POLICY downtime_cc_explicit_tenant
      ON downtime_snapshots
      AS RESTRICTIVE
      FOR ALL
      USING (
        scope <> 'clinical_continuity_pack'
        OR tenant_id = app_current_tenant_id_uuid()
      )
      WITH CHECK (
        scope <> 'clinical_continuity_pack'
        OR tenant_id = app_current_tenant_id_uuid()
      )
  $policy$;
END
$cc_policy_replacement$;

-- ---------------------------------------------------------------------------
-- Least privilege for known application roles. Legacy ward_pack retention
-- still needs table DELETE; trg_downtime_cc_immutable rejects it for continuity
-- evidence. Boot-time broad grants are followed by matching revokes in
-- src/lib/prisma.js.
-- ---------------------------------------------------------------------------

DO $cc_runtime_grants$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT ON TABLE clinical_continuity_policy_versions TO %I',
        role_name
      );
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE clinical_continuity_policy_versions FROM %I',
        role_name
      );
      EXECUTE format(
        'GRANT SELECT, INSERT, DELETE ON TABLE downtime_snapshots TO %I',
        role_name
      );
      EXECUTE format(
        'REVOKE UPDATE, TRUNCATE ON TABLE downtime_snapshots FROM %I',
        role_name
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE downtime_snapshots_id_seq, clinical_continuity_manifest_version_seq TO %I',
        role_name
      );
      EXECUTE format(
        'REVOKE UPDATE ON SEQUENCE downtime_snapshots_id_seq, clinical_continuity_manifest_version_seq FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES
           ON FUNCTION clinical_continuity_parse_timestamp(text),
                       clinical_continuity_policy_guard_version(),
                       clinical_continuity_assert_policy_approval(uuid, uuid),
                       clinical_continuity_policy_approval_constraint(),
                       clinical_continuity_policy_guard_lifecycle(),
                       clinical_continuity_block_approval_mutation(),
                       clinical_continuity_assert_snapshot_governance(),
                       clinical_continuity_snapshot_guard_mutation(),
                       clinical_continuity_purge_snapshot_payload(uuid, integer, integer, text)
         FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$cc_runtime_grants$;

REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_parse_timestamp(text)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_policy_guard_version()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_assert_policy_approval(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_policy_approval_constraint()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_policy_guard_lifecycle()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_block_approval_mutation()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_assert_snapshot_governance()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_snapshot_guard_mutation()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_purge_snapshot_payload(uuid, integer, integer, text)
  FROM PUBLIC;

RESET lock_timeout;
RESET statement_timeout;
