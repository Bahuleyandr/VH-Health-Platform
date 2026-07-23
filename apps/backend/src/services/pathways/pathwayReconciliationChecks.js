import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../../config/pathwayProjectorConfig.js';
import {
  releaseDelayHours,
  releaseVisibilitySql,
} from '../portal/portalAccessService.js';
import { CARE_PATHWAY_KEYS } from './pathwayMode.js';

function result(code, count) {
  const findingCount = Number(count || 0);
  if (!Number.isSafeInteger(findingCount) || findingCount < 0) {
    throw new TypeError(`Pathway reconciliation check ${code} returned an invalid count`);
  }
  return Object.freeze({ code, finding_count: findingCount });
}

async function count(tx, sql, ...params) {
  const rows = await tx.$queryRawUnsafe(sql, ...params);
  return Number(rows[0]?.finding_count || 0);
}

async function runtimePins({ tx, tenantId, pathwayKey }) {
  return result('RUNTIME_PIN_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM care_pathway_instances AS pathway
       LEFT JOIN workflow_runs AS run
         ON run.tenant_id = pathway.tenant_id
        AND run.id = pathway.workflow_run_id
       LEFT JOIN workflow_definitions AS definition
         ON definition.tenant_id = pathway.tenant_id
        AND definition.id = pathway.workflow_definition_id
       LEFT JOIN care_pathway_definition_governance AS governance
         ON governance.tenant_id = pathway.tenant_id
        AND governance.id = pathway.definition_governance_id
      WHERE pathway.tenant_id = $1::uuid
        AND pathway.pathway_key = $2::text
        AND (
          run.id IS NULL
          OR definition.id IS NULL
          OR governance.id IS NULL
          OR run.workflow_definition_id IS DISTINCT FROM pathway.workflow_definition_id
          OR run.pathway_governance_id IS DISTINCT FROM pathway.definition_governance_id
          OR run.pathway_definition_checksum IS DISTINCT FROM pathway.definition_checksum
          OR definition.version IS DISTINCT FROM pathway.pathway_version
          OR governance.workflow_definition_id IS DISTINCT FROM pathway.workflow_definition_id
          OR governance.definition_checksum IS DISTINCT FROM pathway.definition_checksum
          OR (
            SELECT COUNT(*)
              FROM care_pathway_transition_events AS creation
             WHERE creation.tenant_id = pathway.tenant_id
               AND creation.pathway_instance_id = pathway.id
               AND creation.workflow_run_id = pathway.workflow_run_id
               AND creation.sequence_number = 1
               AND creation.transition_key = 'pathway_instance_created'
               AND creation.canonical_timeline_event_id IS NOT NULL
               AND creation.canonical_audit_event_id IS NOT NULL
               AND creation.metadata #>> '{pathway_runtime,definition_checksum}' = pathway.definition_checksum
               AND creation.event_payload ->> 'workflow_definition_id' = pathway.workflow_definition_id::text
               AND LOWER(creation.event_payload ->> 'governance_id') = LOWER(pathway.definition_governance_id::text)
               AND creation.event_payload ->> 'definition_checksum' = pathway.definition_checksum
          ) <> 1
        )`,
    tenantId,
    pathwayKey,
  ));
}

async function transitionSequence({ tx, tenantId, pathwayKey }) {
  return result('TRANSITION_SEQUENCE_DRIFT', await count(
    tx,
    `WITH sequenced AS (
       SELECT event.pathway_instance_id,
              event.sequence_number,
              LAG(event.sequence_number) OVER (
                PARTITION BY event.pathway_instance_id
                ORDER BY event.sequence_number, event.id
              ) AS previous_sequence
         FROM care_pathway_transition_events AS event
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = event.tenant_id
          AND pathway.id = event.pathway_instance_id
        WHERE event.tenant_id = $1::uuid
          AND pathway.pathway_key = $2::text
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM sequenced
      WHERE (previous_sequence IS NULL AND sequence_number <> 1)
         OR (previous_sequence IS NOT NULL AND sequence_number <> previous_sequence + 1)`,
    tenantId,
    pathwayKey,
  ));
}

async function runtimeState({ tx, tenantId, pathwayKey }) {
  return result('RUNTIME_STATE_DRIFT', await count(
    tx,
    `WITH runtime AS (
       SELECT pathway.id,
              pathway.clinical_status,
              pathway.closed_at,
              run.status AS run_status,
              run.current_step_key,
              COUNT(step.id) AS step_count,
              COUNT(step.id) FILTER (
                WHERE step.status IN ('in_progress', 'blocked')
              ) AS active_step_count,
              COUNT(step.id) FILTER (
                WHERE step.status = 'failed'
              ) AS failed_step_count,
              COUNT(step.id) FILTER (
                WHERE step.status NOT IN ('pending')
              ) AS non_pending_step_count,
              COUNT(step.id) FILTER (
                WHERE step.status NOT IN ('completed', 'skipped')
              ) AS non_terminal_step_count,
              MAX(step.status) FILTER (
                WHERE step.step_key = run.current_step_key
              ) AS current_step_status
         FROM care_pathway_instances AS pathway
         JOIN workflow_runs AS run
           ON run.tenant_id = pathway.tenant_id
          AND run.id = pathway.workflow_run_id
         LEFT JOIN workflow_steps AS step
           ON step.tenant_id = run.tenant_id
          AND step.workflow_run_id = run.id
        WHERE pathway.tenant_id = $1::uuid
          AND pathway.pathway_key = $2::text
        GROUP BY pathway.id, pathway.clinical_status, pathway.closed_at,
                 run.status, run.current_step_key
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM runtime
      WHERE CASE
        WHEN run_status = 'started' THEN
          current_step_key IS NOT NULL
          OR active_step_count <> 0
          OR clinical_status <> 'planned'
          OR non_pending_step_count <> 0
        WHEN run_status IN ('running', 'blocked') THEN
          current_step_key IS NULL
          OR active_step_count <> 1
          OR current_step_status IS DISTINCT FROM
             CASE WHEN run_status = 'blocked' THEN 'blocked' ELSE 'in_progress' END
          OR clinical_status NOT IN ('active', 'on_hold')
        WHEN run_status = 'completed' THEN
          current_step_key IS NOT NULL
          OR active_step_count <> 0
          OR clinical_status <> 'completed'
          OR closed_at IS NULL
          OR non_terminal_step_count <> 0
        WHEN run_status IN ('cancelled', 'failed') THEN
          current_step_key IS NOT NULL
          OR active_step_count <> 0
          OR clinical_status IS DISTINCT FROM
             CASE WHEN run_status = 'cancelled' THEN 'cancelled' ELSE 'entered_in_error' END
          OR closed_at IS NULL
          OR (run_status = 'failed' AND failed_step_count = 0)
        ELSE TRUE
      END`,
    tenantId,
    pathwayKey,
  ));
}

async function activeEpisodeUniqueness({ tx, tenantId, pathwayKey }) {
  return result('DUPLICATE_ACTIVE_EPISODE', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM (
         SELECT source_episode_type, source_episode_id
           FROM care_pathway_instances
          WHERE tenant_id = $1::uuid
            AND pathway_key = $2::text
            AND clinical_status IN ('planned', 'active', 'on_hold')
          GROUP BY source_episode_type, source_episode_id
         HAVING COUNT(*) > 1
       ) AS duplicate_episode`,
    tenantId,
    pathwayKey,
  ));
}

async function ownerParity({ tx, tenantId, pathwayKey }) {
  return result('HUMAN_OWNER_PARITY_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM tasks AS task
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = task.tenant_id
        AND pathway.workflow_run_id = task.workflow_run_id
       LEFT JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE task.tenant_id = $1::uuid
        AND pathway.pathway_key = $2::text
        AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
        AND (
          (pathway.owning_clinician_uid IS NOT NULL AND (
             task.assigned_to_uid IS DISTINCT FROM pathway.owning_clinician_uid
             OR task.assigned_to_role IS NOT NULL
             OR NOT care_pathway_named_clinician_is_viable(
                      task.tenant_id,
                      pathway.owning_clinician_uid
                    )
          ))
          OR
          (pathway.owning_clinician_uid IS NULL AND (
             task.assigned_to_uid IS NOT NULL
             OR UPPER(BTRIM(task.assigned_to_role)) IS DISTINCT FROM
                UPPER(BTRIM(pathway.accountable_role))
          ))
          OR
          (sla.id IS NOT NULL
           AND sla.completed_at IS NULL
           AND sla.status IN ('active', 'breached', 'escalated')
           AND NOT care_pathway_task_sla_owner_agrees(
                     task.assigned_to_uid,
                     task.assigned_to_role,
                     sla.assigned_user_uid,
                     sla.assigned_role_codes,
                     sla.rule_code
                   ))
        )`,
    tenantId,
    pathwayKey,
  ));
}

async function linkageIntegrity({ tx, tenantId, pathwayKey }) {
  return result('WORK_LINKAGE_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM tasks AS task
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = task.tenant_id
        AND pathway.workflow_run_id = task.workflow_run_id
       LEFT JOIN workflow_steps AS step
         ON step.tenant_id = task.tenant_id
        AND step.id = task.workflow_step_id
        AND step.workflow_run_id = task.workflow_run_id
       LEFT JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE task.tenant_id = $1::uuid
        AND pathway.pathway_key = $2::text
        AND (
          (task.workflow_step_id IS NOT NULL AND step.id IS NULL)
          OR
          (task.sla_completion_semantics IN ('acknowledgement', 'domain_evidence')
           AND sla.id IS NULL)
          OR
          (task.sla_completion_semantics = 'none'
           AND task.workflow_sla_instance_id IS NOT NULL)
        )`,
    tenantId,
    pathwayKey,
  ));
}

async function handoffCompletion({ tx, tenantId, pathwayKey }) {
  return result('ACCEPTED_HANDOFF_EVIDENCE_MISSING', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM care_handoff_instances AS handoff
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = handoff.tenant_id
        AND pathway.id = handoff.sending_pathway_instance_id
       LEFT JOIN tasks AS task
         ON task.tenant_id = handoff.tenant_id
        AND task.id = handoff.task_id
      WHERE handoff.tenant_id = $1::uuid
        AND pathway.pathway_key = $2::text
        AND handoff.handoff_type = 'covering_clinician_reassignment'
        AND handoff.status = 'accepted'
        AND (
          task.id IS NULL
          OR task.status <> 'completed'
          OR NOT EXISTS (
            SELECT 1
              FROM care_pathway_transition_events AS event
             WHERE event.tenant_id = handoff.tenant_id
               AND event.pathway_instance_id = handoff.sending_pathway_instance_id
               AND event.transition_key = 'pathway_owner_transfer_accepted'
               AND event.source_resource_type = 'care_handoff_instance'
               AND event.source_resource_id = handoff.id::text
          )
        )`,
    tenantId,
    pathwayKey,
  ));
}

async function projectorCoverage({ tx, tenantId, capturedAt }) {
  return result('PROJECTOR_GENERATION_DEBT', await count(
    tx,
    `SELECT (
       CASE WHEN offsets.consumer_key IS NULL THEN 1 ELSE 0 END
       + CASE WHEN offsets.backfill_completed_at IS NULL THEN 1 ELSE 0 END
       + CASE WHEN offsets.intake_retired_at IS NOT NULL THEN 1 ELSE 0 END
       + COALESCE(inbox.debt_count, 0)
       + COALESCE(missing.debt_count, 0)
     )::integer AS finding_count
       FROM (SELECT $1::text AS consumer_key, $2::integer AS generation) AS expected
       LEFT JOIN event_consumer_offsets AS offsets
         ON offsets.consumer_key = expected.consumer_key
        AND offsets.generation = expected.generation
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS debt_count
           FROM pathway_projector_inbox
          WHERE tenant_id = $3::uuid
            AND consumer_key = expected.consumer_key
            AND generation = expected.generation
            AND (
              status = 'dead'
              OR (status = 'pending' AND lease_expires_at < $4::timestamptz)
            )
       ) AS inbox ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS debt_count
           FROM event_outbox AS event
          WHERE event.tenant_id = $3::uuid
            AND offsets.consumer_key IS NOT NULL
            AND (
              event.id <= offsets.backfill_cursor_event_id
              OR event.id > offsets.historical_cutoff_event_id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM pathway_projector_inbox AS candidate
               WHERE candidate.tenant_id = event.tenant_id
                 AND candidate.consumer_key = expected.consumer_key
                 AND candidate.generation = expected.generation
                 AND candidate.event_id = event.id
            )
       ) AS missing ON TRUE`,
    PATHWAY_PROJECTOR_CONSUMER_KEY,
    PATHWAY_PROJECTOR_GENERATION,
    tenantId,
    capturedAt,
  ));
}

async function deliveryDebt({ tx, tenantId }) {
  return result('DELIVERY_DEAD_LETTER_DEBT', await count(
    tx,
    `SELECT (
       (SELECT COUNT(*) FROM event_outbox
         WHERE tenant_id = $1::uuid AND status = 'failed')
       +
       (SELECT COUNT(*) FROM notification_outbox
         WHERE tenant_id = $1::uuid AND status = 'FAILED')
       +
       (SELECT COUNT(*) FROM webhook_deliveries
         WHERE tenant_id = $1::uuid AND status = 'dead')
     )::integer AS finding_count`,
    tenantId,
  ));
}

async function diagnosticGenerationEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.DIAGNOSTICS) {
    return result('DIAGNOSTIC_GENERATION_EVIDENCE_DRIFT', 0);
  }
  return result('DIAGNOSTIC_GENERATION_EVIDENCE_DRIFT', await count(
    tx,
    `WITH item_rollup AS (
       SELECT item.tenant_id, item.generation_id,
              COUNT(*)::integer AS item_count,
              encode(
                digest(
                  string_agg(item.item_snapshot_sha256::text, ':' ORDER BY item.source_ordinal, item.id),
                  'sha256'
                ),
                'hex'
              ) AS snapshot_sha256,
              COUNT(*) FILTER (
                WHERE item.source_table = 'lab_results' AND lab.id IS NULL
              )::integer AS missing_lab_rows,
               COUNT(*) FILTER (
                 WHERE item.source_table = 'investigations' AND shared.id IS NULL
               )::integer AS missing_investigation_rows,
               COUNT(*) FILTER (
                 WHERE item.source_table = 'radiology_orders' AND radiology_order.id IS NULL
               )::integer AS missing_radiology_order_rows,
               COUNT(*) FILTER (
                 WHERE item.source_table = 'radiology_report_addenda' AND radiology_addendum.id IS NULL
               )::integer AS missing_radiology_addendum_rows,
               COUNT(*) FILTER (
                 WHERE item.source_table = 'ap_reports' AND ap_report.id IS NULL
               )::integer AS missing_ap_report_rows,
               COUNT(*) FILTER (
                 WHERE item.source_table = 'ap_report_addenda' AND ap_addendum.id IS NULL
               )::integer AS missing_ap_addendum_rows
         FROM diagnostic_result_generation_items AS item
         LEFT JOIN lab_results AS lab
           ON lab.tenant_id = item.tenant_id
          AND item.source_table = 'lab_results'
          AND lab.id::text = item.source_row_id
          LEFT JOIN investigations AS shared
           ON shared.tenant_id = item.tenant_id
          AND item.source_table = 'investigations'
           AND shared.id::text = item.source_row_id
          LEFT JOIN radiology_orders AS radiology_order
            ON radiology_order.tenant_id = item.tenant_id
           AND item.source_table = 'radiology_orders'
           AND radiology_order.id::text = item.source_row_id
          LEFT JOIN radiology_report_addenda AS radiology_addendum
            ON radiology_addendum.tenant_id = item.tenant_id
           AND item.source_table = 'radiology_report_addenda'
           AND radiology_addendum.id::text = item.source_row_id
          LEFT JOIN ap_reports AS ap_report
            ON ap_report.tenant_id = item.tenant_id
           AND item.source_table = 'ap_reports'
           AND ap_report.id::text = item.source_row_id
          LEFT JOIN ap_report_addenda AS ap_addendum
            ON ap_addendum.tenant_id = item.tenant_id
           AND item.source_table = 'ap_report_addenda'
           AND ap_addendum.id::text = item.source_row_id
        WHERE item.tenant_id = $1::uuid
        GROUP BY item.tenant_id, item.generation_id
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM diagnostic_result_generations AS generation
       LEFT JOIN item_rollup AS items
         ON items.tenant_id = generation.tenant_id
        AND items.generation_id = generation.id
       LEFT JOIN lab_pathologist_signoffs AS signoff
         ON signoff.tenant_id = generation.tenant_id
        AND signoff.id = generation.lab_signoff_id
       LEFT JOIN investigations AS investigation
         ON investigation.tenant_id = generation.tenant_id
         AND investigation.id = generation.investigation_id
       LEFT JOIN radiology_orders AS radiology_order
         ON radiology_order.tenant_id = generation.tenant_id
        AND radiology_order.id = generation.radiology_order_id
       LEFT JOIN radiology_report_addenda AS radiology_addendum
         ON radiology_addendum.tenant_id = generation.tenant_id
        AND radiology_addendum.id = generation.radiology_addendum_id
       LEFT JOIN ap_reports AS ap_report
         ON ap_report.tenant_id = generation.tenant_id
        AND ap_report.id = generation.ap_report_id
       LEFT JOIN ap_report_addenda AS ap_addendum
         ON ap_addendum.tenant_id = generation.tenant_id
        AND ap_addendum.id = generation.ap_addendum_id
      WHERE generation.tenant_id = $1::uuid
        AND (
          items.generation_id IS NULL
          OR items.item_count <> generation.item_count
          OR items.snapshot_sha256 IS DISTINCT FROM generation.snapshot_sha256::text
          OR items.missing_lab_rows > 0
          OR items.missing_investigation_rows > 0
          OR items.missing_radiology_order_rows > 0
          OR items.missing_radiology_addendum_rows > 0
          OR items.missing_ap_report_rows > 0
          OR items.missing_ap_addendum_rows > 0
          OR (generation.source_kind = 'lab_panel' AND signoff.id IS NULL)
          OR (generation.source_kind = 'shared_investigation' AND investigation.id IS NULL)
          OR (generation.source_kind = 'radiology_report' AND radiology_order.id IS NULL)
          OR (generation.source_kind = 'radiology_report'
              AND generation.source_version > 1
              AND radiology_addendum.id IS NULL)
          OR (generation.source_kind = 'anatomical_pathology_report' AND ap_report.id IS NULL)
          OR (generation.source_kind = 'anatomical_pathology_report'
              AND generation.source_version > 1
              AND ap_addendum.id IS NULL)
          OR (generation.source_kind = 'shared_investigation'
              AND generation.ordering_owner_uid IS NULL)
          OR (generation.source_kind IN ('radiology_report', 'anatomical_pathology_report')
              AND generation.ordering_owner_uid IS NULL)
          OR (generation.ordering_owner_uid IS NOT NULL
              AND NOT care_pathway_named_clinician_is_viable(
                        generation.tenant_id,
                        generation.ordering_owner_uid
                      ))
        )`,
    tenantId,
  ));
}

async function diagnosticProjectionEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.DIAGNOSTICS) {
    return result('DIAGNOSTIC_PROJECTION_EVIDENCE_DRIFT', 0);
  }
  return result('DIAGNOSTIC_PROJECTION_EVIDENCE_DRIFT', await count(
    tx,
    `WITH tenant_mode AS (
       SELECT LOWER(COALESCE(
                settings #>> '{care_pathways,diagnostics_order_to_action}',
                'off'
              )) AS mode
         FROM tenants
        WHERE id = $1::uuid
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM diagnostic_result_generations AS generation
       CROSS JOIN tenant_mode
      WHERE generation.tenant_id = $1::uuid
        AND (
          NOT EXISTS (
            SELECT 1
              FROM event_outbox AS event
             WHERE event.tenant_id = generation.tenant_id
               AND event.aggregate_type = 'diagnostic_result_generation'
               AND event.aggregate_id = generation.id::text
               AND event.event_type IN (
                 'diagnostic.result.generation_signed',
                 'diagnostic.result.generation_corrected'
               )
          )
          OR (
            EXISTS (
              SELECT 1
                FROM diagnostic_result_generations AS successor
               WHERE successor.tenant_id = generation.tenant_id
                 AND successor.predecessor_generation_id = generation.id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM diagnostic_result_actions AS supersession
               WHERE supersession.tenant_id = generation.tenant_id
                 AND supersession.generation_id = generation.id
                 AND supersession.action_kind = 'generation_superseded'
            )
          )
          OR (
            tenant_mode.mode = 'active'
            AND NOT EXISTS (
              SELECT 1
                FROM diagnostic_result_generations AS successor
               WHERE successor.tenant_id = generation.tenant_id
                 AND successor.predecessor_generation_id = generation.id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM care_pathway_instances AS pathway
               WHERE pathway.tenant_id = generation.tenant_id
                 AND pathway.pathway_key = 'diagnostics_order_to_action'
                 AND pathway.source_episode_type = 'diagnostic_result_generation'
                 AND pathway.source_episode_id = generation.id::text
            )
          )
        )`,
    tenantId,
  ));
}

async function diagnosticActionEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.DIAGNOSTICS) {
    return result('DIAGNOSTIC_ACTION_EVIDENCE_DRIFT', 0);
  }
  return result('DIAGNOSTIC_ACTION_EVIDENCE_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM diagnostic_result_actions AS action
       JOIN diagnostic_result_generations AS generation
         ON generation.tenant_id = action.tenant_id
        AND generation.id = action.generation_id
       LEFT JOIN clinical_document_signatures AS signature
         ON signature.tenant_id = action.tenant_id
        AND signature.id = action.signature_id
       LEFT JOIN clinical_timeline_events AS timeline
         ON timeline.tenant_id = action.tenant_id
        AND timeline.id = action.canonical_timeline_event_id
       LEFT JOIN clinical_audit_events AS audit
         ON audit.tenant_id = action.tenant_id
        AND audit.id = action.canonical_audit_event_id
      WHERE action.tenant_id = $1::uuid
        AND (
          timeline.id IS NULL
          OR timeline.resource_type <> 'diagnostic_result_action'
          OR timeline.resource_id <> action.id::text
          OR audit.id IS NULL
          OR audit.resource_table <> 'diagnostic_result_actions'
          OR audit.resource_id <> action.id::text
          OR (
            action.action_kind = 'doctor_disposition'
            AND (
              signature.id IS NULL
              OR signature.document_type <> 'diagnostic_result_action'
              OR signature.document_table <> 'diagnostic_result_actions'
              OR signature.document_id <> action.id::text
              OR signature.signer_uid IS DISTINCT FROM action.actor_uid
              OR signature.audit_event_id IS DISTINCT FROM action.canonical_audit_event_id
            )
          )
          OR (
            action.action_kind = 'normal_auto_closed'
            AND EXISTS (
              SELECT 1
                FROM diagnostic_result_generation_items AS item
                JOIN lab_results AS result
                  ON result.tenant_id = item.tenant_id
                 AND result.id::text = item.source_row_id
               WHERE item.tenant_id = action.tenant_id
                 AND item.generation_id = action.generation_id
                 AND NOT (${releaseVisibilitySql('$2')})
            )
          )
          OR (
            EXISTS (
              SELECT 1
                FROM diagnostic_result_generations AS successor
               WHERE successor.tenant_id = generation.tenant_id
                 AND successor.predecessor_generation_id = generation.id
            )
            AND action.action_kind <> 'generation_superseded'
            AND NOT EXISTS (
              SELECT 1
                FROM diagnostic_result_actions AS supersession
               WHERE supersession.tenant_id = generation.tenant_id
                 AND supersession.generation_id = generation.id
                 AND supersession.action_kind = 'generation_superseded'
            )
          )
        )`,
    tenantId,
    releaseDelayHours(),
  ));
}

async function diagnosticObligationEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.DIAGNOSTICS) {
    return result('DIAGNOSTIC_OBLIGATION_EVIDENCE_DRIFT', 0);
  }
  return result('DIAGNOSTIC_OBLIGATION_EVIDENCE_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM care_pathway_instances AS pathway
       JOIN diagnostic_result_generations AS generation
         ON generation.tenant_id = pathway.tenant_id
        AND pathway.source_episode_type = 'diagnostic_result_generation'
        AND pathway.source_episode_id = generation.id::text
       LEFT JOIN workflow_runs AS run
         ON run.tenant_id = pathway.tenant_id
        AND run.id = pathway.workflow_run_id
       LEFT JOIN workflow_steps AS step
         ON step.tenant_id = run.tenant_id
        AND step.workflow_run_id = run.id
        AND step.step_key = run.current_step_key
       LEFT JOIN tasks AS task
         ON task.tenant_id = step.tenant_id
        AND task.workflow_run_id = step.workflow_run_id
        AND task.workflow_step_id = step.id
        AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
       LEFT JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE pathway.tenant_id = $1::uuid
        AND pathway.pathway_key = 'diagnostics_order_to_action'
        AND (
          (
            run.current_step_key = 'record_doctor_action'
            AND (
              task.id IS NULL
              OR task.sla_completion_semantics <> 'domain_evidence'
              OR sla.id IS NULL
              OR sla.completed_at IS NOT NULL
            )
          )
          OR (
            EXISTS (
              SELECT 1
                FROM diagnostic_result_generations AS successor
               WHERE successor.tenant_id = generation.tenant_id
                 AND successor.predecessor_generation_id = generation.id
            )
            AND task.id IS NOT NULL
          )
        )`,
    tenantId,
  ));
}

async function diagnosticStructuredAcknowledgementEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.DIAGNOSTICS) {
    return result('DIAGNOSTIC_STRUCTURED_ACK_EVIDENCE_DRIFT', 0);
  }
  return result('DIAGNOSTIC_STRUCTURED_ACK_EVIDENCE_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM diagnostic_result_generations AS generation
       JOIN tenants AS tenant
         ON tenant.id = generation.tenant_id
       LEFT JOIN tasks AS task
         ON task.tenant_id = generation.tenant_id
        AND task.id = generation.critical_acknowledgement_task_id
       LEFT JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = generation.tenant_id
        AND sla.id = generation.critical_acknowledgement_sla_id
       LEFT JOIN diagnostic_result_generations AS successor
         ON successor.tenant_id = generation.tenant_id
        AND successor.predecessor_generation_id = generation.id
      WHERE generation.tenant_id = $1::uuid
        AND generation.source_kind IN ('radiology_report', 'anatomical_pathology_report')
        AND (
          (
            generation.classification = 'critical'
            AND LOWER(COALESCE(
                  tenant.settings #>> '{care_pathways,diagnostics_order_to_action}',
                  'off'
                )) = 'active'
            AND successor.id IS NULL
            AND (
              generation.critical_acknowledgement_task_id IS NULL
              OR generation.critical_acknowledgement_sla_id IS NULL
            )
          )
          OR (
            (generation.critical_acknowledgement_task_id IS NULL)
              <> (generation.critical_acknowledgement_sla_id IS NULL)
          )
          OR (
            generation.critical_acknowledgement_task_id IS NOT NULL
            AND (
              task.id IS NULL
              OR sla.id IS NULL
              OR generation.classification <> 'critical'
              OR task.related_resource_type <> 'diagnostic_result_generation'
              OR task.related_resource_id <> generation.id::text
              OR task.workflow_sla_instance_id IS DISTINCT FROM sla.id
              OR task.sla_completion_semantics <> 'acknowledgement'
              OR task.assigned_to_uid IS DISTINCT FROM generation.ordering_owner_uid
              OR task.assigned_to_role IS NOT NULL
              OR sla.rule_code <> 'critical_result_ack'
              OR sla.source_table <> 'diagnostic_result_generation'
              OR sla.source_id <> generation.id::text
              OR task.status NOT IN ('open', 'in_progress', 'blocked', 'overdue', 'completed')
              OR (
                task.status IN ('open', 'blocked', 'overdue')
                AND sla.completed_at IS NOT NULL
              )
              OR (
                task.status IN ('in_progress', 'completed')
                AND task.metadata->>'supersession_reason' IS NULL
                AND (
                  jsonb_typeof(COALESCE(task.metadata, '{}'::jsonb)) <> 'object'
                  OR NOT COALESCE(
                    task.metadata->>'acknowledged_at'
                      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$',
                    FALSE
                  )
                  OR NOT COALESCE(
                    pg_input_is_valid(
                      task.metadata->>'acknowledged_at',
                      'timestamp with time zone'
                    ),
                    FALSE
                  )
                  OR NOT COALESCE(
                    task.metadata->>'acknowledged_by'
                      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                    FALSE
                  )
                  OR COALESCE(task.metadata->>'acknowledged_via', '')
                       NOT IN ('assignee', 'role', 'admin', 'override')
                  OR (
                    task.metadata->>'acknowledged_via' = 'assignee'
                    AND task.metadata->>'acknowledged_by' IS DISTINCT FROM task.assigned_to_uid::text
                  )
                  OR (
                    task.metadata->>'acknowledged_via' = 'role'
                    AND task.assigned_to_role IS NULL
                  )
                  OR (
                    task.metadata->>'acknowledged_via' = 'override'
                    AND (
                      NULLIF(BTRIM(task.metadata->>'acknowledge_override_source'), '') IS NULL
                      OR NULLIF(BTRIM(task.metadata->>'acknowledge_override_id'), '') IS NULL
                      OR NULLIF(BTRIM(task.metadata->>'acknowledge_override_reason'), '') IS NULL
                    )
                  )
                  OR sla.completed_at IS NULL
                )
              )
              OR (
                task.metadata->>'supersession_reason' IS NOT NULL
                AND (
                  task.status <> 'completed'
                  OR sla.completed_at IS NULL
                  OR successor.id IS NULL
                  OR task.metadata->>'supersession_reason'
                       IS DISTINCT FROM 'diagnostic_generation_superseded'
                  OR task.metadata->>'superseded_by_diagnostic_generation_id'
                       IS DISTINCT FROM successor.id::text
                  OR sla.metadata->>'supersession_reason'
                       IS DISTINCT FROM 'diagnostic_generation_superseded'
                  OR sla.metadata->>'superseded_by_diagnostic_generation_id'
                       IS DISTINCT FROM successor.id::text
                )
              )
            )
          )
        )`,
    tenantId,
  ));
}

async function diagnosticSourceProjectionEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.DIAGNOSTICS) {
    return result('DIAGNOSTIC_SOURCE_PROJECTION_DRIFT', 0);
  }
  return result('DIAGNOSTIC_SOURCE_PROJECTION_DRIFT', await count(
    tx,
    `WITH source_rows AS (
       SELECT order_row.tenant_id,
              order_row.patient_uid,
              'radiology_report'::text AS source_kind,
              'radiology_order:' || order_row.id::text AS episode_key,
              1::bigint AS source_version,
              order_row.result_classification AS classification,
              order_row.report_signed_off_by AS signer_uid,
              order_row.report_signed_off_at AS signed_at,
              order_row.id::bigint AS base_id,
              NULL::bigint AS addendum_id
         FROM radiology_orders AS order_row
        WHERE order_row.tenant_id = $1::uuid
          AND order_row.report_signed_off_at IS NOT NULL
       UNION ALL
       SELECT order_row.tenant_id,
              order_row.patient_uid,
              'radiology_report'::text,
              'radiology_order:' || order_row.id::text,
              addendum.generation_version,
              addendum.result_classification,
              addendum.signed_by,
              addendum.signed_at,
              order_row.id::bigint,
              addendum.id
         FROM radiology_report_addenda AS addendum
         JOIN radiology_orders AS order_row
           ON order_row.tenant_id = addendum.tenant_id
          AND order_row.id = addendum.radiology_order_id
        WHERE addendum.tenant_id = $1::uuid
       UNION ALL
       SELECT report.tenant_id,
              ap_case.patient_uid,
              'anatomical_pathology_report'::text,
              'ap_report:' || report.id::text,
              1::bigint,
              report.result_classification,
              report.signed_by,
              report.signed_at,
              report.id,
              NULL::bigint
         FROM ap_reports AS report
         JOIN ap_cases AS ap_case
           ON ap_case.tenant_id = report.tenant_id
          AND ap_case.id = report.ap_case_id
        WHERE report.tenant_id = $1::uuid
          AND report.signed_at IS NOT NULL
       UNION ALL
       SELECT report.tenant_id,
              ap_case.patient_uid,
              'anatomical_pathology_report'::text,
              'ap_report:' || report.id::text,
              addendum.generation_version,
              addendum.result_classification,
              addendum.addendum_by,
              addendum.addendum_at,
              report.id,
              addendum.id
         FROM ap_report_addenda AS addendum
         JOIN ap_reports AS report
           ON report.tenant_id = addendum.tenant_id
          AND report.id = addendum.ap_report_id
         JOIN ap_cases AS ap_case
           ON ap_case.tenant_id = report.tenant_id
          AND ap_case.id = report.ap_case_id
        WHERE addendum.tenant_id = $1::uuid
     ), source_drift AS (
       SELECT source.*
         FROM source_rows AS source
         LEFT JOIN diagnostic_result_generations AS generation
           ON generation.tenant_id = source.tenant_id
          AND generation.source_kind = source.source_kind
          AND generation.source_episode_key = source.episode_key
          AND generation.source_version = source.source_version
          AND generation.patient_uid = source.patient_uid
          AND generation.classification = source.classification
          AND generation.signer_uid = source.signer_uid
          AND generation.signed_at = source.signed_at
          AND (
            (source.source_kind = 'radiology_report'
             AND generation.radiology_order_id = source.base_id
             AND generation.radiology_addendum_id IS NOT DISTINCT FROM source.addendum_id)
            OR
            (source.source_kind = 'anatomical_pathology_report'
             AND generation.ap_report_id = source.base_id
             AND generation.ap_addendum_id IS NOT DISTINCT FROM source.addendum_id)
          )
        WHERE source.classification IS NULL
           OR source.source_version IS NULL
           OR source.signer_uid IS NULL
           OR source.signed_at IS NULL
           OR generation.id IS NULL
     ), chain_drift AS (
       SELECT generation.id
         FROM diagnostic_result_generations AS generation
         LEFT JOIN diagnostic_result_generations AS predecessor
           ON predecessor.tenant_id = generation.tenant_id
          AND predecessor.id = generation.predecessor_generation_id
        WHERE generation.tenant_id = $1::uuid
          AND generation.source_kind IN ('radiology_report', 'anatomical_pathology_report')
          AND (
            (generation.source_version = 1 AND generation.predecessor_generation_id IS NOT NULL)
            OR
            (generation.source_version > 1 AND (
              predecessor.id IS NULL
              OR predecessor.source_kind IS DISTINCT FROM generation.source_kind
              OR predecessor.source_episode_key IS DISTINCT FROM generation.source_episode_key
              OR predecessor.source_version IS DISTINCT FROM generation.source_version - 1
            ))
          )
     )
     SELECT (
       (SELECT COUNT(*) FROM source_drift)
       + (SELECT COUNT(*) FROM chain_drift)
     )::integer AS finding_count`,
    tenantId,
  ));
}

async function diagnosticReleaseEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.DIAGNOSTICS) {
    return result('DIAGNOSTIC_RELEASE_EVIDENCE_DRIFT', 0);
  }
  return result('DIAGNOSTIC_RELEASE_EVIDENCE_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM diagnostic_result_generations AS generation
       LEFT JOIN diagnostic_result_release_states AS release_state
         ON release_state.tenant_id = generation.tenant_id
        AND release_state.generation_id = generation.id
        AND release_state.patient_uid = generation.patient_uid
      WHERE generation.tenant_id = $1::uuid
        AND generation.source_kind IN ('radiology_report', 'anatomical_pathology_report')
        AND release_state.generation_id IS NULL`,
    tenantId,
  ));
}

async function referralTransitionEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.REFERRAL) {
    return result('REFERRAL_TRANSITION_EVIDENCE_DRIFT', 0);
  }
  return result('REFERRAL_TRANSITION_EVIDENCE_DRIFT', await count(
    tx,
    `WITH sequenced AS (
       SELECT event.referral_id,
              event.sequence_number,
              LAG(event.sequence_number) OVER (
                PARTITION BY event.referral_id ORDER BY event.sequence_number
              ) AS prior_sequence
         FROM referral_transition_events AS event
        WHERE event.tenant_id = $1::uuid
     )
     SELECT (
       (SELECT COUNT(*) FROM sequenced
         WHERE (prior_sequence IS NULL AND sequence_number <> 1)
            OR (prior_sequence IS NOT NULL AND sequence_number <> prior_sequence + 1))
       +
       (SELECT COUNT(*)
          FROM referral_transition_events AS event
          LEFT JOIN clinical_timeline_events AS timeline
            ON timeline.id = event.canonical_timeline_event_id
          LEFT JOIN clinical_audit_events AS audit
            ON audit.id = event.canonical_audit_event_id
         WHERE event.tenant_id = $1::uuid
           AND (timeline.id IS NULL OR audit.id IS NULL))
       +
       (SELECT COUNT(*)
          FROM referrals AS referral
         WHERE referral.tenant_id = $1::uuid
           AND referral.request_fingerprint IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM referral_transition_events AS requested
              WHERE requested.tenant_id = referral.tenant_id
                AND requested.referral_id = referral.id
                AND requested.event_type = 'referral.requested'
           ))
     )::integer AS finding_count`,
    tenantId,
  ));
}

async function referralReceiverObligation({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.REFERRAL) {
    return result('REFERRAL_RECEIVER_OBLIGATION_DRIFT', 0);
  }
  return result('REFERRAL_RECEIVER_OBLIGATION_DRIFT', await count(
    tx,
    `WITH tenant_mode AS (
       SELECT LOWER(COALESCE(
                settings #>> '{care_pathways,referral_request_to_closure}',
                'off'
              )) AS mode
         FROM tenants WHERE id = $1::uuid
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM referrals AS referral
       CROSS JOIN tenant_mode
       LEFT JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = referral.tenant_id
        AND sla.rule_code = 'referral_response'
        AND sla.source_table = 'referrals'
        AND sla.source_id = referral.id::text
       LEFT JOIN LATERAL (
         SELECT candidate.*
           FROM tasks AS candidate
          WHERE candidate.tenant_id = referral.tenant_id
            AND candidate.related_resource_type = 'referrals'
            AND candidate.related_resource_id = referral.id::text
            AND candidate.workflow_sla_instance_id = sla.id
          ORDER BY candidate.id DESC LIMIT 1
       ) AS task ON TRUE
      WHERE referral.tenant_id = $1::uuid
        AND tenant_mode.mode = 'active'
        AND referral.request_fingerprint IS NOT NULL
        AND referral.referral_type = 'internal'
        AND (
          referral.referred_to_doctor IS NULL
          OR sla.id IS NULL
          OR task.id IS NULL
          OR task.sla_completion_semantics <> 'acknowledgement'
          OR task.assigned_to_uid IS DISTINCT FROM referral.referred_to_doctor
          OR task.assigned_to_role IS NOT NULL
          OR (
            referral.status = 'pending'
            AND (sla.completed_at IS NOT NULL OR task.status NOT IN ('open', 'overdue', 'blocked'))
          )
          OR (
            referral.status IN ('accepted', 'in_progress', 'completed')
            AND (
              referral.accepted_by IS NULL
              OR referral.ownership_accepted_at IS NULL
              OR sla.completed_at IS NULL
              OR task.status <> 'completed'
            )
          )
        )`,
    tenantId,
  ));
}

async function referralResponseClosureEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.REFERRAL) {
    return result('REFERRAL_RESPONSE_CLOSURE_DRIFT', 0);
  }
  return result('REFERRAL_RESPONSE_CLOSURE_DRIFT', await count(
    tx,
    `WITH tenant_mode AS (
       SELECT LOWER(COALESCE(
                settings #>> '{care_pathways,referral_request_to_closure}',
                'off'
              )) AS mode
         FROM tenants WHERE id = $1::uuid
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM referrals AS referral
       CROSS JOIN tenant_mode
       LEFT JOIN LATERAL (
         SELECT response.*
           FROM referral_responses AS response
          WHERE response.tenant_id = referral.tenant_id
            AND response.referral_id = referral.id
          ORDER BY response.version DESC LIMIT 1
       ) AS response ON TRUE
       LEFT JOIN clinical_document_signatures AS signature
         ON signature.tenant_id = response.tenant_id
        AND signature.document_type = 'referral_response'
        AND signature.document_id = response.id::text
       LEFT JOIN LATERAL (
         SELECT task.*
           FROM tasks AS task
          WHERE task.tenant_id = referral.tenant_id
            AND task.related_resource_type = 'referral_specialist_response'
            AND task.related_resource_id = referral.id::text
          ORDER BY task.id DESC LIMIT 1
       ) AS response_task ON TRUE
       LEFT JOIN LATERAL (
         SELECT task.*
           FROM tasks AS task
          WHERE task.tenant_id = referral.tenant_id
            AND task.related_resource_type = 'referral_originator_closure'
            AND task.related_resource_id = referral.id::text
          ORDER BY task.id DESC LIMIT 1
       ) AS originator_task ON TRUE
      WHERE referral.tenant_id = $1::uuid
        AND referral.request_fingerprint IS NOT NULL
        AND (
          (referral.status = 'completed' AND (response.id IS NULL OR signature.id IS NULL))
          OR
          (referral.closure_status = 'closed' AND (
            response.id IS NULL
            OR signature.id IS NULL
            OR referral.closed_at IS NULL
            OR referral.closed_by IS NULL
            OR referral.closure_reason IS NULL
          ))
          OR
          (response.continuing_ownership = TRUE AND referral.closure_status <> 'closed')
          OR
          (
            tenant_mode.mode = 'active'
            AND referral.referral_type = 'internal'
            AND (
              (
                referral.status IN ('accepted', 'in_progress')
                AND (
                  response_task.id IS NULL
                  OR response_task.status NOT IN ('open', 'in_progress', 'blocked', 'overdue')
                  OR response_task.assigned_to_uid IS DISTINCT FROM referral.accepted_by
                  OR response_task.assigned_to_role IS NOT NULL
                )
              )
              OR
              (
                referral.status = 'completed'
                AND response.id IS NOT NULL
                AND (
                  response_task.id IS NULL
                  OR response_task.status <> 'completed'
                )
              )
              OR
              (
                referral.status = 'completed'
                AND referral.closure_status = 'open'
                AND (
                  originator_task.id IS NULL
                  OR originator_task.status NOT IN ('open', 'in_progress', 'blocked', 'overdue')
                  OR originator_task.assigned_to_uid IS DISTINCT FROM referral.referring_doctor
                  OR originator_task.assigned_to_role IS NOT NULL
                )
              )
              OR
              (
                referral.status = 'declined'
                AND (
                  originator_task.id IS NULL
                  OR originator_task.status NOT IN ('open', 'in_progress', 'blocked', 'overdue')
                  OR originator_task.assigned_to_uid IS DISTINCT FROM referral.referring_doctor
                  OR originator_task.assigned_to_role IS NOT NULL
                )
              )
            )
          )
        )`,
    tenantId,
  ));
}

async function referralRecoveryObligation({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.REFERRAL) {
    return result('REFERRAL_RECOVERY_OBLIGATION_DRIFT', 0);
  }
  return result('REFERRAL_RECOVERY_OBLIGATION_DRIFT', await count(
    tx,
    `WITH tenant_mode AS (
       SELECT LOWER(COALESCE(
                settings #>> '{care_pathways,referral_request_to_closure}',
                'off'
              )) AS mode
         FROM tenants WHERE id = $1::uuid
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM referrals AS referral
       CROSS JOIN tenant_mode
       LEFT JOIN appointments AS appointment
         ON appointment.tenant_id = referral.tenant_id
        AND appointment.id = referral.appointment_id
      WHERE referral.tenant_id = $1::uuid
        AND tenant_mode.mode = 'active'
        AND referral.request_fingerprint IS NOT NULL
        AND referral.closure_status = 'open'
        AND (
          (referral.expires_at IS NOT NULL AND referral.expires_at <= NOW())
          OR UPPER(COALESCE(appointment.status, '')) IN ('MISSED', 'NO_SHOW')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM tasks AS task
           WHERE task.tenant_id = referral.tenant_id
             AND task.related_resource_type = 'referral_recovery'
             AND task.related_resource_id = referral.id::text
             AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
        )`,
    tenantId,
  ));
}

async function referralProjectionEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.REFERRAL) {
    return result('REFERRAL_PROJECTION_EVIDENCE_DRIFT', 0);
  }
  return result('REFERRAL_PROJECTION_EVIDENCE_DRIFT', await count(
    tx,
    `WITH tenant_mode AS (
       SELECT LOWER(COALESCE(
                settings #>> '{care_pathways,referral_request_to_closure}',
                'off'
              )) AS mode
         FROM tenants WHERE id = $1::uuid
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM referrals AS referral
       CROSS JOIN tenant_mode
      WHERE referral.tenant_id = $1::uuid
        AND referral.request_fingerprint IS NOT NULL
        AND (
          NOT EXISTS (
            SELECT 1 FROM event_outbox AS event
             WHERE event.tenant_id = referral.tenant_id
               AND event.aggregate_type = 'referral'
               AND event.aggregate_id = referral.id::text
               AND event.event_type = 'referral.requested'
          )
          OR (
            tenant_mode.mode = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM care_pathway_instances AS pathway
               WHERE pathway.tenant_id = referral.tenant_id
                 AND pathway.pathway_key = 'referral_request_to_closure'
                 AND pathway.source_episode_type = 'referral'
                 AND pathway.source_episode_id = referral.id::text
            )
          )
        )`,
    tenantId,
  ));
}

export const COMMON_PATHWAY_RECONCILIATION_CHECKS = Object.freeze([
  Object.freeze({ id: 'runtime_pins', handlerVersion: 'care_pathway.runtime_pins.v1', run: runtimePins }),
  Object.freeze({ id: 'transition_sequence', handlerVersion: 'care_pathway.transition_sequence.v1', run: transitionSequence }),
  Object.freeze({ id: 'runtime_state', handlerVersion: 'care_pathway.runtime_state.v1', run: runtimeState }),
  Object.freeze({ id: 'active_episode_uniqueness', handlerVersion: 'care_pathway.active_episode_uniqueness.v1', run: activeEpisodeUniqueness }),
  Object.freeze({ id: 'human_owner_parity', handlerVersion: 'care_pathway.human_owner_parity.v1', run: ownerParity }),
  Object.freeze({ id: 'work_linkage', handlerVersion: 'care_pathway.work_linkage.v1', run: linkageIntegrity }),
  Object.freeze({ id: 'handoff_completion', handlerVersion: 'care_pathway.handoff_completion.v1', run: handoffCompletion }),
  Object.freeze({ id: 'projector_generation', handlerVersion: 'care_pathway.projector_generation.v1', run: projectorCoverage }),
  Object.freeze({ id: 'delivery_debt', handlerVersion: 'care_pathway.delivery_debt.v1', run: deliveryDebt }),
]);

export const DIAGNOSTIC_PATHWAY_RECONCILIATION_CHECKS = Object.freeze([
  Object.freeze({ id: 'diagnostic_generation_evidence', handlerVersion: 'care_pathway.diagnostic_generation_evidence.v1', run: diagnosticGenerationEvidence }),
  Object.freeze({ id: 'diagnostic_projection_evidence', handlerVersion: 'care_pathway.diagnostic_projection_evidence.v1', run: diagnosticProjectionEvidence }),
  Object.freeze({ id: 'diagnostic_action_evidence', handlerVersion: 'care_pathway.diagnostic_action_evidence.v1', run: diagnosticActionEvidence }),
  Object.freeze({ id: 'diagnostic_obligation_evidence', handlerVersion: 'care_pathway.diagnostic_obligation_evidence.v1', run: diagnosticObligationEvidence }),
  Object.freeze({ id: 'diagnostic_structured_ack_evidence', handlerVersion: 'care_pathway.diagnostic_structured_ack_evidence.v3', run: diagnosticStructuredAcknowledgementEvidence }),
  Object.freeze({ id: 'diagnostic_source_projection', handlerVersion: 'care_pathway.diagnostic_source_projection.v1', run: diagnosticSourceProjectionEvidence }),
  Object.freeze({ id: 'diagnostic_release_evidence', handlerVersion: 'care_pathway.diagnostic_release_evidence.v1', run: diagnosticReleaseEvidence }),
]);

export const REFERRAL_PATHWAY_RECONCILIATION_CHECKS = Object.freeze([
  Object.freeze({ id: 'referral_transition_evidence', handlerVersion: 'care_pathway.referral_transition_evidence.v1', run: referralTransitionEvidence }),
  Object.freeze({ id: 'referral_receiver_obligation', handlerVersion: 'care_pathway.referral_receiver_obligation.v1', run: referralReceiverObligation }),
  Object.freeze({ id: 'referral_response_closure', handlerVersion: 'care_pathway.referral_response_closure.v1', run: referralResponseClosureEvidence }),
  Object.freeze({ id: 'referral_recovery_obligation', handlerVersion: 'care_pathway.referral_recovery_obligation.v1', run: referralRecoveryObligation }),
  Object.freeze({ id: 'referral_projection_evidence', handlerVersion: 'care_pathway.referral_projection_evidence.v1', run: referralProjectionEvidence }),
]);

export default COMMON_PATHWAY_RECONCILIATION_CHECKS;
