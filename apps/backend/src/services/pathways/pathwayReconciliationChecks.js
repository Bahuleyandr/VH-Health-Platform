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
              )::integer AS missing_investigation_rows
         FROM diagnostic_result_generation_items AS item
         LEFT JOIN lab_results AS lab
           ON lab.tenant_id = item.tenant_id
          AND item.source_table = 'lab_results'
          AND lab.id::text = item.source_row_id
         LEFT JOIN investigations AS shared
           ON shared.tenant_id = item.tenant_id
          AND item.source_table = 'investigations'
          AND shared.id::text = item.source_row_id
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
      WHERE generation.tenant_id = $1::uuid
        AND (
          items.generation_id IS NULL
          OR items.item_count <> generation.item_count
          OR items.snapshot_sha256 IS DISTINCT FROM generation.snapshot_sha256::text
          OR items.missing_lab_rows > 0
          OR items.missing_investigation_rows > 0
          OR (generation.source_kind = 'lab_panel' AND signoff.id IS NULL)
          OR (generation.source_kind = 'shared_investigation' AND investigation.id IS NULL)
          OR (generation.source_kind = 'shared_investigation'
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
  Object.freeze({ id: 'diagnostic_generation_evidence', handlerVersion: 'care_pathway.diagnostic_generation_evidence.v1', run: diagnosticGenerationEvidence }),
  Object.freeze({ id: 'diagnostic_projection_evidence', handlerVersion: 'care_pathway.diagnostic_projection_evidence.v1', run: diagnosticProjectionEvidence }),
  Object.freeze({ id: 'diagnostic_action_evidence', handlerVersion: 'care_pathway.diagnostic_action_evidence.v1', run: diagnosticActionEvidence }),
  Object.freeze({ id: 'diagnostic_obligation_evidence', handlerVersion: 'care_pathway.diagnostic_obligation_evidence.v1', run: diagnosticObligationEvidence }),
]);

export default COMMON_PATHWAY_RECONCILIATION_CHECKS;
