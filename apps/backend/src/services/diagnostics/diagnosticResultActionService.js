import { randomUUID } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { signDocumentTx } from '../clinical/documentIntegrityService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
import {
  completePathwayTaskAndExecuteFromRegisteredEvidence,
  executePathwayCommand,
} from '../pathways/pathwayExecutorService.js';
import { projectDiagnosticPathwayEvent } from '../pathways/diagnosticPathwayProjector.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { getDiagnosticGenerationReleaseDecisionTx } from '../portal/portalAccessService.js';
import {
  rearmPendingResultOwnerActionsForDiagnosticReopenTx,
  settlePendingResultOwnerActionsForDiagnosticActionTx,
} from '../emr/inpatientPathwayDomainService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  isPathwayNamedClinicalOwnerRole,
  resolveCurrentHumanActorTx,
} from '../workflow/workflowHumanOwnerService.js';
import {
  createRegisteredWorkflowSystemActor,
  workflowRuntimeRegistryV2,
} from '../workflow/workflowRuntimeRegistry.js';
import { sha256ClinicalJson } from './diagnosticClassification.js';
import { hasValidDiagnosticCriticalAcknowledgementReceipt } from './diagnosticCriticalAcknowledgementEvidence.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const DISPOSITIONS = new Set(['treated', 'repeated', 'referred', 'no_action']);
const DIAGNOSTIC_ACTION_ATTESTATION =
  'I attest that I reviewed this complete signed diagnostic generation and recorded the stated clinical disposition.';

function requireUuid(value, field) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(text)) {
    throw AppError.badRequest(`${field} must be a UUID`, 'DIAGNOSTIC_ACTION_INPUT_INVALID');
  }
  return text;
}

function requireIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!isValidIdempotencyKey(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'DIAGNOSTIC_ACTION_IDEMPOTENCY_KEY_INVALID',
    );
  }
  return key;
}

function requireText(value, field, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength) {
    throw AppError.badRequest(
      `${field} is required and must be at most ${maxLength} characters`,
      'DIAGNOSTIC_ACTION_INPUT_INVALID',
    );
  }
  return text;
}

function normalizeActorInput(context = {}) {
  const primaryRole = String(context.actorRole || '').trim().toUpperCase();
  const roles = [...new Set((Array.isArray(context.actorRoles)
    ? context.actorRoles
    : [context.actorRoles])
    .map((role) => String(role || '').trim().toUpperCase())
    .filter(Boolean))];
  if (primaryRole && !roles.includes(primaryRole)) roles.unshift(primaryRole);
  return {
    actorUid: context.actorUid,
    authenticatedRoles: roles,
    authenticatedPrimaryRole: primaryRole || roles[0] || null,
    authenticatedRawRole: context.actorRawRole || context.actorRole || null,
  };
}

function pathwayActor(actor, context = {}) {
  return Object.freeze({
    kind: 'user',
    uid: actor.uid,
    roles: Object.freeze([actor.role]),
    primaryRole: actor.role,
    rawRole: actor.rawRole,
    authorizationMode: 'diagnostic_result_owner',
    ...(context.breakGlassId ? { breakGlassId: context.breakGlassId } : {}),
  });
}

function normalizeDispositionInput(input = {}) {
  const disposition = String(input.disposition || '').trim().toLowerCase();
  if (!DISPOSITIONS.has(disposition)) {
    throw AppError.badRequest(
      'disposition must be treated|repeated|referred|no_action',
      'DIAGNOSTIC_ACTION_DISPOSITION_INVALID',
    );
  }
  const clinicalNote = requireText(input.clinicalNote, 'clinical_note', 8000);
  const reason = input.reason == null ? null : requireText(input.reason, 'reason', 4000);
  const downstream = input.downstreamEvidence ?? null;
  if (disposition === 'no_action') {
    if (!reason) {
      throw AppError.badRequest(
        'reason is required for no_action',
        'DIAGNOSTIC_ACTION_REASON_REQUIRED',
      );
    }
    if (downstream != null) {
      throw AppError.badRequest(
        'no_action cannot cite downstream treatment evidence',
        'DIAGNOSTIC_ACTION_EVIDENCE_INVALID',
      );
    }
    return { disposition, clinicalNote, reason, downstream: null };
  }
  if (!downstream || typeof downstream !== 'object' || Array.isArray(downstream)) {
    throw AppError.badRequest(
      'typed downstream evidence is required for this disposition',
      'DIAGNOSTIC_ACTION_EVIDENCE_REQUIRED',
    );
  }
  const resourceType = String(downstream.resource_type || '').trim().toLowerCase();
  const resourceId = String(downstream.resource_id || '').trim();
  if (!RESOURCE_TYPE_PATTERN.test(resourceType) || !resourceId || resourceId.length > 160) {
    throw AppError.badRequest(
      'downstream evidence resource_type/resource_id is invalid',
      'DIAGNOSTIC_ACTION_EVIDENCE_INVALID',
    );
  }
  return {
    disposition,
    clinicalNote,
    reason,
    downstream: { resourceType, resourceId },
  };
}

async function assertCanonicalDownstreamEvidenceTx(tx, tenantId, patientUid, downstream) {
  if (!downstream) return;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND resource_type = $3::text
        AND resource_id = $4::text
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
      FOR SHARE`,
    tenantId,
    patientUid,
    downstream.resourceType,
    downstream.resourceId,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Downstream clinical evidence is not canonically linked to this patient',
      'DIAGNOSTIC_ACTION_EVIDENCE_UNVERIFIED',
    );
  }
}

async function loadDoctorActionContextTx(tx, tenantId, generationId, taskId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT generation.id AS generation_id,
            generation.patient_uid,
            generation.classification,
            generation.snapshot_sha256,
            generation.ordering_owner_uid,
            generation.owner_source,
            generation.critical_acknowledgement_task_id,
            generation.critical_acknowledgement_sla_id,
            acknowledgement_task.status AS critical_ack_task_status,
            acknowledgement_task.metadata AS critical_ack_task_metadata,
            acknowledgement_task.assigned_to_uid AS critical_ack_assigned_to_uid,
            acknowledgement_task.assigned_to_role AS critical_ack_assigned_to_role,
            acknowledgement_sla.status AS critical_ack_sla_status,
            acknowledgement_sla.completed_at AS critical_ack_sla_completed_at,
            pathway.id AS pathway_instance_id,
            pathway.workflow_run_id,
            pathway.owning_clinician_uid,
            pathway.accountable_role,
            pathway.clinical_status,
            pathway.metadata AS pathway_metadata,
            step.id AS workflow_step_id,
            step.step_key,
            task.id AS task_id,
            task.status AS task_status,
            task.assigned_to_uid,
            task.assigned_to_role,
            task.sla_completion_semantics,
            task.workflow_sla_instance_id,
            EXISTS (
              SELECT 1
                FROM diagnostic_result_generations AS successor
               WHERE successor.tenant_id = generation.tenant_id
                 AND successor.predecessor_generation_id = generation.id
            ) AS has_successor
       FROM tasks AS task
       JOIN workflow_steps AS step
         ON step.tenant_id = task.tenant_id
        AND step.id = task.workflow_step_id
        AND step.workflow_run_id = task.workflow_run_id
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = task.tenant_id
        AND pathway.workflow_run_id = task.workflow_run_id
       JOIN diagnostic_result_generations AS generation
         ON generation.tenant_id = pathway.tenant_id
        AND generation.id::text = pathway.source_episode_id
        AND pathway.source_episode_type = 'diagnostic_result_generation'
       LEFT JOIN tasks AS acknowledgement_task
         ON acknowledgement_task.tenant_id = generation.tenant_id
        AND acknowledgement_task.id = generation.critical_acknowledgement_task_id
       LEFT JOIN workflow_sla_instances AS acknowledgement_sla
         ON acknowledgement_sla.tenant_id = generation.tenant_id
        AND acknowledgement_sla.id = generation.critical_acknowledgement_sla_id
      WHERE task.tenant_id = $1::uuid
        AND task.id = $2::bigint
        AND generation.id = $3::uuid
        AND pathway.pathway_key = $4::text
      LIMIT 1
      FOR UPDATE OF task, pathway, generation`,
    tenantId,
    taskId,
    generationId,
    CARE_PATHWAY_KEYS.DIAGNOSTICS,
  );
  return rows[0] || null;
}

function assertDoctorActionAuthorization(row, actor) {
  if (!row) {
    throw AppError.forbidden('Not authorized to record this diagnostic action');
  }
  const namedOwner = String(row.owning_clinician_uid || '').toLowerCase();
  const assignedUid = String(row.assigned_to_uid || '').toLowerCase();
  if (namedOwner) {
    if (namedOwner !== actor.uid) {
      throw AppError.forbidden('Not authorized to record this diagnostic action');
    }
    return;
  }
  if (assignedUid !== actor.uid || row.assigned_to_role != null) {
    throw AppError.forbidden('Not authorized to record this diagnostic action');
  }
}

async function findActionByIdempotencyTx(tx, tenantId, key) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM diagnostic_result_actions
      WHERE tenant_id = $1::uuid
        AND idempotency_key = $2::text
      LIMIT 1`,
    tenantId,
    key,
  );
  return rows[0] || null;
}

function actionReceipt(action, { replayed, execution = null } = {}) {
  return Object.freeze({
    id: String(action.id),
    generation_id: String(action.generation_id),
    pathway_instance_id: action.pathway_instance_id
      ? String(action.pathway_instance_id)
      : null,
    task_id: action.task_id == null ? null : Number(action.task_id),
    action_kind: action.action_kind,
    disposition: action.disposition,
    signature_id: action.signature_id ? String(action.signature_id) : null,
    request_sha256: action.request_sha256,
    replayed,
    ...(execution ? { pathway: execution } : {}),
  });
}

async function requireActiveModeTx(tx, tenantId, activationEvidenceCapability) {
  const mode = await resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
  });
  if (mode !== PATHWAY_MODES.ACTIVE) {
    throw AppError.conflict(
      'Diagnostics pathway is not active',
      'DIAGNOSTIC_PATHWAY_NOT_ACTIVE',
    );
  }
  if (!activationEvidenceCapability) {
    throw AppError.conflict(
      'Diagnostics pathway activation evidence is unavailable',
      'DIAGNOSTIC_PATHWAY_ACTIVATION_EVIDENCE_REQUIRED',
    );
  }
}

export async function recordDoctorDiagnosticDisposition(input = {}, context = {}) {
  const tenantId = requireTenantId(input.tenantId);
  const generationId = requireUuid(input.generationId, 'generation_id');
  const taskId = Number(input.taskId);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw AppError.badRequest('task_id must be a positive integer', 'DIAGNOSTIC_ACTION_INPUT_INVALID');
  }
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (input.attested !== true) {
    throw AppError.badRequest(
      'Explicit electronic attestation is required',
      'DIAGNOSTIC_ACTION_ATTESTATION_REQUIRED',
    );
  }
  const attestedHash = requireText(
    input.generationSnapshotSha256,
    'generation_snapshot_sha256',
    64,
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(attestedHash)) {
    throw AppError.badRequest(
      'generation_snapshot_sha256 must be a SHA-256 hash',
      'DIAGNOSTIC_ACTION_INPUT_INVALID',
    );
  }
  const normalized = normalizeDispositionInput(input);
  const requestSha256 = sha256ClinicalJson({
    generation_id: generationId,
    task_id: taskId,
    disposition: normalized.disposition,
    clinical_note: normalized.clinicalNote,
    reason: normalized.reason,
    generation_snapshot_sha256: attestedHash,
    downstream_resource_type: normalized.downstream?.resourceType || null,
    downstream_resource_id: normalized.downstream?.resourceId || null,
    attestation: DIAGNOSTIC_ACTION_ATTESTATION,
  });

  return setTenantTx(tenantId, async (tx) => {
    const actor = await resolveCurrentHumanActorTx({
      tx,
      tenantId,
      ...normalizeActorInput(context),
      rolePredicate: isPathwayNamedClinicalOwnerRole,
    });
    const row = await loadDoctorActionContextTx(tx, tenantId, generationId, taskId);
    assertDoctorActionAuthorization(row, actor);
    if (
      row?.classification === 'critical'
      && row.critical_acknowledgement_task_id != null
      && !hasValidDiagnosticCriticalAcknowledgementReceipt({
        taskStatus: row.critical_ack_task_status,
        slaCompletedAt: row.critical_ack_sla_completed_at,
        taskMetadata: row.critical_ack_task_metadata,
        assignedToUid: row.critical_ack_assigned_to_uid,
        assignedToRole: row.critical_ack_assigned_to_role,
      })
    ) {
      throw AppError.conflict(
        'Critical result must be acknowledged before the doctor action is recorded',
        'DIAGNOSTIC_CRITICAL_ACK_REQUIRED',
      );
    }

    const existing = await findActionByIdempotencyTx(tx, tenantId, idempotencyKey);
    if (existing) {
      if (
        existing.action_kind !== 'doctor_disposition'
        || String(existing.generation_id) !== generationId
        || Number(existing.task_id) !== taskId
        || existing.request_sha256 !== requestSha256
      ) {
        throw AppError.conflict(
          'Diagnostic action idempotency key was reused with different content',
          'DIAGNOSTIC_ACTION_IDEMPOTENCY_CONFLICT',
        );
      }
      await settlePendingResultOwnerActionsForDiagnosticActionTx({
        tx,
        tenantId,
        diagnosticActionId: existing.id,
      });
      return actionReceipt(existing, { replayed: true });
    }

    await requireActiveModeTx(tx, tenantId, input.activationEvidenceCapability);
    const reopenedNormal = row.classification === 'normal'
      && Boolean(row.pathway_metadata?.reopened_action_id);
    if (
      row.has_successor
      || !['active', 'on_hold'].includes(row.clinical_status)
      || row.step_key !== 'record_doctor_action'
      || !['open', 'in_progress', 'blocked', 'overdue'].includes(row.task_status)
      || row.sla_completion_semantics !== 'domain_evidence'
      || !row.workflow_sla_instance_id
      || (!['critical', 'abnormal', 'indeterminate'].includes(row.classification)
        && !reopenedNormal)
    ) {
      throw AppError.conflict(
        'Diagnostic action obligation is not current and actionable',
        'DIAGNOSTIC_ACTION_NOT_ACTIONABLE',
      );
    }
    if (row.snapshot_sha256 !== attestedHash) {
      throw AppError.conflict(
        'Attested diagnostic generation hash is stale',
        'DIAGNOSTIC_ACTION_GENERATION_STALE',
      );
    }
    await assertCanonicalDownstreamEvidenceTx(
      tx,
      tenantId,
      row.patient_uid,
      normalized.downstream,
    );

    const actionId = randomUUID();
    const signatureId = randomUUID();
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: row.patient_uid,
      eventType: 'diagnostic.result.action_recorded',
      eventSubtype: 'doctor_disposition',
      eventStatus: normalized.disposition,
      sourceTable: 'diagnostic_result_actions',
      sourceId: actionId,
      resourceType: 'diagnostic_result_action',
      resourceTable: 'diagnostic_result_actions',
      resourceId: actionId,
      actorUid: actor.uid,
      actorRole: actor.rawRole,
      visibleToPatient: false,
      summary: 'Doctor recorded diagnostic result action',
      payload: {
        action_id: actionId,
        generation_id: generationId,
        disposition: normalized.disposition,
        signature_id: signatureId,
      },
      afterState: {
        disposition: normalized.disposition,
        generation_snapshot_sha256: attestedHash,
        request_sha256: requestSha256,
      },
      tags: ['diagnostics', 'doctor_action', 'signature'],
      timelineIdempotencyKey: `diagnostic_result_actions:${actionId}:action_recorded`,
      auditIdempotencyKey: `diagnostic_result_actions:${actionId}:audit:action_recorded`,
    }, { db: tx });
    if (!canonical?.timeline?.id || !canonical?.audit?.id) {
      throw AppError.internal(
        'Diagnostic action canonical evidence is unavailable',
        'DIAGNOSTIC_ACTION_CANONICAL_EVIDENCE_REQUIRED',
      );
    }

    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO diagnostic_result_actions
         (id, tenant_id, patient_uid, generation_id, pathway_instance_id,
          task_id, action_kind, disposition, clinical_note, reason,
          generation_snapshot_sha256, actor_uid, actor_role,
          downstream_resource_type, downstream_resource_id,
          idempotency_key, request_sha256, signature_id,
          canonical_timeline_event_id, canonical_audit_event_id)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::bigint, 'doctor_disposition', $7::text, $8::text, $9::text,
          $10::text, $11::uuid, $12::text,
          $13::text, $14::text,
          $15::text, $16::text, $17::uuid, $18::uuid, $19::uuid)
       RETURNING *`,
      actionId,
      tenantId,
      row.patient_uid,
      generationId,
      row.pathway_instance_id,
      taskId,
      normalized.disposition,
      normalized.clinicalNote,
      normalized.reason,
      attestedHash,
      actor.uid,
      actor.rawRole,
      normalized.downstream?.resourceType || null,
      normalized.downstream?.resourceId || null,
      idempotencyKey,
      requestSha256,
      signatureId,
      canonical.timeline.id,
      canonical.audit.id,
    );
    await signDocumentTx({
      documentType: 'diagnostic_result_action',
      documentId: actionId,
      statement: DIAGNOSTIC_ACTION_ATTESTATION,
      signatureId,
      canonicalAuditEventId: canonical.audit.id,
    }, {
      actorUid: actor.uid,
      actorRole: actor.rawRole,
      actorName: context.actorName || null,
    }, { tx });

    const effectiveActor = pathwayActor(actor, context);
    const execution = await completePathwayTaskAndExecuteFromRegisteredEvidence({
      tenantId,
      pathwayInstanceId: String(row.pathway_instance_id),
      taskId,
      workflowRunId: Number(row.workflow_run_id),
      workflowStepId: Number(row.workflow_step_id),
      conditionHandler: 'diagnostics.doctor_action.v1',
      idempotencyKey: `diagnostic-action:${idempotencyKey}`,
      evidence: {
        diagnostic_action_id: actionId,
        diagnostic_generation_id: generationId,
        generation_snapshot_sha256: attestedHash,
        disposition: normalized.disposition,
        signature_id: signatureId,
        request_sha256: requestSha256,
      },
      signal: {
        kind: 'diagnostic_doctor_action_recorded',
        payload: { diagnostic_action_id: actionId, diagnostic_generation_id: generationId },
      },
      actor: effectiveActor,
      registry: workflowRuntimeRegistryV2,
      activationEvidenceCapability: input.activationEvidenceCapability,
      tx,
    });
    const event = await publishEvent({
      eventType: 'diagnostic.result.action_recorded',
      aggregateType: 'diagnostic_result_generation',
      aggregateId: generationId,
      patientUid: row.patient_uid,
      tenantId,
      tx,
      payload: {
        generation_id: generationId,
        action_id: actionId,
        pathway_instance_id: String(row.pathway_instance_id),
        disposition: normalized.disposition,
        signature_id: signatureId,
      },
    });
    if (!event?.id) {
      throw AppError.internal(
        'Diagnostic action event could not be published',
        'DIAGNOSTIC_ACTION_EVENT_REQUIRED',
      );
    }
    await settlePendingResultOwnerActionsForDiagnosticActionTx({
      tx,
      tenantId,
      diagnosticActionId: actionId,
    });
    return actionReceipt(inserted[0], {
      replayed: false,
      execution: {
        clinical_status: execution.instance?.clinical_status,
        replayed: execution.replayed === true,
      },
    });
  });
}

async function loadNormalClosureContextTx(tx, tenantId, generationId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT generation.*,
            pathway.id AS pathway_instance_id,
            pathway.workflow_run_id,
            pathway.clinical_status,
            run.current_step_key,
            EXISTS (
              SELECT 1
                FROM diagnostic_result_generations AS successor
               WHERE successor.tenant_id = generation.tenant_id
                 AND successor.predecessor_generation_id = generation.id
            ) AS has_successor
       FROM diagnostic_result_generations AS generation
       LEFT JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = generation.tenant_id
        AND pathway.pathway_key = $3::text
        AND pathway.source_episode_type = 'diagnostic_result_generation'
        AND pathway.source_episode_id = generation.id::text
        AND pathway.clinical_status IN ('planned', 'active', 'on_hold')
       LEFT JOIN workflow_runs AS run
         ON run.tenant_id = pathway.tenant_id
        AND run.id = pathway.workflow_run_id
      WHERE generation.tenant_id = $1::uuid
        AND generation.id = $2::uuid
      LIMIT 1
      FOR UPDATE OF generation`,
    tenantId,
    generationId,
    CARE_PATHWAY_KEYS.DIAGNOSTICS,
  );
  return rows[0] || null;
}

export async function closeNormalDiagnosticGenerationIfEligible(input = {}) {
  const tenantId = requireTenantId(input.tenantId);
  const generationId = requireUuid(input.generationId, 'generation_id');
  const idempotencyKey = `diagnostic-normal-close:${generationId}`;
  return setTenantTx(tenantId, async (tx) => {
    const row = await loadNormalClosureContextTx(tx, tenantId, generationId);
    if (!row) {
      throw AppError.notFound('Diagnostic generation not found', 'DIAGNOSTIC_GENERATION_NOT_FOUND');
    }
    const existing = await tx.$queryRawUnsafe(
      `SELECT *
         FROM diagnostic_result_actions
        WHERE tenant_id = $1::uuid
          AND generation_id = $2::uuid
          AND action_kind = 'normal_auto_closed'
        LIMIT 1`,
      tenantId,
      generationId,
    );
    if (existing[0]) {
      await settlePendingResultOwnerActionsForDiagnosticActionTx({
        tx,
        tenantId,
        diagnosticActionId: existing[0].id,
      });
      return actionReceipt(existing[0], { replayed: true });
    }

    const mode = await resolvePathwayModeTx({
      tx,
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
    });
    if (mode !== PATHWAY_MODES.ACTIVE) {
      return Object.freeze({
        generation_id: generationId,
        closed: false,
        outcome: 'pathway_not_active',
        pathway_mode: mode,
      });
    }
    await requireActiveModeTx(tx, tenantId, input.activationEvidenceCapability);
    if (
      row.classification !== 'normal'
      || row.has_successor
      || !row.pathway_instance_id
      || !['active', 'on_hold'].includes(row.clinical_status)
      || row.current_step_key !== 'await_normal_release_closure'
    ) {
      throw AppError.conflict(
        'Normal diagnostic generation is not awaiting release closure',
        'DIAGNOSTIC_NORMAL_CLOSE_NOT_ACTIONABLE',
      );
    }
    const releaseDecision = await getDiagnosticGenerationReleaseDecisionTx({
      tx,
      tenantId,
      generationId,
    });
    if (releaseDecision.outcome !== 'visible') {
      return Object.freeze({
        generation_id: generationId,
        closed: false,
        outcome: releaseDecision.outcome,
        release_decision: releaseDecision,
      });
    }
    const requestSha256 = sha256ClinicalJson({
      generation_id: generationId,
      generation_snapshot_sha256: row.snapshot_sha256,
      action_kind: 'normal_auto_closed',
      release_decision: releaseDecision,
    });
    const actionId = randomUUID();
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: row.patient_uid,
      eventType: 'diagnostic.result.normal_auto_closed',
      eventSubtype: 'release_eligible',
      eventStatus: 'closed',
      sourceTable: 'diagnostic_result_actions',
      sourceId: actionId,
      resourceType: 'diagnostic_result_action',
      resourceTable: 'diagnostic_result_actions',
      resourceId: actionId,
      visibleToPatient: false,
      summary: 'Normal diagnostic result loop auto-closed after release eligibility',
      payload: { action_id: actionId, generation_id: generationId },
      afterState: {
        generation_snapshot_sha256: row.snapshot_sha256,
        release_decision: releaseDecision,
        request_sha256: requestSha256,
      },
      tags: ['diagnostics', 'normal_result', 'auto_close'],
      timelineIdempotencyKey: `diagnostic_result_actions:${actionId}:normal_auto_closed`,
      auditIdempotencyKey: `diagnostic_result_actions:${actionId}:audit:normal_auto_closed`,
    }, { db: tx });
    if (!canonical?.timeline?.id || !canonical?.audit?.id) {
      throw AppError.internal(
        'Normal diagnostic closure canonical evidence is unavailable',
        'DIAGNOSTIC_ACTION_CANONICAL_EVIDENCE_REQUIRED',
      );
    }
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO diagnostic_result_actions
         (id, tenant_id, patient_uid, generation_id, pathway_instance_id,
          action_kind, generation_snapshot_sha256, idempotency_key,
          request_sha256, release_decision,
          canonical_timeline_event_id, canonical_audit_event_id)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          'normal_auto_closed', $6::text, $7::text, $8::text, $9::jsonb,
          $10::uuid, $11::uuid)
       RETURNING *`,
      actionId,
      tenantId,
      row.patient_uid,
      generationId,
      row.pathway_instance_id,
      row.snapshot_sha256,
      idempotencyKey,
      requestSha256,
      JSON.stringify(releaseDecision),
      canonical.timeline.id,
      canonical.audit.id,
    );
    const event = await publishEvent({
      eventType: 'diagnostic.result.normal_auto_closed',
      aggregateType: 'diagnostic_result_generation',
      aggregateId: generationId,
      patientUid: row.patient_uid,
      tenantId,
      tx,
      payload: {
        generation_id: generationId,
        action_id: actionId,
        pathway_instance_id: String(row.pathway_instance_id),
      },
    });
    if (!event?.id) {
      throw AppError.internal(
        'Normal diagnostic closure event could not be published',
        'DIAGNOSTIC_ACTION_EVENT_REQUIRED',
      );
    }
    const actor = createRegisteredWorkflowSystemActor({
      registry: workflowRuntimeRegistryV2,
      systemKey: 'diagnostics.pathway_projector.v1',
      sourceEventId: event.id,
      causationId: `diagnostic_result_action:${actionId}`,
      signalContext: {
        sourceResourceType: 'event_outbox',
        sourceResourceId: String(event.id),
        occurredAt: new Date(event.created_at).toISOString(),
      },
    });
    const execution = await executePathwayCommand({
      tenantId,
      pathwayInstanceId: String(row.pathway_instance_id),
      idempotencyKey: `diagnostic-normal-close:${generationId}`,
      signal: {
        kind: 'diagnostic_normal_release_eligible',
        payload: { diagnostic_action_id: actionId, diagnostic_generation_id: generationId },
      },
      actor,
      registry: workflowRuntimeRegistryV2,
      activationEvidenceCapability: input.activationEvidenceCapability,
      tx,
    });
    await settlePendingResultOwnerActionsForDiagnosticActionTx({
      tx,
      tenantId,
      diagnosticActionId: actionId,
    });
    return actionReceipt(inserted[0], {
      replayed: false,
      execution: {
        clinical_status: execution.instance?.clinical_status,
        replayed: execution.replayed === true,
      },
    });
  });
}

export async function reopenNormalDiagnosticGeneration(input = {}, context = {}) {
  const tenantId = requireTenantId(input.tenantId);
  const generationId = requireUuid(input.generationId, 'generation_id');
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const reason = requireText(input.reason, 'reason', 4000);
  const requestSha256 = sha256ClinicalJson({
    generation_id: generationId,
    action_kind: 'doctor_reopened',
    reason,
  });
  return setTenantTx(tenantId, async (tx) => {
    const actor = await resolveCurrentHumanActorTx({
      tx,
      tenantId,
      ...normalizeActorInput(context),
      rolePredicate: isPathwayNamedClinicalOwnerRole,
    });
    const rows = await tx.$queryRawUnsafe(
      `SELECT generation.id AS generation_id,
              generation.patient_uid,
              generation.classification,
              generation.snapshot_sha256,
              pathway.id AS pathway_instance_id,
              pathway.owning_clinician_uid,
              pathway.clinical_status,
              closure.id AS closure_action_id,
              EXISTS (
                SELECT 1
                  FROM diagnostic_result_actions AS prior_reopen
                 WHERE prior_reopen.tenant_id = generation.tenant_id
                   AND prior_reopen.generation_id = generation.id
                   AND prior_reopen.action_kind = 'doctor_reopened'
              ) AS already_reopened,
              EXISTS (
                SELECT 1
                  FROM diagnostic_result_generations AS successor
                 WHERE successor.tenant_id = generation.tenant_id
                   AND successor.predecessor_generation_id = generation.id
              ) AS has_successor
         FROM diagnostic_result_generations AS generation
         JOIN diagnostic_result_actions AS closure
           ON closure.tenant_id = generation.tenant_id
          AND closure.generation_id = generation.id
          AND closure.action_kind = 'normal_auto_closed'
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = closure.tenant_id
          AND pathway.id = closure.pathway_instance_id
        WHERE generation.tenant_id = $1::uuid
          AND generation.id = $2::uuid
        LIMIT 1
        FOR UPDATE OF generation, pathway`,
      tenantId,
      generationId,
    );
    const row = rows[0] || null;
    if (!row || String(row.owning_clinician_uid || '').toLowerCase() !== actor.uid) {
      throw AppError.forbidden('Not authorized to reopen this diagnostic result');
    }
    const existing = await findActionByIdempotencyTx(tx, tenantId, idempotencyKey);
    if (existing) {
      if (
        existing.action_kind !== 'doctor_reopened'
        || String(existing.generation_id) !== generationId
        || existing.request_sha256 !== requestSha256
      ) {
        throw AppError.conflict(
          'Diagnostic action idempotency key was reused with different content',
          'DIAGNOSTIC_ACTION_IDEMPOTENCY_CONFLICT',
        );
      }
      await rearmPendingResultOwnerActionsForDiagnosticReopenTx({
        tx,
        tenantId,
        generationId,
        doctorReopenedActionId: existing.id,
      });
      return actionReceipt(existing, { replayed: true });
    }
    await requireActiveModeTx(tx, tenantId, input.activationEvidenceCapability);
    if (
      row.classification !== 'normal'
      || row.has_successor
      || row.already_reopened
      || row.clinical_status !== 'completed'
    ) {
      throw AppError.conflict(
        'Normal diagnostic generation cannot be reopened in its current state',
        'DIAGNOSTIC_REOPEN_NOT_ACTIONABLE',
      );
    }
    const actionId = randomUUID();
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: row.patient_uid,
      eventType: 'diagnostic.result.reopened',
      eventSubtype: 'doctor_review',
      eventStatus: 'reopened',
      sourceTable: 'diagnostic_result_actions',
      sourceId: actionId,
      resourceType: 'diagnostic_result_action',
      resourceTable: 'diagnostic_result_actions',
      resourceId: actionId,
      actorUid: actor.uid,
      actorRole: actor.rawRole,
      visibleToPatient: false,
      summary: 'Doctor reopened a normal diagnostic result for review',
      payload: { action_id: actionId, generation_id: generationId },
      afterState: { request_sha256: requestSha256 },
      metadata: { reason },
      tags: ['diagnostics', 'normal_result', 'doctor_reopen'],
      timelineIdempotencyKey: `diagnostic_result_actions:${actionId}:doctor_reopened`,
      auditIdempotencyKey: `diagnostic_result_actions:${actionId}:audit:doctor_reopened`,
    }, { db: tx });
    if (!canonical?.timeline?.id || !canonical?.audit?.id) {
      throw AppError.internal(
        'Diagnostic reopen canonical evidence is unavailable',
        'DIAGNOSTIC_ACTION_CANONICAL_EVIDENCE_REQUIRED',
      );
    }
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO diagnostic_result_actions
         (id, tenant_id, patient_uid, generation_id, pathway_instance_id,
          action_kind, reason, generation_snapshot_sha256, actor_uid, actor_role,
          idempotency_key, request_sha256, predecessor_action_id,
          canonical_timeline_event_id, canonical_audit_event_id)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          'doctor_reopened', $6::text, $7::text, $8::uuid, $9::text,
          $10::text, $11::text, $12::uuid, $13::uuid, $14::uuid)
       RETURNING *`,
      actionId,
      tenantId,
      row.patient_uid,
      generationId,
      row.pathway_instance_id,
      reason,
      row.snapshot_sha256,
      actor.uid,
      actor.rawRole,
      idempotencyKey,
      requestSha256,
      row.closure_action_id,
      canonical.timeline.id,
      canonical.audit.id,
    );
    const payload = {
      generation_id: generationId,
      action_id: actionId,
      prior_pathway_instance_id: String(row.pathway_instance_id),
    };
    const event = await publishEvent({
      eventType: 'diagnostic.result.reopened',
      aggregateType: 'diagnostic_result_generation',
      aggregateId: generationId,
      patientUid: row.patient_uid,
      tenantId,
      tx,
      payload,
    });
    if (!event?.id) {
      throw AppError.internal(
        'Diagnostic reopen event could not be published',
        'DIAGNOSTIC_ACTION_EVENT_REQUIRED',
      );
    }
    const projection = await projectDiagnosticPathwayEvent({
      tx,
      consumerKey: 'care_pathway_projector',
      generation: 2,
      tenantId,
      event: Object.freeze({ ...event, payload }),
      registry: workflowRuntimeRegistryV2,
      activationEvidenceCapability: input.activationEvidenceCapability,
    });
    await rearmPendingResultOwnerActionsForDiagnosticReopenTx({
      tx,
      tenantId,
      generationId,
      doctorReopenedActionId: actionId,
    });
    return actionReceipt(inserted[0], {
      replayed: false,
      execution: {
        pathway_instance_id: projection.pathway_instance_id,
        replayed: projection.pathway_replayed === true,
      },
    });
  });
}

export default {
  recordDoctorDiagnosticDisposition,
  closeNormalDiagnosticGenerationIfEligible,
  reopenNormalDiagnosticGeneration,
};
