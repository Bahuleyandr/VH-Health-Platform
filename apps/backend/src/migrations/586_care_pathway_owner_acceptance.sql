-- Unified Care Pathways S1b-c2: explicit owner acceptance evidence.
--
-- Covering-clinician requests remain requests until the exact intended user
-- accepts. This migration adds only the durable acceptance receipt and the
-- indexes/constraints needed to enforce that protocol; it never infers an
-- owner, repairs a handoff, or changes a tenant pathway mode.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $care_pathway_owner_acceptance_schema_preflight$
DECLARE
  handoff_relation RECORD;
  audit_relation RECORD;
  access_source_column RECORD;
  access_source_constraint RECORD;
  owner_assertion_function RECORD;
  canonical_handoff_column_count INTEGER;
  canonical_handoff_constraint_count INTEGER;
  owner_dependency_function_count INTEGER;
  owner_dependency_trigger_count INTEGER;
BEGIN
  SELECT relation.oid,
         relation.relkind,
         relation.relowner
    INTO handoff_relation
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'care_handoff_instances';

  IF NOT FOUND
     OR handoff_relation.relkind <> 'r'
     OR handoff_relation.relowner <>
          (CURRENT_USER::pg_catalog.regrole)::pg_catalog.oid
  THEN
    RAISE EXCEPTION
      'migration 586 blocked: care handoff relation ownership or kind is noncanonical'
      USING ERRCODE = '55000';
  END IF;

  WITH expected_columns (column_name, formatted_type, is_not_null) AS (
    VALUES
      ('tenant_id', 'uuid', TRUE),
      ('patient_uid', 'uuid', TRUE),
      ('sending_pathway_instance_id', 'uuid', TRUE),
      ('sending_workflow_run_id', 'integer', TRUE),
      ('sending_step_key', 'character varying(120)', TRUE),
      ('receiving_pathway_instance_id', 'uuid', FALSE),
      ('receiving_workflow_run_id', 'integer', FALSE),
      ('receiving_step_key', 'character varying(120)', FALSE),
      ('handoff_type', 'character varying(80)', TRUE),
      ('source_resource_type', 'character varying(80)', TRUE),
      ('source_resource_id', 'character varying(160)', TRUE),
      ('urgency_code', 'character varying(40)', TRUE),
      ('policy_due_at', 'timestamp(6) with time zone', FALSE),
      ('sender_uid', 'uuid', FALSE),
      ('sender_system_key', 'character varying(120)', FALSE),
      ('recipient_kind', 'character varying(30)', TRUE),
      ('intended_recipient_uid', 'uuid', FALSE),
      ('status', 'character varying(30)', TRUE),
      ('accepted_at', 'timestamp(6) with time zone', FALSE),
      ('task_id', 'integer', FALSE),
      ('metadata', 'jsonb', TRUE)
  )
  SELECT COUNT(*)::integer
    INTO canonical_handoff_column_count
    FROM expected_columns AS expected
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = handoff_relation.oid
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND attribute.attisdropped IS FALSE
     AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) =
           expected.formatted_type
     AND attribute.attnotnull = expected.is_not_null;

  IF canonical_handoff_column_count <> 21 THEN
    RAISE EXCEPTION
      'migration 586 blocked: care handoff columns are noncanonical'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = handoff_relation.oid
       AND attribute.attname = ANY(ARRAY[
         'request_reason',
         'request_fingerprint',
         'accepted_by_uid'
       ]::TEXT[])
       AND attribute.attnum > 0
       AND attribute.attisdropped IS FALSE
  ) THEN
    RAISE EXCEPTION
      'migration 586 blocked: care handoff owner-acceptance columns already exist outside the migration ledger'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)::integer
    INTO canonical_handoff_constraint_count
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = handoff_relation.oid
     AND constraint_row.conname = ANY(ARRAY[
       'care_handoff_status_check',
       'care_handoff_recipient_check',
       'care_handoff_receiving_tuple_check',
       'care_handoff_metadata_object'
     ]::TEXT[])
     AND constraint_row.contype = 'c'
     AND constraint_row.convalidated IS TRUE
     AND constraint_row.connoinherit IS FALSE;

  IF canonical_handoff_constraint_count <> 4 THEN
    RAISE EXCEPTION
      'migration 586 blocked: care handoff constraints are noncanonical'
      USING ERRCODE = '55000';
  END IF;

  SELECT function_row.proowner,
         function_row.prorettype,
         function_row.prokind,
         function_row.prosecdef,
         function_row.provolatile,
         function_row.prosrc,
         language_row.lanname
    INTO owner_assertion_function
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
   WHERE function_row.oid = pg_catalog.to_regprocedure(
     'public.care_pathway_assert_actionable_task_owner(uuid,integer)'
   );

  IF NOT FOUND
     OR owner_assertion_function.proowner <>
          (CURRENT_USER::pg_catalog.regrole)::pg_catalog.oid
     OR owner_assertion_function.prorettype <>
          pg_catalog.to_regtype('pg_catalog.void')
     OR owner_assertion_function.prokind <> 'f'
     OR owner_assertion_function.prosecdef IS DISTINCT FROM FALSE
     OR owner_assertion_function.provolatile <> 'v'
     OR owner_assertion_function.lanname <> 'plpgsql'
     OR pg_catalog.md5(
          pg_catalog.replace(owner_assertion_function.prosrc, CHR(13), '')
        ) <> '59915e01aefce768d69783a7a8f62611'
  THEN
    RAISE EXCEPTION
      'migration 586 blocked: actionable task owner assertion is noncanonical'
      USING ERRCODE = '55000';
  END IF;

  WITH expected_functions (function_name, normalized_body_md5) AS (
    VALUES
      ('care_pathway_task_owner_constraint',
       '7cc1fbb6f573f0c20aacfe9e603eb81f'),
      ('care_pathway_sla_owner_dependency_constraint',
       '95cf0041e9b8c3ee77dbc3cd2e41f5b8'),
      ('care_pathway_step_owner_dependency_constraint',
       'b1162d12ef0b9b9e73343391f2383fd5'),
      ('care_pathway_instance_owner_constraint',
       '7368fe03e87618a438e57cdcd78098ae'),
      ('care_pathway_live_owner_user_dependency_constraint',
       '96fe603f063f3ab10f54e585d86bd00a')
  )
  SELECT COUNT(*)::integer
    INTO owner_dependency_function_count
    FROM expected_functions AS expected
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.proname = expected.function_name
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = function_row.pronamespace
     AND namespace.nspname = 'public'
   WHERE function_row.proowner =
           (CURRENT_USER::pg_catalog.regrole)::pg_catalog.oid
     AND function_row.prorettype = pg_catalog.to_regtype('pg_catalog.trigger')
     AND function_row.prokind = 'f'
     AND function_row.prosecdef IS FALSE
     AND function_row.provolatile = 'v'
     AND pg_catalog.md5(
           pg_catalog.replace(function_row.prosrc, CHR(13), '')
         ) = expected.normalized_body_md5;

  IF owner_dependency_function_count <> 5 THEN
    RAISE EXCEPTION
      'migration 586 blocked: owner dependency functions differ from migration 585'
      USING ERRCODE = '55000';
  END IF;

  WITH expected_triggers (
    trigger_name,
    table_name,
    function_name,
    trigger_type
  ) AS (
    VALUES
      ('trg_tasks_exclusive_live_owner', 'tasks',
       'care_pathway_task_owner_constraint', 29),
      ('trg_workflow_sla_exclusive_live_owner', 'workflow_sla_instances',
       'care_pathway_sla_owner_dependency_constraint', 29),
      ('trg_workflow_steps_exclusive_live_owner_update', 'workflow_steps',
       'care_pathway_step_owner_dependency_constraint', 17),
      ('trg_workflow_steps_exclusive_live_owner_delete', 'workflow_steps',
       'care_pathway_step_owner_dependency_constraint', 9),
      ('trg_care_pathway_instances_exclusive_live_owner',
       'care_pathway_instances', 'care_pathway_instance_owner_constraint', 29),
      ('trg_users_exclusive_live_owner_delete', 'users',
       'care_pathway_live_owner_user_dependency_constraint', 9),
      ('trg_users_exclusive_live_owner_viability', 'users',
       'care_pathway_live_owner_user_dependency_constraint', 17)
  )
  SELECT COUNT(*)::integer
    INTO owner_dependency_trigger_count
    FROM expected_triggers AS expected
    JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgname = expected.trigger_name
     AND trigger_row.tgtype = expected.trigger_type
     AND trigger_row.tgisinternal IS FALSE
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = trigger_row.tgrelid
     AND table_row.relname = expected.table_name
    JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.oid = table_row.relnamespace
     AND table_namespace.nspname = 'public'
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = trigger_row.tgfoid
     AND function_row.proname = expected.function_name
    JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.oid = trigger_row.tgconstraint
   WHERE constraint_row.contype = 't'
     AND constraint_row.condeferrable IS TRUE
     AND constraint_row.condeferred IS TRUE;

  IF owner_dependency_trigger_count <> 7 THEN
    RAISE EXCEPTION
      'migration 586 blocked: deferred owner trigger set differs from migration 585'
      USING ERRCODE = '55000';
  END IF;

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
      'migration 586 blocked: patient access audit relation ownership or kind is noncanonical'
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
      'migration 586 blocked: patient access audit source column is noncanonical'
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
      'migration 586 blocked: patient access audit source constraint is noncanonical'
      USING ERRCODE = '55000';
  END IF;
END
$care_pathway_owner_acceptance_schema_preflight$;

LOCK TABLE users,
  workflow_sla_instances,
  workflow_steps,
  care_pathway_instances,
  tasks,
  care_handoff_instances,
  public.patient_access_audit_log
  IN ACCESS EXCLUSIVE MODE;

CREATE TEMPORARY TABLE care_pathway_owner_acceptance_source_probe (
  access_source VARCHAR(40) NOT NULL
) ON COMMIT DROP;

ALTER TABLE care_pathway_owner_acceptance_source_probe
  ADD CONSTRAINT care_pathway_owner_acceptance_source_probe_old
  CHECK (access_source IN (
    'role', 'care_team', 'clinical_authorship', 'appointment', 'admission',
    'guardian', 'break_glass', 'system', 'unknown', 'care_pathway_owner'
  )),
  ADD CONSTRAINT care_pathway_owner_acceptance_source_probe_new
  CHECK (access_source IN (
    'role', 'care_team', 'clinical_authorship', 'appointment', 'admission',
    'guardian', 'break_glass', 'system', 'unknown', 'care_pathway_owner',
    'care_pathway_transfer_recipient',
    'care_pathway_transfer_decline_recipient',
    'care_pathway_role_queue_claimant'
  ));

DO $care_pathway_owner_acceptance_audit_constraint_preflight$
DECLARE
  audit_expression TEXT;
  old_expression TEXT;
  new_expression TEXT;
BEGIN
  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO audit_expression
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
           'public.patient_access_audit_log'::pg_catalog.regclass
     AND constraint_row.conname =
           'patient_access_audit_log_access_source_check';

  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO old_expression
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
           'pg_temp.care_pathway_owner_acceptance_source_probe'::pg_catalog.regclass
     AND constraint_row.conname =
           'care_pathway_owner_acceptance_source_probe_old';

  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO new_expression
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
           'pg_temp.care_pathway_owner_acceptance_source_probe'::pg_catalog.regclass
     AND constraint_row.conname =
           'care_pathway_owner_acceptance_source_probe_new';

  IF audit_expression IS NULL
     OR audit_expression NOT IN (old_expression, new_expression)
  THEN
    RAISE EXCEPTION
      'migration 586 blocked: patient access audit source constraint expression is noncanonical'
      USING ERRCODE = '55000';
  END IF;
END
$care_pathway_owner_acceptance_audit_constraint_preflight$;

DROP TABLE care_pathway_owner_acceptance_source_probe;

CREATE TEMPORARY TABLE care_pathway_owner_acceptance_task_kind_probe (
  task_kind VARCHAR(60) NOT NULL
) ON COMMIT DROP;

ALTER TABLE care_pathway_owner_acceptance_task_kind_probe
  ADD CONSTRAINT care_pathway_owner_acceptance_task_kind_probe_old
  CHECK (task_kind IN (
    'general', 'follow_up', 'review', 'escalation', 'verification',
    'admin', 'consent', 'investigation', 'other'
  )),
  ADD CONSTRAINT care_pathway_owner_acceptance_task_kind_probe_new
  CHECK (task_kind IN (
    'general', 'follow_up', 'review', 'escalation', 'verification',
    'admin', 'consent', 'investigation', 'other',
    'pathway_owner_transfer_review'
  ));

DO $care_pathway_owner_acceptance_task_kind_preflight$
DECLARE
  task_constraint RECORD;
  task_constraint_found BOOLEAN := FALSE;
  task_kind_constraint_count INTEGER;
  old_expression TEXT;
  new_expression TEXT;
BEGIN
  SELECT constraint_row.contype,
         constraint_row.convalidated,
         constraint_row.connoinherit,
         pg_catalog.pg_get_expr(
           constraint_row.conbin,
           constraint_row.conrelid
         ) AS expression
    INTO task_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'public.tasks'::pg_catalog.regclass
     AND constraint_row.conname = 'tasks_task_kind_check';
  task_constraint_found := FOUND;

  SELECT COUNT(*)::integer
    INTO task_kind_constraint_count
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.conrelid
     AND attribute.attname = 'task_kind'
     AND attribute.attnum = ANY(constraint_row.conkey)
   WHERE constraint_row.conrelid = 'public.tasks'::pg_catalog.regclass
     AND constraint_row.contype = 'c';

  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO old_expression
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
           'pg_temp.care_pathway_owner_acceptance_task_kind_probe'::pg_catalog.regclass
     AND constraint_row.conname =
           'care_pathway_owner_acceptance_task_kind_probe_old';

  SELECT pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO new_expression
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
           'pg_temp.care_pathway_owner_acceptance_task_kind_probe'::pg_catalog.regclass
     AND constraint_row.conname =
           'care_pathway_owner_acceptance_task_kind_probe_new';

  IF task_kind_constraint_count <>
       (CASE WHEN task_constraint_found THEN 1 ELSE 0 END)
     OR (
       task_constraint_found
       AND (
         task_constraint.contype <> 'c'
         OR task_constraint.convalidated IS DISTINCT FROM TRUE
         OR task_constraint.connoinherit IS DISTINCT FROM FALSE
         OR task_constraint.expression IS NULL
         OR task_constraint.expression NOT IN (old_expression, new_expression)
       )
     )
  THEN
    RAISE EXCEPTION
      'migration 586 blocked: task kind constraint expression is noncanonical'
      USING ERRCODE = '55000';
  END IF;
END
$care_pathway_owner_acceptance_task_kind_preflight$;

DROP TABLE care_pathway_owner_acceptance_task_kind_probe;

DO $care_pathway_owner_acceptance_data_preflight$
DECLARE
  preexisting_covering_transfer_count INTEGER;
  invalid_task_kind_count INTEGER;
BEGIN
  SELECT COUNT(*)::integer
    INTO preexisting_covering_transfer_count
    FROM care_handoff_instances AS handoff
   WHERE handoff.handoff_type = 'covering_clinician_reassignment';

  IF preexisting_covering_transfer_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 586 blocked: covering-clinician transfer rows predate immutable request evidence (count=%s)',
        preexisting_covering_transfer_count
      ),
      HINT = 'Resolve each pre-existing request explicitly. The migration never infers request reason, fingerprint, accepting clinician, or task lifecycle evidence.';
  END IF;

  SELECT COUNT(*)::integer
    INTO invalid_task_kind_count
    FROM tasks AS task
   WHERE task.task_kind NOT IN (
     'general', 'follow_up', 'review', 'escalation', 'verification',
     'admin', 'consent', 'investigation', 'other',
     'pathway_owner_transfer_review'
   );

  IF invalid_task_kind_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = FORMAT(
        'migration 586 blocked: task kinds fall outside the canonical runtime contract (count=%s)',
        invalid_task_kind_count
      ),
      HINT = 'Reconcile each noncanonical task kind explicitly. The migration never rewrites historical task meaning.';
  END IF;
END
$care_pathway_owner_acceptance_data_preflight$;

ALTER TABLE public.patient_access_audit_log
  DROP CONSTRAINT patient_access_audit_log_access_source_check;

ALTER TABLE public.patient_access_audit_log
  ADD CONSTRAINT patient_access_audit_log_access_source_check
  CHECK (access_source IN (
    'role', 'care_team', 'clinical_authorship', 'appointment', 'admission',
    'guardian', 'break_glass', 'system', 'unknown', 'care_pathway_owner',
    'care_pathway_transfer_recipient',
    'care_pathway_transfer_decline_recipient',
    'care_pathway_role_queue_claimant'
  ));

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_task_kind_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_task_kind_check
  CHECK (task_kind IN (
    'general', 'follow_up', 'review', 'escalation', 'verification',
    'admin', 'consent', 'investigation', 'other',
    'pathway_owner_transfer_review'
  ));

-- Actionable tasks move with the live owner, but a completed SLA remains an
-- immutable historical receipt for the clinician or queue that owned its
-- clock. Migration 585 enforced task/SLA equality even after SLA completion;
-- retain every task-owner guard while narrowing only that pathway SLA branch.
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
    IF is_pathway_task
       AND obligation.sla_completed_at IS NULL
       AND obligation.sla_status IN ('active', 'breached', 'escalated')
       AND (
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

ALTER TABLE care_handoff_instances
  ADD COLUMN request_reason TEXT,
  ADD COLUMN request_fingerprint CHAR(64),
  ADD COLUMN accepted_by_uid UUID;

ALTER TABLE care_handoff_instances
  ADD CONSTRAINT fk_care_handoff_accepted_by_tenant
  FOREIGN KEY (tenant_id, accepted_by_uid)
  REFERENCES users (tenant_id, uid)
  ON UPDATE NO ACTION
  ON DELETE NO ACTION;

ALTER TABLE care_handoff_instances
  ADD CONSTRAINT care_handoff_covering_transfer_check
  CHECK (
    handoff_type <> 'covering_clinician_reassignment'
    OR (
      sender_uid IS NOT NULL
      AND sender_system_key IS NULL
      AND recipient_kind = 'user'
      AND intended_recipient_uid IS NOT NULL
      AND intended_recipient_uid IS DISTINCT FROM sender_uid
      AND receiving_pathway_instance_id IS NOT NULL
      AND receiving_workflow_run_id IS NOT NULL
      AND receiving_step_key IS NOT NULL
      AND receiving_pathway_instance_id = sending_pathway_instance_id
      AND receiving_workflow_run_id = sending_workflow_run_id
      AND receiving_step_key = sending_step_key
      AND source_resource_type = 'care_pathway_instance'
      AND source_resource_id = sending_pathway_instance_id::TEXT
      AND policy_due_at IS NULL
      AND urgency_code = 'not_applicable'
      AND task_id IS NOT NULL
      AND NULLIF(BTRIM(request_reason), '') IS NOT NULL
      AND request_fingerprint IS NOT NULL
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND status IN ('requested', 'accepted', 'declined', 'cancelled')
      AND (
        (
          status = 'accepted'
          AND accepted_at IS NOT NULL
          AND accepted_by_uid IS NOT NULL
          AND accepted_by_uid = intended_recipient_uid
        )
        OR
        (
          status <> 'accepted'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
        )
      )
    )
  );

CREATE UNIQUE INDEX ux_care_handoff_one_live_covering_transfer
  ON care_handoff_instances (
    tenant_id,
    sending_pathway_instance_id,
    (
      CASE
        WHEN handoff_type = 'covering_clinician_reassignment'
         AND status = 'requested'
          THEN 'requested'
        ELSE id::TEXT
      END
    )
  );

CREATE INDEX idx_care_handoff_covering_recipient
  ON care_handoff_instances (
    tenant_id, intended_recipient_uid, status, requested_at DESC
  )
  WHERE handoff_type = 'covering_clinician_reassignment'
    AND intended_recipient_uid IS NOT NULL
    AND status = 'requested';

CREATE INDEX idx_care_handoff_accepted_by
  ON care_handoff_instances (tenant_id, accepted_by_uid, accepted_at DESC)
  WHERE accepted_by_uid IS NOT NULL;

CREATE OR REPLACE FUNCTION care_pathway_assert_covering_transfer(
  target_tenant_id UUID,
  target_handoff_id UUID,
  enforce_decision_owner BOOLEAN DEFAULT TRUE
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
         handoff.acknowledged_at,
         handoff.declined_at,
         handoff.decline_reason,
         handoff.reroute_reason,
         handoff.cancelled_at,
         handoff.cancellation_reason,
         handoff.completed_at AS handoff_completed_at,
         handoff.originator_closed_at,
         pathway.id AS pathway_id,
         pathway.clinical_status AS pathway_status,
         pathway.owning_clinician_uid AS pathway_owner_uid,
         task.id AS bound_task_id,
         task.task_kind AS task_kind,
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
         task.sla_breached_at AS task_sla_breached_at
    INTO transfer
    FROM care_handoff_instances AS handoff
    LEFT JOIN care_pathway_instances AS pathway
      ON pathway.tenant_id = handoff.tenant_id
     AND pathway.id = handoff.sending_pathway_instance_id
     AND pathway.patient_uid = handoff.patient_uid
     AND pathway.workflow_run_id = handoff.sending_workflow_run_id
    LEFT JOIN tasks AS task
      ON task.tenant_id = handoff.tenant_id
     AND task.id = handoff.task_id
   WHERE handoff.tenant_id = target_tenant_id
     AND handoff.id = target_handoff_id
     AND handoff.handoff_type = 'covering_clinician_reassignment';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF transfer.pathway_id IS NULL OR transfer.bound_task_id IS NULL THEN
    RAISE EXCEPTION
      'covering-clinician transfer requires its exact pathway and review task'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.task_kind <> 'pathway_owner_transfer_review'
     OR transfer.task_patient_uid IS DISTINCT FROM transfer.patient_uid
     OR transfer.task_workflow_run_id IS NOT NULL
     OR transfer.task_workflow_step_id IS NOT NULL
     OR transfer.task_resource_type IS DISTINCT FROM 'care_handoff_instance'
     OR transfer.task_resource_id IS DISTINCT FROM transfer.id::TEXT
     OR transfer.task_owner_uid IS DISTINCT FROM
          transfer.intended_recipient_uid
     OR transfer.task_owner_role IS NOT NULL
     OR transfer.task_due_at IS NOT NULL
     OR transfer.task_sla_definition_id IS NOT NULL
     OR transfer.task_sla_instance_id IS NOT NULL
     OR transfer.task_sla_completion_semantics <> 'none'
     OR transfer.task_sla_breached_at IS NOT NULL
  THEN
    RAISE EXCEPTION
      'covering-clinician transfer review task binding is noncanonical'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.acknowledged_at IS NOT NULL
     OR transfer.reroute_reason IS NOT NULL
     OR transfer.handoff_completed_at IS NOT NULL
     OR transfer.originator_closed_at IS NOT NULL
  THEN
    RAISE EXCEPTION
      'covering-clinician transfer contains evidence from an unsupported handoff lifecycle'
      USING ERRCODE = 'check_violation';
  END IF;

  IF transfer.handoff_status = 'requested' THEN
    IF transfer.pathway_status NOT IN ('planned', 'active', 'on_hold')
       OR transfer.pathway_owner_uid IS DISTINCT FROM transfer.sender_uid
       OR transfer.task_status NOT IN ('open', 'in_progress', 'blocked', 'overdue')
       OR transfer.task_completed_at IS NOT NULL
       OR transfer.task_cancelled_at IS NOT NULL
       OR transfer.task_cancellation_reason IS NOT NULL
       OR transfer.accepted_at IS NOT NULL
       OR transfer.accepted_by_uid IS NOT NULL
       OR transfer.declined_at IS NOT NULL
       OR transfer.decline_reason IS NOT NULL
       OR transfer.cancelled_at IS NOT NULL
       OR transfer.cancellation_reason IS NOT NULL
    THEN
      RAISE EXCEPTION
        'requested covering-clinician transfer requires the sender to remain owner and the recipient review task to remain actionable'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transfer.handoff_status = 'accepted' THEN
    IF (
         enforce_decision_owner
         AND (
           transfer.pathway_status NOT IN ('planned', 'active', 'on_hold')
           OR transfer.pathway_owner_uid IS DISTINCT FROM
                transfer.intended_recipient_uid
         )
       )
       OR transfer.accepted_by_uid IS DISTINCT FROM
            transfer.intended_recipient_uid
       OR transfer.accepted_at IS NULL
       OR transfer.accepted_at < transfer.requested_at
       OR transfer.declined_at IS NOT NULL
       OR transfer.decline_reason IS NOT NULL
       OR transfer.cancelled_at IS NOT NULL
       OR transfer.cancellation_reason IS NOT NULL
       OR transfer.task_status <> 'completed'
       OR transfer.task_completed_at IS NULL
       OR transfer.task_completed_at < transfer.requested_at
       OR transfer.task_cancelled_at IS NOT NULL
       OR transfer.task_cancellation_reason IS NOT NULL
    THEN
      RAISE EXCEPTION
        'accepted covering-clinician transfer requires the intended recipient owner and completed review task'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF transfer.handoff_status IN ('declined', 'cancelled') THEN
    IF (
         enforce_decision_owner
         AND transfer.pathway_owner_uid IS DISTINCT FROM transfer.sender_uid
       )
       OR transfer.task_status <> 'cancelled'
       OR transfer.task_completed_at IS NOT NULL
       OR transfer.task_cancelled_at IS NULL
       OR transfer.task_cancelled_at < transfer.requested_at
       OR NULLIF(BTRIM(transfer.task_cancellation_reason), '') IS NULL
       OR (
         transfer.handoff_status = 'declined'
         AND (
           transfer.declined_at IS NULL
           OR transfer.declined_at < transfer.requested_at
           OR transfer.task_cancellation_reason IS DISTINCT FROM
                transfer.decline_reason
           OR transfer.cancelled_at IS NOT NULL
           OR transfer.cancellation_reason IS NOT NULL
         )
       )
       OR (
         transfer.handoff_status = 'cancelled'
         AND (
           transfer.cancelled_at IS NULL
           OR transfer.cancelled_at < transfer.requested_at
           OR transfer.task_cancellation_reason IS DISTINCT FROM
                transfer.cancellation_reason
           OR transfer.declined_at IS NOT NULL
           OR transfer.decline_reason IS NOT NULL
         )
       )
    THEN
      RAISE EXCEPTION
        'closed covering-clinician transfer requires the sender owner and an exactly reasoned cancelled review task'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION
      'covering-clinician transfer status is noncanonical'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_block_covering_transfer_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.handoff_type = 'covering_clinician_reassignment'
       AND NEW.status <> 'requested'
    THEN
      RAISE EXCEPTION
        'covering-clinician transfer must begin as a request'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.handoff_type = 'covering_clinician_reassignment' THEN
      RAISE EXCEPTION
        'covering-clinician transfer evidence is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.handoff_type <> 'covering_clinician_reassignment'
     AND NEW.handoff_type = 'covering_clinician_reassignment'
  THEN
    RAISE EXCEPTION
      'covering-clinician transfer evidence must be created atomically'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.handoff_type = 'covering_clinician_reassignment' THEN
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
         OLD.requested_at
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
         NEW.requested_at
       )
    THEN
      RAISE EXCEPTION
        'covering-clinician transfer request evidence is immutable'
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
        'decided covering-clinician transfer evidence is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_care_handoff_covering_transfer_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON care_handoff_instances
  FOR EACH ROW EXECUTE FUNCTION care_pathway_block_covering_transfer_mutation();

CREATE OR REPLACE FUNCTION care_pathway_covering_transfer_row_constraint()
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
    PERFORM care_pathway_assert_covering_transfer(
      NEW.tenant_id,
      NEW.id,
      enforce_owner
    );
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.id IS DISTINCT FROM NEW.id
     )
  THEN
    PERFORM care_pathway_assert_covering_transfer(OLD.tenant_id, OLD.id, TRUE);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_handoff_covering_transfer_invariant
  AFTER INSERT OR UPDATE OR DELETE ON care_handoff_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_covering_transfer_row_constraint();

CREATE OR REPLACE FUNCTION care_pathway_covering_transfer_pathway_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM care_pathway_assert_covering_transfer(
      handoff.tenant_id,
      handoff.id,
      TRUE
    )
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.sending_pathway_instance_id = NEW.id
       AND handoff.handoff_type = 'covering_clinician_reassignment'
       AND handoff.status = 'requested';
  END IF;

  IF TG_OP <> 'INSERT'
     AND (
       TG_OP = 'DELETE'
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.id IS DISTINCT FROM NEW.id
     )
  THEN
    PERFORM care_pathway_assert_covering_transfer(
      handoff.tenant_id,
      handoff.id,
      TRUE
    )
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = OLD.tenant_id
       AND handoff.sending_pathway_instance_id = OLD.id
       AND handoff.handoff_type = 'covering_clinician_reassignment'
       AND handoff.status = 'requested';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_pathway_instances_covering_transfer_dependency
  AFTER INSERT OR UPDATE OR DELETE ON care_pathway_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_covering_transfer_pathway_dependency();

CREATE OR REPLACE FUNCTION care_pathway_covering_transfer_task_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM care_pathway_assert_covering_transfer(
      handoff.tenant_id,
      handoff.id,
      handoff.status = 'requested'
    )
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = NEW.tenant_id
       AND handoff.task_id = NEW.id
       AND handoff.handoff_type = 'covering_clinician_reassignment';
  END IF;

  IF TG_OP <> 'INSERT'
     AND (
       TG_OP = 'DELETE'
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.id IS DISTINCT FROM NEW.id
     )
  THEN
    PERFORM care_pathway_assert_covering_transfer(
      handoff.tenant_id,
      handoff.id,
      handoff.status = 'requested'
    )
      FROM care_handoff_instances AS handoff
     WHERE handoff.tenant_id = OLD.tenant_id
       AND handoff.task_id = OLD.id
       AND handoff.handoff_type = 'covering_clinician_reassignment';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_covering_transfer_dependency
  AFTER INSERT OR UPDATE OR DELETE ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_covering_transfer_task_dependency();

DO $care_pathway_owner_acceptance_postflight$
BEGIN
  PERFORM care_pathway_assert_covering_transfer(
    handoff.tenant_id,
    handoff.id,
    TRUE
  )
    FROM care_handoff_instances AS handoff
   WHERE handoff.handoff_type = 'covering_clinician_reassignment';
END
$care_pathway_owner_acceptance_postflight$;

COMMIT;
