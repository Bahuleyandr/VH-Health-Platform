import { AppError } from '../../utils/AppError.js';
import {
  loadValidatedOpChildProjectionTx,
  OP_CHILD_RESOURCE_EVENT_TYPE,
} from '../appointment/opChildResourceEventService.js';
import {
  createRegisteredWorkflowSystemActor,
  workflowRuntimeRegistryV4,
} from '../workflow/workflowRuntimeRegistry.js';
import {
  appendPathwayResourceReferenceTx,
  supersedePathwayResourceReferenceTx,
} from './carePathwayResourceReferenceService.js';
import { compileOpContactToRecoveryDefinition } from './opPathwayDefinition.js';
import {
  completePathwayTaskAndExecuteFromRegisteredCondition,
  executePathwayCommand,
  startCarePathwayInstance,
} from './pathwayExecutorService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from './pathwayMode.js';
import { resolvePathwayModeTx } from './pathwayRuntimePersistence.js';

export const OP_PATHWAY_EVENT_TYPES = Object.freeze([
  'appointment.created',
  'appointment.confirmed',
  'appointment.checked_in',
  'appointment.in_progress',
  'appointment.completed',
  'appointment.cancelled',
  'appointment.no_show',
  'appointment.rescheduled',
  'appointment.admission_advised',
  'appointment.follow_up_recorded',
  'appointment.closure_evidence_recorded',
  OP_CHILD_RESOURCE_EVENT_TYPE,
]);

const OP_RECOVERY_STEP_KEY = 'recover_unattended_visit';
const OP_RECOVERY_CONDITION_HANDLER = 'op.recovery_action.v1';
const OP_RECOVERY_APPOINTMENT_STATUSES = new Set([
  'CANCELLED',
  'NO_SHOW',
  'RESCHEDULED',
]);

function positiveId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function loadAppointmentTx(tx, tenantId, event) {
  const aggregateId = positiveId(event.aggregate_id);
  const payloadId = positiveId(event.payload?.appointment_id);
  if (
    event.aggregate_type !== 'appointment'
    || !aggregateId
    || aggregateId !== payloadId
  ) {
    throw AppError.conflict(
      'OP projector event identity is inconsistent',
      'OP_PROJECTOR_EVENT_IDENTITY_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT appointment.id,
            appointment.uid,
            UPPER(BTRIM(appointment.status)) AS status,
            patient.uid AS patient_uid,
            doctor.uid AS clinician_uid,
            encounter.id AS encounter_id,
            closure.id AS closure_evidence_id,
            closure.evidence_revision AS closure_evidence_revision,
            closure.closure_basis,
            closure.accepted_handoff_id,
            closure.source_status_history_id,
            closure.canonical_timeline_event_id AS closure_timeline_event_id,
            closure.canonical_audit_event_id AS closure_audit_event_id
       FROM appointments AS appointment
       JOIN users AS patient
         ON patient.tenant_id = appointment.tenant_id
        AND patient.id = appointment.patient_id
       LEFT JOIN users AS doctor
         ON doctor.tenant_id = appointment.tenant_id
        AND doctor.id = appointment.doctor_id
       LEFT JOIN patient_encounters AS encounter
         ON encounter.tenant_id = appointment.tenant_id
        AND encounter.appointment_id = appointment.id
        AND encounter.patient_uid = patient.uid
       LEFT JOIN LATERAL (
         SELECT evidence.id,
                evidence.evidence_revision,
                evidence.closure_basis,
                evidence.accepted_handoff_id,
                evidence.source_status_history_id,
                evidence.canonical_timeline_event_id,
                evidence.canonical_audit_event_id
           FROM op_visit_closure_evidence AS evidence
          WHERE evidence.tenant_id = appointment.tenant_id
            AND evidence.appointment_id = appointment.id
            AND evidence.patient_uid = patient.uid
          ORDER BY evidence.evidence_revision DESC, evidence.recorded_at DESC
          LIMIT 1
       ) AS closure ON TRUE
      WHERE appointment.tenant_id = $1::uuid
        AND appointment.id = $2::integer
      LIMIT 1
      FOR SHARE OF appointment, patient`,
    tenantId,
    aggregateId,
  );
  const appointment = rows[0];
  if (!appointment) {
    throw AppError.conflict(
      'OP projector appointment is unavailable',
      'OP_PROJECTOR_APPOINTMENT_MISSING',
    );
  }
  const eventPatientUid = String(event.patient_uid || '').toLowerCase();
  const payloadPatientUid = String(event.payload?.patient_uid || '').toLowerCase();
  const patientUid = String(appointment.patient_uid || '').toLowerCase();
  if (
    !patientUid
    || eventPatientUid !== patientUid
    || payloadPatientUid !== patientUid
  ) {
    throw AppError.conflict(
      'OP projector patient identity is inconsistent',
      'OP_PROJECTOR_PATIENT_IDENTITY_INVALID',
    );
  }
  return appointment;
}

function currentRecoveryTask(execution) {
  const instance = execution?.instance;
  if (instance?.run?.current_step_key !== OP_RECOVERY_STEP_KEY) return null;
  const step = instance.steps?.find((candidate) => candidate.step_key === OP_RECOVERY_STEP_KEY);
  const tasks = step
    ? instance.tasks?.filter(
      (task) => Number(task.workflow_step_id) === Number(step.id),
    ) || []
    : [];
  if (!step || tasks.length !== 1) {
    throw AppError.conflict(
      'OP recovery task runtime is incomplete or ambiguous',
      'OP_RECOVERY_TASK_CONTEXT_INVALID',
    );
  }
  const task = tasks[0];
  if (
    Number(instance.run.id) !== Number(task.workflow_run_id)
    || task.sla_completion_semantics !== 'none'
    || task.workflow_sla_instance_id
    || task.related_resource_type !== 'care_pathway_instance'
    || String(task.related_resource_id) !== String(instance.id)
  ) {
    throw AppError.conflict(
      'OP recovery task does not match its governed no-SLA contract',
      'OP_RECOVERY_TASK_CONTRACT_INVALID',
    );
  }
  return Object.freeze({
    taskId: Number(task.id),
    workflowRunId: Number(instance.run.id),
    workflowStepId: Number(step.id),
  });
}

export async function completeOpRecoveryTaskFromClosureEvidence({
  tenantId,
  appointment,
  event,
  execution,
  actor,
  registry,
  signal,
  activationEvidenceCapability = null,
  tx,
} = {}) {
  if (event?.event_type !== 'appointment.closure_evidence_recorded') return execution;
  const recoveryTask = currentRecoveryTask(execution);
  if (!recoveryTask) return execution;
  if (
    !OP_RECOVERY_APPOINTMENT_STATUSES.has(appointment?.status)
    || !appointment.closure_evidence_id
    || !positiveId(appointment.closure_evidence_revision)
    || !appointment.closure_timeline_event_id
    || !appointment.closure_audit_event_id
    || !appointment.source_status_history_id
  ) {
    throw AppError.conflict(
      'Canonical OP recovery closure evidence is incomplete',
      'OP_RECOVERY_CLOSURE_EVIDENCE_INVALID',
    );
  }
  return completePathwayTaskAndExecuteFromRegisteredCondition({
    tenantId,
    pathwayInstanceId: execution.instance.id,
    ...recoveryTask,
    conditionHandler: OP_RECOVERY_CONDITION_HANDLER,
    evidenceResourceType: 'op_visit_closure_evidence',
    evidenceResourceId: String(appointment.closure_evidence_id),
    evidence: {
      appointment_id: Number(appointment.id),
      appointment_status: appointment.status,
      closure_evidence_id: String(appointment.closure_evidence_id),
      closure_evidence_revision: positiveId(appointment.closure_evidence_revision),
      source_status_history_id: String(appointment.source_status_history_id),
      canonical_timeline_event_id: String(appointment.closure_timeline_event_id),
      canonical_audit_event_id: String(appointment.closure_audit_event_id),
      source_outbox_event_id: String(event.id),
    },
    idempotencyKey: `op:${appointment.id}:event:${event.id}:recovery-completion`,
    signal,
    actor,
    registry,
    activationEvidenceCapability,
    tx,
  });
}

async function approvedDefinitionIdTx(tx, tenantId, checksum) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT definition.id
       FROM workflow_definitions AS definition
       JOIN care_pathway_definition_governance AS governance
         ON governance.tenant_id = definition.tenant_id
        AND governance.workflow_definition_id = definition.id
      WHERE definition.tenant_id = $1::uuid
        AND definition.workflow_key = $2::text
        AND definition.version = 1
        AND definition.is_active = TRUE
        AND governance.governance_status = 'approved'
        AND governance.definition_checksum = $3::char(64)
        AND (governance.effective_from IS NULL OR governance.effective_from <= NOW())
        AND (governance.effective_until IS NULL OR governance.effective_until >= NOW())
      ORDER BY definition.id
      LIMIT 2
      FOR SHARE OF definition, governance`,
    tenantId,
    CARE_PATHWAY_KEYS.OP,
    checksum,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      'One exact approved OP pathway definition is required',
      rows.length === 0
        ? 'OP_PATHWAY_DEFINITION_UNAVAILABLE'
        : 'OP_PATHWAY_DEFINITION_AMBIGUOUS',
    );
  }
  return Number(rows[0].id);
}

async function loadPathwayInstanceTx(tx, tenantId, appointmentId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, clinical_status
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND pathway_key = $2::text
        AND source_episode_type = 'appointment'
        AND source_episode_id = $3::text
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    CARE_PATHWAY_KEYS.OP,
    String(appointmentId),
  );
  return rows[0] || null;
}

async function currentRootReferenceTx(tx, tenantId, pathwayInstanceId, patientUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT reference.id
       FROM care_pathway_resource_references AS reference
      WHERE reference.tenant_id = $1::uuid
        AND reference.pathway_instance_id = $2::uuid
        AND reference.patient_uid = $3::uuid
        AND reference.resource_type = 'appointment'
        AND reference.relationship_kind = 'closure_evidence'
        AND reference.evidence_state <> 'superseded'
        AND NOT EXISTS (
          SELECT 1
            FROM care_pathway_resource_references AS successor
           WHERE successor.tenant_id = reference.tenant_id
             AND successor.superseded_reference_id = reference.id
        )
      ORDER BY reference.recorded_at DESC, reference.id DESC
      LIMIT 1
      FOR SHARE`,
    tenantId,
    pathwayInstanceId,
    patientUid,
  );
  return rows[0] || null;
}

async function currentChildReferenceTx(
  tx,
  tenantId,
  pathwayInstanceId,
  patientUid,
  resourceType,
  resourceId,
) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT reference.id,
            reference.evidence_state,
            reference.accepted_owner_uid,
            reference.task_id,
            reference.handoff_id
       FROM care_pathway_resource_references AS reference
      WHERE reference.tenant_id = $1::uuid
        AND reference.pathway_instance_id = $2::uuid
        AND reference.patient_uid = $3::uuid
        AND reference.resource_type = $4::text
        AND reference.resource_id = $5::text
        AND reference.relationship_kind = 'child_action'
        AND reference.evidence_state <> 'superseded'
        AND NOT EXISTS (
          SELECT 1
            FROM care_pathway_resource_references AS successor
           WHERE successor.tenant_id = reference.tenant_id
             AND successor.superseded_reference_id = reference.id
        )
      ORDER BY reference.recorded_at DESC, reference.id DESC
      LIMIT 1
      FOR SHARE OF reference`,
    tenantId,
    pathwayInstanceId,
    patientUid,
    resourceType,
    String(resourceId),
  );
  return rows[0] || null;
}

async function projectChildReferenceTx({
  tx,
  tenantId,
  pathway,
  appointment,
  event,
  actor,
} = {}) {
  if (event.event_type !== OP_CHILD_RESOURCE_EVENT_TYPE) return null;
  if (
    event.payload?.tenant_id
    && String(event.payload.tenant_id).toLowerCase() !== String(tenantId).toLowerCase()
  ) {
    throw AppError.conflict(
      'OP child event tenant identity is inconsistent',
      'OP_CHILD_EVENT_TENANT_IDENTITY_INVALID',
    );
  }
  const linked = await loadValidatedOpChildProjectionTx(tx, {
    tenantId,
    appointmentId: appointment.id,
    patientUid: appointment.patient_uid,
    resourceType: event.payload?.resource_type,
    resourceId: event.payload?.resource_id,
  });
  const current = await currentChildReferenceTx(
    tx,
    tenantId,
    pathway.id,
    appointment.patient_uid,
    linked.resource_type,
    linked.resource_id,
  );
  if (
    current?.evidence_state === 'completed'
    || (
      current?.evidence_state === 'ownership_accepted'
      && linked.evidence_state === 'open'
    )
    || current?.evidence_state === linked.evidence_state
  ) {
    return Object.freeze({ linked, reference: current, replayed: true });
  }

  const input = {
    tenantId,
    pathwayInstanceId: pathway.id,
    patientUid: String(appointment.patient_uid),
    evidenceState: linked.evidence_state,
    sourceOutboxEventId: event.id,
    canonicalTimelineEventId: linked.canonical_timeline_event_id,
    canonicalAuditEventId: linked.canonical_audit_event_id,
    actor,
    occurredAt: linked.occurred_at,
    idempotencyKey: `op:${appointment.id}:child:${linked.resource_type}:${linked.resource_id}:event:${event.id}`,
    metadata: {
      event_type: event.event_type,
      source_table: linked.source_table,
      source_status: linked.source_status,
      blocking: true,
    },
  };
  const reference = current
    ? await supersedePathwayResourceReferenceTx(tx, {
      ...input,
      supersededReferenceId: current.id,
    })
    : await appendPathwayResourceReferenceTx(tx, {
      ...input,
      resourceType: linked.resource_type,
      relationshipKind: 'child_action',
      resourceId: linked.resource_id,
    });
  return Object.freeze({ linked, reference, replayed: reference.replayed === true });
}

function boundedOutcome({ consumerKey, generation, event, mode, appointment = null }) {
  return Object.freeze({
    consumer_key: consumerKey,
    generation,
    event_type: event.event_type,
    pathway_key: CARE_PATHWAY_KEYS.OP,
    pathway_mode: mode,
    appointment_id: appointment?.id ? Number(appointment.id) : null,
    appointment_status: appointment?.status || null,
    effects_suppressed: mode !== PATHWAY_MODES.ACTIVE,
  });
}

export async function projectOpPathwayEvent({
  tx,
  consumerKey,
  generation,
  tenantId,
  event,
  activationEvidenceCapability = null,
} = {}) {
  const mode = await resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.OP,
  });
  if (mode === PATHWAY_MODES.OFF) {
    return boundedOutcome({ consumerKey, generation, event, mode });
  }
  if (mode === PATHWAY_MODES.ACTIVE && !activationEvidenceCapability) {
    throw AppError.conflict(
      'OP pathway activation evidence is unavailable',
      'OP_PATHWAY_ACTIVATION_EVIDENCE_REQUIRED',
    );
  }

  const appointment = await loadAppointmentTx(tx, tenantId, event);
  const runtimeRegistry = workflowRuntimeRegistryV4;
  const compiled = compileOpContactToRecoveryDefinition({ registry: runtimeRegistry });
  const workflowDefinitionId = await approvedDefinitionIdTx(tx, tenantId, compiled.checksum);
  const occurredAt = new Date(event.occurred_at).toISOString();
  const actor = createRegisteredWorkflowSystemActor({
    registry: runtimeRegistry,
    systemKey: 'op.pathway_projector.v1',
    sourceEventId: event.id,
    causationId: `event_outbox:${event.id}`,
    signalContext: {
      sourceResourceType: 'event_outbox',
      sourceResourceId: String(event.id),
      occurredAt,
    },
  });

  let pathway;
  if (event.event_type === 'appointment.created') {
    pathway = await startCarePathwayInstance({
      tenantId,
      workflowDefinitionId,
      patientUid: String(appointment.patient_uid),
      encounterId: appointment.encounter_id ? String(appointment.encounter_id) : null,
      pathwayKey: CARE_PATHWAY_KEYS.OP,
      sourceEpisodeType: 'appointment',
      sourceEpisodeId: String(appointment.id),
      owningClinicianUid: appointment.clinician_uid
        ? String(appointment.clinician_uid)
        : null,
      accountableRole: 'DOCTOR',
      triggerKind: 'event',
      triggerPayload: {
        event_type: event.event_type,
        appointment_id: Number(appointment.id),
      },
      context: {},
      metadata: { appointment_uid: String(appointment.uid) },
      idempotencyKey: `op:${appointment.id}:start`,
      actor,
      registry: runtimeRegistry,
      activationEvidenceCapability,
      tx,
    });
    await appendPathwayResourceReferenceTx(tx, {
      tenantId,
      pathwayInstanceId: pathway.id,
      patientUid: String(appointment.patient_uid),
      resourceType: 'appointment',
      relationshipKind: 'closure_evidence',
      evidenceState: 'open',
      resourceId: String(appointment.id),
      sourceOutboxEventId: event.id,
      canonicalTimelineEventId: event.payload?.canonical_timeline_event_id || null,
      canonicalAuditEventId: event.payload?.canonical_audit_event_id || null,
      actor,
      occurredAt,
      idempotencyKey: `op:${appointment.id}:root-reference`,
      metadata: { event_type: event.event_type },
    });
  } else {
    pathway = await loadPathwayInstanceTx(tx, tenantId, appointment.id);
    if (!pathway) {
      throw AppError.conflict(
        'OP pathway instance is unavailable',
        'OP_PATHWAY_INSTANCE_MISSING',
      );
    }
    if (!['planned', 'active', 'on_hold'].includes(pathway.clinical_status)) {
      return Object.freeze({
        ...boundedOutcome({ consumerKey, generation, event, mode, appointment }),
        pathway_instance_id: String(pathway.id),
        terminal_instance_skipped: true,
      });
    }
    const rootReference = await currentRootReferenceTx(
      tx,
      tenantId,
      pathway.id,
      appointment.patient_uid,
    );
    if (!rootReference) {
      throw AppError.conflict(
        'OP pathway root reference is unavailable',
        'OP_PATHWAY_ROOT_REFERENCE_MISSING',
      );
    }
  }

  const childProjection = await projectChildReferenceTx({
    tx,
    tenantId,
    pathway,
    appointment,
    event,
    actor,
  });
  const signal = Object.freeze({
    kind: event.event_type.replaceAll('.', '_'),
    payload: Object.freeze({
      appointment_id: Number(appointment.id),
      ...(childProjection
        ? {
          resource_type: childProjection.linked.resource_type,
          resource_id: childProjection.linked.resource_id,
        }
        : {}),
    }),
  });
  const observed = await executePathwayCommand({
    tenantId,
    pathwayInstanceId: pathway.id,
    idempotencyKey: `op:${appointment.id}:event:${event.id}`,
    signal,
    actor,
    registry: runtimeRegistry,
    activationEvidenceCapability,
    tx,
  });
  const executed = await completeOpRecoveryTaskFromClosureEvidence({
    tenantId,
    appointment,
    event,
    execution: observed,
    actor,
    registry: runtimeRegistry,
    signal,
    activationEvidenceCapability,
    tx,
  });
  if (executed.instance?.clinical_status === 'completed') {
    const rootReference = await currentRootReferenceTx(
      tx,
      tenantId,
      pathway.id,
      appointment.patient_uid,
    );
    if (!rootReference) {
      throw AppError.conflict(
        'OP pathway root reference is unavailable',
        'OP_PATHWAY_ROOT_REFERENCE_MISSING',
      );
    }
    await supersedePathwayResourceReferenceTx(tx, {
      tenantId,
      pathwayInstanceId: pathway.id,
      patientUid: String(appointment.patient_uid),
      supersededReferenceId: rootReference.id,
      evidenceState: 'completed',
      handoffId: appointment.accepted_handoff_id || null,
      sourceOutboxEventId: event.id,
      canonicalTimelineEventId: appointment.closure_timeline_event_id || null,
      canonicalAuditEventId: appointment.closure_audit_event_id || null,
      actor,
      occurredAt,
      idempotencyKey: `op:${appointment.id}:root-reference:completed`,
      metadata: {
        event_type: event.event_type,
        closure_evidence_id: appointment.closure_evidence_id
          ? String(appointment.closure_evidence_id)
          : null,
        closure_basis: appointment.closure_basis || null,
      },
    });
  }
  return Object.freeze({
    ...boundedOutcome({ consumerKey, generation, event, mode, appointment }),
    pathway_instance_id: String(pathway.id),
    pathway_replayed: pathway.replayed === true,
    command_replayed: executed.replayed === true,
    child_reference_replayed: childProjection?.replayed ?? null,
  });
}

export async function opPathwayProjectorHandler(context) {
  return projectOpPathwayEvent(context);
}

export default opPathwayProjectorHandler;

export const __testing__ = Object.freeze({
  currentRecoveryTask,
  currentChildReferenceTx,
  projectChildReferenceTx,
});
