import { AppError } from '../../utils/AppError.js';
import {
  createRegisteredWorkflowSystemActor,
  workflowRuntimeRegistryV3,
} from '../workflow/workflowRuntimeRegistry.js';
import {
  executePathwayCommand,
  startCarePathwayInstance,
} from './pathwayExecutorService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from './pathwayMode.js';
import { compileReferralRequestToClosureDefinition } from './referralPathwayDefinition.js';
import { resolvePathwayModeTx } from './pathwayRuntimePersistence.js';

export const REFERRAL_PATHWAY_EVENT_TYPES = Object.freeze([
  'referral.requested',
  'referral.seen',
  'referral.accepted',
  'referral.declined',
  'referral.rerouted',
  'referral.response_signed',
  'referral.closed',
  'referral.appointment_linked',
]);

async function loadReferralTx(tx, tenantId, event) {
  const aggregateId = Number.parseInt(event.aggregate_id, 10);
  const payloadId = Number.parseInt(event.payload?.referral_id, 10);
  if (!Number.isSafeInteger(aggregateId) || aggregateId <= 0 || aggregateId !== payloadId) {
    throw AppError.conflict(
      'Referral projector event identity is inconsistent',
      'REFERRAL_PROJECTOR_EVENT_IDENTITY_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, referring_doctor,
            referred_to_doctor, current_owner_uid, status, closure_status,
            urgency, referred_to_department
       FROM referrals
      WHERE tenant_id = $1::uuid AND id = $2::integer
      LIMIT 1
      FOR SHARE`,
    tenantId,
    aggregateId,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Referral projector source is unavailable',
      'REFERRAL_PROJECTOR_SOURCE_MISSING',
    );
  }
  return rows[0];
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
    CARE_PATHWAY_KEYS.REFERRAL,
    checksum,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      'One exact approved Referral pathway definition is required',
      rows.length === 0
        ? 'REFERRAL_PATHWAY_DEFINITION_UNAVAILABLE'
        : 'REFERRAL_PATHWAY_DEFINITION_AMBIGUOUS',
    );
  }
  return Number(rows[0].id);
}

function outcome({ consumerKey, generation, event, mode, referral = null }) {
  return Object.freeze({
    consumer_key: consumerKey,
    generation,
    event_type: event.event_type,
    pathway_key: CARE_PATHWAY_KEYS.REFERRAL,
    pathway_mode: mode,
    referral_id: referral?.id || null,
    referral_status: referral?.status || null,
    closure_status: referral?.closure_status || null,
    effects_suppressed: mode !== PATHWAY_MODES.ACTIVE,
  });
}

export async function projectReferralPathwayEvent({
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
    pathwayKey: CARE_PATHWAY_KEYS.REFERRAL,
  });
  if (mode === PATHWAY_MODES.OFF) return outcome({ consumerKey, generation, event, mode });
  const referral = await loadReferralTx(tx, tenantId, event);
  if (mode === PATHWAY_MODES.SHADOW) {
    return outcome({ consumerKey, generation, event, mode, referral });
  }
  if (!activationEvidenceCapability) {
    throw AppError.conflict(
      'Referral pathway activation evidence is unavailable',
      'REFERRAL_PATHWAY_ACTIVATION_EVIDENCE_REQUIRED',
    );
  }

  const runtimeRegistry = workflowRuntimeRegistryV3;
  const compiled = compileReferralRequestToClosureDefinition({ registry: runtimeRegistry });
  const workflowDefinitionId = await approvedDefinitionIdTx(tx, tenantId, compiled.checksum);
  const actor = createRegisteredWorkflowSystemActor({
    registry: runtimeRegistry,
    systemKey: 'referral.pathway_projector.v1',
    sourceEventId: event.id,
    causationId: `event_outbox:${event.id}`,
    signalContext: {
      sourceResourceType: 'event_outbox',
      sourceResourceId: String(event.id),
      occurredAt: new Date(event.occurred_at).toISOString(),
    },
  });

  let pathway;
  if (event.event_type === 'referral.requested') {
    pathway = await startCarePathwayInstance({
      tenantId,
      workflowDefinitionId,
      patientUid: String(referral.patient_uid),
      encounterId: referral.encounter_id ? String(referral.encounter_id) : null,
      pathwayKey: CARE_PATHWAY_KEYS.REFERRAL,
      sourceEpisodeType: 'referral',
      sourceEpisodeId: String(referral.id),
      owningClinicianUid: referral.current_owner_uid || referral.referring_doctor,
      accountableRole: 'DOCTOR',
      triggerKind: 'event',
      triggerPayload: { event_type: event.event_type, referral_id: referral.id },
      context: { urgency: referral.urgency },
      metadata: {
        referred_to_department: referral.referred_to_department,
        referred_to_doctor: referral.referred_to_doctor,
      },
      idempotencyKey: `referral:${referral.id}:start`,
      actor,
      registry: runtimeRegistry,
      activationEvidenceCapability,
      tx,
    });
  } else {
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM care_pathway_instances
        WHERE tenant_id = $1::uuid
          AND pathway_key = $2::text
          AND source_episode_type = 'referral'
          AND source_episode_id = $3::text
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`,
      tenantId,
      CARE_PATHWAY_KEYS.REFERRAL,
      String(referral.id),
    );
    pathway = rows[0];
    if (!pathway) {
      throw AppError.conflict(
        'Referral pathway instance is unavailable',
        'REFERRAL_PATHWAY_INSTANCE_MISSING',
      );
    }
    if (!['planned', 'active', 'on_hold'].includes(pathway.clinical_status)) {
      return Object.freeze({
        ...outcome({ consumerKey, generation, event, mode, referral }),
        effects_suppressed: false,
        pathway_instance_id: String(pathway.id),
        terminal_instance_skipped: true,
      });
    }
  }

  const executed = await executePathwayCommand({
    tenantId,
    pathwayInstanceId: pathway.id,
    idempotencyKey: `referral:${referral.id}:event:${event.id}`,
    signal: {
      kind: event.event_type.replaceAll('.', '_'),
      payload: { referral_id: referral.id, status: referral.status },
    },
    actor,
    registry: runtimeRegistry,
    activationEvidenceCapability,
    tx,
  });
  return Object.freeze({
    ...outcome({ consumerKey, generation, event, mode, referral }),
    effects_suppressed: false,
    pathway_instance_id: String(pathway.id),
    pathway_replayed: pathway.replayed === true,
    command_replayed: executed.replayed === true,
  });
}

export async function referralPathwayProjectorHandler(context) {
  return projectReferralPathwayEvent(context);
}

export default referralPathwayProjectorHandler;
