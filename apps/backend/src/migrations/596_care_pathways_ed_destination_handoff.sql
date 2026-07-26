-- Migration 596: Unified Care Pathways S5 ED destination handoff.
--
-- Adds a role-queue receiving task and exact receiving-side acceptance for
-- ward, ICU, HDU, surgery, and external-transfer ED destinations. It does not
-- activate the pathway, choose a tenant's receiver roles, create an SLA, or
-- invent escalation timing.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $s5_ed_task_kind_preflight$
DECLARE
  invalid_task_kind_count INTEGER;
BEGIN
  SELECT COUNT(*)::integer
    INTO invalid_task_kind_count
    FROM tasks AS task
   WHERE task.task_kind NOT IN (
     'general', 'follow_up', 'review', 'escalation', 'verification',
     'admin', 'consent', 'investigation', 'other',
     'pathway_owner_transfer_review',
     'op_to_inpatient_transfer_review',
     'ed_destination_handoff_review'
   );

  IF invalid_task_kind_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 596 blocked: task kinds fall outside the S5 pathway contract (count=%s)',
        invalid_task_kind_count
      ),
      HINT = 'Reconcile each noncanonical task kind explicitly. This migration never rewrites historical task meaning.';
  END IF;
END
$s5_ed_task_kind_preflight$;

ALTER TABLE tasks
  DROP CONSTRAINT tasks_task_kind_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_task_kind_check
  CHECK (task_kind IN (
    'general', 'follow_up', 'review', 'escalation', 'verification',
    'admin', 'consent', 'investigation', 'other',
    'pathway_owner_transfer_review',
    'op_to_inpatient_transfer_review',
    'ed_destination_handoff_review'
  ));

ALTER TABLE admissions
  DROP CONSTRAINT chk_admissions_source_op_shape,
  ADD CONSTRAINT chk_admissions_source_pathway_shape CHECK (
    (
      source_pathway_instance_id IS NULL
      AND source_handoff_id IS NULL
    )
    OR
    (
      source_pathway_instance_id IS NOT NULL
      AND source_handoff_id IS NOT NULL
      AND (
        (
          source_appointment_id IS NOT NULL
          AND from_er_visit_id IS NULL
        )
        OR
        (
          source_appointment_id IS NULL
          AND from_er_visit_id IS NOT NULL
        )
      )
    )
  );

ALTER TABLE care_handoff_instances
  ADD CONSTRAINT care_handoff_ed_destination_check
  CHECK (
    handoff_type <> 'ed_destination_handoff'
    OR (
      sender_uid IS NOT NULL
      AND sender_system_key IS NULL
      AND recipient_kind = 'role'
      AND intended_recipient_uid IS NULL
      AND intended_recipient_role ~ '^[A-Z][A-Z0-9_]{1,79}$'
      AND intended_team_id IS NULL
      AND external_recipient_ref IS NULL
      AND receiving_pathway_instance_id IS NULL
      AND receiving_workflow_run_id IS NULL
      AND receiving_step_key IS NULL
      AND sending_step_key = 'await_destination_acceptance'
      AND source_resource_type = 'emergency_visit'
      AND source_resource_id ~ '^[1-9][0-9]*$'
      AND pg_input_is_valid(source_resource_id, 'integer')
      AND policy_due_at IS NULL
      AND urgency_code = 'not_applicable'
      AND task_id IS NOT NULL
      AND NULLIF(BTRIM(request_reason), '') IS NOT NULL
      AND request_reason = BTRIM(request_reason)
      AND request_reason !~ '[[:cntrl:]]'
      AND request_reason !~ U&'[\0080-\009F]'
      AND request_fingerprint IS NOT NULL
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND metadata ->> 'destination' IN (
        'ward', 'icu', 'hdu', 'surgery', 'external_transfer'
      )
      AND metadata ->> 'registry_version' = '5'
      AND request_fingerprint = encode(
        public.digest(
          convert_to(
            concat_ws(
              chr(30),
              'ed_destination_handoff_request_v1',
              'tenant_id=' || LOWER(tenant_id::text),
              'emergency_visit_id=' || source_resource_id,
              'pathway_instance_id=' ||
                LOWER(sending_pathway_instance_id::text),
              'sender_uid=' || LOWER(sender_uid::text),
              'recipient_role=' || intended_recipient_role,
              'destination=' || (metadata ->> 'destination'),
              'reason=' || BTRIM(request_reason),
              'supersedes_handoff_id=' ||
                COALESCE(metadata ->> 'supersedes_handoff_id', 'none')
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      AND status IN ('requested', 'accepted', 'declined', 'cancelled')
      AND acknowledged_at IS NULL
      AND completed_at IS NULL
      AND originator_closed_at IS NULL
      AND (
        (
          status = 'requested'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND declined_at IS NULL
          AND decline_reason IS NULL
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
          AND reroute_reason IS NULL
          AND NOT (metadata ? 'rerouted_to_handoff_id')
        )
        OR
        (
          status = 'accepted'
          AND accepted_at IS NOT NULL
          AND accepted_by_uid IS NOT NULL
          AND declined_at IS NULL
          AND decline_reason IS NULL
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
          AND reroute_reason IS NULL
          AND NOT (metadata ? 'rerouted_to_handoff_id')
        )
        OR
        (
          status = 'declined'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND declined_at IS NOT NULL
          AND NULLIF(BTRIM(decline_reason), '') IS NOT NULL
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
          AND (
            (
              reroute_reason IS NULL
              AND NOT (metadata ? 'rerouted_to_handoff_id')
            )
            OR
            (
              NULLIF(BTRIM(reroute_reason), '') IS NOT NULL
              AND metadata ->> 'rerouted_to_handoff_id' ~
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
          )
        )
        OR
        (
          status = 'cancelled'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND declined_at IS NULL
          AND decline_reason IS NULL
          AND cancelled_at IS NOT NULL
          AND NULLIF(BTRIM(cancellation_reason), '') IS NOT NULL
        )
      )
    )
  );

CREATE UNIQUE INDEX ux_care_handoff_one_live_ed_destination
  ON care_handoff_instances (
    tenant_id,
    sending_pathway_instance_id,
    source_resource_id
  )
  WHERE handoff_type = 'ed_destination_handoff'
    AND status IN ('requested', 'accepted');

CREATE UNIQUE INDEX ux_care_handoff_s5_ed_reserved_task
  ON care_handoff_instances (tenant_id, task_id)
  WHERE handoff_type = 'ed_destination_handoff'
    AND task_id IS NOT NULL;

CREATE INDEX idx_care_handoff_ed_destination_role
  ON care_handoff_instances (
    tenant_id,
    intended_recipient_role,
    status,
    requested_at
  )
  WHERE handoff_type = 'ed_destination_handoff';

CREATE INDEX idx_care_handoff_ed_destination_sender
  ON care_handoff_instances (
    tenant_id,
    sender_uid,
    status,
    requested_at DESC
  )
  WHERE handoff_type = 'ed_destination_handoff';

CREATE OR REPLACE FUNCTION s5_assert_ed_destination_handoff(
  target_tenant_id UUID,
  target_handoff_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  transfer RECORD;
  actor_role TEXT;
  successor RECORD;
BEGIN
  SELECT handoff.*,
         pathway.id AS pathway_id,
         pathway.pathway_key,
         pathway.source_episode_type,
         pathway.source_episode_id AS pathway_visit_id,
         pathway.patient_uid AS pathway_patient_uid,
         pathway.workflow_run_id AS pathway_run_id,
         pathway.owning_clinician_uid AS pathway_owner_uid,
         run.workflow_key,
         run.workflow_version,
         step.id AS step_id,
         task.id AS bound_task_id,
         task.task_kind,
         task.patient_uid AS task_patient_uid,
         task.encounter_id AS task_encounter_id,
         task.workflow_run_id AS task_workflow_run_id,
         task.workflow_step_id AS task_workflow_step_id,
         task.related_resource_type AS task_resource_type,
         task.related_resource_id AS task_resource_id,
         task.priority AS task_priority,
         task.status AS task_status,
         task.completed_at AS task_completed_at,
         task.cancelled_at AS task_cancelled_at,
         task.cancellation_reason AS task_cancellation_reason,
         task.assigned_to_uid AS task_owner_uid,
         task.assigned_to_role AS task_owner_role,
         task.due_at AS task_due_at,
         task.sla_definition_id AS task_sla_definition_id,
         task.workflow_sla_instance_id AS task_sla_instance_id,
         task.sla_completion_semantics AS task_sla_completion_semantics,
         task.sla_breached_at AS task_sla_breached_at,
         task.metadata AS task_metadata,
         visit.patient_uid AS visit_patient_uid,
         visit.encounter_id AS visit_encounter_id,
         visit.attending_doctor_uid,
         visit.status AS visit_status
    INTO transfer
    FROM care_handoff_instances AS handoff
    LEFT JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = handoff.tenant_id
     AND pathway.id = handoff.sending_pathway_instance_id
     AND pathway.patient_uid = handoff.patient_uid
     AND pathway.workflow_run_id = handoff.sending_workflow_run_id
    LEFT JOIN workflow_runs AS run
      ON run.tenant_id = pathway.tenant_id
     AND run.id = pathway.workflow_run_id
    LEFT JOIN workflow_steps AS step
      ON step.tenant_id = handoff.tenant_id
     AND step.workflow_run_id = handoff.sending_workflow_run_id
     AND step.step_key = handoff.sending_step_key
    LEFT JOIN tasks AS task
      ON task.tenant_id = handoff.tenant_id
     AND task.id = handoff.task_id
    LEFT JOIN emergency_visits AS visit
      ON visit.tenant_id = handoff.tenant_id
     AND visit.id::text = handoff.source_resource_id
   WHERE handoff.tenant_id = target_tenant_id
     AND handoff.id = target_handoff_id
     AND handoff.handoff_type = 'ed_destination_handoff';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF transfer.pathway_id IS NULL
     OR transfer.pathway_key <> 'emergency_arrival_to_aftercare'
     OR transfer.source_episode_type <> 'emergency_visit'
     OR transfer.pathway_visit_id <> transfer.source_resource_id
     OR transfer.pathway_patient_uid IS DISTINCT FROM transfer.patient_uid
     OR transfer.pathway_run_id IS DISTINCT FROM
          transfer.sending_workflow_run_id
     OR transfer.workflow_key <> 'emergency_arrival_to_aftercare'
     OR transfer.workflow_version <> 1
     OR transfer.step_id IS NULL
     OR transfer.bound_task_id IS NULL
     OR transfer.visit_patient_uid IS DISTINCT FROM transfer.patient_uid
     OR transfer.visit_encounter_id IS NULL
     OR transfer.attending_doctor_uid IS DISTINCT FROM transfer.sender_uid
  THEN
    RAISE EXCEPTION
      'ED destination handoff requires its exact pathway, visit, patient, owner, step, and review task'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.task_kind <> 'ed_destination_handoff_review'
     OR transfer.task_patient_uid IS DISTINCT FROM transfer.patient_uid
     OR transfer.task_encounter_id IS NOT NULL
     OR transfer.task_workflow_run_id IS NOT NULL
     OR transfer.task_workflow_step_id IS NOT NULL
     OR transfer.task_resource_type IS DISTINCT FROM
          'care_handoff_instance'
     OR transfer.task_resource_id IS DISTINCT FROM transfer.id::text
     OR transfer.task_priority <> 'high'
     OR transfer.task_owner_uid IS NOT NULL
     OR transfer.task_owner_role IS DISTINCT FROM
          transfer.intended_recipient_role
     OR transfer.task_due_at IS NOT NULL
     OR transfer.task_sla_definition_id IS NOT NULL
     OR transfer.task_sla_instance_id IS NOT NULL
     OR transfer.task_sla_completion_semantics <> 'none'
     OR transfer.task_sla_breached_at IS NOT NULL
     OR transfer.task_metadata ->> 'task_contract' IS DISTINCT FROM
          'ed_destination_handoff_review_v1'
     OR transfer.task_metadata ->> 'care_pathway_instance_id'
          IS DISTINCT FROM transfer.pathway_id::text
     OR transfer.task_metadata ->> 'emergency_visit_id'
          IS DISTINCT FROM transfer.source_resource_id
     OR transfer.task_metadata ->> 'canonical_encounter_id'
          IS DISTINCT FROM transfer.visit_encounter_id::text
     OR transfer.task_metadata ->> 'destination'
          IS DISTINCT FROM transfer.metadata ->> 'destination'
     OR transfer.task_metadata ->> 'request_fingerprint'
          IS DISTINCT FROM transfer.request_fingerprint
  THEN
    RAISE EXCEPTION
      'ED destination handoff review task binding is noncanonical'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.status = 'requested'
     AND transfer.task_status NOT IN (
       'open', 'in_progress', 'blocked', 'overdue'
     )
  THEN
    RAISE EXCEPTION
      'requested ED destination handoff requires an actionable role task'
      USING ERRCODE = 'check_violation';
  ELSIF transfer.status = 'accepted' THEN
    SELECT UPPER(BTRIM(role))
      INTO actor_role
      FROM users
     WHERE tenant_id = target_tenant_id
       AND uid = transfer.accepted_by_uid
       AND is_active
       AND status = 'active'
       AND NOT is_deleted
       AND deleted_at IS NULL;

    IF transfer.task_status <> 'completed'
       OR actor_role IS DISTINCT FROM transfer.intended_recipient_role
    THEN
      RAISE EXCEPTION
        'accepted ED destination handoff requires a completed task and an active exact-role accepter'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transfer.status = 'declined'
        AND (
          transfer.task_status <> 'cancelled'
          OR NULLIF(BTRIM(transfer.task_cancellation_reason), '') IS NULL
        )
  THEN
    RAISE EXCEPTION
      'declined ED destination handoff requires a cancelled task with reason'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.metadata ? 'supersedes_handoff_id' THEN
    SELECT predecessor.status,
           predecessor.sender_uid,
           predecessor.source_resource_id,
           predecessor.reroute_reason,
           predecessor.metadata ->> 'rerouted_to_handoff_id' AS successor_id
      INTO successor
      FROM care_handoff_instances AS predecessor
     WHERE predecessor.tenant_id = target_tenant_id
       AND predecessor.id =
             (transfer.metadata ->> 'supersedes_handoff_id')::uuid
       AND predecessor.handoff_type = 'ed_destination_handoff';

    IF NOT FOUND
       OR successor.status <> 'declined'
       OR successor.sender_uid IS DISTINCT FROM transfer.sender_uid
       OR successor.source_resource_id IS DISTINCT FROM
            transfer.source_resource_id
       OR NULLIF(BTRIM(successor.reroute_reason), '') IS NULL
       OR successor.successor_id IS DISTINCT FROM transfer.id::text
    THEN
      RAISE EXCEPTION
        'rerouted ED destination handoff requires its exact declined predecessor'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION s5_ed_handoff_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM s5_assert_ed_destination_handoff(NEW.tenant_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_handoff_s5_ed_validate
AFTER INSERT OR UPDATE ON care_handoff_instances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.handoff_type = 'ed_destination_handoff')
EXECUTE FUNCTION s5_ed_handoff_constraint();

CREATE OR REPLACE FUNCTION s5_ed_task_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  handoff_id UUID;
BEGIN
  IF NEW.task_kind <> 'ed_destination_handoff_review' THEN
    RETURN NEW;
  END IF;
  IF NEW.related_resource_type <> 'care_handoff_instance'
     OR NEW.related_resource_id !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION
      'ED destination review task requires a UUID care handoff binding'
      USING ERRCODE = 'check_violation';
  END IF;
  handoff_id := NEW.related_resource_id::uuid;
  PERFORM s5_assert_ed_destination_handoff(NEW.tenant_id, handoff_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_s5_ed_reserved_domain_binding
AFTER INSERT OR UPDATE ON tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s5_ed_task_constraint();

CREATE OR REPLACE FUNCTION s5_enforce_ed_destination_acceptance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pathway_mode TEXT;
  accepted_handoff RECORD;
BEGIN
  IF NEW.status NOT IN ('admitted', 'transferred') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(
           tenant.settings #>>
             '{care_pathways,emergency_arrival_to_aftercare}',
           'off'
         )
    INTO pathway_mode
    FROM tenants AS tenant
   WHERE tenant.id = NEW.tenant_id;

  IF pathway_mode <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT handoff.id,
         pathway.id AS pathway_id
    INTO accepted_handoff
    FROM care_handoff_instances AS handoff
    JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = handoff.tenant_id
     AND pathway.id = handoff.sending_pathway_instance_id
     AND pathway.patient_uid = handoff.patient_uid
    JOIN tasks AS task
      ON task.tenant_id = handoff.tenant_id
     AND task.id = handoff.task_id
    JOIN users AS accepter
      ON accepter.tenant_id = handoff.tenant_id
     AND accepter.uid = handoff.accepted_by_uid
   WHERE handoff.tenant_id = NEW.tenant_id
     AND handoff.patient_uid = NEW.patient_uid
     AND handoff.handoff_type = 'ed_destination_handoff'
     AND handoff.source_resource_type = 'emergency_visit'
     AND handoff.source_resource_id = NEW.id::text
     AND handoff.status = 'accepted'
     AND handoff.accepted_at IS NOT NULL
     AND handoff.accepted_by_uid IS NOT NULL
     AND handoff.recipient_kind = 'role'
     AND handoff.intended_recipient_uid IS NULL
     AND handoff.intended_recipient_role = UPPER(BTRIM(accepter.role))
     AND task.task_kind = 'ed_destination_handoff_review'
     AND task.related_resource_type = 'care_handoff_instance'
     AND task.related_resource_id = handoff.id::text
     AND task.status = 'completed'
     AND task.encounter_id IS NULL
     AND task.assigned_to_uid IS NULL
     AND task.assigned_to_role = handoff.intended_recipient_role
     AND task.due_at IS NULL
     AND task.workflow_sla_instance_id IS NULL
     AND task.sla_completion_semantics = 'none'
     AND task.metadata ->> 'canonical_encounter_id' =
           NEW.encounter_id::text
     AND accepter.is_active
     AND accepter.status = 'active'
     AND NOT accepter.is_deleted
     AND accepter.deleted_at IS NULL
     AND pathway.pathway_key = 'emergency_arrival_to_aftercare'
     AND pathway.source_episode_type = 'emergency_visit'
     AND pathway.source_episode_id = NEW.id::text
   ORDER BY handoff.accepted_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'active ED admission or transfer requires the exact accepted destination handoff'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'admitted'
     AND NOT EXISTS (
       SELECT 1
         FROM admissions AS admission
        WHERE admission.tenant_id = NEW.tenant_id
          AND admission.patient_uid = NEW.patient_uid
          AND admission.from_er_visit_id = NEW.id
          AND admission.source_pathway_instance_id =
                accepted_handoff.pathway_id
          AND admission.source_handoff_id = accepted_handoff.id
     )
  THEN
    RAISE EXCEPTION
      'active ED admission requires its exact accepted handoff on the admission'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_emergency_visits_s5_destination_acceptance
AFTER INSERT OR UPDATE OF status, disposition ON emergency_visits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s5_enforce_ed_destination_acceptance();

COMMIT;
