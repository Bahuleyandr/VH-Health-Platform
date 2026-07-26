-- Migration 595: Unified Care Pathways S4 outpatient and inpatient evidence.
--
-- This migration adds policy-neutral, tenant-safe evidence. It does not
-- activate a pathway, publish a definition, dispatch a notification, infer
-- legacy lineage, backfill clinical facts, or create a clinical timer.
-- It does add blank, typed section shells to active discharge-summary
-- templates and unsigned summaries so active-mode finalization can fail
-- closed without rewriting signed clinical documents.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- Composite identities used by tenant/patient-safe foreign keys below.
CREATE UNIQUE INDEX IF NOT EXISTS ux_event_outbox_tenant_id
  ON event_outbox (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_appointment_status_history_tenant_id_appointment
  ON appointment_status_history (tenant_id, id, appointment_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_follow_up_plans_tenant_id_patient
  ON follow_up_plans (tenant_id, id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_admissions_tenant_id_patient
  ON admissions (tenant_id, id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_care_handoff_tenant_id_patient
  ON care_handoff_instances (tenant_id, id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_care_handoff_tenant_id_patient_sender
  ON care_handoff_instances (
    tenant_id, id, patient_uid, sending_pathway_instance_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_discharge_summaries_tenant_admission_patient
  ON discharge_summaries (tenant_id, id, admission_id, patient_uid);

-- ---------------------------------------------------------------------------
-- Typed inpatient-closure sections for templates and unsigned drafts.
-- ---------------------------------------------------------------------------
-- Provision only shadow/active tenants. OFF is behaviorally unchanged.
-- Rollout must pass through shadow before active so existing drafts and
-- templates are measurable before finalization begins to enforce them.

DO $s4_discharge_template_preflight$
DECLARE
  malformed_template_count INTEGER;
BEGIN
  SELECT COUNT(*)::integer
    INTO malformed_template_count
    FROM discharge_summary_templates AS template
    JOIN tenants AS tenant
      ON tenant.id = template.tenant_id
   WHERE template.active
     AND tenant.settings #>>
           '{care_pathways,inpatient_admission_to_recovery}'
           IN ('shadow', 'active')
     AND jsonb_typeof(template.sections) <> 'array';

  IF malformed_template_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 595 blocked: active discharge-summary templates have non-array sections (count=%s)',
        malformed_template_count
      ),
      HINT = 'Repair each active template sections value before adding typed inpatient-closure sections.';
  END IF;
END
$s4_discharge_template_preflight$;

WITH required_section (
  section_key,
  section_title,
  canonical_order
) AS (
  VALUES
    (
      'patient_guardian_instructions',
      'Patient / Guardian Instructions',
      1
    ),
    ('escalation_contact', 'Escalation Contact', 2),
    (
      'required_equipment_home_care',
      'Required Equipment / Home Care',
      3
    ),
    ('discharge_destination', 'Discharge Destination', 4),
    ('transport_plan', 'Transport Plan', 5)
),
template_max_order AS (
  SELECT template.id AS template_id,
         COALESCE(
           MAX(
             CASE
               WHEN definition.value ->> 'display_order' ~ '^-?[0-9]+$'
                 THEN (definition.value ->> 'display_order')::integer
               ELSE NULL
             END
           ),
           0
         ) AS max_display_order
    FROM discharge_summary_templates AS template
    JOIN tenants AS tenant
      ON tenant.id = template.tenant_id
    LEFT JOIN LATERAL jsonb_array_elements(
      template.sections
    ) AS definition(value) ON TRUE
   WHERE template.active
     AND tenant.settings #>>
           '{care_pathways,inpatient_admission_to_recovery}'
           IN ('shadow', 'active')
   GROUP BY template.id
),
missing_section AS (
  SELECT template.id AS template_id,
         required.section_key,
         required.section_title,
         max_order.max_display_order,
         ROW_NUMBER() OVER (
           PARTITION BY template.id
           ORDER BY required.canonical_order
         ) AS append_offset
    FROM discharge_summary_templates AS template
    JOIN template_max_order AS max_order
      ON max_order.template_id = template.id
    CROSS JOIN required_section AS required
   WHERE template.active
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(template.sections) AS definition(value)
        WHERE LOWER(COALESCE(definition.value ->> 'section_key', '')) =
              required.section_key
     )
),
template_addition AS (
  SELECT missing.template_id,
         jsonb_agg(
           jsonb_build_object(
             'section_key',
             missing.section_key,
             'section_title',
             missing.section_title,
             'display_order',
             missing.max_display_order + missing.append_offset,
             'default_body',
             ''
           )
           ORDER BY missing.append_offset
         ) AS definitions
    FROM missing_section AS missing
   GROUP BY missing.template_id
)
UPDATE discharge_summary_templates AS template
   SET sections = template.sections || addition.definitions,
       updated_at = NOW()
  FROM template_addition AS addition
 WHERE template.id = addition.template_id;

WITH required_section (
  section_key,
  section_title,
  canonical_order
) AS (
  VALUES
    (
      'patient_guardian_instructions',
      'Patient / Guardian Instructions',
      1
    ),
    ('escalation_contact', 'Escalation Contact', 2),
    (
      'required_equipment_home_care',
      'Required Equipment / Home Care',
      3
    ),
    ('discharge_destination', 'Discharge Destination', 4),
    ('transport_plan', 'Transport Plan', 5)
),
summary_max_order AS (
  SELECT header.id AS discharge_summary_id,
         header.tenant_id,
         COALESCE(MAX(section.display_order), 0) AS max_display_order
    FROM discharge_summaries AS header
    JOIN tenants AS tenant
      ON tenant.id = header.tenant_id
    LEFT JOIN discharge_summary_sections AS section
      ON section.discharge_summary_id = header.id
   WHERE header.status IN ('draft', 'ready_for_signoff')
     AND tenant.settings #>>
           '{care_pathways,inpatient_admission_to_recovery}'
           IN ('shadow', 'active')
     AND header.signed_at IS NULL
     AND header.signed_by IS NULL
     AND header.signed_by_name IS NULL
     AND header.signed_by_reg IS NULL
   GROUP BY header.id, header.tenant_id
),
missing_section AS (
  SELECT summary.discharge_summary_id,
         summary.tenant_id,
         required.section_key,
         required.section_title,
         summary.max_display_order,
         ROW_NUMBER() OVER (
           PARTITION BY summary.discharge_summary_id
           ORDER BY required.canonical_order
         ) AS append_offset
    FROM summary_max_order AS summary
    CROSS JOIN required_section AS required
   WHERE NOT EXISTS (
     SELECT 1
       FROM discharge_summary_sections AS section
      WHERE section.discharge_summary_id = summary.discharge_summary_id
        AND LOWER(section.section_key) = required.section_key
   )
)
INSERT INTO discharge_summary_sections (
  discharge_summary_id,
  section_key,
  section_title,
  display_order,
  body,
  tenant_id
)
SELECT missing.discharge_summary_id,
       missing.section_key,
       missing.section_title,
       missing.max_display_order + missing.append_offset,
       NULL,
       missing.tenant_id
  FROM missing_section AS missing
ON CONFLICT (discharge_summary_id, section_key) DO NOTHING;

DO $s4_discharge_section_assertions$
DECLARE
  missing_template_definition_count INTEGER;
  missing_unsigned_summary_section_count INTEGER;
BEGIN
  WITH required_section(section_key) AS (
    VALUES
      ('patient_guardian_instructions'),
      ('escalation_contact'),
      ('required_equipment_home_care'),
      ('discharge_destination'),
      ('transport_plan')
  )
  SELECT COUNT(*)::integer
    INTO missing_template_definition_count
    FROM discharge_summary_templates AS template
    JOIN tenants AS tenant
      ON tenant.id = template.tenant_id
    CROSS JOIN required_section AS required
   WHERE template.active
     AND tenant.settings #>>
           '{care_pathways,inpatient_admission_to_recovery}'
           IN ('shadow', 'active')
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(template.sections) AS definition(value)
        WHERE LOWER(COALESCE(definition.value ->> 'section_key', '')) =
              required.section_key
     );

  IF missing_template_definition_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 595 failed to add typed sections to active discharge-summary templates (missing=%s)',
        missing_template_definition_count
      );
  END IF;

  WITH required_section(section_key) AS (
    VALUES
      ('patient_guardian_instructions'),
      ('escalation_contact'),
      ('required_equipment_home_care'),
      ('discharge_destination'),
      ('transport_plan')
  )
  SELECT COUNT(*)::integer
    INTO missing_unsigned_summary_section_count
    FROM discharge_summaries AS header
    JOIN tenants AS tenant
      ON tenant.id = header.tenant_id
    CROSS JOIN required_section AS required
   WHERE header.status IN ('draft', 'ready_for_signoff')
     AND tenant.settings #>>
           '{care_pathways,inpatient_admission_to_recovery}'
           IN ('shadow', 'active')
     AND header.signed_at IS NULL
     AND header.signed_by IS NULL
     AND header.signed_by_name IS NULL
     AND header.signed_by_reg IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM discharge_summary_sections AS section
        WHERE section.discharge_summary_id = header.id
          AND section.tenant_id = header.tenant_id
          AND LOWER(section.section_key) = required.section_key
     );

  IF missing_unsigned_summary_section_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 595 failed to add typed sections to unsigned discharge summaries (missing=%s)',
        missing_unsigned_summary_section_count
      );
  END IF;
END
$s4_discharge_section_assertions$;

DO $care_pathway_op_inpatient_task_kind_preflight$
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
     'op_to_inpatient_transfer_review'
   );

  IF invalid_task_kind_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 595 blocked: task kinds fall outside the OP/inpatient pathway contract (count=%s)',
        invalid_task_kind_count
      ),
      HINT = 'Reconcile each noncanonical task kind explicitly. The migration never rewrites historical task meaning.';
  END IF;
END
$care_pathway_op_inpatient_task_kind_preflight$;

ALTER TABLE tasks
  DROP CONSTRAINT tasks_task_kind_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_task_kind_check
  CHECK (task_kind IN (
    'general', 'follow_up', 'review', 'escalation', 'verification',
    'admin', 'consent', 'investigation', 'other',
    'pathway_owner_transfer_review',
    'op_to_inpatient_transfer_review'
  ));

-- ---------------------------------------------------------------------------
-- Exact OP-to-inpatient transfer request and receiving-side acceptance.
-- ---------------------------------------------------------------------------

ALTER TABLE care_handoff_instances
  ADD CONSTRAINT care_handoff_op_to_inpatient_transfer_check
  CHECK (
    handoff_type <> 'op_to_inpatient_transfer'
    OR (
      sender_uid IS NOT NULL
      AND sender_system_key IS NULL
      AND recipient_kind = 'user'
      AND intended_recipient_uid IS NOT NULL
      AND intended_recipient_uid IS DISTINCT FROM sender_uid
      AND receiving_pathway_instance_id IS NULL
      AND receiving_workflow_run_id IS NULL
      AND receiving_step_key IS NULL
      AND source_resource_type = 'appointment'
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
      AND request_fingerprint = encode(
        public.digest(
          convert_to(
            concat_ws(
              chr(30),
              'op_to_inpatient_transfer_request_v1',
              'tenant_id=' || LOWER(tenant_id::text),
              'appointment_id=' || source_resource_id,
              'pathway_instance_id=' ||
                LOWER(sending_pathway_instance_id::text),
              'sender_uid=' || LOWER(sender_uid::text),
              'recipient_uid=' || LOWER(intended_recipient_uid::text),
              'reason=' || BTRIM(request_reason)
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
      AND reroute_reason IS NULL
      AND (
        (
          status = 'requested'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND declined_at IS NULL
          AND decline_reason IS NULL
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
        )
        OR
        (
          status = 'accepted'
          AND accepted_at IS NOT NULL
          AND accepted_by_uid = intended_recipient_uid
          AND declined_at IS NULL
          AND decline_reason IS NULL
          AND cancelled_at IS NULL
          AND cancellation_reason IS NULL
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

CREATE UNIQUE INDEX ux_care_handoff_one_requested_op_to_ip_transfer
  ON care_handoff_instances (
    tenant_id,
    sending_pathway_instance_id,
    source_resource_id
  )
  WHERE handoff_type = 'op_to_inpatient_transfer'
    AND status = 'requested';

CREATE INDEX idx_care_handoff_op_to_ip_recipient
  ON care_handoff_instances (
    tenant_id,
    intended_recipient_uid,
    status,
    requested_at DESC
  )
  WHERE handoff_type = 'op_to_inpatient_transfer';

CREATE OR REPLACE FUNCTION s4_assert_op_to_inpatient_transfer(
  target_tenant_id UUID,
  target_handoff_id UUID,
  enforce_request_owner BOOLEAN DEFAULT TRUE
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  transfer RECORD;
BEGIN
  IF target_tenant_id IS NULL OR target_handoff_id IS NULL THEN
    RETURN;
  END IF;

  SELECT handoff.id,
         handoff.status AS handoff_status,
         handoff.patient_uid,
         handoff.sender_uid,
         handoff.intended_recipient_uid,
         handoff.requested_at,
         handoff.accepted_at,
         handoff.accepted_by_uid,
         handoff.declined_at,
         handoff.decline_reason,
         handoff.cancelled_at,
         handoff.cancellation_reason,
         handoff.request_fingerprint,
         pathway.id AS pathway_id,
         pathway.clinical_status AS pathway_status,
         pathway.owning_clinician_uid AS pathway_owner_uid,
         pathway.workflow_run_id AS pathway_run_id,
         pathway.source_episode_id AS pathway_appointment_id,
         current_run.id AS current_run_id,
         step.id AS step_id,
         step.status AS step_status,
         task.id AS bound_task_id,
         task.task_kind,
         task.patient_uid AS task_patient_uid,
         task.workflow_run_id AS task_workflow_run_id,
         task.workflow_step_id AS task_workflow_step_id,
         task.related_resource_type AS task_resource_type,
         task.related_resource_id AS task_resource_id,
         task.status AS task_status,
         task.assigned_to_uid AS task_owner_uid,
         task.assigned_to_role AS task_owner_role,
         task.due_at AS task_due_at,
         task.completed_at AS task_completed_at,
         task.cancelled_at AS task_cancelled_at,
         task.cancellation_reason AS task_cancellation_reason,
         task.sla_definition_id AS task_sla_definition_id,
         task.workflow_sla_instance_id AS task_sla_instance_id,
         task.sla_completion_semantics AS task_sla_completion_semantics,
         task.sla_breached_at AS task_sla_breached_at,
         task.metadata AS task_metadata
    INTO transfer
    FROM care_handoff_instances AS handoff
    LEFT JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = handoff.tenant_id
     AND pathway.id = handoff.sending_pathway_instance_id
     AND pathway.patient_uid = handoff.patient_uid
     AND pathway.workflow_run_id = handoff.sending_workflow_run_id
     AND pathway.pathway_key = 'op_contact_to_recovery'
     AND pathway.source_episode_type = 'appointment'
     AND pathway.source_episode_id = handoff.source_resource_id
    LEFT JOIN workflow_runs AS current_run
      ON current_run.tenant_id = pathway.tenant_id
     AND current_run.id = pathway.workflow_run_id
     AND current_run.current_step_key = handoff.sending_step_key
    LEFT JOIN workflow_steps AS step
      ON step.tenant_id = handoff.tenant_id
     AND step.workflow_run_id = handoff.sending_workflow_run_id
     AND step.step_key = handoff.sending_step_key
    LEFT JOIN tasks AS task
      ON task.tenant_id = handoff.tenant_id
     AND task.id = handoff.task_id
   WHERE handoff.tenant_id = target_tenant_id
     AND handoff.id = target_handoff_id
     AND handoff.handoff_type = 'op_to_inpatient_transfer';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF transfer.pathway_id IS NULL
     OR transfer.current_run_id IS NULL
     OR transfer.step_id IS NULL
     OR transfer.bound_task_id IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM appointments AS appointment
         JOIN users AS patient
           ON patient.tenant_id = appointment.tenant_id
          AND patient.id = appointment.patient_id
        WHERE appointment.tenant_id = target_tenant_id
          AND appointment.id =
                transfer.pathway_appointment_id::integer
          AND patient.uid = transfer.patient_uid
     )
  THEN
    RAISE EXCEPTION
      'OP-to-inpatient transfer requires its exact OP pathway, appointment, patient, step, and review task'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.task_kind <> 'op_to_inpatient_transfer_review'
     OR transfer.task_patient_uid IS DISTINCT FROM transfer.patient_uid
     OR transfer.task_workflow_run_id IS NOT NULL
     OR transfer.task_workflow_step_id IS NOT NULL
     OR transfer.task_resource_type IS DISTINCT FROM
          'care_handoff_instance'
     OR transfer.task_resource_id IS DISTINCT FROM transfer.id::text
     OR transfer.task_owner_uid IS DISTINCT FROM
          transfer.intended_recipient_uid
     OR transfer.task_owner_role IS NOT NULL
     OR transfer.task_due_at IS NOT NULL
     OR transfer.task_sla_definition_id IS NOT NULL
     OR transfer.task_sla_instance_id IS NOT NULL
     OR transfer.task_sla_completion_semantics <> 'none'
     OR transfer.task_sla_breached_at IS NOT NULL
     OR transfer.task_metadata ->> 'task_contract' IS DISTINCT FROM
          'op_to_inpatient_transfer_review_v1'
     OR transfer.task_metadata ->> 'care_pathway_instance_id'
          IS DISTINCT FROM
          transfer.pathway_id::text
     OR transfer.task_metadata ->> 'source_appointment_id'
          IS DISTINCT FROM
          transfer.pathway_appointment_id
     OR transfer.task_metadata ->> 'request_fingerprint'
          IS DISTINCT FROM
          transfer.request_fingerprint
  THEN
    RAISE EXCEPTION
      'OP-to-inpatient transfer review task binding is noncanonical'
      USING ERRCODE = 'check_violation';
  END IF;

  IF enforce_request_owner
     AND (
       transfer.pathway_status NOT IN ('planned', 'active', 'on_hold')
       OR transfer.step_status NOT IN ('pending', 'in_progress', 'blocked')
       OR transfer.pathway_owner_uid IS DISTINCT FROM transfer.sender_uid
       OR NOT care_pathway_named_clinician_is_viable(
         target_tenant_id,
         transfer.intended_recipient_uid
       )
     )
  THEN
    RAISE EXCEPTION
      'OP-to-inpatient transfer requires the current OP owner and a distinct active named recipient'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.handoff_status = 'requested' THEN
    IF transfer.task_status NOT IN (
         'open',
         'in_progress',
         'blocked',
         'overdue'
       )
       OR transfer.task_completed_at IS NOT NULL
       OR transfer.task_cancelled_at IS NOT NULL
       OR transfer.task_cancellation_reason IS NOT NULL
    THEN
      RAISE EXCEPTION
        'requested OP-to-inpatient transfer requires an actionable recipient review task'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transfer.handoff_status = 'accepted' THEN
    IF transfer.accepted_by_uid IS DISTINCT FROM
         transfer.intended_recipient_uid
       OR transfer.accepted_at IS NULL
       OR transfer.accepted_at < transfer.requested_at
       OR transfer.task_status <> 'completed'
       OR transfer.task_completed_at IS NULL
       OR transfer.task_completed_at < transfer.requested_at
       OR transfer.task_cancelled_at IS NOT NULL
       OR transfer.task_cancellation_reason IS NOT NULL
    THEN
      RAISE EXCEPTION
        'accepted OP-to-inpatient transfer requires exact recipient acceptance and completed review task'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transfer.handoff_status IN ('declined', 'cancelled') THEN
    IF transfer.task_status <> 'cancelled'
       OR transfer.task_completed_at IS NOT NULL
       OR transfer.task_cancelled_at IS NULL
       OR transfer.task_cancelled_at < transfer.requested_at
       OR NULLIF(BTRIM(transfer.task_cancellation_reason), '') IS NULL
       OR (
         transfer.handoff_status = 'declined'
         AND transfer.task_cancellation_reason IS DISTINCT FROM
               transfer.decline_reason
       )
       OR (
         transfer.handoff_status = 'cancelled'
         AND transfer.task_cancellation_reason IS DISTINCT FROM
               transfer.cancellation_reason
       )
    THEN
      RAISE EXCEPTION
        'closed OP-to-inpatient transfer requires an exactly reasoned cancelled review task'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION
      'OP-to-inpatient transfer status is noncanonical'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION s4_block_op_to_inpatient_transfer_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.handoff_type = 'op_to_inpatient_transfer'
       AND NEW.status <> 'requested'
    THEN
      RAISE EXCEPTION
        'OP-to-inpatient transfer must begin as a request'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.handoff_type = 'op_to_inpatient_transfer' THEN
      RAISE EXCEPTION
        'OP-to-inpatient transfer evidence is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.handoff_type <> 'op_to_inpatient_transfer'
     AND NEW.handoff_type = 'op_to_inpatient_transfer'
  THEN
    RAISE EXCEPTION
      'OP-to-inpatient transfer evidence must be created atomically'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.handoff_type = 'op_to_inpatient_transfer' THEN
    IF ROW(
         OLD.tenant_id,
         OLD.patient_uid,
         OLD.sending_pathway_instance_id,
         OLD.sending_workflow_run_id,
         OLD.sending_step_key,
         OLD.receiving_pathway_instance_id,
         OLD.receiving_workflow_run_id,
         OLD.receiving_step_key,
         OLD.handoff_type,
         OLD.source_resource_type,
         OLD.source_resource_id,
         OLD.urgency_code,
         OLD.policy_due_at,
         OLD.sender_uid,
         OLD.sender_system_key,
         OLD.recipient_kind,
         OLD.intended_recipient_uid,
         OLD.intended_recipient_role,
         OLD.intended_team_id,
         OLD.external_recipient_ref,
         OLD.task_id,
         OLD.idempotency_key,
         OLD.request_reason,
         OLD.request_fingerprint,
         OLD.requested_at,
         OLD.metadata
       ) IS DISTINCT FROM ROW(
         NEW.tenant_id,
         NEW.patient_uid,
         NEW.sending_pathway_instance_id,
         NEW.sending_workflow_run_id,
         NEW.sending_step_key,
         NEW.receiving_pathway_instance_id,
         NEW.receiving_workflow_run_id,
         NEW.receiving_step_key,
         NEW.handoff_type,
         NEW.source_resource_type,
         NEW.source_resource_id,
         NEW.urgency_code,
         NEW.policy_due_at,
         NEW.sender_uid,
         NEW.sender_system_key,
         NEW.recipient_kind,
         NEW.intended_recipient_uid,
         NEW.intended_recipient_role,
         NEW.intended_team_id,
         NEW.external_recipient_ref,
         NEW.task_id,
         NEW.idempotency_key,
         NEW.request_reason,
         NEW.request_fingerprint,
         NEW.requested_at,
         NEW.metadata
       )
    THEN
      RAISE EXCEPTION
        'OP-to-inpatient transfer request evidence is immutable'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status <> 'requested'
       AND ROW(
         OLD.status,
         OLD.accepted_at,
         OLD.accepted_by_uid,
         OLD.declined_at,
         OLD.decline_reason,
         OLD.cancelled_at,
         OLD.cancellation_reason
       ) IS DISTINCT FROM ROW(
         NEW.status,
         NEW.accepted_at,
         NEW.accepted_by_uid,
         NEW.declined_at,
         NEW.decline_reason,
         NEW.cancelled_at,
         NEW.cancellation_reason
       )
    THEN
      RAISE EXCEPTION
        'decided OP-to-inpatient transfer evidence is immutable'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION
        'OP-to-inpatient transfer updates require a later updated_at'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_care_handoff_op_to_ip_immutable
BEFORE INSERT OR UPDATE OR DELETE ON care_handoff_instances
FOR EACH ROW EXECUTE FUNCTION s4_block_op_to_inpatient_transfer_mutation();

CREATE OR REPLACE FUNCTION s4_op_to_ip_transfer_row_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  enforce_owner BOOLEAN;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    enforce_owner := TG_OP = 'INSERT';
    IF TG_OP = 'UPDATE' THEN
      enforce_owner := OLD.status = 'requested';
    END IF;
    PERFORM s4_assert_op_to_inpatient_transfer(
      NEW.tenant_id,
      NEW.id,
      enforce_owner
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_handoff_op_to_ip_invariant
AFTER INSERT OR UPDATE OR DELETE ON care_handoff_instances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_op_to_ip_transfer_row_constraint();

CREATE OR REPLACE FUNCTION s4_op_to_ip_pathway_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM s4_assert_op_to_inpatient_transfer(
      handoff.tenant_id,
      handoff.id,
      TRUE
    )
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.sending_pathway_instance_id = NEW.id
       AND handoff.handoff_type = 'op_to_inpatient_transfer'
       AND handoff.status = 'requested';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_pathway_instances_op_to_ip_dependency
AFTER INSERT OR UPDATE OR DELETE ON care_pathway_instances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_op_to_ip_pathway_dependency();

CREATE OR REPLACE FUNCTION s4_op_to_ip_task_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM s4_assert_op_to_inpatient_transfer(
      handoff.tenant_id,
      handoff.id,
      handoff.status = 'requested'
    )
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.task_id = NEW.id
       AND handoff.handoff_type = 'op_to_inpatient_transfer';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_op_to_ip_dependency
AFTER INSERT OR UPDATE OR DELETE ON tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_op_to_ip_task_dependency();

-- ---------------------------------------------------------------------------
-- Durable OP-to-IP source and same-patient readmission linkage.
-- ---------------------------------------------------------------------------

ALTER TABLE admissions
  ADD COLUMN source_appointment_id INTEGER,
  ADD COLUMN source_pathway_instance_id UUID,
  ADD COLUMN source_handoff_id UUID;

ALTER TABLE admissions
  DROP CONSTRAINT IF EXISTS admissions_prior_admission_id_fkey,
  ADD CONSTRAINT fk_admissions_prior_admission_tenant_patient
    FOREIGN KEY (tenant_id, prior_admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_admissions_source_appointment
    FOREIGN KEY (tenant_id, source_appointment_id)
    REFERENCES appointments (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_admissions_source_pathway
    FOREIGN KEY (tenant_id, source_pathway_instance_id, patient_uid)
    REFERENCES care_pathway_instances (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_admissions_source_handoff
    FOREIGN KEY (
      tenant_id,
      source_handoff_id,
      patient_uid,
      source_pathway_instance_id
    )
    REFERENCES care_handoff_instances (
      tenant_id,
      id,
      patient_uid,
      sending_pathway_instance_id
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_admissions_source_op_shape CHECK (
    (
      source_pathway_instance_id IS NULL
      AND source_handoff_id IS NULL
    )
    OR
    (
      source_appointment_id IS NOT NULL
      AND source_pathway_instance_id IS NOT NULL
      AND source_handoff_id IS NOT NULL
    )
  );

CREATE INDEX idx_admissions_source_appointment
  ON admissions (tenant_id, source_appointment_id)
  WHERE source_appointment_id IS NOT NULL;

CREATE INDEX idx_admissions_source_pathway
  ON admissions (tenant_id, source_pathway_instance_id)
  WHERE source_pathway_instance_id IS NOT NULL;

CREATE INDEX idx_admissions_source_handoff
  ON admissions (tenant_id, source_handoff_id)
  WHERE source_handoff_id IS NOT NULL;

-- Pending-result collection is admission-complete only when every supported
-- source can carry an exact admission origin. These columns are nullable for
-- non-inpatient work; migration 595 performs no heuristic backfill.
ALTER TABLE investigations
  ADD COLUMN admission_id INTEGER,
  ADD CONSTRAINT chk_investigations_admission_patient CHECK (
    admission_id IS NULL OR patient_uid IS NOT NULL
  ),
  ADD CONSTRAINT fk_investigations_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX idx_investigations_admission
  ON investigations (tenant_id, admission_id, id)
  WHERE admission_id IS NOT NULL;

ALTER TABLE lab_results
  ADD COLUMN admission_id INTEGER,
  ADD CONSTRAINT fk_lab_results_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX idx_lab_results_admission
  ON lab_results (tenant_id, admission_id, id)
  WHERE admission_id IS NOT NULL;

ALTER TABLE radiology_orders
  ADD COLUMN admission_id INTEGER,
  ADD CONSTRAINT fk_radiology_orders_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX idx_radiology_orders_admission
  ON radiology_orders (tenant_id, admission_id, id)
  WHERE admission_id IS NOT NULL;

ALTER TABLE ap_cases
  ADD COLUMN admission_id INTEGER,
  ADD CONSTRAINT fk_ap_cases_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX idx_ap_cases_admission
  ON ap_cases (tenant_id, admission_id, id)
  WHERE admission_id IS NOT NULL;

ALTER TABLE diagnostic_result_generations
  ADD COLUMN admission_id INTEGER,
  ADD CONSTRAINT fk_diagnostic_result_generations_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX idx_diagnostic_result_generations_admission
  ON diagnostic_result_generations (tenant_id, admission_id, id)
  WHERE admission_id IS NOT NULL;

CREATE UNIQUE INDEX ux_diagnostic_result_generations_admission_context
  ON diagnostic_result_generations (
    tenant_id,
    id,
    patient_uid,
    admission_id
  );

CREATE OR REPLACE FUNCTION s4_validate_admission_source_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_patient_uid UUID;
  source_pathway RECORD;
  source_handoff RECORD;
BEGIN
  IF NEW.source_appointment_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT patient.uid
    INTO source_patient_uid
    FROM appointments AS appointment
    JOIN users AS patient
      ON patient.tenant_id = appointment.tenant_id
     AND patient.id = appointment.patient_id
   WHERE appointment.tenant_id = NEW.tenant_id
     AND appointment.id = NEW.source_appointment_id
   FOR SHARE OF appointment, patient;

  IF source_patient_uid IS DISTINCT FROM NEW.patient_uid THEN
    RAISE EXCEPTION
      'admission source appointment must belong to the same tenant and patient'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.source_handoff_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT pathway.pathway_key,
         pathway.source_episode_type,
         pathway.source_episode_id
    INTO source_pathway
    FROM care_pathway_instances AS pathway
   WHERE pathway.tenant_id = NEW.tenant_id
     AND pathway.id = NEW.source_pathway_instance_id
     AND pathway.patient_uid = NEW.patient_uid
   FOR SHARE;

  IF NOT FOUND
     OR source_pathway.pathway_key <> 'op_contact_to_recovery'
     OR source_pathway.source_episode_type <> 'appointment'
     OR source_pathway.source_episode_id <> NEW.source_appointment_id::text
  THEN
    RAISE EXCEPTION
      'admission source pathway must be the exact originating OP appointment'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT handoff.handoff_type,
         handoff.source_resource_type,
         handoff.source_resource_id,
         handoff.status,
         handoff.accepted_at,
         handoff.accepted_by_uid
    INTO source_handoff
    FROM care_handoff_instances AS handoff
   WHERE handoff.tenant_id = NEW.tenant_id
     AND handoff.id = NEW.source_handoff_id
     AND handoff.patient_uid = NEW.patient_uid
     AND handoff.sending_pathway_instance_id = NEW.source_pathway_instance_id
   FOR SHARE;

  IF NOT FOUND
     OR source_handoff.handoff_type <> 'op_to_inpatient_transfer'
     OR source_handoff.source_resource_type <> 'appointment'
     OR source_handoff.source_resource_id <> NEW.source_appointment_id::text
     OR source_handoff.status <> 'accepted'
     OR source_handoff.accepted_at IS NULL
     OR source_handoff.accepted_by_uid IS NULL
  THEN
    RAISE EXCEPTION
      'admission source handoff must be the accepted OP-to-IP transfer'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_admissions_s4_source_link
BEFORE INSERT OR UPDATE OF
  tenant_id,
  patient_uid,
  source_appointment_id,
  source_pathway_instance_id,
  source_handoff_id
ON admissions
FOR EACH ROW EXECUTE FUNCTION s4_validate_admission_source_link();

-- ---------------------------------------------------------------------------
-- Append-only typed pathway resource-reference ledger.
-- ---------------------------------------------------------------------------

CREATE TABLE care_pathway_resource_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  pathway_instance_id UUID NOT NULL,
  patient_uid UUID NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  relationship_kind VARCHAR(30) NOT NULL,
  evidence_state VARCHAR(30) NOT NULL,
  resource_id VARCHAR(160) NOT NULL,
  accepted_owner_uid UUID,
  task_id INTEGER,
  handoff_id UUID,
  source_outbox_event_id BIGINT,
  canonical_timeline_event_id UUID,
  canonical_audit_event_id UUID,
  actor_uid UUID,
  actor_system_key VARCHAR(120),
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(220) NOT NULL,
  superseded_reference_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT ux_care_pathway_resource_references_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_care_pathway_resource_references_supersession_identity
    UNIQUE (
      tenant_id,
      id,
      pathway_instance_id,
      patient_uid,
      resource_type,
      resource_id,
      relationship_kind
    ),
  CONSTRAINT ux_care_pathway_resource_references_resource_identity
    UNIQUE (
      tenant_id,
      id,
      patient_uid,
      resource_type,
      resource_id
    ),
  CONSTRAINT ux_care_pathway_resource_references_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_care_pathway_resource_references_instance
    FOREIGN KEY (tenant_id, pathway_instance_id, patient_uid)
    REFERENCES care_pathway_instances (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_owner
    FOREIGN KEY (tenant_id, accepted_owner_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_handoff
    FOREIGN KEY (tenant_id, handoff_id)
    REFERENCES care_handoff_instances (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_outbox
    FOREIGN KEY (tenant_id, source_outbox_event_id)
    REFERENCES event_outbox (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_resource_references_superseded
    FOREIGN KEY (
      tenant_id,
      superseded_reference_id,
      pathway_instance_id,
      patient_uid,
      resource_type,
      resource_id,
      relationship_kind
    )
    REFERENCES care_pathway_resource_references (
      tenant_id,
      id,
      pathway_instance_id,
      patient_uid,
      resource_type,
      resource_id,
      relationship_kind
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_care_pathway_resource_references_type CHECK (
    resource_type IN (
      'appointment',
      'admission',
      'e_prescription',
      'clinical_order',
      'investigation',
      'lab_result',
      'radiology_order',
      'anatomical_pathology_case',
      'diagnostic_result_generation',
      'referral',
      'follow_up_plan',
      'clinical_note',
      'discharge_summary',
      'discharge_consult'
    )
  ),
  CONSTRAINT chk_care_pathway_resource_references_relationship CHECK (
    relationship_kind IN ('child_action', 'closure_evidence')
  ),
  CONSTRAINT chk_care_pathway_resource_references_state CHECK (
    evidence_state IN ('open', 'completed', 'ownership_accepted', 'superseded')
  ),
  CONSTRAINT chk_care_pathway_resource_references_actor CHECK (
    (actor_uid IS NOT NULL) <> (actor_system_key IS NOT NULL)
    AND (
      actor_system_key IS NULL
      OR NULLIF(BTRIM(actor_system_key), '') IS NOT NULL
    )
  ),
  CONSTRAINT chk_care_pathway_resource_references_nonblank CHECK (
    NULLIF(BTRIM(resource_id), '') IS NOT NULL
    AND NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
  ),
  CONSTRAINT chk_care_pathway_resource_references_ownership CHECK (
    evidence_state <> 'ownership_accepted'
    OR (
      accepted_owner_uid IS NOT NULL
      AND (task_id IS NOT NULL OR handoff_id IS NOT NULL)
    )
  ),
  CONSTRAINT chk_care_pathway_resource_references_supersession CHECK (
    (evidence_state <> 'superseded' OR superseded_reference_id IS NOT NULL)
    AND (superseded_reference_id IS NULL OR superseded_reference_id <> id)
  ),
  CONSTRAINT chk_care_pathway_resource_references_metadata CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE UNIQUE INDEX ux_care_pathway_resource_references_successor
  ON care_pathway_resource_references (
    tenant_id,
    superseded_reference_id,
    pathway_instance_id,
    patient_uid,
    resource_type,
    resource_id,
    relationship_kind
  );

CREATE INDEX idx_care_pathway_resource_references_instance
  ON care_pathway_resource_references (
    tenant_id,
    pathway_instance_id,
    relationship_kind,
    evidence_state,
    recorded_at DESC
  );

CREATE INDEX idx_care_pathway_resource_references_resource
  ON care_pathway_resource_references (
    tenant_id,
    resource_type,
    resource_id,
    recorded_at DESC
  );

CREATE INDEX idx_care_pathway_resource_references_patient
  ON care_pathway_resource_references (
    tenant_id,
    patient_uid,
    recorded_at DESC
  );

CREATE OR REPLACE FUNCTION s4_validate_resource_reference_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.evidence_state <> 'ownership_accepted' THEN
    RETURN NEW;
  END IF;

  IF NEW.task_id IS NOT NULL THEN
    PERFORM 1
      FROM tasks AS task
      JOIN care_pathway_instances AS pathway
        ON pathway.tenant_id = task.tenant_id
       AND pathway.workflow_run_id = task.workflow_run_id
     WHERE task.tenant_id = NEW.tenant_id
       AND task.id = NEW.task_id
       AND task.patient_uid = NEW.patient_uid
       AND pathway.id = NEW.pathway_instance_id
       AND pathway.patient_uid = NEW.patient_uid
       AND task.related_resource_type = NEW.resource_type
       AND task.related_resource_id = NEW.resource_id
       AND task.assigned_to_uid = NEW.accepted_owner_uid
       AND task.assigned_to_role IS NULL
       AND task.status = 'completed'
       AND task.completed_at IS NOT NULL
     FOR SHARE OF task, pathway;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'ownership evidence task must match pathway, patient, resource, assignee, and accepted status'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.handoff_id IS NOT NULL THEN
    PERFORM 1
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.id = NEW.handoff_id
       AND handoff.patient_uid = NEW.patient_uid
       AND handoff.sending_pathway_instance_id = NEW.pathway_instance_id
       AND handoff.source_resource_type = NEW.resource_type
       AND handoff.source_resource_id = NEW.resource_id
       AND handoff.recipient_kind = 'user'
       AND handoff.intended_recipient_uid = NEW.accepted_owner_uid
       AND handoff.accepted_by_uid = NEW.accepted_owner_uid
       AND handoff.status IN ('accepted', 'completed', 'closed_loop')
       AND handoff.accepted_at IS NOT NULL
       AND (
         NEW.task_id IS NULL
         OR handoff.task_id = NEW.task_id
       )
     FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'ownership evidence handoff must match pathway, patient, resource, recipient, and accepted status'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_care_pathway_resource_references_ownership
BEFORE INSERT ON care_pathway_resource_references
FOR EACH ROW EXECUTE FUNCTION s4_validate_resource_reference_ownership();

-- ---------------------------------------------------------------------------
-- OP visit closure evidence. Domain evidence intentionally does not depend on
-- an asynchronously projected pathway instance.
-- ---------------------------------------------------------------------------

CREATE TABLE op_visit_closure_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  appointment_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  evidence_revision INTEGER NOT NULL,
  clinician_uid UUID NOT NULL,
  follow_up_required BOOLEAN NOT NULL,
  follow_up_plan_id INTEGER,
  patient_safe_next_steps JSONB NOT NULL,
  closure_basis VARCHAR(40) NOT NULL,
  accepted_handoff_id UUID,
  source_status_history_id BIGINT NOT NULL,
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(220) NOT NULL,

  CONSTRAINT ux_op_visit_closure_evidence_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_op_visit_closure_evidence_revision
    UNIQUE (tenant_id, appointment_id, evidence_revision),
  CONSTRAINT ux_op_visit_closure_evidence_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_op_visit_closure_evidence_appointment
    FOREIGN KEY (tenant_id, appointment_id)
    REFERENCES appointments (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_op_visit_closure_evidence_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_op_visit_closure_evidence_clinician
    FOREIGN KEY (tenant_id, clinician_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_op_visit_closure_evidence_follow_up
    FOREIGN KEY (tenant_id, follow_up_plan_id, patient_uid)
    REFERENCES follow_up_plans (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_op_visit_closure_evidence_handoff
    FOREIGN KEY (tenant_id, accepted_handoff_id, patient_uid)
    REFERENCES care_handoff_instances (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_op_visit_closure_evidence_status_history
    FOREIGN KEY (tenant_id, source_status_history_id, appointment_id)
    REFERENCES appointment_status_history (tenant_id, id, appointment_id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_op_visit_closure_evidence_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_op_visit_closure_evidence_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_op_visit_closure_evidence_revision CHECK (
    evidence_revision > 0
  ),
  CONSTRAINT chk_op_visit_closure_evidence_next_steps CHECK (
    jsonb_typeof(patient_safe_next_steps) = 'array'
    AND jsonb_array_length(patient_safe_next_steps) > 0
  ),
  CONSTRAINT chk_op_visit_closure_evidence_follow_up CHECK (
    NOT follow_up_required
    OR follow_up_plan_id IS NOT NULL
  ),
  CONSTRAINT chk_op_visit_closure_evidence_basis CHECK (
    closure_basis IN (
      'all_required_work_completed',
      'named_ownership_accepted',
      'accepted_transfer'
    )
  ),
  CONSTRAINT chk_op_visit_closure_evidence_handoff_shape CHECK (
    (
      closure_basis = 'accepted_transfer'
      AND accepted_handoff_id IS NOT NULL
    )
    OR
    (
      closure_basis <> 'accepted_transfer'
      AND accepted_handoff_id IS NULL
    )
  ),
  CONSTRAINT chk_op_visit_closure_evidence_idempotency CHECK (
    NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
  )
);

CREATE INDEX idx_op_visit_closure_evidence_appointment
  ON op_visit_closure_evidence (
    tenant_id,
    appointment_id,
    evidence_revision DESC
  );

CREATE INDEX idx_op_visit_closure_evidence_patient
  ON op_visit_closure_evidence (
    tenant_id,
    patient_uid,
    occurred_at DESC
  );

CREATE OR REPLACE FUNCTION s4_validate_op_closure_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  appointment_patient_uid UUID;
  follow_up_record RECORD;
  handoff_record RECORD;
  timeline_record RECORD;
  audit_record RECORD;
BEGIN
  SELECT patient.uid
    INTO appointment_patient_uid
    FROM appointments AS appointment
    JOIN users AS patient
      ON patient.tenant_id = appointment.tenant_id
     AND patient.id = appointment.patient_id
   WHERE appointment.tenant_id = NEW.tenant_id
     AND appointment.id = NEW.appointment_id
   FOR SHARE OF appointment, patient;

  IF appointment_patient_uid IS DISTINCT FROM NEW.patient_uid THEN
    RAISE EXCEPTION
      'OP closure evidence appointment must belong to the same tenant and patient'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT care_pathway_named_clinician_is_viable(
           NEW.tenant_id,
           NEW.clinician_uid
         )
  THEN
    RAISE EXCEPTION
      'OP closure evidence requires an active same-tenant named clinician'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.follow_up_plan_id IS NOT NULL THEN
    SELECT plan.id,
           plan.origin_kind,
           plan.origin_resource_type,
           plan.origin_resource_id,
           plan.status
      INTO follow_up_record
      FROM follow_up_plans AS plan
     WHERE plan.tenant_id = NEW.tenant_id
       AND plan.id = NEW.follow_up_plan_id
       AND plan.patient_uid = NEW.patient_uid
     FOR SHARE;

    IF NOT FOUND
       OR follow_up_record.origin_kind IS DISTINCT FROM 'consultation'
       OR follow_up_record.origin_resource_type IS DISTINCT FROM
            'appointment'
       OR follow_up_record.origin_resource_id IS DISTINCT FROM
            NEW.appointment_id::text
       OR follow_up_record.status NOT IN ('open', 'scheduled')
    THEN
      RAISE EXCEPTION
        'OP closure follow-up must be an open or scheduled plan from the exact appointment'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.accepted_handoff_id IS NOT NULL THEN
    SELECT handoff.status,
           handoff.accepted_at,
           handoff.accepted_by_uid,
           handoff.sender_uid,
           handoff.intended_recipient_uid,
           handoff.handoff_type,
           handoff.source_resource_type,
           handoff.source_resource_id,
           pathway.pathway_key,
           pathway.source_episode_type,
           pathway.source_episode_id
      INTO handoff_record
      FROM care_handoff_instances AS handoff
      JOIN care_pathway_instances AS pathway
        ON pathway.tenant_id = handoff.tenant_id
       AND pathway.id = handoff.sending_pathway_instance_id
       AND pathway.patient_uid = handoff.patient_uid
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.id = NEW.accepted_handoff_id
       AND handoff.patient_uid = NEW.patient_uid
     FOR SHARE OF handoff, pathway;

    IF NOT FOUND
       OR handoff_record.handoff_type <> 'op_to_inpatient_transfer'
       OR handoff_record.source_resource_type <> 'appointment'
       OR handoff_record.source_resource_id <> NEW.appointment_id::text
       OR handoff_record.pathway_key <> 'op_contact_to_recovery'
       OR handoff_record.source_episode_type <> 'appointment'
       OR handoff_record.source_episode_id <> NEW.appointment_id::text
       OR handoff_record.status <> 'accepted'
       OR handoff_record.accepted_at IS NULL
       OR handoff_record.sender_uid IS DISTINCT FROM NEW.clinician_uid
       OR handoff_record.intended_recipient_uid IS NULL
       OR handoff_record.intended_recipient_uid =
            handoff_record.sender_uid
       OR handoff_record.accepted_by_uid IS DISTINCT FROM
            handoff_record.intended_recipient_uid
    THEN
      RAISE EXCEPTION
        'OP closure transfer basis requires the exact accepted OP sender and distinct recipient'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT timeline.id,
         timeline.patient_uid,
         timeline.event_type,
         timeline.source_table,
         timeline.source_id
    INTO timeline_record
    FROM clinical_timeline_events AS timeline
   WHERE timeline.tenant_id = NEW.tenant_id
     AND timeline.id = NEW.canonical_timeline_event_id
   FOR SHARE;

  SELECT audit.id,
         audit.patient_uid,
         audit.action,
         audit.resource_table,
         audit.resource_id
    INTO audit_record
    FROM clinical_audit_events AS audit
   WHERE audit.tenant_id = NEW.tenant_id
     AND audit.id = NEW.canonical_audit_event_id
   FOR SHARE;

  IF timeline_record.id IS NULL
     OR timeline_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR timeline_record.event_type <> 'appointment.closure_evidence_recorded'
     OR timeline_record.source_table <> 'op_visit_closure_evidence'
     OR timeline_record.source_id <> NEW.id::text
     OR audit_record.id IS NULL
     OR audit_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR audit_record.action <> 'appointment.closure_evidence_recorded'
     OR audit_record.resource_table <> 'op_visit_closure_evidence'
     OR audit_record.resource_id <> NEW.id::text
  THEN
    RAISE EXCEPTION
      'OP closure evidence requires its exact same-patient canonical timeline and audit records'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_op_visit_closure_evidence_validate
BEFORE INSERT ON op_visit_closure_evidence
FOR EACH ROW EXECUTE FUNCTION s4_validate_op_closure_evidence();

CREATE OR REPLACE FUNCTION s4_op_closure_follow_up_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM op_visit_closure_evidence AS closure
     WHERE closure.tenant_id = NEW.tenant_id
       AND closure.follow_up_plan_id = NEW.id
       AND (
         closure.patient_uid IS DISTINCT FROM NEW.patient_uid
         OR NEW.origin_kind IS DISTINCT FROM 'consultation'
         OR NEW.origin_resource_type IS DISTINCT FROM 'appointment'
         OR NEW.origin_resource_id IS DISTINCT FROM
              closure.appointment_id::text
       )
  )
  THEN
    RAISE EXCEPTION
      'OP closure follow-up must remain bound to its exact appointment'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_follow_up_plans_op_closure_dependency
AFTER UPDATE OR DELETE ON follow_up_plans
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_op_closure_follow_up_dependency();

-- ---------------------------------------------------------------------------
-- Versioned, append-only inpatient primary physician assignment.
-- ---------------------------------------------------------------------------

CREATE TABLE inpatient_primary_physician_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  admission_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  assignment_version INTEGER NOT NULL,
  physician_uid UUID NOT NULL,
  assignment_source VARCHAR(40) NOT NULL,
  accepted_handoff_id UUID,
  supersedes_assignment_id UUID,
  assigned_by_uid UUID NOT NULL,
  assigned_at TIMESTAMPTZ(6) NOT NULL,
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  idempotency_key VARCHAR(220) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT ux_inpatient_primary_assignments_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_inpatient_primary_assignments_context
    UNIQUE (
      tenant_id,
      id,
      admission_id,
      patient_uid
    ),
  CONSTRAINT ux_inpatient_primary_assignments_identity
    UNIQUE (
      tenant_id,
      id,
      admission_id,
      patient_uid,
      physician_uid
    ),
  CONSTRAINT ux_inpatient_primary_assignments_version
    UNIQUE (tenant_id, admission_id, assignment_version),
  CONSTRAINT ux_inpatient_primary_assignments_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_inpatient_primary_assignments_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_inpatient_primary_assignments_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_inpatient_primary_assignments_physician
    FOREIGN KEY (tenant_id, physician_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_inpatient_primary_assignments_assigned_by
    FOREIGN KEY (tenant_id, assigned_by_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_inpatient_primary_assignments_handoff
    FOREIGN KEY (tenant_id, accepted_handoff_id, patient_uid)
    REFERENCES care_handoff_instances (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_inpatient_primary_assignments_supersedes
    FOREIGN KEY (
      tenant_id,
      supersedes_assignment_id,
      admission_id,
      patient_uid
    )
    REFERENCES inpatient_primary_physician_assignments (
      tenant_id,
      id,
      admission_id,
      patient_uid
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_inpatient_primary_assignments_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_inpatient_primary_assignments_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_inpatient_primary_assignments_version CHECK (
    assignment_version > 0
  ),
  CONSTRAINT chk_inpatient_primary_assignments_source CHECK (
    assignment_source IN (
      'attending_physician',
      'admitting_physician',
      'accepted_covering_handoff'
    )
  ),
  CONSTRAINT chk_inpatient_primary_assignments_shape CHECK (
    (
      assignment_version = 1
      AND assignment_source IN (
        'attending_physician',
        'admitting_physician'
      )
      AND accepted_handoff_id IS NULL
      AND supersedes_assignment_id IS NULL
    )
    OR
    (
      assignment_version > 1
      AND assignment_source = 'accepted_covering_handoff'
      AND accepted_handoff_id IS NOT NULL
      AND supersedes_assignment_id IS NOT NULL
    )
  ),
  CONSTRAINT chk_inpatient_primary_assignments_nonblank CHECK (
    NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
  )
);

CREATE UNIQUE INDEX ux_inpatient_primary_assignments_successor
  ON inpatient_primary_physician_assignments (
    tenant_id,
    supersedes_assignment_id,
    admission_id,
    patient_uid
  );

CREATE INDEX idx_inpatient_primary_assignments_admission
  ON inpatient_primary_physician_assignments (
    tenant_id,
    admission_id,
    assignment_version DESC
  );

CREATE INDEX idx_inpatient_primary_assignments_physician
  ON inpatient_primary_physician_assignments (
    tenant_id,
    physician_uid,
    assigned_at DESC
  );

CREATE OR REPLACE FUNCTION s4_validate_primary_physician_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  admission_record RECORD;
  previous_assignment RECORD;
  handoff_record RECORD;
  timeline_record RECORD;
  audit_record RECORD;
  expected_event_type TEXT;
  expected_event_status TEXT;
BEGIN
  SELECT admission.attending_doctor,
         admission.admitting_doctor
    INTO admission_record
    FROM admissions AS admission
   WHERE admission.tenant_id = NEW.tenant_id
     AND admission.id = NEW.admission_id
     AND admission.patient_uid = NEW.patient_uid
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'primary physician assignment admission context is invalid'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM users AS physician
     WHERE physician.tenant_id = NEW.tenant_id
       AND physician.uid = NEW.physician_uid
       AND physician.is_active = TRUE
       AND LOWER(COALESCE(physician.status, '')) = 'active'
       AND physician.is_deleted IS FALSE
       AND physician.deleted_at IS NULL
       AND UPPER(BTRIM(physician.role)) IN (
         'DOCTOR',
         'CONSULTANT',
         'JUNIOR_DOCTOR',
         'RESIDENT',
         'DUTY_DOCTOR',
         'SENIOR_DOCTOR'
       )
  )
  THEN
    RAISE EXCEPTION
      'primary physician assignment requires an active same-tenant named physician'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.assignment_version = 1 THEN
    IF (
      NEW.assignment_source = 'attending_physician'
      AND admission_record.attending_doctor IS DISTINCT FROM NEW.physician_uid
    ) OR (
      NEW.assignment_source = 'admitting_physician'
      AND (
        admission_record.attending_doctor IS NOT NULL
        OR admission_record.admitting_doctor IS DISTINCT FROM NEW.physician_uid
      )
    )
    THEN
      RAISE EXCEPTION
        'initial primary physician must use the recorded attending physician or the recorded admitting physician fallback'
        USING ERRCODE = 'check_violation';
    END IF;
    expected_event_type := 'admission.primary_physician.assigned';
    expected_event_status := 'assigned';
  ELSE
    SELECT assignment.id,
           assignment.assignment_version,
           assignment.physician_uid
      INTO previous_assignment
      FROM inpatient_primary_physician_assignments AS assignment
     WHERE assignment.tenant_id = NEW.tenant_id
       AND assignment.id = NEW.supersedes_assignment_id
       AND assignment.admission_id = NEW.admission_id
       AND assignment.patient_uid = NEW.patient_uid
     FOR SHARE;

    IF NOT FOUND
       OR previous_assignment.assignment_version IS DISTINCT FROM
            NEW.assignment_version - 1
    THEN
      RAISE EXCEPTION
        'primary physician reassignment must supersede the immediately preceding assignment'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT handoff.handoff_type,
           handoff.status,
           handoff.sender_uid,
           handoff.intended_recipient_uid,
           handoff.accepted_by_uid,
           handoff.accepted_at,
           handoff.sending_pathway_instance_id,
           handoff.source_resource_type,
           handoff.source_resource_id,
           pathway.pathway_key,
           pathway.source_episode_type,
           pathway.source_episode_id
      INTO handoff_record
      FROM care_handoff_instances AS handoff
      JOIN care_pathway_instances AS pathway
        ON pathway.tenant_id = handoff.tenant_id
       AND pathway.id = handoff.sending_pathway_instance_id
       AND pathway.patient_uid = handoff.patient_uid
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.id = NEW.accepted_handoff_id
       AND handoff.patient_uid = NEW.patient_uid
     FOR SHARE OF handoff, pathway;

    IF NOT FOUND
       OR handoff_record.handoff_type IS DISTINCT FROM
            'covering_clinician_reassignment'
       OR handoff_record.status IS DISTINCT FROM 'accepted'
       OR handoff_record.sender_uid IS DISTINCT FROM
            previous_assignment.physician_uid
       OR handoff_record.intended_recipient_uid IS DISTINCT FROM
            NEW.physician_uid
       OR handoff_record.accepted_by_uid IS DISTINCT FROM NEW.physician_uid
       OR handoff_record.accepted_at IS NULL
       OR handoff_record.source_resource_type IS DISTINCT FROM
            'care_pathway_instance'
       OR handoff_record.source_resource_id IS DISTINCT FROM
            handoff_record.sending_pathway_instance_id::text
       OR handoff_record.pathway_key IS DISTINCT FROM
            'inpatient_admission_to_recovery'
       OR handoff_record.source_episode_type IS DISTINCT FROM 'admission'
       OR handoff_record.source_episode_id IS DISTINCT FROM
            NEW.admission_id::text
    THEN
      RAISE EXCEPTION
        'primary physician reassignment requires the exact admission covering-clinician handoff'
        USING ERRCODE = 'check_violation';
    END IF;
    expected_event_type := 'admission.primary_physician.reassigned';
    expected_event_status := 'accepted';
  END IF;

  SELECT timeline.id,
         timeline.patient_uid,
         timeline.event_type,
         timeline.event_status,
         timeline.source_table,
         timeline.source_id,
         timeline.resource_type,
         timeline.resource_id
    INTO timeline_record
    FROM clinical_timeline_events AS timeline
   WHERE timeline.tenant_id = NEW.tenant_id
     AND timeline.id = NEW.canonical_timeline_event_id
   FOR SHARE;

  SELECT audit.id,
         audit.patient_uid,
         audit.action,
         audit.action_status,
         audit.resource_type,
         audit.resource_table,
         audit.resource_id
    INTO audit_record
    FROM clinical_audit_events AS audit
   WHERE audit.tenant_id = NEW.tenant_id
     AND audit.id = NEW.canonical_audit_event_id
   FOR SHARE;

  IF timeline_record.id IS NULL
     OR timeline_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR timeline_record.event_type IS DISTINCT FROM expected_event_type
     OR timeline_record.event_status IS DISTINCT FROM expected_event_status
     OR timeline_record.source_table IS DISTINCT FROM
          'inpatient_primary_physician_assignments'
     OR timeline_record.source_id IS DISTINCT FROM NEW.id::text
     OR timeline_record.resource_type IS DISTINCT FROM
          'inpatient_primary_physician_assignments'
     OR timeline_record.resource_id IS DISTINCT FROM NEW.id::text
     OR audit_record.id IS NULL
     OR audit_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR audit_record.action IS DISTINCT FROM expected_event_type
     OR audit_record.action_status IS DISTINCT FROM 'success'
     OR audit_record.resource_type IS DISTINCT FROM
          'inpatient_primary_physician_assignments'
     OR audit_record.resource_table IS DISTINCT FROM
          'inpatient_primary_physician_assignments'
     OR audit_record.resource_id IS DISTINCT FROM NEW.id::text
  THEN
    RAISE EXCEPTION
      'primary physician assignment requires its exact same-patient canonical timeline and audit records'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inpatient_primary_assignments_validate
BEFORE INSERT ON inpatient_primary_physician_assignments
FOR EACH ROW EXECUTE FUNCTION s4_validate_primary_physician_assignment();

-- ---------------------------------------------------------------------------
-- Mutable operational pending-result handoff. Identity and source are sealed;
-- state/disclosure/resolution fields may advance through the closed graph.
-- ---------------------------------------------------------------------------

CREATE TABLE discharge_pending_result_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  admission_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  resource_reference_id UUID NOT NULL,
  source_type VARCHAR(60) NOT NULL,
  source_id VARCHAR(160) NOT NULL,
  patient_safe_label VARCHAR(240) NOT NULL,
  result_status VARCHAR(60) NOT NULL,
  primary_physician_assignment_id UUID NOT NULL,
  named_physician_uid UUID NOT NULL,
  discharge_summary_id INTEGER,
  summary_included_at TIMESTAMPTZ(6),
  summary_inclusion_timeline_event_id UUID,
  task_id INTEGER NOT NULL,
  notification_outbox_id INTEGER,
  resolution_generation_id UUID,
  resolution_action_id UUID,
  handoff_state VARCHAR(30) NOT NULL DEFAULT 'pending',
  resolved_at TIMESTAMPTZ(6),
  resolved_by_uid UUID,
  created_by_uid UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(220) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT ux_discharge_pending_result_handoffs_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_discharge_pending_result_handoffs_context
    UNIQUE (tenant_id, id, admission_id, patient_uid),
  CONSTRAINT ux_discharge_pending_result_handoffs_source
    UNIQUE (tenant_id, admission_id, source_type, source_id),
  CONSTRAINT ux_discharge_pending_result_handoffs_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_discharge_pending_result_handoffs_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_reference
    FOREIGN KEY (
      tenant_id,
      resource_reference_id,
      patient_uid,
      source_type,
      source_id
    )
    REFERENCES care_pathway_resource_references (
      tenant_id,
      id,
      patient_uid,
      resource_type,
      resource_id
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_assignment
    FOREIGN KEY (
      tenant_id,
      primary_physician_assignment_id,
      admission_id,
      patient_uid,
      named_physician_uid
    )
    REFERENCES inpatient_primary_physician_assignments (
      tenant_id,
      id,
      admission_id,
      patient_uid,
      physician_uid
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_summary
    FOREIGN KEY (
      tenant_id,
      discharge_summary_id,
      admission_id,
      patient_uid
    )
    REFERENCES discharge_summaries (
      tenant_id,
      id,
      admission_id,
      patient_uid
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_summary_timeline
    FOREIGN KEY (tenant_id, summary_inclusion_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_notification
    FOREIGN KEY (tenant_id, notification_outbox_id)
    REFERENCES notification_outbox (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_generation
    FOREIGN KEY (
      tenant_id,
      resolution_generation_id,
      patient_uid,
      admission_id
    )
    REFERENCES diagnostic_result_generations (
      tenant_id,
      id,
      patient_uid,
      admission_id
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_resolution_action
    FOREIGN KEY (tenant_id, resolution_action_id, patient_uid)
    REFERENCES diagnostic_result_actions (
      tenant_id,
      id,
      patient_uid
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_discharge_pending_result_handoffs_resolved_by
    FOREIGN KEY (tenant_id, resolved_by_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_handoffs_created_by
    FOREIGN KEY (tenant_id, created_by_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_discharge_pending_result_handoffs_source CHECK (
    source_type IN (
      'investigation',
      'lab_result',
      'radiology_order',
      'anatomical_pathology_case',
      'diagnostic_result_generation'
    )
  ),
  CONSTRAINT chk_discharge_pending_result_handoffs_state CHECK (
    handoff_state IN (
      'pending',
      'result_available',
      'resolved',
      'superseded'
    )
  ),
  CONSTRAINT chk_discharge_pending_result_handoffs_nonblank CHECK (
    NULLIF(BTRIM(source_id), '') IS NOT NULL
    AND NULLIF(BTRIM(patient_safe_label), '') IS NOT NULL
    AND NULLIF(BTRIM(result_status), '') IS NOT NULL
    AND NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
  ),
  CONSTRAINT chk_discharge_pending_result_handoffs_summary CHECK (
    (
      discharge_summary_id IS NULL
      AND summary_included_at IS NULL
      AND summary_inclusion_timeline_event_id IS NULL
    )
    OR
    (
      discharge_summary_id IS NOT NULL
      AND summary_included_at IS NOT NULL
      AND summary_inclusion_timeline_event_id IS NOT NULL
    )
  ),
  CONSTRAINT chk_discharge_pending_result_handoffs_resolution CHECK (
    (
      handoff_state = 'pending'
      AND resolution_generation_id IS NULL
      AND resolution_action_id IS NULL
      AND resolved_at IS NULL
      AND resolved_by_uid IS NULL
    )
    OR
    (
      handoff_state = 'result_available'
      AND resolution_generation_id IS NOT NULL
      AND resolution_action_id IS NULL
      AND resolved_at IS NULL
      AND resolved_by_uid IS NULL
    )
    OR
    (
      handoff_state = 'resolved'
      AND resolution_generation_id IS NOT NULL
      AND resolution_action_id IS NOT NULL
      AND resolved_at IS NOT NULL
    )
    OR
    (
      handoff_state = 'superseded'
      AND resolution_action_id IS NULL
      AND resolved_at IS NOT NULL
      AND resolved_by_uid IS NOT NULL
    )
  ),
  CONSTRAINT chk_discharge_pending_result_handoffs_metadata CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX idx_discharge_pending_result_handoffs_admission
  ON discharge_pending_result_handoffs (
    tenant_id,
    admission_id,
    handoff_state,
    created_at DESC
  );

CREATE INDEX idx_discharge_pending_result_handoffs_owner
  ON discharge_pending_result_handoffs (
    tenant_id,
    named_physician_uid,
    handoff_state,
    created_at DESC
  );

CREATE INDEX idx_discharge_pending_result_handoffs_summary
  ON discharge_pending_result_handoffs (
    tenant_id,
    discharge_summary_id,
    created_at DESC
  )
  WHERE discharge_summary_id IS NOT NULL;

-- Every signed generation that becomes actionable for a discharge handoff gets
-- its own immutable owner-action row. The handoff keeps the first generation as
-- a fill-once anchor; corrected generations advance through this append-only
-- chain instead of rewriting that evidence.
CREATE TABLE discharge_pending_result_owner_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  handoff_id UUID NOT NULL,
  admission_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  generation_id UUID NOT NULL,
  predecessor_generation_id UUID,
  predecessor_owner_action_id UUID,
  predecessor_resolution_action_id UUID,
  rearm_source_action_id UUID,
  task_id INTEGER NOT NULL,
  owner_uid UUID NOT NULL,
  source_outbox_event_id BIGINT NOT NULL,
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(220) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT ux_discharge_pending_result_owner_actions_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_discharge_pending_result_owner_actions_context
    UNIQUE (
      tenant_id,
      id,
      handoff_id,
      admission_id,
      patient_uid
    ),
  CONSTRAINT ux_discharge_pending_result_owner_actions_task
    UNIQUE (tenant_id, task_id),
  CONSTRAINT ux_discharge_pending_result_owner_actions_outbox
    UNIQUE (tenant_id, source_outbox_event_id),
  CONSTRAINT ux_discharge_pending_result_owner_actions_timeline
    UNIQUE (tenant_id, canonical_timeline_event_id),
  CONSTRAINT ux_discharge_pending_result_owner_actions_audit
    UNIQUE (tenant_id, canonical_audit_event_id),
  CONSTRAINT ux_discharge_pending_result_owner_actions_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_discharge_pending_result_owner_actions_handoff
    FOREIGN KEY (tenant_id, handoff_id, admission_id, patient_uid)
    REFERENCES discharge_pending_result_handoffs (
      tenant_id,
      id,
      admission_id,
      patient_uid
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_owner_actions_generation
    FOREIGN KEY (tenant_id, generation_id, patient_uid, admission_id)
    REFERENCES diagnostic_result_generations (
      tenant_id,
      id,
      patient_uid,
      admission_id
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_owner_actions_predecessor
    FOREIGN KEY (
      tenant_id,
      predecessor_generation_id,
      patient_uid,
      admission_id
    )
    REFERENCES diagnostic_result_generations (
      tenant_id,
      id,
      patient_uid,
      admission_id
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_owner_actions_owner_predecessor
    FOREIGN KEY (
      tenant_id,
      predecessor_owner_action_id,
      handoff_id,
      admission_id,
      patient_uid
    )
    REFERENCES discharge_pending_result_owner_actions (
      tenant_id,
      id,
      handoff_id,
      admission_id,
      patient_uid
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_s4_owner_action_resolution_predecessor
    FOREIGN KEY (
      tenant_id,
      predecessor_resolution_action_id,
      patient_uid
    )
    REFERENCES diagnostic_result_actions (
      tenant_id,
      id,
      patient_uid
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_discharge_pending_result_owner_actions_rearm_source
    FOREIGN KEY (tenant_id, rearm_source_action_id, patient_uid)
    REFERENCES diagnostic_result_actions (
      tenant_id,
      id,
      patient_uid
    )
    ON UPDATE NO ACTION ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_discharge_pending_result_owner_actions_task
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_owner_actions_owner
    FOREIGN KEY (tenant_id, owner_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_owner_actions_outbox
    FOREIGN KEY (tenant_id, source_outbox_event_id)
    REFERENCES event_outbox (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_owner_actions_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_discharge_pending_result_owner_actions_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_discharge_pending_result_owner_actions_identity CHECK (
    NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
    AND predecessor_owner_action_id IS DISTINCT FROM id
    AND (
      (
        predecessor_owner_action_id IS NULL
        AND predecessor_generation_id IS NULL
        AND predecessor_resolution_action_id IS NULL
        AND rearm_source_action_id IS NULL
      )
      OR predecessor_owner_action_id IS NOT NULL
    )
  ),
  CONSTRAINT chk_discharge_pending_result_owner_actions_metadata CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE UNIQUE INDEX ux_discharge_pending_result_owner_actions_successor
  ON discharge_pending_result_owner_actions (
    tenant_id,
    predecessor_owner_action_id,
    handoff_id,
    admission_id,
    patient_uid
  );

CREATE INDEX idx_discharge_pending_result_owner_actions_generation
  ON discharge_pending_result_owner_actions (
    tenant_id,
    handoff_id,
    generation_id
  );

CREATE INDEX idx_discharge_pending_result_owner_actions_handoff
  ON discharge_pending_result_owner_actions (
    tenant_id,
    handoff_id,
    recorded_at DESC,
    id DESC
  );

CREATE INDEX idx_discharge_pending_result_owner_actions_owner
  ON discharge_pending_result_owner_actions (
    tenant_id,
    owner_uid,
    recorded_at DESC
  );

-- Discharge settlement is an append-only diagnostic action. A human
-- disposition is independently cross-signed by the current inpatient owner;
-- explicitly normal generations retain their existing system closure action.
ALTER TABLE diagnostic_result_actions
  DROP CONSTRAINT chk_diagnostic_action_kind,
  DROP CONSTRAINT chk_diagnostic_action_shape;

ALTER TABLE diagnostic_result_actions
  ADD CONSTRAINT chk_diagnostic_action_kind CHECK (
    action_kind IN (
      'normal_auto_closed',
      'doctor_reopened',
      'doctor_disposition',
      'generation_superseded',
      'discharge_owner_cross_sign'
    )
  ),
  ADD CONSTRAINT chk_diagnostic_action_shape CHECK (
    (
      action_kind = 'normal_auto_closed'
      AND disposition IS NULL
      AND clinical_note IS NULL
      AND reason IS NULL
      AND actor_uid IS NULL
      AND actor_role IS NULL
      AND predecessor_action_id IS NULL
      AND superseding_generation_id IS NULL
      AND release_decision IS NOT NULL
      AND signature_id IS NULL
    )
    OR
    (
      action_kind = 'doctor_reopened'
      AND disposition IS NULL
      AND clinical_note IS NULL
      AND NULLIF(BTRIM(reason), '') IS NOT NULL
      AND actor_uid IS NOT NULL
      AND NULLIF(BTRIM(actor_role), '') IS NOT NULL
      AND predecessor_action_id IS NOT NULL
      AND superseding_generation_id IS NULL
      AND release_decision IS NULL
      AND signature_id IS NULL
    )
    OR
    (
      action_kind = 'doctor_disposition'
      AND disposition IS NOT NULL
      AND NULLIF(BTRIM(clinical_note), '') IS NOT NULL
      AND actor_uid IS NOT NULL
      AND NULLIF(BTRIM(actor_role), '') IS NOT NULL
      AND superseding_generation_id IS NULL
      AND release_decision IS NULL
      AND signature_id IS NOT NULL
      AND (
        (
          disposition = 'no_action'
          AND NULLIF(BTRIM(reason), '') IS NOT NULL
          AND downstream_resource_type IS NULL
          AND downstream_resource_id IS NULL
        )
        OR
        (
          disposition IN ('treated', 'repeated', 'referred')
          AND num_nonnulls(
                downstream_resource_type,
                downstream_resource_id
              ) IN (0, 2)
        )
      )
    )
    OR
    (
      action_kind = 'generation_superseded'
      AND disposition IS NULL
      AND clinical_note IS NULL
      AND reason IS NULL
      AND actor_uid IS NULL
      AND actor_role IS NULL
      AND superseding_generation_id IS NOT NULL
      AND release_decision IS NULL
      AND signature_id IS NULL
    )
    OR
    (
      action_kind = 'discharge_owner_cross_sign'
      AND pathway_instance_id IS NOT NULL
      AND task_id IS NOT NULL
      AND disposition IS NULL
      AND clinical_note IS NULL
      AND reason IS NULL
      AND actor_uid IS NOT NULL
      AND NULLIF(BTRIM(actor_role), '') IS NOT NULL
      AND downstream_resource_type =
            'discharge_pending_result_handoff'
      AND NULLIF(BTRIM(downstream_resource_id), '') IS NOT NULL
      AND pg_input_is_valid(downstream_resource_id, 'uuid')
      AND predecessor_action_id IS NOT NULL
      AND superseding_generation_id IS NULL
      AND release_decision IS NULL
      AND signature_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX ux_diagnostic_action_discharge_owner_cross_sign
  ON diagnostic_result_actions (
    tenant_id,
    downstream_resource_id,
    predecessor_action_id
  )
  WHERE action_kind = 'discharge_owner_cross_sign';

CREATE OR REPLACE FUNCTION s4_validate_pending_result_handoff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reference_record RECORD;
  current_assignment_id UUID;
  task_record RECORD;
  predecessor_tracking_task_record RECORD;
  summary_record RECORD;
  summary_event RECORD;
  generation_record RECORD;
  owner_action_record RECORD;
  resolution_action_record RECORD;
  resolution_timeline_record RECORD;
  resolution_audit_record RECORD;
  settlement_timeline_record RECORD;
  settlement_audit_record RECORD;
  settlement_outbox_count INTEGER;
  rearm_source_record RECORD;
BEGIN
  SELECT reference.relationship_kind,
         reference.evidence_state,
         pathway.pathway_key,
         pathway.source_episode_type,
         pathway.source_episode_id
    INTO reference_record
    FROM care_pathway_resource_references AS reference
    JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = reference.tenant_id
     AND pathway.id = reference.pathway_instance_id
     AND pathway.patient_uid = reference.patient_uid
   WHERE reference.tenant_id = NEW.tenant_id
     AND reference.id = NEW.resource_reference_id
     AND reference.patient_uid = NEW.patient_uid
     AND reference.resource_type = NEW.source_type
     AND reference.resource_id = NEW.source_id
   FOR SHARE OF reference, pathway;

  IF NOT FOUND
     OR reference_record.relationship_kind <> 'child_action'
     OR reference_record.evidence_state = 'superseded'
     OR reference_record.pathway_key <> 'inpatient_admission_to_recovery'
     OR reference_record.source_episode_type <> 'admission'
     OR reference_record.source_episode_id <> NEW.admission_id::text
  THEN
    RAISE EXCEPTION
      'pending-result handoff requires an exact live inpatient source reference'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT assignment.id
    INTO current_assignment_id
    FROM inpatient_primary_physician_assignments AS assignment
   WHERE assignment.tenant_id = NEW.tenant_id
     AND assignment.admission_id = NEW.admission_id
     AND assignment.patient_uid = NEW.patient_uid
   ORDER BY assignment.assignment_version DESC
   LIMIT 1
   FOR SHARE;

  IF current_assignment_id IS DISTINCT FROM
       NEW.primary_physician_assignment_id
  THEN
    RAISE EXCEPTION
      'pending-result handoff must use the current primary physician assignment'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT task.task_kind,
         task.parent_task_id,
         task.patient_uid,
         task.related_resource_type,
         task.related_resource_id,
         task.assigned_to_uid,
         task.assigned_to_role,
         task.status,
         task.metadata
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.id = NEW.task_id
   FOR SHARE;

  IF NOT FOUND
     OR task_record.task_kind IS DISTINCT FROM 'follow_up'
     OR task_record.parent_task_id IS NOT NULL
     OR task_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR task_record.related_resource_type IS DISTINCT FROM
          'discharge_pending_result_handoff'
     OR task_record.related_resource_id IS DISTINCT FROM NEW.id::text
     OR task_record.assigned_to_uid IS DISTINCT FROM NEW.named_physician_uid
     OR task_record.assigned_to_role IS NOT NULL
     OR jsonb_typeof(task_record.metadata) IS DISTINCT FROM 'object'
     OR NOT (
       task_record.metadata ?& ARRAY[
         'admission_id',
         'source_type',
         'source_id',
         'task_contract',
         'correlation_contract',
         'predecessor_tracking_task_id',
         'rearm_reason'
       ]
     )
     OR task_record.metadata ->> 'admission_id' IS DISTINCT FROM
          NEW.admission_id::text
     OR task_record.metadata ->> 'source_type' IS DISTINCT FROM
          NEW.source_type
     OR task_record.metadata ->> 'source_id' IS DISTINCT FROM NEW.source_id
     OR task_record.metadata ->> 'task_contract' IS DISTINCT FROM
          'discharge_pending_result_tracking_v1'
     OR task_record.metadata ->> 'correlation_contract' IS DISTINCT FROM
          'pending_result_tracking_v1'
     OR (
       NEW.handoff_state IN ('pending', 'result_available')
       AND (
         task_record.status IS NULL
         OR task_record.status NOT IN (
           'open',
           'in_progress',
           'blocked',
           'overdue'
         )
       )
     )
     OR (
       NEW.handoff_state = 'resolved'
       AND task_record.status IS DISTINCT FROM 'completed'
     )
     OR (
       NEW.handoff_state = 'superseded'
       AND (
         task_record.status IS NULL
         OR task_record.status NOT IN ('completed', 'cancelled')
       )
     )
  THEN
    RAISE EXCEPTION
      'pending-result handoff task must be bound to the exact named physician, handoff, and lifecycle state'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (
       task_record.metadata ->> 'predecessor_tracking_task_id' IS NULL
     ) <> (
       task_record.metadata ->> 'rearm_reason' IS NULL
     )
     OR (
       task_record.metadata ->> 'rearm_reason' IS NOT NULL
       AND task_record.metadata ->> 'rearm_reason' NOT IN (
         'doctor_reopened',
         'corrected_generation'
       )
     )
  THEN
    RAISE EXCEPTION
      'pending-result tracking task lineage requires an exact predecessor and re-arm reason pair'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.metadata ->> 'predecessor_tracking_task_id' IS NOT NULL
  THEN
    SELECT predecessor.id,
           predecessor.patient_uid,
           predecessor.related_resource_type,
           predecessor.related_resource_id,
           predecessor.assigned_to_uid,
           predecessor.assigned_to_role,
           predecessor.status,
           predecessor.completed_at
      INTO predecessor_tracking_task_record
      FROM tasks AS predecessor
     WHERE predecessor.tenant_id = NEW.tenant_id
       AND predecessor.id::text =
             task_record.metadata ->> 'predecessor_tracking_task_id'
     FOR SHARE OF predecessor;

    IF NOT FOUND
       OR predecessor_tracking_task_record.id = NEW.task_id
       OR predecessor_tracking_task_record.patient_uid IS DISTINCT FROM
            NEW.patient_uid
       OR predecessor_tracking_task_record.related_resource_type
            IS DISTINCT FROM 'discharge_pending_result_handoff'
       OR predecessor_tracking_task_record.related_resource_id
            IS DISTINCT FROM NEW.id::text
       OR predecessor_tracking_task_record.assigned_to_uid
            IS DISTINCT FROM NEW.named_physician_uid
       OR predecessor_tracking_task_record.assigned_to_role IS NOT NULL
       OR predecessor_tracking_task_record.status IS DISTINCT FROM
            'completed'
       OR predecessor_tracking_task_record.completed_at IS NULL
    THEN
      RAISE EXCEPTION
        'pending-result tracking task re-arm predecessor is not the exact completed prior owner task'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.discharge_summary_id IS NOT NULL THEN
    SELECT summary.id,
           summary.status,
           summary.signed_at
      INTO summary_record
      FROM discharge_summaries AS summary
     WHERE summary.tenant_id = NEW.tenant_id
       AND summary.id = NEW.discharge_summary_id
       AND summary.admission_id = NEW.admission_id
       AND summary.patient_uid = NEW.patient_uid
     FOR SHARE;

    SELECT timeline.id,
           timeline.patient_uid,
           timeline.event_type,
           timeline.source_table,
           timeline.source_id
      INTO summary_event
      FROM clinical_timeline_events AS timeline
     WHERE timeline.tenant_id = NEW.tenant_id
       AND timeline.id = NEW.summary_inclusion_timeline_event_id
     FOR SHARE;

    IF summary_record.id IS NULL
       OR summary_record.status NOT IN ('signed', 'delivered')
       OR summary_record.signed_at IS NULL
       OR summary_event.id IS NULL
       OR summary_event.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR summary_event.event_type <>
            'discharge_summary.signed'
       OR summary_event.source_table <> 'discharge_summaries'
       OR summary_event.source_id <> NEW.discharge_summary_id::text
    THEN
      RAISE EXCEPTION
        'pending-result summary inclusion must reference the exact signed discharge summary event'
      USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.resolution_generation_id IS NOT NULL THEN
    SELECT generation.id,
           generation.admission_id,
           generation.investigation_id,
           generation.radiology_order_id,
           generation.snapshot_sha256,
           EXISTS (
             SELECT 1
               FROM diagnostic_result_generation_items AS item
              WHERE item.tenant_id = generation.tenant_id
                AND item.generation_id = generation.id
                AND item.patient_uid = generation.patient_uid
                AND item.source_table = 'lab_results'
                AND item.source_row_id = NEW.source_id
           ) AS matches_lab_result,
           EXISTS (
             SELECT 1
               FROM ap_reports AS report
              WHERE report.tenant_id = generation.tenant_id
                AND report.id = generation.ap_report_id
                AND report.ap_case_id::text = NEW.source_id
           ) AS matches_ap_case
      INTO generation_record
      FROM diagnostic_result_generations AS generation
     WHERE generation.tenant_id = NEW.tenant_id
       AND generation.id = NEW.resolution_generation_id
       AND generation.patient_uid = NEW.patient_uid
       AND generation.admission_id = NEW.admission_id
     FOR SHARE OF generation;

    IF NOT FOUND
       OR NOT (
         (
           NEW.source_type = 'diagnostic_result_generation'
           AND generation_record.id::text = NEW.source_id
         )
         OR
         (
           NEW.source_type = 'investigation'
           AND generation_record.investigation_id::text = NEW.source_id
         )
         OR
         (
           NEW.source_type = 'lab_result'
           AND generation_record.matches_lab_result
         )
         OR
         (
           NEW.source_type = 'radiology_order'
           AND generation_record.radiology_order_id::text = NEW.source_id
         )
         OR
         (
           NEW.source_type = 'anatomical_pathology_case'
           AND generation_record.matches_ap_case
         )
       )
    THEN
      RAISE EXCEPTION
        'pending-result resolution generation must match the exact admission, patient, and typed source'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.handoff_state IN ('result_available', 'resolved') THEN
    SELECT action.id,
           action.generation_id,
           action.predecessor_generation_id,
           action.predecessor_owner_action_id,
           action.predecessor_resolution_action_id,
           action.rearm_source_action_id,
           action.owner_uid,
           action.task_id,
           action_task.assigned_to_uid AS action_task_owner_uid,
           action_task.assigned_to_role AS action_task_owner_role,
           action_task.status AS action_task_status,
           action_task.completed_at AS action_task_completed_at,
           tracking_task.status AS tracking_task_status,
           tracking_task.completed_at AS tracking_task_completed_at
      INTO owner_action_record
      FROM discharge_pending_result_owner_actions AS action
      JOIN tasks AS action_task
        ON action_task.tenant_id = action.tenant_id
       AND action_task.id = action.task_id
      JOIN tasks AS tracking_task
        ON tracking_task.tenant_id = NEW.tenant_id
       AND tracking_task.id = NEW.task_id
     WHERE action.tenant_id = NEW.tenant_id
       AND action.handoff_id = NEW.id
       AND action.admission_id = NEW.admission_id
       AND action.patient_uid = NEW.patient_uid
       AND NOT EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS successor
          WHERE successor.tenant_id = action.tenant_id
            AND successor.handoff_id = action.handoff_id
            AND successor.predecessor_owner_action_id = action.id
       )
     FOR SHARE OF action, action_task, tracking_task;

    IF NOT FOUND
       OR owner_action_record.action_task_owner_uid IS DISTINCT FROM
            NEW.named_physician_uid
       OR owner_action_record.action_task_owner_role IS NOT NULL
       OR EXISTS (
         SELECT 1
           FROM diagnostic_result_generations AS successor
          WHERE successor.tenant_id = NEW.tenant_id
            AND successor.predecessor_generation_id =
                  owner_action_record.generation_id
            AND successor.patient_uid = NEW.patient_uid
            AND successor.admission_id = NEW.admission_id
       )
       OR (
         NEW.handoff_state = 'result_available'
         AND (
           owner_action_record.action_task_status IS NULL
           OR owner_action_record.action_task_status NOT IN (
             'open',
             'in_progress',
             'blocked',
             'overdue'
           )
           OR owner_action_record.tracking_task_status IS NULL
           OR owner_action_record.tracking_task_status NOT IN (
             'open',
             'in_progress',
             'blocked',
             'overdue'
           )
         )
       )
       OR (
         NEW.handoff_state = 'resolved'
         AND (
           owner_action_record.action_task_status IS DISTINCT FROM
             'completed'
           OR owner_action_record.action_task_completed_at IS NULL
           OR owner_action_record.tracking_task_status IS DISTINCT FROM
             'completed'
           OR owner_action_record.tracking_task_completed_at IS NULL
         )
       )
    THEN
      RAISE EXCEPTION
        'pending-result state requires the exact current owner action and coherent parent/child task settlement'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.handoff_state = 'resolved' THEN
    SELECT action.action_kind,
           action.generation_id,
           action.patient_uid,
           action.actor_uid,
           action.actor_role,
           action.task_id,
           action.disposition,
           action.downstream_resource_type,
           action.downstream_resource_id,
           action.canonical_timeline_event_id,
           action.canonical_audit_event_id
      INTO resolution_action_record
      FROM diagnostic_result_actions AS action
     WHERE action.tenant_id = NEW.tenant_id
       AND action.id = NEW.resolution_action_id
       AND action.patient_uid = NEW.patient_uid
     FOR SHARE OF action;

    IF NOT FOUND
       OR resolution_action_record.generation_id IS DISTINCT FROM
            owner_action_record.generation_id
       OR resolution_action_record.action_kind NOT IN (
         'normal_auto_closed',
         'doctor_disposition',
         'discharge_owner_cross_sign'
       )
       OR (
         resolution_action_record.action_kind = 'normal_auto_closed'
         AND NEW.resolved_by_uid IS NOT NULL
       )
       OR (
         resolution_action_record.action_kind = 'doctor_disposition'
         AND (
           resolution_action_record.actor_uid IS DISTINCT FROM
             NEW.named_physician_uid
           OR NEW.resolved_by_uid IS DISTINCT FROM
                resolution_action_record.actor_uid
         )
       )
       OR (
         resolution_action_record.action_kind =
               'discharge_owner_cross_sign'
         AND (
           resolution_action_record.actor_uid IS DISTINCT FROM
             NEW.named_physician_uid
           OR NEW.resolved_by_uid IS DISTINCT FROM
                resolution_action_record.actor_uid
           OR resolution_action_record.task_id IS DISTINCT FROM
                owner_action_record.task_id
           OR resolution_action_record.downstream_resource_type
                IS DISTINCT FROM 'discharge_pending_result_handoff'
           OR resolution_action_record.downstream_resource_id
                IS DISTINCT FROM NEW.id::text
         )
       )
    THEN
      RAISE EXCEPTION
        'pending-result resolution requires one exact immutable diagnostic action for the current generation and named owner'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT timeline.event_type,
           timeline.event_status,
           timeline.patient_uid,
           timeline.source_table,
           timeline.source_id,
           timeline.resource_type,
           timeline.resource_id,
           timeline.payload
      INTO resolution_timeline_record
      FROM clinical_timeline_events AS timeline
     WHERE timeline.tenant_id = NEW.tenant_id
       AND timeline.id =
             resolution_action_record.canonical_timeline_event_id
     FOR SHARE OF timeline;

    SELECT audit.action,
           audit.action_status,
           audit.patient_uid,
           audit.resource_type,
           audit.resource_table,
           audit.resource_id
      INTO resolution_audit_record
      FROM clinical_audit_events AS audit
     WHERE audit.tenant_id = NEW.tenant_id
       AND audit.id = resolution_action_record.canonical_audit_event_id
     FOR SHARE OF audit;

    IF resolution_action_record.action_kind IN (
         'normal_auto_closed',
         'doctor_disposition'
       )
       AND (
         resolution_timeline_record.event_type IS DISTINCT FROM
           (CASE resolution_action_record.action_kind
             WHEN 'normal_auto_closed'
               THEN 'diagnostic.result.normal_auto_closed'
             ELSE 'diagnostic.result.action_recorded'
           END)
         OR resolution_timeline_record.event_status IS DISTINCT FROM
           (CASE resolution_action_record.action_kind
             WHEN 'normal_auto_closed' THEN 'closed'
             ELSE resolution_action_record.disposition
           END)
         OR resolution_timeline_record.patient_uid IS DISTINCT FROM
              NEW.patient_uid
         OR resolution_timeline_record.source_table IS DISTINCT FROM
              'diagnostic_result_actions'
         OR resolution_timeline_record.source_id IS DISTINCT FROM
              NEW.resolution_action_id::text
         OR resolution_timeline_record.resource_type IS DISTINCT FROM
              'diagnostic_result_action'
         OR resolution_timeline_record.resource_id IS DISTINCT FROM
              NEW.resolution_action_id::text
         OR jsonb_typeof(resolution_timeline_record.payload)
              IS DISTINCT FROM 'object'
         OR resolution_timeline_record.payload ->> 'action_id'
              IS DISTINCT FROM NEW.resolution_action_id::text
         OR resolution_timeline_record.payload ->> 'generation_id'
              IS DISTINCT FROM owner_action_record.generation_id::text
         OR resolution_audit_record.action IS DISTINCT FROM
           (CASE resolution_action_record.action_kind
             WHEN 'normal_auto_closed'
               THEN 'diagnostic.result.normal_auto_closed'
             ELSE 'diagnostic.result.action_recorded'
           END)
         OR resolution_audit_record.action_status IS DISTINCT FROM
              'success'
         OR resolution_audit_record.patient_uid IS DISTINCT FROM
              NEW.patient_uid
         OR resolution_audit_record.resource_type IS DISTINCT FROM
              'diagnostic_result_action'
         OR resolution_audit_record.resource_table IS DISTINCT FROM
              'diagnostic_result_actions'
         OR resolution_audit_record.resource_id IS DISTINCT FROM
              NEW.resolution_action_id::text
       )
    THEN
      RAISE EXCEPTION
        'pending-result resolution action lacks its exact canonical diagnostic event'
        USING ERRCODE = 'check_violation';
    END IF;

    IF resolution_action_record.action_kind IN (
         'normal_auto_closed',
         'doctor_disposition'
       )
    THEN
      SELECT timeline.id,
             timeline.event_type,
             timeline.event_status,
             timeline.patient_uid,
             timeline.source_table,
             timeline.source_id,
             timeline.resource_type,
             timeline.resource_id,
             timeline.actor_uid,
             timeline.actor_role,
             timeline.visible_to_patient,
             timeline.payload,
             timeline.idempotency_key
        INTO settlement_timeline_record
        FROM clinical_timeline_events AS timeline
       WHERE timeline.tenant_id = NEW.tenant_id
         AND timeline.idempotency_key = FORMAT(
           'pending-result-resolved:%s:%s:%s:timeline',
           NEW.tenant_id::text,
           NEW.id::text,
           NEW.resolution_action_id::text
         )
       FOR SHARE OF timeline;

      IF NOT FOUND
         OR settlement_timeline_record.event_type IS DISTINCT FROM
              'discharge.pending_result_resolved'
         OR settlement_timeline_record.event_status IS DISTINCT FROM
              (CASE resolution_action_record.action_kind
                WHEN 'normal_auto_closed' THEN 'normal_auto_closed'
                ELSE 'ordering_owner_disposition'
              END)
         OR settlement_timeline_record.patient_uid IS DISTINCT FROM
              NEW.patient_uid
         OR settlement_timeline_record.source_table IS DISTINCT FROM
              'diagnostic_result_actions'
         OR settlement_timeline_record.source_id IS DISTINCT FROM
              NEW.resolution_action_id::text
         OR settlement_timeline_record.resource_type IS DISTINCT FROM
              'discharge_pending_result_handoff'
         OR settlement_timeline_record.resource_id IS DISTINCT FROM
              NEW.id::text
         OR settlement_timeline_record.actor_uid IS DISTINCT FROM
              (CASE resolution_action_record.action_kind
                WHEN 'normal_auto_closed' THEN NULL::uuid
                ELSE NEW.named_physician_uid
              END)
         OR settlement_timeline_record.actor_role IS DISTINCT FROM
              (CASE resolution_action_record.action_kind
                WHEN 'normal_auto_closed' THEN NULL::text
                ELSE resolution_action_record.actor_role
              END)
         OR settlement_timeline_record.visible_to_patient IS DISTINCT FROM
              FALSE
         OR jsonb_typeof(settlement_timeline_record.payload)
              IS DISTINCT FROM 'object'
         OR (
              SELECT COUNT(*)
                FROM jsonb_object_keys(
                  settlement_timeline_record.payload
                )
            ) IS DISTINCT FROM 7
         OR settlement_timeline_record.payload ->> 'admission_id'
              IS DISTINCT FROM NEW.admission_id::text
         OR settlement_timeline_record.payload ->> 'handoff_id'
              IS DISTINCT FROM NEW.id::text
         OR settlement_timeline_record.payload ->> 'generation_id'
              IS DISTINCT FROM owner_action_record.generation_id::text
         OR settlement_timeline_record.payload ->> 'owner_action_id'
              IS DISTINCT FROM owner_action_record.id::text
         OR settlement_timeline_record.payload ->> 'action_task_id'
              IS DISTINCT FROM owner_action_record.task_id::text
         OR settlement_timeline_record.payload ->> 'tracking_task_id'
              IS DISTINCT FROM NEW.task_id::text
         OR settlement_timeline_record.payload ->> 'resolution_action_id'
              IS DISTINCT FROM NEW.resolution_action_id::text
      THEN
        RAISE EXCEPTION
          'pending-result settlement requires its exact discharge-resolution timeline receipt'
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT audit.id,
             audit.action,
             audit.action_status,
             audit.patient_uid,
             audit.actor_uid,
             audit.actor_role,
             audit.resource_type,
             audit.resource_table,
             audit.resource_id,
             audit.after_state,
             audit.idempotency_key
        INTO settlement_audit_record
        FROM clinical_audit_events AS audit
       WHERE audit.tenant_id = NEW.tenant_id
         AND audit.idempotency_key = FORMAT(
           'pending-result-resolved:%s:%s:%s:audit',
           NEW.tenant_id::text,
           NEW.id::text,
           NEW.resolution_action_id::text
         )
       FOR SHARE OF audit;

      IF NOT FOUND
         OR settlement_audit_record.action IS DISTINCT FROM
              'discharge.pending_result_resolved'
         OR settlement_audit_record.action_status IS DISTINCT FROM 'success'
         OR settlement_audit_record.patient_uid IS DISTINCT FROM
              NEW.patient_uid
         OR settlement_audit_record.actor_uid IS DISTINCT FROM
              (CASE resolution_action_record.action_kind
                WHEN 'normal_auto_closed' THEN NULL::uuid
                ELSE NEW.named_physician_uid
              END)
         OR settlement_audit_record.actor_role IS DISTINCT FROM
              (CASE resolution_action_record.action_kind
                WHEN 'normal_auto_closed' THEN NULL::text
                ELSE resolution_action_record.actor_role
              END)
         OR settlement_audit_record.resource_type IS DISTINCT FROM
              'discharge_pending_result_handoff'
         OR settlement_audit_record.resource_table IS DISTINCT FROM
              'discharge_pending_result_handoffs'
         OR settlement_audit_record.resource_id IS DISTINCT FROM NEW.id::text
         OR jsonb_typeof(settlement_audit_record.after_state)
              IS DISTINCT FROM 'object'
         OR (
              SELECT COUNT(*)
                FROM jsonb_object_keys(
                  settlement_audit_record.after_state
                )
            ) IS DISTINCT FROM 3
         OR settlement_audit_record.after_state ->> 'handoff_state'
              IS DISTINCT FROM 'resolved'
         OR settlement_audit_record.after_state ->> 'resolution_action_id'
              IS DISTINCT FROM NEW.resolution_action_id::text
         OR settlement_audit_record.after_state ->>
              'generation_snapshot_sha256'
              IS DISTINCT FROM generation_record.snapshot_sha256
      THEN
        RAISE EXCEPTION
          'pending-result settlement requires its exact discharge-resolution audit receipt'
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT COUNT(*)::integer
        INTO settlement_outbox_count
        FROM event_outbox AS event
       WHERE event.tenant_id = NEW.tenant_id
         AND event.event_type = 'discharge.pending_result_resolved'
         AND event.aggregate_type = 'discharge_pending_result_handoff'
         AND event.aggregate_id = NEW.id::text
         AND event.patient_uid = NEW.patient_uid
         AND jsonb_typeof(event.payload) = 'object'
         AND (
               SELECT COUNT(*)
                 FROM jsonb_object_keys(event.payload)
             ) = 10
         AND event.payload ->> 'admission_id' = NEW.admission_id::text
         AND event.payload ->> 'handoff_id' = NEW.id::text
         AND event.payload ->> 'generation_id' =
               owner_action_record.generation_id::text
         AND event.payload ->> 'owner_action_id' =
               owner_action_record.id::text
         AND event.payload ->> 'action_task_id' =
               owner_action_record.task_id::text
         AND event.payload ->> 'tracking_task_id' = NEW.task_id::text
         AND event.payload ->> 'resolution_action_id' =
               NEW.resolution_action_id::text
         AND event.payload ->> 'canonical_timeline_event_id' =
               settlement_timeline_record.id::text
         AND event.payload ->> 'canonical_audit_event_id' =
               settlement_audit_record.id::text
         AND event.payload ->> 'admission_lineage_version' = '1';

      IF settlement_outbox_count <> 1 THEN
        RAISE EXCEPTION
          'pending-result settlement requires one exact discharge-resolution outbox receipt'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.handoff_state = 'resolved'
     AND NEW.handoff_state = 'result_available'
  THEN
    IF NEW.task_id IS NOT DISTINCT FROM OLD.task_id
       OR task_record.metadata ->> 'predecessor_tracking_task_id'
            IS DISTINCT FROM OLD.task_id::text
       OR task_record.metadata ->> 'rearm_reason' IS DISTINCT FROM
            (CASE
              WHEN owner_action_record.rearm_source_action_id IS NOT NULL
                THEN 'doctor_reopened'
              ELSE 'corrected_generation'
            END)
       OR NEW.resolution_action_id IS NOT NULL
       OR NEW.resolved_at IS NOT NULL
       OR NEW.resolved_by_uid IS NOT NULL
       OR owner_action_record.predecessor_owner_action_id IS NULL
       OR owner_action_record.predecessor_resolution_action_id
            IS DISTINCT FROM OLD.resolution_action_id
       OR NOT EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS predecessor
           JOIN tasks AS predecessor_task
             ON predecessor_task.tenant_id = predecessor.tenant_id
            AND predecessor_task.id = predecessor.task_id
          WHERE predecessor.tenant_id = NEW.tenant_id
            AND predecessor.id =
                  owner_action_record.predecessor_owner_action_id
            AND predecessor.handoff_id = NEW.id
            AND predecessor.admission_id = NEW.admission_id
            AND predecessor.patient_uid = NEW.patient_uid
            AND predecessor_task.assigned_to_uid =
                  NEW.named_physician_uid
            AND predecessor_task.assigned_to_role IS NULL
            AND predecessor_task.status = 'completed'
            AND predecessor_task.completed_at IS NOT NULL
            AND (
              (
                owner_action_record.predecessor_generation_id IS NULL
                AND predecessor.generation_id =
                      owner_action_record.generation_id
              )
              OR
              (
                owner_action_record.predecessor_generation_id =
                      predecessor.generation_id
                AND EXISTS (
                  SELECT 1
                    FROM diagnostic_result_generations AS successor_generation
                   WHERE successor_generation.tenant_id = NEW.tenant_id
                     AND successor_generation.id =
                           owner_action_record.generation_id
                     AND successor_generation.patient_uid =
                           NEW.patient_uid
                     AND successor_generation.admission_id =
                           NEW.admission_id
                     AND successor_generation.predecessor_generation_id =
                           predecessor.generation_id
                )
              )
            )
       )
    THEN
      RAISE EXCEPTION
        'resolved pending-result handoff may re-arm only through an exact successor owner action carrying its prior resolution receipt'
        USING ERRCODE = 'check_violation';
    END IF;

    IF owner_action_record.predecessor_generation_id IS NULL THEN
      SELECT action.action_kind,
             action.generation_id,
             action.patient_uid,
             action.predecessor_action_id
        INTO rearm_source_record
        FROM diagnostic_result_actions AS action
       WHERE action.tenant_id = NEW.tenant_id
         AND action.id = owner_action_record.rearm_source_action_id
         AND action.patient_uid = NEW.patient_uid
       FOR SHARE OF action;

      IF NOT FOUND
         OR rearm_source_record.action_kind IS DISTINCT FROM
              'doctor_reopened'
         OR rearm_source_record.generation_id IS DISTINCT FROM
              owner_action_record.generation_id
         OR rearm_source_record.predecessor_action_id IS DISTINCT FROM
              OLD.resolution_action_id
      THEN
        RAISE EXCEPTION
          'same-generation pending-result re-arm requires the exact doctor reopen of its normal resolution action'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF owner_action_record.rearm_source_action_id IS NOT NULL THEN
      RAISE EXCEPTION
        'corrected-generation pending-result re-arm derives from the direct successor generation, not an unrelated action'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_discharge_pending_result_handoffs_validate
AFTER INSERT OR UPDATE ON discharge_pending_result_handoffs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_validate_pending_result_handoff();

CREATE OR REPLACE FUNCTION s4_pending_result_handoff_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'discharge_pending_result_handoffs cannot be deleted'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF ROW(
       OLD.id,
       OLD.tenant_id,
       OLD.admission_id,
       OLD.patient_uid,
       OLD.resource_reference_id,
       OLD.source_type,
       OLD.source_id,
       OLD.patient_safe_label,
       OLD.created_by_uid,
       OLD.created_at,
       OLD.idempotency_key,
       OLD.metadata
     ) IS DISTINCT FROM ROW(
       NEW.id,
       NEW.tenant_id,
       NEW.admission_id,
       NEW.patient_uid,
       NEW.resource_reference_id,
       NEW.source_type,
       NEW.source_id,
       NEW.patient_safe_label,
       NEW.created_by_uid,
       NEW.created_at,
       NEW.idempotency_key,
       NEW.metadata
     )
  THEN
    RAISE EXCEPTION
      'pending-result handoff identity and source evidence are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.task_id IS DISTINCT FROM NEW.task_id
     AND NOT (
       OLD.handoff_state = 'resolved'
       AND NEW.handoff_state = 'result_available'
     )
  THEN
    RAISE EXCEPTION
      'pending-result tracking task may change only during a governed resolution re-arm'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (
       OLD.handoff_state = 'superseded'
       OR (
         OLD.handoff_state = 'resolved'
         AND NEW.handoff_state = 'resolved'
       )
     )
     AND ROW(
       OLD.handoff_state,
       OLD.result_status,
       OLD.primary_physician_assignment_id,
       OLD.named_physician_uid,
       OLD.discharge_summary_id,
       OLD.summary_included_at,
       OLD.summary_inclusion_timeline_event_id,
       OLD.notification_outbox_id,
       OLD.resolution_generation_id,
       OLD.resolution_action_id,
       OLD.resolved_at,
       OLD.resolved_by_uid
     ) IS DISTINCT FROM ROW(
       NEW.handoff_state,
       NEW.result_status,
       NEW.primary_physician_assignment_id,
       NEW.named_physician_uid,
       NEW.discharge_summary_id,
       NEW.summary_included_at,
       NEW.summary_inclusion_timeline_event_id,
       NEW.notification_outbox_id,
       NEW.resolution_generation_id,
       NEW.resolution_action_id,
       NEW.resolved_at,
       NEW.resolved_by_uid
     )
  THEN
    RAISE EXCEPTION
      'terminal pending-result handoff evidence is immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.handoff_state = 'resolved'
     AND NEW.handoff_state = 'result_available'
     AND (
       NEW.result_status IS DISTINCT FROM 'available'
       OR ROW(
            OLD.discharge_summary_id,
            OLD.summary_included_at,
            OLD.summary_inclusion_timeline_event_id,
            OLD.notification_outbox_id,
            OLD.resolution_generation_id
          ) IS DISTINCT FROM ROW(
            NEW.discharge_summary_id,
            NEW.summary_included_at,
            NEW.summary_inclusion_timeline_event_id,
            NEW.notification_outbox_id,
            NEW.resolution_generation_id
          )
       OR NEW.resolution_action_id IS NOT NULL
       OR NEW.resolved_at IS NOT NULL
       OR NEW.resolved_by_uid IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'pending-result re-arm may clear only the operational resolution receipt while preserving sealed handoff evidence'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.discharge_summary_id IS NOT NULL
     AND ROW(
       OLD.discharge_summary_id,
       OLD.summary_included_at,
       OLD.summary_inclusion_timeline_event_id
     ) IS DISTINCT FROM ROW(
       NEW.discharge_summary_id,
       NEW.summary_included_at,
       NEW.summary_inclusion_timeline_event_id
     )
  THEN
    RAISE EXCEPTION
      'pending-result signed-summary inclusion evidence is fill-once'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.resolution_generation_id IS NOT NULL
     AND OLD.resolution_generation_id IS DISTINCT FROM
           NEW.resolution_generation_id
  THEN
    RAISE EXCEPTION
      'pending-result resolution generation evidence is fill-once'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT (
    NEW.handoff_state = OLD.handoff_state
    OR (OLD.handoff_state = 'pending'
        AND NEW.handoff_state IN (
          'result_available',
          'resolved',
          'superseded'
        ))
    OR (OLD.handoff_state = 'result_available'
        AND NEW.handoff_state IN ('resolved', 'superseded'))
    OR (OLD.handoff_state = 'resolved'
        AND NEW.handoff_state = 'result_available')
  )
  THEN
    RAISE EXCEPTION
      'invalid pending-result handoff state transition'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION
      'pending-result handoff updates require a later updated_at'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_discharge_pending_result_handoffs_guard
BEFORE UPDATE OR DELETE ON discharge_pending_result_handoffs
FOR EACH ROW EXECUTE FUNCTION s4_pending_result_handoff_guard();

CREATE OR REPLACE FUNCTION s4_validate_pending_result_owner_action()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  handoff_record RECORD;
  generation_record RECORD;
  task_record RECORD;
  timeline_record RECORD;
  audit_record RECORD;
  outbox_record RECORD;
  predecessor_owner_record RECORD;
  predecessor_resolution_record RECORD;
  rearm_action_record RECORD;
BEGIN
  SELECT handoff.admission_id,
         handoff.patient_uid,
         handoff.source_type,
         handoff.source_id,
         handoff.named_physician_uid,
         handoff.task_id,
         handoff.resolution_generation_id,
         handoff.handoff_state
    INTO handoff_record
    FROM discharge_pending_result_handoffs AS handoff
   WHERE handoff.tenant_id = NEW.tenant_id
     AND handoff.id = NEW.handoff_id
     AND handoff.admission_id = NEW.admission_id
     AND handoff.patient_uid = NEW.patient_uid
   FOR SHARE OF handoff;

  IF NOT FOUND
     OR handoff_record.handoff_state IS NULL
     OR handoff_record.handoff_state NOT IN ('result_available', 'resolved')
     OR handoff_record.named_physician_uid IS DISTINCT FROM NEW.owner_uid
  THEN
    RAISE EXCEPTION
      'pending-result owner action requires the exact live or resolved handoff and named owner'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT generation.id,
         generation.predecessor_generation_id,
         generation.source_kind,
         generation.source_episode_key,
         generation.source_version,
         generation.investigation_id,
         generation.radiology_order_id,
         EXISTS (
           SELECT 1
             FROM diagnostic_result_generation_items AS item
            WHERE item.tenant_id = generation.tenant_id
              AND item.generation_id = generation.id
              AND item.patient_uid = generation.patient_uid
              AND item.source_table = 'lab_results'
              AND item.source_row_id = handoff_record.source_id
         ) AS matches_lab_result,
         EXISTS (
           SELECT 1
             FROM ap_reports AS report
            WHERE report.tenant_id = generation.tenant_id
              AND report.id = generation.ap_report_id
              AND report.ap_case_id::text = handoff_record.source_id
         ) AS matches_ap_case
    INTO generation_record
    FROM diagnostic_result_generations AS generation
   WHERE generation.tenant_id = NEW.tenant_id
     AND generation.id = NEW.generation_id
     AND generation.patient_uid = NEW.patient_uid
     AND generation.admission_id = NEW.admission_id
   FOR SHARE OF generation;

  IF NOT FOUND
     OR NOT (
       (
         handoff_record.source_type IS NOT DISTINCT FROM
           'diagnostic_result_generation'
         AND (
           generation_record.id::text IS NOT DISTINCT FROM
             handoff_record.source_id
           OR NEW.predecessor_generation_id IS NOT NULL
         )
       )
       OR
       (
         handoff_record.source_type IS NOT DISTINCT FROM 'investigation'
         AND generation_record.investigation_id::text IS NOT DISTINCT FROM
               handoff_record.source_id
       )
       OR
       (
         handoff_record.source_type IS NOT DISTINCT FROM 'lab_result'
         AND generation_record.matches_lab_result
       )
       OR
       (
         handoff_record.source_type IS NOT DISTINCT FROM 'radiology_order'
         AND generation_record.radiology_order_id::text IS NOT DISTINCT FROM
               handoff_record.source_id
       )
       OR
       (
         handoff_record.source_type IS NOT DISTINCT FROM
           'anatomical_pathology_case'
         AND generation_record.matches_ap_case
       )
     )
  THEN
    RAISE EXCEPTION
      'pending-result owner action generation must match the exact admission, patient, and typed source'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM diagnostic_result_generations AS successor
     WHERE successor.tenant_id = NEW.tenant_id
       AND successor.predecessor_generation_id = NEW.generation_id
       AND successor.patient_uid = NEW.patient_uid
  )
  THEN
    RAISE EXCEPTION
      'pending-result owner action generation must be the current signed leaf'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.predecessor_owner_action_id IS NULL THEN
    IF handoff_record.resolution_generation_id IS DISTINCT FROM
         NEW.generation_id
       OR NEW.predecessor_generation_id IS NOT NULL
       OR NEW.predecessor_resolution_action_id IS NOT NULL
       OR NEW.rearm_source_action_id IS NOT NULL
       OR EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS existing
          WHERE existing.tenant_id = NEW.tenant_id
            AND existing.handoff_id = NEW.handoff_id
            AND existing.id <> NEW.id
       )
    THEN
      RAISE EXCEPTION
        'first pending-result owner action must attest the handoff generation anchor'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT predecessor.id,
           predecessor.generation_id,
           predecessor.owner_uid,
           predecessor_task.assigned_to_uid AS task_owner_uid,
           predecessor_task.assigned_to_role AS task_owner_role,
           predecessor_task.status AS task_status,
           predecessor_task.completed_at,
           predecessor_generation.source_kind,
           predecessor_generation.source_episode_key,
           predecessor_generation.source_version
      INTO predecessor_owner_record
      FROM discharge_pending_result_owner_actions AS predecessor
      JOIN diagnostic_result_generations AS predecessor_generation
        ON predecessor_generation.tenant_id = predecessor.tenant_id
       AND predecessor_generation.id = predecessor.generation_id
       AND predecessor_generation.patient_uid = predecessor.patient_uid
       AND predecessor_generation.admission_id = predecessor.admission_id
      JOIN tasks AS predecessor_task
        ON predecessor_task.tenant_id = predecessor.tenant_id
       AND predecessor_task.id = predecessor.task_id
     WHERE predecessor.tenant_id = NEW.tenant_id
       AND predecessor.id = NEW.predecessor_owner_action_id
       AND predecessor.handoff_id = NEW.handoff_id
       AND predecessor.admission_id = NEW.admission_id
       AND predecessor.patient_uid = NEW.patient_uid
       AND NOT EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS intermediate
          WHERE intermediate.tenant_id = predecessor.tenant_id
            AND intermediate.handoff_id = predecessor.handoff_id
            AND intermediate.predecessor_owner_action_id = predecessor.id
            AND intermediate.id <> NEW.id
       )
     FOR SHARE OF predecessor, predecessor_generation, predecessor_task;

    IF NOT FOUND
       OR predecessor_owner_record.task_owner_uid IS DISTINCT FROM
            NEW.owner_uid
       OR predecessor_owner_record.task_owner_role IS NOT NULL
    THEN
      RAISE EXCEPTION
        'pending-result owner action must extend the exact current owner-action leaf'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT action.action_kind,
           action.generation_id,
           action.patient_uid
      INTO predecessor_resolution_record
      FROM diagnostic_result_actions AS action
     WHERE action.tenant_id = NEW.tenant_id
       AND action.id = NEW.predecessor_resolution_action_id
       AND action.patient_uid = NEW.patient_uid
     FOR SHARE OF action;

    IF NEW.predecessor_generation_id IS NULL THEN
      IF predecessor_owner_record.generation_id IS DISTINCT FROM
           NEW.generation_id
         OR predecessor_owner_record.task_status IS DISTINCT FROM
              'completed'
         OR predecessor_owner_record.completed_at IS NULL
         OR NEW.predecessor_resolution_action_id IS NULL
         OR predecessor_resolution_record.action_kind IS DISTINCT FROM
              'normal_auto_closed'
         OR predecessor_resolution_record.generation_id IS DISTINCT FROM
              NEW.generation_id
         OR NEW.rearm_source_action_id IS NULL
      THEN
        RAISE EXCEPTION
          'same-generation pending-result owner action requires the exact completed predecessor and normal resolution receipt'
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT action.action_kind,
             action.generation_id,
             action.predecessor_action_id
        INTO rearm_action_record
        FROM diagnostic_result_actions AS action
       WHERE action.tenant_id = NEW.tenant_id
         AND action.id = NEW.rearm_source_action_id
         AND action.patient_uid = NEW.patient_uid
       FOR SHARE OF action;

      IF NOT FOUND
         OR rearm_action_record.action_kind IS DISTINCT FROM
              'doctor_reopened'
         OR rearm_action_record.generation_id IS DISTINCT FROM
              NEW.generation_id
         OR rearm_action_record.predecessor_action_id IS DISTINCT FROM
              NEW.predecessor_resolution_action_id
      THEN
        RAISE EXCEPTION
          'same-generation pending-result owner action requires the exact doctor reopen action'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF generation_record.predecessor_generation_id IS DISTINCT FROM
           NEW.predecessor_generation_id
         OR predecessor_owner_record.generation_id IS DISTINCT FROM
              NEW.predecessor_generation_id
         OR predecessor_owner_record.source_kind IS DISTINCT FROM
              generation_record.source_kind
         OR predecessor_owner_record.source_episode_key IS DISTINCT FROM
              generation_record.source_episode_key
         OR predecessor_owner_record.source_version >=
              generation_record.source_version
         OR predecessor_owner_record.task_status NOT IN (
              'completed',
              'cancelled'
            )
         OR NEW.rearm_source_action_id IS NOT NULL
         OR (
           predecessor_owner_record.task_status = 'completed'
           AND (
             predecessor_owner_record.completed_at IS NULL
             OR NEW.predecessor_resolution_action_id IS NULL
             OR predecessor_resolution_record.action_kind NOT IN (
               'normal_auto_closed',
               'doctor_disposition',
               'discharge_owner_cross_sign'
             )
             OR predecessor_resolution_record.generation_id IS DISTINCT FROM
                  NEW.predecessor_generation_id
           )
         )
         OR (
           predecessor_owner_record.task_status = 'cancelled'
           AND NEW.predecessor_resolution_action_id IS NOT NULL
         )
      THEN
        RAISE EXCEPTION
          'corrected pending-result owner action must extend the exact prior owner action and its settlement state'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  SELECT task.task_kind,
         task.parent_task_id,
         task.patient_uid,
         task.related_resource_type,
         task.related_resource_id,
         task.assigned_to_uid,
         task.assigned_to_role,
         task.status,
         task.metadata
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.id = NEW.task_id
   FOR SHARE OF task;

  IF NOT FOUND
     OR task_record.task_kind IS DISTINCT FROM 'review'
     OR task_record.parent_task_id IS DISTINCT FROM handoff_record.task_id
     OR task_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR task_record.related_resource_type IS DISTINCT FROM
          'discharge_pending_result_action'
     OR task_record.related_resource_id IS DISTINCT FROM
          (CASE
            WHEN NEW.rearm_source_action_id IS NOT NULL
              THEN NEW.handoff_id::text || ':' ||
                   NEW.generation_id::text || ':' ||
                   NEW.predecessor_owner_action_id::text
            ELSE NEW.handoff_id::text || ':' || NEW.generation_id::text
          END)
     OR task_record.assigned_to_uid IS DISTINCT FROM NEW.owner_uid
     OR task_record.assigned_to_role IS NOT NULL
     OR jsonb_typeof(task_record.metadata) IS DISTINCT FROM 'object'
     OR NOT (
       task_record.metadata ?& ARRAY[
         'task_contract',
         'handoff_id',
         'generation_id',
         'predecessor_generation_id',
         'predecessor_owner_action_id',
         'predecessor_resolution_action_id',
         'rearm_source_action_id'
       ]
     )
     OR task_record.metadata ->> 'task_contract' IS DISTINCT FROM
          'discharge_pending_result_action_v1'
     OR task_record.metadata ->> 'handoff_id' IS DISTINCT FROM
          NEW.handoff_id::text
     OR task_record.metadata ->> 'generation_id' IS DISTINCT FROM
          NEW.generation_id::text
     OR task_record.metadata ->> 'predecessor_generation_id'
          IS DISTINCT FROM NEW.predecessor_generation_id::text
     OR task_record.metadata ->> 'predecessor_owner_action_id'
          IS DISTINCT FROM NEW.predecessor_owner_action_id::text
     OR task_record.metadata ->> 'predecessor_resolution_action_id'
          IS DISTINCT FROM NEW.predecessor_resolution_action_id::text
     OR task_record.metadata ->> 'rearm_source_action_id'
          IS DISTINCT FROM NEW.rearm_source_action_id::text
     OR task_record.status IS NULL
     OR task_record.status NOT IN (
          'open',
          'in_progress',
          'blocked',
          'overdue'
        )
  THEN
    RAISE EXCEPTION
      'pending-result owner action task must be the exact live named-owner generation task'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT timeline.event_type,
         timeline.event_status,
         timeline.patient_uid,
         timeline.source_table,
         timeline.source_id,
         timeline.resource_type,
         timeline.resource_id,
         timeline.actor_uid,
         timeline.actor_role,
         timeline.visible_to_patient,
         timeline.payload,
         timeline.idempotency_key
    INTO timeline_record
    FROM clinical_timeline_events AS timeline
   WHERE timeline.tenant_id = NEW.tenant_id
     AND timeline.id = NEW.canonical_timeline_event_id
   FOR SHARE OF timeline;

  IF NOT FOUND
     OR timeline_record.event_type IS DISTINCT FROM
          'discharge.pending_result_available'
     OR (
           NEW.predecessor_owner_action_id IS NULL
           AND timeline_record.event_status IS DISTINCT FROM
                'result_available'
        )
     OR (
           NEW.predecessor_owner_action_id IS NOT NULL
           AND timeline_record.event_status IS DISTINCT FROM
                'result_rearmed'
        )
     OR timeline_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR timeline_record.source_table IS DISTINCT FROM
          'discharge_pending_result_handoffs'
     OR timeline_record.source_id IS DISTINCT FROM NEW.handoff_id::text
     OR timeline_record.resource_type IS DISTINCT FROM
          'diagnostic_result_generation'
     OR timeline_record.resource_id IS DISTINCT FROM NEW.generation_id::text
     OR jsonb_typeof(timeline_record.payload) IS DISTINCT FROM 'object'
     OR NOT (
          timeline_record.payload ?& ARRAY[
            'admission_id',
            'handoff_id',
             'generation_id',
             'predecessor_generation_id',
             'predecessor_owner_action_id',
             'predecessor_resolution_action_id',
             'rearm_source_action_id',
             'action_task_id',
             'tracking_task_id'
          ]
        )
     OR timeline_record.payload ->> 'admission_id' IS DISTINCT FROM
          NEW.admission_id::text
     OR timeline_record.payload ->> 'handoff_id' IS DISTINCT FROM
          NEW.handoff_id::text
     OR timeline_record.payload ->> 'generation_id' IS DISTINCT FROM
          NEW.generation_id::text
     OR timeline_record.payload ->> 'predecessor_generation_id'
           IS DISTINCT FROM NEW.predecessor_generation_id::text
     OR timeline_record.payload ->> 'predecessor_owner_action_id'
          IS DISTINCT FROM NEW.predecessor_owner_action_id::text
     OR timeline_record.payload ->> 'predecessor_resolution_action_id'
          IS DISTINCT FROM NEW.predecessor_resolution_action_id::text
     OR timeline_record.payload ->> 'rearm_source_action_id'
          IS DISTINCT FROM NEW.rearm_source_action_id::text
     OR timeline_record.payload ->> 'action_task_id' IS DISTINCT FROM
          NEW.task_id::text
     OR timeline_record.payload ->> 'tracking_task_id' IS DISTINCT FROM
          handoff_record.task_id::text
  THEN
    RAISE EXCEPTION
      'pending-result owner action timeline event does not match its exact handoff and generation'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT audit.action,
         audit.action_status,
         audit.patient_uid,
         audit.actor_uid,
         audit.actor_role,
         audit.resource_type,
         audit.resource_table,
         audit.resource_id,
         audit.after_state,
         audit.idempotency_key
    INTO audit_record
    FROM clinical_audit_events AS audit
   WHERE audit.tenant_id = NEW.tenant_id
     AND audit.id = NEW.canonical_audit_event_id
   FOR SHARE OF audit;

  IF NOT FOUND
     OR audit_record.action IS DISTINCT FROM
          'discharge.pending_result_available'
     OR audit_record.action_status IS DISTINCT FROM 'success'
     OR audit_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR audit_record.resource_type IS DISTINCT FROM
          'diagnostic_result_generation'
     OR audit_record.resource_table IS DISTINCT FROM
          'discharge_pending_result_handoffs'
     OR audit_record.resource_id IS DISTINCT FROM NEW.generation_id::text
  THEN
    RAISE EXCEPTION
      'pending-result owner action audit event does not match its exact handoff and generation'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT event.event_type,
         event.aggregate_type,
         event.aggregate_id,
         event.patient_uid,
         event.payload
    INTO outbox_record
    FROM event_outbox AS event
   WHERE event.tenant_id = NEW.tenant_id
     AND event.id = NEW.source_outbox_event_id
   FOR SHARE OF event;

  IF NOT FOUND
     OR outbox_record.event_type IS DISTINCT FROM
          'discharge.pending_result_available'
     OR outbox_record.aggregate_type IS DISTINCT FROM
          'discharge_pending_result_handoff'
     OR outbox_record.aggregate_id IS DISTINCT FROM NEW.handoff_id::text
     OR outbox_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR jsonb_typeof(outbox_record.payload) IS DISTINCT FROM 'object'
     OR NOT (
          outbox_record.payload ?& ARRAY[
            'admission_id',
            'handoff_id',
             'generation_id',
             'predecessor_generation_id',
             'predecessor_owner_action_id',
             'predecessor_resolution_action_id',
             'rearm_source_action_id',
             'action_task_id',
             'tracking_task_id',
             'canonical_timeline_event_id',
            'canonical_audit_event_id'
          ]
        )
     OR outbox_record.payload ->> 'admission_id' IS DISTINCT FROM
          NEW.admission_id::text
     OR outbox_record.payload ->> 'handoff_id' IS DISTINCT FROM
          NEW.handoff_id::text
     OR outbox_record.payload ->> 'generation_id' IS DISTINCT FROM
          NEW.generation_id::text
     OR outbox_record.payload ->> 'predecessor_generation_id'
           IS DISTINCT FROM NEW.predecessor_generation_id::text
     OR outbox_record.payload ->> 'predecessor_owner_action_id'
          IS DISTINCT FROM NEW.predecessor_owner_action_id::text
     OR outbox_record.payload ->> 'predecessor_resolution_action_id'
          IS DISTINCT FROM NEW.predecessor_resolution_action_id::text
     OR outbox_record.payload ->> 'rearm_source_action_id'
          IS DISTINCT FROM NEW.rearm_source_action_id::text
     OR outbox_record.payload ->> 'action_task_id' IS DISTINCT FROM
          NEW.task_id::text
     OR outbox_record.payload ->> 'tracking_task_id' IS DISTINCT FROM
          handoff_record.task_id::text
     OR outbox_record.payload ->> 'canonical_timeline_event_id'
          IS DISTINCT FROM
          NEW.canonical_timeline_event_id::text
     OR outbox_record.payload ->> 'canonical_audit_event_id'
          IS DISTINCT FROM
          NEW.canonical_audit_event_id::text
  THEN
    RAISE EXCEPTION
      'pending-result owner action outbox event does not correlate its exact canonical evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_discharge_pending_result_owner_actions_validate
AFTER INSERT ON discharge_pending_result_owner_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_validate_pending_result_owner_action();

CREATE OR REPLACE FUNCTION s4_validate_pending_result_generation_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.predecessor_generation_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_handoffs AS handoff
      JOIN discharge_pending_result_owner_actions AS predecessor
        ON predecessor.tenant_id = handoff.tenant_id
       AND predecessor.handoff_id = handoff.id
       AND predecessor.admission_id = handoff.admission_id
       AND predecessor.patient_uid = handoff.patient_uid
       AND predecessor.generation_id = NEW.predecessor_generation_id
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.patient_uid = NEW.patient_uid
       AND handoff.admission_id = NEW.admission_id
       AND handoff.handoff_state IN ('result_available', 'resolved')
       AND NOT EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS intermediate
          WHERE intermediate.tenant_id = predecessor.tenant_id
            AND intermediate.handoff_id = predecessor.handoff_id
            AND intermediate.predecessor_owner_action_id = predecessor.id
            AND intermediate.generation_id <> NEW.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS successor
          WHERE successor.tenant_id = predecessor.tenant_id
            AND successor.handoff_id = predecessor.handoff_id
            AND successor.admission_id = predecessor.admission_id
            AND successor.patient_uid = predecessor.patient_uid
            AND successor.predecessor_owner_action_id = predecessor.id
            AND successor.predecessor_generation_id =
                  predecessor.generation_id
            AND successor.generation_id = NEW.id
       )
  )
  THEN
    RAISE EXCEPTION
      'signed successor generation requires an exact successor pending-result owner action in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_diagnostic_generations_pending_result_dependency
AFTER INSERT ON diagnostic_result_generations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_validate_pending_result_generation_dependency();

CREATE OR REPLACE FUNCTION s4_validate_pending_result_reopen_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action_kind <> 'doctor_reopened' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_handoffs AS handoff
      JOIN discharge_pending_result_owner_actions AS predecessor
        ON predecessor.tenant_id = handoff.tenant_id
       AND predecessor.handoff_id = handoff.id
       AND predecessor.admission_id = handoff.admission_id
       AND predecessor.patient_uid = handoff.patient_uid
       AND predecessor.generation_id = NEW.generation_id
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.patient_uid = NEW.patient_uid
       AND handoff.resolution_action_id = NEW.predecessor_action_id
       AND handoff.handoff_state = 'resolved'
       AND NOT EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS successor
          WHERE successor.tenant_id = predecessor.tenant_id
            AND successor.handoff_id = predecessor.handoff_id
            AND successor.predecessor_owner_action_id = predecessor.id
            AND successor.generation_id = predecessor.generation_id
            AND successor.predecessor_generation_id IS NULL
            AND successor.predecessor_resolution_action_id =
                  NEW.predecessor_action_id
            AND successor.rearm_source_action_id = NEW.id
       )
  )
  THEN
    RAISE EXCEPTION
      'doctor reopen requires every exact resolved pending-result handoff to re-arm in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_diagnostic_actions_pending_result_reopen_dependency
AFTER INSERT ON diagnostic_result_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_validate_pending_result_reopen_dependency();

CREATE OR REPLACE FUNCTION s4_validate_discharge_resolution_action()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  settlement_record RECORD;
  predecessor_record RECORD;
  signature_record RECORD;
  timeline_record RECORD;
  audit_record RECORD;
BEGIN
  IF NEW.action_kind <> 'discharge_owner_cross_sign' THEN
    RETURN NEW;
  END IF;

  SELECT handoff.id AS handoff_id,
         handoff.patient_uid,
         handoff.admission_id,
         handoff.named_physician_uid,
         handoff.resolved_by_uid,
         handoff.handoff_state,
         owner_action.id AS owner_action_id,
         owner_action.generation_id,
         owner_action.task_id AS action_task_id,
         action_task.status AS action_task_status,
         action_task.completed_at AS action_task_completed_at,
         tracking_task.id AS tracking_task_id,
         tracking_task.status AS tracking_task_status,
         tracking_task.completed_at AS tracking_task_completed_at,
         pathway.pathway_key,
         pathway.source_episode_type,
         pathway.source_episode_id
    INTO settlement_record
    FROM discharge_pending_result_handoffs AS handoff
    JOIN discharge_pending_result_owner_actions AS owner_action
      ON owner_action.tenant_id = handoff.tenant_id
     AND owner_action.handoff_id = handoff.id
     AND owner_action.admission_id = handoff.admission_id
     AND owner_action.patient_uid = handoff.patient_uid
     AND owner_action.generation_id = NEW.generation_id
     AND owner_action.task_id = NEW.task_id
    JOIN tasks AS action_task
      ON action_task.tenant_id = owner_action.tenant_id
     AND action_task.id = owner_action.task_id
    JOIN tasks AS tracking_task
      ON tracking_task.tenant_id = handoff.tenant_id
     AND tracking_task.id = handoff.task_id
    JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = NEW.tenant_id
     AND pathway.id = NEW.pathway_instance_id
     AND pathway.patient_uid = NEW.patient_uid
    WHERE handoff.tenant_id = NEW.tenant_id
      AND handoff.id = NEW.downstream_resource_id::uuid
      AND handoff.patient_uid = NEW.patient_uid
      AND handoff.resolution_action_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
          FROM discharge_pending_result_owner_actions AS successor
         WHERE successor.tenant_id = owner_action.tenant_id
           AND successor.handoff_id = owner_action.handoff_id
           AND successor.predecessor_owner_action_id = owner_action.id
      )
    FOR SHARE OF handoff, owner_action, action_task, tracking_task, pathway;

  IF NOT FOUND
     OR settlement_record.handoff_state IS DISTINCT FROM 'resolved'
     OR settlement_record.named_physician_uid IS DISTINCT FROM NEW.actor_uid
     OR settlement_record.resolved_by_uid IS DISTINCT FROM NEW.actor_uid
     OR settlement_record.generation_id IS DISTINCT FROM NEW.generation_id
     OR settlement_record.action_task_status IS DISTINCT FROM 'completed'
     OR settlement_record.action_task_completed_at IS NULL
     OR settlement_record.tracking_task_status IS DISTINCT FROM 'completed'
     OR settlement_record.tracking_task_completed_at IS NULL
     OR settlement_record.pathway_key IS DISTINCT FROM
          'inpatient_admission_to_recovery'
     OR settlement_record.source_episode_type IS DISTINCT FROM 'admission'
     OR settlement_record.source_episode_id IS DISTINCT FROM
          settlement_record.admission_id::text
  THEN
    RAISE EXCEPTION
      'discharge owner cross-sign requires the exact resolved handoff, current child, completed parent, and named inpatient owner'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT action.action_kind,
         action.generation_id,
         action.patient_uid,
         action.actor_uid,
         action.signature_id
    INTO predecessor_record
    FROM diagnostic_result_actions AS action
   WHERE action.tenant_id = NEW.tenant_id
     AND action.id = NEW.predecessor_action_id
     AND action.patient_uid = NEW.patient_uid
   FOR SHARE OF action;

  IF NOT FOUND
     OR predecessor_record.action_kind IS DISTINCT FROM
          'doctor_disposition'
     OR predecessor_record.generation_id IS DISTINCT FROM NEW.generation_id
     OR predecessor_record.actor_uid IS NULL
     OR predecessor_record.actor_uid IS NOT DISTINCT FROM NEW.actor_uid
     OR predecessor_record.signature_id IS NULL
  THEN
    RAISE EXCEPTION
      'discharge owner cross-sign must link the exact signed disposition by a different doctor'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT signature.document_type,
         signature.document_table,
         signature.document_id,
         signature.patient_uid,
         signature.signer_uid,
         signature.signer_role,
         signature.audit_event_id
    INTO signature_record
    FROM clinical_document_signatures AS signature
   WHERE signature.tenant_id = NEW.tenant_id
     AND signature.id = NEW.signature_id
   FOR SHARE OF signature;

  IF NOT FOUND
     OR signature_record.document_type IS DISTINCT FROM
          'diagnostic_result_action'
     OR signature_record.document_table IS DISTINCT FROM
          'diagnostic_result_actions'
     OR signature_record.document_id IS DISTINCT FROM NEW.id::text
     OR signature_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR signature_record.signer_uid IS DISTINCT FROM NEW.actor_uid
     OR signature_record.signer_role IS DISTINCT FROM NEW.actor_role
     OR signature_record.audit_event_id IS DISTINCT FROM
          NEW.canonical_audit_event_id
  THEN
    RAISE EXCEPTION
      'discharge owner cross-sign requires one matching sealed signature'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT timeline.event_type,
         timeline.event_status,
         timeline.patient_uid,
         timeline.source_table,
         timeline.source_id,
         timeline.resource_type,
         timeline.resource_id,
         timeline.actor_uid,
         timeline.actor_role,
         timeline.visible_to_patient,
         timeline.idempotency_key,
         timeline.payload
    INTO timeline_record
    FROM clinical_timeline_events AS timeline
   WHERE timeline.tenant_id = NEW.tenant_id
     AND timeline.id = NEW.canonical_timeline_event_id
   FOR SHARE OF timeline;

  SELECT audit.action,
         audit.action_status,
         audit.patient_uid,
         audit.actor_uid,
         audit.actor_role,
         audit.resource_type,
         audit.resource_table,
         audit.resource_id,
         audit.idempotency_key,
         audit.after_state
    INTO audit_record
    FROM clinical_audit_events AS audit
   WHERE audit.tenant_id = NEW.tenant_id
     AND audit.id = NEW.canonical_audit_event_id
   FOR SHARE OF audit;

  IF timeline_record.event_type IS DISTINCT FROM
       'discharge.pending_result_resolved'
     OR timeline_record.event_status IS DISTINCT FROM 'owner_cross_signed'
     OR timeline_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR timeline_record.source_table IS DISTINCT FROM
          'diagnostic_result_actions'
     OR timeline_record.source_id IS DISTINCT FROM NEW.id::text
     OR timeline_record.resource_type IS DISTINCT FROM
          'discharge_pending_result_handoff'
     OR timeline_record.resource_id IS DISTINCT FROM
          settlement_record.handoff_id::text
     OR timeline_record.actor_uid IS DISTINCT FROM NEW.actor_uid
     OR timeline_record.actor_role IS DISTINCT FROM NEW.actor_role
     OR timeline_record.visible_to_patient IS DISTINCT FROM FALSE
     OR timeline_record.idempotency_key IS DISTINCT FROM FORMAT(
          'pending-result-cross-sign:%s:%s:timeline',
          NEW.tenant_id::text,
          NEW.id::text
        )
     OR jsonb_typeof(timeline_record.payload) IS DISTINCT FROM 'object'
     OR (
          SELECT COUNT(*)
            FROM jsonb_object_keys(timeline_record.payload)
        ) IS DISTINCT FROM 8
     OR timeline_record.payload ->> 'admission_id' IS DISTINCT FROM
          settlement_record.admission_id::text
     OR timeline_record.payload ->> 'handoff_id' IS DISTINCT FROM
          settlement_record.handoff_id::text
     OR timeline_record.payload ->> 'generation_id' IS DISTINCT FROM
          NEW.generation_id::text
     OR timeline_record.payload ->> 'diagnostic_action_id'
          IS DISTINCT FROM NEW.predecessor_action_id::text
     OR timeline_record.payload ->> 'owner_action_id' IS DISTINCT FROM
          settlement_record.owner_action_id::text
     OR timeline_record.payload ->> 'action_task_id' IS DISTINCT FROM
          settlement_record.action_task_id::text
     OR timeline_record.payload ->> 'tracking_task_id' IS DISTINCT FROM
          settlement_record.tracking_task_id::text
     OR timeline_record.payload ->> 'signature_id' IS DISTINCT FROM
          NEW.signature_id::text
     OR audit_record.action IS DISTINCT FROM
          'discharge.pending_result_resolved'
     OR audit_record.action_status IS DISTINCT FROM 'success'
     OR audit_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR audit_record.actor_uid IS DISTINCT FROM NEW.actor_uid
     OR audit_record.actor_role IS DISTINCT FROM NEW.actor_role
     OR audit_record.resource_type IS DISTINCT FROM
          'discharge_pending_result_handoff'
     OR audit_record.resource_table IS DISTINCT FROM
          'discharge_pending_result_handoffs'
     OR audit_record.resource_id IS DISTINCT FROM
          settlement_record.handoff_id::text
     OR audit_record.idempotency_key IS DISTINCT FROM FORMAT(
          'pending-result-cross-sign:%s:%s:audit',
          NEW.tenant_id::text,
          NEW.id::text
        )
     OR jsonb_typeof(audit_record.after_state) IS DISTINCT FROM 'object'
     OR (
          SELECT COUNT(*)
            FROM jsonb_object_keys(audit_record.after_state)
        ) IS DISTINCT FROM 4
     OR audit_record.after_state ->> 'handoff_state' IS DISTINCT FROM
          'resolved'
     OR audit_record.after_state ->> 'resolution_action_id'
          IS DISTINCT FROM NEW.id::text
     OR audit_record.after_state ->> 'generation_snapshot_sha256'
          IS DISTINCT FROM NEW.generation_snapshot_sha256
     OR audit_record.after_state ->> 'request_sha256'
          IS DISTINCT FROM NEW.request_sha256
     OR NOT EXISTS (
       SELECT 1
         FROM event_outbox AS event
        WHERE event.tenant_id = NEW.tenant_id
          AND event.event_type = 'discharge.pending_result_resolved'
          AND event.aggregate_type =
                'discharge_pending_result_handoff'
          AND event.aggregate_id = settlement_record.handoff_id::text
           AND event.patient_uid = NEW.patient_uid
           AND jsonb_typeof(event.payload) = 'object'
           AND (
                 SELECT COUNT(*)
                   FROM jsonb_object_keys(event.payload)
               ) = 11
           AND event.payload ->> 'admission_id' =
                 settlement_record.admission_id::text
           AND event.payload ->> 'handoff_id' =
                 settlement_record.handoff_id::text
           AND event.payload ->> 'resolution_action_id' = NEW.id::text
           AND event.payload ->> 'generation_id' =
                 NEW.generation_id::text
           AND event.payload ->> 'diagnostic_action_id' =
                 NEW.predecessor_action_id::text
          AND event.payload ->> 'owner_action_id' =
                settlement_record.owner_action_id::text
          AND event.payload ->> 'action_task_id' =
                settlement_record.action_task_id::text
          AND event.payload ->> 'tracking_task_id' =
                settlement_record.tracking_task_id::text
          AND event.payload ->> 'canonical_timeline_event_id' =
                NEW.canonical_timeline_event_id::text
           AND event.payload ->> 'canonical_audit_event_id' =
                 NEW.canonical_audit_event_id::text
           AND event.payload ->> 'admission_lineage_version' = '1'
     )
  THEN
    RAISE EXCEPTION
      'discharge owner cross-sign canonical evidence does not correlate its exact handoff, tasks, generation, and immutable action'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_diagnostic_actions_discharge_resolution_validate
AFTER INSERT ON diagnostic_result_actions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_validate_discharge_resolution_action();

CREATE OR REPLACE FUNCTION s4_assert_reserved_task_domain_binding(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  task_record RECORD;
  exact_binding_count INTEGER;
BEGIN
  SELECT task.task_kind,
         task.patient_uid,
         task.related_resource_type,
         task.related_resource_id,
         task.status,
         task.completed_at
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF task_record.task_kind = 'op_to_inpatient_transfer_review' THEN
    SELECT COUNT(*)::integer
      INTO exact_binding_count
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = target_tenant_id
       AND handoff.task_id = target_task_id
       AND handoff.handoff_type = 'op_to_inpatient_transfer'
       AND task_record.related_resource_type = 'care_handoff_instance'
       AND task_record.related_resource_id = handoff.id::text;
  ELSIF task_record.task_kind = 'pathway_owner_transfer_review' THEN
    SELECT COUNT(*)::integer
      INTO exact_binding_count
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = target_tenant_id
       AND handoff.task_id = target_task_id
       AND handoff.handoff_type = 'covering_clinician_reassignment'
       AND task_record.related_resource_type = 'care_handoff_instance'
       AND task_record.related_resource_id = handoff.id::text;
  ELSIF task_record.related_resource_type =
        'discharge_pending_result_handoff'
  THEN
    SELECT (
      (
        SELECT COUNT(*)
          FROM discharge_pending_result_handoffs AS handoff
         WHERE handoff.tenant_id = target_tenant_id
           AND handoff.task_id = target_task_id
           AND handoff.patient_uid = task_record.patient_uid
           AND handoff.id::text = task_record.related_resource_id
      )
      +
      (
        SELECT COUNT(*)
          FROM tasks AS successor
          JOIN discharge_pending_result_handoffs AS handoff
            ON handoff.tenant_id = successor.tenant_id
           AND handoff.task_id = successor.id
           AND handoff.patient_uid = successor.patient_uid
           AND handoff.id::text = successor.related_resource_id
         WHERE successor.tenant_id = target_tenant_id
           AND successor.related_resource_type =
                 'discharge_pending_result_handoff'
           AND successor.related_resource_id =
                 task_record.related_resource_id
           AND successor.patient_uid = task_record.patient_uid
           AND successor.id <> target_task_id
           AND successor.metadata ->> 'predecessor_tracking_task_id' =
                 target_task_id::text
           AND successor.metadata ->> 'rearm_reason' IN (
                 'doctor_reopened',
                 'corrected_generation'
               )
           AND task_record.status = 'completed'
           AND task_record.completed_at IS NOT NULL
      )
    )::integer
      INTO exact_binding_count;
  ELSIF task_record.related_resource_type =
        'discharge_pending_result_action'
  THEN
    SELECT COUNT(*)::integer
      INTO exact_binding_count
      FROM discharge_pending_result_owner_actions AS action
     WHERE action.tenant_id = target_tenant_id
       AND action.task_id = target_task_id
       AND action.patient_uid = task_record.patient_uid;
  ELSE
    RETURN;
  END IF;

  IF exact_binding_count <> 1 THEN
    RAISE EXCEPTION
      'reserved S4 task %/% must bind to exactly one matching current domain row or historical tracking successor (found=%)',
      target_tenant_id,
      target_task_id,
      exact_binding_count
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION s4_reserved_task_domain_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM s4_assert_reserved_task_domain_binding(NEW.tenant_id, NEW.id);

  IF TG_OP = 'UPDATE'
     AND (
       OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.id IS DISTINCT FROM NEW.id
       OR OLD.task_kind IS DISTINCT FROM NEW.task_kind
       OR OLD.related_resource_type IS DISTINCT FROM
            NEW.related_resource_type
       OR OLD.related_resource_id IS DISTINCT FROM NEW.related_resource_id
     )
  THEN
    PERFORM s4_assert_reserved_task_domain_binding(OLD.tenant_id, OLD.id);
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_s4_reserved_domain_binding
AFTER INSERT OR UPDATE ON tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_reserved_task_domain_constraint();

DO $s4_reserved_task_preflight$
DECLARE
  task_record RECORD;
  duplicate_count INTEGER;
BEGIN
  FOR task_record IN
    SELECT task.tenant_id, task.id
      FROM tasks AS task
     WHERE task.task_kind IN (
       'op_to_inpatient_transfer_review',
       'pathway_owner_transfer_review'
     )
        OR task.related_resource_type IN (
          'discharge_pending_result_handoff',
          'discharge_pending_result_action'
        )
  LOOP
    PERFORM s4_assert_reserved_task_domain_binding(
      task_record.tenant_id,
      task_record.id
    );
  END LOOP;

  SELECT COUNT(*)::integer
    INTO duplicate_count
    FROM (
      SELECT handoff.tenant_id, handoff.task_id::text
        FROM care_handoff_instances AS handoff
       WHERE handoff.handoff_type IN (
         'op_to_inpatient_transfer',
         'covering_clinician_reassignment'
       )
         AND handoff.task_id IS NOT NULL
       GROUP BY handoff.tenant_id, handoff.task_id
      HAVING COUNT(*) > 1
      UNION ALL
      SELECT handoff.tenant_id, handoff.task_id::text
        FROM discharge_pending_result_handoffs AS handoff
       GROUP BY handoff.tenant_id, handoff.task_id
      HAVING COUNT(*) > 1
      UNION ALL
      SELECT successor.tenant_id,
             successor.metadata ->> 'predecessor_tracking_task_id'
        FROM tasks AS successor
       WHERE successor.related_resource_type =
             'discharge_pending_result_handoff'
         AND successor.metadata ->>
               'predecessor_tracking_task_id' IS NOT NULL
       GROUP BY successor.tenant_id,
                successor.metadata ->>
                  'predecessor_tracking_task_id'
      HAVING COUNT(*) > 1
    ) AS duplicate;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'migration 595 blocked: duplicate reserved S4 task bindings or tracking successors exist (groups=%)',
      duplicate_count
      USING ERRCODE = 'check_violation';
  END IF;
END
$s4_reserved_task_preflight$;

CREATE UNIQUE INDEX ux_care_handoff_s4_reserved_task
  ON care_handoff_instances (tenant_id, task_id)
  WHERE handoff_type IN (
    'op_to_inpatient_transfer',
    'covering_clinician_reassignment'
  )
    AND task_id IS NOT NULL;

CREATE UNIQUE INDEX ux_discharge_pending_result_handoffs_task
  ON discharge_pending_result_handoffs (tenant_id, task_id);

CREATE UNIQUE INDEX ux_tasks_pending_result_tracking_successor
  ON tasks (
    tenant_id,
    ((metadata ->> 'predecessor_tracking_task_id'))
  )
  WHERE related_resource_type = 'discharge_pending_result_handoff'
    AND metadata ->> 'predecessor_tracking_task_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION s4_pending_result_tracking_task_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.related_resource_type =
       'discharge_pending_result_handoff'
     AND EXISTS (
       SELECT 1
         FROM discharge_pending_result_handoffs AS handoff
        WHERE handoff.tenant_id = OLD.tenant_id
          AND handoff.id::text = OLD.related_resource_id
          AND handoff.patient_uid = OLD.patient_uid
     )
  THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'pending-result tracking task correlation evidence is immutable'
        USING ERRCODE = 'raise_exception';
    END IF;

    IF ROW(
         NEW.tenant_id,
         NEW.id,
         NEW.task_kind,
         NEW.parent_task_id,
         NEW.patient_uid,
         NEW.related_resource_type,
         NEW.related_resource_id,
         NEW.metadata
       ) IS DISTINCT FROM ROW(
         OLD.tenant_id,
         OLD.id,
         OLD.task_kind,
         OLD.parent_task_id,
         OLD.patient_uid,
         OLD.related_resource_type,
         OLD.related_resource_id,
         OLD.metadata
       )
    THEN
      RAISE EXCEPTION
        'pending-result tracking task correlation evidence is immutable'
      USING ERRCODE = 'raise_exception';
    END IF;

    IF EXISTS (
         SELECT 1
           FROM tasks AS successor
          WHERE successor.tenant_id = OLD.tenant_id
            AND successor.related_resource_type =
                  'discharge_pending_result_handoff'
            AND successor.related_resource_id = OLD.related_resource_id
            AND successor.metadata ->> 'predecessor_tracking_task_id' =
                  OLD.id::text
       )
       AND ROW(
         NEW.assigned_to_uid,
         NEW.assigned_to_role,
         NEW.status,
         NEW.completed_at,
         NEW.cancelled_at,
         NEW.cancellation_reason
       ) IS DISTINCT FROM ROW(
         OLD.assigned_to_uid,
         OLD.assigned_to_role,
         OLD.status,
         OLD.completed_at,
         OLD.cancelled_at,
         OLD.cancellation_reason
       )
    THEN
      RAISE EXCEPTION
        'historical pending-result tracking task evidence is immutable after re-arm'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_s4_pending_result_tracking_task_dependency
BEFORE UPDATE OR DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION s4_pending_result_tracking_task_dependency();

CREATE OR REPLACE FUNCTION s4_validate_pending_result_tracking_task_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.assigned_to_uid IS NOT DISTINCT FROM NEW.assigned_to_uid
     AND OLD.assigned_to_role IS NOT DISTINCT FROM NEW.assigned_to_role
     AND OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at
     AND OLD.cancelled_at IS NOT DISTINCT FROM NEW.cancelled_at
     AND OLD.cancellation_reason IS NOT DISTINCT FROM
           NEW.cancellation_reason
     AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at
     AND OLD.cancelled_at IS NOT DISTINCT FROM NEW.cancelled_at
     AND OLD.cancellation_reason IS NOT DISTINCT FROM
           NEW.cancellation_reason
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_handoffs AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.task_id = NEW.id
       AND (
         NEW.task_kind IS DISTINCT FROM 'follow_up'
         OR NEW.parent_task_id IS NOT NULL
         OR NEW.patient_uid IS DISTINCT FROM handoff.patient_uid
         OR NEW.related_resource_type IS DISTINCT FROM
              'discharge_pending_result_handoff'
         OR NEW.related_resource_id IS DISTINCT FROM handoff.id::text
         OR NEW.assigned_to_uid IS DISTINCT FROM
              handoff.named_physician_uid
         OR NEW.assigned_to_role IS NOT NULL
         OR handoff.handoff_state IS NULL
         OR handoff.handoff_state NOT IN (
              'pending',
              'result_available',
              'resolved',
              'superseded'
            )
         OR (
           handoff.handoff_state IN ('pending', 'result_available')
           AND (
             NEW.status IS NULL
             OR NEW.status NOT IN (
               'open',
               'in_progress',
               'blocked',
               'overdue'
             )
           )
         )
         OR (
           handoff.handoff_state = 'resolved'
           AND (
             NEW.status IS DISTINCT FROM 'completed'
             OR NEW.completed_at IS NULL
             OR (
               OLD.status = 'completed'
               AND ROW(
                 NEW.assigned_to_uid,
                 NEW.assigned_to_role,
                 NEW.status,
                 NEW.completed_at,
                 NEW.cancelled_at,
                 NEW.cancellation_reason
               ) IS DISTINCT FROM ROW(
                 OLD.assigned_to_uid,
                 OLD.assigned_to_role,
                 OLD.status,
                 OLD.completed_at,
                 OLD.cancelled_at,
                 OLD.cancellation_reason
               )
             )
           )
         )
         OR (
           handoff.handoff_state = 'superseded'
           AND (
             NEW.status IS NULL
             OR NEW.status NOT IN ('completed', 'cancelled')
           )
         )
       )
  )
  THEN
    RAISE EXCEPTION
      'pending-result tracking task must match the final handoff binding, owner, and lifecycle state'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_pending_result_tracking_state_dependency
AFTER UPDATE ON tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_validate_pending_result_tracking_task_state();

CREATE OR REPLACE FUNCTION s4_pending_result_owner_task_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_owner_actions AS action
     WHERE action.tenant_id = OLD.tenant_id
       AND action.task_id = OLD.id
  )
  THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'pending-result owner-action task correlation evidence is immutable'
        USING ERRCODE = 'raise_exception';
    END IF;

    IF ROW(
         NEW.tenant_id,
         NEW.id,
         NEW.task_kind,
         NEW.parent_task_id,
         NEW.patient_uid,
         NEW.related_resource_type,
         NEW.related_resource_id,
         NEW.metadata
       ) IS DISTINCT FROM ROW(
         OLD.tenant_id,
         OLD.id,
         OLD.task_kind,
         OLD.parent_task_id,
         OLD.patient_uid,
         OLD.related_resource_type,
         OLD.related_resource_id,
         OLD.metadata
       )
    THEN
      RAISE EXCEPTION
        'pending-result owner-action task correlation evidence is immutable'
      USING ERRCODE = 'raise_exception';
    END IF;

    IF EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS predecessor
           JOIN discharge_pending_result_owner_actions AS successor
             ON successor.tenant_id = predecessor.tenant_id
            AND successor.handoff_id = predecessor.handoff_id
            AND successor.predecessor_owner_action_id = predecessor.id
          WHERE predecessor.tenant_id = OLD.tenant_id
            AND predecessor.task_id = OLD.id
       )
       AND ROW(
         NEW.assigned_to_uid,
         NEW.assigned_to_role,
         NEW.status,
         NEW.completed_at,
         NEW.cancelled_at,
         NEW.cancellation_reason
       ) IS DISTINCT FROM ROW(
         OLD.assigned_to_uid,
         OLD.assigned_to_role,
         OLD.status,
         OLD.completed_at,
         OLD.cancelled_at,
         OLD.cancellation_reason
       )
    THEN
      RAISE EXCEPTION
        'historical pending-result owner-action task evidence is immutable after re-arm'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_s4_pending_result_owner_task_dependency
BEFORE UPDATE OR DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION s4_pending_result_owner_task_dependency();

CREATE OR REPLACE FUNCTION s4_governed_primary_transfer_exists(
  target_tenant_id UUID,
  target_assignment_id UUID,
  target_admission_id INTEGER,
  target_patient_uid UUID,
  target_physician_uid UUID
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM inpatient_primary_physician_assignments AS current_assignment
      JOIN inpatient_primary_physician_assignments AS previous_assignment
        ON previous_assignment.tenant_id = current_assignment.tenant_id
       AND previous_assignment.id =
             current_assignment.supersedes_assignment_id
       AND previous_assignment.admission_id =
             current_assignment.admission_id
       AND previous_assignment.patient_uid =
             current_assignment.patient_uid
      JOIN care_handoff_instances AS accepted_handoff
        ON accepted_handoff.tenant_id = current_assignment.tenant_id
       AND accepted_handoff.id = current_assignment.accepted_handoff_id
       AND accepted_handoff.patient_uid = current_assignment.patient_uid
      JOIN care_pathway_instances AS pathway
        ON pathway.tenant_id = accepted_handoff.tenant_id
       AND pathway.id = accepted_handoff.sending_pathway_instance_id
       AND pathway.patient_uid = accepted_handoff.patient_uid
      JOIN admissions AS admission
        ON admission.tenant_id = current_assignment.tenant_id
       AND admission.id = current_assignment.admission_id
       AND admission.patient_uid = current_assignment.patient_uid
      JOIN tasks AS acceptance_task
        ON acceptance_task.tenant_id = accepted_handoff.tenant_id
       AND acceptance_task.id = accepted_handoff.task_id
      JOIN clinical_timeline_events AS timeline
        ON timeline.tenant_id = current_assignment.tenant_id
       AND timeline.id =
             current_assignment.canonical_timeline_event_id
      JOIN clinical_audit_events AS audit
        ON audit.tenant_id = current_assignment.tenant_id
       AND audit.id = current_assignment.canonical_audit_event_id
     WHERE current_assignment.tenant_id = target_tenant_id
       AND current_assignment.id = target_assignment_id
       AND current_assignment.admission_id = target_admission_id
       AND current_assignment.patient_uid = target_patient_uid
       AND current_assignment.physician_uid = target_physician_uid
       AND current_assignment.assignment_source IS NOT DISTINCT FROM
             'accepted_covering_handoff'
       AND current_assignment.assignment_version > 1
       AND previous_assignment.assignment_version IS NOT DISTINCT FROM
             current_assignment.assignment_version - 1
       AND accepted_handoff.handoff_type IS NOT DISTINCT FROM
             'covering_clinician_reassignment'
       AND accepted_handoff.status IS NOT DISTINCT FROM 'accepted'
       AND accepted_handoff.sender_uid IS NOT DISTINCT FROM
             previous_assignment.physician_uid
       AND accepted_handoff.recipient_kind IS NOT DISTINCT FROM 'user'
       AND accepted_handoff.intended_recipient_uid IS NOT DISTINCT FROM
             current_assignment.physician_uid
       AND accepted_handoff.accepted_by_uid IS NOT DISTINCT FROM
             current_assignment.physician_uid
       AND accepted_handoff.accepted_at IS NOT NULL
       AND accepted_handoff.source_resource_type IS NOT DISTINCT FROM
             'care_pathway_instance'
       AND accepted_handoff.source_resource_id IS NOT DISTINCT FROM
             accepted_handoff.sending_pathway_instance_id::text
       AND pathway.pathway_key IS NOT DISTINCT FROM
             'inpatient_admission_to_recovery'
       AND pathway.source_episode_type IS NOT DISTINCT FROM 'admission'
       AND pathway.source_episode_id IS NOT DISTINCT FROM
             current_assignment.admission_id::text
       AND admission.attending_doctor IS NOT DISTINCT FROM
             current_assignment.physician_uid
       AND acceptance_task.task_kind IS NOT DISTINCT FROM
             'pathway_owner_transfer_review'
       AND acceptance_task.patient_uid IS NOT DISTINCT FROM
             current_assignment.patient_uid
       AND acceptance_task.related_resource_type IS NOT DISTINCT FROM
             'care_handoff_instance'
       AND acceptance_task.related_resource_id IS NOT DISTINCT FROM
             accepted_handoff.id::text
       AND acceptance_task.assigned_to_uid IS NOT DISTINCT FROM
             current_assignment.physician_uid
       AND acceptance_task.assigned_to_role IS NULL
       AND acceptance_task.status IS NOT DISTINCT FROM 'completed'
       AND acceptance_task.completed_at IS NOT NULL
       AND timeline.patient_uid IS NOT DISTINCT FROM
             current_assignment.patient_uid
       AND timeline.event_type IS NOT DISTINCT FROM
             'admission.primary_physician.reassigned'
       AND timeline.event_status IS NOT DISTINCT FROM 'accepted'
       AND timeline.source_table IS NOT DISTINCT FROM
             'inpatient_primary_physician_assignments'
       AND timeline.source_id IS NOT DISTINCT FROM
             current_assignment.id::text
       AND timeline.resource_type IS NOT DISTINCT FROM
             'inpatient_primary_physician_assignments'
       AND timeline.resource_id IS NOT DISTINCT FROM
             current_assignment.id::text
       AND audit.patient_uid IS NOT DISTINCT FROM
             current_assignment.patient_uid
       AND audit.action IS NOT DISTINCT FROM
             'admission.primary_physician.reassigned'
       AND audit.action_status IS NOT DISTINCT FROM 'success'
       AND audit.resource_type IS NOT DISTINCT FROM
             'inpatient_primary_physician_assignments'
       AND audit.resource_table IS NOT DISTINCT FROM
             'inpatient_primary_physician_assignments'
       AND audit.resource_id IS NOT DISTINCT FROM
             current_assignment.id::text
       AND NOT EXISTS (
         SELECT 1
           FROM inpatient_primary_physician_assignments AS successor
          WHERE successor.tenant_id = current_assignment.tenant_id
            AND successor.supersedes_assignment_id = current_assignment.id
       )
  );
$$;

CREATE OR REPLACE FUNCTION s4_validate_pending_result_owner_task_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_record RECORD;
  action_record RECORD;
BEGIN
  IF OLD.assigned_to_uid IS NOT DISTINCT FROM NEW.assigned_to_uid
     AND OLD.assigned_to_role IS NOT DISTINCT FROM NEW.assigned_to_role
     AND OLD.status IS NOT DISTINCT FROM NEW.status
  THEN
    RETURN NEW;
  END IF;

  SELECT task.assigned_to_uid,
         task.assigned_to_role,
         task.status,
         task.completed_at,
         task.cancelled_at,
         task.cancellation_reason
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.id = NEW.id
   FOR SHARE;

  SELECT action.id AS owner_action_id,
         action.handoff_id,
         action.generation_id,
         handoff.admission_id,
         handoff.patient_uid,
         handoff.handoff_state,
         handoff.named_physician_uid,
         handoff.primary_physician_assignment_id,
         current_assignment.physician_uid AS assignment_physician_uid
    INTO action_record
    FROM discharge_pending_result_owner_actions AS action
    JOIN discharge_pending_result_handoffs AS handoff
      ON handoff.tenant_id = action.tenant_id
     AND handoff.id = action.handoff_id
     AND handoff.admission_id = action.admission_id
     AND handoff.patient_uid = action.patient_uid
    JOIN inpatient_primary_physician_assignments AS current_assignment
      ON current_assignment.tenant_id = handoff.tenant_id
     AND current_assignment.id =
           handoff.primary_physician_assignment_id
     AND current_assignment.admission_id = handoff.admission_id
     AND current_assignment.patient_uid = handoff.patient_uid
   WHERE action.tenant_id = NEW.tenant_id
     AND action.task_id = NEW.id
   FOR SHARE OF action, handoff, current_assignment;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF task_record.assigned_to_uid IS DISTINCT FROM
       action_record.named_physician_uid
     OR task_record.assigned_to_role IS NOT NULL
     OR action_record.assignment_physician_uid IS DISTINCT FROM
          action_record.named_physician_uid
  THEN
    RAISE EXCEPTION
      'pending-result owner-action task must match the final named physician'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.status IS NOT DISTINCT FROM 'cancelled'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND NOT EXISTS (
       SELECT 1
         FROM discharge_pending_result_owner_actions AS successor
         WHERE successor.tenant_id = NEW.tenant_id
           AND successor.handoff_id = action_record.handoff_id
           AND successor.predecessor_owner_action_id =
                 action_record.owner_action_id
     )
  THEN
    RAISE EXCEPTION
      'pending-result owner-action task cancellation requires its exact successor action'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.assigned_to_uid IS DISTINCT FROM task_record.assigned_to_uid
     OR OLD.assigned_to_role IS DISTINCT FROM task_record.assigned_to_role
  THEN
    IF action_record.handoff_state IS NULL
       OR action_record.handoff_state NOT IN ('pending', 'result_available')
       OR EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS successor
           WHERE successor.tenant_id = NEW.tenant_id
             AND successor.handoff_id = action_record.handoff_id
             AND successor.predecessor_owner_action_id =
                   action_record.owner_action_id
       )
       OR EXISTS (
         SELECT 1
           FROM diagnostic_result_generations AS successor_generation
          WHERE successor_generation.tenant_id = NEW.tenant_id
            AND successor_generation.predecessor_generation_id =
                  action_record.generation_id
            AND successor_generation.patient_uid =
                  action_record.patient_uid
            AND successor_generation.admission_id =
                  action_record.admission_id
       )
       OR NOT s4_governed_primary_transfer_exists(
         NEW.tenant_id,
         action_record.primary_physician_assignment_id,
         action_record.admission_id,
         action_record.patient_uid,
         task_record.assigned_to_uid
       )
       OR NOT EXISTS (
         SELECT 1
           FROM inpatient_primary_physician_assignments AS current_assignment
           JOIN inpatient_primary_physician_assignments AS previous_assignment
             ON previous_assignment.tenant_id =
                  current_assignment.tenant_id
            AND previous_assignment.id =
                  current_assignment.supersedes_assignment_id
            AND previous_assignment.admission_id =
                  current_assignment.admission_id
            AND previous_assignment.patient_uid =
                  current_assignment.patient_uid
          WHERE current_assignment.tenant_id = NEW.tenant_id
            AND current_assignment.id =
                  action_record.primary_physician_assignment_id
            AND previous_assignment.physician_uid IS NOT DISTINCT FROM
                  OLD.assigned_to_uid
       )
    THEN
      RAISE EXCEPTION
        'pending-result owner-action task reassignment requires the exact accepted primary-physician transfer'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF EXISTS (
       SELECT 1
         FROM discharge_pending_result_owner_actions AS successor
        WHERE successor.tenant_id = NEW.tenant_id
          AND successor.handoff_id = action_record.handoff_id
          AND successor.predecessor_owner_action_id =
                action_record.owner_action_id
     )
  THEN
    IF EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS successor
          WHERE successor.tenant_id = NEW.tenant_id
            AND successor.handoff_id = action_record.handoff_id
            AND successor.predecessor_owner_action_id =
                  action_record.owner_action_id
            AND successor.predecessor_resolution_action_id IS NOT NULL
       )
       AND (
         task_record.status IS DISTINCT FROM 'completed'
         OR task_record.completed_at IS NULL
       )
    THEN
      RAISE EXCEPTION
        'resolved predecessor owner-action task must remain completed'
        USING ERRCODE = 'check_violation';
    ELSIF EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS successor
          WHERE successor.tenant_id = NEW.tenant_id
            AND successor.handoff_id = action_record.handoff_id
            AND successor.predecessor_owner_action_id =
                  action_record.owner_action_id
            AND successor.predecessor_resolution_action_id IS NULL
       )
       AND task_record.status IS DISTINCT FROM 'cancelled'
    THEN
      RAISE EXCEPTION
        'live corrected predecessor owner-action task must remain cancelled'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF action_record.handoff_state = 'result_available' THEN
    IF task_record.status IS NULL
       OR task_record.status NOT IN (
         'open',
         'in_progress',
         'blocked',
         'overdue'
       )
    THEN
      RAISE EXCEPTION
        'current result-available owner-action task must remain live'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF action_record.handoff_state = 'resolved' THEN
    IF task_record.status IS DISTINCT FROM 'completed'
       OR task_record.completed_at IS NULL
       OR (
         OLD.status = 'completed'
         AND ROW(
           task_record.assigned_to_uid,
           task_record.assigned_to_role,
           task_record.status,
           task_record.completed_at,
           task_record.cancelled_at,
           task_record.cancellation_reason
         ) IS DISTINCT FROM ROW(
           OLD.assigned_to_uid,
           OLD.assigned_to_role,
           OLD.status,
           OLD.completed_at,
           OLD.cancelled_at,
           OLD.cancellation_reason
         )
       )
    THEN
      RAISE EXCEPTION
        'current resolved owner-action task must retain its completed settlement evidence'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF action_record.handoff_state = 'superseded' THEN
    IF task_record.status IS NULL
       OR task_record.status NOT IN ('completed', 'cancelled')
    THEN
      RAISE EXCEPTION
        'superseded handoff owner-action task must be closed'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_pending_result_owner_state_dependency
AFTER UPDATE ON tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_validate_pending_result_owner_task_state();

CREATE OR REPLACE FUNCTION s4_pending_result_owner_timeline_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_owner_actions AS action
     WHERE action.tenant_id = OLD.tenant_id
       AND action.canonical_timeline_event_id = OLD.id
  )
  OR EXISTS (
    SELECT 1
     FROM diagnostic_result_actions AS action
     WHERE action.tenant_id = OLD.tenant_id
       AND action.canonical_timeline_event_id = OLD.id
       AND (
         action.action_kind = 'discharge_owner_cross_sign'
         OR EXISTS (
           SELECT 1
             FROM discharge_pending_result_handoffs AS handoff
            WHERE handoff.tenant_id = action.tenant_id
              AND handoff.resolution_action_id = action.id
         )
         OR EXISTS (
           SELECT 1
             FROM discharge_pending_result_owner_actions AS successor
            WHERE successor.tenant_id = action.tenant_id
              AND successor.predecessor_resolution_action_id = action.id
         )
       )
  )
  THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'pending-result owner-action timeline correlation evidence is immutable'
        USING ERRCODE = 'raise_exception';
    END IF;

    IF ROW(
            NEW.tenant_id,
            NEW.id,
            NEW.patient_uid,
            NEW.event_type,
            NEW.event_status,
            NEW.source_table,
            NEW.source_id,
            NEW.resource_type,
            NEW.resource_id,
            NEW.payload
          ) IS DISTINCT FROM ROW(
            OLD.tenant_id,
            OLD.id,
            OLD.patient_uid,
            OLD.event_type,
            OLD.event_status,
            OLD.source_table,
            OLD.source_id,
            OLD.resource_type,
            OLD.resource_id,
            OLD.payload
          )
    THEN
      RAISE EXCEPTION
        'pending-result owner-action timeline correlation evidence is immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_s4_pending_result_owner_timeline_dependency
BEFORE UPDATE OR DELETE ON clinical_timeline_events
FOR EACH ROW EXECUTE FUNCTION s4_pending_result_owner_timeline_dependency();

CREATE OR REPLACE FUNCTION s4_pending_result_owner_outbox_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_owner_actions AS action
     WHERE action.tenant_id = OLD.tenant_id
       AND action.source_outbox_event_id = OLD.id
  )
  OR EXISTS (
    SELECT 1
      FROM diagnostic_result_actions AS action
     WHERE action.tenant_id = OLD.tenant_id
       AND action.action_kind = 'discharge_owner_cross_sign'
       AND OLD.event_type = 'discharge.pending_result_resolved'
       AND OLD.aggregate_type = 'discharge_pending_result_handoff'
       AND OLD.patient_uid = action.patient_uid
       AND OLD.payload ->> 'resolution_action_id' = action.id::text
  )
  THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'pending-result owner-action outbox correlation evidence is immutable'
        USING ERRCODE = 'raise_exception';
    END IF;

    IF ROW(
            NEW.tenant_id,
            NEW.id,
            NEW.event_type,
            NEW.aggregate_type,
            NEW.aggregate_id,
            NEW.patient_uid,
            NEW.payload
          ) IS DISTINCT FROM ROW(
            OLD.tenant_id,
            OLD.id,
            OLD.event_type,
            OLD.aggregate_type,
            OLD.aggregate_id,
            OLD.patient_uid,
            OLD.payload
          )
    THEN
      RAISE EXCEPTION
        'pending-result owner-action outbox correlation evidence is immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_s4_pending_result_owner_outbox_dependency
BEFORE UPDATE OR DELETE ON event_outbox
FOR EACH ROW EXECUTE FUNCTION s4_pending_result_owner_outbox_dependency();

CREATE OR REPLACE FUNCTION s4_pending_result_owner_audit_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_owner_actions AS action
     WHERE action.tenant_id = OLD.tenant_id
       AND action.canonical_audit_event_id = OLD.id
  )
  OR EXISTS (
    SELECT 1
     FROM diagnostic_result_actions AS action
     WHERE action.tenant_id = OLD.tenant_id
       AND action.canonical_audit_event_id = OLD.id
       AND (
         action.action_kind = 'discharge_owner_cross_sign'
         OR EXISTS (
           SELECT 1
             FROM discharge_pending_result_handoffs AS handoff
            WHERE handoff.tenant_id = action.tenant_id
              AND handoff.resolution_action_id = action.id
         )
         OR EXISTS (
           SELECT 1
             FROM discharge_pending_result_owner_actions AS successor
            WHERE successor.tenant_id = action.tenant_id
              AND successor.predecessor_resolution_action_id = action.id
         )
       )
  )
  THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'pending-result owner-action audit correlation evidence is immutable'
        USING ERRCODE = 'raise_exception';
    END IF;

    IF ROW(
            NEW.tenant_id,
            NEW.id,
            NEW.patient_uid,
            NEW.action,
            NEW.action_status,
            NEW.resource_type,
            NEW.resource_table,
            NEW.resource_id
          ) IS DISTINCT FROM ROW(
            OLD.tenant_id,
            OLD.id,
            OLD.patient_uid,
            OLD.action,
            OLD.action_status,
            OLD.resource_type,
            OLD.resource_table,
            OLD.resource_id
          )
    THEN
      RAISE EXCEPTION
        'pending-result owner-action audit correlation evidence is immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_s4_pending_result_owner_audit_dependency
BEFORE UPDATE OR DELETE ON clinical_audit_events
FOR EACH ROW EXECUTE FUNCTION s4_pending_result_owner_audit_dependency();

CREATE OR REPLACE FUNCTION s4_primary_assignment_pending_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assignment_source IS NOT DISTINCT FROM
       'accepted_covering_handoff'
     AND NOT s4_governed_primary_transfer_exists(
       NEW.tenant_id,
       NEW.id,
       NEW.admission_id,
       NEW.patient_uid,
       NEW.physician_uid
     )
  THEN
    RAISE EXCEPTION
      'primary physician reassignment requires exact accepted handoff, final admission attending, and canonical evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_handoffs AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.admission_id = NEW.admission_id
       AND handoff.patient_uid = NEW.patient_uid
       AND handoff.handoff_state IN ('pending', 'result_available')
       AND (
         handoff.primary_physician_assignment_id IS DISTINCT FROM NEW.id
         OR handoff.named_physician_uid IS DISTINCT FROM NEW.physician_uid
       )
  )
  THEN
    RAISE EXCEPTION
      'primary physician reassignment must update every live pending-result handoff in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_handoffs AS handoff
      JOIN tasks AS tracking_task
        ON tracking_task.tenant_id = handoff.tenant_id
       AND tracking_task.id = handoff.task_id
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.admission_id = NEW.admission_id
       AND handoff.patient_uid = NEW.patient_uid
       AND handoff.handoff_state IN ('pending', 'result_available')
       AND (
         tracking_task.assigned_to_uid IS DISTINCT FROM NEW.physician_uid
         OR tracking_task.assigned_to_role IS NOT NULL
       )
  )
  THEN
    RAISE EXCEPTION
      'primary physician reassignment must update every live pending-result tracking task in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_handoffs AS handoff
      JOIN discharge_pending_result_owner_actions AS action
        ON action.tenant_id = handoff.tenant_id
       AND action.handoff_id = handoff.id
       AND action.admission_id = handoff.admission_id
       AND action.patient_uid = handoff.patient_uid
      JOIN diagnostic_result_generations AS successor_generation
        ON successor_generation.tenant_id = action.tenant_id
       AND successor_generation.predecessor_generation_id =
             action.generation_id
       AND successor_generation.patient_uid = action.patient_uid
       AND successor_generation.admission_id = action.admission_id
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.admission_id = NEW.admission_id
       AND handoff.patient_uid = NEW.patient_uid
       AND handoff.handoff_state IN ('pending', 'result_available')
       AND NOT EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS successor_action
          WHERE successor_action.tenant_id = action.tenant_id
            AND successor_action.handoff_id = action.handoff_id
            AND successor_action.admission_id = action.admission_id
            AND successor_action.patient_uid = action.patient_uid
             AND successor_action.generation_id =
                   successor_generation.id
             AND successor_action.predecessor_generation_id =
                   action.generation_id
             AND successor_action.predecessor_owner_action_id = action.id
       )
  )
  THEN
    RAISE EXCEPTION
      'primary physician reassignment must wait for every signed successor generation to acquire its owner action'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM discharge_pending_result_handoffs AS handoff
      JOIN discharge_pending_result_owner_actions AS action
        ON action.tenant_id = handoff.tenant_id
       AND action.handoff_id = handoff.id
       AND action.admission_id = handoff.admission_id
       AND action.patient_uid = handoff.patient_uid
      JOIN tasks AS action_task
        ON action_task.tenant_id = action.tenant_id
       AND action_task.id = action.task_id
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.admission_id = NEW.admission_id
       AND handoff.patient_uid = NEW.patient_uid
       AND handoff.handoff_state IN ('pending', 'result_available')
       AND NOT EXISTS (
         SELECT 1
           FROM discharge_pending_result_owner_actions AS successor
           WHERE successor.tenant_id = action.tenant_id
             AND successor.handoff_id = action.handoff_id
             AND successor.predecessor_owner_action_id = action.id
       )
       AND (
         action_task.assigned_to_uid IS DISTINCT FROM NEW.physician_uid
         OR action_task.assigned_to_role IS NOT NULL
       )
  )
  THEN
    RAISE EXCEPTION
      'primary physician reassignment must update every current pending-result owner-action task in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_inpatient_primary_assignments_pending_dependency
AFTER INSERT ON inpatient_primary_physician_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION s4_primary_assignment_pending_dependency();

-- ---------------------------------------------------------------------------
-- Append-only, policy-neutral post-discharge contact evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE post_discharge_contact_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  admission_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  event_kind VARCHAR(30) NOT NULL,
  contact_source VARCHAR(30) NOT NULL,
  contact_channel VARCHAR(30) NOT NULL,
  outcome_code VARCHAR(80),
  patient_safe_summary TEXT,
  policy_rule_code VARCHAR(120),
  recorded_by_uid UUID,
  recorded_by_system_key VARCHAR(120),
  canonical_timeline_event_id UUID NOT NULL,
  canonical_audit_event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(220) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT ux_post_discharge_contact_events_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT ux_post_discharge_contact_events_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_post_discharge_contact_events_admission
    FOREIGN KEY (tenant_id, admission_id, patient_uid)
    REFERENCES admissions (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_post_discharge_contact_events_patient
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_post_discharge_contact_events_actor
    FOREIGN KEY (tenant_id, recorded_by_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_post_discharge_contact_events_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_post_discharge_contact_events_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT chk_post_discharge_contact_events_kind CHECK (
    event_kind IN ('attempt', 'outcome')
  ),
  CONSTRAINT chk_post_discharge_contact_events_source CHECK (
    contact_source IN ('manual', 'registered_policy')
  ),
  CONSTRAINT chk_post_discharge_contact_events_channel CHECK (
    contact_channel IN (
      'phone',
      'sms',
      'email',
      'patient_portal',
      'in_person',
      'video',
      'other'
    )
  ),
  CONSTRAINT chk_post_discharge_contact_events_outcome CHECK (
    (event_kind = 'attempt' AND outcome_code IS NULL)
    OR
    (
      event_kind = 'outcome'
      AND NULLIF(BTRIM(outcome_code), '') IS NOT NULL
    )
  ),
  CONSTRAINT chk_post_discharge_contact_events_policy CHECK (
    (
      contact_source = 'manual'
      AND policy_rule_code IS NULL
    )
    OR
    (
      contact_source = 'registered_policy'
      AND NULLIF(BTRIM(policy_rule_code), '') IS NOT NULL
    )
  ),
  CONSTRAINT chk_post_discharge_contact_events_actor CHECK (
    (recorded_by_uid IS NOT NULL) <> (recorded_by_system_key IS NOT NULL)
    AND (
      recorded_by_system_key IS NULL
      OR NULLIF(BTRIM(recorded_by_system_key), '') IS NOT NULL
    )
  ),
  CONSTRAINT chk_post_discharge_contact_events_nonblank CHECK (
    NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
  ),
  CONSTRAINT chk_post_discharge_contact_events_metadata CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX idx_post_discharge_contact_events_admission
  ON post_discharge_contact_events (
    tenant_id,
    admission_id,
    occurred_at DESC
  );

CREATE INDEX idx_post_discharge_contact_events_patient
  ON post_discharge_contact_events (
    tenant_id,
    patient_uid,
    occurred_at DESC
  );

CREATE OR REPLACE FUNCTION s4_validate_post_discharge_contact_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  timeline_record RECORD;
  audit_record RECORD;
BEGIN
  SELECT timeline.id,
         timeline.patient_uid,
         timeline.event_type,
         timeline.source_table,
         timeline.source_id
    INTO timeline_record
    FROM clinical_timeline_events AS timeline
   WHERE timeline.tenant_id = NEW.tenant_id
     AND timeline.id = NEW.canonical_timeline_event_id
   FOR SHARE;

  SELECT audit.id,
         audit.patient_uid,
         audit.action,
         audit.resource_table,
         audit.resource_id
    INTO audit_record
    FROM clinical_audit_events AS audit
   WHERE audit.tenant_id = NEW.tenant_id
     AND audit.id = NEW.canonical_audit_event_id
   FOR SHARE;

  IF timeline_record.id IS NULL
     OR timeline_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR timeline_record.event_type <> 'post_discharge.contact_recorded'
     OR timeline_record.source_table <> 'post_discharge_contact_events'
     OR timeline_record.source_id <> NEW.id::text
     OR audit_record.id IS NULL
     OR audit_record.patient_uid IS DISTINCT FROM NEW.patient_uid
     OR audit_record.action <> 'post_discharge.contact_recorded'
     OR audit_record.resource_table <> 'post_discharge_contact_events'
     OR audit_record.resource_id <> NEW.id::text
  THEN
    RAISE EXCEPTION
      'post-discharge contact requires its exact same-patient canonical timeline and audit records'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_post_discharge_contact_events_validate
BEFORE INSERT ON post_discharge_contact_events
FOR EACH ROW EXECUTE FUNCTION s4_validate_post_discharge_contact_event();

-- ---------------------------------------------------------------------------
-- Append-only protection and forced tenant RLS.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION s4_care_pathway_evidence_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    '% is append-only: % is not allowed without authorized maintenance bypass',
    TG_TABLE_NAME,
    TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER trg_care_pathway_resource_references_append_only
BEFORE UPDATE OR DELETE ON care_pathway_resource_references
FOR EACH ROW EXECUTE FUNCTION s4_care_pathway_evidence_block_mutation();

CREATE TRIGGER trg_op_visit_closure_evidence_append_only
BEFORE UPDATE OR DELETE ON op_visit_closure_evidence
FOR EACH ROW EXECUTE FUNCTION s4_care_pathway_evidence_block_mutation();

CREATE TRIGGER trg_inpatient_primary_assignments_append_only
BEFORE UPDATE OR DELETE ON inpatient_primary_physician_assignments
FOR EACH ROW EXECUTE FUNCTION s4_care_pathway_evidence_block_mutation();

CREATE TRIGGER trg_discharge_pending_result_owner_actions_append_only
BEFORE UPDATE OR DELETE ON discharge_pending_result_owner_actions
FOR EACH ROW EXECUTE FUNCTION s4_care_pathway_evidence_block_mutation();

CREATE TRIGGER trg_post_discharge_contact_events_append_only
BEFORE UPDATE OR DELETE ON post_discharge_contact_events
FOR EACH ROW EXECUTE FUNCTION s4_care_pathway_evidence_block_mutation();

DO $s4_tenant_rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'care_pathway_resource_references',
    'op_visit_closure_evidence',
    'inpatient_primary_physician_assignments',
    'discharge_pending_result_handoffs',
    'discharge_pending_result_owner_actions',
    'post_discharge_contact_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$
      CREATE POLICY tenant_isolation ON %I
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
    $policy$, table_name);
  END LOOP;
END
$s4_tenant_rls$;

COMMENT ON TABLE care_pathway_resource_references IS
  'Append-only closed-type lineage and closure-evidence ledger; never inferred from patient/time proximity.';
COMMENT ON TABLE op_visit_closure_evidence IS
  'Append-only revisioned clinician disposition and patient-safe OP next-step evidence.';
COMMENT ON TABLE inpatient_primary_physician_assignments IS
  'Append-only named inpatient primary-physician assignment history; current means highest assignment_version.';
COMMENT ON TABLE discharge_pending_result_handoffs IS
  'Exact-source, named-owner pending-result handoff state for discharge; source membership is proven by a typed pathway reference.';
COMMENT ON TABLE discharge_pending_result_owner_actions IS
  'Append-only per-handoff owner-action chain; corrected generations append a new leaf task and preserve every prior generation action.';
COMMENT ON TABLE post_discharge_contact_events IS
  'Append-only policy-neutral contact attempt/outcome evidence with no embedded timer or escalation threshold.';
COMMENT ON COLUMN admissions.source_appointment_id IS
  'Exact originating OP appointment when admission follows recorded OP advice; no heuristic backfill.';
COMMENT ON COLUMN admissions.source_handoff_id IS
  'Accepted OP-to-IP cross-pathway handoff when pathway projection is available.';

COMMIT;
