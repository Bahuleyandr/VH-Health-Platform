#!/usr/bin/env node
// Read-only evidence for migration 585's exclusive live-owner contract.
//
// Migration 580's original readiness tool must keep working before the pathway
// tables exist. This separate audit therefore requires the post-584 substrate,
// verifies pre/post-585 tracker coherence, and never claims pathway activation.

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

export const ACKNOWLEDGEMENT_FLAG = '--ack-read-only-primary-scan';
export const DEFAULT_SAMPLE_LIMIT = 5;
export const MAX_SAMPLE_LIMIT = 25;
export const BLOCKED_EXIT_CODE = 2;
export const TARGET_MIGRATION = '585_care_pathway_exclusive_owner_integrity.sql';
export const PREREQUISITE_MIGRATIONS = Object.freeze([
  '580_care_pathway_execution_spine.sql',
  '581_lab_critical_alert_generations.sql',
  '582_lab_oru_replay_idempotency.sql',
  '583_lab_astm_atomic_replay.sql',
  '584_care_pathway_governance_pinning.sql',
]);

export const BEGIN_READ_ONLY_QUERY =
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';
export const COMMIT_QUERY = 'COMMIT';
export const ROLLBACK_QUERY = 'ROLLBACK';

export const READ_ONLY_CHECK_QUERY = `
  SELECT current_setting('transaction_read_only') AS transaction_read_only,
         current_setting('transaction_isolation') AS transaction_isolation,
         pg_is_in_recovery() AS pg_is_in_recovery,
         current_user AS audit_user,
         role.rolsuper AS audit_user_is_superuser,
         role.rolbypassrls AS audit_user_bypasses_rls
    FROM pg_roles AS role
   WHERE role.rolname = current_user
`;

export const TENANT_INVENTORY_QUERY = `
  SELECT tenant.id AS tenant_id
    FROM tenants AS tenant
   ORDER BY tenant.id
`;

const TRACKED_MIGRATIONS = [...PREREQUISITE_MIGRATIONS, TARGET_MIGRATION];
const TRACKED_MIGRATIONS_SQL = TRACKED_MIGRATIONS
  .map(name => `'${name}'`)
  .join(', ');

export const MIGRATION_TRACKER_QUERY = `
  SELECT migration.name
    FROM _migrations AS migration
   WHERE migration.name IN (${TRACKED_MIGRATIONS_SQL})
   ORDER BY migration.name
`;

export const SCHEMA_STATE_QUERY = `
  SELECT to_regclass('public.care_pathway_instances') IS NOT NULL
           AS pathway_instance_table_exists,
         to_regclass('public.tasks') IS NOT NULL AS tasks_table_exists,
         to_regclass('public.workflow_sla_instances') IS NOT NULL
           AS workflow_sla_table_exists,
         to_regclass('public.workflow_steps') IS NOT NULL
           AS workflow_steps_table_exists,
         to_regprocedure(
           'public.care_pathway_is_route_actionable_human_role(text,text)'
         ) IS NOT NULL AS route_role_function_exists,
         to_regprocedure('public.care_pathway_assert_run_companion(integer)') IS NOT NULL
           AS governance_pin_function_exists,
         (
           SELECT COUNT(*)::integer
             FROM information_schema.columns AS column_state
            WHERE column_state.table_schema = 'public'
              AND (
                (column_state.table_name = 'tasks'
                 AND column_state.column_name IN (
                   'workflow_run_id', 'workflow_sla_instance_id',
                   'sla_completion_semantics', 'assigned_to_uid',
                   'assigned_to_role', 'status'
                 ))
                OR
                (column_state.table_name = 'workflow_sla_instances'
                 AND column_state.column_name IN (
                   'assigned_user_uid', 'assigned_role_codes', 'rule_code',
                   'status', 'completed_at'
                 ))
                OR
                (column_state.table_name = 'workflow_steps'
                 AND column_state.column_name IN (
                   'tenant_id', 'id', 'workflow_run_id', 'assigned_role'
                 ))
                OR
                (column_state.table_name = 'care_pathway_instances'
                 AND column_state.column_name IN (
                   'workflow_run_id', 'owning_clinician_uid',
                   'accountable_role', 'clinical_status',
                   'workflow_definition_id', 'definition_governance_id',
                   'definition_checksum'
                 ))
                OR
                (column_state.table_name = 'workflow_runs'
                 AND column_state.column_name IN (
                   'pathway_governance_id', 'pathway_definition_checksum'
                 ))
                OR
                (column_state.table_name = 'users'
                 AND column_state.column_name IN (
                   'is_active', 'status', 'is_deleted', 'deleted_at', 'role'
                 ))
              )
         ) AS prerequisite_column_count,
         (
           SELECT COUNT(*)::integer
             FROM pg_proc AS function_state
            WHERE function_state.oid = ANY(ARRAY[
              to_regprocedure(
                'public.care_pathway_named_owner_is_viable(uuid,uuid,text)'
              ),
              to_regprocedure(
                'public.care_pathway_clinical_accountability_roles()'
              ),
              to_regprocedure(
                'public.care_pathway_named_clinician_is_viable(uuid,uuid)'
              ),
              to_regprocedure(
                'public.care_pathway_task_owner_is_exclusive_and_viable(uuid,uuid,text,text)'
              ),
              to_regprocedure(
                'public.care_pathway_task_sla_owner_agrees(uuid,text,uuid,text[],text)'
              ),
              to_regprocedure(
                'public.care_pathway_assert_live_instance_owner(uuid,uuid)'
              ),
              to_regprocedure(
                'public.care_pathway_assert_actionable_task_owner(uuid,integer)'
              ),
              to_regprocedure('public.care_pathway_task_owner_constraint()'),
              to_regprocedure(
                'public.care_pathway_sla_owner_dependency_constraint()'
              ),
              to_regprocedure('public.care_pathway_instance_owner_constraint()'),
              to_regprocedure(
                'public.care_pathway_live_owner_user_dependency_constraint()'
              ),
              to_regprocedure(
                'public.care_pathway_step_owner_dependency_constraint()'
              )
            ]::oid[])
         ) AS owner_function_count,
         (
           SELECT COUNT(DISTINCT trigger_state.tgname)::integer
             FROM pg_trigger AS trigger_state
            WHERE NOT trigger_state.tgisinternal
              AND trigger_state.tgname IN (
                'trg_tasks_exclusive_live_owner',
                'trg_workflow_sla_exclusive_live_owner',
                'trg_care_pathway_instances_exclusive_live_owner',
                'trg_users_exclusive_live_owner_delete',
                'trg_users_exclusive_live_owner_viability',
                'trg_workflow_steps_exclusive_live_owner_update',
                'trg_workflow_steps_exclusive_live_owner_delete'
              )
         ) AS owner_trigger_count,
         (
           SELECT COUNT(*)::integer
             FROM pg_constraint AS constraint_state
            WHERE constraint_state.conname = 'fk_care_pathway_instances_owner_tenant'
              AND constraint_state.conrelid =
                    to_regclass('public.care_pathway_instances')
              AND constraint_state.contype = 'f'
              AND constraint_state.condeferrable
              AND constraint_state.condeferred
              AND constraint_state.confdeltype = 'a'
         ) AS deferred_owner_fk_count,
         COALESCE((
           SELECT constraint_state.contype = 'c'
              AND constraint_state.convalidated
              AND NOT constraint_state.connoinherit
              AND pg_get_expr(
                    constraint_state.conbin,
                    constraint_state.conrelid
                  ) = $$((access_source)::text = ANY ((ARRAY['role'::character varying, 'care_team'::character varying, 'clinical_authorship'::character varying, 'appointment'::character varying, 'admission'::character varying, 'guardian'::character varying, 'break_glass'::character varying, 'system'::character varying, 'unknown'::character varying])::text[]))$$
             FROM pg_constraint AS constraint_state
            WHERE constraint_state.conrelid =
                    to_regclass('public.patient_access_audit_log')
              AND constraint_state.conname =
                    'patient_access_audit_log_access_source_check'
         ), FALSE) AS patient_access_audit_source_is_pre_585,
         COALESCE((
           SELECT constraint_state.contype = 'c'
              AND constraint_state.convalidated
              AND NOT constraint_state.connoinherit
              AND pg_get_expr(
                    constraint_state.conbin,
                    constraint_state.conrelid
                  ) = $$((access_source)::text = ANY ((ARRAY['role'::character varying, 'care_team'::character varying, 'clinical_authorship'::character varying, 'appointment'::character varying, 'admission'::character varying, 'guardian'::character varying, 'break_glass'::character varying, 'system'::character varying, 'unknown'::character varying, 'care_pathway_owner'::character varying])::text[]))$$
             FROM pg_constraint AS constraint_state
            WHERE constraint_state.conrelid =
                    to_regclass('public.patient_access_audit_log')
              AND constraint_state.conname =
                    'patient_access_audit_log_access_source_check'
         ), FALSE) AS patient_access_audit_source_is_post_585
`;

export const OWNER_ISSUE_KEYS = Object.freeze([
  'task_owner_dual_assignment',
  'task_owner_missing_assignment',
  'pathway_task_owner_invalid',
  'human_sla_task_owner_invalid',
  'pathway_task_owner_source_mismatch',
  'task_sla_owner_mismatch',
  'pathway_instance_owner_invalid',
]);

export const CLINICAL_ACCOUNTABILITY_ROLE_CODES = Object.freeze([
  'DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT', 'DUTY_DOCTOR',
  'NURSING_STAFF', 'NURSING_INCHARGE', 'OP_STAFF_NURSE', 'OP_INCHARGE',
  'IP_STAFF_NURSE', 'IP_INCHARGE', 'OT_NURSE', 'OT_INCHARGE',
  'CATH_LAB_STAFF', 'CATH_LAB_INCHARGE', 'RADIOLOGIST', 'ANESTHETIST',
  'PHYSIOTHERAPIST', 'DIETITIAN', 'COUNSELLOR', 'SENIOR_DOCTOR',
  'ANAESTHETIST', 'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'ER_STAFF',
  'DIALYSIS_TECHNICIAN', 'RADIOLOGY_STAFF', 'PATHOLOGIST', 'LAB_INCHARGE',
  'BLOOD_BANK_STAFF', 'BLOOD_BANK_TECHNICIAN',
]);
const CLINICAL_ACCOUNTABILITY_ROLES_SQL = `ARRAY[
  ${CLINICAL_ACCOUNTABILITY_ROLE_CODES.map(role => `'${role}'`).join(', ')}
]::TEXT[]`;

export const LEGACY_EMPTY_SLA_OWNER_RULE_CODES = Object.freeze([
  'critical_result_ack',
  'mortuary_unclaimed_body',
]);
const LEGACY_EMPTY_SLA_OWNER_RULES_SQL = LEGACY_EMPTY_SLA_OWNER_RULE_CODES
  .map(ruleCode => `'${ruleCode}'`)
  .join(', ');

export const OWNER_REPORT_QUERY = `
  WITH guarded_tasks AS (
    SELECT task.id AS task_id,
           task.tenant_id,
           task.status AS task_status,
           task.assigned_to_uid,
           task.assigned_to_role,
           task.sla_completion_semantics,
           task.workflow_step_id,
           pathway.id AS pathway_instance_id,
           pathway.owning_clinician_uid AS pathway_owner_uid,
           COALESCE(
             NULLIF(BTRIM(step.assigned_role), ''),
             NULLIF(BTRIM(pathway.accountable_role), '')
           ) AS resolved_stage_role,
           sla.id AS sla_id,
           sla.rule_code,
           sla.status AS sla_status,
           sla.completed_at AS sla_completed_at,
           sla.assigned_user_uid AS sla_owner_uid,
           sla.assigned_role_codes AS sla_owner_roles,
           pathway.id IS NOT NULL AS is_pathway_task,
           COALESCE(NULLIF(BTRIM(sla.rule_code), ''), 'care_pathway_stage')
             AS obligation_rule_code
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
  ), assessed_tasks AS (
    SELECT guarded.task_id,
           guarded.tenant_id,
           guarded.task_status,
           guarded.rule_code,
           guarded.sla_status,
           guarded.is_pathway_task,
           guarded.assigned_to_uid IS NOT NULL
             AND guarded.assigned_to_role IS NOT NULL AS is_dual_assignment,
           guarded.assigned_to_uid IS NULL
             AND NULLIF(BTRIM(guarded.assigned_to_role), '') IS NULL
             AS is_missing_assignment,
           CASE
             WHEN guarded.assigned_to_uid IS NOT NULL THEN
               guarded.assigned_to_role IS NULL
               AND EXISTS (
                 SELECT 1
                   FROM users AS owner
                  WHERE owner.tenant_id = guarded.tenant_id
                    AND owner.uid = guarded.assigned_to_uid
                    AND owner.is_active = TRUE
                    AND LOWER(COALESCE(owner.status, '')) = 'active'
                    AND owner.is_deleted IS FALSE
                    AND owner.deleted_at IS NULL
                    AND (
                      (
                        guarded.is_pathway_task
                        AND UPPER(BTRIM(owner.role)) = ANY(
                              ${CLINICAL_ACCOUNTABILITY_ROLES_SQL}
                            )
                      )
                      OR (
                        NOT guarded.is_pathway_task
                        AND care_pathway_is_route_actionable_human_role(
                              owner.role,
                              guarded.obligation_rule_code
                            )
                      )
                    )
               )
             ELSE
               NULLIF(BTRIM(guarded.assigned_to_role), '') IS NOT NULL
               AND care_pathway_is_route_actionable_human_role(
                     guarded.assigned_to_role,
                     guarded.obligation_rule_code
                   )
           END AS has_valid_exclusive_owner,
           CASE
             WHEN NOT guarded.is_pathway_task THEN TRUE
             WHEN guarded.pathway_owner_uid IS NOT NULL THEN
               guarded.assigned_to_uid IS NOT DISTINCT FROM guarded.pathway_owner_uid
               AND guarded.assigned_to_role IS NULL
             ELSE
               guarded.assigned_to_uid IS NULL
               AND NULLIF(BTRIM(guarded.assigned_to_role), '') IS NOT NULL
               AND UPPER(BTRIM(guarded.assigned_to_role)) IS NOT DISTINCT FROM
                     UPPER(BTRIM(guarded.resolved_stage_role))
           END AS matches_pathway_source,
           CASE
             WHEN guarded.sla_id IS NULL THEN TRUE
             WHEN guarded.is_pathway_task
                  AND guarded.assigned_to_uid IS NOT NULL THEN
               guarded.sla_owner_uid IS NOT DISTINCT FROM guarded.assigned_to_uid
               AND CARDINALITY(
                     COALESCE(guarded.sla_owner_roles, ARRAY[]::TEXT[])
                   ) = 0
               AND guarded.assigned_to_role IS NULL
             WHEN guarded.is_pathway_task THEN
               guarded.assigned_to_uid IS NULL
               AND guarded.sla_owner_uid IS NULL
               AND NULLIF(BTRIM(guarded.assigned_to_role), '') IS NOT NULL
               AND CARDINALITY(
                     COALESCE(guarded.sla_owner_roles, ARRAY[]::TEXT[])
                   ) = 1
               AND UPPER(BTRIM(guarded.assigned_to_role)) IS NOT DISTINCT FROM
                     UPPER(BTRIM(guarded.sla_owner_roles[1]))
               AND care_pathway_is_route_actionable_human_role(
                     guarded.sla_owner_roles[1],
                     guarded.obligation_rule_code
                   )
             WHEN guarded.sla_owner_uid IS NULL
                  AND CARDINALITY(
                        COALESCE(guarded.sla_owner_roles, ARRAY[]::TEXT[])
                      ) = 0
               THEN NOT guarded.is_pathway_task
                    AND guarded.obligation_rule_code IN (
                      ${LEGACY_EMPTY_SLA_OWNER_RULES_SQL}
                    )
             WHEN guarded.sla_owner_uid IS NOT NULL THEN
               CARDINALITY(
                 COALESCE(guarded.sla_owner_roles, ARRAY[]::TEXT[])
               ) = 0
               AND guarded.assigned_to_uid = guarded.sla_owner_uid
               AND guarded.assigned_to_role IS NULL
             ELSE
               guarded.assigned_to_uid IS NULL
               AND NULLIF(BTRIM(guarded.assigned_to_role), '') IS NOT NULL
               AND UPPER(BTRIM(guarded.assigned_to_role)) = ANY(
                     COALESCE(guarded.sla_owner_roles, ARRAY[]::TEXT[])
                   )
               AND NOT EXISTS (
                 SELECT 1
                   FROM UNNEST(
                          COALESCE(guarded.sla_owner_roles, ARRAY[]::TEXT[])
                        ) AS sla_role(role_code)
                  WHERE NOT care_pathway_is_route_actionable_human_role(
                              sla_role.role_code,
                              guarded.obligation_rule_code
                            )
               )
           END AS matches_sla_owner
      FROM guarded_tasks AS guarded
  ), task_findings AS (
    SELECT assessed.tenant_id,
           issue.issue_key,
           assessed.tenant_id::text || ':task:' || assessed.task_id::text
             AS evidence_seed,
           assessed.rule_code,
           assessed.task_status,
           assessed.sla_status,
           issue.detail
      FROM assessed_tasks AS assessed
      CROSS JOIN LATERAL (
        VALUES
          (
            'task_owner_dual_assignment'::text,
            assessed.is_dual_assignment,
            'uid_and_role_are_both_populated'::text
          ),
          (
            'task_owner_missing_assignment'::text,
            assessed.is_missing_assignment,
            'uid_and_route_role_are_both_absent'::text
          ),
          (
            'pathway_task_owner_invalid'::text,
            assessed.is_pathway_task AND NOT assessed.has_valid_exclusive_owner,
            'pathway_task_owner_is_not_current_route_actionable_and_exclusive'::text
          ),
          (
            'human_sla_task_owner_invalid'::text,
            NOT assessed.is_pathway_task AND NOT assessed.has_valid_exclusive_owner,
            'human_sla_task_owner_is_not_current_route_actionable_and_exclusive'::text
          ),
          (
            'pathway_task_owner_source_mismatch'::text,
            assessed.is_pathway_task AND NOT assessed.matches_pathway_source,
            'task_owner_does_not_match_pathway_named_source'::text
          ),
          (
            'task_sla_owner_mismatch'::text,
            NOT assessed.matches_sla_owner,
            'task_and_sla_owner_declarations_do_not_agree'::text
          )
      ) AS issue(issue_key, is_blocker, detail)
     WHERE issue.is_blocker
  ), instance_findings AS (
    SELECT pathway.tenant_id,
           'pathway_instance_owner_invalid'::text AS issue_key,
           pathway.tenant_id::text || ':pathway-instance:' || pathway.id::text
             AS evidence_seed,
           'care_pathway_stage'::text AS rule_code,
           pathway.clinical_status AS task_status,
           NULL::text AS sla_status,
           'live_pathway_owner_or_accountable_role_is_not_route_capable'::text AS detail
      FROM care_pathway_instances AS pathway
     WHERE pathway.clinical_status IN ('planned', 'active', 'on_hold')
       AND (
         NOT care_pathway_is_route_actionable_human_role(
               pathway.accountable_role,
               'care_pathway_stage'
             )
         OR (
           pathway.owning_clinician_uid IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM users AS owner
              WHERE owner.tenant_id = pathway.tenant_id
                AND owner.uid = pathway.owning_clinician_uid
                AND owner.is_active = TRUE
                AND LOWER(COALESCE(owner.status, '')) = 'active'
                AND owner.is_deleted IS FALSE
                AND owner.deleted_at IS NULL
                AND UPPER(BTRIM(owner.role)) = ANY(
                      ${CLINICAL_ACCOUNTABILITY_ROLES_SQL}
                    )
           )
         )
       )
  ), findings AS (
    SELECT task_finding.tenant_id,
           task_finding.issue_key,
           task_finding.evidence_seed,
           task_finding.rule_code,
           task_finding.task_status,
           task_finding.sla_status,
           task_finding.detail
      FROM task_findings AS task_finding
    UNION ALL
    SELECT instance_finding.tenant_id,
           instance_finding.issue_key,
           instance_finding.evidence_seed,
           instance_finding.rule_code,
           instance_finding.task_status,
           instance_finding.sla_status,
           instance_finding.detail
      FROM instance_findings AS instance_finding
  ), ranked AS (
    SELECT finding.tenant_id,
           finding.issue_key,
           finding.evidence_seed,
           finding.rule_code,
           finding.task_status,
           finding.sla_status,
           finding.detail,
           COUNT(*) OVER (
             PARTITION BY finding.tenant_id, finding.issue_key
           )::bigint AS total_count,
           ROW_NUMBER() OVER (
             PARTITION BY finding.tenant_id, finding.issue_key
             ORDER BY finding.evidence_seed
           ) AS sample_rank
      FROM findings AS finding
  )
  SELECT ranked.tenant_id,
         ranked.issue_key,
         ranked.total_count,
         ranked.sample_rank,
         SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16)
           AS evidence_fingerprint,
         ranked.rule_code,
         ranked.task_status,
         ranked.sla_status,
         ranked.detail
    FROM ranked
   WHERE ranked.sample_rank <= $1::integer
   ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
`;

const SAFE_SAMPLE_FIELDS = Object.freeze([
  'evidence_fingerprint',
  'rule_code',
  'task_status',
  'sla_status',
  'detail',
]);

function pgBooleanIsTrue(value) {
  return value === true || value === 'true' || value === 't' || value === '1'
    || value === 'on';
}

function pgBooleanIsFalse(value) {
  return value === false || value === 'false' || value === 'f' || value === '0'
    || value === 'off';
}

function asCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return count;
}

export function ownerSchemaModeFromState(schemaState = {}) {
  const prerequisitesReady = [
    schemaState.pathway_instance_table_exists,
    schemaState.tasks_table_exists,
    schemaState.workflow_sla_table_exists,
    schemaState.workflow_steps_table_exists,
    schemaState.route_role_function_exists,
    schemaState.governance_pin_function_exists,
  ].every(pgBooleanIsTrue)
    && asCount(schemaState.prerequisite_column_count ?? 0, 'prerequisite_column_count') === 29;
  if (!prerequisitesReady) return 'prerequisites_missing_or_partial';

  const functionCount = asCount(schemaState.owner_function_count ?? 0, 'owner_function_count');
  const triggerCount = asCount(schemaState.owner_trigger_count ?? 0, 'owner_trigger_count');
  const ownerFkCount = asCount(
    schemaState.deferred_owner_fk_count ?? 0,
    'deferred_owner_fk_count',
  );
  const pre585AuditSource = pgBooleanIsTrue(
    schemaState.patient_access_audit_source_is_pre_585,
  );
  const post585AuditSource = pgBooleanIsTrue(
    schemaState.patient_access_audit_source_is_post_585,
  );
  if (
    functionCount === 0
    && triggerCount === 0
    && ownerFkCount === 0
    && pre585AuditSource
    && !post585AuditSource
  ) return 'pre_585';
  if (
    functionCount === 12
    && triggerCount === 7
    && ownerFkCount === 1
    && !pre585AuditSource
    && post585AuditSource
  ) return 'post_585';
  return 'partial_585';
}

export function buildMigrationState({ migrationRows = [], schemaMode } = {}) {
  const tracked = new Set((migrationRows || []).map(row => String(row.name)));
  const prerequisitesApplied = PREREQUISITE_MIGRATIONS
    .filter(name => tracked.has(name));
  const targetApplied = tracked.has(TARGET_MIGRATION);
  const trackerCoherent = schemaMode === 'pre_585'
    ? prerequisitesApplied.length === PREREQUISITE_MIGRATIONS.length && !targetApplied
    : schemaMode === 'post_585'
      ? prerequisitesApplied.length === PREREQUISITE_MIGRATIONS.length && targetApplied
      : false;
  return {
    prerequisites_applied: prerequisitesApplied,
    prerequisites_complete:
      prerequisitesApplied.length === PREREQUISITE_MIGRATIONS.length,
    target_migration: TARGET_MIGRATION,
    target_applied: targetApplied,
    tracker_coherent: trackerCoherent,
  };
}

function safeSample(row) {
  return Object.fromEntries(
    SAFE_SAMPLE_FIELDS
      .filter(field => row[field] !== undefined && row[field] !== null)
      .map(field => [field, row[field]]),
  );
}

function issueSection(rows, tenantId, issueKey, sampleLimit) {
  const matches = rows
    .filter(row => String(row.tenant_id) === tenantId && row.issue_key === issueKey)
    .sort((left, right) => {
      const rankDelta = Number(left.sample_rank) - Number(right.sample_rank);
      if (rankDelta !== 0) return rankDelta;
      return String(left.evidence_fingerprint)
        .localeCompare(String(right.evidence_fingerprint));
    });
  if (matches.length === 0) return { count: 0, samples: [] };

  const totals = new Set(matches.map(row => asCount(
    row.total_count,
    `${tenantId}/${issueKey} total_count`,
  )));
  if (totals.size !== 1) {
    throw new Error(`Inconsistent total_count values for ${tenantId}/${issueKey}`);
  }
  const count = [...totals][0];
  if (count < matches.length) {
    throw new Error(`Bounded evidence exceeds total_count for ${tenantId}/${issueKey}`);
  }
  return {
    count,
    samples: matches.slice(0, sampleLimit).map(safeSample),
  };
}

export function buildOwnerRoutingReport({
  tenantRows = [],
  ownerRows = [],
  readOnlyState = {},
  schemaState = {},
  schemaMode = ownerSchemaModeFromState(schemaState),
  migrationState = buildMigrationState({ schemaMode }),
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > MAX_SAMPLE_LIMIT) {
    throw new Error(`sampleLimit must be an integer from 1 to ${MAX_SAMPLE_LIMIT}`);
  }
  const tenantIds = [...new Set(tenantRows.map(row => String(row.tenant_id)))].sort();
  const knownTenants = new Set(tenantIds);
  for (const row of ownerRows) {
    if (!knownTenants.has(String(row.tenant_id))) {
      throw new Error(`Finding belongs to tenant absent from inventory: ${row.tenant_id}`);
    }
    if (!OWNER_ISSUE_KEYS.includes(row.issue_key)) {
      throw new Error(`Unknown owner-routing readiness issue: ${row.issue_key}`);
    }
  }

  const tenants = tenantIds.map(tenantId => {
    const blockers = Object.fromEntries(
      OWNER_ISSUE_KEYS.map(issueKey => [
        issueKey,
        issueSection(ownerRows, tenantId, issueKey, sampleLimit),
      ]),
    );
    const blockingFindingCount = Object.values(blockers)
      .reduce((sum, section) => sum + section.count, 0);
    return {
      tenant_id: tenantId,
      owner_routing_ready: blockingFindingCount === 0,
      blocking_finding_count: blockingFindingCount,
      blockers,
    };
  });
  const tenantBlockingFindingCount = tenants
    .reduce((sum, tenant) => sum + tenant.blocking_finding_count, 0);
  const globalBlockers = {
    prerequisite_schema_missing_or_partial:
      schemaMode === 'prerequisites_missing_or_partial' ? 1 : 0,
    migration_585_schema_partial: schemaMode === 'partial_585' ? 1 : 0,
    migration_tracker_schema_mismatch: migrationState.tracker_coherent ? 0 : 1,
  };
  const globalBlockingFindingCount = Object.values(globalBlockers)
    .reduce((sum, count) => sum + count, 0);
  const ownerRoutingReady = tenantBlockingFindingCount === 0
    && globalBlockingFindingCount === 0
    && (schemaMode === 'pre_585' || schemaMode === 'post_585');

  return {
    schema_version: 1,
    gate: 'care_pathway_exclusive_owner_routing_readiness',
    generated_at: generatedAt,
    ready: ownerRoutingReady,
    owner_routing_ready: ownerRoutingReady,
    care_pathway_production_activation_ready: false,
    production_activation_reason:
      'S1b-c1 proves owner integrity only; clinical/governance activation evidence remains pending',
    scope: 'all_tenants',
    access_mode: 'primary_repeatable_read_read_only_transaction',
    sample_limit_per_tenant_per_section: sampleLimit,
    tenants_scanned: tenants.length,
    schema_mode: schemaMode,
    migration: migrationState,
    snapshot: {
      transaction_read_only: readOnlyState.transaction_read_only ?? null,
      transaction_isolation: readOnlyState.transaction_isolation ?? null,
      pg_is_in_recovery: readOnlyState.pg_is_in_recovery ?? null,
      audit_user: readOnlyState.audit_user ?? null,
      audit_user_is_superuser: readOnlyState.audit_user_is_superuser ?? null,
      audit_user_bypasses_rls: readOnlyState.audit_user_bypasses_rls ?? null,
    },
    blocker_section_keys: OWNER_ISSUE_KEYS,
    tenant_blocking_finding_count: tenantBlockingFindingCount,
    global_blocking_finding_count: globalBlockingFindingCount,
    blocking_finding_count:
      tenantBlockingFindingCount + globalBlockingFindingCount,
    global_blockers: globalBlockers,
    tenants,
  };
}

export async function collectOwnerRoutingReadiness({
  client,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  generatedAt,
} = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('collectOwnerRoutingReadiness requires a database client');
  }
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > MAX_SAMPLE_LIMIT) {
    throw new Error(`sampleLimit must be an integer from 1 to ${MAX_SAMPLE_LIMIT}`);
  }

  let transactionOpen = false;
  try {
    await client.query(BEGIN_READ_ONLY_QUERY);
    transactionOpen = true;

    const stateResult = await client.query(READ_ONLY_CHECK_QUERY);
    const readOnlyState = stateResult.rows?.[0] || {};
    if (!pgBooleanIsTrue(readOnlyState.transaction_read_only)) {
      throw new Error('Database transaction is writable; refusing owner-routing readiness scan');
    }
    if (String(readOnlyState.transaction_isolation).toLowerCase() !== 'repeatable read') {
      throw new Error('Database transaction is not repeatable read; snapshot proof is unavailable');
    }
    if (!pgBooleanIsFalse(readOnlyState.pg_is_in_recovery)) {
      throw new Error('Audit is on a recovery replica or primary status is unproven');
    }
    if (
      !pgBooleanIsTrue(readOnlyState.audit_user_is_superuser)
      && !pgBooleanIsTrue(readOnlyState.audit_user_bypasses_rls)
    ) {
      throw new Error(
        'Audit principal is not all-tenant privileged; rolsuper or rolbypassrls is required',
      );
    }

    const schemaResult = await client.query(SCHEMA_STATE_QUERY);
    const schemaState = schemaResult.rows?.[0] || {};
    const schemaMode = ownerSchemaModeFromState(schemaState);
    const migrationResult = await client.query(MIGRATION_TRACKER_QUERY);
    const migrationState = buildMigrationState({
      migrationRows: migrationResult.rows || [],
      schemaMode,
    });
    const tenantResult = await client.query(TENANT_INVENTORY_QUERY);
    const tenantRows = tenantResult.rows || [];
    if (tenantRows.length === 0) {
      throw new Error(
        'All-tenant audit returned zero tenants; refusing an empty-scope green result',
      );
    }

    let ownerRows = [];
    if (schemaMode === 'pre_585' || schemaMode === 'post_585') {
      const ownerResult = await client.query(OWNER_REPORT_QUERY, [sampleLimit]);
      ownerRows = ownerResult.rows || [];
    }
    const report = buildOwnerRoutingReport({
      tenantRows,
      ownerRows,
      readOnlyState,
      schemaState,
      schemaMode,
      migrationState,
      sampleLimit,
      generatedAt,
    });
    await client.query(COMMIT_QUERY);
    transactionOpen = false;
    return report;
  } catch (error) {
    if (transactionOpen) await client.query(ROLLBACK_QUERY).catch(() => {});
    throw error;
  }
}

export function parseArgs(argv) {
  const options = {
    acknowledged: false,
    json: false,
    help: false,
    sampleLimit: DEFAULT_SAMPLE_LIMIT,
  };
  for (const arg of argv) {
    if (arg === ACKNOWLEDGEMENT_FLAG) options.acknowledged = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--sample-limit=')) {
      options.sampleLimit = Number(arg.slice('--sample-limit='.length));
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    !Number.isInteger(options.sampleLimit)
    || options.sampleLimit < 1
    || options.sampleLimit > MAX_SAMPLE_LIMIT
  ) {
    throw new Error(`--sample-limit must be an integer from 1 to ${MAX_SAMPLE_LIMIT}`);
  }
  return options;
}

export function resolveConnectionString(env = process.env) {
  return env.CARE_PATHWAY_OWNER_AUDIT_DATABASE_URL
    || env.DATABASE_SUPERUSER_URL
    || null;
}

export function assertOperationalSafety({ acknowledged, env = process.env } = {}) {
  if (!acknowledged) {
    throw new Error(`Explicit operator acknowledgement required: ${ACKNOWLEDGEMENT_FLAG}`);
  }
  if (!resolveConnectionString(env)) {
    throw new Error(
      'CARE_PATHWAY_OWNER_AUDIT_DATABASE_URL or DATABASE_SUPERUSER_URL is required; ordinary DATABASE_URL fallback is forbidden',
    );
  }
}

export function auditExitCode(report) {
  return report?.owner_routing_ready === true ? 0 : BLOCKED_EXIT_CODE;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/audit-care-pathway-owner-routing-readiness.mjs',
    `    ${ACKNOWLEDGEMENT_FLAG} [--json] [--sample-limit=${DEFAULT_SAMPLE_LIMIT}]`,
    '',
    'Scans every tenant for migration-585 exclusive owner debt on the primary',
    'inside a repeatable-read READ ONLY transaction. Evidence is bounded and',
    'contains only one-way row fingerprints plus non-PHI classifications.',
    'A clean report is not tenant or pathway activation evidence.',
    `Exit 0 = owner-routing ready, ${BLOCKED_EXIT_CODE} = blocked, 1 = audit failed.`,
  ].join('\n');
}

function writeTextReport(report) {
  process.stdout.write(
    `Care-pathway owner routing: ${report.owner_routing_ready ? 'READY' : 'BLOCKED'}\n`,
  );
  process.stdout.write(`  schema mode: ${report.schema_mode}\n`);
  process.stdout.write(
    `  tracker coherent: ${report.migration.tracker_coherent ? 'yes' : 'no'}\n`,
  );
  process.stdout.write(`  tenants scanned: ${report.tenants_scanned}\n`);
  process.stdout.write(`  blocking findings: ${report.blocking_finding_count}\n`);
  process.stdout.write('  production/pathway activation: NOT READY (outside this gate)\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  assertOperationalSafety(options);
  const client = new Client({
    connectionString: resolveConnectionString(process.env),
    application_name: 'care-pathway-owner-routing-readiness',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
  });
  try {
    await client.connect();
    const report = await collectOwnerRoutingReadiness({
      client,
      sampleLimit: options.sampleLimit,
    });
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else writeTextReport(report);
    return auditExitCode(report);
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then(exitCode => {
      process.exitCode = exitCode;
    })
    .catch(error => {
      process.stderr.write(
        `[care-pathway-owner-routing-readiness] fatal: ${error.message}\n`,
      );
      process.exitCode = 1;
    });
}
