#!/usr/bin/env node
// SELECT-only readiness evidence for migration 580's opening fail-closed checks.
//
// The audit runs on the primary in one repeatable-read READ ONLY transaction.
// It intentionally does not emulate migration 580's later lock-dependent race
// closure: the migration remains the authority for those post-lock checks.

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

export const ACKNOWLEDGEMENT_FLAG = '--ack-read-only-primary-scan';
export const DEFAULT_SAMPLE_LIMIT = 5;
export const MAX_SAMPLE_LIMIT = 25;
export const BLOCKED_EXIT_CODE = 2;

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

const COLD_CHAIN_ACTIONABLE_ROLES_SQL = `ARRAY[
  'SUPER_ADMIN', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'ADMIN',
  'PHARMACIST', 'LAB_STAFF', 'LAB_INCHARGE', 'PATHOLOGIST', 'RADIOLOGIST',
  'RADIOLOGY_STAFF', 'BLOOD_BANK_TECHNICIAN', 'BLOOD_BANK_STAFF', 'DOCTOR',
  'NURSING_STAFF', 'OP_STAFF_NURSE', 'IP_STAFF_NURSE', 'CATH_LAB_STAFF',
  'DUTY_DOCTOR', 'NURSING_INCHARGE', 'IP_INCHARGE', 'OT_NURSE',
  'OT_INCHARGE', 'CATH_LAB_INCHARGE', 'ANESTHETIST', 'ADMISSION_OFFICER',
  'IPD_COUNSELLOR', 'OT_STAFF', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT',
  'ANAESTHETIST', 'SENIOR_DOCTOR', 'ICU_NURSE', 'ICU_INCHARGE',
  'ICU_STAFF', 'DIALYSIS_TECHNICIAN', 'MEDICAL_SUPERINTENDENT', 'CMO', 'CNO'
]::text[]`;

const DEFAULT_ACTIONABLE_ROLES_SQL = `ARRAY[
  'SUPER_ADMIN', 'DOCTOR', 'DUTY_DOCTOR', 'MEDICAL_SUPERINTENDENT',
  'NURSING_STAFF', 'NURSING_INCHARGE', 'OP_STAFF_NURSE', 'OP_INCHARGE',
  'IP_STAFF_NURSE', 'IP_INCHARGE', 'OT_NURSE', 'OT_INCHARGE',
  'CATH_LAB_STAFF', 'CATH_LAB_INCHARGE', 'PHARMACY_STAFF',
  'PHARMACY_INCHARGE', 'MEDICAL_RECORDS', 'ADMIN', 'ANESTHETIST',
  'ADMISSION_OFFICER', 'IPD_COUNSELLOR', 'OT_STAFF', 'CMO', 'CNO',
  'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT', 'ANAESTHETIST',
  'SENIOR_DOCTOR', 'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'ER_STAFF',
  'PHARMACIST'
]::text[]`;

export const REPORT_QUERY_KEYS = Object.freeze([
  'task_sla_links',
  'human_obligations',
  'acknowledgement_lifecycle',
  'corrected_result_lineage',
  'workflow_graph',
  'source_deadline_mortuary',
]);

export const ISSUE_KEYS = Object.freeze([
  'malformed_task_sla_links',
  'missing_task_sla_links',
  'cross_tenant_task_sla_links',
  'mismatched_task_sla_rules',
  'unlinked_active_task_sla_claims',
  'human_sla_missing_exact_actionable_task',
  'human_sla_missing_exact_terminal_receipt',
  'acknowledged_or_completed_task_with_incomplete_sla',
  'cancelled_task_with_incomplete_sla',
  'actionable_task_with_terminal_sla',
  'reopen_ancestor_deadline_mismatch',
  'invalid_reopen_edge',
  'critical_rearm_unproven_generation',
  'critical_rearm_stale_completed_by_task',
  'critical_rearm_terminal_unlinked_predecessor',
  'workflow_definition_key_version_mismatch',
  'workflow_current_step_missing',
  'duplicate_workflow_step_ordering',
  'multiple_current_workflow_steps',
  'task_workflow_step_wrong_run',
  'task_workflow_step_missing_run',
  'approval_task_wrong_run',
  'approval_task_missing_run',
  'parent_child_task_run_mismatch',
  'unknown_task_sla_completion_semantics',
  'task_sla_source_mismatch',
  'task_sla_missing_deadline',
  'mortuary_task_missing_death_record',
  'terminal_mortuary_task_missing_release',
  'duplicate_active_task_resource',
]);

export const REPORT_QUERIES = Object.freeze({
  task_sla_links: `
    WITH metadata_links AS (
      SELECT task.id AS task_id,
             task.tenant_id,
             BTRIM(task.metadata->>'sla_instance_id') AS sla_instance_id,
             NULLIF(BTRIM(task.metadata->>'sla_key'), '') AS sla_key,
             BTRIM(task.metadata->>'sla_instance_id') ~*
               '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               AS is_canonical_uuid
        FROM tasks AS task
       WHERE NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
    ), classified_links AS (
      SELECT metadata_link.task_id,
             metadata_link.tenant_id,
             metadata_link.is_canonical_uuid,
             metadata_link.sla_key,
             sla.id AS resolved_sla_id,
             sla.tenant_id AS resolved_tenant_id,
             sla.rule_code AS resolved_rule_code
        FROM metadata_links AS metadata_link
        LEFT JOIN workflow_sla_instances AS sla
          ON sla.id::text = LOWER(metadata_link.sla_instance_id)
    ), findings AS (
      SELECT link.tenant_id,
             CASE
               WHEN NOT link.is_canonical_uuid THEN 'malformed_task_sla_links'
               WHEN link.resolved_sla_id IS NULL THEN 'missing_task_sla_links'
               WHEN link.resolved_tenant_id IS DISTINCT FROM link.tenant_id
                 THEN 'cross_tenant_task_sla_links'
               WHEN link.sla_key IS NOT NULL
                    AND link.sla_key IS DISTINCT FROM link.resolved_rule_code
                 THEN 'mismatched_task_sla_rules'
             END AS issue_key,
             link.tenant_id::text || ':task:' || link.task_id::text AS evidence_seed,
             link.sla_key AS rule_code,
             NULL::text AS task_status,
             NULL::text AS sla_status,
             NULL::text AS detail,
             NULL::bigint AS observed_count
        FROM classified_links AS link
       WHERE NOT link.is_canonical_uuid
          OR (link.is_canonical_uuid AND link.resolved_sla_id IS NULL)
          OR (
            link.is_canonical_uuid
            AND link.resolved_sla_id IS NOT NULL
            AND link.resolved_tenant_id IS DISTINCT FROM link.tenant_id
          )
          OR (
            link.is_canonical_uuid
            AND link.resolved_sla_id IS NOT NULL
            AND link.resolved_tenant_id IS NOT DISTINCT FROM link.tenant_id
            AND link.sla_key IS NOT NULL
            AND link.sla_key IS DISTINCT FROM link.resolved_rule_code
          )

      UNION ALL

      SELECT task.tenant_id,
             'unlinked_active_task_sla_claims'::text,
             task.tenant_id::text || ':task:' || task.id::text,
             NULLIF(BTRIM(task.metadata->>'sla_key'), ''),
             task.status,
             NULL::text,
             NULL::text,
             NULL::bigint
        FROM tasks AS task
       WHERE task.status IN ('open', 'in_progress', 'blocked', 'overdue')
         AND NULLIF(BTRIM(task.metadata->>'sla_key'), '') IS NOT NULL
         AND NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NULL
         AND NOT (
           task.metadata->>'sla_key' = 'mortuary_unclaimed_body'
           AND task.metadata->>'requested_sla_key' = 'mortuary_unclaimed_body'
           AND task.metadata->>'sla_policy_status' = 'missing'
           AND task.related_resource_type = 'death_record'
           AND NULLIF(BTRIM(task.related_resource_id), '') IS NOT NULL
           AND task.due_at IS NULL
           AND EXISTS (
             SELECT 1
               FROM death_records AS death_record
              WHERE death_record.tenant_id = task.tenant_id
                AND death_record.id::text = task.related_resource_id
           )
         )
    ), ranked AS (
      SELECT finding.tenant_id,
             finding.issue_key,
             finding.evidence_seed,
             finding.rule_code,
             finding.task_status,
             finding.sla_status,
             finding.detail,
             finding.observed_count,
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
           SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16) AS evidence_fingerprint,
           ranked.rule_code,
           ranked.task_status,
           ranked.sla_status,
           ranked.detail,
           ranked.observed_count
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  human_obligations: `
    WITH known_human_slas AS (
      SELECT sla.id,
             sla.tenant_id,
             sla.patient_uid,
             sla.rule_code,
             sla.source_table,
             sla.source_id,
             sla.status,
             sla.completed_at,
             sla.metadata,
             CASE
               WHEN sla.rule_code = 'cold_chain_excursion_ack'
                 THEN ${COLD_CHAIN_ACTIONABLE_ROLES_SQL}
               ELSE ${DEFAULT_ACTIONABLE_ROLES_SQL}
             END AS actionable_roles
        FROM workflow_sla_instances AS sla
       WHERE sla.rule_code IN (
         'critical_result_ack',
         'cold_chain_excursion_ack',
         'mortuary_unclaimed_body'
       )
    ), assessed AS (
      SELECT sla.id,
             sla.tenant_id,
             sla.rule_code,
             sla.status,
             sla.completed_at,
             actionable.actionable_count,
             current_receipt.current_receipt_count
        FROM known_human_slas AS sla
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::integer AS actionable_count
            FROM tasks AS task
           WHERE task.tenant_id = sla.tenant_id
             AND LOWER(BTRIM(task.metadata->>'sla_instance_id')) = sla.id::text
             AND task.task_kind = 'review'
             AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
             AND task.patient_uid IS NOT DISTINCT FROM sla.patient_uid
             AND task.related_resource_type IS NOT DISTINCT FROM
                   CASE
                     WHEN sla.rule_code = 'mortuary_unclaimed_body'
                       THEN 'death_record'
                     ELSE sla.source_table
                   END
             AND task.related_resource_id IS NOT DISTINCT FROM sla.source_id
             AND (
               (
                 task.assigned_to_uid IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM users AS owner
                    WHERE owner.tenant_id = task.tenant_id
                      AND owner.uid = task.assigned_to_uid
                      AND owner.is_active = TRUE
                      AND NULLIF(BTRIM(owner.role), '') IS NOT NULL
                      AND UPPER(BTRIM(owner.role)) = ANY(sla.actionable_roles)
                 )
               )
               OR (
                 NULLIF(BTRIM(task.assigned_to_role), '') IS NOT NULL
                 AND UPPER(BTRIM(task.assigned_to_role)) = ANY(sla.actionable_roles)
               )
             )
        ) AS actionable
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::integer AS current_receipt_count
            FROM tasks AS task
           WHERE task.tenant_id = sla.tenant_id
             AND task.id::text = sla.metadata->>'completed_by_task'
             AND task.task_kind = 'review'
             AND LOWER(BTRIM(task.metadata->>'sla_instance_id')) = sla.id::text
             AND task.status IN ('in_progress', 'completed', 'cancelled')
             AND task.patient_uid IS NOT DISTINCT FROM sla.patient_uid
             AND task.related_resource_type IS NOT DISTINCT FROM
                   CASE
                     WHEN sla.rule_code = 'mortuary_unclaimed_body'
                       THEN 'death_record'
                     ELSE sla.source_table
                   END
             AND task.related_resource_id IS NOT DISTINCT FROM sla.source_id
        ) AS current_receipt
    ), findings AS (
      SELECT assessed.tenant_id,
             CASE
               WHEN assessed.completed_at IS NULL
                 THEN 'human_sla_missing_exact_actionable_task'
               ELSE 'human_sla_missing_exact_terminal_receipt'
             END AS issue_key,
             assessed.tenant_id::text || ':workflow_sla_instance:' || assessed.id::text
               AS evidence_seed,
             assessed.rule_code,
             NULL::text AS task_status,
             assessed.status AS sla_status,
             CASE
               WHEN assessed.completed_at IS NULL THEN 'actionable_count_must_equal_one'
               ELSE 'current_receipt_count_must_equal_one'
             END AS detail,
             CASE
               WHEN assessed.completed_at IS NULL THEN assessed.actionable_count
               ELSE assessed.current_receipt_count
             END::bigint AS observed_count
        FROM assessed
       WHERE (
         assessed.completed_at IS NULL
         AND assessed.status IN ('active', 'breached', 'escalated')
         AND assessed.actionable_count <> 1
       )
       OR (
         assessed.completed_at IS NOT NULL
         AND assessed.status IN ('completed', 'breached', 'escalated', 'cancelled')
         AND assessed.current_receipt_count <> 1
       )
    ), ranked AS (
      SELECT finding.tenant_id,
             finding.issue_key,
             finding.evidence_seed,
             finding.rule_code,
             finding.task_status,
             finding.sla_status,
             finding.detail,
             finding.observed_count,
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
           SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16) AS evidence_fingerprint,
           ranked.rule_code,
           ranked.task_status,
           ranked.sla_status,
           ranked.detail,
           ranked.observed_count
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  acknowledgement_lifecycle: `
    WITH RECURSIVE acknowledgement_links AS (
      SELECT task.id AS task_id,
             task.tenant_id,
             task.patient_uid,
             task.related_resource_type,
             task.related_resource_id,
             task.status AS task_status,
             task.due_at AS task_due_at,
             task.created_at AS task_created_at,
             NULLIF(BTRIM(task.metadata->>'reopened_from_task_id'), '')
               AS reopened_from_task_id,
             NULLIF(BTRIM(task.metadata->>'reopen_reason'), '') AS reopen_reason,
             sla.id AS sla_id,
             sla.rule_code,
             sla.status AS sla_status,
             sla.completed_at AS sla_completed_at,
             sla.metadata AS sla_metadata
        FROM tasks AS task
        JOIN workflow_sla_instances AS sla
          ON sla.tenant_id = task.tenant_id
         AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))
       WHERE NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
         AND sla.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
    ), reopen_chain AS (
      SELECT current_task.tenant_id,
             current_task.sla_id,
             current_task.task_id AS root_task_id,
             current_task.patient_uid,
             current_task.related_resource_type,
             current_task.related_resource_id,
             current_task.task_id,
             current_task.reopened_from_task_id,
             current_task.reopen_reason,
             current_task.task_created_at,
             current_task.sla_metadata,
             0::integer AS history_match_count,
             0::integer AS comment_match_count,
             NULL::text AS prior_due_at_text,
             ARRAY[current_task.task_id]::integer[] AS visited_task_ids,
             1 AS depth
        FROM acknowledgement_links AS current_task
       WHERE current_task.rule_code = 'critical_result_ack'
         AND current_task.reopened_from_task_id IS NOT NULL

      UNION ALL

      SELECT chain.tenant_id,
             chain.sla_id,
             chain.root_task_id,
             chain.patient_uid,
             chain.related_resource_type,
             chain.related_resource_id,
             predecessor.task_id,
             predecessor.reopened_from_task_id,
             predecessor.reopen_reason,
             predecessor.task_created_at,
             predecessor.sla_metadata,
             reopen_history.match_count,
             reciprocal_comment.match_count,
             reopen_history.prior_due_at_text,
             chain.visited_task_ids || predecessor.task_id,
             chain.depth + 1
        FROM reopen_chain AS chain
        JOIN acknowledgement_links AS predecessor
          ON predecessor.tenant_id = chain.tenant_id
         AND predecessor.sla_id = chain.sla_id
         AND predecessor.patient_uid IS NOT DISTINCT FROM chain.patient_uid
         AND predecessor.related_resource_type
               IS NOT DISTINCT FROM chain.related_resource_type
         AND predecessor.related_resource_id
               IS NOT DISTINCT FROM chain.related_resource_id
         AND predecessor.task_id::text = chain.reopened_from_task_id
         AND predecessor.task_status IN ('in_progress', 'completed', 'cancelled')
        JOIN LATERAL (
          SELECT COUNT(*)::integer AS match_count,
                 CASE WHEN COUNT(*) = 1
                   THEN MAX(history.receipt->>'prior_due_at')
                   ELSE NULL
                 END AS prior_due_at_text
            FROM jsonb_array_elements(
                   CASE
                     WHEN jsonb_typeof(predecessor.sla_metadata->'reopen_history') = 'array'
                       THEN predecessor.sla_metadata->'reopen_history'
                     ELSE '[]'::jsonb
                   END
                 ) WITH ORDINALITY AS history(receipt, position)
           WHERE NULLIF(BTRIM(history.receipt->>'prior_completed_by_task'), '') =
                   predecessor.task_id::text
             AND (
               history.receipt->>'database_authored_by'
                 IS DISTINCT FROM 'migration_580_rolling_compat'
               OR (
                 history.receipt->>'compatibility_state' = 'linked'
                 AND history.receipt->>'successor_task_id' = chain.task_id::text
               )
             )
        ) AS reopen_history ON TRUE
        JOIN LATERAL (
          SELECT COUNT(*)::integer AS match_count
            FROM task_comments AS receipt
           WHERE receipt.tenant_id = predecessor.tenant_id
             AND receipt.task_id = predecessor.task_id
             AND receipt.author_uid IS NULL
             AND receipt.body_kind = 'system_event'
             AND receipt.created_at >= chain.task_created_at
             AND NULLIF(BTRIM(receipt.metadata->>'superseded_by_task_id'), '') =
                   chain.task_id::text
             AND NULLIF(BTRIM(receipt.metadata->>'reason'), '') = chain.reopen_reason
        ) AS reciprocal_comment ON TRUE
       WHERE chain.reopened_from_task_id ~ '^[1-9][0-9]*$'
         AND chain.depth < 100
         AND NOT predecessor.task_id = ANY(chain.visited_task_ids)
         AND predecessor.task_id < chain.task_id
         AND predecessor.task_created_at <= chain.task_created_at
         AND reopen_history.match_count = 1
    ), verified_reopen_ancestors AS (
      SELECT DISTINCT tenant_id,
             sla_id,
             root_task_id,
             task_id,
             history_match_count,
             comment_match_count,
             prior_due_at_text,
             CASE
               WHEN prior_due_at_text ~
                      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                    AND pg_input_is_valid(prior_due_at_text, 'timestamp with time zone')
                 THEN prior_due_at_text::timestamptz
               ELSE NULL
             END AS receipt_prior_due_at
        FROM reopen_chain
       WHERE depth > 1
    ), assessed AS (
      SELECT link.tenant_id,
             link.task_id,
             link.task_due_at,
             link.reopened_from_task_id,
             link.sla_id,
             link.rule_code,
             link.task_status,
             link.sla_status,
             link.sla_completed_at,
             ancestor.task_id AS ancestor_task_id,
             ancestor.history_match_count,
             ancestor.receipt_prior_due_at
        FROM acknowledgement_links AS link
        LEFT JOIN verified_reopen_ancestors AS ancestor
          ON ancestor.tenant_id = link.tenant_id
         AND ancestor.sla_id = link.sla_id
         AND ancestor.task_id = link.task_id
    ), findings AS (
      SELECT assessed.tenant_id,
             issue.issue_key,
             assessed.tenant_id::text || ':task:' || assessed.task_id::text
               AS evidence_seed,
             assessed.rule_code,
             assessed.task_status,
             assessed.sla_status,
             issue.detail,
             NULL::bigint AS observed_count
        FROM assessed
        CROSS JOIN LATERAL (
          VALUES
            (
              'acknowledged_or_completed_task_with_incomplete_sla'::text,
              (
                assessed.task_status = 'in_progress'
                AND assessed.sla_completed_at IS NULL
              ) OR (
                assessed.task_status = 'completed'
                AND assessed.sla_completed_at IS NULL
                AND assessed.ancestor_task_id IS NULL
              ),
              'terminal_or_acknowledged_task_without_completed_sla'::text
            ),
            (
              'cancelled_task_with_incomplete_sla'::text,
              assessed.task_status = 'cancelled'
                AND assessed.sla_completed_at IS NULL
                AND assessed.ancestor_task_id IS NULL,
              'cancelled_task_without_completed_sla'::text
            ),
            (
              'actionable_task_with_terminal_sla'::text,
              assessed.task_status IN ('open', 'blocked', 'overdue')
                AND NOT (
                  assessed.sla_completed_at IS NULL
                  AND assessed.sla_status IN ('active', 'breached', 'escalated')
                ),
              'actionable_task_has_terminal_sla'::text
            ),
            (
              'reopen_ancestor_deadline_mismatch'::text,
              assessed.ancestor_task_id IS NOT NULL
                AND (
                  assessed.history_match_count > 1
                  OR (
                    assessed.task_due_at IS NULL
                    AND assessed.receipt_prior_due_at IS NULL
                  )
                  OR (
                    assessed.task_due_at IS NOT NULL
                    AND assessed.history_match_count = 1
                    AND (
                      assessed.receipt_prior_due_at IS NULL
                      OR assessed.task_due_at IS DISTINCT FROM
                           assessed.receipt_prior_due_at
                    )
                  )
                ),
              'reopen_receipt_does_not_preserve_exact_prior_deadline'::text
            ),
            (
              'invalid_reopen_edge'::text,
              assessed.rule_code = 'critical_result_ack'
                AND assessed.reopened_from_task_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                    FROM verified_reopen_ancestors AS verified_edge
                   WHERE verified_edge.tenant_id = assessed.tenant_id
                     AND verified_edge.sla_id = assessed.sla_id
                     AND verified_edge.root_task_id = assessed.task_id
                ),
              'critical_result_reopen_edge_is_not_uniquely_proven'::text
            )
        ) AS issue(issue_key, is_blocker, detail)
       WHERE issue.is_blocker
    ), ranked AS (
      SELECT finding.tenant_id,
             finding.issue_key,
             finding.evidence_seed,
             finding.rule_code,
             finding.task_status,
             finding.sla_status,
             finding.detail,
             finding.observed_count,
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
           SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16) AS evidence_fingerprint,
           ranked.rule_code,
           ranked.task_status,
           ranked.sla_status,
           ranked.detail,
           ranked.observed_count
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  corrected_result_lineage: `
    WITH critical_lab_slas AS (
      SELECT sla.id,
             sla.tenant_id,
             sla.patient_uid,
             sla.source_table,
             sla.source_id,
             sla.status,
             sla.completed_at,
             sla.metadata
        FROM workflow_sla_instances AS sla
        JOIN lab_results AS result
          ON result.tenant_id = sla.tenant_id
         AND result.id::text = sla.source_id
         AND result.patient_uid = sla.patient_uid
       WHERE sla.rule_code = 'critical_result_ack'
         AND sla.source_table = 'lab_result'
    ), generations AS (
      SELECT task.id,
             task.tenant_id,
             task.patient_uid,
             task.related_resource_type,
             task.related_resource_id,
             task.status,
             task.due_at,
             task.created_at,
             task.completed_at,
             task.metadata,
             sla.id AS linked_sla_id,
             sla.status AS sla_status,
             sla.completed_at AS sla_completed_at,
             sla.metadata AS sla_metadata,
             CASE
               WHEN task.metadata->>'acknowledged_at' ~
                      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                    AND pg_input_is_valid(
                      task.metadata->>'acknowledged_at',
                      'timestamp with time zone'
                    )
                 THEN (task.metadata->>'acknowledged_at')::timestamptz
               ELSE task.completed_at
             END AS obligation_completed_at
        FROM tasks AS task
        JOIN critical_lab_slas AS sla
          ON sla.tenant_id = task.tenant_id
         AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))
         AND task.patient_uid IS NOT DISTINCT FROM sla.patient_uid
         AND task.related_resource_type = sla.source_table
         AND task.related_resource_id = sla.source_id
    ), candidate_edges AS (
      SELECT successor.tenant_id,
             successor.linked_sla_id AS workflow_sla_instance_id,
             successor.id AS successor_id,
             predecessor.id AS predecessor_id,
             predecessor.due_at AS predecessor_due_at,
             predecessor.sla_metadata,
             predecessor.sla_status,
             predecessor.sla_completed_at,
             history_receipt.match_count AS history_match_count,
             history_receipt.prior_due_at_text,
             (
               NULLIF(BTRIM(successor.metadata->>'reopened_from_task_id'), '') =
                 predecessor.id::text
               AND history_receipt.match_count = 1
               AND history_receipt.prior_due_at_text ~
                     '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
               AND pg_input_is_valid(
                     history_receipt.prior_due_at_text,
                     'timestamp with time zone'
                   )
               AND (
                 predecessor.due_at IS NULL
                 OR predecessor.due_at = history_receipt.prior_due_at_text::timestamptz
               )
             ) AS valid_edge
        FROM generations AS successor
        JOIN generations AS predecessor
          ON predecessor.tenant_id = successor.tenant_id
         AND predecessor.metadata->>'sla_instance_id' =
               successor.metadata->>'sla_instance_id'
         AND predecessor.patient_uid IS NOT DISTINCT FROM successor.patient_uid
         AND predecessor.related_resource_type
               IS NOT DISTINCT FROM successor.related_resource_type
         AND predecessor.related_resource_id
               IS NOT DISTINCT FROM successor.related_resource_id
         AND predecessor.id < successor.id
         AND predecessor.created_at <= successor.created_at
         AND predecessor.status IN ('in_progress', 'completed', 'cancelled')
        JOIN lab_results AS result
          ON result.tenant_id = successor.tenant_id
         AND result.id::text = successor.related_resource_id
         AND result.patient_uid = successor.patient_uid
        JOIN lab_pathologist_signoffs AS signoff
          ON signoff.tenant_id = result.tenant_id
         AND result.id = ANY(signoff.result_ids)
         AND signoff.decision IN ('corrected', 'amended')
         AND signoff.signed_at > COALESCE(
               predecessor.obligation_completed_at,
               predecessor.created_at
             )
         AND signoff.signed_at <= successor.created_at
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::integer AS match_count,
                 CASE WHEN COUNT(*) = 1
                   THEN MAX(history.receipt->>'prior_due_at')
                   ELSE NULL
                 END AS prior_due_at_text
            FROM jsonb_array_elements(
                   CASE
                     WHEN jsonb_typeof(predecessor.sla_metadata->'reopen_history') = 'array'
                       THEN predecessor.sla_metadata->'reopen_history'
                     ELSE '[]'::jsonb
                   END
                 ) AS history(receipt)
           WHERE history.receipt->>'prior_completed_by_task' = predecessor.id::text
             AND (
               history.receipt->>'database_authored_by'
                 IS DISTINCT FROM 'migration_580_rolling_compat'
               OR (
                 history.receipt->>'compatibility_state' = 'linked'
                 AND history.receipt->>'successor_task_id' = successor.id::text
               )
             )
        ) AS history_receipt ON TRUE
    ), successor_assessments AS (
      SELECT edge.tenant_id,
             edge.workflow_sla_instance_id,
             edge.successor_id,
             BOOL_OR(edge.valid_edge) AS has_valid_edge
        FROM candidate_edges AS edge
       GROUP BY edge.tenant_id, edge.workflow_sla_instance_id, edge.successor_id
    ), successor_findings AS (
      SELECT assessment.tenant_id,
             CASE
               WHEN NOT assessment.has_valid_edge
                 THEN 'critical_rearm_unproven_generation'
               ELSE 'critical_rearm_stale_completed_by_task'
             END AS issue_key,
             assessment.tenant_id::text || ':task:' || assessment.successor_id::text
               AS evidence_seed,
             'critical_result_ack'::text AS rule_code,
             NULL::text AS task_status,
             sla.status AS sla_status,
             CASE
               WHEN NOT assessment.has_valid_edge THEN 'generation_edge_not_proven'
               ELSE 'active_sla_points_to_predecessor'
             END AS detail,
             NULL::bigint AS observed_count
        FROM successor_assessments AS assessment
        JOIN workflow_sla_instances AS sla
          ON sla.tenant_id = assessment.tenant_id
         AND sla.id = assessment.workflow_sla_instance_id
       WHERE NOT assessment.has_valid_edge
          OR (
            assessment.has_valid_edge
            AND sla.completed_at IS NULL
            AND sla.status IN ('active', 'breached', 'escalated')
            AND NULLIF(BTRIM(sla.metadata->>'completed_by_task'), '') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM candidate_edges AS exact_edge
               WHERE exact_edge.tenant_id = assessment.tenant_id
                 AND exact_edge.workflow_sla_instance_id =
                       assessment.workflow_sla_instance_id
                 AND exact_edge.successor_id = assessment.successor_id
                 AND exact_edge.valid_edge
                 AND exact_edge.predecessor_id::text =
                       sla.metadata->>'completed_by_task'
            )
          )
    ), linked_successors AS (
      SELECT successor.id,
             successor.tenant_id,
             successor.patient_uid,
             successor.related_resource_type,
             successor.related_resource_id,
             successor.created_at
        FROM tasks AS successor
        JOIN critical_lab_slas AS sla
          ON sla.tenant_id = successor.tenant_id
         AND sla.id::text = LOWER(BTRIM(successor.metadata->>'sla_instance_id'))
         AND successor.patient_uid IS NOT DISTINCT FROM sla.patient_uid
         AND successor.related_resource_type = sla.source_table
         AND successor.related_resource_id = sla.source_id
       WHERE successor.metadata->>'sla_key' = 'critical_result_ack'
    ), terminal_unlinked_predecessors AS (
      SELECT predecessor.id,
             predecessor.tenant_id,
             predecessor.patient_uid,
             predecessor.related_resource_type,
             predecessor.related_resource_id,
             predecessor.status,
             predecessor.created_at,
             CASE
               WHEN predecessor.metadata->>'acknowledged_at' ~
                      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                    AND pg_input_is_valid(
                      predecessor.metadata->>'acknowledged_at',
                      'timestamp with time zone'
                    )
                 THEN (predecessor.metadata->>'acknowledged_at')::timestamptz
               ELSE predecessor.completed_at
             END AS obligation_completed_at
        FROM tasks AS predecessor
       WHERE predecessor.metadata->>'sla_key' = 'critical_result_ack'
         AND NULLIF(BTRIM(predecessor.metadata->>'sla_instance_id'), '') IS NULL
         AND predecessor.related_resource_type = 'lab_result'
         AND predecessor.status IN ('in_progress', 'completed', 'cancelled')
    ), unlinked_findings AS (
      SELECT predecessor.tenant_id,
             'critical_rearm_terminal_unlinked_predecessor'::text AS issue_key,
             predecessor.tenant_id::text || ':task-pair:' ||
               predecessor.id::text || ':' || successor.id::text AS evidence_seed,
             'critical_result_ack'::text AS rule_code,
             predecessor.status AS task_status,
             NULL::text AS sla_status,
             'terminal_predecessor_is_not_linked_to_rearmed_sla'::text AS detail,
             NULL::bigint AS observed_count
        FROM terminal_unlinked_predecessors AS predecessor
        JOIN linked_successors AS successor
          ON successor.tenant_id = predecessor.tenant_id
         AND successor.patient_uid IS NOT DISTINCT FROM predecessor.patient_uid
         AND successor.related_resource_type = predecessor.related_resource_type
         AND successor.related_resource_id = predecessor.related_resource_id
         AND successor.id > predecessor.id
         AND successor.created_at >= predecessor.created_at
        JOIN lab_results AS result
          ON result.tenant_id = predecessor.tenant_id
         AND result.id::text = predecessor.related_resource_id
         AND result.patient_uid = predecessor.patient_uid
       WHERE EXISTS (
         SELECT 1
           FROM lab_pathologist_signoffs AS signoff
          WHERE signoff.tenant_id = predecessor.tenant_id
            AND result.id = ANY(signoff.result_ids)
            AND signoff.decision IN ('corrected', 'amended')
            AND signoff.signed_at > COALESCE(
                  predecessor.obligation_completed_at,
                  predecessor.created_at
                )
            AND signoff.signed_at <= successor.created_at
       )
    ), findings AS (
      SELECT successor_finding.tenant_id,
             successor_finding.issue_key,
             successor_finding.evidence_seed,
             successor_finding.rule_code,
             successor_finding.task_status,
             successor_finding.sla_status,
             successor_finding.detail,
             successor_finding.observed_count
        FROM successor_findings AS successor_finding
      UNION ALL
      SELECT unlinked_finding.tenant_id,
             unlinked_finding.issue_key,
             unlinked_finding.evidence_seed,
             unlinked_finding.rule_code,
             unlinked_finding.task_status,
             unlinked_finding.sla_status,
             unlinked_finding.detail,
             unlinked_finding.observed_count
        FROM unlinked_findings AS unlinked_finding
    ), ranked AS (
      SELECT finding.tenant_id,
             finding.issue_key,
             finding.evidence_seed,
             finding.rule_code,
             finding.task_status,
             finding.sla_status,
             finding.detail,
             finding.observed_count,
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
           SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16) AS evidence_fingerprint,
           ranked.rule_code,
           ranked.task_status,
           ranked.sla_status,
           ranked.detail,
           ranked.observed_count
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  workflow_graph: `
    WITH findings AS (
      SELECT run.tenant_id,
             'workflow_definition_key_version_mismatch'::text AS issue_key,
             run.tenant_id::text || ':workflow_run:' || run.id::text AS evidence_seed
        FROM workflow_runs AS run
        JOIN workflow_definitions AS definition
          ON definition.tenant_id = run.tenant_id
         AND definition.id = run.workflow_definition_id
       WHERE run.workflow_definition_id IS NOT NULL
         AND (
           run.workflow_key IS DISTINCT FROM definition.workflow_key
           OR run.workflow_version IS DISTINCT FROM definition.version
         )

      UNION ALL

      SELECT run.tenant_id,
             'workflow_current_step_missing',
             run.tenant_id::text || ':workflow_run:' || run.id::text
        FROM workflow_runs AS run
       WHERE run.current_step_key IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM workflow_steps AS step
            WHERE step.tenant_id = run.tenant_id
              AND step.workflow_run_id = run.id
              AND step.step_key = run.current_step_key
         )

      UNION ALL

      SELECT step.tenant_id,
             'duplicate_workflow_step_ordering',
             step.tenant_id::text || ':workflow-run-ordering:' ||
               step.workflow_run_id::text || ':' || COALESCE(step.ordering::text, '<null>')
        FROM workflow_steps AS step
       GROUP BY step.tenant_id, step.workflow_run_id, step.ordering
      HAVING COUNT(*) > 1

      UNION ALL

      SELECT step.tenant_id,
             'multiple_current_workflow_steps',
             step.tenant_id::text || ':workflow-run-current:' || step.workflow_run_id::text
        FROM workflow_steps AS step
       WHERE step.status IN ('in_progress', 'blocked')
       GROUP BY step.tenant_id, step.workflow_run_id
      HAVING COUNT(*) > 1

      UNION ALL

      SELECT task.tenant_id,
             'task_workflow_step_wrong_run',
             task.tenant_id::text || ':task:' || task.id::text
        FROM tasks AS task
        JOIN workflow_steps AS step
          ON step.tenant_id = task.tenant_id
         AND step.id = task.workflow_step_id
       WHERE task.workflow_run_id IS NOT NULL
         AND task.workflow_step_id IS NOT NULL
         AND step.workflow_run_id IS DISTINCT FROM task.workflow_run_id

      UNION ALL

      SELECT task.tenant_id,
             'task_workflow_step_missing_run',
             task.tenant_id::text || ':task:' || task.id::text
        FROM tasks AS task
       WHERE task.workflow_step_id IS NOT NULL
         AND task.workflow_run_id IS NULL

      UNION ALL

      SELECT approval.tenant_id,
             'approval_task_wrong_run',
             approval.tenant_id::text || ':approval:' || approval.id::text
        FROM approvals AS approval
        JOIN tasks AS task
          ON task.tenant_id = approval.tenant_id
         AND task.id = approval.task_id
       WHERE approval.workflow_run_id IS NOT NULL
         AND approval.task_id IS NOT NULL
         AND task.workflow_run_id IS DISTINCT FROM approval.workflow_run_id

      UNION ALL

      SELECT approval.tenant_id,
             'approval_task_missing_run',
             approval.tenant_id::text || ':approval:' || approval.id::text
        FROM approvals AS approval
       WHERE approval.task_id IS NOT NULL
         AND approval.workflow_run_id IS NULL

      UNION ALL

      SELECT child.tenant_id,
             'parent_child_task_run_mismatch',
             child.tenant_id::text || ':task-pair:' || child.id::text || ':' || parent.id::text
        FROM tasks AS child
        JOIN tasks AS parent
          ON parent.tenant_id = child.tenant_id
         AND parent.id = child.parent_task_id
       WHERE child.parent_task_id IS NOT NULL
         AND parent.workflow_run_id IS DISTINCT FROM child.workflow_run_id

      UNION ALL

      SELECT task.tenant_id,
             'duplicate_active_task_resource',
             task.tenant_id::text || ':active-task-resource:' ||
               task.related_resource_type || ':' || task.related_resource_id
        FROM tasks AS task
       WHERE task.status IN ('open', 'in_progress', 'blocked', 'overdue')
         AND task.related_resource_type IS NOT NULL
         AND task.related_resource_id IS NOT NULL
       GROUP BY task.tenant_id, task.related_resource_type, task.related_resource_id
      HAVING COUNT(*) > 1
    ), ranked AS (
      SELECT finding.tenant_id,
             finding.issue_key,
             finding.evidence_seed,
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
           SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16) AS evidence_fingerprint,
           NULL::text AS rule_code,
           NULL::text AS task_status,
           NULL::text AS sla_status,
           ranked.issue_key AS detail,
           NULL::bigint AS observed_count
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  source_deadline_mortuary: `
    WITH linked AS (
      SELECT task.id AS task_id,
             task.tenant_id,
             task.workflow_step_id,
             task.related_resource_type,
             task.related_resource_id,
             task.status AS task_status,
             sla.rule_code,
             sla.source_table,
             sla.source_id,
             sla.due_at
        FROM tasks AS task
        JOIN workflow_sla_instances AS sla
          ON sla.tenant_id = task.tenant_id
         AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))
       WHERE NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
    ), findings AS (
      SELECT linked.tenant_id,
             'unknown_task_sla_completion_semantics'::text AS issue_key,
             linked.tenant_id::text || ':task:' || linked.task_id::text AS evidence_seed,
             linked.rule_code,
             linked.task_status,
             NULL::text AS sla_status,
             'unregistered_non_pathway_completion_semantics'::text AS detail
        FROM linked
       WHERE linked.workflow_step_id IS NULL
         AND linked.rule_code NOT IN (
           'critical_result_ack',
           'cold_chain_excursion_ack',
           'mortuary_unclaimed_body'
         )

      UNION ALL

      SELECT linked.tenant_id,
             'task_sla_source_mismatch',
             linked.tenant_id::text || ':task:' || linked.task_id::text,
             linked.rule_code,
             linked.task_status,
             NULL::text,
             'linked_sla_source_does_not_match_task_resource'
        FROM linked
       WHERE NOT (
         (
           linked.workflow_step_id IS NOT NULL
           AND linked.source_table IS NOT DISTINCT FROM 'workflow_steps'
           AND linked.source_id IS NOT DISTINCT FROM linked.workflow_step_id::text
         )
         OR (
           linked.workflow_step_id IS NULL
           AND linked.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
           AND NULLIF(BTRIM(linked.related_resource_type), '') IS NOT NULL
           AND NULLIF(BTRIM(linked.related_resource_id), '') IS NOT NULL
           AND linked.source_table IS NOT DISTINCT FROM linked.related_resource_type
           AND linked.source_id IS NOT DISTINCT FROM linked.related_resource_id
         )
         OR (
           linked.workflow_step_id IS NULL
           AND linked.rule_code = 'mortuary_unclaimed_body'
           AND linked.related_resource_type IS NOT DISTINCT FROM 'death_record'
           AND NULLIF(BTRIM(linked.related_resource_id), '') IS NOT NULL
           AND linked.source_table IS NOT DISTINCT FROM 'death_records'
           AND linked.source_id IS NOT DISTINCT FROM linked.related_resource_id
         )
       )

      UNION ALL

      SELECT linked.tenant_id,
             'task_sla_missing_deadline',
             linked.tenant_id::text || ':task:' || linked.task_id::text,
             linked.rule_code,
             linked.task_status,
             NULL::text,
             'linked_sla_has_no_canonical_deadline'
        FROM linked
       WHERE linked.due_at IS NULL

      UNION ALL

      SELECT linked.tenant_id,
             'mortuary_task_missing_death_record',
             linked.tenant_id::text || ':task:' || linked.task_id::text,
             linked.rule_code,
             linked.task_status,
             NULL::text,
             'mortuary_task_has_no_valid_death_record_resource'
        FROM linked
       WHERE linked.rule_code = 'mortuary_unclaimed_body'
         AND (
           linked.related_resource_type IS DISTINCT FROM 'death_record'
           OR NOT EXISTS (
             SELECT 1
               FROM death_records AS death_record
              WHERE death_record.tenant_id = linked.tenant_id
                AND death_record.id::text = linked.related_resource_id
           )
         )

      UNION ALL

      SELECT linked.tenant_id,
             'terminal_mortuary_task_missing_release',
             linked.tenant_id::text || ':task:' || linked.task_id::text,
             linked.rule_code,
             linked.task_status,
             NULL::text,
             'terminal_mortuary_task_has_no_release_evidence'
        FROM linked
       WHERE linked.rule_code = 'mortuary_unclaimed_body'
         AND linked.related_resource_type = 'death_record'
         AND linked.task_status IN ('completed', 'cancelled')
         AND NOT EXISTS (
           SELECT 1
             FROM body_custody_events AS evidence
            WHERE evidence.tenant_id = linked.tenant_id
              AND evidence.death_record_id::text = linked.related_resource_id
              AND evidence.event_type = 'release'
         )
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
           SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16) AS evidence_fingerprint,
           ranked.rule_code,
           ranked.task_status,
           ranked.sla_status,
           ranked.detail,
           NULL::bigint AS observed_count
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,
});

const SAFE_SAMPLE_FIELDS = Object.freeze([
  'evidence_fingerprint',
  'rule_code',
  'task_status',
  'sla_status',
  'detail',
  'observed_count',
]);

function parseSafeCount(value, label) {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return parsed;
}

function safeSample(row) {
  return Object.fromEntries(
    SAFE_SAMPLE_FIELDS
      .filter(field => row[field] !== undefined && row[field] !== null)
      .map(field => [field, row[field]]),
  );
}

function sectionFor(rows, tenantId, issueKey, sampleLimit) {
  const matches = rows
    .filter(row => String(row.tenant_id) === tenantId && row.issue_key === issueKey)
    .sort((left, right) => {
      const rankDelta = Number(left.sample_rank) - Number(right.sample_rank);
      if (rankDelta !== 0) return rankDelta;
      return String(left.evidence_fingerprint).localeCompare(String(right.evidence_fingerprint));
    });
  if (matches.length === 0) return { count: 0, samples: [] };

  const totals = new Set(
    matches.map(row => parseSafeCount(row.total_count, `${tenantId}/${issueKey} total_count`)),
  );
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

/** Build deterministic, tenant-grouped, PHI-safe evidence from bounded rows. */
export function buildAuditReport({
  tenantRows = [],
  rowsByQuery = {},
  readOnlyState = {},
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > MAX_SAMPLE_LIMIT) {
    throw new Error(`sampleLimit must be an integer from 1 to ${MAX_SAMPLE_LIMIT}`);
  }

  const tenantIds = [...new Set(tenantRows.map(row => String(row.tenant_id)))].sort();
  const knownTenants = new Set(tenantIds);
  const allRows = REPORT_QUERY_KEYS.flatMap(key => rowsByQuery[key] || []);
  for (const row of allRows) {
    const tenantId = String(row.tenant_id);
    if (!knownTenants.has(tenantId)) {
      throw new Error(`Finding belongs to tenant absent from the inventory: ${tenantId}`);
    }
    if (!ISSUE_KEYS.includes(row.issue_key)) {
      throw new Error(`Unknown migration-580 readiness issue: ${row.issue_key}`);
    }
  }

  const tenants = tenantIds.map(tenantId => {
    const blockers = Object.fromEntries(
      ISSUE_KEYS.map(issueKey => [
        issueKey,
        sectionFor(allRows, tenantId, issueKey, sampleLimit),
      ]),
    );
    const blockingFindingCount = Object.values(blockers)
      .reduce((sum, section) => sum + section.count, 0);
    return {
      tenant_id: tenantId,
      ready: blockingFindingCount === 0,
      blocking_finding_count: blockingFindingCount,
      blockers,
    };
  });

  const totals = Object.fromEntries(
    ISSUE_KEYS.map(issueKey => [
      issueKey,
      tenants.reduce((sum, tenant) => sum + tenant.blockers[issueKey].count, 0),
    ]),
  );
  const blockingFindingCount = Object.values(totals)
    .reduce((sum, count) => sum + count, 0);

  return {
    schema_version: 1,
    gate: 'migration_580_care_pathway_execution_spine_readiness',
    generated_at: generatedAt,
    ready: blockingFindingCount === 0,
    scope: 'all_tenants',
    access_mode: 'primary_repeatable_read_read_only_transaction',
    sample_limit_per_tenant_per_section: sampleLimit,
    tenants_scanned: tenants.length,
    blocker_section_keys: ISSUE_KEYS,
    snapshot: {
      transaction_read_only: readOnlyState.transaction_read_only ?? null,
      transaction_isolation: readOnlyState.transaction_isolation ?? null,
      pg_is_in_recovery: readOnlyState.pg_is_in_recovery ?? null,
      audit_user: readOnlyState.audit_user ?? null,
      audit_user_is_superuser: readOnlyState.audit_user_is_superuser ?? null,
      audit_user_bypasses_rls: readOnlyState.audit_user_bypasses_rls ?? null,
    },
    proof_boundary: {
      opening_fail_closed_predicates_only: true,
      post_lock_race_closure_included: false,
      post_lock_race_closure_authority:
        'migration_580_commit_on_the_drained_production_clone_and_primary',
    },
    blocking_finding_count: blockingFindingCount,
    totals,
    tenants,
  };
}

function pgBooleanIsTrue(value) {
  return value === true || value === 'true' || value === 't' || value === '1'
    || value === 'on';
}

function pgBooleanIsFalse(value) {
  return value === false || value === 'false' || value === 'f' || value === '0'
    || value === 'off';
}

export async function collectCarePathwaySpineReadiness({
  client,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  generatedAt,
} = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('collectCarePathwaySpineReadiness requires a database client');
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
      throw new Error('Database transaction is writable; refusing migration-580 readiness scan');
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

    const tenantResult = await client.query(TENANT_INVENTORY_QUERY);
    const tenantRows = tenantResult.rows || [];
    if (tenantRows.length === 0) {
      throw new Error(
        'All-tenant audit returned zero tenants; refusing an empty-scope green result',
      );
    }

    const rowsByQuery = {};
    for (const key of REPORT_QUERY_KEYS) {
      const result = await client.query(REPORT_QUERIES[key], [sampleLimit]);
      rowsByQuery[key] = result.rows || [];
    }

    const report = buildAuditReport({
      tenantRows,
      rowsByQuery,
      readOnlyState,
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
  return env.CARE_PATHWAY_AUDIT_DATABASE_URL
    || env.DATABASE_SUPERUSER_URL
    || null;
}

export function assertOperationalSafety({ acknowledged, env = process.env } = {}) {
  if (!acknowledged) {
    throw new Error(`Explicit operator acknowledgement required: ${ACKNOWLEDGEMENT_FLAG}`);
  }
  if (!resolveConnectionString(env)) {
    throw new Error(
      'CARE_PATHWAY_AUDIT_DATABASE_URL or DATABASE_SUPERUSER_URL is required; ordinary DATABASE_URL fallback is forbidden',
    );
  }
}

export function auditExitCode(report) {
  return report?.ready === true ? 0 : BLOCKED_EXIT_CODE;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/audit-care-pathway-spine-readiness.mjs',
    `    ${ACKNOWLEDGEMENT_FLAG} [--json] [--sample-limit=${DEFAULT_SAMPLE_LIMIT}]`,
    '',
    'Runs migration 580 opening readiness checks for every tenant on the primary',
    'inside a repeatable-read READ ONLY transaction. Evidence is bounded and',
    'contains only one-way row fingerprints plus non-PHI classification fields.',
    'Post-lock race closure is deliberately left to migration 580 itself.',
    `Exit 0 = ready, ${BLOCKED_EXIT_CODE} = blockers found, 1 = audit execution failed.`,
  ].join('\n');
}

function writeTextReport(report) {
  process.stdout.write(
    `Migration 580 care-pathway spine readiness: ${report.ready ? 'READY' : 'BLOCKED'}\n`,
  );
  process.stdout.write(`  tenants scanned: ${report.tenants_scanned}\n`);
  process.stdout.write(`  blocking findings: ${report.blocking_finding_count}\n`);
  for (const tenant of report.tenants) {
    process.stdout.write(
      `  tenant ${tenant.tenant_id}: ${tenant.ready ? 'ready' : 'blocked'} `
        + `(${tenant.blocking_finding_count} finding(s))\n`,
    );
    for (const key of ISSUE_KEYS) {
      if (tenant.blockers[key].count > 0) {
        process.stdout.write(`    ${key}: ${tenant.blockers[key].count}\n`);
      }
    }
  }
  process.stdout.write(
    '  READY covers opening predicates only; migration 580 must still close post-lock races.\n',
  );
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
    application_name: 'care-pathway-spine-580-readiness-audit',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
  });
  try {
    await client.connect();
    const report = await collectCarePathwaySpineReadiness({
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
      process.stderr.write(`[care-pathway-spine-580-readiness] fatal: ${error.message}\n`);
      process.exitCode = 1;
    });
}
