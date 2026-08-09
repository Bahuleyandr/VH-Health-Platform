import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../../config/pathwayProjectorConfig.js';
import {
  releaseDelayHours,
  releaseVisibilitySql,
} from '../portal/portalAccessService.js';
import {
  DEFAULT_APPOINTMENT_REAPER_GRACE_MINUTES,
} from '../appointment/appointmentReaperPolicy.js';
import { mergedPatientUidsSubquery } from '../clinical/mergedPatientReadUnion.js';
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

// event_consumer_offsets is FORCE-RLS (migration 603) and its restrictive
// policy hides pathway_registry rows from every non-owner role, including the
// tenant runtime role this sweep runs under. The SECURITY DEFINER accessor
// pathway_projector_offset_get is the sanctioned read path — a raw join would
// see NULLs and both fabricate registration/backfill debt and mute the
// missing-event lateral below.
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
       LEFT JOIN LATERAL (
         SELECT registered.consumer_key,
                registered.generation,
                registered.backfill_completed_at,
                registered.intake_retired_at,
                registered.backfill_cursor_event_id,
                registered.historical_cutoff_event_id
           FROM public.pathway_projector_offset_get(
             expected.consumer_key,
             expected.generation,
             FALSE
           ) AS registered
       ) AS offsets ON TRUE
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

async function opSourceProjectionEvidence({ tx, tenantId, pathwayKey, capturedAt }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.OP) {
    return result('OP_SOURCE_PROJECTION_DRIFT', 0);
  }
  return result('OP_SOURCE_PROJECTION_DRIFT', await count(
    tx,
    `WITH created_sources AS (
       SELECT DISTINCT event.aggregate_id, event.patient_uid
         FROM event_outbox AS event
        WHERE event.tenant_id = $1::uuid
          AND event.event_type = 'appointment.created'
          AND event.aggregate_type = 'appointment'
          AND event.created_at <= $2::timestamptz
          AND event.aggregate_id ~ '^[1-9][0-9]*$'
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM created_sources AS source
      WHERE NOT EXISTS (
        SELECT 1
          FROM care_pathway_instances AS pathway
         WHERE pathway.tenant_id = $1::uuid
           AND pathway.pathway_key = 'op_contact_to_recovery'
           AND pathway.source_episode_type = 'appointment'
           AND pathway.source_episode_id = source.aggregate_id
           AND pathway.patient_uid = source.patient_uid
           AND EXISTS (
             SELECT 1
               FROM care_pathway_resource_references AS reference
              WHERE reference.tenant_id = pathway.tenant_id
                AND reference.pathway_instance_id = pathway.id
                AND reference.patient_uid = pathway.patient_uid
                AND reference.resource_type = 'appointment'
                AND reference.resource_id = source.aggregate_id
                AND reference.relationship_kind = 'closure_evidence'
                AND reference.evidence_state <> 'superseded'
           )
      )`,
    tenantId,
    capturedAt,
  ));
}

async function opLiveAppointmentSourceCoverage({
  tx,
  tenantId,
  pathwayKey,
  capturedAt,
}) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.OP) {
    return result('OP_LIVE_APPOINTMENT_SOURCE_COVERAGE_DRIFT', 0);
  }
  return result('OP_LIVE_APPOINTMENT_SOURCE_COVERAGE_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM appointments AS appointment
       LEFT JOIN users AS patient
         ON patient.tenant_id = appointment.tenant_id
        AND patient.id = appointment.patient_id
      WHERE appointment.tenant_id = $1::uuid
        AND appointment.created_at <= $2::timestamptz
        AND UPPER(BTRIM(COALESCE(appointment.status, ''))) NOT IN (
          'COMPLETED',
          'CANCELLED',
          'CANCELED',
          'NO_SHOW',
          'MISSED',
          'RESCHEDULED'
        )
        AND (
          patient.uid IS NULL
          OR NOT EXISTS (
            SELECT 1
              FROM event_outbox AS event
             WHERE event.tenant_id = appointment.tenant_id
               AND event.aggregate_type = 'appointment'
               AND event.aggregate_id = appointment.id::text
               AND event.event_type = 'appointment.created'
               AND event.patient_uid = patient.uid
               AND event.payload ->> 'tenant_id' = appointment.tenant_id::text
               AND event.payload ->> 'appointment_id' = appointment.id::text
               AND event.payload ->> 'patient_uid' = patient.uid::text
               AND event.created_at <= $2::timestamptz
          )
        )`,
    tenantId,
    capturedAt,
  ));
}

async function opStaleScheduledReaperDebt({
  tx,
  tenantId,
  pathwayKey,
  capturedAt,
}) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.OP) {
    return result('OP_STALE_SCHEDULED_REAPER_DEBT', 0);
  }
  return result('OP_STALE_SCHEDULED_REAPER_DEBT', await count(
    tx,
    `SELECT COUNT(DISTINCT appointment.id)::integer AS finding_count
       FROM appointments AS appointment
       JOIN users AS patient
         ON patient.tenant_id = appointment.tenant_id
        AND patient.id = appointment.patient_id
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = appointment.tenant_id
        AND pathway.patient_uid = patient.uid
        AND pathway.pathway_key = 'op_contact_to_recovery'
        AND pathway.source_episode_type = 'appointment'
        AND pathway.source_episode_id = appointment.id::text
        AND pathway.clinical_status IN ('planned', 'active', 'on_hold')
      WHERE appointment.tenant_id = $1::uuid
        AND appointment.status = 'SCHEDULED'
        AND appointment.admin_override = false
        AND (
          appointment.appointment_date::timestamp
          + COALESCE(
              NULLIF(appointment.appointment_time, '')::interval,
              INTERVAL '0 minutes'
            )
        ) < (
          $2::timestamptz
          - ($3 || ' minutes')::interval
        )`,
    tenantId,
    capturedAt,
    String(DEFAULT_APPOINTMENT_REAPER_GRACE_MINUTES),
  ));
}

async function opChildReferenceCompleteness({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.OP) {
    return result('OP_CHILD_REFERENCE_DRIFT', 0);
  }
  return result('OP_CHILD_REFERENCE_DRIFT', await count(
    tx,
    `WITH RECURSIVE known_sources AS (
       SELECT prescription.tenant_id,
              prescription.appointment_id,
              prescription.patient_uid,
              'e_prescription'::text AS resource_type,
              prescription.id::text AS resource_id
         FROM e_prescriptions AS prescription
        WHERE prescription.tenant_id = $1::uuid
          AND prescription.appointment_id IS NOT NULL
          AND prescription.patient_uid IS NOT NULL
       UNION ALL
       SELECT clinical_order.tenant_id,
              encounter.appointment_id,
              clinical_order.patient_uid,
              'clinical_order',
              clinical_order.id::text
         FROM clinical_orders AS clinical_order
         JOIN patient_encounters AS encounter
           ON encounter.tenant_id = clinical_order.tenant_id
          AND encounter.id = clinical_order.encounter_id
          AND encounter.patient_uid = clinical_order.patient_uid
        WHERE clinical_order.tenant_id = $1::uuid
          AND encounter.appointment_id IS NOT NULL
       UNION ALL
       SELECT investigation.tenant_id,
              investigation.appointment_id,
              investigation.patient_uid,
              'investigation',
              investigation.id::text
         FROM investigations AS investigation
        WHERE investigation.tenant_id = $1::uuid
          AND investigation.appointment_id IS NOT NULL
          AND investigation.patient_uid IS NOT NULL
       UNION ALL
       SELECT referral.tenant_id,
              referral.appointment_id,
              referral.patient_uid,
              'referral',
              referral.id::text
         FROM referrals AS referral
        WHERE referral.tenant_id = $1::uuid
          AND referral.appointment_id IS NOT NULL
       UNION ALL
       SELECT plan.tenant_id,
              plan.origin_resource_id::integer,
              plan.patient_uid,
              'follow_up_plan',
              plan.id::text
         FROM follow_up_plans AS plan
        WHERE plan.tenant_id = $1::uuid
          AND plan.origin_kind = 'appointment'
          AND plan.origin_resource_type = 'appointment'
          AND plan.origin_resource_id ~ '^[1-9][0-9]*$'
     ),
     current_reference_ancestry AS (
       SELECT reference.tenant_id,
              reference.pathway_instance_id,
              reference.patient_uid,
              reference.resource_type,
              reference.resource_id,
              reference.id AS current_reference_id,
              reference.id AS ancestor_reference_id,
              reference.superseded_reference_id,
              reference.source_outbox_event_id AS ancestor_source_outbox_event_id,
              ARRAY[reference.id]::uuid[] AS visited_reference_ids,
              1::integer AS ancestry_depth
          FROM care_pathway_resource_references AS reference
         WHERE reference.tenant_id = $1::uuid
           AND reference.relationship_kind = 'child_action'
           AND reference.evidence_state <> 'superseded'
           AND NOT EXISTS (
            SELECT 1
              FROM care_pathway_resource_references AS successor
             WHERE successor.tenant_id = reference.tenant_id
               AND successor.superseded_reference_id = reference.id
          )
       UNION ALL
       SELECT ancestry.tenant_id,
              ancestry.pathway_instance_id,
              ancestry.patient_uid,
              ancestry.resource_type,
              ancestry.resource_id,
              ancestry.current_reference_id,
              predecessor.id,
              predecessor.superseded_reference_id,
              predecessor.source_outbox_event_id,
              ancestry.visited_reference_ids || predecessor.id,
              ancestry.ancestry_depth + 1
         FROM current_reference_ancestry AS ancestry
         JOIN care_pathway_resource_references AS predecessor
           ON predecessor.tenant_id = ancestry.tenant_id
          AND predecessor.id = ancestry.superseded_reference_id
          AND predecessor.pathway_instance_id = ancestry.pathway_instance_id
          AND predecessor.patient_uid = ancestry.patient_uid
          AND predecessor.resource_type = ancestry.resource_type
          AND predecessor.resource_id = ancestry.resource_id
          AND predecessor.relationship_kind = 'child_action'
        WHERE ancestry.ancestry_depth < 64
          AND predecessor.id <> ALL(ancestry.visited_reference_ids)
     ),
     source_without_link_event AS (
       SELECT CONCAT(
                'source:',
                source.resource_type,
                ':',
                source.resource_id
              ) AS finding_id
       FROM known_sources AS source
      WHERE NOT EXISTS (
        SELECT 1
          FROM event_outbox AS event
         WHERE event.tenant_id = source.tenant_id
           AND event.event_type = 'appointment.child_resource_linked'
           AND event.aggregate_type = 'appointment'
           AND event.aggregate_id = source.appointment_id::text
           AND event.patient_uid = source.patient_uid
           AND event.payload ->> 'tenant_id' = source.tenant_id::text
           AND event.payload ->> 'appointment_id' = source.appointment_id::text
           AND event.payload ->> 'patient_uid' = source.patient_uid::text
           AND event.payload ->> 'resource_type' = source.resource_type
           AND event.payload ->> 'resource_id' = source.resource_id
      )
     ),
     link_event_without_source_or_reference AS (
       SELECT CONCAT('event:', event.id::text) AS finding_id
         FROM event_outbox AS event
        WHERE event.tenant_id = $1::uuid
          AND event.event_type = 'appointment.child_resource_linked'
          AND (
            event.aggregate_type <> 'appointment'
            OR event.aggregate_id !~ '^[1-9][0-9]*$'
            OR event.payload ->> 'tenant_id' IS DISTINCT FROM event.tenant_id::text
            OR event.payload ->> 'appointment_id' IS DISTINCT FROM event.aggregate_id
            OR event.payload ->> 'patient_uid' IS DISTINCT FROM event.patient_uid::text
            OR NOT EXISTS (
              SELECT 1
                FROM known_sources AS source
               WHERE source.tenant_id = event.tenant_id
                 AND source.appointment_id::text = event.aggregate_id
                 AND source.patient_uid = event.patient_uid
                 AND source.resource_type = event.payload ->> 'resource_type'
                 AND source.resource_id = event.payload ->> 'resource_id'
            )
            OR NOT EXISTS (
              SELECT 1
                FROM care_pathway_instances AS pathway
                JOIN current_reference_ancestry AS reference
                  ON reference.tenant_id = pathway.tenant_id
                 AND reference.pathway_instance_id = pathway.id
                 AND reference.patient_uid = pathway.patient_uid
                 AND reference.resource_type = event.payload ->> 'resource_type'
                 AND reference.resource_id = event.payload ->> 'resource_id'
                 AND reference.ancestor_source_outbox_event_id = event.id
               WHERE pathway.tenant_id = event.tenant_id
                 AND pathway.pathway_key = 'op_contact_to_recovery'
                 AND pathway.source_episode_type = 'appointment'
                 AND pathway.source_episode_id = event.aggregate_id
                 AND pathway.patient_uid = event.patient_uid
            )
          )
     ),
     findings AS (
       SELECT finding_id FROM source_without_link_event
       UNION ALL
       SELECT finding_id FROM link_event_without_source_or_reference
     )
     SELECT COUNT(*)::integer AS finding_count FROM findings`,
    tenantId,
  ));
}

async function opClosureAndOwnershipEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.OP) {
    return result('OP_CLOSURE_OWNERSHIP_DRIFT', 0);
  }
  return result('OP_CLOSURE_OWNERSHIP_DRIFT', await count(
    tx,
    `WITH findings AS (
       SELECT pathway.id::text AS finding_id
         FROM care_pathway_instances AS pathway
        WHERE pathway.tenant_id = $1::uuid
          AND pathway.pathway_key = 'op_contact_to_recovery'
          AND pathway.source_episode_type = 'appointment'
          AND pathway.clinical_status = 'completed'
          AND (
            NOT EXISTS (
              SELECT 1
                FROM op_visit_closure_evidence AS closure
               WHERE closure.tenant_id = pathway.tenant_id
                 AND closure.appointment_id::text = pathway.source_episode_id
                 AND closure.patient_uid = pathway.patient_uid
            )
            OR EXISTS (
              SELECT 1
                FROM care_pathway_resource_references AS reference
               WHERE reference.tenant_id = pathway.tenant_id
                 AND reference.pathway_instance_id = pathway.id
                 AND reference.patient_uid = pathway.patient_uid
                 AND reference.evidence_state = 'open'
                 AND NOT EXISTS (
                   SELECT 1
                     FROM care_pathway_resource_references AS successor
                    WHERE successor.tenant_id = reference.tenant_id
                      AND successor.superseded_reference_id = reference.id
                 )
            )
          )
       UNION ALL
       SELECT reference.id::text
         FROM care_pathway_resource_references AS reference
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = reference.tenant_id
          AND pathway.id = reference.pathway_instance_id
          AND pathway.patient_uid = reference.patient_uid
        WHERE reference.tenant_id = $1::uuid
          AND pathway.pathway_key = 'op_contact_to_recovery'
          AND reference.evidence_state = 'ownership_accepted'
          AND (
            (
              reference.task_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM tasks AS task
                 WHERE task.tenant_id = reference.tenant_id
                   AND task.id = reference.task_id
                   AND task.workflow_run_id = pathway.workflow_run_id
                   AND task.patient_uid = pathway.patient_uid
                   AND task.assigned_to_uid = reference.accepted_owner_uid
              )
            )
            OR (
              reference.handoff_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM care_handoff_instances AS handoff
                 WHERE handoff.tenant_id = reference.tenant_id
                   AND handoff.id = reference.handoff_id
                   AND handoff.patient_uid = pathway.patient_uid
                   AND handoff.status = 'accepted'
                   AND handoff.accepted_at IS NOT NULL
                   AND handoff.accepted_by_uid = reference.accepted_owner_uid
              )
            )
          )
     )
     SELECT COUNT(*)::integer AS finding_count FROM findings`,
    tenantId,
  ));
}

async function opToInpatientHandoffEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.OP) {
    return result('OP_TO_INPATIENT_HANDOFF_DRIFT', 0);
  }
  return result('OP_TO_INPATIENT_HANDOFF_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM admissions AS admission
       LEFT JOIN care_pathway_instances AS source_pathway
         ON source_pathway.tenant_id = admission.tenant_id
        AND source_pathway.id = admission.source_pathway_instance_id
        AND source_pathway.patient_uid = admission.patient_uid
       LEFT JOIN care_handoff_instances AS handoff
         ON handoff.tenant_id = admission.tenant_id
        AND handoff.id = admission.source_handoff_id
        AND handoff.patient_uid = admission.patient_uid
      WHERE admission.tenant_id = $1::uuid
        AND admission.source_appointment_id IS NOT NULL
        AND (
          source_pathway.pathway_key IS DISTINCT FROM 'op_contact_to_recovery'
          OR source_pathway.source_episode_type IS DISTINCT FROM 'appointment'
          OR source_pathway.source_episode_id IS DISTINCT FROM
               admission.source_appointment_id::text
          OR handoff.handoff_type IS DISTINCT FROM 'op_to_inpatient_transfer'
          OR handoff.sending_pathway_instance_id IS DISTINCT FROM source_pathway.id
          OR handoff.source_resource_type IS DISTINCT FROM 'appointment'
          OR handoff.source_resource_id IS DISTINCT FROM
               admission.source_appointment_id::text
          OR handoff.status IS DISTINCT FROM 'accepted'
          OR handoff.accepted_at IS NULL
          OR handoff.accepted_by_uid IS NULL
        )`,
    tenantId,
  ));
}

async function inpatientSourceProjectionEvidence({ tx, tenantId, pathwayKey, capturedAt }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.INPATIENT) {
    return result('INPATIENT_SOURCE_PROJECTION_DRIFT', 0);
  }
  return result('INPATIENT_SOURCE_PROJECTION_DRIFT', await count(
    tx,
    `WITH created_sources AS (
       SELECT DISTINCT event.aggregate_id, event.patient_uid
         FROM event_outbox AS event
        WHERE event.tenant_id = $1::uuid
          AND event.event_type = 'admission.created'
          AND event.aggregate_type = 'admission'
          AND event.created_at <= $2::timestamptz
          AND event.aggregate_id ~ '^[1-9][0-9]*$'
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM created_sources AS source
      WHERE NOT EXISTS (
        SELECT 1
          FROM care_pathway_instances AS pathway
         WHERE pathway.tenant_id = $1::uuid
           AND pathway.pathway_key = 'inpatient_admission_to_recovery'
           AND pathway.source_episode_type = 'admission'
           AND pathway.source_episode_id = source.aggregate_id
           AND pathway.patient_uid = source.patient_uid
           AND EXISTS (
             SELECT 1
               FROM care_pathway_resource_references AS reference
              WHERE reference.tenant_id = pathway.tenant_id
                AND reference.pathway_instance_id = pathway.id
                AND reference.patient_uid = pathway.patient_uid
                AND reference.resource_type = 'admission'
                AND reference.resource_id = source.aggregate_id
                AND reference.relationship_kind = 'closure_evidence'
                AND reference.evidence_state <> 'superseded'
           )
      )`,
    tenantId,
    capturedAt,
  ));
}

async function inpatientDiagnosticReferenceCompleteness({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.INPATIENT) {
    return result('INPATIENT_DIAGNOSTIC_REFERENCE_DRIFT', 0);
  }
  return result('INPATIENT_DIAGNOSTIC_REFERENCE_DRIFT', await count(
    tx,
    `WITH RECURSIVE known_sources AS (
       SELECT source.tenant_id,
              source.admission_id,
              source.patient_uid,
              'investigation'::text AS resource_type,
              source.id::text AS resource_id
         FROM investigations AS source
        WHERE source.tenant_id = $1::uuid
          AND source.admission_id IS NOT NULL
       UNION ALL
       SELECT source.tenant_id,
              source.admission_id,
              source.patient_uid,
              'lab_result'::text,
              source.id::text
         FROM lab_results AS source
        WHERE source.tenant_id = $1::uuid
          AND source.admission_id IS NOT NULL
       UNION ALL
       SELECT source.tenant_id,
              source.admission_id,
              source.patient_uid,
              'radiology_order'::text,
              source.id::text
         FROM radiology_orders AS source
        WHERE source.tenant_id = $1::uuid
          AND source.admission_id IS NOT NULL
       UNION ALL
       SELECT source.tenant_id,
              source.admission_id,
              source.patient_uid,
              'anatomical_pathology_case'::text,
              source.id::text
         FROM ap_cases AS source
        WHERE source.tenant_id = $1::uuid
          AND source.admission_id IS NOT NULL
       UNION ALL
       SELECT source.tenant_id,
              source.admission_id,
              source.patient_uid,
              'diagnostic_result_generation'::text,
              source.id::text
         FROM diagnostic_result_generations AS source
        WHERE source.tenant_id = $1::uuid
          AND source.admission_id IS NOT NULL
     ),
     current_reference_ancestry AS (
       SELECT reference.tenant_id,
              reference.pathway_instance_id,
              reference.patient_uid,
              reference.resource_type,
              reference.resource_id,
              reference.id AS current_reference_id,
              reference.id AS ancestor_reference_id,
              reference.superseded_reference_id,
              reference.source_outbox_event_id AS ancestor_source_outbox_event_id,
              ARRAY[reference.id]::uuid[] AS visited_reference_ids,
              1::integer AS ancestry_depth
          FROM care_pathway_resource_references AS reference
         WHERE reference.tenant_id = $1::uuid
           AND reference.relationship_kind = 'child_action'
           AND reference.evidence_state <> 'superseded'
           AND NOT EXISTS (
            SELECT 1
              FROM care_pathway_resource_references AS successor
             WHERE successor.tenant_id = reference.tenant_id
               AND successor.superseded_reference_id = reference.id
          )
       UNION ALL
       SELECT ancestry.tenant_id,
              ancestry.pathway_instance_id,
              ancestry.patient_uid,
              ancestry.resource_type,
              ancestry.resource_id,
              ancestry.current_reference_id,
              predecessor.id,
              predecessor.superseded_reference_id,
              predecessor.source_outbox_event_id,
              ancestry.visited_reference_ids || predecessor.id,
              ancestry.ancestry_depth + 1
         FROM current_reference_ancestry AS ancestry
         JOIN care_pathway_resource_references AS predecessor
           ON predecessor.tenant_id = ancestry.tenant_id
          AND predecessor.id = ancestry.superseded_reference_id
          AND predecessor.pathway_instance_id = ancestry.pathway_instance_id
          AND predecessor.patient_uid = ancestry.patient_uid
          AND predecessor.resource_type = ancestry.resource_type
          AND predecessor.resource_id = ancestry.resource_id
          AND predecessor.relationship_kind = 'child_action'
        WHERE ancestry.ancestry_depth < 64
          AND predecessor.id <> ALL(ancestry.visited_reference_ids)
     ),
     source_without_link_event AS (
       SELECT CONCAT(
                'source:',
                source.resource_type,
                ':',
                source.resource_id
              ) AS finding_id
         FROM known_sources AS source
        WHERE NOT EXISTS (
          SELECT 1
            FROM event_outbox AS event
           WHERE event.tenant_id = source.tenant_id
             AND event.event_type = 'admission.diagnostic_resource_linked'
             AND event.aggregate_type = 'admission'
             AND event.aggregate_id = source.admission_id::text
             AND event.patient_uid = source.patient_uid
             AND event.payload ->> 'admission_id' = source.admission_id::text
             AND event.payload ->> 'patient_uid' = source.patient_uid::text
             AND event.payload ->> 'resource_type' = source.resource_type
             AND event.payload ->> 'resource_id' = source.resource_id
             AND event.payload ->> 'admission_lineage_version' = '1'
             AND NULLIF(event.payload ->> 'occurred_at', '') IS NOT NULL
        )
     ),
     link_event_without_source_or_reference AS (
       SELECT CONCAT('event:', event.id::text) AS finding_id
         FROM event_outbox AS event
        WHERE event.tenant_id = $1::uuid
          AND event.event_type = 'admission.diagnostic_resource_linked'
          AND (
            event.aggregate_type <> 'admission'
            OR event.aggregate_id !~ '^[1-9][0-9]*$'
            OR event.payload ->> 'admission_id' IS DISTINCT FROM event.aggregate_id
            OR event.payload ->> 'patient_uid' IS DISTINCT FROM event.patient_uid::text
            OR event.payload ->> 'admission_lineage_version' IS DISTINCT FROM '1'
            OR NULLIF(event.payload ->> 'occurred_at', '') IS NULL
            OR NOT EXISTS (
              SELECT 1
                FROM known_sources AS source
               WHERE source.tenant_id = event.tenant_id
                 AND source.admission_id::text = event.aggregate_id
                 AND source.patient_uid = event.patient_uid
                 AND source.resource_type = event.payload ->> 'resource_type'
                 AND source.resource_id = event.payload ->> 'resource_id'
            )
            OR NOT EXISTS (
              SELECT 1
                FROM care_pathway_instances AS pathway
                JOIN current_reference_ancestry AS reference
                  ON reference.tenant_id = pathway.tenant_id
                 AND reference.pathway_instance_id = pathway.id
                 AND reference.patient_uid = pathway.patient_uid
                 AND reference.resource_type = event.payload ->> 'resource_type'
                 AND reference.resource_id = event.payload ->> 'resource_id'
                 AND reference.ancestor_source_outbox_event_id = event.id
               WHERE pathway.tenant_id = event.tenant_id
                 AND pathway.pathway_key = 'inpatient_admission_to_recovery'
                 AND pathway.source_episode_type = 'admission'
                 AND pathway.source_episode_id = event.aggregate_id
                 AND pathway.patient_uid = event.patient_uid
            )
          )
     ),
     findings AS (
       SELECT finding_id FROM source_without_link_event
       UNION ALL
       SELECT finding_id FROM link_event_without_source_or_reference
     )
     SELECT COUNT(*)::integer AS finding_count FROM findings`,
    tenantId,
  ));
}

async function inpatientDischargeEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.INPATIENT) {
    return result('INPATIENT_DISCHARGE_EVIDENCE_DRIFT', 0);
  }
  return result('INPATIENT_DISCHARGE_EVIDENCE_DRIFT', await count(
    tx,
    `SELECT COUNT(DISTINCT admission.id)::integer AS finding_count
       FROM admissions AS admission
      WHERE admission.tenant_id = $1::uuid
        AND admission.discharged_at IS NOT NULL
        AND (
          NOT EXISTS (
            SELECT 1
              FROM discharge_summaries AS summary
             WHERE summary.tenant_id = admission.tenant_id
               AND summary.admission_id = admission.id
               AND summary.patient_uid = admission.patient_uid
               AND summary.status IN ('signed', 'delivered')
               AND summary.signed_by IS NOT NULL
               AND summary.signed_at IS NOT NULL
          )
          OR NOT EXISTS (
            SELECT 1
              FROM medication_reconciliations AS reconciliation
             WHERE reconciliation.tenant_id = admission.tenant_id
               AND reconciliation.admission_id = admission.id
               AND reconciliation.patient_uid = admission.patient_uid
               AND reconciliation.rec_type = 'discharge'
               AND reconciliation.status = 'completed'
               AND reconciliation.completed_by IS NOT NULL
               AND reconciliation.completed_at IS NOT NULL
               AND jsonb_typeof(
                     reconciliation.metadata -> 'take_home_list'
                   ) = 'array'
          )
          OR (
            NOT EXISTS (
              SELECT 1
                FROM follow_up_plans AS plan
                JOIN appointments AS appointment
                  ON appointment.tenant_id = plan.tenant_id
                 AND appointment.id = plan.appointment_id
                JOIN users AS appointment_patient
                  ON appointment_patient.tenant_id = appointment.tenant_id
                 AND appointment_patient.id = appointment.patient_id
                 AND appointment_patient.uid = plan.patient_uid
               WHERE plan.tenant_id = admission.tenant_id
                 AND plan.patient_uid = admission.patient_uid
                 AND plan.origin_kind = 'admission'
                 AND plan.origin_resource_type = 'admission'
                 AND plan.origin_resource_id = admission.id::text
                 AND plan.status IN ('open', 'scheduled')
                 AND UPPER(COALESCE(appointment.status, '')) NOT IN
                     ('CANCELLED', 'CANCELED', 'NO_SHOW')
            )
            AND NOT EXISTS (
              -- Merged-uid union: the exception may predate a patient merge
              -- and stay recorded under a uid merged into this admission's
              -- patient (append-only timeline/audit are never re-pointed).
              SELECT 1
                FROM clinical_timeline_events AS timeline
                JOIN clinical_audit_events AS audit
                  ON audit.tenant_id = timeline.tenant_id
                 AND audit.patient_uid = timeline.patient_uid
                 AND audit.action = 'discharge.follow_up_exception_recorded'
                 AND audit.resource_type = 'admission'
                 AND audit.resource_id = admission.id::text
                 AND NULLIF(audit.metadata ->> 'reason', '') IS NOT NULL
               WHERE timeline.tenant_id = admission.tenant_id
                 AND timeline.patient_uid IN (
                   ${mergedPatientUidsSubquery('admission.tenant_id', 'admission.patient_uid')}
                 )
                 AND timeline.encounter_id IS NOT DISTINCT FROM admission.encounter_id
                 AND timeline.event_type =
                     'discharge.follow_up_exception_recorded'
                 AND timeline.resource_type = 'admission'
                 AND timeline.resource_id = admission.id::text
                 AND NULLIF(timeline.payload ->> 'reason', '') IS NOT NULL
            )
          )
          OR EXISTS (
            SELECT 1
              FROM discharge_pending_result_handoffs AS handoff
              LEFT JOIN inpatient_primary_physician_assignments AS assignment
                ON assignment.tenant_id = handoff.tenant_id
               AND assignment.id = handoff.primary_physician_assignment_id
               AND assignment.admission_id = handoff.admission_id
               AND assignment.patient_uid = handoff.patient_uid
              LEFT JOIN discharge_summaries AS summary
                ON summary.tenant_id = handoff.tenant_id
               AND summary.id = handoff.discharge_summary_id
               AND summary.admission_id = handoff.admission_id
               AND summary.patient_uid = handoff.patient_uid
              LEFT JOIN tasks AS task
                ON task.tenant_id = handoff.tenant_id
               AND task.id = handoff.task_id
             WHERE handoff.tenant_id = admission.tenant_id
               AND handoff.admission_id = admission.id
               AND handoff.patient_uid = admission.patient_uid
               AND handoff.handoff_state <> 'superseded'
               AND (
                 assignment.id IS NULL
                 OR handoff.named_physician_uid IS DISTINCT FROM
                      assignment.physician_uid
                 OR summary.id IS NULL
                 OR summary.status NOT IN ('signed', 'delivered')
                 OR handoff.summary_included_at IS NULL
                 OR handoff.summary_inclusion_timeline_event_id IS NULL
                 OR task.id IS NULL
                 OR task.assigned_to_uid IS DISTINCT FROM
                      handoff.named_physician_uid
               )
          )
        )`,
    tenantId,
  ));
}

async function inpatientContinuityEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.INPATIENT) {
    return result('INPATIENT_CONTINUITY_EVIDENCE_DRIFT', 0);
  }
  return result('INPATIENT_CONTINUITY_EVIDENCE_DRIFT', await count(
    tx,
    `WITH findings AS (
       SELECT pathway.id::text AS finding_id
         FROM care_pathway_instances AS pathway
        WHERE pathway.tenant_id = $1::uuid
          AND pathway.pathway_key = 'inpatient_admission_to_recovery'
          AND pathway.source_episode_type = 'admission'
          AND pathway.clinical_status = 'completed'
          AND NOT EXISTS (
            SELECT 1
              FROM post_discharge_contact_events AS contact
             WHERE contact.tenant_id = pathway.tenant_id
               AND contact.admission_id::text = pathway.source_episode_id
               AND contact.patient_uid = pathway.patient_uid
          )
       UNION ALL
       SELECT admission.id::text
         FROM admissions AS admission
         LEFT JOIN admissions AS prior
           ON prior.tenant_id = admission.tenant_id
          AND prior.id = admission.prior_admission_id
          AND prior.patient_uid = admission.patient_uid
        WHERE admission.tenant_id = $1::uuid
          AND admission.prior_admission_id IS NOT NULL
          AND prior.id IS NULL
     )
     SELECT COUNT(*)::integer AS finding_count FROM findings`,
    tenantId,
  ));
}

async function emergencySourceProjectionEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.EMERGENCY) {
    return result('EMERGENCY_SOURCE_PROJECTION_DRIFT', 0);
  }
  return result('EMERGENCY_SOURCE_PROJECTION_DRIFT', await count(
    tx,
    `SELECT COUNT(*)::integer AS finding_count
       FROM emergency_visits AS visit
       JOIN tenants AS tenant
         ON tenant.id = visit.tenant_id
       LEFT JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = visit.tenant_id
        AND pathway.patient_uid = visit.patient_uid
        AND pathway.pathway_key = 'emergency_arrival_to_aftercare'
        AND pathway.source_episode_type = 'emergency_visit'
        AND pathway.source_episode_id = visit.id::text
      WHERE visit.tenant_id = $1::uuid
        AND tenant.settings #>>
              '{care_pathways,emergency_arrival_to_aftercare}'
              IN ('shadow', 'active')
        AND visit.patient_uid IS NOT NULL
        AND visit.encounter_id IS NOT NULL
        AND (
          pathway.id IS NULL
          OR pathway.workflow_run_id IS NULL
          OR pathway.definition_checksum IS NULL
        )`,
    tenantId,
  ));
}

async function emergencyDestinationHandoffEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.EMERGENCY) {
    return result('EMERGENCY_DESTINATION_HANDOFF_DRIFT', 0);
  }
  return result('EMERGENCY_DESTINATION_HANDOFF_DRIFT', await count(
    tx,
    `WITH findings AS (
       SELECT handoff.id::text AS finding_id
         FROM care_handoff_instances AS handoff
         LEFT JOIN tasks AS task
           ON task.tenant_id = handoff.tenant_id
          AND task.id = handoff.task_id
         LEFT JOIN users AS accepter
           ON accepter.tenant_id = handoff.tenant_id
          AND accepter.uid = handoff.accepted_by_uid
         LEFT JOIN emergency_visits AS visit
           ON visit.tenant_id = handoff.tenant_id
          AND visit.patient_uid = handoff.patient_uid
          AND visit.id::text = handoff.source_resource_id
        WHERE handoff.tenant_id = $1::uuid
          AND handoff.handoff_type = 'ed_destination_handoff'
          AND (
            task.id IS NULL
            OR task.task_kind <> 'ed_destination_handoff_review'
            OR task.related_resource_type <> 'care_handoff_instance'
            OR task.related_resource_id <> handoff.id::text
            OR task.encounter_id IS NOT NULL
            OR task.metadata ->> 'canonical_encounter_id'
                 IS DISTINCT FROM visit.encounter_id::text
            OR task.assigned_to_uid IS NOT NULL
            OR task.assigned_to_role IS DISTINCT FROM
                 handoff.intended_recipient_role
            OR task.due_at IS NOT NULL
            OR task.workflow_sla_instance_id IS NOT NULL
            OR task.sla_completion_semantics <> 'none'
            OR (
              handoff.status = 'requested'
              AND task.status NOT IN (
                'open', 'in_progress', 'blocked', 'overdue'
              )
            )
            OR (
              handoff.status = 'accepted'
              AND (
                task.status <> 'completed'
                OR accepter.uid IS NULL
                OR UPPER(BTRIM(accepter.role)) IS DISTINCT FROM
                     handoff.intended_recipient_role
                OR NOT accepter.is_active
                OR accepter.status <> 'active'
                OR accepter.is_deleted
                OR accepter.deleted_at IS NOT NULL
              )
            )
          )
       UNION ALL
       SELECT visit.id::text
         FROM emergency_visits AS visit
         JOIN tenants AS tenant
           ON tenant.id = visit.tenant_id
         LEFT JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = visit.tenant_id
          AND pathway.patient_uid = visit.patient_uid
          AND pathway.pathway_key = 'emergency_arrival_to_aftercare'
          AND pathway.source_episode_type = 'emergency_visit'
          AND pathway.source_episode_id = visit.id::text
        WHERE visit.tenant_id = $1::uuid
          AND tenant.settings #>>
                '{care_pathways,emergency_arrival_to_aftercare}' = 'active'
          AND visit.status IN ('admitted', 'transferred')
          AND NOT EXISTS (
            SELECT 1
              FROM care_handoff_instances AS handoff
             WHERE handoff.tenant_id = visit.tenant_id
               AND handoff.patient_uid = visit.patient_uid
               AND handoff.sending_pathway_instance_id = pathway.id
               AND handoff.handoff_type = 'ed_destination_handoff'
               AND handoff.source_resource_type = 'emergency_visit'
               AND handoff.source_resource_id = visit.id::text
               AND handoff.status = 'accepted'
               AND handoff.accepted_at IS NOT NULL
               AND handoff.accepted_by_uid IS NOT NULL
               AND (
                 visit.status <> 'admitted'
                 OR EXISTS (
                   SELECT 1
                     FROM admissions AS admission
                    WHERE admission.tenant_id = visit.tenant_id
                      AND admission.patient_uid = visit.patient_uid
                      AND admission.from_er_visit_id = visit.id
                      AND admission.source_pathway_instance_id = pathway.id
                      AND admission.source_handoff_id = handoff.id
                 )
               )
          )
     )
     SELECT COUNT(*)::integer AS finding_count FROM findings`,
    tenantId,
  ));
}

async function emergencyClosureRecoveryEvidence({ tx, tenantId, pathwayKey }) {
  if (pathwayKey !== CARE_PATHWAY_KEYS.EMERGENCY) {
    return result('EMERGENCY_CLOSURE_RECOVERY_DRIFT', 0);
  }
  return result('EMERGENCY_CLOSURE_RECOVERY_DRIFT', await count(
    tx,
    `WITH terminal AS (
       SELECT visit.id,
              visit.patient_uid,
              visit.encounter_id,
              visit.attending_doctor_uid,
              visit.status,
              visit.is_mlc,
              patient.is_unidentified,
              closure.id AS closure_id,
              closure.closure_kind,
              closure.clinician_uid,
              closure.identity_resolution_status,
              closure.patient_merge_request_id,
              closure.accepted_handoff_id,
              closure.death_record_id,
              closure.mlc_record_id,
              handoff.id AS handoff_id,
              handoff.metadata ->> 'destination' AS destination,
              death.status AS death_status,
              death.certified_at,
              custody.has_receive AS custody_has_receive,
              custody.has_release AS custody_has_release,
              mlc.status AS mlc_status,
              review.completeness_status,
              review.certification_blocked,
              COALESCE(recovery.attempt_count, 0)::integer AS attempt_count,
              recovery.outcome_count,
              merge_request.status AS merge_status
         FROM emergency_visits AS visit
         JOIN tenants AS tenant
           ON tenant.id = visit.tenant_id
         JOIN users AS patient
           ON patient.tenant_id = visit.tenant_id
          AND patient.uid = visit.patient_uid
         LEFT JOIN LATERAL (
           SELECT candidate.*
             FROM ed_closure_evidence AS candidate
            WHERE candidate.tenant_id = visit.tenant_id
              AND candidate.emergency_visit_id = visit.id
            ORDER BY candidate.evidence_revision DESC
            LIMIT 1
         ) AS closure ON TRUE
         LEFT JOIN LATERAL (
           SELECT candidate.*
             FROM care_handoff_instances AS candidate
            WHERE candidate.tenant_id = visit.tenant_id
              AND candidate.patient_uid = visit.patient_uid
              AND candidate.handoff_type = 'ed_destination_handoff'
              AND candidate.source_resource_type = 'emergency_visit'
              AND candidate.source_resource_id = visit.id::text
              AND candidate.status = 'accepted'
            ORDER BY candidate.accepted_at DESC, candidate.id DESC
            LIMIT 1
         ) AS handoff ON TRUE
         LEFT JOIN death_records AS death
           ON death.id = closure.death_record_id
          AND death.tenant_id = visit.tenant_id
          AND death.patient_uid = visit.patient_uid
         LEFT JOIN LATERAL (
           SELECT BOOL_OR(event.event_type = 'receive') AS has_receive,
                  BOOL_OR(event.event_type = 'release') AS has_release
             FROM body_custody_events AS event
            WHERE event.tenant_id = visit.tenant_id
              AND event.death_record_id = death.id
         ) AS custody ON TRUE
         LEFT JOIN mlc_records AS mlc
           ON mlc.id = closure.mlc_record_id
          AND mlc.tenant_id = visit.tenant_id
          AND mlc.patient_uid = visit.patient_uid
          AND mlc.emergency_visit_id = visit.id
         LEFT JOIN mlc_completeness_reviews AS review
           ON review.tenant_id = mlc.tenant_id
          AND review.mlc_record_id = mlc.id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (
                    WHERE event.event_kind = 'attempt'
                  )::integer AS attempt_count,
                  COUNT(*) FILTER (
                    WHERE event.event_kind = 'outcome'
                  )::integer AS outcome_count
             FROM ed_recovery_contact_events AS event
            WHERE event.tenant_id = visit.tenant_id
              AND event.emergency_visit_id = visit.id
              AND (
                closure.id IS NULL
                OR event.closure_evidence_id = closure.id
              )
         ) AS recovery ON TRUE
         LEFT JOIN patient_merge_requests AS merge_request
           ON merge_request.tenant_id = visit.tenant_id
          AND merge_request.id = closure.patient_merge_request_id
        WHERE visit.tenant_id = $1::uuid
          AND tenant.settings #>>
                '{care_pathways,emergency_arrival_to_aftercare}'
                IN ('shadow', 'active')
          AND visit.status IN (
            'discharged',
            'left_against_advice',
            'lwbs',
            'transferred',
            'expired'
          )
     )
     SELECT COUNT(*)::integer AS finding_count
       FROM terminal
      WHERE (
        status = 'discharged'
        AND closure_kind IS DISTINCT FROM 'discharge'
      )
      OR (
        status = 'left_against_advice'
        AND (
          closure_kind IS DISTINCT FROM 'left_against_medical_advice'
          OR attempt_count < 1
          OR COALESCE(outcome_count, 0) < 1
        )
      )
      OR (
        status = 'lwbs'
        AND (
          closure_kind IS DISTINCT FROM 'lwbs'
          OR attempt_count < 1
          OR COALESCE(outcome_count, 0) < 1
        )
      )
      OR (
        status = 'transferred'
        AND destination = 'external_transfer'
        AND (
          closure_kind IS DISTINCT FROM 'external_transfer'
          OR accepted_handoff_id IS DISTINCT FROM handoff_id
        )
      )
      OR (
        status = 'expired'
        AND (
          closure_kind IS DISTINCT FROM 'death'
          OR death_status NOT IN (
            'certified',
            'submitted_to_registrar',
            'registered'
          )
          OR certified_at IS NULL
          OR custody_has_receive IS DISTINCT FROM TRUE
          OR custody_has_release IS DISTINCT FROM TRUE
          OR (
            is_mlc
            AND (
              mlc_status NOT IN ('certified', 'closed')
              OR completeness_status NOT IN (
                'complete',
                'certified',
                'closed'
              )
              OR certification_blocked IS DISTINCT FROM FALSE
            )
          )
        )
      )
      OR (
        closure_id IS NOT NULL
        AND clinician_uid IS DISTINCT FROM attending_doctor_uid
      )
      OR (
        is_unidentified
        AND (
          identity_resolution_status IS NULL
          OR (
            identity_resolution_status = 'merge_requested'
            AND merge_status NOT IN ('requested', 'approved')
          )
          OR (
            identity_resolution_status = 'merged'
            AND merge_status <> 'executed'
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

export const OP_PATHWAY_RECONCILIATION_CHECKS = Object.freeze([
  Object.freeze({ id: 'op_live_appointment_source_coverage', handlerVersion: 'care_pathway.op_live_appointment_source_coverage.v1', run: opLiveAppointmentSourceCoverage }),
  Object.freeze({ id: 'op_source_projection', handlerVersion: 'care_pathway.op_source_projection.v1', run: opSourceProjectionEvidence }),
  Object.freeze({ id: 'op_stale_scheduled_reaper_debt', handlerVersion: 'care_pathway.op_stale_scheduled_reaper_debt.v1', run: opStaleScheduledReaperDebt }),
  Object.freeze({ id: 'op_child_reference_completeness', handlerVersion: 'care_pathway.op_child_reference_completeness.v1', run: opChildReferenceCompleteness }),
  Object.freeze({ id: 'op_closure_ownership_evidence', handlerVersion: 'care_pathway.op_closure_ownership_evidence.v1', run: opClosureAndOwnershipEvidence }),
  Object.freeze({ id: 'op_to_inpatient_handoff_evidence', handlerVersion: 'care_pathway.op_to_inpatient_handoff_evidence.v1', run: opToInpatientHandoffEvidence }),
]);

export const INPATIENT_PATHWAY_RECONCILIATION_CHECKS = Object.freeze([
  Object.freeze({ id: 'inpatient_source_projection', handlerVersion: 'care_pathway.inpatient_source_projection.v1', run: inpatientSourceProjectionEvidence }),
  Object.freeze({ id: 'inpatient_diagnostic_reference_completeness', handlerVersion: 'care_pathway.inpatient_diagnostic_reference_completeness.v1', run: inpatientDiagnosticReferenceCompleteness }),
  Object.freeze({ id: 'inpatient_discharge_evidence', handlerVersion: 'care_pathway.inpatient_discharge_evidence.v1', run: inpatientDischargeEvidence }),
  Object.freeze({ id: 'inpatient_continuity_evidence', handlerVersion: 'care_pathway.inpatient_continuity_evidence.v1', run: inpatientContinuityEvidence }),
]);

export const EMERGENCY_PATHWAY_RECONCILIATION_CHECKS = Object.freeze([
  Object.freeze({ id: 'emergency_source_projection', handlerVersion: 'care_pathway.emergency_source_projection.v1', run: emergencySourceProjectionEvidence }),
  Object.freeze({ id: 'emergency_destination_handoff_evidence', handlerVersion: 'care_pathway.emergency_destination_handoff_evidence.v1', run: emergencyDestinationHandoffEvidence }),
]);

export const EMERGENCY_PATHWAY_RECONCILIATION_CHECKS_V2 = Object.freeze([
  ...EMERGENCY_PATHWAY_RECONCILIATION_CHECKS,
  Object.freeze({
    id: 'emergency_closure_recovery_evidence',
    handlerVersion: 'care_pathway.emergency_closure_recovery_evidence.v1',
    run: emergencyClosureRecoveryEvidence,
  }),
]);

export default COMMON_PATHWAY_RECONCILIATION_CHECKS;
