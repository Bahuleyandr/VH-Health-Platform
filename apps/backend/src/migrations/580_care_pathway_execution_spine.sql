-- Unified Care Pathways S1b-b: dormant execution-spine schema.
--
-- No pathway definition, handler, projector, scheduler, notification or tenant
-- mode is activated here. The migration finishes the database invariants that
-- the default-off executor relies on before a clinical pathway can be approved.

BEGIN;

-- Keep database-side task ownership aligned with the route surfaces that can
-- actually service the obligation. The conformance suite compares these exact
-- arrays with routeRolePolicy.js so policy drift fails before merge.
CREATE OR REPLACE FUNCTION care_pathway_route_actionable_roles(
  obligation_rule_code TEXT
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN obligation_rule_code = 'cold_chain_excursion_ack' THEN ARRAY[
      'SUPER_ADMIN', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'ADMIN',
      'PHARMACIST', 'LAB_STAFF', 'LAB_INCHARGE', 'PATHOLOGIST', 'RADIOLOGIST',
      'RADIOLOGY_STAFF', 'BLOOD_BANK_TECHNICIAN', 'BLOOD_BANK_STAFF', 'DOCTOR',
      'NURSING_STAFF', 'OP_STAFF_NURSE', 'IP_STAFF_NURSE', 'CATH_LAB_STAFF',
      'DUTY_DOCTOR', 'NURSING_INCHARGE', 'IP_INCHARGE', 'OT_NURSE',
      'OT_INCHARGE', 'CATH_LAB_INCHARGE', 'ANESTHETIST', 'ADMISSION_OFFICER',
      'IPD_COUNSELLOR', 'OT_STAFF', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT',
      'ANAESTHETIST', 'SENIOR_DOCTOR', 'ICU_NURSE', 'ICU_INCHARGE',
      'ICU_STAFF', 'DIALYSIS_TECHNICIAN', 'MEDICAL_SUPERINTENDENT', 'CMO', 'CNO'
    ]::TEXT[]
    ELSE ARRAY[
      'SUPER_ADMIN', 'DOCTOR', 'DUTY_DOCTOR', 'MEDICAL_SUPERINTENDENT',
      'NURSING_STAFF', 'NURSING_INCHARGE', 'OP_STAFF_NURSE', 'OP_INCHARGE',
      'IP_STAFF_NURSE', 'IP_INCHARGE', 'OT_NURSE', 'OT_INCHARGE',
      'CATH_LAB_STAFF', 'CATH_LAB_INCHARGE', 'PHARMACY_STAFF',
      'PHARMACY_INCHARGE', 'MEDICAL_RECORDS', 'ADMIN', 'ANESTHETIST',
      'ADMISSION_OFFICER', 'IPD_COUNSELLOR', 'OT_STAFF', 'CMO', 'CNO',
      'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT', 'ANAESTHETIST',
      'SENIOR_DOCTOR', 'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF', 'ER_STAFF',
      'PHARMACIST'
    ]::TEXT[]
  END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_is_route_actionable_human_role(
  role_code TEXT,
  obligation_rule_code TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(BTRIM(role_code), '') IS NOT NULL
     AND UPPER(BTRIM(role_code)) = ANY(
       care_pathway_route_actionable_roles(obligation_rule_code)
     );
$$;

-- ---------------------------------------------------------------------------
-- Fail closed before strengthening the live workflow graph.
-- ---------------------------------------------------------------------------

DO $care_pathway_task_sla_link_preflight$
DECLARE
  malformed_link_count INTEGER;
  missing_link_count INTEGER;
  cross_tenant_link_count INTEGER;
  rule_mismatch_count INTEGER;
  unlinked_claim_count INTEGER;
  invalid_link_count INTEGER;
BEGIN
  WITH metadata_links AS (
    SELECT task.tenant_id,
           BTRIM(task.metadata->>'sla_instance_id') AS sla_instance_id,
           NULLIF(BTRIM(task.metadata->>'sla_key'), '') AS sla_key,
           BTRIM(task.metadata->>'sla_instance_id') ~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AS is_canonical_uuid
      FROM tasks AS task
     WHERE NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
  ), classified_links AS (
    SELECT metadata_link.tenant_id,
           metadata_link.is_canonical_uuid,
           metadata_link.sla_key,
           sla.id AS resolved_sla_id,
           sla.tenant_id AS resolved_tenant_id,
           sla.rule_code AS resolved_rule_code
      FROM metadata_links AS metadata_link
      LEFT JOIN workflow_sla_instances AS sla
        ON sla.id::text = LOWER(metadata_link.sla_instance_id)
  )
  SELECT COUNT(*) FILTER (WHERE NOT is_canonical_uuid)::integer,
         COUNT(*) FILTER (
           WHERE is_canonical_uuid
             AND resolved_sla_id IS NULL
         )::integer,
         COUNT(*) FILTER (
           WHERE is_canonical_uuid
             AND resolved_sla_id IS NOT NULL
             AND resolved_tenant_id IS DISTINCT FROM tenant_id
         )::integer,
         COUNT(*) FILTER (
           WHERE is_canonical_uuid
             AND resolved_sla_id IS NOT NULL
             AND resolved_tenant_id IS NOT DISTINCT FROM tenant_id
             AND sla_key IS NOT NULL
             AND sla_key IS DISTINCT FROM resolved_rule_code
         )::integer
    INTO malformed_link_count,
         missing_link_count,
         cross_tenant_link_count,
         rule_mismatch_count
    FROM classified_links;

  SELECT COUNT(*)::integer
    INTO unlinked_claim_count
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
     );

  invalid_link_count :=
    malformed_link_count + missing_link_count + cross_tenant_link_count
      + rule_mismatch_count + unlinked_claim_count;

  IF invalid_link_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'migration 580 blocked: %s task SLA metadata link(s) are invalid (malformed=%s, missing=%s, cross_tenant=%s, rule_mismatch=%s, unlinked_claims=%s)',
        invalid_link_count,
        malformed_link_count,
        missing_link_count,
        cross_tenant_link_count,
        rule_mismatch_count,
        unlinked_claim_count
      ),
      HINT =
        'Reconcile each active SLA claim to a workflow_sla_instance in the same tenant and verify its exact task source before retrying. Do not detach or delete open clinical tasks. Policy-missing tasks must be marked explicitly.';
  END IF;
END
$care_pathway_task_sla_link_preflight$;

DO $care_pathway_human_sla_task_preflight$
DECLARE
  inconsistent_obligation_count INTEGER;
BEGIN
  WITH known_human_slas AS (
    SELECT sla.*,
           CASE
             WHEN sla.rule_code IN (
               'critical_result_ack', 'cold_chain_excursion_ack'
             ) THEN 'acknowledgement'
             WHEN sla.rule_code = 'mortuary_unclaimed_body'
               THEN 'domain_evidence'
           END AS expected_semantics
      FROM workflow_sla_instances AS sla
     WHERE sla.rule_code IN (
       'critical_result_ack',
       'cold_chain_excursion_ack',
       'mortuary_unclaimed_body'
     )
  ), assessed AS (
    SELECT sla.id,
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
             (task.assigned_to_uid IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM users AS owner
                 WHERE owner.tenant_id = task.tenant_id
                   AND owner.uid = task.assigned_to_uid
                   AND owner.is_active = TRUE
                   AND care_pathway_is_route_actionable_human_role(
                         owner.role,
                         sla.rule_code
                       )
              ))
             OR care_pathway_is_route_actionable_human_role(
                  task.assigned_to_role,
                  sla.rule_code
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
  )
  SELECT COUNT(*)::integer
    INTO inconsistent_obligation_count
    FROM assessed
   WHERE (
     completed_at IS NULL
     AND status IN ('active', 'breached', 'escalated')
     AND actionable_count <> 1
   )
   OR (
     completed_at IS NOT NULL
     AND status IN ('completed', 'breached', 'escalated', 'cancelled')
     AND current_receipt_count <> 1
   );

  IF inconsistent_obligation_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'migration 580 blocked: %s known human-action SLA obligation(s) lack one owned task or exact terminal receipt',
        inconsistent_obligation_count
      ),
      HINT =
        'Reconcile critical-result, cold-chain, and mortuary task ownership and clock receipts before retrying. No task or patient identifiers are reported.';
  END IF;
END
$care_pathway_human_sla_task_preflight$;

DO $care_pathway_ack_lifecycle_preflight$
DECLARE
  acknowledged_or_completed_incomplete_count INTEGER;
  cancelled_incomplete_count INTEGER;
  actionable_terminal_count INTEGER;
  reopen_ancestor_missing_deadline_count INTEGER;
  invalid_reopen_edge_count INTEGER;
  inconsistent_count INTEGER;
BEGIN
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
           reopen_receipt.prior_due_at_text,
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
                   WHEN jsonb_typeof(
                          predecessor.sla_metadata->'reopen_history'
                        ) = 'array'
                     THEN predecessor.sla_metadata->'reopen_history'
                   ELSE '[]'::jsonb
                 END
               ) WITH ORDINALITY AS history(receipt, position)
         WHERE NULLIF(
                 BTRIM(history.receipt->>'prior_completed_by_task'),
                 ''
                ) = predecessor.task_id::text
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
           AND NULLIF(
                 BTRIM(receipt.metadata->>'superseded_by_task_id'),
                 ''
               ) = chain.task_id::text
           AND NULLIF(BTRIM(receipt.metadata->>'reason'), '')
                 = chain.reopen_reason
      ) AS reciprocal_comment ON TRUE
      JOIN LATERAL (
        SELECT reopen_history.prior_due_at_text
      ) AS reopen_receipt ON TRUE
     WHERE chain.reopened_from_task_id ~ '^[1-9][0-9]*$'
       AND chain.depth < 100
       AND NOT predecessor.task_id = ANY(chain.visited_task_ids)
       AND predecessor.task_id < chain.task_id
       AND predecessor.task_created_at <= chain.task_created_at
       AND reopen_history.match_count = 1
  ), verified_reopen_ancestors AS (
    SELECT DISTINCT
           tenant_id,
           sla_id,
           root_task_id,
           task_id,
           history_match_count,
           comment_match_count,
           prior_due_at_text,
           CASE
             WHEN prior_due_at_text ~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                  AND pg_input_is_valid(
                    prior_due_at_text,
                    'timestamp with time zone'
                  )
               THEN prior_due_at_text::timestamptz
             ELSE NULL
           END AS receipt_prior_due_at
      FROM reopen_chain
     WHERE depth > 1
  )
  SELECT COUNT(*) FILTER (
           WHERE link.task_status = 'in_progress'
             AND link.sla_completed_at IS NULL
         )::integer
         + COUNT(*) FILTER (
           WHERE link.task_status = 'completed'
             AND link.sla_completed_at IS NULL
             AND ancestor.task_id IS NULL
         )::integer,
         COUNT(*) FILTER (
           WHERE link.task_status = 'cancelled'
             AND link.sla_completed_at IS NULL
             AND ancestor.task_id IS NULL
         )::integer,
         COUNT(*) FILTER (
           WHERE link.task_status IN ('open', 'blocked', 'overdue')
             AND NOT (
               link.sla_completed_at IS NULL
               AND link.sla_status IN ('active', 'breached', 'escalated')
             )
         )::integer,
         COUNT(*) FILTER (
           WHERE ancestor.task_id IS NOT NULL
             AND (
               ancestor.history_match_count > 1
               OR (
                 link.task_due_at IS NULL
                 AND ancestor.receipt_prior_due_at IS NULL
               )
               OR (
                 link.task_due_at IS NOT NULL
                 AND ancestor.history_match_count = 1
                 AND (
                   ancestor.receipt_prior_due_at IS NULL
                   OR link.task_due_at IS DISTINCT FROM
                        ancestor.receipt_prior_due_at
                 )
               )
             )
         )::integer,
         COUNT(*) FILTER (
           WHERE link.rule_code = 'critical_result_ack'
             AND link.reopened_from_task_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM verified_reopen_ancestors AS verified_edge
                WHERE verified_edge.tenant_id = link.tenant_id
                  AND verified_edge.sla_id = link.sla_id
                  AND verified_edge.root_task_id = link.task_id
             )
         )::integer
    INTO acknowledged_or_completed_incomplete_count,
         cancelled_incomplete_count,
         actionable_terminal_count,
         reopen_ancestor_missing_deadline_count,
         invalid_reopen_edge_count
    FROM acknowledgement_links AS link
    LEFT JOIN verified_reopen_ancestors AS ancestor
      ON ancestor.tenant_id = link.tenant_id
     AND ancestor.sla_id = link.sla_id
     AND ancestor.task_id = link.task_id;

  inconsistent_count :=
    acknowledged_or_completed_incomplete_count
      + cancelled_incomplete_count
      + actionable_terminal_count
      + reopen_ancestor_missing_deadline_count
      + invalid_reopen_edge_count;

  IF inconsistent_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'migration 580 blocked: %s acknowledgement task/SLA lifecycle pair(s) are inconsistent (acknowledged_or_completed_incomplete=%s, cancelled_incomplete=%s, actionable_terminal=%s, reopen_ancestor_missing_deadline=%s, invalid_reopen_edge=%s)',
        inconsistent_count,
        acknowledged_or_completed_incomplete_count,
        cancelled_incomplete_count,
        actionable_terminal_count,
        reopen_ancestor_missing_deadline_count,
        invalid_reopen_edge_count
      ),
      HINT =
        'Reconcile each critical-result or cold-chain pair from authoritative clinical evidence before retrying. A reopened predecessor needs a unique SLA history receipt and an exact historical deadline; comments and legacy acknowledgement metadata alone are not authorization evidence.';
  END IF;
END
$care_pathway_ack_lifecycle_preflight$;

-- A pre-580 corrected-result sequence can contain several task generations
-- even when the old helper failed to write the successor pointer or wrote a
-- stale SLA.completed_by_task. Once the old clock was overwritten, the prior
-- deadline cannot be inferred from the current SLA. Detect every such edge
-- before backfill instead of silently treating the rows as generation one.
CREATE OR REPLACE FUNCTION care_pathway_assert_legacy_critical_rearm_lineage(
  validation_phase TEXT
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  unproven_generation_count INTEGER;
  stale_completion_pointer_count INTEGER;
  unlinked_predecessor_count INTEGER;
BEGIN
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
    SELECT task.*,
           sla.id AS linked_sla_id,
           sla.status AS sla_status,
           sla.completed_at AS sla_completed_at,
           sla.metadata AS sla_metadata,
           CASE
             WHEN task.metadata->>'acknowledged_at' ~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
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
           NULLIF(
             BTRIM(successor.metadata->>'reopened_from_task_id'),
             ''
           ) AS claimed_predecessor_id,
           NULLIF(BTRIM(successor.metadata->>'reopen_reason'), '')
             AS reopen_reason,
           history_receipt.match_count AS history_match_count,
           history_receipt.prior_due_at_text,
           reciprocal_comment.match_count AS comment_match_count,
           (
             NULLIF(
               BTRIM(successor.metadata->>'reopened_from_task_id'),
               ''
             ) = predecessor.id::text
             AND (
               (
                 history_receipt.match_count = 1
                 AND history_receipt.prior_due_at_text ~
                       '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                 AND pg_input_is_valid(
                       history_receipt.prior_due_at_text,
                       'timestamp with time zone'
                     )
                 AND (
                   predecessor.due_at IS NULL
                   OR predecessor.due_at =
                        history_receipt.prior_due_at_text::timestamptz
                 )
               )
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
                   WHEN jsonb_typeof(
                          predecessor.sla_metadata->'reopen_history'
                        ) = 'array'
                     THEN predecessor.sla_metadata->'reopen_history'
                   ELSE '[]'::jsonb
                 END
               ) AS history(receipt)
         WHERE history.receipt->>'prior_completed_by_task' =
                 predecessor.id::text
           AND (
             history.receipt->>'database_authored_by'
               IS DISTINCT FROM 'migration_580_rolling_compat'
             OR (
               history.receipt->>'compatibility_state' = 'linked'
               AND history.receipt->>'successor_task_id' = successor.id::text
             )
           )
      ) AS history_receipt ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS match_count
          FROM task_comments AS receipt
         WHERE receipt.tenant_id = predecessor.tenant_id
           AND receipt.task_id = predecessor.id
           AND receipt.author_uid IS NULL
           AND receipt.body_kind = 'system_event'
           AND receipt.created_at >= successor.created_at
           AND receipt.metadata->>'superseded_by_task_id' = successor.id::text
           AND NULLIF(BTRIM(receipt.metadata->>'reason'), '') =
                 NULLIF(BTRIM(successor.metadata->>'reopen_reason'), '')
      ) AS reciprocal_comment ON TRUE
  ), successor_assessments AS (
    SELECT edge.tenant_id,
           edge.workflow_sla_instance_id,
           edge.successor_id,
           BOOL_OR(edge.valid_edge) AS has_valid_edge
      FROM candidate_edges AS edge
     GROUP BY edge.tenant_id, edge.workflow_sla_instance_id, edge.successor_id
  )
  SELECT COUNT(*) FILTER (
           WHERE NOT assessment.has_valid_edge
         )::integer,
         COUNT(*) FILTER (
           WHERE assessment.has_valid_edge
             AND sla.completed_at IS NULL
             AND sla.status IN ('active', 'breached', 'escalated')
             AND NULLIF(
                   BTRIM(sla.metadata->>'completed_by_task'),
                   ''
                 ) IS NOT NULL
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
         )::integer
    INTO unproven_generation_count,
         stale_completion_pointer_count
    FROM successor_assessments AS assessment
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = assessment.tenant_id
     AND sla.id = assessment.workflow_sla_instance_id;

  WITH critical_lab_slas AS (
    SELECT sla.id,
           sla.tenant_id,
           sla.patient_uid,
           sla.source_table,
           sla.source_id
      FROM workflow_sla_instances AS sla
      JOIN lab_results AS result
        ON result.tenant_id = sla.tenant_id
       AND result.id::text = sla.source_id
       AND result.patient_uid = sla.patient_uid
     WHERE sla.rule_code = 'critical_result_ack'
       AND sla.source_table = 'lab_result'
  ), linked_successors AS (
    SELECT successor.*,
           sla.id AS linked_sla_id
      FROM tasks AS successor
      JOIN critical_lab_slas AS sla
        ON sla.tenant_id = successor.tenant_id
       AND sla.id::text = LOWER(BTRIM(successor.metadata->>'sla_instance_id'))
       AND successor.patient_uid IS NOT DISTINCT FROM sla.patient_uid
       AND successor.related_resource_type = sla.source_table
       AND successor.related_resource_id = sla.source_id
     WHERE successor.metadata->>'sla_key' = 'critical_result_ack'
  ), terminal_unlinked_predecessors AS (
    SELECT predecessor.*,
           CASE
             WHEN predecessor.metadata->>'acknowledged_at' ~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
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
  )
  SELECT COUNT(*)::integer
    INTO unlinked_predecessor_count
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
     );

  IF unproven_generation_count > 0
     OR stale_completion_pointer_count > 0
     OR unlinked_predecessor_count > 0
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'migration 580 blocked %s: legacy critical-result generations require manual lineage reconciliation (unproven_generation=%s, stale_completed_by_task=%s, terminal_unlinked_predecessor=%s)',
        validation_phase,
        unproven_generation_count,
        stale_completion_pointer_count,
        unlinked_predecessor_count
      ),
      HINT =
        'Preserve every historical task and exact deadline. Reconcile a unique predecessor pointer plus an authenticated SLA history receipt before retrying; a task comment alone cannot prove who stopped the prior clock.';
  END IF;
END;
$$;

SELECT care_pathway_assert_legacy_critical_rearm_lineage('during opening preflight');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM workflow_runs AS run
      JOIN workflow_definitions AS definition
        ON definition.tenant_id = run.tenant_id
       AND definition.id = run.workflow_definition_id
     WHERE run.workflow_definition_id IS NOT NULL
       AND (
         run.workflow_key IS DISTINCT FROM definition.workflow_key
         OR run.workflow_version IS DISTINCT FROM definition.version
       )
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: workflow run definition key/version mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM workflow_runs AS run
     WHERE run.current_step_key IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM workflow_steps AS step
          WHERE step.tenant_id = run.tenant_id
            AND step.workflow_run_id = run.id
            AND step.step_key = run.current_step_key
       )
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: workflow run current_step_key is not in its run';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM workflow_steps
     GROUP BY tenant_id, workflow_run_id, ordering
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: duplicate workflow step ordering within a run';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM workflow_steps
     WHERE status IN ('in_progress', 'blocked')
     GROUP BY tenant_id, workflow_run_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: multiple current workflow steps in one run';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS task
      JOIN workflow_steps AS step
        ON step.tenant_id = task.tenant_id
       AND step.id = task.workflow_step_id
     WHERE task.workflow_run_id IS NOT NULL
       AND task.workflow_step_id IS NOT NULL
       AND step.workflow_run_id IS DISTINCT FROM task.workflow_run_id
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: task workflow step belongs to another run';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks
     WHERE workflow_step_id IS NOT NULL
       AND workflow_run_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: task workflow step is missing its workflow run';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM approvals AS approval
      JOIN tasks AS task
        ON task.tenant_id = approval.tenant_id
       AND task.id = approval.task_id
     WHERE approval.workflow_run_id IS NOT NULL
       AND approval.task_id IS NOT NULL
       AND task.workflow_run_id IS DISTINCT FROM approval.workflow_run_id
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: approval task belongs to another run';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM approvals
     WHERE task_id IS NOT NULL
       AND workflow_run_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: approval workflow link is missing its workflow run';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS child
      JOIN tasks AS parent
        ON parent.tenant_id = child.tenant_id
       AND parent.id = child.parent_task_id
     WHERE child.parent_task_id IS NOT NULL
       AND parent.workflow_run_id IS DISTINCT FROM child.workflow_run_id
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: parent and child task workflow runs differ';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))
     WHERE NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
       AND task.workflow_step_id IS NULL
       AND sla.rule_code NOT IN (
         'critical_result_ack',
         'cold_chain_excursion_ack',
         'mortuary_unclaimed_body'
       )
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: task SLA metadata link has unknown completion semantics';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))
     WHERE NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
       AND NOT (
         (
           task.workflow_step_id IS NOT NULL
           AND sla.source_table IS NOT DISTINCT FROM 'workflow_steps'
           AND sla.source_id IS NOT DISTINCT FROM task.workflow_step_id::text
         )
         OR
         (
           task.workflow_step_id IS NULL
           AND sla.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
           AND NULLIF(BTRIM(task.related_resource_type), '') IS NOT NULL
           AND NULLIF(BTRIM(task.related_resource_id), '') IS NOT NULL
           AND sla.source_table IS NOT DISTINCT FROM task.related_resource_type
           AND sla.source_id IS NOT DISTINCT FROM task.related_resource_id
         )
         OR
         (
           task.workflow_step_id IS NULL
           AND sla.rule_code = 'mortuary_unclaimed_body'
           AND task.related_resource_type IS NOT DISTINCT FROM 'death_record'
           AND NULLIF(BTRIM(task.related_resource_id), '') IS NOT NULL
           AND sla.source_table IS NOT DISTINCT FROM 'death_records'
           AND sla.source_id IS NOT DISTINCT FROM task.related_resource_id
         )
       )
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: task SLA metadata link source does not match its task resource';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))
     WHERE NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
       AND sla.due_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: linked task SLA metadata has no canonical deadline';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))
     WHERE sla.rule_code = 'mortuary_unclaimed_body'
       AND (
         task.related_resource_type IS DISTINCT FROM 'death_record'
         OR NOT EXISTS (
           SELECT 1
             FROM death_records AS death_record
            WHERE death_record.tenant_id = task.tenant_id
              AND death_record.id::text = task.related_resource_id
         )
       )
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: mortuary domain-evidence task has no valid death_record resource';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))
     WHERE sla.rule_code = 'mortuary_unclaimed_body'
       AND task.related_resource_type = 'death_record'
       AND task.status IN ('completed', 'cancelled')
       AND NOT EXISTS (
         SELECT 1
          FROM body_custody_events AS evidence
          WHERE evidence.tenant_id = task.tenant_id
            AND evidence.death_record_id::text = task.related_resource_id
            AND evidence.event_type = 'release'
       )
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: terminal mortuary task has no release evidence and cannot be safely re-armed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM tasks
     WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
       AND related_resource_type IS NOT NULL
       AND related_resource_id IS NOT NULL
     GROUP BY tenant_id, related_resource_type, related_resource_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: duplicate active or overdue task resource';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Supporting keys and exact workflow graph coherence.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_definitions_tenant_identity
  ON workflow_definitions (tenant_id, id, workflow_key, version);

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_runs_tenant_identity
  ON workflow_runs (tenant_id, id, workflow_key, workflow_version);

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_steps_tenant_run_identity
  ON workflow_steps (tenant_id, id, workflow_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_steps_tenant_run_step_identity
  ON workflow_steps (tenant_id, id, workflow_run_id, step_key);

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_steps_tenant_run_key
  ON workflow_steps (tenant_id, workflow_run_id, step_key);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_tenant_run_identity
  ON tasks (tenant_id, id, workflow_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_tenant_id
  ON approvals (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_sla_instances_tenant_id
  ON workflow_sla_instances (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tenant_uid_for_pathways
  ON users (tenant_id, uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_patient_encounters_tenant_patient_for_pathways
  ON patient_encounters (tenant_id, id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_care_teams_tenant_patient_for_pathways
  ON care_teams (tenant_id, id, patient_uid);

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_steps_run_order
  ON workflow_steps (tenant_id, workflow_run_id, ordering);

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_steps_one_current
  ON workflow_steps (tenant_id, workflow_run_id, (TRUE))
  WHERE status IN ('in_progress', 'blocked');

ALTER TABLE users
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

-- This substrate migration does not seed or activate tenant SLA/escalation
-- policy. Each non-default tenant requires owner-approved clocks, recipients,
-- and notification policy before S1b-c activation.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'workflow_runs'::regclass
       AND conname = 'fk_workflow_runs_definition_identity'
  ) THEN
    ALTER TABLE workflow_runs
      ADD CONSTRAINT fk_workflow_runs_definition_identity
      FOREIGN KEY (tenant_id, workflow_definition_id, workflow_key, workflow_version)
      REFERENCES workflow_definitions (tenant_id, id, workflow_key, version)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (workflow_definition_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'workflow_runs'::regclass
       AND conname = 'fk_workflow_runs_current_step'
  ) THEN
    ALTER TABLE workflow_runs
      ADD CONSTRAINT fk_workflow_runs_current_step
      FOREIGN KEY (tenant_id, id, current_step_key)
      REFERENCES workflow_steps (tenant_id, workflow_run_id, step_key)
      ON UPDATE NO ACTION
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tasks'::regclass
       AND conname = 'fk_tasks_workflow_step_same_run'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_workflow_step_same_run
      FOREIGN KEY (tenant_id, workflow_step_id, workflow_run_id)
      REFERENCES workflow_steps (tenant_id, id, workflow_run_id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (workflow_step_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tasks'::regclass
       AND conname = 'fk_tasks_parent_same_run'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_parent_same_run
      FOREIGN KEY (tenant_id, parent_task_id, workflow_run_id)
      REFERENCES tasks (tenant_id, id, workflow_run_id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (parent_task_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'approvals'::regclass
       AND conname = 'fk_approvals_task_same_run'
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT fk_approvals_task_same_run
      FOREIGN KEY (tenant_id, task_id, workflow_run_id)
      REFERENCES tasks (tenant_id, id, workflow_run_id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (task_id);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Typed task/SLA behavior and replay-safe work-item materialisation.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS workflow_sla_instance_id UUID,
  ADD COLUMN IF NOT EXISTS sla_completion_semantics VARCHAR(30) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stage_occurrence_key VARCHAR(200);

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS workflow_step_id INTEGER,
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS decided_by UUID,
  ADD COLUMN IF NOT EXISTS materialization_key VARCHAR(200);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM approvals
     WHERE workflow_step_id IS NOT NULL
       AND workflow_run_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'migration 580 blocked: approval workflow step is missing its workflow run';
  END IF;
END
$$;

UPDATE tasks AS task
   SET workflow_sla_instance_id = sla.id,
       due_at = CASE
         WHEN sla.rule_code = 'critical_result_ack'
              AND task.status IN ('in_progress', 'completed', 'cancelled')
              AND EXISTS (
                SELECT 1
                  FROM tasks AS successor
                 WHERE successor.tenant_id = task.tenant_id
                   AND successor.id > task.id
                   AND successor.created_at >= task.created_at
                   AND successor.related_resource_type
                         IS NOT DISTINCT FROM task.related_resource_type
                   AND successor.related_resource_id
                         IS NOT DISTINCT FROM task.related_resource_id
                   AND NULLIF(
                         BTRIM(successor.metadata->>'reopened_from_task_id'),
                         ''
                       ) = task.id::text
                   AND LOWER(BTRIM(successor.metadata->>'sla_instance_id'))
                         = sla.id::text
              )
           THEN COALESCE(task.due_at, (
             SELECT CASE
                      WHEN matched.prior_due_at_text ~
                             '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                           AND pg_input_is_valid(
                             matched.prior_due_at_text,
                             'timestamp with time zone'
                           )
                        THEN matched.prior_due_at_text::timestamptz
                      ELSE NULL
                    END
               FROM (
                 SELECT COUNT(*)::integer AS match_count,
                        MAX(history.receipt->>'prior_due_at') AS prior_due_at_text
                   FROM jsonb_array_elements(
                          CASE
                            WHEN jsonb_typeof(sla.metadata->'reopen_history') = 'array'
                              THEN sla.metadata->'reopen_history'
                            ELSE '[]'::jsonb
                          END
                        ) AS history(receipt)
                  WHERE NULLIF(
                          BTRIM(history.receipt->>'prior_completed_by_task'),
                          ''
                        ) = task.id::text
               ) AS matched
              WHERE matched.match_count = 1
           ))
         WHEN task.status IN ('open', 'in_progress', 'blocked', 'overdue')
           THEN sla.due_at
         WHEN task.due_at IS NOT NULL
           THEN task.due_at
         ELSE sla.due_at
       END,
       sla_completion_semantics = CASE
         WHEN task.workflow_step_id IS NOT NULL THEN 'acknowledgement'
         WHEN sla.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
           THEN 'acknowledgement'
         WHEN sla.rule_code = 'mortuary_unclaimed_body'
           THEN 'domain_evidence'
       END
  FROM workflow_sla_instances AS sla
 WHERE task.workflow_sla_instance_id IS NULL
   AND NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
   AND sla.tenant_id = task.tenant_id
   AND sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'));

-- PR #607 shipped authenticated acknowledgement receipts before this typed
-- contract. Those rows carry the actor on both the task and the SLA, but the
-- SLA uses the legacy key `acknowledged_by` and PostgreSQL transaction-time
-- NOW() rather than the task's durable JS receipt instant. Normalize only the
-- exact, same-tenant authenticated shape. Malformed or mismatched receipts are
-- intentionally left untouched for the final receipt preflight to reject.
WITH legacy_ack_candidates AS (
  SELECT task.tenant_id,
         task.id AS task_id,
         task.workflow_sla_instance_id AS sla_id,
         task.metadata->>'acknowledged_by' AS actor_text,
         task.metadata->>'acknowledged_via' AS authorization_mode,
         CASE
           WHEN task.metadata->>'acknowledged_at' ~
                  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                AND pg_input_is_valid(
                  task.metadata->>'acknowledged_at',
                  'timestamp with time zone'
                )
             THEN (task.metadata->>'acknowledged_at')::timestamptz
           ELSE NULL
         END AS acknowledged_at,
         sla.started_at,
         sla.due_at,
         sla.status AS previous_status,
         sla.completed_at AS previous_completed_at,
         sla.breached_at AS previous_breached_at,
         sla.metadata AS previous_metadata
    FROM tasks AS task
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
   WHERE task.sla_completion_semantics = 'acknowledgement'
     AND task.status IN ('in_progress', 'completed', 'cancelled')
     AND task.patient_uid IS NOT DISTINCT FROM sla.patient_uid
     AND task.due_at IS NOT NULL
     AND sla.due_at IS NOT NULL
     AND sla.started_at IS NOT NULL
     AND sla.completed_at IS NOT NULL
     AND sla.status IN ('completed', 'breached', 'escalated')
     AND sla.metadata->>'completed_via' = 'task_ack'
     AND sla.metadata->>'completed_by_task' = task.id::text
     AND sla.metadata->>'acknowledged_by' =
           task.metadata->>'acknowledged_by'
     AND task.metadata->>'acknowledged_by' ~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND pg_input_is_valid(task.metadata->>'acknowledged_by', 'uuid')
     AND task.metadata->>'acknowledged_via'
           IN ('assignee', 'role', 'admin', 'override')
     AND EXISTS (
       SELECT 1
         FROM users AS actor
        WHERE actor.tenant_id = task.tenant_id
          AND actor.uid::text = LOWER(task.metadata->>'acknowledged_by')
     )
     AND (
       (
         task.workflow_step_id IS NOT NULL
         AND sla.source_table = 'workflow_steps'
         AND sla.source_id = task.workflow_step_id::text
       )
       OR (
         sla.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
         AND sla.source_table IS NOT DISTINCT FROM task.related_resource_type
         AND sla.source_id IS NOT DISTINCT FROM task.related_resource_id
       )
     )
     AND (
       task.metadata->>'acknowledged_via' <> 'override'
       OR (
         NULLIF(BTRIM(task.metadata->>'acknowledge_override_source'), '')
           IS NOT NULL
         AND NULLIF(BTRIM(task.metadata->>'acknowledge_override_id'), '')
           IS NOT NULL
         AND NULLIF(BTRIM(task.metadata->>'acknowledge_override_reason'), '')
           IS NOT NULL
         AND (
           (
             task.metadata->>'acknowledge_override_source' =
               'patient_access_break_glass'
             AND task.metadata->>'acknowledge_override_id' ~ '^[1-9][0-9]*$'
             AND pg_input_is_valid(
               task.metadata->>'acknowledge_override_id',
               'integer'
             )
             AND EXISTS (
               SELECT 1
                 FROM patient_access_break_glass AS access_override
                WHERE access_override.tenant_id = task.tenant_id
                  AND access_override.id =
                        (task.metadata->>'acknowledge_override_id')::integer
                  AND access_override.patient_uid = task.patient_uid
                  AND access_override.actor_uid::text =
                        LOWER(task.metadata->>'acknowledged_by')
                  AND access_override.reason =
                        task.metadata->>'acknowledge_override_reason'
             )
           )
           OR (
             task.metadata->>'acknowledge_override_source' =
               'cold_chain_excursion_ack'
             AND task.related_resource_type = 'cold_chain_excursions'
             AND task.related_resource_id =
                   task.metadata->>'acknowledge_override_id'
           )
         )
       )
     )
), normalizable_legacy_acks AS (
  SELECT candidate.*,
         GREATEST(candidate.acknowledged_at, candidate.started_at)
           AS canonical_completed_at
    FROM legacy_ack_candidates AS candidate
   WHERE candidate.acknowledged_at IS NOT NULL
)
UPDATE workflow_sla_instances AS sla
   SET status = CASE
         WHEN normalized.previous_status = 'escalated' THEN 'escalated'
         WHEN normalized.due_at IS NOT NULL
              AND normalized.canonical_completed_at > normalized.due_at
           THEN 'breached'
         ELSE 'completed'
       END,
       completed_at = normalized.canonical_completed_at,
       breached_at = CASE
         WHEN normalized.due_at IS NOT NULL
              AND normalized.canonical_completed_at > normalized.due_at
           THEN COALESCE(normalized.previous_breached_at, normalized.due_at)
         WHEN normalized.previous_status = 'escalated'
           THEN normalized.previous_breached_at
         ELSE NULL
       END,
       metadata = COALESCE(sla.metadata, '{}'::jsonb)
         || jsonb_build_object(
              'completed_by', normalized.actor_text,
              'care_pathway_migration_580_reconciliation',
              COALESCE(
                CASE
                  WHEN jsonb_typeof(
                         sla.metadata->'care_pathway_migration_580_reconciliation'
                       ) = 'object'
                    THEN sla.metadata->'care_pathway_migration_580_reconciliation'
                  ELSE '{}'::jsonb
                END,
                '{}'::jsonb
              ) || jsonb_build_object(
                'legacy_task_ack_receipt', jsonb_build_object(
                  'normalized_at', NOW(),
                  'task_id', normalized.task_id,
                  'authorization_mode', normalized.authorization_mode,
                  'previous_status', normalized.previous_status,
                  'previous_completed_at', normalized.previous_completed_at,
                  'previous_breached_at', normalized.previous_breached_at,
                  'previous_acknowledged_by',
                    normalized.previous_metadata->'acknowledged_by',
                  'previous_completed_by',
                    normalized.previous_metadata->'completed_by'
                )
              )
            ),
       updated_at = NOW()
  FROM normalizable_legacy_acks AS normalized
 WHERE sla.tenant_id = normalized.tenant_id
   AND sla.id = normalized.sla_id;

WITH mortuary_links AS (
  SELECT task.tenant_id,
         task.id AS task_id,
         task.status AS task_status,
         task.workflow_sla_instance_id AS sla_id,
         release_event.id AS release_event_id,
         release_event.event_at AS release_event_at,
         release_event.created_at AS release_created_at
    FROM tasks AS task
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
     AND sla.rule_code = 'mortuary_unclaimed_body'
    LEFT JOIN LATERAL (
      SELECT evidence.id, evidence.event_at, evidence.created_at
        FROM body_custody_events AS evidence
       WHERE evidence.tenant_id = task.tenant_id
         AND evidence.death_record_id::text = task.related_resource_id
         AND evidence.event_type = 'release'
       ORDER BY evidence.event_at, evidence.id
       LIMIT 1
    ) AS release_event ON TRUE
   WHERE task.sla_completion_semantics = 'domain_evidence'
     AND task.related_resource_type = 'death_record'
     AND EXISTS (
       SELECT 1
         FROM death_records AS death_record
        WHERE death_record.tenant_id = task.tenant_id
          AND death_record.id::text = task.related_resource_id
     )
), reconciled AS (
  SELECT link.*,
         sla.due_at,
         sla.metadata AS previous_metadata
    FROM mortuary_links AS link
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = link.tenant_id
     AND sla.id = link.sla_id
)
UPDATE workflow_sla_instances AS sla
   SET status = CASE
         WHEN reconciled.release_event_id IS NOT NULL
              AND sla.status = 'escalated'
           THEN 'escalated'
         WHEN reconciled.release_event_id IS NOT NULL
              AND sla.due_at IS NOT NULL
              AND reconciled.release_created_at > sla.due_at
           THEN 'breached'
         WHEN reconciled.release_event_id IS NOT NULL
           THEN 'completed'
         WHEN sla.due_at IS NOT NULL AND sla.due_at <= NOW()
           THEN CASE
             WHEN sla.status = 'escalated' THEN 'escalated'
             ELSE 'breached'
           END
         ELSE 'active'
       END,
       completed_at = CASE
         WHEN reconciled.release_event_id IS NOT NULL
           THEN reconciled.release_created_at
         ELSE NULL
       END,
       breached_at = CASE
         WHEN reconciled.release_event_id IS NOT NULL
              AND sla.due_at IS NOT NULL
              AND reconciled.release_created_at > sla.due_at
           THEN COALESCE(sla.breached_at, sla.due_at)
         WHEN reconciled.release_event_id IS NULL
              AND sla.due_at IS NOT NULL
              AND sla.due_at <= NOW()
           THEN COALESCE(sla.breached_at, sla.due_at)
         ELSE NULL
       END,
       metadata = (
         COALESCE(sla.metadata, '{}'::jsonb)
           - 'completed_via'
           - 'completed_by_task'
           - 'completed_by'
           - 'completion_evidence'
       )
       || jsonb_build_object(
            'care_pathway_migration_580_reconciliation',
            jsonb_build_object(
              'reconciled_at', NOW(),
              'previous_completed_via', sla.metadata->'completed_via',
              'previous_completed_by_task', sla.metadata->'completed_by_task',
              'previous_completed_by', sla.metadata->'completed_by',
              'previous_completion_evidence', sla.metadata->'completion_evidence'
            )
          )
       || CASE WHEN reconciled.release_event_id IS NOT NULL
            THEN jsonb_build_object(
              'completed_via', 'domain_evidence',
              'completed_by_task', reconciled.task_id,
              'completion_evidence', jsonb_build_object(
                'kind', 'mortuary_body_release',
                'resource_type', 'body_custody_event',
                'resource_id', reconciled.release_event_id::text,
                'occurred_at', reconciled.release_event_at,
                'recorded_at', reconciled.release_created_at
              )
            )
            ELSE '{}'::jsonb
          END,
       updated_at = NOW()
  FROM reconciled
 WHERE sla.tenant_id = reconciled.tenant_id
   AND sla.id = reconciled.sla_id;

WITH mortuary_task_releases AS (
  SELECT task.tenant_id,
         task.id AS task_id,
         task.status AS previous_status,
         task.completed_at AS previous_completed_at,
         release_event.id AS release_event_id,
         release_event.event_at AS release_event_at,
         release_event.created_at AS release_created_at
    FROM tasks AS task
    JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
     AND sla.rule_code = 'mortuary_unclaimed_body'
    JOIN LATERAL (
      SELECT evidence.id, evidence.event_at, evidence.created_at
        FROM body_custody_events AS evidence
       WHERE evidence.tenant_id = task.tenant_id
         AND evidence.death_record_id::text = task.related_resource_id
         AND evidence.event_type = 'release'
       ORDER BY evidence.event_at, evidence.id
       LIMIT 1
    ) AS release_event ON TRUE
   WHERE task.sla_completion_semantics = 'domain_evidence'
     AND task.related_resource_type = 'death_record'
     AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND EXISTS (
       SELECT 1
         FROM death_records AS death_record
        WHERE death_record.tenant_id = task.tenant_id
          AND death_record.id::text = task.related_resource_id
     )
)
UPDATE tasks AS task
   SET status = 'completed',
       completed_at = release.release_created_at,
       metadata = COALESCE(task.metadata, '{}'::jsonb)
         || jsonb_build_object(
              'care_pathway_migration_580_reconciliation',
              jsonb_build_object(
                'reconciled_at', NOW(),
                'reason', 'mortuary_release_evidence',
                'previous_status', release.previous_status,
                'previous_completed_at', release.previous_completed_at,
                'release_event_id', release.release_event_id::text,
                'release_event_at', release.release_event_at,
                'release_recorded_at', release.release_created_at
              )
            ),
       updated_at = NOW()
  FROM mortuary_task_releases AS release
 WHERE task.tenant_id = release.tenant_id
   AND task.id = release.task_id;

-- Release 1 of the rolling compatibility bridge deliberately retains both
-- legacy aliases. Old replicas still read metadata.sla_instance_id to stop the
-- clock and metadata.sla_key to match escalation rules. The trigger below
-- keeps them equal to the typed contract for mixed-version traffic. Remove the
-- aliases and trigger only in a later migration after every old replica has
-- been proven drained.
UPDATE tasks AS task
   SET metadata = COALESCE(task.metadata, '{}'::jsonb)
       || jsonb_build_object(
            'sla_instance_id', task.workflow_sla_instance_id::text
          )
       || CASE
            WHEN NULLIF(BTRIM(task.metadata->>'sla_key'), '') IS NULL
              THEN jsonb_build_object('sla_key', sla.rule_code)
            ELSE '{}'::jsonb
          END
  FROM workflow_sla_instances AS sla
 WHERE task.workflow_sla_instance_id IS NOT NULL
   AND sla.tenant_id = task.tenant_id
   AND sla.id = task.workflow_sla_instance_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tasks'::regclass
       AND conname = 'tasks_sla_completion_semantics_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_sla_completion_semantics_check
      CHECK (sla_completion_semantics IN ('none', 'acknowledgement', 'domain_evidence'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tasks'::regclass
       AND conname = 'tasks_sla_completion_link_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_sla_completion_link_check
      CHECK (
        (sla_completion_semantics = 'none' AND workflow_sla_instance_id IS NULL)
        OR
        (sla_completion_semantics IN ('acknowledgement', 'domain_evidence')
         AND workflow_sla_instance_id IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tasks'::regclass
       AND conname = 'tasks_workflow_sla_legacy_alias_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_workflow_sla_legacy_alias_check
      CHECK (
        (
          workflow_sla_instance_id IS NULL
          AND NULLIF(BTRIM(metadata->>'sla_instance_id'), '') IS NULL
        )
        OR
        (
          workflow_sla_instance_id IS NOT NULL
          AND metadata->>'sla_instance_id' = workflow_sla_instance_id::text
          AND NULLIF(BTRIM(metadata->>'sla_key'), '') IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tasks'::regclass
       AND conname = 'fk_tasks_workflow_sla_tenant'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT fk_tasks_workflow_sla_tenant
      FOREIGN KEY (tenant_id, workflow_sla_instance_id)
      REFERENCES workflow_sla_instances (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'approvals'::regclass
       AND conname = 'fk_approvals_workflow_step_tenant'
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT fk_approvals_workflow_step_tenant
      FOREIGN KEY (tenant_id, workflow_step_id)
      REFERENCES workflow_steps (tenant_id, id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (workflow_step_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'approvals'::regclass
       AND conname = 'fk_approvals_workflow_step_same_run'
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT fk_approvals_workflow_step_same_run
      FOREIGN KEY (tenant_id, workflow_step_id, workflow_run_id)
      REFERENCES workflow_steps (tenant_id, id, workflow_run_id)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (workflow_step_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'approvals'::regclass
       AND conname = 'fk_approvals_created_by_tenant'
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT fk_approvals_created_by_tenant
      FOREIGN KEY (tenant_id, created_by)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (created_by);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'approvals'::regclass
       AND conname = 'fk_approvals_decided_by_tenant'
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT fk_approvals_decided_by_tenant
      FOREIGN KEY (tenant_id, decided_by)
      REFERENCES users (tenant_id, uid)
      ON UPDATE NO ACTION
      ON DELETE SET NULL (decided_by);
  END IF;
END
$$;

-- Preserve the window an old release would otherwise overwrite when it re-arms
-- an acknowledged critical lab result. The trigger accepts only a canonical
-- predecessor and corrective sign-off, validates the history already written
-- by the new helper, and creates a pending database-owned generation only for
-- the old helper. The pending generation is finalized after a replacement task
-- is actually inserted; an ON CONFLICT DO NOTHING path therefore cannot consume
-- it.
CREATE OR REPLACE FUNCTION workflow_sla_preserve_critical_rearm_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor_id_text TEXT;
  predecessor_id INTEGER;
  predecessor tasks%ROWTYPE;
  corrective_signoff RECORD;
  old_history_value JSONB;
  history_value JSONB;
  receipt_identity JSONB;
  canonical_receipt JSONB;
  old_history_length INTEGER;
  exact_receipt_count INTEGER;
  compatibility_receipt JSONB;
BEGIN
  IF OLD.rule_code IS DISTINCT FROM 'critical_result_ack'
     OR OLD.completed_at IS NULL
     OR OLD.status NOT IN ('completed', 'breached', 'escalated')
     OR NEW.status IS DISTINCT FROM 'active'
     OR NEW.completed_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.rule_code IS DISTINCT FROM OLD.rule_code
     OR NEW.source_table IS DISTINCT FROM OLD.source_table
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
     OR OLD.patient_uid IS NULL
     OR OLD.due_at IS NULL
     OR NEW.started_at IS NULL
     OR NEW.due_at IS NULL
  THEN
    RAISE EXCEPTION
      'critical-result SLA rearm must preserve one exact obligation and both clock windows'
      USING ERRCODE = 'check_violation';
  END IF;

  predecessor_id_text :=
    NULLIF(BTRIM(COALESCE(OLD.metadata, '{}'::jsonb)->>'completed_by_task'), '');
  IF predecessor_id_text IS NULL
     OR predecessor_id_text !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(predecessor_id_text, 'integer')
  THEN
    RAISE EXCEPTION
      'critical-result SLA rearm is missing its canonical completed predecessor'
      USING ERRCODE = 'check_violation';
  END IF;
  predecessor_id := predecessor_id_text::integer;

  SELECT task.*
    INTO predecessor
    FROM tasks AS task
   WHERE task.tenant_id = OLD.tenant_id
     AND task.id = predecessor_id
     AND task.workflow_sla_instance_id = OLD.id
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.status IN ('in_progress', 'completed', 'cancelled')
     AND task.related_resource_type IS NOT DISTINCT FROM OLD.source_table
     AND task.related_resource_id IS NOT DISTINCT FROM OLD.source_id
     AND task.patient_uid IS NOT DISTINCT FROM OLD.patient_uid
     AND task.due_at IS NOT DISTINCT FROM OLD.due_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'critical-result SLA rearm predecessor does not match its tenant, clock, patient, or resource'
      USING ERRCODE = 'check_violation';
  END IF;

  receipt_identity :=
    jsonb_build_object(
      'prior_status', OLD.status,
      'prior_started_at', OLD.started_at,
      'prior_due_at', OLD.due_at,
      'prior_completed_at', OLD.completed_at,
      'prior_breached_at', OLD.breached_at,
      'prior_escalated_at', OLD.escalated_at,
      'prior_completed_by_task', predecessor.id
    )
    || jsonb_strip_nulls(jsonb_build_object(
         'prior_completed_via', OLD.metadata->'completed_via',
         'prior_completed_by', OLD.metadata->'completed_by',
         'prior_acknowledged_by', OLD.metadata->'acknowledged_by',
         'prior_completion_evidence', OLD.metadata->'completion_evidence'
       ));
  old_history_value := CASE
    WHEN jsonb_typeof(OLD.metadata->'reopen_history') = 'array'
      THEN OLD.metadata->'reopen_history'
    ELSE '[]'::jsonb
  END;
  history_value := CASE
    WHEN jsonb_typeof(NEW.metadata->'reopen_history') = 'array'
      THEN NEW.metadata->'reopen_history'
    ELSE '[]'::jsonb
  END;
  old_history_length := jsonb_array_length(old_history_value);

  SELECT COUNT(*)::integer
    INTO exact_receipt_count
    FROM jsonb_array_elements(history_value) AS history(receipt)
   WHERE history.receipt @> receipt_identity;

  IF exact_receipt_count > 1 THEN
    RAISE EXCEPTION
      'critical-result SLA rearm contains duplicate predecessor history receipts'
      USING ERRCODE = 'check_violation';
  END IF;

  IF exact_receipt_count = 1
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(history_value) AS history(receipt)
        WHERE history.receipt @> receipt_identity
          AND history.receipt->>'database_authored_by' =
                'migration_580_rolling_compat'
          AND NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(
                     CASE
                       WHEN jsonb_typeof(OLD.metadata->'reopen_history') = 'array'
                         THEN OLD.metadata->'reopen_history'
                       ELSE '[]'::jsonb
                     END
                   ) AS prior_history(receipt)
             WHERE prior_history.receipt->>'generation_id' =
                     history.receipt->>'generation_id'
          )
     )
  THEN
    RAISE EXCEPTION
      'critical-result SLA rearm cannot claim reserved database compatibility provenance'
      USING ERRCODE = 'check_violation';
  END IF;

  IF exact_receipt_count = 1 THEN
    IF jsonb_array_length(history_value) <> old_history_length + 1
       OR (history_value - old_history_length) IS DISTINCT FROM old_history_value
       OR NOT ((history_value->old_history_length) @> receipt_identity)
    THEN
      RAISE EXCEPTION
        'critical-result SLA rearm history must preserve the prior array and append one receipt'
        USING ERRCODE = 'check_violation';
    END IF;

    canonical_receipt := history_value->old_history_length;
    IF NULLIF(BTRIM(canonical_receipt->>'reopen_reason'), '') IS NULL
       OR canonical_receipt->'reopened_at' IS DISTINCT FROM to_jsonb(NEW.started_at)
    THEN
      RAISE EXCEPTION
        'critical-result SLA rearm receipt requires its exact clock start and nonblank reason'
        USING ERRCODE = 'check_violation';
    END IF;
    canonical_receipt := canonical_receipt || jsonb_build_object(
      'rearmed_started_at', NEW.started_at,
      'rearmed_due_at', NEW.due_at
    );
    history_value := jsonb_set(
      history_value,
      ARRAY[old_history_length::text],
      canonical_receipt,
      false
    );
  ELSIF history_value IS DISTINCT FROM old_history_value THEN
    RAISE EXCEPTION
      'legacy critical-result SLA rearm must preserve existing history unchanged'
      USING ERRCODE = 'check_violation';
  END IF;

  IF exact_receipt_count = 0 THEN
    IF OLD.source_table IS DISTINCT FROM 'lab_result'
       OR OLD.source_id !~ '^[1-9][0-9]*$'
       OR NOT pg_input_is_valid(OLD.source_id, 'integer')
    THEN
      RAISE EXCEPTION
        'legacy critical-result SLA rearm source is not a canonical lab result'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT signoff.id,
           signoff.decision,
           signoff.signed_at
      INTO corrective_signoff
      FROM lab_pathologist_signoffs AS signoff
      JOIN lab_results AS result
        ON result.tenant_id = signoff.tenant_id
       AND result.id = OLD.source_id::integer
       AND result.patient_uid = OLD.patient_uid
     WHERE signoff.tenant_id = OLD.tenant_id
       AND signoff.decision IN ('corrected', 'amended')
       AND result.id = ANY(signoff.result_ids)
       AND signoff.signed_at > OLD.completed_at
       AND signoff.signed_at <= NEW.started_at
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(history_value) AS used(receipt)
          WHERE used.receipt->'domain_evidence'->>'signoff_id' = signoff.id::text
       )
     ORDER BY signoff.signed_at DESC, signoff.id DESC
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'legacy critical-result SLA rearm has no fresh corrected or amended lab sign-off'
        USING ERRCODE = 'check_violation';
    END IF;

    compatibility_receipt :=
      receipt_identity
      || jsonb_build_object(
           'generation_id', gen_random_uuid(),
           'database_authored_by', 'migration_580_rolling_compat',
           'compatibility_state', 'pending_successor',
           'reopened_at', NEW.started_at,
           'reopen_reason', 'lab_signoff_' || corrective_signoff.decision,
           'rearmed_started_at', NEW.started_at,
           'rearmed_due_at', NEW.due_at,
           'domain_evidence', jsonb_build_object(
             'kind', 'lab_corrective_signoff',
             'signoff_id', corrective_signoff.id,
             'decision', corrective_signoff.decision,
             'signed_at', corrective_signoff.signed_at,
             'result_id', OLD.source_id,
             'patient_uid', OLD.patient_uid
           )
         );
    history_value := history_value || jsonb_build_array(compatibility_receipt);
  END IF;

  NEW.escalated_at := NULL;
  NEW.metadata := (
      COALESCE(NEW.metadata, '{}'::jsonb)
        - 'completed_via'
        - 'completed_by_task'
        - 'completed_by'
        - 'acknowledged_at'
        - 'acknowledged_by'
        - 'acknowledged_via'
        - 'completion_evidence'
    ) || jsonb_build_object('reopen_history', history_value);
  IF exact_receipt_count = 0 THEN
    NEW.metadata := NEW.metadata || jsonb_build_object(
      'reopened_at', NEW.started_at,
      'reopen_reason', 'lab_signoff_' || corrective_signoff.decision
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_sla_preserve_critical_rearm_history
  ON workflow_sla_instances;
CREATE TRIGGER trg_workflow_sla_preserve_critical_rearm_history
  BEFORE UPDATE OF
    tenant_id,
    rule_code,
    source_table,
    source_id,
    patient_uid,
    status,
    completed_at,
    started_at,
    due_at,
    breached_at,
    escalated_at,
    metadata
  ON workflow_sla_instances
  FOR EACH ROW EXECUTE FUNCTION workflow_sla_preserve_critical_rearm_history();

-- Two-release mixed-version bridge. Release 1 accepts the three known legacy
-- producers, promotes a real metadata-only link into the typed contract, and
-- writes the legacy aliases back for replicas that have not yet deployed the
-- typed reader. A recognized old producer with no clock is made explicitly
-- degraded; no SLA row or deadline is fabricated. Unknown or contradictory
-- claims fail closed. Remove this function and both triggers only after a
-- later deployment has proven every legacy replica drained.
CREATE OR REPLACE FUNCTION tasks_sync_workflow_sla_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  metadata_value JSONB;
  legacy_instance_text TEXT;
  legacy_key TEXT;
  requested_key TEXT;
  policy_status TEXT;
  legacy_instance_id UUID;
  resolved_instance_id UUID;
  sla_record RECORD;
  expected_semantics TEXT;
  promoting_legacy BOOLEAN := FALSE;
BEGIN
  metadata_value := COALESCE(NEW.metadata, '{}'::jsonb);

  IF jsonb_typeof(metadata_value) IS DISTINCT FROM 'object' THEN
    IF NEW.workflow_sla_instance_id IS NOT NULL
       OR NEW.sla_completion_semantics IS DISTINCT FROM 'none'
    THEN
      RAISE EXCEPTION
        'typed task SLA metadata must be a JSON object'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  legacy_instance_text :=
    NULLIF(BTRIM(metadata_value->>'sla_instance_id'), '');
  legacy_key := NULLIF(BTRIM(metadata_value->>'sla_key'), '');
  requested_key := NULLIF(BTRIM(metadata_value->>'requested_sla_key'), '');
  policy_status := NULLIF(BTRIM(metadata_value->>'sla_policy_status'), '');

  IF legacy_instance_text IS NOT NULL THEN
    IF legacy_instance_text !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION
        'task SLA legacy instance alias must be a canonical UUID'
        USING ERRCODE = 'check_violation';
    END IF;
    legacy_instance_id := LOWER(legacy_instance_text)::uuid;
  END IF;

  IF NEW.workflow_sla_instance_id IS NOT NULL
     AND legacy_instance_id IS NOT NULL
     AND NEW.workflow_sla_instance_id IS DISTINCT FROM legacy_instance_id
  THEN
    RAISE EXCEPTION
      'task SLA typed link and legacy instance alias must identify the same instance'
      USING ERRCODE = 'check_violation';
  END IF;

  resolved_instance_id :=
    COALESCE(NEW.workflow_sla_instance_id, legacy_instance_id);
  promoting_legacy :=
    NEW.workflow_sla_instance_id IS NULL AND legacy_instance_id IS NOT NULL;

  IF TG_OP = 'UPDATE'
     AND OLD.workflow_sla_instance_id IS NOT NULL
     AND resolved_instance_id IS NULL
  THEN
    RAISE EXCEPTION
      'typed task SLA links cannot be detached during rolling compatibility'
      USING ERRCODE = 'check_violation';
  END IF;

  IF resolved_instance_id IS NULL THEN
    IF NEW.sla_completion_semantics IS DISTINCT FROM 'none' THEN
      RAISE EXCEPTION
        'unlinked task cannot declare SLA completion semantics'
        USING ERRCODE = 'check_violation';
    END IF;

    IF legacy_key IS NULL
       AND requested_key IS NULL
       AND policy_status IS NULL
    THEN
      NEW.metadata := metadata_value - 'sla_instance_id';
      RETURN NEW;
    END IF;

    IF NEW.workflow_step_id IS NOT NULL
       OR NEW.due_at IS NOT NULL
       OR NULLIF(BTRIM(NEW.related_resource_type), '') IS NULL
       OR NULLIF(BTRIM(NEW.related_resource_id), '') IS NULL
    THEN
      RAISE EXCEPTION
        'degraded task SLA claim must be unlinked, deadline-free, and resource-bound'
        USING ERRCODE = 'check_violation';
    END IF;

    IF requested_key IS NOT NULL OR policy_status IS NOT NULL THEN
      IF requested_key NOT IN (
           'critical_result_ack',
           'cold_chain_excursion_ack',
           'mortuary_unclaimed_body'
         )
         OR policy_status IS DISTINCT FROM 'missing'
         OR (legacy_key IS NOT NULL AND legacy_key IS DISTINCT FROM requested_key)
      THEN
        RAISE EXCEPTION
          'degraded task SLA policy marker is unknown or inconsistent'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF legacy_key NOT IN (
           'critical_result_ack',
           'cold_chain_excursion_ack',
           'mortuary_unclaimed_body'
         )
      THEN
        RAISE EXCEPTION
          'unlinked task SLA legacy claim is not a recognized compatibility contract'
          USING ERRCODE = 'check_violation';
      END IF;
      requested_key := legacy_key;
      policy_status := 'missing';
    END IF;

    IF requested_key = 'cold_chain_excursion_ack'
       AND NEW.related_resource_type IS DISTINCT FROM 'cold_chain_excursions'
    THEN
      RAISE EXCEPTION
        'degraded cold-chain task must reference its excursion'
        USING ERRCODE = 'check_violation';
    END IF;

    IF requested_key = 'mortuary_unclaimed_body'
       AND (
         NEW.related_resource_type IS DISTINCT FROM 'death_record'
         OR NOT EXISTS (
           SELECT 1
             FROM death_records AS death_record
            WHERE death_record.tenant_id = NEW.tenant_id
              AND death_record.id::text = NEW.related_resource_id
         )
       )
    THEN
      RAISE EXCEPTION
        'degraded mortuary task must reference a same-tenant death record'
        USING ERRCODE = 'check_violation';
    END IF;

    metadata_value :=
      (metadata_value - 'sla_instance_id' - 'requested_sla_key' - 'sla_policy_status')
      || jsonb_build_object(
           'requested_sla_key', requested_key,
           'sla_policy_status', 'missing'
         );
    IF requested_key = 'mortuary_unclaimed_body' THEN
      metadata_value := metadata_value
        || jsonb_build_object('sla_key', 'mortuary_unclaimed_body');
    ELSE
      metadata_value := metadata_value - 'sla_key';
    END IF;
    NEW.metadata := metadata_value;
    RETURN NEW;
  END IF;

  IF metadata_value ? 'requested_sla_key'
     OR metadata_value ? 'sla_policy_status'
  THEN
    RAISE EXCEPTION
      'linked task SLA cannot retain a missing-policy marker'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT sla.id,
         sla.rule_code,
         sla.source_table,
         sla.source_id,
         sla.status,
         sla.due_at,
         sla.completed_at,
         sla.started_at,
         sla.patient_uid,
         sla.metadata
    INTO sla_record
    FROM workflow_sla_instances AS sla
   WHERE sla.tenant_id = NEW.tenant_id
     AND sla.id = resolved_instance_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'task SLA compatibility link does not resolve inside its tenant'
      USING ERRCODE = 'check_violation';
  END IF;

  IF sla_record.due_at IS NULL THEN
    RAISE EXCEPTION
      'typed task SLA must have a canonical deadline'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.workflow_step_id IS NOT NULL THEN
    IF promoting_legacy THEN
      expected_semantics := 'acknowledgement';
    ELSIF NEW.sla_completion_semantics IN ('acknowledgement', 'domain_evidence') THEN
      expected_semantics := NEW.sla_completion_semantics;
    ELSE
      RAISE EXCEPTION
        'typed workflow-step task must declare acknowledgement or domain-evidence completion'
        USING ERRCODE = 'check_violation';
    END IF;
    IF sla_record.source_table IS DISTINCT FROM 'workflow_steps'
       OR sla_record.source_id IS DISTINCT FROM NEW.workflow_step_id::text
    THEN
      RAISE EXCEPTION
        'task and linked SLA must describe the same obligation'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF sla_record.rule_code IN (
          'critical_result_ack',
          'cold_chain_excursion_ack'
        )
  THEN
    expected_semantics := 'acknowledgement';
    IF NULLIF(BTRIM(NEW.related_resource_type), '') IS NULL
       OR NULLIF(BTRIM(NEW.related_resource_id), '') IS NULL
       OR sla_record.source_table IS DISTINCT FROM NEW.related_resource_type
       OR sla_record.source_id IS DISTINCT FROM NEW.related_resource_id
    THEN
      RAISE EXCEPTION
        'task and linked SLA must describe the same obligation'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF sla_record.rule_code = 'mortuary_unclaimed_body' THEN
    expected_semantics := 'domain_evidence';
    IF NEW.related_resource_type IS DISTINCT FROM 'death_record'
       OR NULLIF(BTRIM(NEW.related_resource_id), '') IS NULL
       OR sla_record.source_table IS DISTINCT FROM 'death_records'
       OR sla_record.source_id IS DISTINCT FROM NEW.related_resource_id
       OR NOT EXISTS (
         SELECT 1
           FROM death_records AS death_record
          WHERE death_record.tenant_id = NEW.tenant_id
            AND death_record.id::text = NEW.related_resource_id
       )
    THEN
      RAISE EXCEPTION
        'task and linked SLA must describe the same obligation'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION
      'task SLA compatibility link is not a recognized completion contract'
      USING ERRCODE = 'check_violation';
  END IF;

  IF legacy_key IS NOT NULL
     AND legacy_key IS DISTINCT FROM sla_record.rule_code
  THEN
    RAISE EXCEPTION
      'task SLA legacy key must equal the linked SLA rule code'
      USING ERRCODE = 'check_violation';
  END IF;

  IF promoting_legacy THEN
    NEW.workflow_sla_instance_id := sla_record.id;
    NEW.sla_completion_semantics := expected_semantics;
    NEW.due_at := sla_record.due_at;
  ELSIF NEW.sla_completion_semantics IS DISTINCT FROM expected_semantics THEN
    RAISE EXCEPTION
      'typed task SLA completion semantics do not match the linked obligation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND NEW.status = 'cancelled'
     AND expected_semantics IN ('acknowledgement', 'domain_evidence')
     AND sla_record.completed_at IS NULL
     AND sla_record.status IN ('active', 'breached', 'escalated')
  THEN
    RAISE EXCEPTION
      'linked clinical task cannot be cancelled while its SLA clock is incomplete'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.metadata := metadata_value
    || jsonb_build_object(
         'sla_instance_id', sla_record.id::text,
         'sla_key', sla_record.rule_code
       );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_insert ON tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_sync_workflow_sla_compat();

DROP TRIGGER IF EXISTS trg_tasks_workflow_sla_compat_update ON tasks;
CREATE TRIGGER trg_tasks_workflow_sla_compat_update
  BEFORE UPDATE OF
    tenant_id,
    status,
    workflow_step_id,
    related_resource_type,
    related_resource_id,
    workflow_sla_instance_id,
    sla_completion_semantics,
    due_at,
    metadata
  ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_sync_workflow_sla_compat();

-- During the two-release window a PR #607 replica still writes an authorized
-- task receipt first, then completes the SLA with legacy `acknowledged_by` and
-- an independent PostgreSQL NOW(). Promote only that exact authenticated shape
-- to the canonical receipt in the same SLA statement. The task read is plain
-- MVCC (not row-locking): the old writer already owns the task before taking
-- the SLA lock, so introducing the reverse lock order here would deadlock.
CREATE OR REPLACE FUNCTION workflow_sla_normalize_rolling_legacy_ack()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_id_text TEXT;
  task_id_value INTEGER;
  acknowledged_task tasks%ROWTYPE;
  acknowledged_at_text TEXT;
  acknowledged_at_value TIMESTAMPTZ;
  actor_text TEXT;
  authorization_mode TEXT;
  authorization_valid BOOLEAN := FALSE;
  normalization_history JSONB;
  normalization_receipt JSONB;
BEGIN
  IF OLD.completed_at IS NOT NULL
     OR OLD.status NOT IN ('active', 'breached', 'escalated')
     OR NEW.completed_at IS NULL
     OR NEW.started_at IS NULL
     OR NEW.status NOT IN ('completed', 'breached', 'escalated')
     OR NEW.metadata->>'completed_via' IS DISTINCT FROM 'task_ack'
     OR NULLIF(BTRIM(NEW.metadata->>'completed_by'), '') IS NOT NULL
     OR NULLIF(BTRIM(NEW.metadata->>'acknowledged_by'), '') IS NULL
  THEN
    RETURN NEW;
  END IF;

  task_id_text :=
    NULLIF(BTRIM(NEW.metadata->>'completed_by_task'), '');
  IF task_id_text IS NULL
     OR task_id_text !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(task_id_text, 'integer')
  THEN
    RETURN NEW;
  END IF;
  task_id_value := task_id_text::integer;

  SELECT task.*
    INTO acknowledged_task
    FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.id = task_id_value
     AND task.workflow_sla_instance_id = NEW.id
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.status IN ('in_progress', 'completed', 'cancelled')
     AND task.patient_uid IS NOT DISTINCT FROM NEW.patient_uid
     AND task.due_at IS NOT NULL
     AND task.due_at IS NOT DISTINCT FROM NEW.due_at
     AND (
       (
         task.workflow_step_id IS NOT NULL
         AND NEW.source_table = 'workflow_steps'
         AND NEW.source_id = task.workflow_step_id::text
       )
       OR (
         NEW.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
         AND NEW.source_table IS NOT DISTINCT FROM task.related_resource_type
         AND NEW.source_id IS NOT DISTINCT FROM task.related_resource_id
       )
     );
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  acknowledged_at_text :=
    NULLIF(BTRIM(acknowledged_task.metadata->>'acknowledged_at'), '');
  actor_text :=
    NULLIF(BTRIM(acknowledged_task.metadata->>'acknowledged_by'), '');
  authorization_mode :=
    NULLIF(BTRIM(acknowledged_task.metadata->>'acknowledged_via'), '');
  IF acknowledged_at_text IS NULL
     OR acknowledged_at_text !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR NOT pg_input_is_valid(
          acknowledged_at_text,
          'timestamp with time zone'
        )
     OR actor_text IS NULL
     OR actor_text !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT pg_input_is_valid(actor_text, 'uuid')
     OR NEW.metadata->>'acknowledged_by' IS DISTINCT FROM actor_text
     OR authorization_mode NOT IN ('assignee', 'role', 'admin', 'override')
     OR NOT EXISTS (
       SELECT 1
         FROM users AS actor
        WHERE actor.tenant_id = NEW.tenant_id
          AND actor.uid::text = LOWER(actor_text)
     )
  THEN
    RETURN NEW;
  END IF;
  acknowledged_at_value := acknowledged_at_text::timestamptz;

  authorization_valid := authorization_mode <> 'override';
  IF authorization_mode = 'override'
     AND NULLIF(
           BTRIM(acknowledged_task.metadata->>'acknowledge_override_source'),
           ''
         ) IS NOT NULL
     AND NULLIF(
           BTRIM(acknowledged_task.metadata->>'acknowledge_override_id'),
           ''
         ) IS NOT NULL
     AND NULLIF(
           BTRIM(acknowledged_task.metadata->>'acknowledge_override_reason'),
           ''
         ) IS NOT NULL
  THEN
    IF acknowledged_task.metadata->>'acknowledge_override_source' =
         'patient_access_break_glass'
       AND acknowledged_task.metadata->>'acknowledge_override_id' ~
             '^[1-9][0-9]*$'
       AND pg_input_is_valid(
             acknowledged_task.metadata->>'acknowledge_override_id',
             'integer'
           )
    THEN
      SELECT EXISTS (
        SELECT 1
          FROM patient_access_break_glass AS access_override
         WHERE access_override.tenant_id = NEW.tenant_id
           AND access_override.id =
                 (acknowledged_task.metadata->>'acknowledge_override_id')::integer
           AND access_override.patient_uid = acknowledged_task.patient_uid
           AND access_override.actor_uid::text = LOWER(actor_text)
           AND access_override.reason =
                 acknowledged_task.metadata->>'acknowledge_override_reason'
      ) INTO authorization_valid;
    ELSIF acknowledged_task.metadata->>'acknowledge_override_source' =
            'cold_chain_excursion_ack'
          AND acknowledged_task.related_resource_type =
                'cold_chain_excursions'
          AND acknowledged_task.related_resource_id =
                acknowledged_task.metadata->>'acknowledge_override_id'
    THEN
      authorization_valid := TRUE;
    END IF;
  END IF;
  IF NOT authorization_valid THEN
    RETURN NEW;
  END IF;

  normalization_history := CASE
    WHEN jsonb_typeof(
           NEW.metadata->'rolling_legacy_ack_normalization_history'
         ) = 'array'
      THEN NEW.metadata->'rolling_legacy_ack_normalization_history'
    ELSE '[]'::jsonb
  END;
  normalization_receipt := jsonb_build_object(
    'database_authored_by', 'migration_580_rolling_compat',
    'normalized_at', NOW(),
    'task_id', acknowledged_task.id,
    'authorization_mode', authorization_mode,
    'submitted_status', NEW.status,
    'submitted_completed_at', NEW.completed_at,
    'submitted_breached_at', NEW.breached_at,
    'submitted_acknowledged_by', NEW.metadata->'acknowledged_by',
    'canonical_completed_at',
      GREATEST(acknowledged_at_value, NEW.started_at)
  );

  NEW.completed_at := GREATEST(acknowledged_at_value, NEW.started_at);
  NEW.status := CASE
    WHEN OLD.status = 'escalated' OR NEW.status = 'escalated' THEN 'escalated'
    WHEN NEW.due_at IS NOT NULL AND NEW.completed_at > NEW.due_at THEN 'breached'
    ELSE 'completed'
  END;
  NEW.breached_at := CASE
    WHEN NEW.due_at IS NOT NULL AND NEW.completed_at > NEW.due_at
      THEN COALESCE(NEW.breached_at, NEW.due_at)
    WHEN NEW.status = 'escalated' THEN NEW.breached_at
    ELSE NULL
  END;
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
    || jsonb_build_object(
         'completed_by', actor_text,
         'rolling_legacy_ack_normalization_history',
           normalization_history || jsonb_build_array(normalization_receipt)
       );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_sla_normalize_rolling_legacy_ack
  ON workflow_sla_instances;
CREATE TRIGGER trg_workflow_sla_normalize_rolling_legacy_ack
  BEFORE UPDATE OF status, completed_at, breached_at, metadata
  ON workflow_sla_instances
  FOR EACH ROW EXECUTE FUNCTION workflow_sla_normalize_rolling_legacy_ack();

CREATE OR REPLACE FUNCTION workflow_sla_materialize_legacy_critical_rearm_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_history JSONB;
  new_history JSONB;
  newly_pending_count INTEGER;
  total_pending_count INTEGER;
  pending_receipt JSONB;
  predecessor_id_text TEXT;
  predecessor_id INTEGER;
  predecessor tasks%ROWTYPE;
  signoff_record RECORD;
  ordering_clinician_uid UUID;
  requested_owner_tenant_id UUID;
  requested_owner_is_active BOOLEAN;
  requested_owner_role TEXT;
  owner_resolution_reason TEXT;
  signoff_actor_uid UUID;
  successor tasks%ROWTYPE;
  successor_count INTEGER;
  linked_history JSONB;
BEGIN
  IF OLD.rule_code IS DISTINCT FROM 'critical_result_ack'
     OR OLD.completed_at IS NULL
     OR OLD.status NOT IN ('completed', 'breached', 'escalated')
     OR NEW.status IS DISTINCT FROM 'active'
     OR NEW.completed_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  old_history := CASE
    WHEN jsonb_typeof(OLD.metadata->'reopen_history') = 'array'
      THEN OLD.metadata->'reopen_history'
    ELSE '[]'::jsonb
  END;
  new_history := CASE
    WHEN jsonb_typeof(NEW.metadata->'reopen_history') = 'array'
      THEN NEW.metadata->'reopen_history'
    ELSE '[]'::jsonb
  END;

  SELECT COUNT(*)::integer
    INTO newly_pending_count
    FROM jsonb_array_elements(new_history) AS history(receipt)
   WHERE history.receipt->>'database_authored_by' = 'migration_580_rolling_compat'
     AND history.receipt->>'compatibility_state' = 'pending_successor'
     AND history.receipt->'rearmed_started_at' = to_jsonb(NEW.started_at)
     AND history.receipt->'rearmed_due_at' = to_jsonb(NEW.due_at)
     AND NULLIF(BTRIM(history.receipt->>'generation_id'), '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(old_history) AS prior_history(receipt)
        WHERE prior_history.receipt->>'generation_id' =
                history.receipt->>'generation_id'
     );

  IF newly_pending_count = 0 THEN
    RETURN NEW;
  END IF;
  IF newly_pending_count <> 1 THEN
    RAISE EXCEPTION
      'critical-result SLA rearm must append exactly one rolling-compatibility generation'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::integer
    INTO total_pending_count
    FROM jsonb_array_elements(new_history) AS history(receipt)
   WHERE history.receipt->>'database_authored_by' = 'migration_580_rolling_compat'
     AND history.receipt->>'compatibility_state' = 'pending_successor';
  IF total_pending_count <> 1 THEN
    RAISE EXCEPTION
      'critical-result SLA has stale or multiple pending rolling-compatibility generations'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT history.receipt
    INTO pending_receipt
    FROM jsonb_array_elements(new_history) AS history(receipt)
   WHERE history.receipt->>'database_authored_by' = 'migration_580_rolling_compat'
     AND history.receipt->>'compatibility_state' = 'pending_successor'
     AND history.receipt->'rearmed_started_at' = to_jsonb(NEW.started_at)
     AND history.receipt->'rearmed_due_at' = to_jsonb(NEW.due_at)
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(old_history) AS prior_history(receipt)
        WHERE prior_history.receipt->>'generation_id' =
                history.receipt->>'generation_id'
     )
   LIMIT 1;

  predecessor_id_text :=
    NULLIF(BTRIM(pending_receipt->>'prior_completed_by_task'), '');
  IF predecessor_id_text IS NULL
     OR predecessor_id_text !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(predecessor_id_text, 'integer')
  THEN
    RAISE EXCEPTION
      'pending critical-result rearm generation has no canonical predecessor'
      USING ERRCODE = 'check_violation';
  END IF;
  predecessor_id := predecessor_id_text::integer;

  SELECT task.*
    INTO predecessor
    FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.id = predecessor_id
     AND task.workflow_sla_instance_id = NEW.id
     AND task.sla_completion_semantics = 'acknowledgement'
     AND task.status IN ('in_progress', 'completed', 'cancelled')
     AND task.related_resource_type IS NOT DISTINCT FROM NEW.source_table
     AND task.related_resource_id IS NOT DISTINCT FROM NEW.source_id
     AND task.patient_uid IS NOT DISTINCT FROM NEW.patient_uid
     AND task.due_at IS NOT NULL
     AND pending_receipt->'prior_due_at' = to_jsonb(task.due_at);
  IF NOT FOUND
  THEN
    RAISE EXCEPTION
      'legacy critical-result rearm predecessor does not match its pending generation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF pending_receipt->'domain_evidence'->>'kind'
       IS DISTINCT FROM 'lab_corrective_signoff'
     OR pending_receipt->'domain_evidence'->>'result_id'
       IS DISTINCT FROM NEW.source_id
     OR pending_receipt->'domain_evidence'->>'patient_uid'
       IS DISTINCT FROM NEW.patient_uid::text
     OR pending_receipt->'domain_evidence'->>'decision'
       NOT IN ('corrected', 'amended')
     OR pending_receipt->>'reopen_reason' IS DISTINCT FROM
          'lab_signoff_' ||
            (pending_receipt->'domain_evidence'->>'decision')
     OR NEW.source_table IS DISTINCT FROM 'lab_result'
     OR NEW.source_id !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(NEW.source_id, 'integer')
     OR pending_receipt->'domain_evidence'->>'signoff_id' !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(
       pending_receipt->'domain_evidence'->>'signoff_id',
       'integer'
     )
  THEN
    RAISE EXCEPTION
      'pending critical-result rearm generation has invalid corrective evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT signoff.id,
         signoff.decision,
         signoff.signed_at,
         signoff.signed_off_by,
         result.investigation_id,
         investigation.requested_by
    INTO signoff_record
    FROM lab_pathologist_signoffs AS signoff
    JOIN lab_results AS result
      ON result.tenant_id = signoff.tenant_id
     AND result.id = NEW.source_id::integer
     AND result.patient_uid = NEW.patient_uid
    LEFT JOIN investigations AS investigation
      ON investigation.tenant_id = result.tenant_id
     AND investigation.id = result.investigation_id
   WHERE signoff.tenant_id = NEW.tenant_id
     AND signoff.id =
           (pending_receipt->'domain_evidence'->>'signoff_id')::integer
     AND signoff.decision = pending_receipt->'domain_evidence'->>'decision'
     AND result.id = ANY(signoff.result_ids)
     AND to_jsonb(signoff.signed_at) =
           pending_receipt->'domain_evidence'->'signed_at'
     AND signoff.signed_at > OLD.completed_at
     AND signoff.signed_at <= NEW.started_at
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'legacy critical-result rearm has no matching fresh corrective sign-off'
      USING ERRCODE = 'check_violation';
  END IF;

  IF signoff_record.requested_by IS NULL THEN
    owner_resolution_reason := 'missing';
  ELSE
    SELECT owner.tenant_id,
           owner.is_active,
           owner.role
      INTO requested_owner_tenant_id,
           requested_owner_is_active,
           requested_owner_role
      FROM users AS owner
     WHERE owner.uid = signoff_record.requested_by
     LIMIT 1;
    IF NOT FOUND THEN
      owner_resolution_reason := 'missing';
    ELSIF requested_owner_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      owner_resolution_reason := 'cross_tenant';
    ELSIF requested_owner_is_active IS DISTINCT FROM TRUE THEN
      owner_resolution_reason := 'inactive';
    ELSIF NOT care_pathway_is_route_actionable_human_role(
                requested_owner_role,
                'critical_result_ack'
              )
    THEN
      owner_resolution_reason := 'non_clinical';
    ELSE
      ordering_clinician_uid := signoff_record.requested_by;
      owner_resolution_reason := 'resolved_active';
    END IF;
  END IF;

  SELECT same_tenant_user.uid
    INTO signoff_actor_uid
    FROM users AS same_tenant_user
   WHERE same_tenant_user.tenant_id = NEW.tenant_id
     AND same_tenant_user.uid = signoff_record.signed_off_by
   LIMIT 1;

  -- The old application re-arms and enqueues in separate transactions. Make
  -- the replacement task a side effect of the rearm row update itself, so a
  -- process crash cannot commit a live clock without actionable work. No
  -- predecessor task is locked or commented here: the SLA-to-new-task order is
  -- deliberate, and a conflicting writer is accepted only when it already
  -- materialized this exact generation. Callers may retry boundedly on a true
  -- concurrent transaction abort; a mismatched resource-slot collision fails.
  INSERT INTO tasks (
    tenant_id,
    task_kind,
    title,
    description,
    patient_uid,
    related_resource_type,
    related_resource_id,
    priority,
    status,
    assigned_to_uid,
    assigned_to_role,
    created_by,
    due_at,
    workflow_sla_instance_id,
    sla_completion_semantics,
    metadata
  ) VALUES (
    NEW.tenant_id,
    'review',
    'Updated result: re-acknowledgement required',
    NULL,
    NEW.patient_uid,
    NEW.source_table,
    NEW.source_id,
    COALESCE(predecessor.priority, 'critical'),
    'open',
    ordering_clinician_uid,
    CASE WHEN ordering_clinician_uid IS NULL THEN 'DUTY_DOCTOR' ELSE NULL END,
    signoff_actor_uid,
    NEW.due_at,
    NEW.id,
    'acknowledgement',
    jsonb_build_object(
      'source', 'lab_result',
      'sla_key', NEW.rule_code,
      'sla_instance_id', NEW.id::text,
      'reopened_from_task_id', predecessor.id,
      'reopen_reason', pending_receipt->>'reopen_reason',
      'reopen_generation_id', pending_receipt->>'generation_id',
      'reopen_link_source', 'migration_580_rolling_compat',
      'legacy_owner_resolution', jsonb_build_object(
        'mode', CASE
          WHEN ordering_clinician_uid IS NULL THEN 'duty_role_fallback'
          ELSE 'requested_by'
        END,
        'reason', owner_resolution_reason
      )
    )
  )
  ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
    WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
      AND related_resource_type IS NOT NULL
      AND related_resource_id IS NOT NULL
  DO NOTHING;

  SELECT COUNT(*)::integer
    INTO successor_count
    FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.related_resource_type = NEW.source_table
     AND task.related_resource_id = NEW.source_id
     AND task.status IN ('open', 'in_progress', 'blocked', 'overdue');

  IF successor_count <> 1 THEN
    RAISE EXCEPTION
      'legacy critical-result rearm requires exactly one actionable replacement task'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT task.*
    INTO successor
    FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.related_resource_type = NEW.source_table
     AND task.related_resource_id = NEW.source_id
     AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
   LIMIT 1;

  IF successor.status IS DISTINCT FROM 'open'
     OR successor.id <= predecessor.id
     OR successor.created_at < NEW.started_at
     OR successor.workflow_sla_instance_id IS DISTINCT FROM NEW.id
     OR successor.sla_completion_semantics IS DISTINCT FROM 'acknowledgement'
     OR successor.patient_uid IS DISTINCT FROM NEW.patient_uid
      OR successor.due_at IS DISTINCT FROM NEW.due_at
      OR successor.assigned_to_uid IS DISTINCT FROM ordering_clinician_uid
      OR successor.assigned_to_role IS DISTINCT FROM (
           CASE WHEN ordering_clinician_uid IS NULL THEN 'DUTY_DOCTOR' ELSE NULL END
         )
      OR successor.metadata->>'reopened_from_task_id'
          IS DISTINCT FROM predecessor.id::text
     OR successor.metadata->>'reopen_reason'
          IS DISTINCT FROM pending_receipt->>'reopen_reason'
     OR successor.metadata->>'reopen_generation_id'
          IS DISTINCT FROM pending_receipt->>'generation_id'
  THEN
    RAISE EXCEPTION
      'active critical-result task does not match the exact rearm generation'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT jsonb_agg(
           CASE
             WHEN history.receipt->>'generation_id' =
                    pending_receipt->>'generation_id'
               THEN history.receipt || jsonb_build_object(
                 'compatibility_state', 'linked',
                 'successor_task_id', successor.id,
                 'successor_linked_at', NOW()
               )
             ELSE history.receipt
           END
           ORDER BY history.position
         )
    INTO linked_history
    FROM jsonb_array_elements(new_history)
      WITH ORDINALITY AS history(receipt, position);

  UPDATE workflow_sla_instances AS sla
     SET metadata = jsonb_set(
           COALESCE(sla.metadata, '{}'::jsonb),
           '{reopen_history}',
           COALESCE(linked_history, '[]'::jsonb),
           true
         ),
         updated_at = NOW()
   WHERE sla.tenant_id = NEW.tenant_id
     AND sla.id = NEW.id;

  IF EXISTS (
    SELECT 1
      FROM workflow_sla_instances AS sla,
           LATERAL jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(sla.metadata->'reopen_history') = 'array'
                 THEN sla.metadata->'reopen_history'
               ELSE '[]'::jsonb
             END
           ) AS history(receipt)
     WHERE sla.tenant_id = NEW.tenant_id
       AND sla.id = NEW.id
       AND history.receipt->>'database_authored_by' =
             'migration_580_rolling_compat'
       AND history.receipt->>'compatibility_state' = 'pending_successor'
  ) THEN
    RAISE EXCEPTION
      'legacy critical-result rearm left an unbound pending generation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM workflow_sla_instances AS sla,
           LATERAL jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(sla.metadata->'reopen_history') = 'array'
                 THEN sla.metadata->'reopen_history'
               ELSE '[]'::jsonb
             END
           ) AS history(receipt)
     WHERE sla.tenant_id = NEW.tenant_id
       AND sla.id = NEW.id
       AND history.receipt->>'generation_id' =
             pending_receipt->>'generation_id'
       AND history.receipt->>'compatibility_state' = 'linked'
       AND history.receipt->>'successor_task_id' = successor.id::text
  ) THEN
    RAISE EXCEPTION
      'legacy critical-result rearm did not persist its exact successor lineage'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_sla_materialize_legacy_critical_rearm_task
  ON workflow_sla_instances;
CREATE TRIGGER trg_workflow_sla_materialize_legacy_critical_rearm_task
  AFTER UPDATE OF status, completed_at, started_at, due_at, metadata
  ON workflow_sla_instances
  FOR EACH ROW EXECUTE FUNCTION workflow_sla_materialize_legacy_critical_rearm_task();

-- ALTER TABLE acquired an ACCESS EXCLUSIVE lock earlier in this transaction.
-- Normalize rows that an old replica could have committed after the opening
-- preflight but before that lock was acquired, then verify the now-stable set.
-- This closes the migration/traffic race without trusting or dropping work.
UPDATE tasks
   SET metadata = metadata
 WHERE workflow_sla_instance_id IS NOT NULL;

UPDATE tasks
   SET metadata = metadata
 WHERE workflow_sla_instance_id IS NULL
   AND (
     (
       status IN ('open', 'in_progress', 'blocked', 'overdue')
       AND NULLIF(BTRIM(metadata->>'sla_key'), '') IN (
         'critical_result_ack',
         'cold_chain_excursion_ack',
         'mortuary_unclaimed_body'
       )
       AND NULLIF(BTRIM(metadata->>'requested_sla_key'), '') IS NULL
       AND NULLIF(BTRIM(metadata->>'sla_policy_status'), '') IS NULL
     )
     OR
     (
       NULLIF(BTRIM(metadata->>'requested_sla_key'), '') IN (
         'critical_result_ack',
         'cold_chain_excursion_ack',
         'mortuary_unclaimed_body'
       )
       AND metadata->>'sla_policy_status' = 'missing'
       AND (
         NULLIF(BTRIM(metadata->>'sla_key'), '') IS NULL
         OR metadata->>'sla_key' = metadata->>'requested_sla_key'
       )
     )
   );

DO $care_pathway_post_lock_compatibility_check$
DECLARE
  unsafe_claim_count INTEGER;
BEGIN
  SELECT COUNT(*)::integer
    INTO unsafe_claim_count
    FROM tasks AS task
    LEFT JOIN workflow_sla_instances AS sla
      ON sla.tenant_id = task.tenant_id
     AND sla.id = task.workflow_sla_instance_id
   WHERE (
     task.workflow_sla_instance_id IS NOT NULL
     AND (
       sla.id IS NULL
       OR task.metadata->>'sla_instance_id'
            IS DISTINCT FROM task.workflow_sla_instance_id::text
       OR NULLIF(BTRIM(task.metadata->>'sla_key'), '')
            IS DISTINCT FROM sla.rule_code
       OR (
         task.workflow_step_id IS NULL
         AND sla.rule_code NOT IN (
           'critical_result_ack',
           'cold_chain_excursion_ack',
           'mortuary_unclaimed_body'
         )
       )
     )
   )
   OR (
     task.workflow_sla_instance_id IS NULL
     AND (
       task.sla_completion_semantics IS DISTINCT FROM 'none'
       OR NULLIF(BTRIM(task.metadata->>'sla_instance_id'), '') IS NOT NULL
       OR (
         (
           task.metadata ? 'requested_sla_key'
           OR task.metadata ? 'sla_policy_status'
           OR (
             task.status IN ('open', 'in_progress', 'blocked', 'overdue')
             AND NULLIF(BTRIM(task.metadata->>'sla_key'), '') IS NOT NULL
           )
         )
         AND NOT (
           task.workflow_step_id IS NULL
           AND task.due_at IS NULL
           AND NULLIF(BTRIM(task.related_resource_type), '') IS NOT NULL
           AND NULLIF(BTRIM(task.related_resource_id), '') IS NOT NULL
           AND task.metadata->>'sla_policy_status' = 'missing'
           AND (
             (
               task.metadata->>'requested_sla_key' = 'critical_result_ack'
               AND NULLIF(BTRIM(task.metadata->>'sla_key'), '') IS NULL
             )
             OR
             (
               task.metadata->>'requested_sla_key' = 'cold_chain_excursion_ack'
               AND NULLIF(BTRIM(task.metadata->>'sla_key'), '') IS NULL
               AND task.related_resource_type = 'cold_chain_excursions'
             )
             OR
             (
               task.metadata->>'requested_sla_key' = 'mortuary_unclaimed_body'
               AND task.metadata->>'sla_key' = 'mortuary_unclaimed_body'
               AND task.related_resource_type = 'death_record'
               AND EXISTS (
                 SELECT 1
                   FROM death_records AS death_record
                  WHERE death_record.tenant_id = task.tenant_id
                    AND death_record.id::text = task.related_resource_id
               )
             )
           )
         )
       )
     )
   );

  IF unsafe_claim_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'migration 580 blocked: %s post-lock task SLA compatibility claim(s) remain unsafe',
        unsafe_claim_count
      ),
      HINT =
        'Reconcile typed aliases or mark a recognized policy-missing task explicitly before retrying. No task identifiers are reported.';
  END IF;
END
$care_pathway_post_lock_compatibility_check$;

-- The opening lifecycle preflight can race a legacy writer before the ALTER
-- lock. Re-run the same aggregate check after compatibility normalization,
-- while the task table is stable, so no contradictory terminal/actionable
-- pair can slip through the rolling migration window.
DO $care_pathway_post_lock_ack_lifecycle_check$
DECLARE
  acknowledged_or_completed_incomplete_count INTEGER;
  cancelled_incomplete_count INTEGER;
  actionable_terminal_count INTEGER;
  reopen_ancestor_missing_deadline_count INTEGER;
  invalid_reopen_edge_count INTEGER;
  inconsistent_count INTEGER;
BEGIN
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
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.workflow_sla_instance_id IS NOT NULL
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
           reopen_receipt.prior_due_at_text,
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
                   WHEN jsonb_typeof(
                          predecessor.sla_metadata->'reopen_history'
                        ) = 'array'
                     THEN predecessor.sla_metadata->'reopen_history'
                   ELSE '[]'::jsonb
                 END
               ) WITH ORDINALITY AS history(receipt, position)
         WHERE NULLIF(
                 BTRIM(history.receipt->>'prior_completed_by_task'),
                 ''
                ) = predecessor.task_id::text
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
           AND NULLIF(
                 BTRIM(receipt.metadata->>'superseded_by_task_id'),
                 ''
               ) = chain.task_id::text
           AND NULLIF(BTRIM(receipt.metadata->>'reason'), '')
                 = chain.reopen_reason
      ) AS reciprocal_comment ON TRUE
      JOIN LATERAL (
        SELECT reopen_history.prior_due_at_text
      ) AS reopen_receipt ON TRUE
     WHERE chain.reopened_from_task_id ~ '^[1-9][0-9]*$'
       AND chain.depth < 100
       AND NOT predecessor.task_id = ANY(chain.visited_task_ids)
       AND predecessor.task_id < chain.task_id
       AND predecessor.task_created_at <= chain.task_created_at
       AND reopen_history.match_count = 1
  ), verified_reopen_ancestors AS (
    SELECT DISTINCT
           tenant_id,
           sla_id,
           root_task_id,
           task_id,
           history_match_count,
           comment_match_count,
           prior_due_at_text,
           CASE
             WHEN prior_due_at_text ~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                  AND pg_input_is_valid(
                    prior_due_at_text,
                    'timestamp with time zone'
                  )
               THEN prior_due_at_text::timestamptz
             ELSE NULL
           END AS receipt_prior_due_at
      FROM reopen_chain
     WHERE depth > 1
  )
  SELECT COUNT(*) FILTER (
           WHERE link.task_status = 'in_progress'
             AND link.sla_completed_at IS NULL
         )::integer
         + COUNT(*) FILTER (
           WHERE link.task_status = 'completed'
             AND link.sla_completed_at IS NULL
             AND ancestor.task_id IS NULL
         )::integer,
         COUNT(*) FILTER (
           WHERE link.task_status = 'cancelled'
             AND link.sla_completed_at IS NULL
             AND ancestor.task_id IS NULL
         )::integer,
         COUNT(*) FILTER (
           WHERE link.task_status IN ('open', 'blocked', 'overdue')
             AND NOT (
               link.sla_completed_at IS NULL
               AND link.sla_status IN ('active', 'breached', 'escalated')
             )
         )::integer,
         COUNT(*) FILTER (
           WHERE ancestor.task_id IS NOT NULL
             AND (
               ancestor.history_match_count > 1
               OR (
                 link.task_due_at IS NULL
                 AND ancestor.receipt_prior_due_at IS NULL
               )
               OR (
                 link.task_due_at IS NOT NULL
                 AND ancestor.history_match_count = 1
                 AND (
                   ancestor.receipt_prior_due_at IS NULL
                   OR link.task_due_at IS DISTINCT FROM
                        ancestor.receipt_prior_due_at
                 )
               )
             )
         )::integer,
         COUNT(*) FILTER (
           WHERE link.rule_code = 'critical_result_ack'
             AND link.reopened_from_task_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM verified_reopen_ancestors AS verified_edge
                WHERE verified_edge.tenant_id = link.tenant_id
                  AND verified_edge.sla_id = link.sla_id
                  AND verified_edge.root_task_id = link.task_id
             )
         )::integer
    INTO acknowledged_or_completed_incomplete_count,
         cancelled_incomplete_count,
         actionable_terminal_count,
         reopen_ancestor_missing_deadline_count,
         invalid_reopen_edge_count
    FROM acknowledgement_links AS link
    LEFT JOIN verified_reopen_ancestors AS ancestor
      ON ancestor.tenant_id = link.tenant_id
     AND ancestor.sla_id = link.sla_id
     AND ancestor.task_id = link.task_id;

  inconsistent_count :=
    acknowledged_or_completed_incomplete_count
      + cancelled_incomplete_count
      + actionable_terminal_count
      + reopen_ancestor_missing_deadline_count
      + invalid_reopen_edge_count;

  IF inconsistent_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'migration 580 blocked after task-table lock: %s acknowledgement task/SLA lifecycle pair(s) are inconsistent (acknowledged_or_completed_incomplete=%s, cancelled_incomplete=%s, actionable_terminal=%s, reopen_ancestor_missing_deadline=%s, invalid_reopen_edge=%s)',
        inconsistent_count,
        acknowledged_or_completed_incomplete_count,
        cancelled_incomplete_count,
        actionable_terminal_count,
        reopen_ancestor_missing_deadline_count,
        invalid_reopen_edge_count
      ),
      HINT =
        'Reconcile the post-lock critical-result or cold-chain pair from authoritative clinical evidence before retrying. A reopened predecessor needs a unique authenticated SLA history receipt plus an exact historical deadline; a task comment alone is insufficient.';
  END IF;
END
$care_pathway_post_lock_ack_lifecycle_check$;

SELECT care_pathway_assert_legacy_critical_rearm_lineage(
  'after task-table lock'
);

DROP FUNCTION care_pathway_assert_legacy_critical_rearm_lineage(TEXT);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_definition_identity
  ON workflow_runs (tenant_id, workflow_definition_id, workflow_key, workflow_version)
  WHERE workflow_definition_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_runs_current_step_identity
  ON workflow_runs (tenant_id, id, current_step_key);

CREATE INDEX IF NOT EXISTS idx_tasks_workflow_step_same_run
  ON tasks (tenant_id, workflow_step_id, workflow_run_id)
  WHERE workflow_step_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_parent_same_run
  ON tasks (tenant_id, parent_task_id, workflow_run_id)
  WHERE parent_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approvals_task_same_run
  ON approvals (tenant_id, task_id, workflow_run_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approvals_workflow_step_same_run
  ON approvals (tenant_id, workflow_step_id, workflow_run_id)
  WHERE workflow_step_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approvals_created_by
  ON approvals (tenant_id, created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approvals_decided_by
  ON approvals (tenant_id, decided_by)
  WHERE decided_by IS NOT NULL;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_workflow_step_requires_run
  CHECK (workflow_step_id IS NULL OR workflow_run_id IS NOT NULL);

ALTER TABLE approvals
  ADD CONSTRAINT approvals_workflow_links_require_run
  CHECK (
    (workflow_step_id IS NULL AND task_id IS NULL)
    OR workflow_run_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION tasks_enforce_parent_run_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run_id INTEGER;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT parent.workflow_run_id
      INTO parent_run_id
      FROM tasks AS parent
     WHERE parent.tenant_id = NEW.tenant_id
       AND parent.id = NEW.parent_task_id
     FOR KEY SHARE;

    IF FOUND AND NEW.workflow_run_id IS DISTINCT FROM parent_run_id THEN
      RAISE EXCEPTION
        'parent and child task workflow runs must match'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id
     )
     AND EXISTS (
       SELECT 1
         FROM tasks AS child
        WHERE child.tenant_id = OLD.tenant_id
          AND child.parent_task_id = OLD.id
          AND child.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id
     )
  THEN
    RAISE EXCEPTION
      'parent and child task workflow runs must match'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tasks_parent_run_coherence
  BEFORE INSERT OR UPDATE OF tenant_id, parent_task_id, workflow_run_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_enforce_parent_run_coherence();

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_stage_occurrence
  ON tasks (tenant_id, stage_occurrence_key)
  WHERE stage_occurrence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_workflow_sla
  ON tasks (tenant_id, workflow_sla_instance_id)
  WHERE workflow_sla_instance_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_materialization
  ON approvals (tenant_id, materialization_key)
  WHERE materialization_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approvals_workflow_step
  ON approvals (tenant_id, workflow_step_id)
  WHERE workflow_step_id IS NOT NULL;

-- A typed link is safe only when both rows identify the same obligation. The
-- workflow-step mapping takes precedence for pathway tasks so registered
-- pathway-specific SLA rule codes are allowed without weakening legacy links.
CREATE OR REPLACE FUNCTION care_pathway_assert_task_sla_source_binding(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  valid_binding BOOLEAN := FALSE;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND OR task_record.workflow_sla_instance_id IS NULL THEN
    RETURN;
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances AS sla
   WHERE sla.tenant_id = task_record.tenant_id
     AND sla.id = task_record.workflow_sla_instance_id;

  IF FOUND AND (
    task_record.metadata->>'sla_instance_id'
      IS DISTINCT FROM task_record.workflow_sla_instance_id::text
    OR NULLIF(BTRIM(task_record.metadata->>'sla_key'), '')
      IS DISTINCT FROM sla_record.rule_code
  ) THEN
    RAISE EXCEPTION
      'typed task SLA legacy aliases must equal the linked instance and rule'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND AND task_record.due_at IS NULL THEN
    RAISE EXCEPTION
      'linked task deadline must be present'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND (
       sla_record.due_at IS NULL
       OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     )
  THEN
    RAISE EXCEPTION
      'task and linked SLA deadlines must both be present and exactly equal'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.sla_completion_semantics = 'acknowledgement'
     AND task_record.status = 'in_progress'
     AND sla_record.completed_at IS NULL
  THEN
    RAISE EXCEPTION
      'acknowledged task must have a completed linked SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND
     AND task_record.sla_completion_semantics = 'acknowledgement'
     AND task_record.status IN ('open', 'blocked', 'overdue')
     AND (
       sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
     )
  THEN
    RAISE EXCEPTION
      'actionable acknowledgement task must have an incomplete linked SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF FOUND AND task_record.workflow_step_id IS NOT NULL THEN
    valid_binding := task_record.sla_completion_semantics
        IN ('acknowledgement', 'domain_evidence')
      AND sla_record.source_table IS NOT DISTINCT FROM 'workflow_steps'
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.workflow_step_id::text;
  ELSIF FOUND
        AND sla_record.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')
  THEN
    valid_binding := task_record.sla_completion_semantics = 'acknowledgement'
      AND NULLIF(BTRIM(task_record.related_resource_type), '') IS NOT NULL
      AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
      AND sla_record.source_table IS NOT DISTINCT FROM task_record.related_resource_type
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id;
  ELSIF FOUND AND sla_record.rule_code = 'mortuary_unclaimed_body' THEN
    valid_binding := task_record.sla_completion_semantics = 'domain_evidence'
      AND task_record.related_resource_type IS NOT DISTINCT FROM 'death_record'
      AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
      AND sla_record.source_table IS NOT DISTINCT FROM 'death_records'
      AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id
      AND EXISTS (
        SELECT 1
          FROM death_records AS death_record
         WHERE death_record.tenant_id = task_record.tenant_id
           AND death_record.id::text = task_record.related_resource_id
      );
  END IF;

  IF NOT valid_binding THEN
    RAISE EXCEPTION
      'task and linked SLA source do not describe the same obligation'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION care_pathway_task_sla_source_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'tasks' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_task_sla_source_binding(NEW.tenant_id, NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME = 'workflow_sla_instances' THEN
    PERFORM care_pathway_assert_task_sla_source_binding(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.workflow_sla_instance_id = OLD.id;

    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id THEN
      PERFORM care_pathway_assert_task_sla_source_binding(task.tenant_id, task.id)
        FROM tasks AS task
       WHERE task.tenant_id = NEW.tenant_id
         AND task.workflow_sla_instance_id = NEW.id;
    END IF;
  ELSE
    PERFORM care_pathway_assert_task_sla_source_binding(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.related_resource_type = 'death_record'
       AND task.related_resource_id = OLD.id::text
       AND task.workflow_sla_instance_id IS NOT NULL;

    IF TG_OP <> 'DELETE'
       AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id)
    THEN
      PERFORM care_pathway_assert_task_sla_source_binding(task.tenant_id, task.id)
        FROM tasks AS task
       WHERE task.tenant_id = NEW.tenant_id
         AND task.related_resource_type = 'death_record'
         AND task.related_resource_id = NEW.id::text
         AND task.workflow_sla_instance_id IS NOT NULL;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_sla_source_binding
  AFTER INSERT OR UPDATE ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_task_sla_source_constraint();

CREATE CONSTRAINT TRIGGER trg_workflow_sla_instances_task_source_binding
  AFTER UPDATE ON workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_task_sla_source_constraint();

CREATE CONSTRAINT TRIGGER trg_death_records_task_sla_source_binding
  AFTER UPDATE OR DELETE ON death_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_task_sla_source_constraint();

DO $$
BEGIN
  PERFORM care_pathway_assert_task_sla_source_binding(task.tenant_id, task.id)
    FROM tasks AS task
   WHERE task.workflow_sla_instance_id IS NOT NULL;
END
$$;

DROP INDEX IF EXISTS uq_task_open_per_resource;
CREATE UNIQUE INDEX uq_task_open_per_resource
  ON tasks (tenant_id, related_resource_type, related_resource_id)
  WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
    AND related_resource_type IS NOT NULL
    AND related_resource_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Pathway context/closure companion. Workflow run/step remain execution state.
-- ---------------------------------------------------------------------------

CREATE TABLE care_pathway_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  workflow_run_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  pathway_key VARCHAR(120) NOT NULL,
  pathway_version INTEGER NOT NULL,
  source_episode_type VARCHAR(80) NOT NULL,
  source_episode_id VARCHAR(160) NOT NULL,
  parent_instance_id UUID,
  owning_clinician_uid UUID,
  owning_team_id INTEGER,
  accountable_role VARCHAR(80) NOT NULL,
  clinical_status VARCHAR(30) NOT NULL DEFAULT 'planned',
  completion_outcome VARCHAR(80),
  closure_reason TEXT,
  patient_visibility_status VARCHAR(30) NOT NULL DEFAULT 'hidden',
  idempotency_key VARCHAR(200) NOT NULL,
  activated_at TIMESTAMPTZ(6),
  closed_at TIMESTAMPTZ(6),
  created_by UUID,
  updated_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_care_pathway_instances_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_care_pathway_instances_run_identity
    FOREIGN KEY (tenant_id, workflow_run_id, pathway_key, pathway_version)
    REFERENCES workflow_runs (tenant_id, id, workflow_key, workflow_version)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_instances_patient_tenant
    FOREIGN KEY (tenant_id, patient_uid)
    REFERENCES users (tenant_id, uid) ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_instances_encounter_patient
    FOREIGN KEY (tenant_id, encounter_id, patient_uid)
    REFERENCES patient_encounters (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE SET NULL (encounter_id),
  CONSTRAINT fk_care_pathway_instances_created_by_tenant
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE SET NULL (created_by),
  CONSTRAINT fk_care_pathway_instances_updated_by_tenant
    FOREIGN KEY (tenant_id, updated_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE SET NULL (updated_by),
  CONSTRAINT care_pathway_instances_version_positive
    CHECK (pathway_version > 0),
  CONSTRAINT care_pathway_instances_episode_nonblank
    CHECK (
      NULLIF(BTRIM(pathway_key), '') IS NOT NULL
      AND NULLIF(BTRIM(source_episode_type), '') IS NOT NULL
      AND NULLIF(BTRIM(source_episode_id), '') IS NOT NULL
      AND NULLIF(BTRIM(accountable_role), '') IS NOT NULL
      AND NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
    ),
  CONSTRAINT care_pathway_instances_status_check
    CHECK (clinical_status IN (
      'planned', 'active', 'on_hold', 'completed', 'cancelled',
      'transferred', 'entered_in_error'
    )),
  CONSTRAINT care_pathway_instances_visibility_check
    CHECK (patient_visibility_status IN ('hidden', 'staff_only', 'patient_visible', 'withheld')),
  CONSTRAINT care_pathway_instances_closure_check
    CHECK (
      (clinical_status IN ('planned', 'active', 'on_hold') AND closed_at IS NULL)
      OR
      (clinical_status IN ('completed', 'cancelled', 'transferred', 'entered_in_error')
       AND closed_at IS NOT NULL)
    ),
  CONSTRAINT care_pathway_instances_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX ux_care_pathway_instances_run
  ON care_pathway_instances (workflow_run_id);

CREATE UNIQUE INDEX ux_care_pathway_instances_tenant_id
  ON care_pathway_instances (tenant_id, id);

CREATE UNIQUE INDEX ux_care_pathway_instances_tenant_patient_run
  ON care_pathway_instances (tenant_id, id, patient_uid, workflow_run_id);

CREATE UNIQUE INDEX ux_care_pathway_instances_tenant_patient
  ON care_pathway_instances (tenant_id, id, patient_uid);

CREATE UNIQUE INDEX ux_care_pathway_instances_idempotency
  ON care_pathway_instances (tenant_id, idempotency_key);

CREATE UNIQUE INDEX ux_care_pathway_instances_active_episode
  ON care_pathway_instances (
    tenant_id, pathway_key, source_episode_type, source_episode_id
  )
  WHERE clinical_status IN ('planned', 'active', 'on_hold');

CREATE INDEX idx_care_pathway_instances_patient
  ON care_pathway_instances (tenant_id, patient_uid, clinical_status, created_at DESC);

CREATE INDEX idx_care_pathway_instances_encounter
  ON care_pathway_instances (tenant_id, encounter_id, clinical_status)
  WHERE encounter_id IS NOT NULL;

CREATE INDEX idx_care_pathway_instances_owner
  ON care_pathway_instances (tenant_id, owning_clinician_uid, clinical_status)
  WHERE owning_clinician_uid IS NOT NULL;

CREATE UNIQUE INDEX ux_care_pathway_instances_run_identity
  ON care_pathway_instances (
    tenant_id, workflow_run_id, pathway_key, pathway_version
  );

CREATE INDEX idx_care_pathway_instances_encounter_patient
  ON care_pathway_instances (tenant_id, encounter_id, patient_uid)
  WHERE encounter_id IS NOT NULL;

CREATE INDEX idx_care_pathway_instances_parent_patient
  ON care_pathway_instances (tenant_id, parent_instance_id, patient_uid)
  WHERE parent_instance_id IS NOT NULL;

CREATE INDEX idx_care_pathway_instances_team_patient
  ON care_pathway_instances (tenant_id, owning_team_id, patient_uid)
  WHERE owning_team_id IS NOT NULL;

CREATE INDEX idx_care_pathway_instances_created_by
  ON care_pathway_instances (tenant_id, created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX idx_care_pathway_instances_updated_by
  ON care_pathway_instances (tenant_id, updated_by)
  WHERE updated_by IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE care_pathway_instances
    ADD CONSTRAINT fk_care_pathway_instances_parent_patient
    FOREIGN KEY (tenant_id, parent_instance_id, patient_uid)
    REFERENCES care_pathway_instances (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

  ALTER TABLE care_pathway_instances
    ADD CONSTRAINT fk_care_pathway_instances_owner_tenant
    FOREIGN KEY (tenant_id, owning_clinician_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE SET NULL (owning_clinician_uid);

  ALTER TABLE care_pathway_instances
    ADD CONSTRAINT fk_care_pathway_instances_team_patient
    FOREIGN KEY (tenant_id, owning_team_id, patient_uid)
    REFERENCES care_teams (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE SET NULL (owning_team_id);
END
$$;

ALTER TABLE care_pathway_instances
  ADD CONSTRAINT care_pathway_instances_not_self_parent
  CHECK (parent_instance_id IS NULL OR parent_instance_id <> id);

-- ---------------------------------------------------------------------------
-- Definition governance. Approval stores evidence; no activation route lands.
-- ---------------------------------------------------------------------------

CREATE TABLE care_pathway_definition_governance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  workflow_definition_id INTEGER NOT NULL,
  clinical_owner_uid UUID NOT NULL,
  operational_owner_uid UUID NOT NULL,
  governance_status VARCHAR(30) NOT NULL DEFAULT 'draft',
  approval_id INTEGER,
  approved_by UUID,
  approved_at TIMESTAMPTZ(6),
  patient_visibility_policy_ref VARCHAR(120),
  effective_from TIMESTAMPTZ(6),
  effective_until TIMESTAMPTZ(6),
  definition_checksum CHAR(64),
  platform_gates JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_care_pathway_governance_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_care_pathway_governance_definition
    FOREIGN KEY (tenant_id, workflow_definition_id)
    REFERENCES workflow_definitions (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_governance_approval
    FOREIGN KEY (tenant_id, approval_id)
    REFERENCES approvals (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_governance_clinical_owner
    FOREIGN KEY (tenant_id, clinical_owner_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_governance_operational_owner
    FOREIGN KEY (tenant_id, operational_owner_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_governance_approved_by
    FOREIGN KEY (tenant_id, approved_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE SET NULL (approved_by),
  CONSTRAINT care_pathway_governance_status_check
    CHECK (governance_status IN ('draft', 'under_review', 'approved', 'retired')),
  CONSTRAINT care_pathway_governance_effective_interval
    CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from),
  CONSTRAINT care_pathway_governance_checksum_check
    CHECK (definition_checksum IS NULL OR definition_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT care_pathway_governance_approved_evidence
    CHECK (
      governance_status NOT IN ('approved', 'retired')
      OR (
        approval_id IS NOT NULL
        AND approved_by IS NOT NULL
        AND approved_at IS NOT NULL
        AND definition_checksum IS NOT NULL
        AND NULLIF(BTRIM(patient_visibility_policy_ref), '') IS NOT NULL
      )
    ),
  CONSTRAINT care_pathway_governance_json_shapes
    CHECK (jsonb_typeof(platform_gates) = 'array' AND jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX ux_care_pathway_governance_definition
  ON care_pathway_definition_governance (tenant_id, workflow_definition_id);

CREATE UNIQUE INDEX ux_care_pathway_governance_tenant_id
  ON care_pathway_definition_governance (tenant_id, id);

CREATE INDEX idx_care_pathway_governance_state
  ON care_pathway_definition_governance (tenant_id, governance_status, effective_from);

CREATE INDEX idx_care_pathway_governance_approval
  ON care_pathway_definition_governance (tenant_id, approval_id)
  WHERE approval_id IS NOT NULL;

CREATE INDEX idx_care_pathway_governance_clinical_owner
  ON care_pathway_definition_governance (tenant_id, clinical_owner_uid);

CREATE INDEX idx_care_pathway_governance_operational_owner
  ON care_pathway_definition_governance (tenant_id, operational_owner_uid);

CREATE INDEX idx_care_pathway_governance_approved_by
  ON care_pathway_definition_governance (tenant_id, approved_by)
  WHERE approved_by IS NOT NULL;

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
  operational_owner_role TEXT;
  approver_role TEXT;
BEGIN
  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT role
    INTO clinical_owner_role
    FROM users
   WHERE tenant_id = governance_record.tenant_id
     AND uid = governance_record.clinical_owner_uid
   FOR KEY SHARE;

  SELECT role
    INTO operational_owner_role
    FROM users
   WHERE tenant_id = governance_record.tenant_id
     AND uid = governance_record.operational_owner_uid
   FOR KEY SHARE;

  IF governance_record.approved_by IS NOT NULL THEN
    SELECT role
      INTO approver_role
      FROM users
     WHERE tenant_id = governance_record.tenant_id
       AND uid = governance_record.approved_by
     FOR KEY SHARE;
  END IF;

  IF NULLIF(BTRIM(clinical_owner_role), '') IS NULL
     OR UPPER(clinical_owner_role) = 'PATIENT'
     OR NULLIF(BTRIM(operational_owner_role), '') IS NULL
     OR UPPER(operational_owner_role) = 'PATIENT'
     OR (
       governance_record.approved_by IS NOT NULL
       AND (
         NULLIF(BTRIM(approver_role), '') IS NULL
         OR UPPER(approver_role) = 'PATIENT'
       )
     )
  THEN
    RAISE EXCEPTION
      'pathway governance owners and approver must be non-patient tenant users'
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
    PERFORM care_pathway_assert_governance_actors(governance.tenant_id, governance.id)
      FROM care_pathway_definition_governance AS governance
     WHERE governance.tenant_id = OLD.tenant_id
       AND (
         governance.clinical_owner_uid = OLD.uid
         OR governance.operational_owner_uid = OLD.uid
         OR governance.approved_by = OLD.uid
       );

    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.uid IS DISTINCT FROM OLD.uid THEN
      PERFORM care_pathway_assert_governance_actors(governance.tenant_id, governance.id)
        FROM care_pathway_definition_governance AS governance
       WHERE governance.tenant_id = NEW.tenant_id
         AND (
           governance.clinical_owner_uid = NEW.uid
           OR governance.operational_owner_uid = NEW.uid
           OR governance.approved_by = NEW.uid
         );
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_care_pathway_governance_non_patient_actors
  AFTER INSERT OR UPDATE ON care_pathway_definition_governance
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_governance_actor_constraint();

CREATE CONSTRAINT TRIGGER trg_users_pathway_governance_non_patient_actors
  AFTER UPDATE ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_governance_actor_constraint();

-- An approval reference is governance evidence only when it is the completed,
-- tenant-matched decision for this exact workflow definition. Both sides are
-- checked at commit so an approval cannot be attached first and repaired later,
-- or mutated after publication to invalidate the evidence chain.
CREATE OR REPLACE FUNCTION care_pathway_parse_vote_timestamp(value TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
BEGIN
  IF NULLIF(BTRIM(value), '') IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN value::timestamptz;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
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
  deciding_actor_is_approver BOOLEAN;
  approval_quorum_met BOOLEAN;
  approval_vote_count INTEGER := 0;
  approval_valid_vote_count INTEGER := 0;
  approval_distinct_valid_user_count INTEGER := 0;
BEGIN
  SELECT governance.*
    INTO governance_record
    FROM care_pathway_definition_governance AS governance
   WHERE governance.tenant_id = target_tenant_id
     AND governance.id = target_governance_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR governance_record.governance_status NOT IN ('approved', 'retired')
  THEN
    RETURN;
  END IF;

  SELECT approval.*
    INTO approval_record
    FROM approvals AS approval
   WHERE approval.tenant_id = governance_record.tenant_id
     AND approval.id = governance_record.approval_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'approved or retired pathway governance requires matching approval evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  deciding_actor_is_approver := FALSE;
  approval_quorum_met := FALSE;

  IF jsonb_typeof(approval_record.approved_by) = 'array' THEN
    WITH votes AS (
      SELECT approver.entry,
             NULLIF(BTRIM(approver.entry ->> 'uid'), '') AS uid_text,
             care_pathway_parse_vote_timestamp(approver.entry ->> 'at') AS vote_at
        FROM jsonb_array_elements(approval_record.approved_by) AS approver(entry)
    ), validated_votes AS (
      SELECT vote.*,
             voter.uid AS voter_uid,
             (
               jsonb_typeof(vote.entry) = 'object'
               AND vote.uid_text IS NOT NULL
               AND vote.uid_text = voter.uid::text
               AND NULLIF(BTRIM(voter.role), '') IS NOT NULL
               AND UPPER(voter.role) <> 'PATIENT'
               AND vote.vote_at IS NOT NULL
               AND vote.vote_at <= approval_record.decided_at
             ) AS is_valid
        FROM votes AS vote
        LEFT JOIN users AS voter
          ON voter.tenant_id = approval_record.tenant_id
         AND voter.uid::text = vote.uid_text
    )
    SELECT COUNT(*)::integer,
           COUNT(*) FILTER (WHERE is_valid)::integer,
           COUNT(DISTINCT voter_uid) FILTER (WHERE is_valid)::integer,
           COALESCE(
             BOOL_OR(is_valid AND voter_uid = approval_record.decided_by),
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

CREATE OR REPLACE FUNCTION care_pathway_governance_approval_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'care_pathway_definition_governance' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_governance_approval(NEW.tenant_id, NEW.id);
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

CREATE CONSTRAINT TRIGGER trg_care_pathway_governance_approval_evidence
  AFTER INSERT OR UPDATE ON care_pathway_definition_governance
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_governance_approval_constraint();

CREATE CONSTRAINT TRIGGER trg_approvals_pathway_governance_evidence
  AFTER UPDATE OR DELETE ON approvals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_governance_approval_constraint();

CREATE OR REPLACE FUNCTION care_pathway_governance_vote_actor_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM care_pathway_assert_governance_approval(governance.tenant_id, governance.id)
    FROM care_pathway_definition_governance AS governance
    JOIN approvals AS approval
      ON approval.tenant_id = governance.tenant_id
     AND approval.id = governance.approval_id
   WHERE governance.tenant_id = OLD.tenant_id
     AND governance.governance_status IN ('approved', 'retired')
     AND jsonb_typeof(approval.approved_by) = 'array'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(approval.approved_by) AS vote(entry)
        WHERE vote.entry ->> 'uid' = OLD.uid::text
     );

  IF TG_OP <> 'DELETE'
     AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.uid IS DISTINCT FROM OLD.uid)
  THEN
    PERFORM care_pathway_assert_governance_approval(governance.tenant_id, governance.id)
      FROM care_pathway_definition_governance AS governance
      JOIN approvals AS approval
        ON approval.tenant_id = governance.tenant_id
       AND approval.id = governance.approval_id
     WHERE governance.tenant_id = NEW.tenant_id
       AND governance.governance_status IN ('approved', 'retired')
       AND jsonb_typeof(approval.approved_by) = 'array'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(approval.approved_by) AS vote(entry)
          WHERE vote.entry ->> 'uid' = NEW.uid::text
       );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_users_pathway_governance_vote_actors
  AFTER UPDATE OR DELETE ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_governance_vote_actor_constraint();

CREATE OR REPLACE FUNCTION care_pathway_block_published_definition_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM care_pathway_definition_governance AS governance
     WHERE governance.tenant_id = OLD.tenant_id
       AND governance.workflow_definition_id = OLD.id
       AND governance.governance_status IN ('approved', 'retired')
  ) THEN
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

  IF (to_jsonb(NEW) - 'is_active' - 'updated_at')
       IS DISTINCT FROM
     (to_jsonb(OLD) - 'is_active' - 'updated_at')
  THEN
    RAISE EXCEPTION
      'approved or retired pathway definitions are immutable; publish a new version'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workflow_definitions_pathway_immutable
  BEFORE UPDATE OR DELETE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION care_pathway_block_published_definition_mutation();

-- ---------------------------------------------------------------------------
-- Handoff protocol state. No referral-specific D6 closure rule is encoded.
-- ---------------------------------------------------------------------------

CREATE TABLE care_handoff_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  sending_pathway_instance_id UUID NOT NULL,
  sending_workflow_run_id INTEGER NOT NULL,
  sending_step_key VARCHAR(120) NOT NULL,
  receiving_pathway_instance_id UUID,
  receiving_workflow_run_id INTEGER,
  receiving_step_key VARCHAR(120),
  handoff_type VARCHAR(80) NOT NULL,
  source_resource_type VARCHAR(80) NOT NULL,
  source_resource_id VARCHAR(160) NOT NULL,
  urgency_code VARCHAR(40) NOT NULL,
  policy_due_at TIMESTAMPTZ(6),
  sender_uid UUID,
  sender_system_key VARCHAR(120),
  recipient_kind VARCHAR(30) NOT NULL,
  intended_recipient_uid UUID,
  intended_recipient_role VARCHAR(80),
  intended_team_id INTEGER,
  external_recipient_ref VARCHAR(160),
  status VARCHAR(30) NOT NULL DEFAULT 'requested',
  decline_reason TEXT,
  reroute_reason TEXT,
  cancellation_reason TEXT,
  requested_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ(6),
  accepted_at TIMESTAMPTZ(6),
  declined_at TIMESTAMPTZ(6),
  completed_at TIMESTAMPTZ(6),
  originator_closed_at TIMESTAMPTZ(6),
  cancelled_at TIMESTAMPTZ(6),
  task_id INTEGER,
  idempotency_key VARCHAR(200) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_care_handoff_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_care_handoff_sending_instance
    FOREIGN KEY (
      tenant_id, sending_pathway_instance_id, patient_uid, sending_workflow_run_id
    ) REFERENCES care_pathway_instances (tenant_id, id, patient_uid, workflow_run_id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_handoff_sending_step
    FOREIGN KEY (tenant_id, sending_workflow_run_id, sending_step_key)
    REFERENCES workflow_steps (tenant_id, workflow_run_id, step_key)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_handoff_receiving_instance
    FOREIGN KEY (
      tenant_id, receiving_pathway_instance_id, patient_uid, receiving_workflow_run_id
    ) REFERENCES care_pathway_instances (tenant_id, id, patient_uid, workflow_run_id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_handoff_receiving_step
    FOREIGN KEY (tenant_id, receiving_workflow_run_id, receiving_step_key)
    REFERENCES workflow_steps (tenant_id, workflow_run_id, step_key)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_handoff_task_tenant
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES tasks (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE SET NULL (task_id),
  CONSTRAINT fk_care_handoff_sender_tenant
    FOREIGN KEY (tenant_id, sender_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_handoff_recipient_tenant
    FOREIGN KEY (tenant_id, intended_recipient_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE SET NULL (intended_recipient_uid),
  CONSTRAINT fk_care_handoff_team_patient
    FOREIGN KEY (tenant_id, intended_team_id, patient_uid)
    REFERENCES care_teams (tenant_id, id, patient_uid)
    ON UPDATE NO ACTION ON DELETE SET NULL (intended_team_id),
  CONSTRAINT care_handoff_status_check
    CHECK (status IN (
      'requested', 'acknowledged', 'accepted', 'declined', 'completed',
      'closed_loop', 'cancelled'
    )),
  CONSTRAINT care_handoff_recipient_kind_check
    CHECK (recipient_kind IN ('user', 'role', 'team', 'external')),
  CONSTRAINT care_handoff_sender_check
    CHECK ((sender_uid IS NOT NULL) <> (sender_system_key IS NOT NULL)),
  CONSTRAINT care_handoff_recipient_check
    CHECK (
      (recipient_kind = 'user'
       AND intended_recipient_uid IS NOT NULL
       AND intended_recipient_role IS NULL
       AND intended_team_id IS NULL
       AND external_recipient_ref IS NULL)
      OR
      (recipient_kind = 'role'
       AND intended_recipient_uid IS NULL
       AND NULLIF(BTRIM(intended_recipient_role), '') IS NOT NULL
       AND intended_team_id IS NULL
       AND external_recipient_ref IS NULL)
      OR
      (recipient_kind = 'team'
       AND intended_recipient_uid IS NULL
       AND intended_recipient_role IS NULL
       AND intended_team_id IS NOT NULL
       AND external_recipient_ref IS NULL)
      OR
      (recipient_kind = 'external'
       AND intended_recipient_uid IS NULL
       AND intended_recipient_role IS NULL
       AND intended_team_id IS NULL
       AND NULLIF(BTRIM(external_recipient_ref), '') IS NOT NULL)
    ),
  CONSTRAINT care_handoff_receiving_tuple_check
    CHECK (
      (receiving_pathway_instance_id IS NULL
       AND receiving_workflow_run_id IS NULL
       AND receiving_step_key IS NULL)
      OR
      (receiving_pathway_instance_id IS NOT NULL
       AND receiving_workflow_run_id IS NOT NULL
       AND NULLIF(BTRIM(receiving_step_key), '') IS NOT NULL)
    ),
  CONSTRAINT care_handoff_nonblank_check
    CHECK (
      NULLIF(BTRIM(sending_step_key), '') IS NOT NULL
      AND NULLIF(BTRIM(handoff_type), '') IS NOT NULL
      AND NULLIF(BTRIM(source_resource_type), '') IS NOT NULL
      AND NULLIF(BTRIM(source_resource_id), '') IS NOT NULL
      AND NULLIF(BTRIM(urgency_code), '') IS NOT NULL
      AND NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
    ),
  CONSTRAINT care_handoff_status_evidence_check
    CHECK (
      (status <> 'acknowledged' OR acknowledged_at IS NOT NULL)
      AND (status NOT IN ('accepted', 'completed', 'closed_loop') OR accepted_at IS NOT NULL)
      AND (status NOT IN ('completed', 'closed_loop') OR completed_at IS NOT NULL)
      AND (status <> 'closed_loop' OR originator_closed_at IS NOT NULL)
      AND (status <> 'declined'
           OR (declined_at IS NOT NULL AND NULLIF(BTRIM(decline_reason), '') IS NOT NULL))
      AND (status <> 'cancelled'
           OR (cancelled_at IS NOT NULL AND NULLIF(BTRIM(cancellation_reason), '') IS NOT NULL))
    ),
  CONSTRAINT care_handoff_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX ux_care_handoff_idempotency
  ON care_handoff_instances (tenant_id, idempotency_key);

CREATE UNIQUE INDEX ux_care_handoff_tenant_id
  ON care_handoff_instances (tenant_id, id);

CREATE INDEX idx_care_handoff_sender
  ON care_handoff_instances (
    tenant_id, sending_pathway_instance_id, status, requested_at DESC
  );

CREATE INDEX idx_care_handoff_receiver
  ON care_handoff_instances (
    tenant_id, receiving_pathway_instance_id, status, requested_at DESC
  ) WHERE receiving_pathway_instance_id IS NOT NULL;

CREATE INDEX idx_care_handoff_due
  ON care_handoff_instances (tenant_id, status, policy_due_at)
  WHERE policy_due_at IS NOT NULL
    AND status IN ('requested', 'acknowledged', 'accepted');

CREATE INDEX idx_care_handoff_task
  ON care_handoff_instances (tenant_id, task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX idx_care_handoff_sending_instance_fk
  ON care_handoff_instances (
    tenant_id, sending_pathway_instance_id, patient_uid, sending_workflow_run_id
  );

CREATE INDEX idx_care_handoff_sending_step_fk
  ON care_handoff_instances (
    tenant_id, sending_workflow_run_id, sending_step_key
  );

CREATE INDEX idx_care_handoff_receiving_instance_fk
  ON care_handoff_instances (
    tenant_id, receiving_pathway_instance_id, patient_uid, receiving_workflow_run_id
  ) WHERE receiving_pathway_instance_id IS NOT NULL;

CREATE INDEX idx_care_handoff_receiving_step_fk
  ON care_handoff_instances (
    tenant_id, receiving_workflow_run_id, receiving_step_key
  ) WHERE receiving_workflow_run_id IS NOT NULL;

CREATE INDEX idx_care_handoff_sender_user
  ON care_handoff_instances (tenant_id, sender_uid)
  WHERE sender_uid IS NOT NULL;

CREATE INDEX idx_care_handoff_recipient_user
  ON care_handoff_instances (tenant_id, intended_recipient_uid)
  WHERE intended_recipient_uid IS NOT NULL;

CREATE INDEX idx_care_handoff_recipient_team
  ON care_handoff_instances (tenant_id, intended_team_id, patient_uid)
  WHERE intended_team_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Immutable pathway transition evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE care_pathway_transition_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  pathway_instance_id UUID NOT NULL,
  patient_uid UUID NOT NULL,
  workflow_run_id INTEGER NOT NULL,
  sequence_number INTEGER NOT NULL,
  transition_scope VARCHAR(30) NOT NULL,
  transition_key VARCHAR(120) NOT NULL,
  stage_key VARCHAR(120),
  workflow_step_id INTEGER,
  previous_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_resource_type VARCHAR(80),
  source_resource_id VARCHAR(160),
  workflow_sla_instance_id UUID,
  actor_uid UUID,
  system_actor_key VARCHAR(120),
  actor_role VARCHAR(80),
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  idempotency_key VARCHAR(200) NOT NULL,
  command_fingerprint CHAR(64) NOT NULL,
  effect_ordinal INTEGER NOT NULL DEFAULT 0,
  canonical_timeline_event_id UUID,
  canonical_audit_event_id UUID,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_care_pathway_transition_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_care_pathway_transition_instance
    FOREIGN KEY (tenant_id, pathway_instance_id, patient_uid, workflow_run_id)
    REFERENCES care_pathway_instances (tenant_id, id, patient_uid, workflow_run_id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fk_care_pathway_transition_step
    FOREIGN KEY (tenant_id, workflow_step_id, workflow_run_id, stage_key)
    REFERENCES workflow_steps (tenant_id, id, workflow_run_id, step_key)
    ON UPDATE NO ACTION ON DELETE SET NULL (workflow_step_id),
  CONSTRAINT fk_care_pathway_transition_sla
    FOREIGN KEY (tenant_id, workflow_sla_instance_id)
    REFERENCES workflow_sla_instances (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE SET NULL (workflow_sla_instance_id),
  CONSTRAINT fk_care_pathway_transition_timeline
    FOREIGN KEY (tenant_id, canonical_timeline_event_id)
    REFERENCES clinical_timeline_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE SET NULL (canonical_timeline_event_id),
  CONSTRAINT fk_care_pathway_transition_audit
    FOREIGN KEY (tenant_id, canonical_audit_event_id)
    REFERENCES clinical_audit_events (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE SET NULL (canonical_audit_event_id),
  CONSTRAINT fk_care_pathway_transition_actor
    FOREIGN KEY (tenant_id, actor_uid)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT care_pathway_transition_sequence_positive
    CHECK (sequence_number > 0),
  CONSTRAINT care_pathway_transition_effect_ordinal_check
    CHECK (effect_ordinal >= 0),
  CONSTRAINT care_pathway_transition_scope_check
    CHECK (transition_scope IN ('pathway', 'run', 'step', 'task', 'approval', 'handoff')),
  CONSTRAINT care_pathway_transition_actor_check
    CHECK ((actor_uid IS NOT NULL) <> (system_actor_key IS NOT NULL)),
  CONSTRAINT care_pathway_transition_source_pair_check
    CHECK (
      (source_resource_type IS NULL AND source_resource_id IS NULL)
      OR
      (NULLIF(BTRIM(source_resource_type), '') IS NOT NULL
       AND NULLIF(BTRIM(source_resource_id), '') IS NOT NULL)
    ),
  CONSTRAINT care_pathway_transition_nonblank_check
    CHECK (
      NULLIF(BTRIM(transition_key), '') IS NOT NULL
      AND NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
      AND (
        workflow_step_id IS NULL
        OR NULLIF(BTRIM(stage_key), '') IS NOT NULL
      )
      AND (system_actor_key IS NULL OR NULLIF(BTRIM(system_actor_key), '') IS NOT NULL)
    ),
  CONSTRAINT care_pathway_transition_fingerprint_check
    CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT care_pathway_transition_json_shapes
    CHECK (
      jsonb_typeof(previous_state) = 'object'
      AND jsonb_typeof(new_state) = 'object'
      AND jsonb_typeof(event_payload) = 'object'
      AND jsonb_typeof(metadata) = 'object'
    )
);

CREATE UNIQUE INDEX ux_care_pathway_transition_sequence
  ON care_pathway_transition_events (
    tenant_id, pathway_instance_id, sequence_number
  );

CREATE UNIQUE INDEX ux_care_pathway_transition_effect
  ON care_pathway_transition_events (tenant_id, idempotency_key, effect_ordinal);

CREATE INDEX idx_care_pathway_transition_instance
  ON care_pathway_transition_events (
    tenant_id, pathway_instance_id, occurred_at, sequence_number
  );

CREATE INDEX idx_care_pathway_transition_command
  ON care_pathway_transition_events (
    tenant_id, pathway_instance_id, idempotency_key, effect_ordinal
  );

CREATE INDEX idx_care_pathway_transition_patient
  ON care_pathway_transition_events (tenant_id, patient_uid, occurred_at DESC);

CREATE INDEX idx_care_pathway_transition_source
  ON care_pathway_transition_events (
    tenant_id, source_resource_type, source_resource_id, occurred_at DESC
  ) WHERE source_resource_type IS NOT NULL AND source_resource_id IS NOT NULL;

CREATE INDEX idx_care_pathway_transition_sla
  ON care_pathway_transition_events (tenant_id, workflow_sla_instance_id)
  WHERE workflow_sla_instance_id IS NOT NULL;

CREATE INDEX idx_care_pathway_transition_instance_fk
  ON care_pathway_transition_events (
    tenant_id, pathway_instance_id, patient_uid, workflow_run_id
  );

CREATE INDEX idx_care_pathway_transition_step_fk
  ON care_pathway_transition_events (
    tenant_id, workflow_step_id, workflow_run_id, stage_key
  ) WHERE workflow_step_id IS NOT NULL;

CREATE INDEX idx_care_pathway_transition_timeline_fk
  ON care_pathway_transition_events (tenant_id, canonical_timeline_event_id)
  WHERE canonical_timeline_event_id IS NOT NULL;

CREATE INDEX idx_care_pathway_transition_audit_fk
  ON care_pathway_transition_events (tenant_id, canonical_audit_event_id)
  WHERE canonical_audit_event_id IS NOT NULL;

CREATE INDEX idx_care_pathway_transition_actor
  ON care_pathway_transition_events (tenant_id, actor_uid)
  WHERE actor_uid IS NOT NULL;

CREATE OR REPLACE FUNCTION care_pathway_transition_require_canonical_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.canonical_timeline_event_id IS NULL
     OR NEW.canonical_audit_event_id IS NULL
  THEN
    RAISE EXCEPTION
      'care pathway transition insert requires canonical timeline and audit evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_care_pathway_transition_requires_canonical_evidence
  BEFORE INSERT ON care_pathway_transition_events
  FOR EACH ROW EXECUTE FUNCTION care_pathway_transition_require_canonical_evidence();

CREATE OR REPLACE FUNCTION care_pathway_transition_events_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.workflow_step_id IS NOT DISTINCT FROM OLD.workflow_step_id
       OR (
         OLD.workflow_step_id IS NOT NULL
         AND NEW.workflow_step_id IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM workflow_steps AS step
            WHERE step.tenant_id = OLD.tenant_id
              AND step.id = OLD.workflow_step_id
              AND step.workflow_run_id = OLD.workflow_run_id
         )
       )
     )
     AND (
       NEW.workflow_sla_instance_id IS NOT DISTINCT FROM OLD.workflow_sla_instance_id
       OR (
         OLD.workflow_sla_instance_id IS NOT NULL
         AND NEW.workflow_sla_instance_id IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM workflow_sla_instances AS sla
            WHERE sla.tenant_id = OLD.tenant_id
              AND sla.id = OLD.workflow_sla_instance_id
         )
       )
     )
     AND (
       NEW.canonical_timeline_event_id IS NOT DISTINCT FROM OLD.canonical_timeline_event_id
       OR (
         OLD.canonical_timeline_event_id IS NOT NULL
         AND NEW.canonical_timeline_event_id IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM clinical_timeline_events AS timeline
            WHERE timeline.tenant_id = OLD.tenant_id
              AND timeline.id = OLD.canonical_timeline_event_id
         )
       )
     )
     AND (
       NEW.canonical_audit_event_id IS NOT DISTINCT FROM OLD.canonical_audit_event_id
       OR (
         OLD.canonical_audit_event_id IS NOT NULL
         AND NEW.canonical_audit_event_id IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM clinical_audit_events AS audit
            WHERE audit.tenant_id = OLD.tenant_id
              AND audit.id = OLD.canonical_audit_event_id
         )
       )
     )
     AND (
       to_jsonb(NEW)
         - 'workflow_step_id'
         - 'workflow_sla_instance_id'
         - 'canonical_timeline_event_id'
         - 'canonical_audit_event_id'
     ) = (
       to_jsonb(OLD)
         - 'workflow_step_id'
         - 'workflow_sla_instance_id'
         - 'canonical_timeline_event_id'
         - 'canonical_audit_event_id'
     )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'care_pathway_transition_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER trg_care_pathway_transition_events_append_only
  BEFORE UPDATE OR DELETE ON care_pathway_transition_events
  FOR EACH ROW EXECUTE FUNCTION care_pathway_transition_events_block_mutation();

-- A terminal typed task is not itself proof that its clinical obligation was
-- satisfied. Validate the durable receipt that stopped the linked clock. This
-- second deferred invariant lives after transition-event creation because a
-- pathway domain-evidence completion writes the task, SLA, and immutable event
-- in one transaction and must be judged only at commit.
CREATE OR REPLACE FUNCTION care_pathway_assert_task_sla_completion_receipt(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  task_record tasks%ROWTYPE;
  sla_record workflow_sla_instances%ROWTYPE;
  evidence JSONB;
  provenance JSONB;
  acknowledged_at_text TEXT;
  acknowledged_by_text TEXT;
  acknowledged_via_text TEXT;
  completed_by_text TEXT;
  prior_started_at_text TEXT;
  acknowledged_at_value TIMESTAMPTZ;
  prior_started_at_value TIMESTAMPTZ;
  receipt_actor_valid BOOLEAN := FALSE;
  acknowledgement_authorization_valid BOOLEAN := FALSE;
  acknowledgement_receipt_valid BOOLEAN := FALSE;
  direct_completion_receipt_valid BOOLEAN := FALSE;
  potential_reopen_successor BOOLEAN := FALSE;
  reopen_match_count INTEGER := 0;
  reopen_receipt JSONB;
  evidence_event_count INTEGER := 0;
BEGIN
  SELECT task.*
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF NOT FOUND
     OR task_record.workflow_sla_instance_id IS NULL
     OR task_record.sla_completion_semantics = 'none'
  THEN
    RETURN;
  END IF;

  SELECT sla.*
    INTO sla_record
    FROM workflow_sla_instances AS sla
   WHERE sla.tenant_id = task_record.tenant_id
     AND sla.id = task_record.workflow_sla_instance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'typed task completion receipt has no linked SLA instance'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.sla_completion_semantics = 'acknowledgement' THEN
    IF task_record.status IN ('open', 'blocked', 'overdue') THEN
      IF sla_record.completed_at IS NOT NULL
         OR sla_record.status NOT IN ('active', 'breached', 'escalated')
         OR COALESCE(sla_record.metadata, '{}'::jsonb) ?| ARRAY[
              'completed_via',
              'completed_by_task',
              'completed_by',
              'acknowledged_at',
              'acknowledged_by',
              'acknowledged_via',
              'completion_evidence'
            ]
      THEN
        RAISE EXCEPTION
          'actionable acknowledgement task must have a clean incomplete SLA clock'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN;
    END IF;

    potential_reopen_successor :=
      task_record.status IN ('in_progress', 'completed', 'cancelled')
      AND sla_record.rule_code = 'critical_result_ack'
      AND EXISTS (
        SELECT 1
          FROM tasks AS successor
         WHERE successor.tenant_id = task_record.tenant_id
           AND successor.workflow_sla_instance_id = sla_record.id
           AND successor.sla_completion_semantics = 'acknowledgement'
           AND successor.patient_uid IS NOT DISTINCT FROM task_record.patient_uid
           AND successor.related_resource_type
                 IS NOT DISTINCT FROM task_record.related_resource_type
           AND successor.related_resource_id
                 IS NOT DISTINCT FROM task_record.related_resource_id
           AND successor.id > task_record.id
           AND successor.created_at >= task_record.created_at
           AND successor.metadata->>'reopened_from_task_id' = task_record.id::text
      );

    IF task_record.status IN ('in_progress', 'completed', 'cancelled')
       AND sla_record.completed_at IS NOT NULL
       AND NOT potential_reopen_successor
       AND task_record.due_at IS DISTINCT FROM sla_record.due_at
    THEN
      RAISE EXCEPTION
        'terminal acknowledgement task and terminal SLA deadlines must exactly match'
        USING ERRCODE = 'check_violation';
    END IF;

    acknowledged_at_text :=
      NULLIF(BTRIM(task_record.metadata->>'acknowledged_at'), '');
    acknowledged_by_text :=
      NULLIF(BTRIM(task_record.metadata->>'acknowledged_by'), '');
    acknowledged_via_text :=
      NULLIF(BTRIM(task_record.metadata->>'acknowledged_via'), '');
    completed_by_text :=
      NULLIF(BTRIM(sla_record.metadata->>'completed_by'), '');

    IF acknowledged_at_text IS NOT NULL
       AND acknowledged_at_text ~
             '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
       AND pg_input_is_valid(acknowledged_at_text, 'timestamp with time zone')
    THEN
      acknowledged_at_value := acknowledged_at_text::timestamptz;
    END IF;

    receipt_actor_valid := acknowledged_by_text IS NOT NULL
      AND acknowledged_by_text ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND pg_input_is_valid(acknowledged_by_text, 'uuid')
      AND EXISTS (
        SELECT 1
          FROM users AS actor
         WHERE actor.tenant_id = task_record.tenant_id
           AND actor.uid::text = LOWER(acknowledged_by_text)
         FOR SHARE
      );
    acknowledgement_authorization_valid :=
      acknowledged_via_text IN ('assignee', 'role', 'admin', 'override')
      AND (
        acknowledged_via_text <> 'override'
        OR (
          NULLIF(BTRIM(task_record.metadata->>'acknowledge_override_source'), '')
            IS NOT NULL
          AND NULLIF(BTRIM(task_record.metadata->>'acknowledge_override_id'), '')
            IS NOT NULL
          AND NULLIF(BTRIM(task_record.metadata->>'acknowledge_override_reason'), '')
            IS NOT NULL
          AND (
            (
              task_record.metadata->>'acknowledge_override_source' =
                'patient_access_break_glass'
              AND task_record.metadata->>'acknowledge_override_id' ~
                    '^[1-9][0-9]*$'
              AND pg_input_is_valid(
                    task_record.metadata->>'acknowledge_override_id',
                    'integer'
                  )
              AND EXISTS (
                SELECT 1
                  FROM patient_access_break_glass AS access_override
                 WHERE access_override.tenant_id = task_record.tenant_id
                   AND access_override.id =
                         (task_record.metadata->>'acknowledge_override_id')::integer
                   AND access_override.patient_uid = task_record.patient_uid
                   AND access_override.actor_uid::text =
                         LOWER(acknowledged_by_text)
                    AND access_override.reason =
                          task_record.metadata->>'acknowledge_override_reason'
                 FOR SHARE
              )
            )
            OR (
              task_record.metadata->>'acknowledge_override_source' =
                'cold_chain_excursion_ack'
              AND task_record.related_resource_type = 'cold_chain_excursions'
              AND task_record.related_resource_id =
                    task_record.metadata->>'acknowledge_override_id'
            )
          )
        )
      );

    acknowledgement_receipt_valid :=
      sla_record.completed_at IS NOT NULL
      AND sla_record.status IN ('completed', 'breached', 'escalated')
      AND sla_record.metadata->>'completed_by_task' = task_record.id::text
      AND sla_record.metadata->>'completed_via' = 'task_ack'
      AND acknowledged_at_value IS NOT NULL
      AND receipt_actor_valid
      AND acknowledgement_authorization_valid
      AND completed_by_text IS NOT NULL
      AND LOWER(completed_by_text) = LOWER(acknowledged_by_text)
      AND sla_record.started_at IS NOT NULL
      AND sla_record.completed_at =
            GREATEST(acknowledged_at_value, sla_record.started_at);

    direct_completion_receipt_valid :=
      task_record.status = 'completed'
      AND sla_record.completed_at IS NOT NULL
      AND sla_record.status IN ('completed', 'breached', 'escalated')
      AND sla_record.metadata->>'completed_by_task' = task_record.id::text
      AND sla_record.metadata->>'completed_via' = 'task_completion'
      AND completed_by_text IS NOT NULL
      AND completed_by_text ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND pg_input_is_valid(completed_by_text, 'uuid')
      AND EXISTS (
        SELECT 1
          FROM users AS actor
         WHERE actor.tenant_id = task_record.tenant_id
           AND actor.uid::text = LOWER(completed_by_text)
         FOR SHARE
      )
      AND task_record.completed_at IS NOT NULL
      AND sla_record.completed_at = task_record.completed_at;

    IF task_record.status IN ('in_progress', 'completed', 'cancelled')
       AND sla_record.completed_at IS NOT NULL
       AND NOT potential_reopen_successor
    THEN
      IF task_record.status = 'cancelled'
         AND NOT acknowledgement_receipt_valid
      THEN
        RAISE EXCEPTION
          'cancelled acknowledgement task requires a prior authenticated acknowledgement receipt'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT acknowledgement_receipt_valid
         AND NOT direct_completion_receipt_valid
      THEN
        RAISE EXCEPTION
          'terminal acknowledgement task requires an authenticated clock-stopping receipt'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN;
    END IF;

    IF task_record.status IN ('in_progress', 'completed', 'cancelled')
       AND potential_reopen_successor
       AND sla_record.rule_code = 'critical_result_ack'
    THEN
      SELECT COUNT(*)::integer
        INTO reopen_match_count
        FROM tasks AS successor
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(sla_record.metadata->'reopen_history') = 'array'
              THEN sla_record.metadata->'reopen_history'
            ELSE '[]'::jsonb
          END
        ) AS history(receipt)
       WHERE successor.tenant_id = task_record.tenant_id
         AND successor.workflow_sla_instance_id = sla_record.id
         AND successor.sla_completion_semantics = 'acknowledgement'
         AND successor.patient_uid IS NOT DISTINCT FROM task_record.patient_uid
         AND successor.related_resource_type
               IS NOT DISTINCT FROM task_record.related_resource_type
         AND successor.related_resource_id
               IS NOT DISTINCT FROM task_record.related_resource_id
         AND successor.id > task_record.id
         AND successor.created_at >= task_record.created_at
         AND successor.metadata->>'reopened_from_task_id' = task_record.id::text
         AND NULLIF(BTRIM(successor.metadata->>'reopen_reason'), '') IS NOT NULL
         AND history.receipt->>'prior_completed_by_task' = task_record.id::text
         AND history.receipt->'prior_due_at' = to_jsonb(task_record.due_at)
         AND history.receipt->>'reopen_reason' =
               successor.metadata->>'reopen_reason'
         AND history.receipt->>'rearmed_started_at' ~
               '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         AND pg_input_is_valid(
               history.receipt->>'rearmed_started_at',
               'timestamp with time zone'
             )
         AND successor.created_at >=
               (history.receipt->>'rearmed_started_at')::timestamptz
         AND history.receipt->'rearmed_due_at' = to_jsonb(successor.due_at)
         AND (
           NOT (history.receipt ? 'successor_task_id')
           OR history.receipt->>'successor_task_id' = successor.id::text
         )
         AND (
           history.receipt->>'database_authored_by'
             IS DISTINCT FROM 'migration_580_rolling_compat'
           OR (
             history.receipt->>'compatibility_state' = 'linked'
             AND history.receipt->>'successor_task_id' = successor.id::text
             AND successor.metadata->>'reopen_generation_id' =
                   history.receipt->>'generation_id'
           )
         );

      IF reopen_match_count = 1 THEN
        SELECT history.receipt
          INTO reopen_receipt
          FROM tasks AS successor
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(sla_record.metadata->'reopen_history') = 'array'
                THEN sla_record.metadata->'reopen_history'
              ELSE '[]'::jsonb
            END
          ) AS history(receipt)
         WHERE successor.tenant_id = task_record.tenant_id
           AND successor.workflow_sla_instance_id = sla_record.id
           AND successor.sla_completion_semantics = 'acknowledgement'
           AND successor.patient_uid IS NOT DISTINCT FROM task_record.patient_uid
           AND successor.related_resource_type
                 IS NOT DISTINCT FROM task_record.related_resource_type
           AND successor.related_resource_id
                 IS NOT DISTINCT FROM task_record.related_resource_id
           AND successor.id > task_record.id
           AND successor.created_at >= task_record.created_at
           AND successor.metadata->>'reopened_from_task_id' = task_record.id::text
           AND NULLIF(BTRIM(successor.metadata->>'reopen_reason'), '') IS NOT NULL
           AND history.receipt->>'prior_completed_by_task' = task_record.id::text
           AND history.receipt->'prior_due_at' = to_jsonb(task_record.due_at)
           AND history.receipt->>'reopen_reason' =
                 successor.metadata->>'reopen_reason'
           AND history.receipt->>'rearmed_started_at' ~
                 '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
           AND pg_input_is_valid(
                 history.receipt->>'rearmed_started_at',
                 'timestamp with time zone'
               )
           AND successor.created_at >=
                 (history.receipt->>'rearmed_started_at')::timestamptz
           AND history.receipt->'rearmed_due_at' = to_jsonb(successor.due_at)
           AND (
             NOT (history.receipt ? 'successor_task_id')
             OR history.receipt->>'successor_task_id' = successor.id::text
           )
           AND (
             history.receipt->>'database_authored_by'
               IS DISTINCT FROM 'migration_580_rolling_compat'
             OR (
               history.receipt->>'compatibility_state' = 'linked'
               AND history.receipt->>'successor_task_id' = successor.id::text
               AND successor.metadata->>'reopen_generation_id' =
                     history.receipt->>'generation_id'
             )
           )
         LIMIT 1;
      END IF;

      receipt_actor_valid := acknowledged_by_text IS NOT NULL
        AND acknowledged_by_text ~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND pg_input_is_valid(acknowledged_by_text, 'uuid')
        AND EXISTS (
          SELECT 1
            FROM users AS actor
           WHERE actor.tenant_id = task_record.tenant_id
             AND actor.uid::text = LOWER(acknowledged_by_text)
           FOR SHARE
        );
      prior_started_at_text :=
        NULLIF(BTRIM(reopen_receipt->>'prior_started_at'), '');
      IF prior_started_at_text IS NOT NULL
         AND prior_started_at_text ~
               '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         AND pg_input_is_valid(
               prior_started_at_text,
               'timestamp with time zone'
             )
      THEN
        prior_started_at_value := prior_started_at_text::timestamptz;
      END IF;
      acknowledgement_receipt_valid := reopen_match_count = 1
        AND reopen_receipt->>'prior_completed_via' = 'task_ack'
        AND acknowledged_at_value IS NOT NULL
        AND prior_started_at_value IS NOT NULL
        AND receipt_actor_valid
        AND acknowledgement_authorization_valid
        AND reopen_receipt->>'prior_completed_by' = acknowledged_by_text
        AND reopen_receipt->'prior_completed_at' =
              to_jsonb(GREATEST(acknowledged_at_value, prior_started_at_value));
      direct_completion_receipt_valid := reopen_match_count = 1
        AND task_record.status = 'completed'
        AND reopen_receipt->>'prior_completed_via' = 'task_completion'
        AND NULLIF(BTRIM(reopen_receipt->>'prior_completed_by'), '') IS NOT NULL
        AND reopen_receipt->>'prior_completed_by' ~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND pg_input_is_valid(reopen_receipt->>'prior_completed_by', 'uuid')
        AND EXISTS (
          SELECT 1
            FROM users AS actor
           WHERE actor.tenant_id = task_record.tenant_id
             AND actor.uid::text =
                   LOWER(reopen_receipt->>'prior_completed_by')
           FOR SHARE
        )
        AND task_record.completed_at IS NOT NULL
        AND reopen_receipt->'prior_completed_at' =
              to_jsonb(task_record.completed_at);

      IF task_record.status = 'cancelled'
         AND NOT acknowledgement_receipt_valid
      THEN
        RAISE EXCEPTION
          'cancelled reopened predecessor requires a prior authenticated acknowledgement receipt'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT acknowledgement_receipt_valid
         AND NOT direct_completion_receipt_valid
      THEN
        RAISE EXCEPTION
          'terminal task with a rearmed SLA requires exact predecessor and successor receipts'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN;
    END IF;

    RAISE EXCEPTION
      'acknowledgement task and SLA completion receipt are inconsistent'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.sla_completion_semantics = 'domain_evidence' THEN
    IF task_record.status IN ('open', 'in_progress', 'blocked', 'overdue') THEN
      IF sla_record.completed_at IS NOT NULL
         OR sla_record.status NOT IN ('active', 'breached', 'escalated')
         OR COALESCE(sla_record.metadata, '{}'::jsonb) ?| ARRAY[
              'completed_via',
              'completed_by_task',
              'completed_by',
              'acknowledged_at',
              'acknowledged_by',
              'acknowledged_via',
              'completion_evidence'
            ]
      THEN
        RAISE EXCEPTION
          'actionable domain-evidence task must have a clean incomplete SLA clock'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN;
    END IF;

    IF task_record.status IN ('completed', 'cancelled')
       AND sla_record.completed_at IS NOT NULL
       AND task_record.due_at IS DISTINCT FROM sla_record.due_at
    THEN
      RAISE EXCEPTION
        'terminal domain-evidence task and terminal SLA deadlines must exactly match'
        USING ERRCODE = 'check_violation';
    END IF;

    completed_by_text :=
      NULLIF(BTRIM(sla_record.metadata->>'completed_by'), '');
    evidence := sla_record.metadata->'completion_evidence';
    IF task_record.status NOT IN ('completed', 'cancelled')
       OR sla_record.completed_at IS NULL
       OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
       OR sla_record.metadata->>'completed_via' IS DISTINCT FROM 'domain_evidence'
       OR sla_record.metadata->>'completed_by_task' IS DISTINCT FROM task_record.id::text
       OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
    THEN
      RAISE EXCEPTION
        'terminal domain-evidence task requires its exact completed SLA receipt'
        USING ERRCODE = 'check_violation';
    END IF;

    IF sla_record.rule_code = 'mortuary_unclaimed_body' THEN
      IF evidence->>'kind' IS DISTINCT FROM 'mortuary_body_release'
         OR evidence->>'resource_type' IS DISTINCT FROM 'body_custody_event'
         OR evidence->>'resource_id' !~ '^[1-9][0-9]*$'
         OR NOT pg_input_is_valid(evidence->>'resource_id', 'bigint')
         OR evidence->>'occurred_at' !~
               '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         OR NOT pg_input_is_valid(
               evidence->>'occurred_at',
               'timestamp with time zone'
             )
         OR evidence->>'recorded_at' !~
               '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
         OR NOT pg_input_is_valid(
               evidence->>'recorded_at',
               'timestamp with time zone'
             )
         OR NOT EXISTS (
           SELECT 1
             FROM body_custody_events AS custody
            WHERE custody.tenant_id = task_record.tenant_id
              AND custody.id = (evidence->>'resource_id')::bigint
              AND custody.death_record_id::text = task_record.related_resource_id
              AND custody.event_type = 'release'
              AND date_trunc('milliseconds', custody.event_at) =
                    date_trunc(
                      'milliseconds',
                      (evidence->>'occurred_at')::timestamptz
                    )
              AND date_trunc('milliseconds', custody.created_at) =
                    date_trunc(
                      'milliseconds',
                      (evidence->>'recorded_at')::timestamptz
                    )
              AND date_trunc('milliseconds', sla_record.completed_at) =
                    date_trunc('milliseconds', custody.created_at)
              AND (
                completed_by_text IS NULL
                OR (
                  completed_by_text ~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  AND pg_input_is_valid(completed_by_text, 'uuid')
                  AND custody.performed_by::text = LOWER(completed_by_text)
                  AND EXISTS (
                    SELECT 1
                      FROM users AS actor
                     WHERE actor.tenant_id = task_record.tenant_id
                       AND actor.uid::text = LOWER(completed_by_text)
                  )
                )
              )
         )
      THEN
        RAISE EXCEPTION
          'mortuary domain-evidence receipt does not match its durable release event'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN;
    END IF;

    IF task_record.workflow_step_id IS NOT NULL
       AND sla_record.source_table = 'workflow_steps'
       AND sla_record.source_id = task_record.workflow_step_id::text
    THEN
      provenance := evidence->'provenance';
      IF evidence->>'kind' IS DISTINCT FROM 'pathway_registered_condition'
         OR evidence->>'decision' IS DISTINCT FROM 'satisfied'
         OR evidence->>'resource_type' IS DISTINCT FROM 'workflow_steps'
         OR evidence->>'resource_id' IS DISTINCT FROM task_record.workflow_step_id::text
         OR NULLIF(BTRIM(evidence->>'handler_id'), '') IS NULL
         OR jsonb_typeof(evidence->'payload') IS DISTINCT FROM 'object'
         OR jsonb_typeof(provenance) IS DISTINCT FROM 'object'
         OR NOT EXISTS (
           SELECT 1
             FROM workflow_steps AS step
             JOIN workflow_runs AS run
               ON run.tenant_id = step.tenant_id
              AND run.id = step.workflow_run_id
             JOIN workflow_definitions AS definition
               ON definition.tenant_id = run.tenant_id
              AND definition.id = run.workflow_definition_id
              AND definition.workflow_key = run.workflow_key
              AND definition.version = run.workflow_version
             JOIN care_pathway_definition_governance AS governance
               ON governance.tenant_id = definition.tenant_id
              AND governance.workflow_definition_id = definition.id
              AND governance.governance_status IN ('approved', 'retired')
             JOIN care_pathway_instances AS instance
               ON instance.tenant_id = run.tenant_id
              AND instance.workflow_run_id = run.id
              AND instance.patient_uid = task_record.patient_uid
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(definition.steps) = 'array'
                   THEN definition.steps
                 ELSE '[]'::jsonb
               END
             ) AS pinned(step_definition)
            WHERE step.tenant_id = task_record.tenant_id
              AND step.id = task_record.workflow_step_id
              AND step.workflow_run_id = task_record.workflow_run_id
              AND pinned.step_definition->>'step_key' = step.step_key
              AND pinned.step_definition->>'condition_handler' =
                    evidence->>'handler_id'
              AND sla_record.metadata->>'care_pathway_instance_id' =
                    instance.id::text
              AND sla_record.metadata->>'workflow_run_id' = run.id::text
              AND sla_record.metadata->>'workflow_step_id' = step.id::text
              AND sla_record.metadata->>'stage_key' = step.step_key
         )
      THEN
        RAISE EXCEPTION
          'pathway domain-evidence receipt does not match its pinned governed condition'
          USING ERRCODE = 'check_violation';
      END IF;

      IF provenance->>'actor_kind' = 'user' THEN
        IF provenance->>'actor_uid' !~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR NOT pg_input_is_valid(provenance->>'actor_uid', 'uuid')
           OR NOT EXISTS (
             SELECT 1
               FROM users AS actor
              WHERE actor.tenant_id = task_record.tenant_id
                AND actor.uid::text = LOWER(provenance->>'actor_uid')
           )
           OR NULLIF(BTRIM(provenance->>'authorization_mode'), '') IS NULL
           OR sla_record.metadata->>'completed_by' IS DISTINCT FROM
                provenance->>'actor_uid'
        THEN
          RAISE EXCEPTION
            'pathway domain-evidence user provenance is not authenticated'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF provenance->>'actor_kind' = 'system' THEN
        IF NULLIF(BTRIM(provenance->>'system_key'), '') IS NULL
           OR provenance->>'source_event_id' !~ '^[0-9]+$'
           OR NULLIF(BTRIM(sla_record.metadata->>'completed_by'), '') IS NOT NULL
        THEN
          RAISE EXCEPTION
            'pathway domain-evidence system provenance is incomplete'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        RAISE EXCEPTION
          'pathway domain-evidence provenance actor kind is invalid'
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT COUNT(*)::integer
        INTO evidence_event_count
        FROM care_pathway_transition_events AS event
       WHERE event.tenant_id = task_record.tenant_id
         AND event.transition_scope = 'task'
         AND event.transition_key = 'domain_evidence_task_completed'
         AND event.patient_uid = task_record.patient_uid
         AND event.workflow_run_id = task_record.workflow_run_id
         AND event.workflow_step_id = task_record.workflow_step_id
         AND event.workflow_sla_instance_id = sla_record.id
         AND event.source_resource_type = 'tasks'
         AND event.source_resource_id = task_record.id::text
         AND event.new_state->>'task_status' = 'completed'
         AND event.event_payload->>'task_id' = task_record.id::text
         AND event.event_payload->>'workflow_sla_instance_id' = sla_record.id::text
         AND event.event_payload->'evidence'->>'kind' = evidence->>'kind'
         AND event.event_payload->'evidence'->>'handler_id' = evidence->>'handler_id'
         AND event.event_payload->'evidence'->>'decision' = evidence->>'decision'
         AND event.event_payload->'evidence'->>'resource_type' =
               evidence->>'resource_type'
         AND event.event_payload->'evidence'->>'resource_id' =
               evidence->>'resource_id'
         AND event.event_payload->'evidence'->'provenance' = provenance
         AND (
           (provenance->>'actor_kind' = 'user'
            AND event.actor_uid::text = LOWER(provenance->>'actor_uid')
            AND event.system_actor_key IS NULL)
           OR
           (provenance->>'actor_kind' = 'system'
            AND event.actor_uid IS NULL
            AND event.system_actor_key = provenance->>'system_key')
         )
         -- The executor hashes canonical JavaScript serialization, whose byte
         -- layout is intentionally not reimplemented with PostgreSQL jsonb
         -- text. Every reference field and provenance object is compared
         -- above; the fingerprint is additionally required to be canonical.
         AND event.event_payload->'evidence'->>'evidence_fingerprint' ~
               '^[0-9a-f]{64}$';
      IF evidence_event_count < 1 THEN
        RAISE EXCEPTION
          'pathway domain-evidence completion lacks immutable transition evidence'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN;
    END IF;

    RAISE EXCEPTION
      'domain-evidence task source is not a registered completion contract'
      USING ERRCODE = 'check_violation';
  END IF;

  RAISE EXCEPTION
    'typed task has an unknown SLA completion receipt contract'
    USING ERRCODE = 'check_violation';
END;
$$;

-- A draining mortuary replica completes the typed task through the generic
-- task transition after it records the release event. Promote that legacy SLA
-- write to the canonical domain-evidence receipt before deferred validation.
CREATE OR REPLACE FUNCTION workflow_sla_normalize_rolling_legacy_mortuary_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_id_text TEXT;
  task_record tasks%ROWTYPE;
  release_record RECORD;
  actor_uid UUID;
  prior_normalizations JSONB;
  submitted_status TEXT;
  submitted_completed_at TIMESTAMPTZ;
  submitted_breached_at TIMESTAMPTZ;
  submitted_completed_via JSONB;
  submitted_metadata JSONB;
BEGIN
  IF OLD.rule_code IS DISTINCT FROM 'mortuary_unclaimed_body'
     OR OLD.completed_at IS NOT NULL
     OR NEW.completed_at IS NULL
     OR NEW.status NOT IN ('completed', 'breached', 'escalated')
     OR NEW.metadata->>'completed_via' = 'domain_evidence'
  THEN
    RETURN NEW;
  END IF;

  task_id_text := NULLIF(BTRIM(NEW.metadata->>'completed_by_task'), '');
  IF task_id_text IS NULL
     OR task_id_text !~ '^[1-9][0-9]*$'
     OR NOT pg_input_is_valid(task_id_text, 'integer')
  THEN
    RETURN NEW;
  END IF;
  SELECT task.*
    INTO task_record
    FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.id = task_id_text::integer
     AND task.workflow_sla_instance_id = NEW.id
     AND task.sla_completion_semantics = 'domain_evidence'
     AND task.status = 'completed'
     AND task.related_resource_type = 'death_record'
     AND task.related_resource_id = NEW.source_id
     AND task.patient_uid IS NOT DISTINCT FROM NEW.patient_uid
     AND task.due_at IS NOT DISTINCT FROM NEW.due_at;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT custody.id,
         custody.event_at,
         custody.created_at,
         custody.performed_by
    INTO release_record
    FROM body_custody_events AS custody
   WHERE custody.tenant_id = NEW.tenant_id
     AND custody.death_record_id::text = NEW.source_id
     AND custody.event_type = 'release'
     AND custody.created_at >= OLD.started_at
     AND custody.created_at <= NEW.completed_at
   ORDER BY custody.created_at DESC, custody.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT actor.uid
    INTO actor_uid
    FROM users AS actor
   WHERE actor.tenant_id = NEW.tenant_id
     AND actor.uid = release_record.performed_by
   LIMIT 1;
  prior_normalizations := CASE
    WHEN jsonb_typeof(
           NEW.metadata->'rolling_legacy_mortuary_normalization_history'
         ) = 'array'
      THEN NEW.metadata->'rolling_legacy_mortuary_normalization_history'
    ELSE '[]'::jsonb
  END;
  submitted_status := NEW.status;
  submitted_completed_at := NEW.completed_at;
  submitted_breached_at := NEW.breached_at;
  submitted_completed_via := NEW.metadata->'completed_via';
  submitted_metadata := NEW.metadata;

  NEW.completed_at := release_record.created_at;
  NEW.status := CASE
    WHEN OLD.status = 'escalated' THEN 'escalated'
    WHEN NEW.due_at IS NOT NULL AND release_record.created_at > NEW.due_at
      THEN 'breached'
    ELSE 'completed'
  END;
  NEW.breached_at := CASE
    WHEN NEW.due_at IS NOT NULL AND release_record.created_at > NEW.due_at
      THEN COALESCE(NEW.breached_at, NEW.due_at)
    WHEN OLD.status = 'escalated' THEN OLD.breached_at
    ELSE NULL
  END;
  NEW.metadata := (
      COALESCE(NEW.metadata, '{}'::jsonb)
        - 'completed_via'
        - 'completed_by'
        - 'completion_evidence'
    ) || jsonb_build_object(
      'completed_via', 'domain_evidence',
      'completed_by_task', task_record.id,
      'completion_evidence', jsonb_build_object(
        'kind', 'mortuary_body_release',
        'resource_type', 'body_custody_event',
        'resource_id', release_record.id::text,
        'occurred_at', release_record.event_at,
        'recorded_at', release_record.created_at
      ),
      'rolling_legacy_mortuary_normalization_history',
        prior_normalizations || jsonb_build_array(jsonb_build_object(
          'normalized_at', NOW(),
          'task_id', task_record.id,
          'submitted_status', submitted_status,
          'submitted_completed_at', submitted_completed_at,
          'submitted_breached_at', submitted_breached_at,
          'submitted_completed_via', submitted_completed_via,
          'submitted_metadata', submitted_metadata,
          'release_event_id', release_record.id
        ))
    ) || CASE
      WHEN actor_uid IS NOT NULL
        THEN jsonb_build_object('completed_by', actor_uid)
      ELSE '{}'::jsonb
    END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_sla_normalize_rolling_legacy_mortuary
  ON workflow_sla_instances;
CREATE TRIGGER trg_workflow_sla_normalize_rolling_legacy_mortuary
  BEFORE UPDATE OF status, completed_at, breached_at, metadata
  ON workflow_sla_instances
  FOR EACH ROW EXECUTE FUNCTION workflow_sla_normalize_rolling_legacy_mortuary_completion();

-- Old critical-result and mortuary producers can commit a newly started SLA
-- before their separate task transaction. During the two-release drain,
-- materialize those marker-free legacy shapes in the database. New atomic
-- producers stamp `task_materialization_contract=application_atomic_v1`;
-- their own richer task must satisfy the same deferred reverse obligation.
CREATE OR REPLACE FUNCTION workflow_sla_materialize_rolling_initial_human_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_semantics TEXT;
  task_resource_type TEXT;
  task_title TEXT;
  task_description TEXT;
  task_role TEXT;
  task_assignee UUID;
  task_created_by UUID;
  receive_record RECORD;
  requested_owner_uid UUID;
  requested_owner_tenant_id UUID;
  requested_owner_is_active BOOLEAN;
  requested_owner_role TEXT;
  candidate_owner_role TEXT;
  owner_resolution TEXT;
  owner_resolution_reason TEXT;
  actionable_count INTEGER;
  exact_count INTEGER;
BEGIN
  IF NEW.completed_at IS NOT NULL
     OR NEW.status NOT IN ('active', 'breached', 'escalated')
     OR NEW.metadata->>'task_materialization_contract' =
          'application_atomic_v1'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.rule_code = 'critical_result_ack' THEN
    IF NEW.source_table IS NULL
       OR NULLIF(BTRIM(NEW.source_id), '') IS NULL
       OR NEW.patient_uid IS NULL
       OR NEW.due_at IS NULL
    THEN
      RETURN NEW;
    END IF;
    expected_semantics := 'acknowledgement';
    task_resource_type := NEW.source_table;
    task_title := 'Critical result acknowledgement required';
    IF NEW.source_table = 'lab_result' THEN
      IF NEW.source_id !~ '^[1-9][0-9]*$'
         OR NOT pg_input_is_valid(NEW.source_id, 'integer')
      THEN
        RETURN NEW;
      END IF;
      SELECT investigation.requested_by
        INTO requested_owner_uid
        FROM lab_results AS result
        LEFT JOIN investigations AS investigation
          ON investigation.tenant_id = result.tenant_id
         AND investigation.id = result.investigation_id
       WHERE result.tenant_id = NEW.tenant_id
         AND result.id = NEW.source_id::integer
         AND result.patient_uid = NEW.patient_uid
       LIMIT 1;
      IF NOT FOUND THEN
        RETURN NEW;
      END IF;
    ELSIF NEW.source_table = 'investigations' THEN
      IF NEW.source_id !~ '^[1-9][0-9]*$'
         OR NOT pg_input_is_valid(NEW.source_id, 'integer')
      THEN
        RETURN NEW;
      END IF;
      SELECT investigation.requested_by
        INTO requested_owner_uid
        FROM investigations AS investigation
       WHERE investigation.tenant_id = NEW.tenant_id
         AND investigation.id = NEW.source_id::integer
         AND investigation.patient_uid = NEW.patient_uid
       LIMIT 1;
      IF NOT FOUND THEN
        RETURN NEW;
      END IF;
    ELSIF NEW.source_table = 'task_candidate' THEN
      IF NEW.source_id !~ '^[1-9][0-9]*$'
         OR NOT pg_input_is_valid(NEW.source_id, 'integer')
      THEN
        RETURN NEW;
      END IF;
      SELECT candidate.owner_role
        INTO candidate_owner_role
        FROM clinical_ai_task_candidates AS candidate
       WHERE candidate.tenant_id = NEW.tenant_id
         AND candidate.id = NEW.source_id::integer
         AND candidate.patient_uid IS NOT DISTINCT FROM NEW.patient_uid
         AND candidate.reviewer_decision = 'accepted'
       LIMIT 1;
      IF NOT FOUND THEN
        RETURN NEW;
      END IF;
      task_role := CASE NULLIF(BTRIM(candidate_owner_role), '')
        WHEN 'DUTY' THEN 'DUTY_DOCTOR'
        WHEN 'LEADERSHIP' THEN 'CMO'
        ELSE COALESCE(NULLIF(BTRIM(candidate_owner_role), ''), 'DUTY_DOCTOR')
      END;
      owner_resolution := CASE
        WHEN NULLIF(BTRIM(candidate_owner_role), '') IS NULL
          THEN 'duty_role_fallback'
        ELSE 'candidate_owner_role'
      END;
      owner_resolution_reason := CASE
        WHEN NULLIF(BTRIM(candidate_owner_role), '') IS NULL THEN 'missing'
        ELSE 'resolved_role'
      END;
      IF NOT care_pathway_is_route_actionable_human_role(
               task_role,
               'critical_result_ack'
             )
      THEN
        RAISE EXCEPTION
          'accepted task-candidate owner role cannot service the clinical obligation'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.source_table = 'clinical_alert' THEN
      IF NEW.source_id !~ '^[1-9][0-9]*$'
         OR NOT pg_input_is_valid(NEW.source_id, 'integer')
         OR NOT EXISTS (
           SELECT 1
             FROM clinical_alerts AS alert
             JOIN users AS patient
               ON patient.id = alert.patient_id
              AND patient.tenant_id = NEW.tenant_id
              AND patient.uid = NEW.patient_uid
            WHERE alert.id = NEW.source_id::integer
              AND alert.tenant_id = NEW.tenant_id
              AND LOWER(BTRIM(alert.severity)) = 'critical'
         )
      THEN
        RETURN NEW;
      END IF;
      task_role := 'DUTY_DOCTOR';
      owner_resolution := 'duty_role_fallback';
      owner_resolution_reason := 'missing';
    ELSIF NEW.source_table = 'news2_score' THEN
      IF NEW.source_id !~ '^[1-9][0-9]*$'
         OR NOT pg_input_is_valid(NEW.source_id, 'integer')
         OR NOT EXISTS (
           SELECT 1
             FROM news2_scores AS score
             JOIN users AS patient
               ON patient.uid = score.patient_uid
              AND patient.tenant_id = NEW.tenant_id
            WHERE score.id = NEW.source_id::integer
              AND score.tenant_id = NEW.tenant_id
              AND score.patient_uid = NEW.patient_uid
              AND score.total_score >= 5
         )
      THEN
        RETURN NEW;
      END IF;
      task_role := 'DUTY_DOCTOR';
      owner_resolution := 'duty_role_fallback';
      owner_resolution_reason := 'missing';
    ELSIF NEW.source_table IN ('abnormal_triage', 'lab_autoverification') THEN
      RAISE EXCEPTION
        'dormant clinical-AI critical source requires manual rolling reconciliation'
        USING ERRCODE = 'check_violation';
    ELSE
      RAISE EXCEPTION
        'rolling critical-result SLA source is unsupported for exact owner materialization'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.source_table IN ('lab_result', 'investigations') THEN
      IF requested_owner_uid IS NULL THEN
        owner_resolution_reason := 'missing';
      ELSE
        SELECT owner.tenant_id,
               owner.is_active,
               owner.role
          INTO requested_owner_tenant_id,
               requested_owner_is_active,
               requested_owner_role
          FROM users AS owner
         WHERE owner.uid = requested_owner_uid
         LIMIT 1;
        IF NOT FOUND THEN
          owner_resolution_reason := 'missing';
        ELSIF requested_owner_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
          owner_resolution_reason := 'cross_tenant';
        ELSIF requested_owner_is_active IS DISTINCT FROM TRUE THEN
          owner_resolution_reason := 'inactive';
        ELSIF NOT care_pathway_is_route_actionable_human_role(
                    requested_owner_role,
                    'critical_result_ack'
                  )
        THEN
          owner_resolution_reason := 'non_clinical';
        ELSE
          task_assignee := requested_owner_uid;
          owner_resolution_reason := 'resolved_active';
        END IF;
      END IF;
      IF task_assignee IS NULL THEN
        task_role := 'DUTY_DOCTOR';
        owner_resolution := 'duty_role_fallback';
      ELSE
        task_role := NULL;
        owner_resolution := 'requested_by';
      END IF;
    END IF;
  ELSIF NEW.rule_code = 'mortuary_unclaimed_body' THEN
    IF NEW.source_table IS DISTINCT FROM 'death_records'
       OR NEW.source_id !~ '^[1-9][0-9]*$'
       OR NOT pg_input_is_valid(NEW.source_id, 'integer')
       OR NEW.due_at IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM death_records AS death_record
          WHERE death_record.tenant_id = NEW.tenant_id
            AND death_record.id = NEW.source_id::integer
       )
    THEN
      RETURN NEW;
    END IF;
    SELECT custody.id,
           custody.event_type,
           custody.is_unclaimed,
           custody.performed_by,
           custody.event_at,
           custody.created_at
      INTO receive_record
      FROM body_custody_events AS custody
     WHERE custody.tenant_id = NEW.tenant_id
       AND custody.death_record_id = NEW.source_id::integer
       AND custody.event_type = 'receive'
       AND custody.is_unclaimed = TRUE
       AND custody.created_at <= NEW.started_at
     ORDER BY custody.created_at DESC, custody.id DESC
     LIMIT 1;
    IF NOT FOUND
       OR EXISTS (
         SELECT 1
           FROM body_custody_events AS later_release
          WHERE later_release.tenant_id = NEW.tenant_id
            AND later_release.death_record_id = NEW.source_id::integer
            AND later_release.event_type = 'release'
            AND later_release.created_at >= receive_record.created_at
            AND later_release.created_at <= NEW.started_at
       )
    THEN
      RETURN NEW;
    END IF;
    expected_semantics := 'domain_evidence';
    task_resource_type := 'death_record';
    task_title := 'Unclaimed body custody follow-up: death record #' || NEW.source_id;
    task_description :=
      'Body received into mortuary custody without a claimant or release plan.';
    task_role := 'MEDICAL_RECORDS';
    task_created_by := receive_record.performed_by;
    owner_resolution := 'fixed_role';
    owner_resolution_reason := 'mortuary_medical_records';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO tasks (
    tenant_id,
    task_kind,
    title,
    description,
    patient_uid,
    related_resource_type,
    related_resource_id,
    priority,
    status,
    assigned_to_uid,
    assigned_to_role,
    created_by,
    due_at,
    workflow_sla_instance_id,
    sla_completion_semantics,
    metadata
  ) VALUES (
    NEW.tenant_id,
    'review',
    task_title,
    task_description,
    NEW.patient_uid,
    task_resource_type,
    NEW.source_id,
    COALESCE(NEW.priority, 'critical'),
    'open',
    task_assignee,
    task_role,
    task_created_by,
    NEW.due_at,
    NEW.id,
    expected_semantics,
    jsonb_build_object(
      'source', NEW.source_table,
      'sla_key', NEW.rule_code,
      'sla_instance_id', NEW.id::text,
      'task_materialized_by', 'migration_580_rolling_compat',
      'legacy_owner_resolution', jsonb_build_object(
        'mode', owner_resolution,
        'reason', owner_resolution_reason
      ),
      'initial_evidence', CASE
        WHEN receive_record.id IS NULL THEN NULL
        ELSE jsonb_build_object(
          'kind', 'mortuary_unclaimed_receive',
          'resource_type', 'body_custody_event',
          'resource_id', receive_record.id::text,
          'occurred_at', receive_record.event_at,
          'recorded_at', receive_record.created_at
        )
      END
    )
  )
  ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
    WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
      AND related_resource_type IS NOT NULL
      AND related_resource_id IS NOT NULL
  DO NOTHING;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (
           WHERE task.workflow_sla_instance_id = NEW.id
             AND task.task_kind = 'review'
             AND task.sla_completion_semantics = expected_semantics
              AND task.patient_uid IS NOT DISTINCT FROM NEW.patient_uid
              AND task.due_at = NEW.due_at
              AND task.assigned_to_uid IS NOT DISTINCT FROM task_assignee
              AND task.assigned_to_role IS NOT DISTINCT FROM task_role
          )::integer
    INTO actionable_count,
         exact_count
   FROM tasks AS task
   WHERE task.tenant_id = NEW.tenant_id
     AND task.related_resource_type = task_resource_type
     AND task.related_resource_id = NEW.source_id
     AND task.status IN ('open', 'in_progress', 'blocked', 'overdue');

  IF actionable_count <> 1 OR exact_count <> 1 THEN
    RAISE EXCEPTION
      'rolling human-action SLA insert conflicts with an incompatible active task'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_sla_materialize_rolling_initial_human_task
  ON workflow_sla_instances;
CREATE TRIGGER trg_workflow_sla_materialize_rolling_initial_human_task
  AFTER INSERT ON workflow_sla_instances
  FOR EACH ROW EXECUTE FUNCTION workflow_sla_materialize_rolling_initial_human_task();

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
                       AND owner.is_active = TRUE
                        AND care_pathway_is_route_actionable_human_role(
                              owner.role,
                              sla_record.rule_code
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

-- A named human owner is a live routing dependency rather than durable receipt
-- evidence. Revalidate an incomplete obligation when that user is deactivated,
-- moved, renamed, deleted, or changed to a role with no servicing route. The
-- task/SLA reads stay non-locking; the one-way owner FOR SHARE above serializes
-- a concurrent assignment with this user mutation without restoring the former
-- task <-> SLA lock cycle.
CREATE OR REPLACE FUNCTION care_pathway_named_owner_dependency_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM care_pathway_assert_human_sla_task_obligation(
              obligation.tenant_id,
              obligation.workflow_sla_instance_id
            )
      FROM (
        SELECT DISTINCT task.tenant_id,
                        task.workflow_sla_instance_id
          FROM tasks AS task
          JOIN workflow_sla_instances AS sla
            ON sla.tenant_id = task.tenant_id
           AND sla.id = task.workflow_sla_instance_id
         WHERE task.tenant_id = OLD.tenant_id
           AND task.assigned_to_uid = OLD.uid
           AND sla.completed_at IS NULL
           AND sla.status IN ('active', 'breached', 'escalated')
      ) AS obligation;
  ELSE
    PERFORM care_pathway_assert_human_sla_task_obligation(
              obligation.tenant_id,
              obligation.workflow_sla_instance_id
            )
      FROM (
        SELECT DISTINCT task.tenant_id,
                        task.workflow_sla_instance_id
          FROM tasks AS task
          JOIN workflow_sla_instances AS sla
            ON sla.tenant_id = task.tenant_id
           AND sla.id = task.workflow_sla_instance_id
         WHERE sla.completed_at IS NULL
           AND sla.status IN ('active', 'breached', 'escalated')
           AND (
             (task.tenant_id = OLD.tenant_id
              AND task.assigned_to_uid = OLD.uid)
             OR
             (task.tenant_id = NEW.tenant_id
              AND task.assigned_to_uid = NEW.uid)
           )
      ) AS obligation;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_users_human_owner_dependency_delete
  AFTER DELETE ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_named_owner_dependency_constraint();

CREATE CONSTRAINT TRIGGER trg_users_human_owner_dependency_viability
  AFTER UPDATE OF tenant_id, uid, is_active, role ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_named_owner_dependency_constraint();

CREATE OR REPLACE FUNCTION care_pathway_task_sla_completion_receipt_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'tasks' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.workflow_sla_instance_id IS NOT NULL
         AND OLD.sla_completion_semantics <> 'none'
         AND EXISTS (
           SELECT 1
             FROM workflow_sla_instances AS sla
            WHERE sla.tenant_id = OLD.tenant_id
              AND sla.id = OLD.workflow_sla_instance_id
         )
      THEN
        RAISE EXCEPTION
          'typed clinical task cannot be deleted while its SLA obligation survives'
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM care_pathway_assert_human_sla_task_obligation(
        OLD.tenant_id,
        OLD.workflow_sla_instance_id
      );
    ELSE
      IF TG_OP = 'UPDATE'
         AND OLD.workflow_sla_instance_id IS NOT NULL
         AND OLD.sla_completion_semantics <> 'none'
         AND (
           NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
           OR NEW.id IS DISTINCT FROM OLD.id
           OR NEW.workflow_sla_instance_id
                IS DISTINCT FROM OLD.workflow_sla_instance_id
         )
         AND EXISTS (
           SELECT 1
             FROM workflow_sla_instances AS sla
            WHERE sla.tenant_id = OLD.tenant_id
              AND sla.id = OLD.workflow_sla_instance_id
         )
      THEN
        RAISE EXCEPTION
          'typed clinical task identity cannot move away from its surviving SLA obligation'
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM care_pathway_assert_task_sla_completion_receipt(NEW.tenant_id, NEW.id);
      IF NEW.workflow_sla_instance_id IS NOT NULL THEN
        -- A successor's lineage fields are part of every predecessor receipt
        -- on the same clock. Revalidate the whole obligation, not only NEW,
        -- so mutating a successor cannot orphan a previously valid ancestor.
        PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
          FROM tasks AS task
         WHERE task.tenant_id = NEW.tenant_id
           AND task.workflow_sla_instance_id = NEW.workflow_sla_instance_id;
        PERFORM care_pathway_assert_human_sla_task_obligation(
          NEW.tenant_id,
          NEW.workflow_sla_instance_id
        );
      END IF;
      IF TG_OP = 'UPDATE'
         AND OLD.workflow_sla_instance_id IS NOT NULL
         AND (
           OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
           OR OLD.workflow_sla_instance_id
                IS DISTINCT FROM NEW.workflow_sla_instance_id
         )
      THEN
        PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
          FROM tasks AS task
         WHERE task.tenant_id = OLD.tenant_id
           AND task.workflow_sla_instance_id = OLD.workflow_sla_instance_id;
        PERFORM care_pathway_assert_human_sla_task_obligation(
          OLD.tenant_id,
          OLD.workflow_sla_instance_id
        );
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'workflow_sla_instances' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
        FROM tasks AS task
       WHERE task.tenant_id = NEW.tenant_id
         AND task.workflow_sla_instance_id = NEW.id;
      PERFORM care_pathway_assert_human_sla_task_obligation(NEW.tenant_id, NEW.id);
    ELSE
      PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
        FROM tasks AS task
       WHERE task.tenant_id = OLD.tenant_id
         AND task.workflow_sla_instance_id = OLD.id;
      PERFORM care_pathway_assert_human_sla_task_obligation(OLD.tenant_id, OLD.id);
      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id THEN
        PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
          FROM tasks AS task
         WHERE task.tenant_id = NEW.tenant_id
           AND task.workflow_sla_instance_id = NEW.id;
        PERFORM care_pathway_assert_human_sla_task_obligation(NEW.tenant_id, NEW.id);
      END IF;
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM tasks AS task
       WHERE task.tenant_id = OLD.tenant_id
         AND task.metadata->>'task_materialized_by' =
               'migration_580_rolling_compat'
         AND task.metadata->'initial_evidence'->>'kind' =
               'mortuary_unclaimed_receive'
         AND task.metadata->'initial_evidence'->>'resource_type' =
               'body_custody_event'
         AND task.metadata->'initial_evidence'->>'resource_id' = OLD.id::text
    ) THEN
      RAISE EXCEPTION
        'mortuary compatibility task cannot outlive its unclaimed-receive evidence'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = OLD.tenant_id
       AND task.sla_completion_semantics = 'domain_evidence'
       AND sla.metadata->'completion_evidence'->>'kind' = 'mortuary_body_release'
       AND sla.metadata->'completion_evidence'->>'resource_type' =
             'body_custody_event'
       AND sla.metadata->'completion_evidence'->>'resource_id' = OLD.id::text;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_tasks_sla_completion_receipt
  AFTER INSERT OR UPDATE OR DELETE ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_task_sla_completion_receipt_constraint();

CREATE CONSTRAINT TRIGGER trg_workflow_sla_completion_receipt
  AFTER INSERT OR UPDATE ON workflow_sla_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_task_sla_completion_receipt_constraint();

CREATE CONSTRAINT TRIGGER trg_body_custody_completion_receipt
  AFTER DELETE ON body_custody_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_task_sla_completion_receipt_constraint();

-- Receipt actors and break-glass grants are durable authorization evidence.
-- Revalidate their dependants at commit so deleting or moving a referenced
-- identity cannot leave a task whose clock-stopping receipt merely looks valid.
CREATE OR REPLACE FUNCTION care_pathway_receipt_dependency_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
      FROM tasks AS task
      JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = task.tenant_id
       AND sla.id = task.workflow_sla_instance_id
     WHERE task.tenant_id = OLD.tenant_id
       AND task.sla_completion_semantics = 'acknowledgement'
       AND (
         LOWER(task.metadata->>'acknowledged_by') = LOWER(OLD.uid::text)
         OR LOWER(sla.metadata->>'completed_by') = LOWER(OLD.uid::text)
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(sla.metadata->'reopen_history') = 'array'
                   THEN sla.metadata->'reopen_history'
                 ELSE '[]'::jsonb
               END
             ) AS history(receipt)
            WHERE LOWER(history.receipt->>'prior_completed_by') =
                    LOWER(OLD.uid::text)
         )
       );
  ELSE
    PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
      FROM tasks AS task
     WHERE task.tenant_id = OLD.tenant_id
       AND task.sla_completion_semantics = 'acknowledgement'
       AND task.metadata->>'acknowledge_override_source' =
             'patient_access_break_glass'
       AND task.metadata->>'acknowledge_override_id' = OLD.id::text;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_users_clinical_receipt_dependency_delete
  AFTER DELETE ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_receipt_dependency_constraint();

CREATE CONSTRAINT TRIGGER trg_users_clinical_receipt_dependency_identity
  AFTER UPDATE OF tenant_id, uid ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_receipt_dependency_constraint();

CREATE CONSTRAINT TRIGGER trg_break_glass_clinical_receipt_dependency_delete
  AFTER DELETE ON patient_access_break_glass
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_receipt_dependency_constraint();

CREATE CONSTRAINT TRIGGER trg_break_glass_clinical_receipt_dependency_identity
  AFTER UPDATE OF tenant_id, id, patient_uid, actor_uid, reason
  ON patient_access_break_glass
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_receipt_dependency_constraint();

DO $$
BEGIN
  PERFORM care_pathway_assert_task_sla_completion_receipt(task.tenant_id, task.id)
    FROM tasks AS task
   WHERE task.workflow_sla_instance_id IS NOT NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- Approved governed runs require exactly one companion at transaction commit.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION care_pathway_assert_run_companion(target_run_id INTEGER)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  companion_count INTEGER;
BEGIN
  IF target_run_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM workflow_runs AS run
      JOIN care_pathway_definition_governance AS governance
        ON governance.tenant_id = run.tenant_id
       AND governance.workflow_definition_id = run.workflow_definition_id
     WHERE run.id = target_run_id
       AND governance.governance_status = 'approved'
  ) THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::integer
    INTO companion_count
    FROM care_pathway_instances
   WHERE workflow_run_id = target_run_id;

  IF companion_count <> 1 THEN
    RAISE EXCEPTION
      'approved pathway workflow run % requires exactly one companion (found %)',
      target_run_id, companion_count;
  END IF;
END;
$$;

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
       AND (TG_OP = 'DELETE'
            OR OLD.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id)
    THEN
      PERFORM care_pathway_assert_run_companion(OLD.workflow_run_id);
    END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM care_pathway_assert_run_companion(run.id)
        FROM workflow_runs AS run
       WHERE run.tenant_id = NEW.tenant_id
         AND run.workflow_definition_id = NEW.workflow_definition_id;
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
       WHERE run.tenant_id = OLD.tenant_id
         AND run.workflow_definition_id = OLD.workflow_definition_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_workflow_runs_pathway_companion
  AFTER INSERT OR UPDATE OR DELETE ON workflow_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_run_companion_constraint();

CREATE CONSTRAINT TRIGGER trg_care_pathway_instances_run_companion
  AFTER INSERT OR UPDATE OR DELETE ON care_pathway_instances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_run_companion_constraint();

CREATE CONSTRAINT TRIGGER trg_care_pathway_governance_run_companion
  AFTER INSERT OR UPDATE OR DELETE ON care_pathway_definition_governance
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION care_pathway_run_companion_constraint();

-- ---------------------------------------------------------------------------
-- Pattern-A tenant isolation on every new table.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  table_name TEXT;
  tables TEXT[] := ARRAY[
    'care_pathway_instances',
    'care_pathway_transition_events',
    'care_handoff_instances',
    'care_pathway_definition_governance'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
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
$$;

COMMIT;
