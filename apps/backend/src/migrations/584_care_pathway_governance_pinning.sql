-- Unified Care Pathways S1b-b: immutable governance and runtime definition pins.
--
-- This migration does not publish a definition, register a handler, or activate
-- a tenant pathway mode. It closes the governance and replay gaps left by the
-- dormant execution spine in migration 580.

-- Keep the maintenance cutover free of writer races while published evidence
-- is checked and runtime pins are backfilled. The order is stable across runs.
LOCK TABLE users,
  workflow_definitions,
  care_pathway_definition_governance,
  approvals,
  workflow_runs,
  care_pathway_instances,
  clinical_timeline_events,
  clinical_audit_events,
  care_pathway_transition_events
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE care_pathway_definition_governance
  ADD COLUMN retired_by UUID,
  ADD COLUMN retired_at TIMESTAMPTZ(6),
  ADD COLUMN retirement_reason TEXT;

ALTER TABLE workflow_runs
  ADD COLUMN pathway_governance_id UUID,
  ADD COLUMN pathway_definition_checksum CHAR(64);

ALTER TABLE care_pathway_instances
  ADD COLUMN workflow_definition_id INTEGER,
  ADD COLUMN definition_governance_id UUID,
  ADD COLUMN definition_checksum CHAR(64);

-- Published governance must already carry an exact immutable checksum receipt
-- in its referenced approval. Missing historical evidence is not synthesized.
DO $care_pathway_governance_receipt_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM care_pathway_definition_governance AS governance
      LEFT JOIN approvals AS approval
        ON approval.tenant_id = governance.tenant_id
       AND approval.id = governance.approval_id
     WHERE governance.governance_status IN ('approved', 'retired')
       AND (
         approval.id IS NULL
         OR jsonb_typeof(
              approval.metadata -> 'care_pathway_definition_governance'
            ) IS DISTINCT FROM 'object'
         OR jsonb_typeof(
              approval.metadata #> ARRAY[
                'care_pathway_definition_governance',
                'definition_checksum'
              ]
            ) IS DISTINCT FROM 'string'
         OR approval.metadata #>> ARRAY[
              'care_pathway_definition_governance',
              'definition_checksum'
            ] IS DISTINCT FROM governance.definition_checksum::text
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'migration 584 blocked: published pathway governance lacks an exact immutable approval checksum receipt',
      HINT = 'Reconcile the approval evidence before retrying. Migration 584 never infers or mints clinical governance approval evidence.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM care_pathway_definition_governance
     WHERE governance_status = 'retired'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'migration 584 blocked: historical retired pathway governance lacks typed retirement evidence',
      HINT = 'Reconcile retired_by, retired_at, retirement_reason, and effective_until before retrying; no retirement evidence is inferred.';
  END IF;
END
$care_pathway_governance_receipt_preflight$;

-- Every existing pathway companion is backfilled only from its single immutable
-- creation event and the currently referenced published governance record. The
-- temporary proof set is reused by both updates so preflight and backfill cannot
-- drift to different predicates.
CREATE TEMPORARY TABLE care_pathway_584_exact_pins
ON COMMIT DROP
AS
SELECT instance.tenant_id,
       instance.id AS pathway_instance_id,
       run.id AS workflow_run_id,
       definition.id AS workflow_definition_id,
       governance.id AS definition_governance_id,
       governance.definition_checksum::char(64) AS definition_checksum
  FROM care_pathway_instances AS instance
  JOIN workflow_runs AS run
    ON run.tenant_id = instance.tenant_id
   AND run.id = instance.workflow_run_id
  JOIN workflow_definitions AS definition
    ON definition.tenant_id = run.tenant_id
   AND definition.id = run.workflow_definition_id
   AND definition.workflow_key = run.workflow_key
   AND definition.version = run.workflow_version
  JOIN care_pathway_definition_governance AS governance
    ON governance.tenant_id = definition.tenant_id
   AND governance.workflow_definition_id = definition.id
   AND governance.governance_status IN ('approved', 'retired')
   AND governance.definition_checksum ~ '^[0-9a-f]{64}$'
  JOIN approvals AS approval
    ON approval.tenant_id = governance.tenant_id
   AND approval.id = governance.approval_id
   AND jsonb_typeof(
         approval.metadata -> 'care_pathway_definition_governance'
       ) = 'object'
   AND approval.metadata #>> ARRAY[
         'care_pathway_definition_governance', 'definition_checksum'
       ] = governance.definition_checksum::text
  JOIN care_pathway_transition_events AS event
    ON event.tenant_id = instance.tenant_id
   AND event.pathway_instance_id = instance.id
   AND event.patient_uid = instance.patient_uid
   AND event.workflow_run_id = run.id
   AND event.sequence_number = 1
   AND event.transition_scope = 'pathway'
   AND event.transition_key = 'pathway_instance_created'
   AND event.idempotency_key = instance.idempotency_key
   AND event.effect_ordinal = 0
   AND event.canonical_timeline_event_id IS NOT NULL
   AND event.canonical_audit_event_id IS NOT NULL
   AND jsonb_typeof(event.event_payload->'event_id') = 'string'
   AND event.event_payload->>'event_id' = event.id::text
   AND jsonb_typeof(event.event_payload->'tenant_id') = 'string'
   AND event.event_payload->>'tenant_id' = event.tenant_id::text
   AND jsonb_typeof(event.event_payload->'pathway_instance_id') = 'string'
   AND event.event_payload->>'pathway_instance_id' = event.pathway_instance_id::text
   AND jsonb_typeof(event.event_payload->'patient_uid') = 'string'
   AND event.event_payload->>'patient_uid' = event.patient_uid::text
   AND jsonb_typeof(event.event_payload->'workflow_run_id') = 'number'
   AND event.event_payload->>'workflow_run_id' = event.workflow_run_id::text
   AND jsonb_typeof(event.event_payload->'sequence_number') = 'number'
   AND event.event_payload->>'sequence_number' = '1'
   AND jsonb_typeof(event.event_payload->'transition_scope') = 'string'
   AND event.event_payload->>'transition_scope' = event.transition_scope
   AND jsonb_typeof(event.event_payload->'transition_key') = 'string'
   AND event.event_payload->>'transition_key' = event.transition_key
   AND jsonb_typeof(event.event_payload->'idempotency_key') = 'string'
   AND event.event_payload->>'idempotency_key' = event.idempotency_key
   AND jsonb_typeof(event.event_payload->'command_fingerprint') = 'string'
   AND event.event_payload->>'command_fingerprint' = event.command_fingerprint::text
   AND jsonb_typeof(event.event_payload->'effect_ordinal') = 'number'
   AND event.event_payload->>'effect_ordinal' = '0'
   AND jsonb_typeof(event.event_payload->'workflow_definition_id') = 'number'
   AND event.event_payload->>'workflow_definition_id' = definition.id::text
   AND jsonb_typeof(event.event_payload->'governance_id') = 'string'
   AND event.event_payload->>'governance_id' = governance.id::text
   AND jsonb_typeof(event.event_payload->'definition_checksum') = 'string'
   AND event.event_payload->>'definition_checksum' = governance.definition_checksum::text
   AND jsonb_typeof(event.metadata->'pathway_runtime') = 'object'
   AND jsonb_typeof(
         event.metadata #> ARRAY['pathway_runtime', 'definition_checksum']
       ) = 'string'
   AND event.metadata #>> ARRAY['pathway_runtime', 'definition_checksum'] =
         governance.definition_checksum::text
   AND jsonb_typeof(event.metadata->'command_fingerprint') = 'string'
   AND event.metadata->>'command_fingerprint' = event.command_fingerprint::text
   AND jsonb_typeof(event.metadata->'effect_ordinal') = 'number'
   AND event.metadata->>'effect_ordinal' = '0'
  JOIN clinical_timeline_events AS timeline
    ON timeline.tenant_id = event.tenant_id
   AND timeline.id = event.canonical_timeline_event_id
   AND timeline.patient_uid = event.patient_uid
   AND timeline.encounter_id IS NOT DISTINCT FROM instance.encounter_id
   AND timeline.event_type = 'care_pathway.transition'
   AND timeline.event_status = event.transition_scope
   AND timeline.source_table = 'care_pathway_transition_events'
   AND timeline.source_id = event.id::text
   AND timeline.source_uid = event.id
   AND timeline.resource_type = 'care_pathway_transition_event'
   AND timeline.resource_id = event.id::text
   AND timeline.actor_uid IS NOT DISTINCT FROM event.actor_uid
   AND timeline.actor_role IS NOT DISTINCT FROM event.actor_role
   AND timeline.occurred_at = event.occurred_at
   AND timeline.visible_to_patient = FALSE
   AND timeline.payload = event.event_payload
   AND timeline.idempotency_key =
         'care_pathway_transition_events:' || event.id::text || ':timeline'
  JOIN clinical_audit_events AS audit
    ON audit.tenant_id = event.tenant_id
   AND audit.id = event.canonical_audit_event_id
   AND audit.patient_uid = event.patient_uid
   AND audit.encounter_id IS NOT DISTINCT FROM instance.encounter_id
   AND audit.action = 'care_pathway.transition'
   AND audit.action_status = 'success'
   AND audit.resource_type = 'care_pathway_transition_event'
   AND audit.resource_table = 'care_pathway_transition_events'
   AND audit.resource_id = event.id::text
   AND audit.actor_uid IS NOT DISTINCT FROM event.actor_uid
   AND audit.actor_role IS NOT DISTINCT FROM event.actor_role
   AND audit.before_state = event.previous_state
   AND audit.after_state = event.new_state
   AND audit.metadata = event.metadata
   AND audit.idempotency_key =
         'care_pathway_transition_events:' || event.id::text || ':audit'
   AND audit.occurred_at = event.occurred_at
 WHERE (
   SELECT COUNT(*)
     FROM care_pathway_transition_events AS candidate
    WHERE candidate.tenant_id = instance.tenant_id
      AND candidate.pathway_instance_id = instance.id
      AND candidate.transition_key = 'pathway_instance_created'
 ) = 1;

CREATE UNIQUE INDEX ux_care_pathway_584_exact_pins_instance
  ON care_pathway_584_exact_pins (tenant_id, pathway_instance_id);

DO $care_pathway_runtime_pin_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM care_pathway_instances AS instance
      LEFT JOIN care_pathway_584_exact_pins AS pin
        ON pin.tenant_id = instance.tenant_id
       AND pin.pathway_instance_id = instance.id
     WHERE pin.pathway_instance_id IS NULL
        OR (
          instance.workflow_definition_id IS NOT NULL
          AND instance.workflow_definition_id IS DISTINCT FROM pin.workflow_definition_id
        )
        OR (
          instance.definition_governance_id IS NOT NULL
          AND instance.definition_governance_id IS DISTINCT FROM pin.definition_governance_id
        )
        OR (
          instance.definition_checksum IS NOT NULL
          AND instance.definition_checksum IS DISTINCT FROM pin.definition_checksum
        )
        OR EXISTS (
          SELECT 1
            FROM workflow_runs AS run
           WHERE run.tenant_id = instance.tenant_id
             AND run.id = instance.workflow_run_id
             AND (
               (
                 run.pathway_governance_id IS NOT NULL
                 AND run.pathway_governance_id IS DISTINCT FROM
                       pin.definition_governance_id
               )
               OR
               (
                 run.pathway_definition_checksum IS NOT NULL
                 AND run.pathway_definition_checksum IS DISTINCT FROM
                       pin.definition_checksum
               )
             )
        )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'migration 584 blocked: pathway runtime definition pin cannot be proven from exact immutable creation evidence',
      HINT = 'Reconcile the single exact pathway_instance_created event, current published governance, approval checksum receipt, run identity, and instance identity before retrying.';
  END IF;
END
$care_pathway_runtime_pin_preflight$;

UPDATE workflow_runs AS run
   SET pathway_governance_id = pin.definition_governance_id,
       pathway_definition_checksum = pin.definition_checksum
  FROM care_pathway_584_exact_pins AS pin
 WHERE run.tenant_id = pin.tenant_id
   AND run.id = pin.workflow_run_id;

UPDATE care_pathway_instances AS instance
   SET workflow_definition_id = pin.workflow_definition_id,
       definition_governance_id = pin.definition_governance_id,
       definition_checksum = pin.definition_checksum
  FROM care_pathway_584_exact_pins AS pin
 WHERE instance.tenant_id = pin.tenant_id
   AND instance.id = pin.pathway_instance_id;

DO $care_pathway_runtime_pin_postflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM care_pathway_instances
     WHERE workflow_definition_id IS NULL
        OR definition_governance_id IS NULL
        OR definition_checksum IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'migration 584 blocked: pathway runtime definition pin backfill was incomplete';
  END IF;
END
$care_pathway_runtime_pin_postflight$;

ALTER TABLE care_pathway_instances
  ALTER COLUMN workflow_definition_id SET NOT NULL,
  ALTER COLUMN definition_governance_id SET NOT NULL,
  ALTER COLUMN definition_checksum SET NOT NULL;

ALTER TABLE care_pathway_definition_governance
  ADD CONSTRAINT care_pathway_governance_retirement_evidence_check
  CHECK (
    (
      governance_status = 'retired'
      AND retired_by IS NOT NULL
      AND retired_at IS NOT NULL
      AND NULLIF(BTRIM(retirement_reason), '') IS NOT NULL
      AND effective_until IS NOT NULL
      AND effective_until <= retired_at
      AND retired_at >= approved_at
    )
    OR
    (
      governance_status <> 'retired'
      AND retired_by IS NULL
      AND retired_at IS NULL
      AND retirement_reason IS NULL
    )
  );

ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_pathway_definition_pin_check
  CHECK (
    (
      pathway_governance_id IS NULL
      AND pathway_definition_checksum IS NULL
    )
    OR
    (
      workflow_definition_id IS NOT NULL
      AND pathway_governance_id IS NOT NULL
      AND pathway_definition_checksum ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE care_pathway_instances
  ADD CONSTRAINT care_pathway_instances_definition_checksum_check
  CHECK (definition_checksum ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX ux_care_pathway_governance_identity_pin
  ON care_pathway_definition_governance (
    tenant_id, id, workflow_definition_id, definition_checksum
  );

CREATE UNIQUE INDEX ux_workflow_runs_pathway_governance_pin
  ON workflow_runs (
    tenant_id, id, workflow_definition_id, pathway_governance_id,
    pathway_definition_checksum
  );

CREATE INDEX idx_workflow_runs_governance_pin
  ON workflow_runs (
    tenant_id, pathway_governance_id, workflow_definition_id,
    pathway_definition_checksum
  )
  WHERE pathway_governance_id IS NOT NULL;

CREATE INDEX idx_care_pathway_instances_definition_pin
  ON care_pathway_instances (
    tenant_id, workflow_run_id, workflow_definition_id,
    definition_governance_id, definition_checksum
  );

CREATE UNIQUE INDEX ux_care_pathway_instances_run_definition_pin
  ON care_pathway_instances (
    tenant_id, workflow_run_id, workflow_definition_id,
    definition_governance_id, definition_checksum
  );

CREATE INDEX idx_care_pathway_governance_retired_by
  ON care_pathway_definition_governance (tenant_id, retired_by)
  WHERE retired_by IS NOT NULL;

ALTER TABLE care_pathway_definition_governance
  ADD CONSTRAINT fk_care_pathway_governance_retired_by
  FOREIGN KEY (tenant_id, retired_by)
  REFERENCES users (tenant_id, uid)
  ON UPDATE NO ACTION ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE workflow_runs
  ADD CONSTRAINT fk_workflow_runs_pathway_governance_pin
  FOREIGN KEY (
    tenant_id, pathway_governance_id, workflow_definition_id,
    pathway_definition_checksum
  )
  REFERENCES care_pathway_definition_governance (
    tenant_id, id, workflow_definition_id, definition_checksum
  )
  ON UPDATE NO ACTION ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE care_pathway_instances
  ADD CONSTRAINT fk_care_pathway_instances_run_definition_pin
  FOREIGN KEY (
    tenant_id, workflow_run_id, workflow_definition_id,
    definition_governance_id, definition_checksum
  )
  REFERENCES workflow_runs (
    tenant_id, id, workflow_definition_id, pathway_governance_id,
    pathway_definition_checksum
  )
  ON UPDATE NO ACTION ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- All writes that can classify a workflow definition as governed, admit a
-- run, or change published evidence serialize on the same transaction-scoped
-- keys. Definition, approval, and row UPDATE/DELETE trigger acquisitions use
-- the fail-fast form: sorting within one call cannot impose a transaction-wide
-- order across multiple statements, and waiting after any earlier fence or row
-- lock could deadlock with an opposite-order transaction.
CREATE OR REPLACE FUNCTION care_pathway_definition_fence_key(
  target_tenant_id UUID,
  target_definition_id INTEGER
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT target_tenant_id::text
         || ':care_pathway:definition:'
         || target_definition_id::text
$$;

CREATE OR REPLACE FUNCTION care_pathway_approval_fence_key(
  target_tenant_id UUID,
  target_approval_id INTEGER
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT target_tenant_id::text
         || ':care_pathway:approval:'
         || target_approval_id::text
$$;

CREATE OR REPLACE FUNCTION care_pathway_creation_event_fence_key(
  target_tenant_id UUID,
  target_event_id UUID
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT target_tenant_id::text
         || ':care_pathway:creation_event:'
         || target_event_id::text
$$;

CREATE OR REPLACE FUNCTION care_pathway_acquire_serialization_fences(
  target_keys TEXT[],
  wait_for_fence BOOLEAN DEFAULT TRUE
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  fence_key TEXT;
  fence_acquired BOOLEAN;
BEGIN
  FOR fence_key IN
    SELECT DISTINCT candidate.key
      FROM unnest(COALESCE(target_keys, ARRAY[]::text[])) AS candidate(key)
     WHERE NULLIF(BTRIM(candidate.key), '') IS NOT NULL
     ORDER BY candidate.key
  LOOP
    IF wait_for_fence THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(fence_key, 0));
    ELSE
      SELECT pg_try_advisory_xact_lock(hashtextextended(fence_key, 0))
        INTO fence_acquired;
      IF fence_acquired IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION
          'care pathway serialization fence is busy; retry the transaction'
          USING ERRCODE = 'serialization_failure';
      END IF;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_lock_governance_users(
  target_tenant_id UUID,
  target_user_uids UUID[]
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM actor.uid
    FROM users AS actor
   WHERE actor.tenant_id = target_tenant_id
     AND actor.uid = ANY(COALESCE(target_user_uids, ARRAY[]::uuid[]))
   ORDER BY actor.uid
   FOR SHARE NOWAIT;
EXCEPTION
  WHEN lock_not_available THEN
    RAISE EXCEPTION
      'care pathway governance actor is changing; retry the transaction'
      USING ERRCODE = 'serialization_failure';
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_governance_serialization_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  definition_fence_keys TEXT[] := ARRAY[]::text[];
  approval_fence_keys TEXT[] := ARRAY[]::text[];
  publication_votes JSONB;
  publication_actor_uids UUID[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    definition_fence_keys := array_append(
      definition_fence_keys,
      care_pathway_definition_fence_key(OLD.tenant_id, OLD.workflow_definition_id)
    );
    IF OLD.approval_id IS NOT NULL THEN
      approval_fence_keys := array_append(
        approval_fence_keys,
        care_pathway_approval_fence_key(OLD.tenant_id, OLD.approval_id)
      );
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    definition_fence_keys := array_append(
      definition_fence_keys,
      care_pathway_definition_fence_key(NEW.tenant_id, NEW.workflow_definition_id)
    );
    IF NEW.approval_id IS NOT NULL THEN
      approval_fence_keys := array_append(
        approval_fence_keys,
        care_pathway_approval_fence_key(NEW.tenant_id, NEW.approval_id)
      );
    END IF;
  END IF;

  PERFORM care_pathway_acquire_serialization_fences(
    definition_fence_keys,
    FALSE
  );
  PERFORM care_pathway_acquire_serialization_fences(
    approval_fence_keys,
    FALSE
  );

  -- Lock every NEW current-duty actor before row FK checks. Publication adds
  -- its point-in-time voters; retirement replaces owners with retired_by.
  -- NOWAIT becomes retryable 40001 so a user-update transaction that will
  -- next write governance cannot form a user-to-definition lock inversion.
  IF TG_OP <> 'DELETE'
  THEN
    IF NEW.governance_status = 'approved'
       AND (
         TG_OP = 'INSERT'
         OR OLD.governance_status NOT IN ('approved', 'retired')
       )
    THEN
      SELECT approval.approved_by
        INTO publication_votes
        FROM approvals AS approval
       WHERE approval.tenant_id = NEW.tenant_id
         AND approval.id = NEW.approval_id;
    END IF;

    SELECT ARRAY_AGG(required_actor.uid ORDER BY required_actor.uid)
      INTO publication_actor_uids
      FROM (
        SELECT NEW.clinical_owner_uid AS uid
         WHERE NEW.governance_status <> 'retired'
        UNION
        SELECT NEW.operational_owner_uid
         WHERE NEW.governance_status <> 'retired'
        UNION
        SELECT NEW.retired_by
         WHERE NEW.governance_status = 'retired'
           AND NEW.retired_by IS NOT NULL
        UNION
        SELECT (vote.entry ->> 'uid')::uuid
          FROM jsonb_array_elements(
                 CASE
                   WHEN jsonb_typeof(publication_votes) = 'array'
                   THEN publication_votes
                   ELSE '[]'::jsonb
                 END
               ) AS vote(entry)
         WHERE vote.entry ->> 'uid' ~*
               '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) AS required_actor;

    PERFORM care_pathway_lock_governance_users(
      NEW.tenant_id,
      publication_actor_uids
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_00_care_pathway_governance_serialization
  BEFORE INSERT OR UPDATE OR DELETE ON care_pathway_definition_governance
  FOR EACH ROW EXECUTE FUNCTION care_pathway_governance_serialization_guard();

-- The exact approved checksum is part of the immutable approval receipt, not
-- mutable governance bookkeeping.
CREATE OR REPLACE FUNCTION care_pathway_assert_governance_checksum_receipt(
  target_tenant_id UUID,
  target_governance_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  governance_record care_pathway_definition_governance%ROWTYPE;
  approval_record approvals%ROWTYPE;
BEGIN
  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id;

  IF NOT FOUND
     OR governance_record.governance_status NOT IN ('approved', 'retired')
  THEN
    RETURN;
  END IF;

  PERFORM care_pathway_acquire_serialization_fences(ARRAY[
    care_pathway_approval_fence_key(
      governance_record.tenant_id,
      governance_record.approval_id
    )
  ]);

  -- Re-read after the fence. A concurrent approval writer that won the fence
  -- must be visible to this READ COMMITTED statement before validation.
  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id;

  SELECT approval.*
    INTO approval_record
    FROM approvals AS approval
   WHERE approval.tenant_id = governance_record.tenant_id
     AND approval.id = governance_record.approval_id;

  IF NOT FOUND
     OR jsonb_typeof(
          approval_record.metadata -> 'care_pathway_definition_governance'
        ) IS DISTINCT FROM 'object'
     OR jsonb_typeof(
          approval_record.metadata #> ARRAY[
            'care_pathway_definition_governance', 'definition_checksum'
          ]
        ) IS DISTINCT FROM 'string'
     OR approval_record.metadata #>> ARRAY[
          'care_pathway_definition_governance', 'definition_checksum'
        ] IS DISTINCT FROM governance_record.definition_checksum::text
  THEN
    RAISE EXCEPTION
      'published pathway governance approval checksum receipt is invalid'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_governance_checksum_receipt_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'care_pathway_definition_governance' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_governance_checksum_receipt(NEW.tenant_id, NEW.id);
    END IF;
  ELSE
    PERFORM care_pathway_assert_governance_checksum_receipt(governance.tenant_id, governance.id)
      FROM care_pathway_definition_governance AS governance
     WHERE governance.tenant_id = OLD.tenant_id
       AND governance.approval_id = OLD.id
       AND governance.governance_status IN ('approved', 'retired');

    IF TG_OP <> 'DELETE'
       AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id)
    THEN
      PERFORM care_pathway_assert_governance_checksum_receipt(governance.tenant_id, governance.id)
        FROM care_pathway_definition_governance AS governance
       WHERE governance.tenant_id = NEW.tenant_id
         AND governance.approval_id = NEW.id
         AND governance.governance_status IN ('approved', 'retired');
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_pathway_governance_checksum_receipt
  AFTER INSERT OR UPDATE ON care_pathway_definition_governance
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_governance_checksum_receipt_constraint();

CREATE CONSTRAINT TRIGGER trg_approvals_pathway_governance_checksum_receipt
  AFTER UPDATE OR DELETE ON approvals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_governance_checksum_receipt_constraint();

CREATE OR REPLACE FUNCTION care_pathway_block_published_approval_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM care_pathway_acquire_serialization_fences(
    ARRAY[
      care_pathway_approval_fence_key(OLD.tenant_id, OLD.id),
      CASE
        WHEN TG_OP = 'UPDATE'
        THEN care_pathway_approval_fence_key(NEW.tenant_id, NEW.id)
        ELSE NULL
      END
    ],
    FALSE
  );

  IF EXISTS (
    SELECT 1
      FROM care_pathway_definition_governance AS governance
     WHERE governance.tenant_id = OLD.tenant_id
       AND governance.approval_id = OLD.id
       AND governance.governance_status IN ('approved', 'retired')
  ) THEN
    RAISE EXCEPTION
      'published pathway governance approval evidence is immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_approvals_pathway_governance_immutable
  BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION care_pathway_block_published_approval_mutation();

-- Publication captures approver and voter eligibility at the decision point.
-- After publication, the immutable receipt remains valid even if those people
-- later change roles or active status. Clinical and operational owners remain
-- current duties while governance is approved. Retirement makes those owner
-- identities historical and uses its own active retirement actor receipt.
CREATE OR REPLACE FUNCTION care_pathway_assert_governance_actors(
  target_tenant_id UUID,
  target_governance_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  governance_record care_pathway_definition_governance%ROWTYPE;
  clinical_owner_role TEXT;
  clinical_owner_active BOOLEAN;
  operational_owner_role TEXT;
  operational_owner_active BOOLEAN;
  owner RECORD;
BEGIN
  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF governance_record.governance_status = 'retired' THEN
    RETURN;
  END IF;

  PERFORM care_pathway_lock_governance_users(
    governance_record.tenant_id,
    ARRAY[
      governance_record.clinical_owner_uid,
      governance_record.operational_owner_uid
    ]
  );

  FOR owner IN
    SELECT actor.uid, actor.role, actor.is_active
      FROM users AS actor
     WHERE actor.tenant_id = governance_record.tenant_id
       AND actor.uid IN (
         governance_record.clinical_owner_uid,
         governance_record.operational_owner_uid
       )
     ORDER BY actor.uid
  LOOP
    IF owner.uid = governance_record.clinical_owner_uid THEN
      clinical_owner_role := owner.role;
      clinical_owner_active := owner.is_active;
    END IF;
    IF owner.uid = governance_record.operational_owner_uid THEN
      operational_owner_role := owner.role;
      operational_owner_active := owner.is_active;
    END IF;
  END LOOP;

  IF NULLIF(BTRIM(clinical_owner_role), '') IS NULL
     OR UPPER(clinical_owner_role) = 'PATIENT'
     OR NULLIF(BTRIM(operational_owner_role), '') IS NULL
     OR UPPER(operational_owner_role) = 'PATIENT'
  THEN
    RAISE EXCEPTION
      'pathway governance owners must be non-patient tenant users'
      USING ERRCODE = 'check_violation';
  END IF;

  IF governance_record.governance_status = 'approved'
     AND (
       clinical_owner_active IS DISTINCT FROM TRUE
       OR operational_owner_active IS DISTINCT FROM TRUE
     )
  THEN
    RAISE EXCEPTION
      'approved pathway governance owners must be active non-patient tenant users'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_governance_actor_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'care_pathway_definition_governance' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_governance_actors(NEW.tenant_id, NEW.id);
    END IF;
  ELSE
    -- A users UPDATE already owns that user's row lock. Validate only the
    -- changed identity against final governance state so swapped owner pairs
    -- cannot deadlock by attempting to lock one another in reverse order.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;

    IF (
      NULLIF(BTRIM(NEW.role), '') IS NULL
      OR UPPER(NEW.role) = 'PATIENT'
    ) AND EXISTS (
      SELECT 1
        FROM care_pathway_definition_governance AS governance
       WHERE governance.tenant_id = OLD.tenant_id
         AND governance.governance_status <> 'retired'
         AND (
           governance.clinical_owner_uid = OLD.uid
           OR governance.operational_owner_uid = OLD.uid
         )
    ) THEN
      RAISE EXCEPTION
        'pathway governance owners must be non-patient tenant users'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.is_active IS DISTINCT FROM TRUE
       AND EXISTS (
         SELECT 1
           FROM care_pathway_definition_governance AS governance
          WHERE governance.tenant_id = OLD.tenant_id
            AND governance.governance_status = 'approved'
            AND (
              governance.clinical_owner_uid = OLD.uid
              OR governance.operational_owner_uid = OLD.uid
            )
       )
    THEN
      RAISE EXCEPTION
        'approved pathway governance owners must be active non-patient tenant users'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_assert_governance_approval(
  target_tenant_id UUID,
  target_governance_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  governance_record care_pathway_definition_governance%ROWTYPE;
  approval_record approvals%ROWTYPE;
  deciding_actor_is_approver BOOLEAN := FALSE;
  approval_quorum_met BOOLEAN := FALSE;
  approval_vote_count INTEGER := 0;
  approval_valid_vote_count INTEGER := 0;
  approval_distinct_valid_user_count INTEGER := 0;
BEGIN
  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id;

  IF NOT FOUND
     OR governance_record.governance_status NOT IN ('approved', 'retired')
  THEN
    RETURN;
  END IF;

  PERFORM care_pathway_acquire_serialization_fences(ARRAY[
    care_pathway_approval_fence_key(
      governance_record.tenant_id,
      governance_record.approval_id
    )
  ]);

  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id;

  SELECT approval.*
    INTO approval_record
    FROM approvals AS approval
   WHERE approval.tenant_id = governance_record.tenant_id
     AND approval.id = governance_record.approval_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'approved or retired pathway governance requires matching approval evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  IF jsonb_typeof(approval_record.approved_by) = 'array' THEN
    WITH votes AS (
      SELECT approver.entry,
             NULLIF(BTRIM(approver.entry ->> 'uid'), '') AS uid_text,
             care_pathway_parse_vote_timestamp(approver.entry ->> 'at') AS vote_at
        FROM jsonb_array_elements(approval_record.approved_by) AS approver(entry)
    ), validated_votes AS (
      SELECT vote.*,
             (
               jsonb_typeof(vote.entry) = 'object'
               AND vote.uid_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               AND vote.vote_at IS NOT NULL
               AND vote.vote_at <= approval_record.decided_at
             ) AS is_valid
        FROM votes AS vote
    )
    SELECT COUNT(*)::integer,
           COUNT(*) FILTER (WHERE is_valid)::integer,
           COUNT(DISTINCT uid_text) FILTER (WHERE is_valid)::integer,
           COALESCE(
             BOOL_OR(is_valid AND uid_text = approval_record.decided_by::text),
             FALSE
           )
      INTO approval_vote_count,
           approval_valid_vote_count,
           approval_distinct_valid_user_count,
           deciding_actor_is_approver
      FROM validated_votes;

    approval_quorum_met := approval_record.required_approvers > 0
      AND approval_vote_count = approval_valid_vote_count
      AND approval_vote_count = approval_distinct_valid_user_count
      AND approval_distinct_valid_user_count >= approval_record.required_approvers;
  END IF;

  IF approval_record.status <> 'approved'
     OR approval_record.approval_kind <> 'care_pathway_definition_governance'
     OR approval_record.subject_resource_type IS DISTINCT FROM 'care_pathway_definition'
     OR approval_record.subject_resource_id IS DISTINCT FROM governance_record.workflow_definition_id::text
     OR approval_record.decided_by IS NULL
     OR approval_record.decided_at IS NULL
     OR governance_record.approved_by IS DISTINCT FROM approval_record.decided_by
     OR governance_record.approved_at < approval_record.decided_at
     OR NOT deciding_actor_is_approver
     OR NOT approval_quorum_met
  THEN
    RAISE EXCEPTION
      'approved or retired pathway governance has invalid approval evidence'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_assert_governance_publication_approval(
  target_tenant_id UUID,
  target_governance_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  governance_record care_pathway_definition_governance%ROWTYPE;
  approval_record approvals%ROWTYPE;
BEGIN
  PERFORM care_pathway_assert_governance_approval(
    target_tenant_id,
    target_governance_id
  );

  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id
     AND governance.governance_status IN ('approved', 'retired');

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT approval.*
    INTO approval_record
    FROM approvals AS approval
   WHERE approval.tenant_id = governance_record.tenant_id
     AND approval.id = governance_record.approval_id;

  IF jsonb_typeof(approval_record.approved_by) <> 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(approval_record.approved_by) AS vote(entry)
         LEFT JOIN users AS voter
           ON voter.tenant_id = approval_record.tenant_id
          AND voter.uid::text = vote.entry ->> 'uid'
        WHERE voter.uid IS NULL
           OR NULLIF(BTRIM(voter.role), '') IS NULL
           OR UPPER(voter.role) = 'PATIENT'
           OR voter.is_active IS DISTINCT FROM TRUE
     )
  THEN
    RAISE EXCEPTION
      'approved pathway governance voters must be active non-patient tenant users at publication'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_governance_approval_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'care_pathway_definition_governance' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.governance_status IN ('approved', 'retired') THEN
        PERFORM care_pathway_assert_governance_publication_approval(NEW.tenant_id, NEW.id);
      END IF;
    ELSIF NEW.governance_status IN ('approved', 'retired') THEN
      IF OLD.governance_status NOT IN ('approved', 'retired') THEN
        PERFORM care_pathway_assert_governance_publication_approval(NEW.tenant_id, NEW.id);
      ELSE
        PERFORM care_pathway_assert_governance_approval(NEW.tenant_id, NEW.id);
      END IF;
    END IF;
  ELSE
    PERFORM care_pathway_assert_governance_approval(governance.tenant_id, governance.id)
      FROM care_pathway_definition_governance AS governance
     WHERE governance.tenant_id = OLD.tenant_id
       AND governance.approval_id = OLD.id
       AND governance.governance_status IN ('approved', 'retired');

    IF TG_OP <> 'DELETE'
       AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id)
    THEN
      PERFORM care_pathway_assert_governance_approval(governance.tenant_id, governance.id)
        FROM care_pathway_definition_governance AS governance
       WHERE governance.tenant_id = NEW.tenant_id
         AND governance.approval_id = NEW.id
         AND governance.governance_status IN ('approved', 'retired');
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_pathway_governance_vote_actors ON users;

-- Existing rows receive the same fail-closed owner validation as new writes.
-- Retired owner identities are historical; no current role or active status is
-- inferred or required for them.
DO $care_pathway_governance_owner_cutover_validation$
DECLARE
  governance_record RECORD;
BEGIN
  FOR governance_record IN
    SELECT governance.tenant_id, governance.id
      FROM care_pathway_definition_governance AS governance
     WHERE governance.governance_status <> 'retired'
     ORDER BY governance.tenant_id, governance.id
  LOOP
    PERFORM care_pathway_assert_governance_actors(
      governance_record.tenant_id,
      governance_record.id
    );
  END LOOP;
END
$care_pathway_governance_owner_cutover_validation$;

-- Publication is one-way. Approved governance is frozen except for one
-- evidence-bearing retirement transition; retired governance is terminal.
CREATE OR REPLACE FUNCTION care_pathway_guard_governance_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.governance_status = 'retired' THEN
      RAISE EXCEPTION
        'pathway governance must be approved before it can be retired'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.governance_status IN ('approved', 'retired') THEN
      RAISE EXCEPTION
        'published pathway governance cannot be deleted'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.governance_status = 'retired' THEN
    RAISE EXCEPTION
      'retired pathway governance is terminal and immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.governance_status = 'approved' THEN
    IF NEW.governance_status = 'approved' THEN
      IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM
         (to_jsonb(OLD) - 'updated_at')
      THEN
        RAISE EXCEPTION
          'approved pathway governance is immutable; retire it or publish a new definition version'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.governance_status <> 'retired'
       OR NEW.retired_by IS NULL
       OR NEW.retired_at IS NULL
       OR NULLIF(BTRIM(NEW.retirement_reason), '') IS NULL
       OR NEW.effective_until IS NULL
       OR NEW.effective_until > NEW.retired_at
       OR NEW.retired_at < OLD.approved_at
       OR (
         OLD.effective_until IS NOT NULL
         AND NEW.effective_until > OLD.effective_until
       )
       OR (
         (to_jsonb(NEW)
           - 'governance_status'
           - 'retired_by'
           - 'retired_at'
           - 'retirement_reason'
           - 'effective_until'
           - 'updated_at')
         IS DISTINCT FROM
         (to_jsonb(OLD)
           - 'governance_status'
           - 'retired_by'
           - 'retired_at'
           - 'retirement_reason'
           - 'effective_until'
           - 'updated_at')
       )
    THEN
      RAISE EXCEPTION
        'approved pathway governance may only retire with terminal evidence and a non-extended effective_until'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.governance_status = 'retired' THEN
    RAISE EXCEPTION
      'pathway governance must be approved before it can be retired'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_care_pathway_governance_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON care_pathway_definition_governance
  FOR EACH ROW EXECUTE FUNCTION care_pathway_guard_governance_lifecycle();

-- Published definition content is frozen. is_active remains the operational
-- kill switch while approved, but a retired definition cannot be re-enabled.
CREATE OR REPLACE FUNCTION care_pathway_block_published_definition_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  published_status TEXT;
BEGIN
  PERFORM care_pathway_acquire_serialization_fences(
    ARRAY[
      care_pathway_definition_fence_key(OLD.tenant_id, OLD.id),
      CASE
        WHEN TG_OP = 'UPDATE'
        THEN care_pathway_definition_fence_key(NEW.tenant_id, NEW.id)
        ELSE NULL
      END
    ],
    FALSE
  );

  -- The fence is the authority for definition/governance classification.
  -- This plain READ COMMITTED reread observes whichever transaction won it.
  SELECT governance.governance_status
    INTO published_status
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = OLD.tenant_id
     AND governance.workflow_definition_id = OLD.id
     AND governance.governance_status IN ('approved', 'retired')
   LIMIT 1;

  IF published_status IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'approved or retired pathway definitions are immutable; publish a new version'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (to_jsonb(NEW) - 'is_active' - 'updated_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'is_active' - 'updated_at')
  THEN
    RAISE EXCEPTION
      'approved or retired pathway definitions are immutable; publish a new version'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF published_status = 'retired' AND NEW.is_active THEN
    RAISE EXCEPTION
      'retired pathway definitions cannot be re-enabled'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_assert_retirement_actor(
  target_tenant_id UUID,
  target_governance_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  retirement_actor_uid UUID;
  retirement_actor_role TEXT;
  retirement_actor_active BOOLEAN;
BEGIN
  SELECT governance.retired_by
    INTO retirement_actor_uid
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id
     AND governance.governance_status = 'retired';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM care_pathway_lock_governance_users(
    target_tenant_id,
    ARRAY[retirement_actor_uid]
  );

  SELECT actor.role, actor.is_active
    INTO retirement_actor_role, retirement_actor_active
    FROM users AS actor
   WHERE actor.tenant_id = target_tenant_id
     AND actor.uid = retirement_actor_uid;

  IF NOT FOUND
     OR NULLIF(BTRIM(retirement_actor_role), '') IS NULL
     OR UPPER(retirement_actor_role) = 'PATIENT'
     OR retirement_actor_active IS DISTINCT FROM TRUE
  THEN
    RAISE EXCEPTION
      'pathway governance retirement actor must be an active non-patient tenant user'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_retirement_actor_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM care_pathway_assert_retirement_actor(NEW.tenant_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_pathway_governance_retirement_actor
  AFTER INSERT OR UPDATE ON care_pathway_definition_governance
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_retirement_actor_constraint();

CREATE OR REPLACE FUNCTION care_pathway_assert_retired_definition_inactive(
  target_tenant_id UUID,
  target_definition_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM care_pathway_definition_governance AS governance
      JOIN workflow_definitions AS definition
        ON definition.tenant_id = governance.tenant_id
       AND definition.id = governance.workflow_definition_id
     WHERE governance.tenant_id = target_tenant_id
       AND governance.workflow_definition_id = target_definition_id
       AND governance.governance_status = 'retired'
       AND definition.is_active = TRUE
  ) THEN
    RAISE EXCEPTION
      'retired pathway governance requires an inactive workflow definition'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_retired_definition_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'care_pathway_definition_governance' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_retired_definition_inactive(
        NEW.tenant_id,
        NEW.workflow_definition_id
      );
    END IF;
    IF TG_OP <> 'INSERT'
       AND (
         TG_OP = 'DELETE'
         OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR OLD.workflow_definition_id IS DISTINCT FROM NEW.workflow_definition_id
       )
    THEN
      PERFORM care_pathway_assert_retired_definition_inactive(
        OLD.tenant_id,
        OLD.workflow_definition_id
      );
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_retired_definition_inactive(NEW.tenant_id, NEW.id);
    END IF;
    IF TG_OP <> 'INSERT'
       AND (
         TG_OP = 'DELETE'
         OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR OLD.id IS DISTINCT FROM NEW.id
       )
    THEN
      PERFORM care_pathway_assert_retired_definition_inactive(OLD.tenant_id, OLD.id);
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_pathway_governance_retired_definition
  AFTER INSERT OR UPDATE OR DELETE ON care_pathway_definition_governance
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_retired_definition_constraint();

CREATE CONSTRAINT TRIGGER trg_workflow_definitions_pathway_retirement
  AFTER INSERT OR UPDATE OR DELETE ON workflow_definitions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_retired_definition_constraint();

-- Generic workflow writers may continue to use ungoverned definitions. A run
-- for any governed definition must enter through the pathway executor with the
-- exact approved/effective checksum pin. Existing retired pinned runs may still
-- update their operational state because this trigger only guards pin columns.
CREATE OR REPLACE FUNCTION care_pathway_guard_governed_run_pin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  governance_record care_pathway_definition_governance%ROWTYPE;
  definition_active BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.workflow_definition_id IS NULL THEN
    RAISE EXCEPTION
      'fresh workflow runs require an explicit workflow definition identity'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.workflow_definition_id IS NULL
     AND (
       NEW.workflow_definition_id IS DISTINCT FROM OLD.workflow_definition_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.workflow_key IS DISTINCT FROM OLD.workflow_key
       OR NEW.workflow_version IS DISTINCT FROM OLD.workflow_version
     )
  THEN
    RAISE EXCEPTION
      'historical null-definition workflow run identity is immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM care_pathway_acquire_serialization_fences(
      ARRAY[
        care_pathway_definition_fence_key(NEW.tenant_id, NEW.workflow_definition_id)
      ],
      FALSE
    );
  ELSIF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.workflow_definition_id IS DISTINCT FROM NEW.workflow_definition_id
  THEN
    PERFORM care_pathway_acquire_serialization_fences(
      ARRAY[
        care_pathway_definition_fence_key(OLD.tenant_id, OLD.workflow_definition_id),
        care_pathway_definition_fence_key(NEW.tenant_id, NEW.workflow_definition_id)
      ],
      FALSE
    );
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.workflow_definition_id IS NOT NULL
     AND NEW.workflow_definition_id IS NULL
     AND EXISTS (
       SELECT 1
         FROM workflow_definitions AS definition
        WHERE definition.tenant_id = OLD.tenant_id
          AND definition.id = OLD.workflow_definition_id
     )
  THEN
    RAISE EXCEPTION
      'workflow run definition identity cannot be detached while its definition exists'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.pathway_governance_id IS NOT NULL
     AND (
       NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.workflow_definition_id IS DISTINCT FROM OLD.workflow_definition_id
       OR NEW.workflow_key IS DISTINCT FROM OLD.workflow_key
       OR NEW.workflow_version IS DISTINCT FROM OLD.workflow_version
       OR NEW.pathway_governance_id IS DISTINCT FROM OLD.pathway_governance_id
       OR NEW.pathway_definition_checksum IS DISTINCT FROM
            OLD.pathway_definition_checksum
     )
  THEN
    RAISE EXCEPTION
      'governed pathway workflow run definition pins are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- UPDATE OF fires even when a full-row writer sets the pinned columns to
  -- their existing values. Existing published runs, including retired or
  -- expired ones, may continue changing operational state after their exact
  -- immutable identity has been verified above.
  IF TG_OP = 'UPDATE'
     AND OLD.pathway_governance_id IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = NEW.tenant_id
     AND governance.workflow_definition_id = NEW.workflow_definition_id;

  IF NOT FOUND THEN
    IF NEW.pathway_governance_id IS NOT NULL
       OR NEW.pathway_definition_checksum IS NOT NULL
    THEN
      RAISE EXCEPTION
        'ungoverned workflow runs cannot carry a pathway definition checksum'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT definition.is_active
    INTO definition_active
    FROM workflow_definitions AS definition
   WHERE definition.tenant_id = NEW.tenant_id
     AND definition.id = NEW.workflow_definition_id
     AND definition.workflow_key = NEW.workflow_key
     AND definition.version = NEW.workflow_version;

  IF governance_record.governance_status <> 'approved'
     OR governance_record.definition_checksum IS NULL
     OR NEW.pathway_governance_id IS DISTINCT FROM governance_record.id
     OR NEW.pathway_definition_checksum IS DISTINCT FROM
          governance_record.definition_checksum
     OR definition_active IS DISTINCT FROM TRUE
     OR (
       governance_record.effective_from IS NOT NULL
       AND governance_record.effective_from > CURRENT_TIMESTAMP
     )
     OR (
       governance_record.effective_until IS NOT NULL
       AND governance_record.effective_until < CURRENT_TIMESTAMP
     )
  THEN
    RAISE EXCEPTION
      'governed pathway workflow runs require an active approved effective definition checksum pin'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workflow_runs_pathway_governance_pin
  BEFORE INSERT OR UPDATE OF
    tenant_id,
    workflow_definition_id,
    workflow_key,
    workflow_version,
    pathway_governance_id,
    pathway_definition_checksum
  ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION care_pathway_guard_governed_run_pin();

CREATE OR REPLACE FUNCTION care_pathway_block_instance_definition_pin_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id
     OR NEW.pathway_key IS DISTINCT FROM OLD.pathway_key
     OR NEW.pathway_version IS DISTINCT FROM OLD.pathway_version
     OR NEW.workflow_definition_id IS DISTINCT FROM OLD.workflow_definition_id
     OR NEW.definition_governance_id IS DISTINCT FROM OLD.definition_governance_id
     OR NEW.definition_checksum IS DISTINCT FROM OLD.definition_checksum
  THEN
    RAISE EXCEPTION
      'care pathway instance definition pins are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_care_pathway_instances_definition_pin_immutable
  BEFORE UPDATE OF
    tenant_id,
    workflow_run_id,
    pathway_key,
    pathway_version,
    workflow_definition_id,
    definition_governance_id,
    definition_checksum
  ON care_pathway_instances
  FOR EACH ROW EXECUTE FUNCTION care_pathway_block_instance_definition_pin_mutation();

-- Replace migration 580's approved-only companion assertion. Every governed
-- definition is now covered, and the exact immutable creation event must agree
-- with governance, run, and instance pins at transaction commit.
CREATE OR REPLACE FUNCTION care_pathway_assert_run_companion(target_run_id INTEGER)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  run_record workflow_runs%ROWTYPE;
  governance_record care_pathway_definition_governance%ROWTYPE;
  instance_record care_pathway_instances%ROWTYPE;
  effective_definition_id INTEGER;
  companion_count INTEGER;
  creation_count INTEGER;
  exact_creation_count INTEGER;
BEGIN
  IF target_run_id IS NULL THEN
    RETURN;
  END IF;

  SELECT run.*
    INTO run_record
    FROM workflow_runs AS run
   WHERE run.id = target_run_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  effective_definition_id := run_record.workflow_definition_id;
  IF effective_definition_id IS NULL THEN
    SELECT definition.id
      INTO effective_definition_id
      FROM workflow_definitions AS definition
     WHERE definition.tenant_id = run_record.tenant_id
       AND definition.workflow_key = run_record.workflow_key
       AND definition.version = run_record.workflow_version
     LIMIT 1;
  END IF;

  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = run_record.tenant_id
     AND governance.workflow_definition_id = effective_definition_id;

  IF NOT FOUND THEN
    IF run_record.pathway_governance_id IS NULL
       AND run_record.pathway_definition_checksum IS NULL
    THEN
      RETURN;
    END IF;
    RAISE EXCEPTION
      'ungoverned workflow run % cannot carry a pathway definition pin',
      target_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::integer
    INTO companion_count
    FROM care_pathway_instances AS instance
   WHERE instance.tenant_id = run_record.tenant_id
     AND instance.workflow_run_id = run_record.id;

  IF governance_record.governance_status NOT IN ('approved', 'retired')
     OR governance_record.definition_checksum IS NULL
     OR run_record.pathway_governance_id IS DISTINCT FROM governance_record.id
     OR run_record.pathway_definition_checksum IS DISTINCT FROM
          governance_record.definition_checksum
     OR companion_count <> 1
  THEN
    RAISE EXCEPTION
      'governed workflow run % requires one exact published pinned pathway companion (found %)',
      target_run_id, companion_count
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT instance.*
    INTO STRICT instance_record
    FROM care_pathway_instances AS instance
   WHERE instance.tenant_id = run_record.tenant_id
     AND instance.workflow_run_id = run_record.id;

  IF instance_record.pathway_key IS DISTINCT FROM run_record.workflow_key
     OR instance_record.pathway_version IS DISTINCT FROM run_record.workflow_version
     OR instance_record.workflow_definition_id IS DISTINCT FROM
          run_record.workflow_definition_id
     OR instance_record.definition_governance_id IS DISTINCT FROM
          run_record.pathway_governance_id
     OR instance_record.definition_checksum IS DISTINCT FROM
          run_record.pathway_definition_checksum
  THEN
    RAISE EXCEPTION
      'governed workflow run % has an inconsistent instance definition pin',
      target_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (
           WHERE event.transition_scope = 'pathway'
             AND event.sequence_number = 1
             AND event.effect_ordinal = 0
             AND event.workflow_run_id = run_record.id
             AND event.patient_uid = instance_record.patient_uid
             AND event.idempotency_key = instance_record.idempotency_key
             AND event.canonical_timeline_event_id IS NOT NULL
             AND event.canonical_audit_event_id IS NOT NULL
             AND jsonb_typeof(event.event_payload->'event_id') = 'string'
             AND event.event_payload->>'event_id' = event.id::text
             AND jsonb_typeof(event.event_payload->'tenant_id') = 'string'
             AND event.event_payload->>'tenant_id' = event.tenant_id::text
             AND jsonb_typeof(event.event_payload->'pathway_instance_id') = 'string'
             AND event.event_payload->>'pathway_instance_id' =
                   event.pathway_instance_id::text
             AND jsonb_typeof(event.event_payload->'patient_uid') = 'string'
             AND event.event_payload->>'patient_uid' = event.patient_uid::text
             AND jsonb_typeof(event.event_payload->'workflow_run_id') = 'number'
             AND event.event_payload->>'workflow_run_id' = event.workflow_run_id::text
             AND jsonb_typeof(event.event_payload->'sequence_number') = 'number'
             AND event.event_payload->>'sequence_number' = '1'
             AND jsonb_typeof(event.event_payload->'transition_scope') = 'string'
             AND event.event_payload->>'transition_scope' = event.transition_scope
             AND jsonb_typeof(event.event_payload->'transition_key') = 'string'
             AND event.event_payload->>'transition_key' = event.transition_key
             AND jsonb_typeof(event.event_payload->'idempotency_key') = 'string'
             AND event.event_payload->>'idempotency_key' = event.idempotency_key
             AND jsonb_typeof(event.event_payload->'command_fingerprint') = 'string'
             AND event.event_payload->>'command_fingerprint' =
                   event.command_fingerprint::text
             AND jsonb_typeof(event.event_payload->'effect_ordinal') = 'number'
             AND event.event_payload->>'effect_ordinal' = '0'
             AND jsonb_typeof(event.event_payload->'workflow_definition_id') = 'number'
             AND event.event_payload->>'workflow_definition_id' =
                   run_record.workflow_definition_id::text
             AND jsonb_typeof(event.event_payload->'governance_id') = 'string'
             AND event.event_payload->>'governance_id' = governance_record.id::text
             AND jsonb_typeof(event.event_payload->'definition_checksum') = 'string'
             AND event.event_payload->>'definition_checksum' =
                   run_record.pathway_definition_checksum::text
             AND jsonb_typeof(event.metadata->'pathway_runtime') = 'object'
             AND jsonb_typeof(
                   event.metadata #> ARRAY[
                     'pathway_runtime', 'definition_checksum'
                   ]
                 ) = 'string'
             AND event.metadata #>> ARRAY[
                   'pathway_runtime', 'definition_checksum'
                 ] = instance_record.definition_checksum::text
             AND jsonb_typeof(event.metadata->'command_fingerprint') = 'string'
             AND event.metadata->>'command_fingerprint' = event.command_fingerprint::text
             AND jsonb_typeof(event.metadata->'effect_ordinal') = 'number'
             AND event.metadata->>'effect_ordinal' = '0'
             AND timeline.id IS NOT NULL
             AND timeline.patient_uid = event.patient_uid
             AND timeline.encounter_id IS NOT DISTINCT FROM instance_record.encounter_id
             AND timeline.event_type = 'care_pathway.transition'
             AND timeline.event_status = event.transition_scope
             AND timeline.source_table = 'care_pathway_transition_events'
             AND timeline.source_id = event.id::text
             AND timeline.source_uid = event.id
             AND timeline.resource_type = 'care_pathway_transition_event'
             AND timeline.resource_id = event.id::text
             AND timeline.actor_uid IS NOT DISTINCT FROM event.actor_uid
             AND timeline.actor_role IS NOT DISTINCT FROM event.actor_role
             AND timeline.occurred_at = event.occurred_at
             AND timeline.visible_to_patient = FALSE
             AND timeline.payload = event.event_payload
             AND timeline.idempotency_key =
                   'care_pathway_transition_events:' || event.id::text || ':timeline'
             AND audit.id IS NOT NULL
             AND audit.patient_uid = event.patient_uid
             AND audit.encounter_id IS NOT DISTINCT FROM instance_record.encounter_id
             AND audit.action = 'care_pathway.transition'
             AND audit.action_status = 'success'
             AND audit.resource_type = 'care_pathway_transition_event'
             AND audit.resource_table = 'care_pathway_transition_events'
             AND audit.resource_id = event.id::text
             AND audit.actor_uid IS NOT DISTINCT FROM event.actor_uid
             AND audit.actor_role IS NOT DISTINCT FROM event.actor_role
             AND audit.before_state = event.previous_state
             AND audit.after_state = event.new_state
             AND audit.metadata = event.metadata
             AND audit.idempotency_key =
                   'care_pathway_transition_events:' || event.id::text || ':audit'
             AND audit.occurred_at = event.occurred_at
         )::integer
    INTO creation_count, exact_creation_count
    FROM care_pathway_transition_events AS event
    LEFT JOIN clinical_timeline_events AS timeline
      ON timeline.tenant_id = event.tenant_id
     AND timeline.id = event.canonical_timeline_event_id
    LEFT JOIN clinical_audit_events AS audit
      ON audit.tenant_id = event.tenant_id
     AND audit.id = event.canonical_audit_event_id
   WHERE event.tenant_id = run_record.tenant_id
     AND event.pathway_instance_id = instance_record.id
     AND event.transition_key = 'pathway_instance_created';

  IF creation_count <> 1 OR exact_creation_count <> 1 THEN
    RAISE EXCEPTION
      'governed workflow run % lacks one exact immutable pathway creation pin',
      target_run_id
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- Replace migration 580's trigger dispatcher so governance publication also
-- classifies historical FK-null runs by their unchanged logical key/version.
CREATE OR REPLACE FUNCTION care_pathway_run_companion_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'workflow_runs' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_run_companion(NEW.id);
    END IF;
    IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.id IS DISTINCT FROM NEW.id) THEN
      PERFORM care_pathway_assert_run_companion(OLD.id);
    END IF;
  ELSIF TG_TABLE_NAME = 'care_pathway_instances' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_run_companion(NEW.workflow_run_id);
    END IF;
    IF TG_OP <> 'INSERT'
       AND (
         TG_OP = 'DELETE'
         OR OLD.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id
       )
    THEN
      PERFORM care_pathway_assert_run_companion(OLD.workflow_run_id);
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_run_companion(run.id)
        FROM workflow_runs AS run
        JOIN workflow_definitions AS definition
          ON definition.tenant_id = NEW.tenant_id
         AND definition.id = NEW.workflow_definition_id
       WHERE run.tenant_id = NEW.tenant_id
         AND (
           run.workflow_definition_id = NEW.workflow_definition_id
           OR (
             run.workflow_definition_id IS NULL
             AND run.workflow_key = definition.workflow_key
             AND run.workflow_version = definition.version
           )
         );
    END IF;
    IF TG_OP <> 'INSERT'
       AND (
         TG_OP = 'DELETE'
         OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR OLD.workflow_definition_id IS DISTINCT FROM NEW.workflow_definition_id
       )
    THEN
      PERFORM care_pathway_assert_run_companion(run.id)
        FROM workflow_runs AS run
        JOIN workflow_definitions AS definition
          ON definition.tenant_id = OLD.tenant_id
         AND definition.id = OLD.workflow_definition_id
       WHERE run.tenant_id = OLD.tenant_id
         AND (
           run.workflow_definition_id = OLD.workflow_definition_id
           OR (
             run.workflow_definition_id IS NULL
             AND run.workflow_key = definition.workflow_key
             AND run.workflow_version = definition.version
           )
         );
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_creation_event_companion_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- One event-key fence covers both canonical parents. Admission may wait
  -- because its new transition row cannot be the parent-row lock holder. A
  -- parent UPDATE/DELETE uses the fail-fast form below after PostgreSQL has
  -- locked its row, preventing audit-to-timeline maintenance order from
  -- inverting a timeline-to-audit lock order.
  PERFORM care_pathway_acquire_serialization_fences(ARRAY[
    care_pathway_creation_event_fence_key(NEW.tenant_id, NEW.id)
  ]);

  PERFORM care_pathway_assert_run_companion(NEW.workflow_run_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_care_pathway_creation_event_run_companion
  ON care_pathway_transition_events;

CREATE CONSTRAINT TRIGGER trg_care_pathway_creation_event_run_companion
  AFTER INSERT OR UPDATE ON care_pathway_transition_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.transition_key = 'pathway_instance_created')
  EXECUTE FUNCTION care_pathway_creation_event_companion_constraint();

-- Canonical parent rows are part of the immutable creation proof. Revalidate
-- semantic changes to a referenced parent; FK-driven link nulling is covered
-- by the transition UPDATE trigger above. Non-creation events retain the
-- generic SET NULL lifecycle from migration 580.
CREATE OR REPLACE FUNCTION care_pathway_canonical_creation_parent_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_fence_keys TEXT[] := ARRAY[]::text[];
BEGIN
  IF TG_TABLE_NAME = 'clinical_timeline_events' THEN
    IF OLD.source_uid IS NOT NULL THEN
      event_fence_keys := array_append(
        event_fence_keys,
        care_pathway_creation_event_fence_key(OLD.tenant_id, OLD.source_uid)
      );
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.source_uid IS NOT NULL THEN
      event_fence_keys := array_append(
        event_fence_keys,
        care_pathway_creation_event_fence_key(NEW.tenant_id, NEW.source_uid)
      );
    END IF;
    PERFORM care_pathway_acquire_serialization_fences(event_fence_keys, FALSE);

    PERFORM care_pathway_assert_run_companion(event.workflow_run_id)
      FROM care_pathway_transition_events AS event
     WHERE event.tenant_id = OLD.tenant_id
       AND event.canonical_timeline_event_id = OLD.id
       AND event.transition_key = 'pathway_instance_created';

    IF TG_OP <> 'DELETE'
       AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id)
    THEN
      PERFORM care_pathway_assert_run_companion(event.workflow_run_id)
        FROM care_pathway_transition_events AS event
       WHERE event.tenant_id = NEW.tenant_id
         AND event.canonical_timeline_event_id = NEW.id
         AND event.transition_key = 'pathway_instance_created';
    END IF;
  ELSE
    IF OLD.resource_id ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      event_fence_keys := array_append(
        event_fence_keys,
        care_pathway_creation_event_fence_key(
          OLD.tenant_id,
          OLD.resource_id::uuid
        )
      );
    END IF;
    IF TG_OP <> 'DELETE'
       AND NEW.resource_id ~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      event_fence_keys := array_append(
        event_fence_keys,
        care_pathway_creation_event_fence_key(
          NEW.tenant_id,
          NEW.resource_id::uuid
        )
      );
    END IF;
    PERFORM care_pathway_acquire_serialization_fences(event_fence_keys, FALSE);

    PERFORM care_pathway_assert_run_companion(event.workflow_run_id)
      FROM care_pathway_transition_events AS event
     WHERE event.tenant_id = OLD.tenant_id
       AND event.canonical_audit_event_id = OLD.id
       AND event.transition_key = 'pathway_instance_created';

    IF TG_OP <> 'DELETE'
       AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id)
    THEN
      PERFORM care_pathway_assert_run_companion(event.workflow_run_id)
        FROM care_pathway_transition_events AS event
       WHERE event.tenant_id = NEW.tenant_id
         AND event.canonical_audit_event_id = NEW.id
         AND event.transition_key = 'pathway_instance_created';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_clinical_timeline_pathway_creation_companion
  AFTER UPDATE OR DELETE ON clinical_timeline_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_canonical_creation_parent_constraint();

CREATE CONSTRAINT TRIGGER trg_clinical_audit_pathway_creation_companion
  AFTER UPDATE OR DELETE ON clinical_audit_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_canonical_creation_parent_constraint();

DO $care_pathway_validate_runtime_pins$
DECLARE
  governed_run RECORD;
BEGIN
  FOR governed_run IN
    SELECT run.id
      FROM workflow_runs AS run
     WHERE EXISTS (
             SELECT 1
               FROM care_pathway_definition_governance AS governance
               JOIN workflow_definitions AS definition
                 ON definition.tenant_id = governance.tenant_id
                AND definition.id = governance.workflow_definition_id
              WHERE governance.tenant_id = run.tenant_id
                AND (
                  governance.workflow_definition_id = run.workflow_definition_id
                  OR (
                    run.workflow_definition_id IS NULL
                    AND run.workflow_key = definition.workflow_key
                    AND run.workflow_version = definition.version
                  )
                )
           )
        OR run.pathway_governance_id IS NOT NULL
        OR run.pathway_definition_checksum IS NOT NULL
     ORDER BY run.tenant_id, run.id
  LOOP
    PERFORM care_pathway_assert_run_companion(governed_run.id);
  END LOOP;
END
$care_pathway_validate_runtime_pins$;
