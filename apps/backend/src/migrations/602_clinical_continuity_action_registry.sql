-- Clinical Service Continuity C4.2: signed action-registry policy extension.
--
-- @no-transaction
--
-- This migration is additive and inert. It extends the existing C3.1 policy
-- substrate; it does not create or activate a policy, registry, key, approval,
-- capture action, replay receipt, or client capability.

SET lock_timeout = '10s';
SET statement_timeout = '60s';

ALTER TABLE clinical_continuity_policy_versions
  ADD COLUMN IF NOT EXISTS action_registry_schema_version INTEGER,
  ADD COLUMN IF NOT EXISTS action_registry_version BIGINT,
  ADD COLUMN IF NOT EXISTS action_registry_checksum CHAR(64);

DO $cc_action_registry_constraints$
BEGIN
  ALTER TABLE clinical_continuity_policy_versions
    DROP CONSTRAINT IF EXISTS cc_policy_action_registry_shape_check;

  ALTER TABLE clinical_continuity_policy_versions
    ADD CONSTRAINT cc_policy_action_registry_shape_check
    CHECK (
      (
        policy_schema_version <> 3
        AND action_registry_schema_version IS NULL
        AND action_registry_version IS NULL
        AND action_registry_checksum IS NULL
        AND NOT (policy_document ? 'actionRegistry')
      )
      OR
      (
        policy_schema_version = 3
        AND action_registry_schema_version = 1
        AND action_registry_version > 0
        AND action_registry_checksum ~ '^[0-9a-f]{64}$'
        AND effective_until IS NOT NULL
        AND jsonb_typeof(policy_document -> 'actionRegistry') = 'object'
        AND jsonb_typeof(policy_document #> '{actionRegistry,actions}') = 'array'
        AND jsonb_array_length(policy_document #> '{actionRegistry,actions}') = 17
        AND jsonb_typeof(policy_document #> '{actionRegistry,compatibilityRules}') = 'array'
        AND policy_document #>> '{actionRegistry,registrySchemaVersion}'
              = action_registry_schema_version::text
        AND policy_document #>> '{actionRegistry,registryVersion}'
              = action_registry_version::text
        AND policy_document #>> '{actionRegistry,registryChecksum}'
              = BTRIM(action_registry_checksum)
        AND clinical_continuity_parse_timestamp(
              policy_document #>> '{actionRegistry,issuedAt}'
            ) = effective_from
        AND clinical_continuity_parse_timestamp(
              policy_document #>> '{actionRegistry,expiresAt}'
            ) = effective_until
        AND policy_document #>> '{actionRegistry,approvalEvidence,decisionId}' = 'C-D3'
        AND policy_document #>> '{actionRegistry,approvalEvidence,countersignedAt}'
              = '2026-07-30'
        AND policy_document #>> '{actionRegistry,approvalEvidence,source}'
              = 'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix'
      )
    );
END
$cc_action_registry_constraints$;

CREATE INDEX IF NOT EXISTS idx_cc_policy_action_registry
  ON clinical_continuity_policy_versions (
    tenant_id, facility_id, action_registry_version, policy_version DESC
  )
  WHERE action_registry_version IS NOT NULL;

CREATE OR REPLACE FUNCTION clinical_continuity_action_registry_guard_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_registry clinical_continuity_policy_versions%ROWTYPE;
BEGIN
  IF NEW.policy_schema_version <> 3 THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.tenant_id::text || ':' || NEW.facility_id::text, 0)
  );

  SELECT policy.*
    INTO previous_registry
    FROM clinical_continuity_policy_versions AS policy
   WHERE policy.tenant_id = NEW.tenant_id
     AND policy.facility_id = NEW.facility_id
     AND policy.action_registry_version IS NOT NULL
   ORDER BY policy.action_registry_version DESC,
            policy.policy_version DESC,
            policy.created_at DESC,
            policy.id DESC
   LIMIT 1;

  IF FOUND THEN
    IF NEW.action_registry_version < previous_registry.action_registry_version THEN
      RAISE EXCEPTION 'clinical continuity action-registry version cannot roll back'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.action_registry_version = previous_registry.action_registry_version
       AND NEW.action_registry_checksum IS DISTINCT FROM
             previous_registry.action_registry_checksum
    THEN
      RAISE EXCEPTION 'clinical continuity action-registry checksum changed without a new version'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.action_registry_version > previous_registry.action_registry_version
       AND NEW.action_registry_checksum IS NOT DISTINCT FROM
             previous_registry.action_registry_checksum
    THEN
      RAISE EXCEPTION 'clinical continuity action-registry version changed without new content'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_action_registry_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action_registry_schema_version IS DISTINCT FROM
       OLD.action_registry_schema_version
     OR NEW.action_registry_version IS DISTINCT FROM OLD.action_registry_version
     OR NEW.action_registry_checksum IS DISTINCT FROM OLD.action_registry_checksum
  THEN
    RAISE EXCEPTION 'clinical continuity action-registry binding is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clinical_continuity_action_registry_approval_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  approval_record approvals%ROWTYPE;
BEGIN
  IF NEW.policy_schema_version <> 3 OR NEW.lifecycle_state = 'draft' THEN
    RETURN NEW;
  END IF;

  SELECT approval.*
    INTO approval_record
    FROM approvals AS approval
   WHERE approval.tenant_id = NEW.tenant_id
     AND approval.id = NEW.approval_id;

  IF NOT FOUND
     OR approval_record.metadata #>> ARRAY[
          'clinical_continuity_policy_governance', 'action_registry_schema_version'
        ] IS DISTINCT FROM NEW.action_registry_schema_version::text
     OR approval_record.metadata #>> ARRAY[
          'clinical_continuity_policy_governance', 'action_registry_version'
        ] IS DISTINCT FROM NEW.action_registry_version::text
     OR approval_record.metadata #>> ARRAY[
          'clinical_continuity_policy_governance', 'action_registry_checksum'
        ] IS DISTINCT FROM BTRIM(NEW.action_registry_checksum)
     OR approval_record.metadata #>> ARRAY[
          'clinical_continuity_policy_governance', 'action_registry_decision_id'
        ] IS DISTINCT FROM 'C-D3'
  THEN
    RAISE EXCEPTION 'clinical continuity action registry lacks exact approval evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DO $cc_action_registry_trigger_replacement$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_action_registry_version
             ON clinical_continuity_policy_versions';
  EXECUTE $trigger$
    CREATE TRIGGER trg_cc_action_registry_version
      BEFORE INSERT ON clinical_continuity_policy_versions
      FOR EACH ROW
      EXECUTE FUNCTION clinical_continuity_action_registry_guard_version()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_action_registry_immutable
             ON clinical_continuity_policy_versions';
  EXECUTE $trigger$
    CREATE TRIGGER trg_cc_action_registry_immutable
      BEFORE UPDATE ON clinical_continuity_policy_versions
      FOR EACH ROW
      EXECUTE FUNCTION clinical_continuity_action_registry_guard_update()
  $trigger$;

  EXECUTE 'DROP TRIGGER IF EXISTS trg_cc_action_registry_approval
             ON clinical_continuity_policy_versions';
  EXECUTE $trigger$
    CREATE CONSTRAINT TRIGGER trg_cc_action_registry_approval
      AFTER INSERT OR UPDATE ON clinical_continuity_policy_versions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION clinical_continuity_action_registry_approval_constraint()
  $trigger$;
END
$cc_action_registry_trigger_replacement$;

-- C4.2 adds no tenant-bearing table. Reassert the inherited C3.1 table posture:
-- tenant/facility FKs and tenant-aware uniqueness remain authoritative, and
-- absent/empty/bypass tenant GUCs match no rows through the restrictive policy.
ALTER TABLE clinical_continuity_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_continuity_policy_versions FORCE ROW LEVEL SECURITY;

DO $cc_action_registry_rls_assertion$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policy
     WHERE polrelid = 'clinical_continuity_policy_versions'::regclass
       AND polname = 'cc_policy_explicit_context'
       AND polpermissive = FALSE
  ) THEN
    RAISE EXCEPTION 'C4.2 requires the C3.1 restrictive continuity policy'
      USING ERRCODE = '23514';
  END IF;
END
$cc_action_registry_rls_assertion$;

DO $cc_action_registry_runtime_grants$
DECLARE
  role_name TEXT;
BEGIN
  REVOKE ALL PRIVILEGES
    ON TABLE clinical_continuity_policy_versions
  FROM PUBLIC;

  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT ON TABLE clinical_continuity_policy_versions TO %I',
        role_name
      );
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE
           ON TABLE clinical_continuity_policy_versions
         FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES
           ON FUNCTION clinical_continuity_action_registry_guard_version(),
                       clinical_continuity_action_registry_guard_update(),
                       clinical_continuity_action_registry_approval_constraint()
         FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$cc_action_registry_runtime_grants$;

REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_action_registry_guard_version()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_action_registry_guard_update()
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON FUNCTION clinical_continuity_action_registry_approval_constraint()
  FROM PUBLIC;

RESET lock_timeout;
RESET statement_timeout;
