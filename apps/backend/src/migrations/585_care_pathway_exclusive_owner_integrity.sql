-- Unified Care Pathways S1b-c1: exclusive live-owner integrity.
--
-- Generic tasks may remain unassigned and historical terminal receipts retain
-- their stored routing evidence. Live pathway work and typed clinical tasks,
-- however, must use exactly one route: a viable named user or a route-capable
-- role queue. A named pathway owner is never converted into a role fallback by
-- a user deletion; explicit reassignment must complete in the same transaction.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $care_pathway_access_audit_schema_preflight$
DECLARE
  audit_relation RECORD;
  access_source_column RECORD;
  access_source_constraint RECORD;
BEGIN
  SELECT relation.oid,
         relation.relkind,
         relation.relowner
    INTO audit_relation
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'patient_access_audit_log';

  IF NOT FOUND
     OR audit_relation.relkind <> 'r'
     OR audit_relation.relowner <>
          (CURRENT_USER::pg_catalog.regrole)::pg_catalog.oid
  THEN
    RAISE EXCEPTION
      'migration 585 blocked: patient access audit relation ownership or kind is noncanonical'
      USING ERRCODE = '55000';
  END IF;

  SELECT attribute.atttypid,
         attribute.atttypmod,
         attribute.attnotnull,
         attribute.attisdropped
    INTO access_source_column
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = audit_relation.oid
     AND attribute.attname = 'access_source'
     AND attribute.attnum > 0;

  IF NOT FOUND
     OR access_source_column.atttypid <> pg_catalog.to_regtype('pg_catalog.varchar')
     OR access_source_column.atttypmod <> 44
     OR access_source_column.attnotnull IS DISTINCT FROM TRUE
     OR access_source_column.attisdropped IS DISTINCT FROM FALSE
  THEN
    RAISE EXCEPTION
      'migration 585 blocked: patient access audit source column is noncanonical'
      USING ERRCODE = '55000';
  END IF;

  SELECT constraint_row.contype,
         constraint_row.convalidated,
         constraint_row.connoinherit
    INTO access_source_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = audit_relation.oid
     AND constraint_row.conname =
           'patient_access_audit_log_access_source_check';

  IF NOT FOUND
     OR access_source_constraint.contype <> 'c'
     OR access_source_constraint.convalidated IS DISTINCT FROM TRUE
     OR access_source_constraint.connoinherit IS DISTINCT FROM FALSE
  THEN
    RAISE EXCEPTION
      'migration 585 blocked: patient access audit source constraint is noncanonical'
      USING ERRCODE = '55000';
  END IF;
END
$care_pathway_access_audit_schema_preflight$;

LOCK TABLE users,
  workflow_sla_instances,
  workflow_steps,
  care_pathway_instances,
  tasks,
  public.patient_access_audit_log
  IN ACCESS EXCLUSIVE MODE;

CREATE TEMPORARY TABLE care_pathway_access_source_constraint_probe (
  access_source VARCHAR(40) NOT NULL
) ON COMMIT DROP;

ALTER TABLE care_pathway_access_source_constraint_probe
  ADD CONSTRAINT care_pathway_access_source_constraint_probe_old
  CHECK (access_source IN (
    'role', 'care_team', 'clinical_authorship', 'appointment', 'admission',
    'guardian', 'break_glass', 'system', 'unknown'
  )),
  ADD CONSTRAINT care_pathway_access_source_constraint_probe_new
  CHECK (access_source IN (
    'role', 'care_team', 'clinical_authorship', 'appointment', 'admission',
    'guardian', 'break_glass', 'system', 'unknown', 'care_pathway_owner'
  ));

DO $care_pathway_access_audit_constraint_preflight$
DECLARE
  audit_expression TEXT;
  old_expression TEXT;
  new_expression TEXT;
BEGIN
  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO audit_expression
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'public.patient_access_audit_log'::pg_catalog.regclass
     AND constraint_row.conname =
           'patient_access_audit_log_access_source_check';

  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO old_expression
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
           'pg_temp.care_pathway_access_source_constraint_probe'::pg_catalog.regclass
     AND constraint_row.conname =
           'care_pathway_access_source_constraint_probe_old';

  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO new_expression
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
           'pg_temp.care_pathway_access_source_constraint_probe'::pg_catalog.regclass
     AND constraint_row.conname =
           'care_pathway_access_source_constraint_probe_new';

  IF audit_expression IS NULL
     OR audit_expression NOT IN (old_expression, new_expression)
  THEN
    RAISE EXCEPTION
      'migration 585 blocked: patient access audit source constraint expression is noncanonical'
      USING ERRCODE = '55000';
  END IF;
END
$care_pathway_access_audit_constraint_preflight$;

DROP TABLE care_pathway_access_source_constraint_probe;

ALTER TABLE public.patient_access_audit_log
  DROP CONSTRAINT patient_access_audit_log_access_source_check;
ALTER TABLE public.patient_access_audit_log
  ADD CONSTRAINT patient_access_audit_log_access_source_check
  CHECK (access_source IN (
    'role', 'care_team', 'clinical_authorship', 'appointment', 'admission',
    'guardian', 'break_glass', 'system', 'unknown', 'care_pathway_owner'
  ));

-- This array is the database projection of rolePolicyGraph.js roles whose
-- canonical group is "clinical". Named pathway accountability is narrower
-- than the inbox/queue route surface: administrative and support roles may
-- service an explicit queue, but they cannot become the named clinician.
CREATE OR REPLACE FUNCTION care_pathway_clinical_accountability_roles()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT', 'DUTY_DOCTOR',
    'NURSING_STAFF', 'NURSING_INCHARGE', 'OP_STAFF_NURSE', 'OP_INCHARGE',
    'IP_STAFF_NURSE', 'IP_INCHARGE', 'OT_NURSE', 'OT_INCHARGE',
    'CATH_LAB_STAFF', 'CATH_LAB_INCHARGE', 'RADIOLOGIST', 'ANESTHETIST',
    'PHYSIOTHERAPIST', 'DIETITIAN', 'COUNSELLOR', 'SENIOR_DOCTOR',
    'ANAESTHETIST', 'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'ER_STAFF',
    'DIALYSIS_TECHNICIAN', 'RADIOLOGY_STAFF', 'PATHOLOGIST', 'LAB_INCHARGE',
    'BLOOD_BANK_STAFF', 'BLOOD_BANK_TECHNICIAN'
  ]::TEXT[];
$$;

CREATE OR REPLACE FUNCTION care_pathway_named_owner_is_viable(
  target_tenant_id UUID,
  target_owner_uid UUID,
  obligation_rule_code TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT target_tenant_id IS NOT NULL
     AND target_owner_uid IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM users AS owner
        WHERE owner.tenant_id = target_tenant_id
          AND owner.uid = target_owner_uid
          AND owner.is_active = TRUE
          AND LOWER(COALESCE(owner.status, '')) = 'active'
          AND owner.is_deleted IS FALSE
          AND owner.deleted_at IS NULL
          AND care_pathway_is_route_actionable_human_role(
                owner.role,
                obligation_rule_code
              )
     );
$$;

CREATE OR REPLACE FUNCTION care_pathway_named_clinician_is_viable(
  target_tenant_id UUID,
  target_owner_uid UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT target_tenant_id IS NOT NULL
     AND target_owner_uid IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM users AS owner
        WHERE owner.tenant_id = target_tenant_id
          AND owner.uid = target_owner_uid
          AND owner.is_active = TRUE
          AND LOWER(COALESCE(owner.status, '')) = 'active'
          AND owner.is_deleted IS FALSE
          AND owner.deleted_at IS NULL
          AND UPPER(BTRIM(owner.role)) = ANY(
                care_pathway_clinical_accountability_roles()
              )
     );
$$;

CREATE OR REPLACE FUNCTION care_pathway_task_owner_is_exclusive_and_viable(
  target_tenant_id UUID,
  target_owner_uid UUID,
  target_owner_role TEXT,
  obligation_rule_code TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN target_owner_uid IS NOT NULL THEN
      target_owner_role IS NULL
      AND care_pathway_named_owner_is_viable(
            target_tenant_id,
            target_owner_uid,
            obligation_rule_code
          )
    ELSE
      NULLIF(BTRIM(target_owner_role), '') IS NOT NULL
      AND care_pathway_is_route_actionable_human_role(
            target_owner_role,
            obligation_rule_code
          )
  END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_task_sla_owner_agrees(
  task_owner_uid UUID,
  task_owner_role TEXT,
  sla_owner_uid UUID,
  sla_owner_roles TEXT[],
  obligation_rule_code TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- Only the verified critical-result and mortuary compatibility producers
    -- may omit the SLA-side declaration. Cold-chain alerts require an explicit
    -- route so an empty role array cannot silently become task-authoritative.
    WHEN sla_owner_uid IS NULL
         AND CARDINALITY(COALESCE(sla_owner_roles, ARRAY[]::TEXT[])) = 0
      THEN COALESCE(
        obligation_rule_code IN (
          'critical_result_ack',
          'mortuary_unclaimed_body'
        ),
        FALSE
      )
    WHEN sla_owner_uid IS NOT NULL THEN
      CARDINALITY(COALESCE(sla_owner_roles, ARRAY[]::TEXT[])) = 0
      AND task_owner_uid = sla_owner_uid
      AND task_owner_role IS NULL
    ELSE
      task_owner_uid IS NULL
      AND NULLIF(BTRIM(task_owner_role), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM UNNEST(COALESCE(sla_owner_roles, ARRAY[]::TEXT[])) AS role_code
         WHERE UPPER(BTRIM(role_code)) = UPPER(BTRIM(task_owner_role))
      )
      AND NOT EXISTS (
        SELECT 1
          FROM UNNEST(COALESCE(sla_owner_roles, ARRAY[]::TEXT[])) AS role_code
         WHERE NOT care_pathway_is_route_actionable_human_role(
                     role_code,
                     obligation_rule_code
                   )
      )
  END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_assert_live_instance_owner(
  target_tenant_id UUID,
  target_pathway_instance_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  pathway_record RECORD;
BEGIN
  IF target_tenant_id IS NULL OR target_pathway_instance_id IS NULL THEN
    RETURN;
  END IF;

  SELECT instance.tenant_id,
         instance.owning_clinician_uid,
         instance.accountable_role,
         instance.clinical_status
    INTO pathway_record
    FROM care_pathway_instances AS instance
   WHERE instance.tenant_id = target_tenant_id
     AND instance.id = target_pathway_instance_id;

  IF NOT FOUND
     OR pathway_record.clinical_status NOT IN ('planned', 'active', 'on_hold')
  THEN
    RETURN;
  END IF;

  IF NOT care_pathway_is_route_actionable_human_role(
           pathway_record.accountable_role,
           'care_pathway_stage'
         )
  THEN
    RAISE EXCEPTION
      'live pathway instance requires a route-capable accountable role'
      USING ERRCODE = 'check_violation';
  END IF;

  IF pathway_record.owning_clinician_uid IS NULL THEN
    RETURN;
  END IF;

  -- Serialize the final viability decision with any concurrent lifecycle
  -- update. FOR SHARE conflicts with updates to status/deletion/role columns.
  PERFORM 1
    FROM users AS owner
   WHERE owner.tenant_id = pathway_record.tenant_id
     AND owner.uid = pathway_record.owning_clinician_uid
   FOR SHARE;

  IF NOT care_pathway_named_clinician_is_viable(
           pathway_record.tenant_id,
           pathway_record.owning_clinician_uid
         )
  THEN
    RAISE EXCEPTION
      'live pathway instance requires an active same-tenant clinically eligible named owner'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_assert_actionable_task_owner(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  obligation RECORD;
  is_pathway_task BOOLEAN;
  is_typed_human_task BOOLEAN;
  obligation_rule_code TEXT;
BEGIN
  IF target_tenant_id IS NULL OR target_task_id IS NULL THEN
    RETURN;
  END IF;

  SELECT task.tenant_id,
         task.id,
         task.status,
         task.assigned_to_uid,
         task.assigned_to_role,
         task.sla_completion_semantics,
         pathway.id AS pathway_instance_id,
         pathway.owning_clinician_uid AS pathway_owner_uid,
         COALESCE(
           NULLIF(BTRIM(step.assigned_role), ''),
           NULLIF(BTRIM(pathway.accountable_role), '')
         ) AS pathway_resolved_role,
         sla.id AS sla_id,
         sla.rule_code AS sla_rule_code,
         sla.status AS sla_status,
         sla.completed_at AS sla_completed_at,
         sla.assigned_user_uid AS sla_owner_uid,
         sla.assigned_role_codes AS sla_owner_roles
    INTO obligation
    FROM tasks AS task
    LEFT JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = task.tenant_id
     AND pathway.workflow_run_id = task.workflow_run_id
    LEFT JOIN workflow_steps AS step
      ON step.tenant_id = task.tenant_id
     AND step.id = task.workflow_step_id
     AND step.workflow_run_id = task.workflow_run_id
    LEFT JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR obligation.status NOT IN ('open', 'in_progress', 'blocked', 'overdue')
  THEN
    RETURN;
  END IF;

  is_pathway_task := obligation.pathway_instance_id IS NOT NULL;
  is_typed_human_task :=
    obligation.sla_id IS NOT NULL
    AND obligation.sla_rule_code IN (
      'critical_result_ack',
      'cold_chain_excursion_ack',
      'mortuary_unclaimed_body'
    )
    AND obligation.sla_completion_semantics IN ('acknowledgement', 'domain_evidence')
    AND obligation.sla_completed_at IS NULL
    AND obligation.sla_status IN ('active', 'breached', 'escalated');

  IF NOT is_pathway_task AND NOT is_typed_human_task THEN
    RETURN;
  END IF;

  obligation_rule_code := COALESCE(
    NULLIF(BTRIM(obligation.sla_rule_code), ''),
    'care_pathway_stage'
  );

  IF obligation.assigned_to_uid IS NOT NULL THEN
    PERFORM 1
      FROM users AS owner
     WHERE owner.tenant_id = obligation.tenant_id
       AND owner.uid = obligation.assigned_to_uid
     FOR SHARE;
  END IF;

  IF (
    is_pathway_task
    AND obligation.assigned_to_uid IS NOT NULL
    AND (
      obligation.assigned_to_role IS NOT NULL
      OR NOT care_pathway_named_clinician_is_viable(
               obligation.tenant_id,
               obligation.assigned_to_uid
             )
    )
  ) OR (
    NOT (is_pathway_task AND obligation.assigned_to_uid IS NOT NULL)
    AND NOT care_pathway_task_owner_is_exclusive_and_viable(
              obligation.tenant_id,
              obligation.assigned_to_uid,
              obligation.assigned_to_role,
              obligation_rule_code
            )
  )
  THEN
    RAISE EXCEPTION
      'actionable clinical task requires exactly one live route-capable owner'
      USING ERRCODE = 'check_violation';
  END IF;

  IF is_pathway_task THEN
    PERFORM care_pathway_assert_live_instance_owner(
      obligation.tenant_id,
      obligation.pathway_instance_id
    );

    IF obligation.pathway_owner_uid IS NOT NULL THEN
      IF obligation.assigned_to_uid IS DISTINCT FROM obligation.pathway_owner_uid
         OR obligation.assigned_to_role IS NOT NULL
      THEN
        RAISE EXCEPTION
          'actionable pathway task must follow its named pathway owner'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF obligation.assigned_to_uid IS NOT NULL
          OR NULLIF(BTRIM(obligation.assigned_to_role), '') IS NULL
          OR UPPER(BTRIM(obligation.assigned_to_role)) IS DISTINCT FROM
               UPPER(BTRIM(obligation.pathway_resolved_role))
    THEN
      RAISE EXCEPTION
        'role-owned pathway instance requires a role-owned actionable task'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF obligation.sla_id IS NOT NULL THEN
    IF is_pathway_task AND (
      (
        obligation.pathway_owner_uid IS NOT NULL
        AND (
          obligation.sla_owner_uid IS DISTINCT FROM obligation.pathway_owner_uid
          OR CARDINALITY(
               COALESCE(obligation.sla_owner_roles, ARRAY[]::TEXT[])
             ) <> 0
        )
      )
      OR
      (
        obligation.pathway_owner_uid IS NULL
        AND (
          obligation.sla_owner_uid IS NOT NULL
          OR CARDINALITY(
               COALESCE(obligation.sla_owner_roles, ARRAY[]::TEXT[])
             ) <> 1
          OR UPPER(BTRIM(obligation.sla_owner_roles[1])) IS DISTINCT FROM
               UPPER(BTRIM(obligation.assigned_to_role))
        )
      )
    )
    THEN
      RAISE EXCEPTION
        'actionable pathway SLA requires the same single exclusive owner as its task'
        USING ERRCODE = 'check_violation';
    ELSIF NOT is_pathway_task
          AND NOT care_pathway_task_sla_owner_agrees(
                    obligation.assigned_to_uid,
                    obligation.assigned_to_role,
                    obligation.sla_owner_uid,
                    obligation.sla_owner_roles,
                    obligation_rule_code
                  )
    THEN
      RAISE EXCEPTION
        'actionable clinical task and SLA owner assignments must agree'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END;
$$;

-- Migration 580's deferred receipt triggers remain installed and call this
-- assertion at commit. Specialize its named-owner check for governed pathway
-- SLAs so clinical accountability (rather than the narrower queue surface)
-- remains authoritative, while role queues and non-pathway typed rails keep
-- their existing route-specific semantics.
CREATE OR REPLACE FUNCTION care_pathway_assert_human_sla_task_obligation(
  target_tenant_id UUID,
  target_sla_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  sla_record workflow_sla_instances%ROWTYPE;
  expected_semantics TEXT;
  governed_step_id INTEGER;
  governed_run_id INTEGER;
  current_task_id_text TEXT;
  actionable_count INTEGER;
  exact_actionable_count INTEGER;
  terminal_receipt_count INTEGER;
BEGIN
  IF target_tenant_id IS NULL OR target_sla_id IS NULL THEN
    RETURN;
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances AS sla
   WHERE sla.tenant_id = target_tenant_id
     AND sla.id = target_sla_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF sla_record.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack') THEN
    expected_semantics := 'acknowledgement';
  ELSIF sla_record.rule_code = 'mortuary_unclaimed_body' THEN
    expected_semantics := 'domain_evidence';
  ELSIF sla_record.source_table = 'workflow_steps'
        AND sla_record.source_id ~ '^[1-9][0-9]*$'
        AND pg_input_is_valid(sla_record.source_id, 'integer')
  THEN
    SELECT step.id,
           step.workflow_run_id
      INTO governed_step_id,
           governed_run_id
      FROM workflow_steps AS step
      JOIN care_pathway_instances AS pathway
        ON pathway.tenant_id = step.tenant_id
       AND pathway.workflow_run_id = step.workflow_run_id
       AND pathway.id::text =
             sla_record.metadata->>'care_pathway_instance_id'
     WHERE step.tenant_id = sla_record.tenant_id
       AND step.id = sla_record.source_id::integer
       AND step.step_kind IN ('task', 'approval')
     LIMIT 1;

    IF NOT FOUND THEN
      RETURN;
    END IF;
  ELSE
    RETURN;
  END IF;

  IF sla_record.completed_at IS NULL
     AND sla_record.status IN ('active', 'breached', 'escalated')
  THEN
    SELECT COUNT(*)::integer,
           COUNT(*) FILTER (
             WHERE task.due_at IS NOT DISTINCT FROM sla_record.due_at
               AND (expected_semantics IS NULL OR task.task_kind = 'review')
               AND task.patient_uid IS NOT DISTINCT FROM sla_record.patient_uid
               AND (
                 (expected_semantics IS NOT NULL
                  AND task.sla_completion_semantics = expected_semantics)
                 OR
                 (expected_semantics IS NULL
                  AND task.sla_completion_semantics IN (
                    'acknowledgement', 'domain_evidence'
                  ))
               )
               AND (
                 (governed_step_id IS NULL
                  AND task.related_resource_type IS NOT DISTINCT FROM
                        CASE
                          WHEN sla_record.rule_code = 'mortuary_unclaimed_body'
                            THEN 'death_record'
                          ELSE sla_record.source_table
                        END
                  AND task.related_resource_id IS NOT DISTINCT FROM
                        sla_record.source_id)
                 OR
                 (governed_step_id IS NOT NULL
                  AND task.workflow_step_id = governed_step_id
                  AND task.workflow_run_id = governed_run_id)
               )
               AND (
                 (task.assigned_to_uid IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                      FROM users AS owner
                     WHERE owner.tenant_id = task.tenant_id
                       AND owner.uid = task.assigned_to_uid
                       AND (
                         (
                           governed_step_id IS NOT NULL
                           AND care_pathway_named_clinician_is_viable(
                                 task.tenant_id,
                                 task.assigned_to_uid
                               )
                         )
                         OR
                         (
                           governed_step_id IS NULL
                           AND owner.is_active = TRUE
                           AND care_pathway_is_route_actionable_human_role(
                                 owner.role,
                                 sla_record.rule_code
                               )
                         )
                       )
                     FOR SHARE
                   ))
                 OR care_pathway_is_route_actionable_human_role(
                      task.assigned_to_role,
                      sla_record.rule_code
                    )
               )
           )::integer
      INTO actionable_count,
           exact_actionable_count
      FROM tasks AS task
     WHERE task.tenant_id = sla_record.tenant_id
       AND task.workflow_sla_instance_id = sla_record.id
       AND task.status IN ('open', 'in_progress', 'blocked', 'overdue');

    IF actionable_count <> 1 OR exact_actionable_count <> 1 THEN
      RAISE EXCEPTION
        'incomplete human-action SLA requires exactly one owned actionable task'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  current_task_id_text :=
    NULLIF(BTRIM(sla_record.metadata->>'completed_by_task'), '');
  IF sla_record.completed_at IS NULL
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated', 'cancelled')
     OR current_task_id_text IS NULL
     OR current_task_id_text !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(current_task_id_text, 'integer')
  THEN
    RAISE EXCEPTION
      'terminal human-action SLA requires its exact current task receipt'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::integer
    INTO terminal_receipt_count
    FROM tasks AS task
   WHERE task.tenant_id = sla_record.tenant_id
     AND task.id = current_task_id_text::integer
     AND task.workflow_sla_instance_id = sla_record.id
     AND (expected_semantics IS NULL OR task.task_kind = 'review')
     AND task.status IN ('in_progress', 'completed', 'cancelled')
     AND task.due_at IS NOT DISTINCT FROM sla_record.due_at
     AND task.patient_uid IS NOT DISTINCT FROM sla_record.patient_uid
     AND (
       (expected_semantics IS NOT NULL
        AND task.sla_completion_semantics = expected_semantics)
       OR
       (expected_semantics IS NULL
        AND task.sla_completion_semantics IN ('acknowledgement', 'domain_evidence'))
     )
     AND (
       (governed_step_id IS NULL
        AND task.related_resource_type IS NOT DISTINCT FROM
              CASE
                WHEN sla_record.rule_code = 'mortuary_unclaimed_body'
                  THEN 'death_record'
                ELSE sla_record.source_table
              END
        AND task.related_resource_id IS NOT DISTINCT FROM sla_record.source_id)
       OR
       (governed_step_id IS NOT NULL
        AND task.workflow_step_id = governed_step_id
        AND task.workflow_run_id = governed_run_id)
     );

  IF terminal_receipt_count <> 1 THEN
    RAISE EXCEPTION
      'terminal human-action SLA requires its exact current task receipt'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- Fail closed before installing the new constraints. No owner is inferred and
-- no routing field is rewritten by this migration.
DO $care_pathway_exclusive_owner_preflight$
DECLARE
  dual_owner_count INTEGER;
  missing_owner_count INTEGER;
  invalid_owner_count INTEGER;
  pathway_source_mismatch_count INTEGER;
  sla_owner_mismatch_count INTEGER;
  invalid_instance_owner_count INTEGER;
BEGIN
  WITH guarded_tasks AS (
    SELECT task.tenant_id,
           task.assigned_to_uid,
           task.assigned_to_role,
           pathway.id AS pathway_instance_id,
           pathway.owning_clinician_uid AS pathway_owner_uid,
           COALESCE(
             NULLIF(BTRIM(step.assigned_role), ''),
             NULLIF(BTRIM(pathway.accountable_role), '')
           ) AS pathway_resolved_role,
           sla.id AS sla_id,
           sla.rule_code,
           sla.assigned_user_uid AS sla_owner_uid,
           sla.assigned_role_codes AS sla_owner_roles,
           pathway.id IS NOT NULL AS is_pathway_task
      FROM tasks AS task
      LEFT JOIN care_pathway_instances AS pathway
        ON pathway.tenant_id = task.tenant_id
       AND pathway.workflow_run_id = task.workflow_run_id
      LEFT JOIN workflow_steps AS step
        ON step.tenant_id = task.tenant_id
       AND step.id = task.workflow_step_id
       AND step.workflow_run_id = task.workflow_run_id
      LEFT JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.status IN ('open', 'in_progress', 'blocked', 'overdue')
       AND (
         pathway.id IS NOT NULL
         OR (
           sla.id IS NOT NULL
           AND sla.rule_code IN (
             'critical_result_ack',
             'cold_chain_excursion_ack',
             'mortuary_unclaimed_body'
           )
           AND task.sla_completion_semantics IN ('acknowledgement', 'domain_evidence')
           AND sla.completed_at IS NULL
           AND sla.status IN ('active', 'breached', 'escalated')
         )
       )
  )
  SELECT COUNT(*) FILTER (
           WHERE assigned_to_uid IS NOT NULL
             AND assigned_to_role IS NOT NULL
         )::integer,
         COUNT(*) FILTER (
           WHERE assigned_to_uid IS NULL
             AND NULLIF(BTRIM(assigned_to_role), '') IS NULL
         )::integer,
         COUNT(*) FILTER (
           WHERE NOT CASE
             WHEN is_pathway_task AND assigned_to_uid IS NOT NULL THEN
               assigned_to_role IS NULL
               AND care_pathway_named_clinician_is_viable(
                     tenant_id,
                     assigned_to_uid
                   )
             ELSE
               care_pathway_task_owner_is_exclusive_and_viable(
                 tenant_id,
                 assigned_to_uid,
                 assigned_to_role,
                 COALESCE(NULLIF(BTRIM(rule_code), ''), 'care_pathway_stage')
               )
           END
         )::integer,
         COUNT(*) FILTER (
           WHERE is_pathway_task
             AND (
               (
                 pathway_owner_uid IS NOT NULL
                 AND (
                   assigned_to_uid IS DISTINCT FROM pathway_owner_uid
                   OR assigned_to_role IS NOT NULL
                 )
               )
               OR
               (
                 pathway_owner_uid IS NULL
                 AND (
                   assigned_to_uid IS NOT NULL
                   OR NULLIF(BTRIM(assigned_to_role), '') IS NULL
                   OR UPPER(BTRIM(assigned_to_role)) IS DISTINCT FROM
                        UPPER(BTRIM(pathway_resolved_role))
                 )
               )
             )
         )::integer,
         COUNT(*) FILTER (
           WHERE sla_id IS NOT NULL
             AND (
               NOT care_pathway_task_sla_owner_agrees(
                     assigned_to_uid,
                     assigned_to_role,
                     sla_owner_uid,
                     sla_owner_roles,
                     COALESCE(NULLIF(BTRIM(rule_code), ''), 'care_pathway_stage')
                   )
               OR (
                 is_pathway_task
                 AND (
                   (
                     pathway_owner_uid IS NOT NULL
                     AND (
                       sla_owner_uid IS DISTINCT FROM pathway_owner_uid
                       OR CARDINALITY(
                            COALESCE(sla_owner_roles, ARRAY[]::TEXT[])
                          ) <> 0
                     )
                   )
                   OR
                   (
                     pathway_owner_uid IS NULL
                     AND (
                       sla_owner_uid IS NOT NULL
                       OR CARDINALITY(
                            COALESCE(sla_owner_roles, ARRAY[]::TEXT[])
                          ) <> 1
                       OR UPPER(BTRIM(sla_owner_roles[1])) IS DISTINCT FROM
                            UPPER(BTRIM(assigned_to_role))
                     )
                   )
                 )
               )
             )
         )::integer
    INTO dual_owner_count,
         missing_owner_count,
         invalid_owner_count,
         pathway_source_mismatch_count,
         sla_owner_mismatch_count
    FROM guarded_tasks;

  SELECT COUNT(*)::integer
    INTO invalid_instance_owner_count
    FROM care_pathway_instances AS pathway
   WHERE pathway.clinical_status IN ('planned', 'active', 'on_hold')
     AND (
       NOT care_pathway_is_route_actionable_human_role(
             pathway.accountable_role,
             'care_pathway_stage'
           )
       OR (
         pathway.owning_clinician_uid IS NOT NULL
         AND NOT care_pathway_named_clinician_is_viable(
                   pathway.tenant_id,
                   pathway.owning_clinician_uid
                 )
       )
     );

  IF dual_owner_count > 0
     OR missing_owner_count > 0
     OR invalid_owner_count > 0
     OR pathway_source_mismatch_count > 0
     OR sla_owner_mismatch_count > 0
     OR invalid_instance_owner_count > 0
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 585 blocked: live clinical ownership is not exclusive '
        || '(dual=%s, missing=%s, invalid=%s, pathway_source_mismatch=%s, '
        || 'sla_mismatch=%s, invalid_pathway_owner=%s)',
        dual_owner_count,
        missing_owner_count,
        invalid_owner_count,
        pathway_source_mismatch_count,
        sla_owner_mismatch_count,
        invalid_instance_owner_count
      ),
      HINT = 'Explicitly reconcile each live pathway or typed clinical obligation. A named owner must remain named and viable; the migration never converts it to a role queue.';
  END IF;
END
$care_pathway_exclusive_owner_preflight$;

-- ON DELETE SET NULL silently promoted accountable_role into a fallback. A
-- deferred NO ACTION relationship permits an explicit same-transaction owner
-- reassignment but never performs that transfer on behalf of the application.
ALTER TABLE care_pathway_instances
  DROP CONSTRAINT fk_care_pathway_instances_owner_tenant;

ALTER TABLE care_pathway_instances
  ADD CONSTRAINT fk_care_pathway_instances_owner_tenant
  FOREIGN KEY (tenant_id, owning_clinician_uid)
  REFERENCES users (tenant_id, uid)
  ON UPDATE NO ACTION
  ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION care_pathway_task_owner_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM care_pathway_assert_actionable_task_owner(NEW.tenant_id, NEW.id);
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.id IS DISTINCT FROM NEW.id
     )
  THEN
    PERFORM care_pathway_assert_actionable_task_owner(OLD.tenant_id, OLD.id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_exclusive_live_owner
  AFTER INSERT OR UPDATE OR DELETE ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_task_owner_constraint();

CREATE OR REPLACE FUNCTION care_pathway_sla_owner_dependency_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = NEW.tenant_id
       AND task.workflow_sla_instance_id = NEW.id;
  END IF;

  IF TG_OP <> 'INSERT'
     AND (
       TG_OP = 'DELETE'
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.id IS DISTINCT FROM NEW.id
     )
  THEN
    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.workflow_sla_instance_id = OLD.id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_workflow_sla_exclusive_live_owner
  AFTER INSERT OR UPDATE OR DELETE ON workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_sla_owner_dependency_constraint();

CREATE OR REPLACE FUNCTION care_pathway_step_owner_dependency_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = NEW.tenant_id
       AND task.workflow_step_id = NEW.id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- The task FK has already applied ON DELETE SET NULL by this AFTER trigger.
    -- Recheck the run so losing a step override cannot silently change the
    -- authoritative role from step.assigned_role to pathway.accountable_role.
    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.workflow_run_id = OLD.workflow_run_id;
  ELSIF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.id IS DISTINCT FROM NEW.id
        OR OLD.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id
        OR OLD.assigned_role IS DISTINCT FROM NEW.assigned_role
  THEN
    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.workflow_step_id = OLD.id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_workflow_steps_exclusive_live_owner_update
  AFTER UPDATE OF tenant_id, id, workflow_run_id, assigned_role ON workflow_steps
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_step_owner_dependency_constraint();

CREATE CONSTRAINT TRIGGER trg_workflow_steps_exclusive_live_owner_delete
  AFTER DELETE ON workflow_steps
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_step_owner_dependency_constraint();

CREATE OR REPLACE FUNCTION care_pathway_instance_owner_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM care_pathway_assert_live_instance_owner(NEW.tenant_id, NEW.id);
    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = NEW.tenant_id
       AND task.workflow_run_id = NEW.workflow_run_id;
  END IF;

  IF TG_OP <> 'INSERT'
     AND (
       TG_OP = 'DELETE'
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.id IS DISTINCT FROM NEW.id
       OR OLD.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id
     )
  THEN
    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.workflow_run_id = OLD.workflow_run_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_pathway_instances_exclusive_live_owner
  AFTER INSERT OR UPDATE OR DELETE ON care_pathway_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_instance_owner_constraint();

CREATE OR REPLACE FUNCTION care_pathway_live_owner_user_dependency_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM care_pathway_assert_live_instance_owner(pathway.tenant_id, pathway.id)
      FROM care_pathway_instances AS pathway
     WHERE pathway.tenant_id = OLD.tenant_id
       AND pathway.owning_clinician_uid = OLD.uid;

    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.assigned_to_uid = OLD.uid;
  ELSE
    PERFORM care_pathway_assert_live_instance_owner(pathway.tenant_id, pathway.id)
      FROM care_pathway_instances AS pathway
     WHERE (
       pathway.tenant_id = OLD.tenant_id
       AND pathway.owning_clinician_uid = OLD.uid
     ) OR (
       pathway.tenant_id = NEW.tenant_id
       AND pathway.owning_clinician_uid = NEW.uid
     );

    PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE (
       task.tenant_id = OLD.tenant_id
       AND task.assigned_to_uid = OLD.uid
     ) OR (
       task.tenant_id = NEW.tenant_id
       AND task.assigned_to_uid = NEW.uid
     );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_users_exclusive_live_owner_delete
  AFTER DELETE ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_live_owner_user_dependency_constraint();

CREATE CONSTRAINT TRIGGER trg_users_exclusive_live_owner_viability
  AFTER UPDATE OF tenant_id, uid, is_active, role, status, is_deleted, deleted_at
  ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_live_owner_user_dependency_constraint();

DO $care_pathway_exclusive_owner_postflight$
BEGIN
  PERFORM care_pathway_assert_live_instance_owner(pathway.tenant_id, pathway.id)
    FROM care_pathway_instances AS pathway
   WHERE pathway.clinical_status IN ('planned', 'active', 'on_hold');

  PERFORM care_pathway_assert_actionable_task_owner(task.tenant_id, task.id)
    FROM tasks AS task
    LEFT JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = task.tenant_id
     AND pathway.workflow_run_id = task.workflow_run_id
    LEFT JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
   WHERE task.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND (
       pathway.id IS NOT NULL
       OR (
         sla.id IS NOT NULL
         AND sla.rule_code IN (
           'critical_result_ack',
           'cold_chain_excursion_ack',
           'mortuary_unclaimed_body'
         )
         AND task.sla_completion_semantics IN ('acknowledgement', 'domain_evidence')
         AND sla.completed_at IS NULL
         AND sla.status IN ('active', 'breached', 'escalated')
       )
     );
END
$care_pathway_exclusive_owner_postflight$;

COMMIT;
