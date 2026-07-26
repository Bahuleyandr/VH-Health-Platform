import { AppError } from '../../utils/AppError.js';
import { supersedePriorDiagnosticGenerationTx } from '../diagnostics/diagnosticGenerationSupersessionService.js';
import {
  createRegisteredWorkflowSystemActor,
  workflowRuntimeRegistryV2,
} from '../workflow/workflowRuntimeRegistry.js';
import {
  executePathwayCommand,
  startCarePathwayInstance,
} from './pathwayExecutorService.js';
import { compileDiagnosticsOrderToActionDefinition } from './diagnosticsPathwayDefinition.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from './pathwayMode.js';
import { resolvePathwayModeTx } from './pathwayRuntimePersistence.js';

export const DIAGNOSTIC_PATHWAY_EVENT_TYPES = Object.freeze([
  'diagnostic.result.generation_signed',
  'diagnostic.result.release_became_eligible',
  'diagnostic.result.normal_auto_closed',
  'diagnostic.result.generation_corrected',
  'diagnostic.result.action_recorded',
  'diagnostic.result.reopened',
]);

const START_EVENT_TYPES = new Set([
  'diagnostic.result.generation_signed',
  'diagnostic.result.generation_corrected',
  'diagnostic.result.reopened',
]);

async function loadGenerationTx(tx, tenantId, event) {
  const payloadGenerationId = String(event.payload?.generation_id || '').trim().toLowerCase();
  const aggregateId = String(event.aggregate_id || '').trim().toLowerCase();
  if (!payloadGenerationId || payloadGenerationId !== aggregateId) {
    throw AppError.conflict(
      'Diagnostic projector event identity is inconsistent',
      'DIAGNOSTIC_PROJECTOR_EVENT_IDENTITY_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, classification, snapshot_sha256,
            source_kind, source_episode_type, source_episode_key, source_version,
            ordering_owner_uid, owner_source, signed_at, predecessor_generation_id,
            EXISTS (
              SELECT 1
                FROM diagnostic_result_generations AS successor
               WHERE successor.tenant_id = generation.tenant_id
                 AND successor.predecessor_generation_id = generation.id
            ) AS has_successor
       FROM diagnostic_result_generations AS generation
      WHERE generation.tenant_id = $1::uuid
        AND generation.id = $2::uuid
      LIMIT 1
      FOR SHARE`,
    tenantId,
    payloadGenerationId,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Diagnostic projector generation is unavailable',
      'DIAGNOSTIC_PROJECTOR_GENERATION_MISSING',
    );
  }
  return rows[0];
}

async function loadApprovedDefinitionIdTx(tx, tenantId, checksum) {
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
    CARE_PATHWAY_KEYS.DIAGNOSTICS,
    checksum,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      'One exact approved Diagnostics pathway definition is required',
      rows.length === 0
        ? 'DIAGNOSTIC_PATHWAY_DEFINITION_UNAVAILABLE'
        : 'DIAGNOSTIC_PATHWAY_DEFINITION_AMBIGUOUS',
    );
  }
  return Number(rows[0].id);
}

function boundedOutcome({ consumerKey, generation, event, pathwayMode, generationRow = null }) {
  return Object.freeze({
    consumer_key: consumerKey,
    generation,
    event_type: event.event_type,
    pathway_key: CARE_PATHWAY_KEYS.DIAGNOSTICS,
    pathway_mode: pathwayMode,
    diagnostic_generation_id: generationRow?.id ? String(generationRow.id) : null,
    classification: generationRow?.classification || null,
    effects_suppressed: pathwayMode !== PATHWAY_MODES.ACTIVE,
  });
}

export async function projectDiagnosticPathwayEvent({
  tx,
  consumerKey,
  generation,
  tenantId,
  event,
  activationEvidenceCapability = null,
} = {}) {
  const pathwayMode = await resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
  });
  if (pathwayMode === PATHWAY_MODES.OFF) {
    return boundedOutcome({ consumerKey, generation, event, pathwayMode });
  }

  const generationRow = await loadGenerationTx(tx, tenantId, event);
  if (pathwayMode === PATHWAY_MODES.SHADOW) {
    return boundedOutcome({
      consumerKey,
      generation,
      event,
      pathwayMode,
      generationRow,
    });
  }

  if (!START_EVENT_TYPES.has(event.event_type)) {
    return boundedOutcome({
      consumerKey,
      generation,
      event,
      pathwayMode,
      generationRow,
    });
  }
  if (!activationEvidenceCapability) {
    throw AppError.conflict(
      'Diagnostics pathway activation evidence is unavailable',
      'DIAGNOSTIC_PATHWAY_ACTIVATION_EVIDENCE_REQUIRED',
    );
  }

  const runtimeRegistry = workflowRuntimeRegistryV2;
  const compiled = compileDiagnosticsOrderToActionDefinition({ registry: runtimeRegistry });
  const workflowDefinitionId = await loadApprovedDefinitionIdTx(
    tx,
    tenantId,
    compiled.checksum,
  );
  const occurredAt = new Date(event.created_at).toISOString();
  const actor = createRegisteredWorkflowSystemActor({
    registry: runtimeRegistry,
    systemKey: 'diagnostics.pathway_projector.v1',
    sourceEventId: event.id,
    causationId: `event_outbox:${event.id}`,
    signalContext: {
      sourceResourceType: 'event_outbox',
      sourceResourceId: String(event.id),
      occurredAt,
    },
  });
  const supersession = event.event_type === 'diagnostic.result.generation_corrected'
    ? await supersedePriorDiagnosticGenerationTx({
      tx,
      tenantId,
      successorGenerationId: String(generationRow.id),
      actor,
      registry: runtimeRegistry,
      activationEvidenceCapability,
    })
    : null;
  if (generationRow.has_successor === true) {
    return Object.freeze({
      ...boundedOutcome({
        consumerKey,
        generation,
        event,
        pathwayMode,
        generationRow,
      }),
      effects_suppressed: false,
      stale_generation_skipped: true,
      ...(supersession ? { predecessor_supersession: supersession } : {}),
    });
  }
  const started = await startCarePathwayInstance({
    tenantId,
    workflowDefinitionId,
    patientUid: String(generationRow.patient_uid),
    encounterId: generationRow.encounter_id ? String(generationRow.encounter_id) : null,
    pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
    sourceEpisodeType: 'diagnostic_result_generation',
    sourceEpisodeId: String(generationRow.id),
    owningClinicianUid: generationRow.ordering_owner_uid
      ? String(generationRow.ordering_owner_uid)
      : null,
    accountableRole: 'DOCTOR',
    triggerKind: 'event',
    triggerPayload: {
      event_type: event.event_type,
      diagnostic_generation_id: String(generationRow.id),
      classification: generationRow.classification,
    },
    context: {
      diagnostic_generation_snapshot_sha256: generationRow.snapshot_sha256,
    },
    metadata: {
      source_kind: generationRow.source_kind,
      source_episode_type: generationRow.source_episode_type,
      source_episode_key: generationRow.source_episode_key,
      source_version: Number(generationRow.source_version),
      owner_source: generationRow.owner_source,
      ...(event.payload?.action_id ? {
        reopened_action_id: String(event.payload.action_id),
      } : {}),
    },
    idempotencyKey: `diagnostics:${generationRow.id}:start`,
    actor,
    registry: runtimeRegistry,
    activationEvidenceCapability,
    tx,
  });
  const executed = await executePathwayCommand({
    tenantId,
    pathwayInstanceId: started.id,
    idempotencyKey: `diagnostics:${generationRow.id}:route`,
    signal: {
      kind: 'diagnostic_generation_signed',
      payload: {
        diagnostic_generation_id: String(generationRow.id),
        classification: generationRow.classification,
      },
    },
    actor,
    registry: runtimeRegistry,
    activationEvidenceCapability,
    tx,
  });
  return Object.freeze({
    ...boundedOutcome({
      consumerKey,
      generation,
      event,
      pathwayMode,
      generationRow,
    }),
    effects_suppressed: false,
    pathway_instance_id: String(started.id),
    pathway_replayed: started.replayed === true,
    command_replayed: executed.replayed === true,
    ...(supersession ? { predecessor_supersession: supersession } : {}),
  });
}

export async function diagnosticPathwayProjectorHandler(context) {
  return projectDiagnosticPathwayEvent(context);
}

export default diagnosticPathwayProjectorHandler;
