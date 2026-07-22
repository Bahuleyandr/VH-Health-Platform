import { randomUUID } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import {
  completePathwayTaskAndExecuteFromRegisteredEvidence,
  executePathwayCommand,
} from '../pathways/pathwayExecutorService.js';
import { sha256ClinicalJson } from './diagnosticClassification.js';
import { supersedeAcknowledgementTaskFromTrustedWorkflow } from '../workflow/taskService.js';

async function loadSupersessionContextTx(tx, tenantId, successorGenerationId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT predecessor.id AS predecessor_generation_id,
            predecessor.patient_uid,
            predecessor.snapshot_sha256,
            successor.id AS successor_generation_id,
            successor.signer_uid AS successor_signer_uid,
            predecessor.critical_acknowledgement_task_id,
            predecessor.critical_acknowledgement_sla_id,
            acknowledgement_task.status AS acknowledgement_task_status,
            pathway.id AS pathway_instance_id,
            pathway.workflow_run_id,
            pathway.clinical_status,
            run.current_step_key,
            step.id AS workflow_step_id,
            task.id AS task_id,
            task.status AS task_status,
            prior_action.id AS predecessor_action_id
       FROM diagnostic_result_generations AS successor
       JOIN diagnostic_result_generations AS predecessor
         ON predecessor.tenant_id = successor.tenant_id
        AND predecessor.id = successor.predecessor_generation_id
        AND predecessor.patient_uid = successor.patient_uid
       LEFT JOIN LATERAL (
         SELECT candidate.*
           FROM care_pathway_instances AS candidate
          WHERE candidate.tenant_id = predecessor.tenant_id
            AND candidate.pathway_key = 'diagnostics_order_to_action'
            AND candidate.source_episode_type = 'diagnostic_result_generation'
            AND candidate.source_episode_id = predecessor.id::text
          ORDER BY
            CASE WHEN candidate.clinical_status IN ('planned', 'active', 'on_hold') THEN 0 ELSE 1 END,
            candidate.created_at DESC,
            candidate.id DESC
          LIMIT 1
       ) AS pathway ON TRUE
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
       LEFT JOIN LATERAL (
         SELECT action.id
           FROM diagnostic_result_actions AS action
          WHERE action.tenant_id = predecessor.tenant_id
            AND action.generation_id = predecessor.id
          ORDER BY action.occurred_at DESC, action.id DESC
          LIMIT 1
       ) AS prior_action ON TRUE
       LEFT JOIN tasks AS acknowledgement_task
         ON acknowledgement_task.tenant_id = predecessor.tenant_id
        AND acknowledgement_task.id = predecessor.critical_acknowledgement_task_id
      WHERE successor.tenant_id = $1::uuid
        AND successor.id = $2::uuid
      LIMIT 1
      FOR UPDATE OF predecessor, successor`,
    tenantId,
    successorGenerationId,
  );
  return rows[0] || null;
}

async function findExistingSupersessionTx(tx, tenantId, predecessorGenerationId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM diagnostic_result_actions
      WHERE tenant_id = $1::uuid
        AND generation_id = $2::uuid
        AND action_kind = 'generation_superseded'
      LIMIT 1`,
    tenantId,
    predecessorGenerationId,
  );
  return rows[0] || null;
}

async function recordSupersessionActionTx(tx, tenantId, row) {
  const existing = await findExistingSupersessionTx(
    tx,
    tenantId,
    row.predecessor_generation_id,
  );
  if (existing) {
    if (String(existing.superseding_generation_id) !== String(row.successor_generation_id)) {
      throw AppError.conflict(
        'Diagnostic generation was superseded by a different successor',
        'DIAGNOSTIC_GENERATION_SUPERSESSION_CONFLICT',
      );
    }
    return { action: existing, replayed: true };
  }

  const actionId = randomUUID();
  const idempotencyKey = `diagnostic-generation-superseded:${row.predecessor_generation_id}`;
  const requestSha256 = sha256ClinicalJson({
    generation_id: String(row.predecessor_generation_id),
    generation_snapshot_sha256: row.snapshot_sha256,
    action_kind: 'generation_superseded',
    superseding_generation_id: String(row.successor_generation_id),
  });
  const canonical = await recordCanonicalClinicalEvent({
    tenantId,
    patientUid: row.patient_uid,
    eventType: 'diagnostic.result.generation_superseded',
    eventSubtype: 'corrected_generation',
    eventStatus: 'superseded',
    sourceTable: 'diagnostic_result_actions',
    sourceId: actionId,
    resourceType: 'diagnostic_result_action',
    resourceTable: 'diagnostic_result_actions',
    resourceId: actionId,
    visibleToPatient: false,
    summary: 'Diagnostic result generation superseded by a signed correction',
    payload: {
      action_id: actionId,
      generation_id: String(row.predecessor_generation_id),
      superseding_generation_id: String(row.successor_generation_id),
    },
    afterState: {
      generation_snapshot_sha256: row.snapshot_sha256,
      request_sha256: requestSha256,
    },
    tags: ['diagnostics', 'corrected_generation', 'superseded'],
    timelineIdempotencyKey: `diagnostic_result_actions:${actionId}:generation_superseded`,
    auditIdempotencyKey: `diagnostic_result_actions:${actionId}:audit:generation_superseded`,
  }, { db: tx });
  if (!canonical?.timeline?.id || !canonical?.audit?.id) {
    throw AppError.internal(
      'Diagnostic supersession canonical evidence is unavailable',
      'DIAGNOSTIC_ACTION_CANONICAL_EVIDENCE_REQUIRED',
    );
  }
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO diagnostic_result_actions
       (id, tenant_id, patient_uid, generation_id, pathway_instance_id,
        action_kind, generation_snapshot_sha256, idempotency_key, request_sha256,
        predecessor_action_id, superseding_generation_id,
        canonical_timeline_event_id, canonical_audit_event_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        'generation_superseded', $6::text, $7::text, $8::text,
        $9::uuid, $10::uuid, $11::uuid, $12::uuid)
     RETURNING *`,
    actionId,
    tenantId,
    row.patient_uid,
    row.predecessor_generation_id,
    row.pathway_instance_id || null,
    row.snapshot_sha256,
    idempotencyKey,
    requestSha256,
    row.predecessor_action_id || null,
    row.successor_generation_id,
    canonical.timeline.id,
    canonical.audit.id,
  );
  return { action: inserted[0], replayed: false };
}

export async function supersedePriorDiagnosticGenerationTx({
  tx,
  tenantId,
  successorGenerationId,
  actor,
  registry,
  activationEvidenceCapability,
} = {}) {
  const row = await loadSupersessionContextTx(tx, tenantId, successorGenerationId);
  if (!row) return Object.freeze({ superseded: false, reason: 'no_predecessor' });
  const recorded = await recordSupersessionActionTx(tx, tenantId, row);
  if (
    row.critical_acknowledgement_task_id != null
    && ['open', 'in_progress', 'blocked', 'overdue'].includes(row.acknowledgement_task_status)
  ) {
    await supersedeAcknowledgementTaskFromTrustedWorkflow({
      tenantId,
      id: Number(row.critical_acknowledgement_task_id),
      relatedResourceType: 'diagnostic_result_generation',
      relatedResourceId: String(row.predecessor_generation_id),
      workflowSlaInstanceId: row.critical_acknowledgement_sla_id,
      supersededByActorUid: row.successor_signer_uid,
      supersedingDiagnosticGenerationId: row.successor_generation_id,
      supersessionReason: 'diagnostic_generation_superseded',
      tx,
    });
  }
  if (!row.pathway_instance_id || !['planned', 'active', 'on_hold'].includes(row.clinical_status)) {
    return Object.freeze({
      superseded: true,
      action_id: String(recorded.action.id),
      pathway_advanced: false,
      replayed: recorded.replayed,
    });
  }

  const command = {
    tenantId,
    pathwayInstanceId: String(row.pathway_instance_id),
    idempotencyKey: `diagnostic-generation-superseded:${row.predecessor_generation_id}`,
    signal: {
      kind: 'diagnostic_generation_superseded',
      payload: {
        diagnostic_action_id: String(recorded.action.id),
        diagnostic_generation_id: String(row.predecessor_generation_id),
        superseding_generation_id: String(row.successor_generation_id),
      },
    },
    actor,
    registry,
    activationEvidenceCapability,
    tx,
  };
  let execution;
  if (row.current_step_key === 'record_doctor_action' && row.task_id != null) {
    execution = await completePathwayTaskAndExecuteFromRegisteredEvidence({
      ...command,
      taskId: Number(row.task_id),
      workflowRunId: Number(row.workflow_run_id),
      workflowStepId: Number(row.workflow_step_id),
      conditionHandler: 'diagnostics.doctor_action.v1',
      evidence: {
        kind: 'diagnostic_generation_superseded',
        diagnostic_action_id: String(recorded.action.id),
        diagnostic_generation_id: String(row.predecessor_generation_id),
        superseding_generation_id: String(row.successor_generation_id),
      },
    });
  } else {
    execution = await executePathwayCommand(command);
  }
  return Object.freeze({
    superseded: true,
    action_id: String(recorded.action.id),
    pathway_advanced: true,
    pathway_status: execution.instance?.clinical_status || null,
    replayed: execution.replayed === true,
  });
}

export default { supersedePriorDiagnosticGenerationTx };
