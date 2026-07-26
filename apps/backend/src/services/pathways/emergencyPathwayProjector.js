import { AppError } from '../../utils/AppError.js';
import { ensureEmergencyPatientEncounterTx } from '../ed/edPathwayDomainService.js';
import {
  createRegisteredWorkflowSystemActor,
  workflowRuntimeRegistryV5,
} from '../workflow/workflowRuntimeRegistry.js';
import { compileEmergencyArrivalToAftercareDefinition } from './emergencyPathwayDefinition.js';
import {
  executePathwayCommand,
  startCarePathwayInstance,
} from './pathwayExecutorService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from './pathwayMode.js';
import { resolvePathwayModeTx } from './pathwayRuntimePersistence.js';

export const EMERGENCY_PATHWAY_EVENT_TYPES = Object.freeze([
  'emergency.visit.created',
  'emergency.visit.transitioned',
  'emergency.visit.destination_closed',
]);

function positiveId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function loadEmergencyVisitTx(tx, tenantId, event) {
  const aggregateId = positiveId(event.aggregate_id);
  const payloadId = positiveId(event.payload?.emergency_visit_id);
  if (
    event.aggregate_type !== 'emergency_visit'
    || !aggregateId
    || aggregateId !== payloadId
  ) {
    throw AppError.conflict(
      'Emergency projector event identity is inconsistent',
      'EMERGENCY_PROJECTOR_EVENT_IDENTITY_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, attending_doctor_uid,
            status, disposition, created_at, updated_at
       FROM emergency_visits
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
      LIMIT 1
      FOR SHARE`,
    tenantId,
    aggregateId,
  );
  const visit = rows[0];
  if (!visit) {
    throw AppError.conflict(
      'Emergency projector visit is unavailable',
      'EMERGENCY_PROJECTOR_VISIT_MISSING',
    );
  }
  const eventPatientUid = String(event.patient_uid || '').toLowerCase();
  const payloadPatientUid = String(event.payload?.patient_uid || '').toLowerCase();
  const patientUid = String(visit.patient_uid || '').toLowerCase();
  if (
    !patientUid
    || eventPatientUid !== patientUid
    || payloadPatientUid !== patientUid
  ) {
    throw AppError.conflict(
      'Emergency projector patient identity is inconsistent',
      'EMERGENCY_PROJECTOR_PATIENT_IDENTITY_INVALID',
    );
  }
  return visit;
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
    CARE_PATHWAY_KEYS.EMERGENCY,
    checksum,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      'One exact approved emergency pathway definition is required',
      rows.length === 0
        ? 'EMERGENCY_PATHWAY_DEFINITION_UNAVAILABLE'
        : 'EMERGENCY_PATHWAY_DEFINITION_AMBIGUOUS',
    );
  }
  return Number(rows[0].id);
}

async function loadPathwayInstanceTx(tx, tenantId, emergencyVisitId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, clinical_status
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND pathway_key = $2::text
        AND source_episode_type = 'emergency_visit'
        AND source_episode_id = $3::integer::text
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    CARE_PATHWAY_KEYS.EMERGENCY,
    emergencyVisitId,
  );
  return rows[0] || null;
}

function boundedOutcome({ consumerKey, generation, event, mode, visit = null }) {
  return Object.freeze({
    consumer_key: consumerKey,
    generation,
    event_type: event.event_type,
    pathway_key: CARE_PATHWAY_KEYS.EMERGENCY,
    pathway_mode: mode,
    emergency_visit_id: visit?.id ? Number(visit.id) : null,
    emergency_visit_status: visit?.status || null,
    effects_suppressed: mode !== PATHWAY_MODES.ACTIVE,
  });
}

export async function projectEmergencyPathwayEvent({
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
    pathwayKey: CARE_PATHWAY_KEYS.EMERGENCY,
  });
  if (mode === PATHWAY_MODES.OFF) {
    return boundedOutcome({ consumerKey, generation, event, mode });
  }
  if (mode === PATHWAY_MODES.ACTIVE && !activationEvidenceCapability) {
    throw AppError.conflict(
      'Emergency pathway activation evidence is unavailable',
      'EMERGENCY_PATHWAY_ACTIVATION_EVIDENCE_REQUIRED',
    );
  }

  const visit = await loadEmergencyVisitTx(tx, tenantId, event);
  await ensureEmergencyPatientEncounterTx(tx, {
    tenantId,
    visit,
    actorUid: visit.attending_doctor_uid,
  });
  const runtimeRegistry = workflowRuntimeRegistryV5;
  const compiled = compileEmergencyArrivalToAftercareDefinition({
    registry: runtimeRegistry,
  });
  const workflowDefinitionId = await approvedDefinitionIdTx(
    tx,
    tenantId,
    compiled.checksum,
  );
  const occurredAt = new Date(event.created_at).toISOString();
  const actor = createRegisteredWorkflowSystemActor({
    registry: runtimeRegistry,
    systemKey: 'emergency.pathway_projector.v1',
    sourceEventId: event.id,
    causationId: `event_outbox:${event.id}`,
    signalContext: {
      sourceResourceType: 'event_outbox',
      sourceResourceId: String(event.id),
      occurredAt,
    },
  });

  let pathway;
  if (event.event_type === 'emergency.visit.created') {
    pathway = await startCarePathwayInstance({
      tenantId,
      workflowDefinitionId,
      patientUid: String(visit.patient_uid),
      encounterId: String(visit.encounter_id),
      pathwayKey: CARE_PATHWAY_KEYS.EMERGENCY,
      sourceEpisodeType: 'emergency_visit',
      sourceEpisodeId: String(visit.id),
      owningClinicianUid: visit.attending_doctor_uid
        ? String(visit.attending_doctor_uid)
        : null,
      accountableRole: 'DOCTOR',
      triggerKind: 'event',
      triggerPayload: {
        event_type: event.event_type,
        emergency_visit_id: Number(visit.id),
      },
      context: {},
      metadata: { visit_number: event.payload?.visit_number || null },
      idempotencyKey: `emergency:${visit.id}:start`,
      actor,
      registry: runtimeRegistry,
      activationEvidenceCapability,
      tx,
    });
  } else {
    pathway = await loadPathwayInstanceTx(tx, tenantId, visit.id);
    if (!pathway) {
      throw AppError.conflict(
        'Emergency pathway instance is unavailable',
        'EMERGENCY_PATHWAY_INSTANCE_MISSING',
      );
    }
    if (!['planned', 'active', 'on_hold'].includes(pathway.clinical_status)) {
      return Object.freeze({
        ...boundedOutcome({ consumerKey, generation, event, mode, visit }),
        pathway_instance_id: String(pathway.id),
        terminal_instance_skipped: true,
      });
    }
  }

  const executed = await executePathwayCommand({
    tenantId,
    pathwayInstanceId: pathway.id,
    idempotencyKey: `emergency:${visit.id}:event:${event.id}`,
    signal: Object.freeze({
      kind: event.event_type.replaceAll('.', '_'),
      payload: Object.freeze({
        emergency_visit_id: Number(visit.id),
        status: visit.status,
        disposition: visit.disposition || null,
      }),
    }),
    actor,
    registry: runtimeRegistry,
    activationEvidenceCapability,
    tx,
  });
  return Object.freeze({
    ...boundedOutcome({ consumerKey, generation, event, mode, visit }),
    pathway_instance_id: String(pathway.id),
    pathway_replayed: pathway.replayed === true,
    command_replayed: executed.replayed === true,
  });
}

export async function emergencyPathwayProjectorHandler(context) {
  return projectEmergencyPathwayEvent(context);
}

export default emergencyPathwayProjectorHandler;
