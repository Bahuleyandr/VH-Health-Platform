import { AppError } from '../../utils/AppError.js';
import {
  createRegisteredWorkflowSystemActor,
  workflowRuntimeRegistryV4,
} from '../workflow/workflowRuntimeRegistry.js';
import {
  appendPathwayResourceReferenceTx,
  supersedePathwayResourceReferenceTx,
} from './carePathwayResourceReferenceService.js';
import { compileInpatientAdmissionToRecoveryDefinition } from './inpatientPathwayDefinition.js';
import {
  executePathwayCommand,
  startCarePathwayInstance,
} from './pathwayExecutorService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from './pathwayMode.js';
import { resolvePathwayModeTx } from './pathwayRuntimePersistence.js';

export const INPATIENT_PATHWAY_EVENT_TYPES = Object.freeze([
  'admission.created',
  'admission.readmission_linked',
  'admission.diagnostic_resource_linked',
  'bed.assigned',
  'bed.transferred',
  'discharge.workflow_opened',
  'discharge.work_item_completed',
  'discharge.drugs_dispensed',
  'clinical_document.discharge_summary.signed',
  'discharge.pending_result_handoff_recorded',
  'discharge.pending_result_available',
  'discharge.pending_result_resolved',
  'discharge.completed',
  'post_discharge.contact_recorded',
]);

const INPATIENT_DIAGNOSTIC_RESOURCE_TYPES = Object.freeze([
  'investigation',
  'lab_result',
  'radiology_order',
  'anatomical_pathology_case',
  'diagnostic_result_generation',
]);
const INPATIENT_DIAGNOSTIC_RESOURCE_TYPE_SET = new Set(
  INPATIENT_DIAGNOSTIC_RESOURCE_TYPES,
);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function positiveId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function diagnosticResourceIdentity(event) {
  if (event?.event_type !== 'admission.diagnostic_resource_linked') return null;
  const resourceType = String(event.payload?.resource_type || '').trim().toLowerCase();
  if (!INPATIENT_DIAGNOSTIC_RESOURCE_TYPE_SET.has(resourceType)) {
    throw AppError.conflict(
      'Inpatient diagnostic projector resource type is invalid',
      'INPATIENT_PROJECTOR_DIAGNOSTIC_RESOURCE_TYPE_INVALID',
    );
  }
  const resourceId = String(event.payload?.resource_id || '').trim().toLowerCase();
  const validResourceId = resourceType === 'diagnostic_result_generation'
    ? UUID_PATTERN.test(resourceId)
    : /^[1-9][0-9]*$/.test(resourceId);
  if (!validResourceId) {
    throw AppError.conflict(
      'Inpatient diagnostic projector resource identity is invalid',
      'INPATIENT_PROJECTOR_DIAGNOSTIC_RESOURCE_ID_INVALID',
    );
  }
  const occurredAt = new Date(event.payload?.occurred_at);
  if (
    Number.isNaN(occurredAt.getTime())
    || event.payload?.admission_lineage_version !== 1
  ) {
    throw AppError.conflict(
      'Inpatient diagnostic projector lineage metadata is invalid',
      'INPATIENT_PROJECTOR_DIAGNOSTIC_LINEAGE_INVALID',
    );
  }
  for (const field of [
    'canonical_timeline_event_id',
    'canonical_audit_event_id',
  ]) {
    const value = event.payload?.[field];
    if (value != null && !UUID_PATTERN.test(String(value).toLowerCase())) {
      throw AppError.conflict(
        'Inpatient diagnostic projector canonical evidence identity is invalid',
        'INPATIENT_PROJECTOR_DIAGNOSTIC_EVIDENCE_INVALID',
      );
    }
  }
  return Object.freeze({
    resourceType,
    resourceId,
    occurredAt: occurredAt.toISOString(),
  });
}

async function loadInpatientDiagnosticResourceTx({
  tx,
  tenantId,
  admission,
  identity,
}) {
  const queryByResourceType = {
    investigation: `SELECT resource.id::text AS resource_id
       FROM investigations AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.id = $2::integer
        AND resource.patient_uid = $3::uuid
        AND resource.admission_id = $4::integer
      LIMIT 1
      FOR SHARE`,
    lab_result: `SELECT resource.id::text AS resource_id
       FROM lab_results AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.id = $2::integer
        AND resource.patient_uid = $3::uuid
        AND resource.admission_id = $4::integer
      LIMIT 1
      FOR SHARE`,
    radiology_order: `SELECT resource.id::text AS resource_id
       FROM radiology_orders AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.id = $2::integer
        AND resource.patient_uid = $3::uuid
        AND resource.admission_id = $4::integer
      LIMIT 1
      FOR SHARE`,
    anatomical_pathology_case: `SELECT resource.id::text AS resource_id
       FROM ap_cases AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.id = $2::bigint
        AND resource.patient_uid = $3::uuid
        AND resource.admission_id = $4::integer
      LIMIT 1
      FOR SHARE`,
    diagnostic_result_generation: `SELECT resource.id::text AS resource_id
       FROM diagnostic_result_generations AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.id = $2::uuid
        AND resource.patient_uid = $3::uuid
        AND resource.admission_id = $4::integer
      LIMIT 1
      FOR SHARE`,
  };
  const rows = await tx.$queryRawUnsafe(
    queryByResourceType[identity.resourceType],
    tenantId,
    identity.resourceId,
    admission.patient_uid,
    Number(admission.id),
  );
  if (rows.length !== 1 || String(rows[0].resource_id).toLowerCase() !== identity.resourceId) {
    throw AppError.conflict(
      'Inpatient diagnostic resource is not explicitly linked to this admission',
      'INPATIENT_PROJECTOR_DIAGNOSTIC_ADMISSION_LINEAGE_REQUIRED',
    );
  }
}

export function classifyDischargeSummarySignedEvent(event) {
  if (event?.event_type !== 'clinical_document.discharge_summary.signed') return null;
  const aggregateId = positiveId(event.aggregate_id);
  const dischargeSummaryId = positiveId(event.payload?.discharge_summary_id);
  if (
    dischargeSummaryId
    && event.aggregate_type === 'discharge_summary'
    && aggregateId === dischargeSummaryId
  ) {
    return Object.freeze({
      kind: 'structured_discharge_summary',
      dischargeSummaryId,
    });
  }
  if (
    !dischargeSummaryId
    && event.aggregate_type === 'clinical_note'
    && aggregateId
  ) {
    return Object.freeze({
      kind: 'legacy_clinical_note',
      clinicalNoteId: aggregateId,
    });
  }
  throw AppError.conflict(
    'Signed discharge summary projector identity is inconsistent',
    'INPATIENT_PROJECTOR_SUMMARY_IDENTITY_INVALID',
  );
}

async function loadAdmissionTx(tx, tenantId, event) {
  const admissionId = positiveId(event.payload?.admission_id);
  if (
    !admissionId
    || (
      event.event_type.startsWith('admission.')
      && positiveId(event.aggregate_id) !== admissionId
    )
  ) {
    throw AppError.conflict(
      'Inpatient projector event identity is inconsistent',
      'INPATIENT_PROJECTOR_EVENT_IDENTITY_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT admission.id,
            admission.patient_uid,
            admission.encounter_id,
            LOWER(BTRIM(COALESCE(admission.status, ''))) AS status,
            admission.source_appointment_id,
            admission.source_pathway_instance_id,
            admission.source_handoff_id,
            admission.prior_admission_id,
            assignment.id AS primary_assignment_id,
            assignment.physician_uid AS primary_physician_uid
       FROM admissions AS admission
       LEFT JOIN LATERAL (
         SELECT candidate.id, candidate.physician_uid
           FROM inpatient_primary_physician_assignments AS candidate
          WHERE candidate.tenant_id = admission.tenant_id
            AND candidate.admission_id = admission.id
            AND candidate.patient_uid = admission.patient_uid
          ORDER BY candidate.assignment_version DESC, candidate.recorded_at DESC
          LIMIT 1
       ) AS assignment ON TRUE
      WHERE admission.tenant_id = $1::uuid
        AND admission.id = $2::integer
      LIMIT 1
      FOR SHARE OF admission`,
    tenantId,
    admissionId,
  );
  const admission = rows[0];
  if (!admission) {
    throw AppError.conflict(
      'Inpatient projector admission is unavailable',
      'INPATIENT_PROJECTOR_ADMISSION_MISSING',
    );
  }
  const eventPatientUid = String(event.patient_uid || '').toLowerCase();
  const patientUid = String(admission.patient_uid || '').toLowerCase();
  const payloadPatientUid = event.payload?.patient_uid == null
    ? patientUid
    : String(event.payload.patient_uid).toLowerCase();
  if (
    !patientUid
    || eventPatientUid !== patientUid
    || payloadPatientUid !== patientUid
  ) {
    throw AppError.conflict(
      'Inpatient projector patient identity is inconsistent',
      'INPATIENT_PROJECTOR_PATIENT_IDENTITY_INVALID',
    );
  }
  return admission;
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
    CARE_PATHWAY_KEYS.INPATIENT,
    checksum,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      'One exact approved Inpatient pathway definition is required',
      rows.length === 0
        ? 'INPATIENT_PATHWAY_DEFINITION_UNAVAILABLE'
        : 'INPATIENT_PATHWAY_DEFINITION_AMBIGUOUS',
    );
  }
  return Number(rows[0].id);
}

async function loadPathwayInstanceTx(tx, tenantId, admissionId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, clinical_status
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND pathway_key = $2::text
        AND source_episode_type = 'admission'
        AND source_episode_id = $3::text
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    CARE_PATHWAY_KEYS.INPATIENT,
    String(admissionId),
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
        AND reference.resource_type = 'admission'
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

function boundedOutcome({ consumerKey, generation, event, mode, admission = null }) {
  return Object.freeze({
    consumer_key: consumerKey,
    generation,
    event_type: event.event_type,
    pathway_key: CARE_PATHWAY_KEYS.INPATIENT,
    pathway_mode: mode,
    admission_id: admission?.id ? Number(admission.id) : null,
    admission_status: admission?.status || null,
    effects_suppressed: mode !== PATHWAY_MODES.ACTIVE,
  });
}

export async function projectInpatientPathwayEvent({
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
    pathwayKey: CARE_PATHWAY_KEYS.INPATIENT,
  });
  if (mode === PATHWAY_MODES.OFF) {
    return boundedOutcome({ consumerKey, generation, event, mode });
  }
  if (mode === PATHWAY_MODES.ACTIVE && !activationEvidenceCapability) {
    throw AppError.conflict(
      'Inpatient pathway activation evidence is unavailable',
      'INPATIENT_PATHWAY_ACTIVATION_EVIDENCE_REQUIRED',
    );
  }

  const signedSummaryIdentity = classifyDischargeSummarySignedEvent(event);
  const diagnosticIdentity = diagnosticResourceIdentity(event);
  if (signedSummaryIdentity?.kind === 'legacy_clinical_note') {
    return Object.freeze({
      ...boundedOutcome({ consumerKey, generation, event, mode }),
      admission_id: positiveId(event.payload?.admission_id),
      legacy_summary_ignored: true,
      reconciliation_code: 'INPATIENT_STRUCTURED_SUMMARY_IDENTITY_REQUIRED',
    });
  }

  const admission = await loadAdmissionTx(tx, tenantId, event);
  const runtimeRegistry = workflowRuntimeRegistryV4;
  const compiled = compileInpatientAdmissionToRecoveryDefinition({
    registry: runtimeRegistry,
  });
  const workflowDefinitionId = await approvedDefinitionIdTx(tx, tenantId, compiled.checksum);
  const occurredAt = new Date(event.created_at).toISOString();
  const actor = createRegisteredWorkflowSystemActor({
    registry: runtimeRegistry,
    systemKey: 'inpatient.pathway_projector.v1',
    sourceEventId: event.id,
    causationId: `event_outbox:${event.id}`,
    signalContext: {
      sourceResourceType: 'event_outbox',
      sourceResourceId: String(event.id),
      occurredAt,
    },
  });

  let pathway;
  if (event.event_type === 'admission.created') {
    pathway = await startCarePathwayInstance({
      tenantId,
      workflowDefinitionId,
      patientUid: String(admission.patient_uid),
      encounterId: admission.encounter_id ? String(admission.encounter_id) : null,
      pathwayKey: CARE_PATHWAY_KEYS.INPATIENT,
      sourceEpisodeType: 'admission',
      sourceEpisodeId: String(admission.id),
      // OP-to-IP is a typed accepted cross-pathway handoff, not registered
      // child fanout. Preserve its durable source tuple in metadata without
      // claiming a parent/child runtime relationship.
      parentInstanceId: null,
      owningClinicianUid: admission.primary_physician_uid
        ? String(admission.primary_physician_uid)
        : null,
      accountableRole: 'DOCTOR',
      triggerKind: 'event',
      triggerPayload: {
        event_type: event.event_type,
        admission_id: Number(admission.id),
      },
      context: {},
      metadata: {
        primary_physician_assignment_id: admission.primary_assignment_id
          ? String(admission.primary_assignment_id)
          : null,
        source_appointment_id: admission.source_appointment_id == null
          ? null
          : Number(admission.source_appointment_id),
        source_handoff_id: admission.source_handoff_id
          ? String(admission.source_handoff_id)
          : null,
        source_pathway_instance_id: admission.source_pathway_instance_id
          ? String(admission.source_pathway_instance_id)
          : null,
        prior_admission_id: admission.prior_admission_id == null
          ? null
          : Number(admission.prior_admission_id),
      },
      idempotencyKey: `inpatient:${admission.id}:start`,
      actor,
      registry: runtimeRegistry,
      activationEvidenceCapability,
      tx,
    });
    await appendPathwayResourceReferenceTx(tx, {
      tenantId,
      pathwayInstanceId: pathway.id,
      patientUid: String(admission.patient_uid),
      resourceType: 'admission',
      relationshipKind: 'closure_evidence',
      evidenceState: 'open',
      resourceId: String(admission.id),
      sourceOutboxEventId: event.id,
      canonicalTimelineEventId: event.payload?.canonical_timeline_event_id || null,
      canonicalAuditEventId: event.payload?.canonical_audit_event_id || null,
      actor,
      occurredAt,
      idempotencyKey: `inpatient:${admission.id}:root-reference`,
      metadata: { event_type: event.event_type },
    });
  } else {
    pathway = await loadPathwayInstanceTx(tx, tenantId, admission.id);
    if (!pathway) {
      throw AppError.conflict(
        'Inpatient pathway instance is unavailable',
        'INPATIENT_PATHWAY_INSTANCE_MISSING',
      );
    }
    if (!['planned', 'active', 'on_hold'].includes(pathway.clinical_status)) {
      return Object.freeze({
        ...boundedOutcome({ consumerKey, generation, event, mode, admission }),
        pathway_instance_id: String(pathway.id),
        terminal_instance_skipped: true,
      });
    }
    const rootReference = await currentRootReferenceTx(
      tx,
      tenantId,
      pathway.id,
      admission.patient_uid,
    );
    if (!rootReference) {
      throw AppError.conflict(
        'Inpatient pathway root reference is unavailable',
        'INPATIENT_PATHWAY_ROOT_REFERENCE_MISSING',
      );
    }
  }

  if (event.event_type === 'clinical_document.discharge_summary.signed') {
    const dischargeSummaryId = signedSummaryIdentity.dischargeSummaryId;
    if (
      event.aggregate_type !== 'discharge_summary'
      || positiveId(event.aggregate_id) !== dischargeSummaryId
    ) {
      throw AppError.conflict(
        'Inpatient structured summary event identity is inconsistent',
        'INPATIENT_PROJECTOR_SUMMARY_IDENTITY_INVALID',
      );
    }
    const summaryRows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM discharge_summaries
        WHERE tenant_id = $1::uuid
          AND id = $2::integer
          AND admission_id = $3::integer
          AND patient_uid = $4::uuid
          AND status IN ('signed', 'delivered')
          AND signed_by IS NOT NULL
          AND signed_at IS NOT NULL
        LIMIT 1
        FOR SHARE`,
      tenantId,
      dischargeSummaryId,
      admission.id,
      admission.patient_uid,
    );
    if (!summaryRows[0]) {
      throw AppError.conflict(
        'Signed structured discharge summary is unavailable for this admission',
        'INPATIENT_PROJECTOR_SIGNED_SUMMARY_MISSING',
      );
    }
    await appendPathwayResourceReferenceTx(tx, {
      tenantId,
      pathwayInstanceId: pathway.id,
      patientUid: String(admission.patient_uid),
      resourceType: 'discharge_summary',
      relationshipKind: 'closure_evidence',
      evidenceState: 'completed',
      resourceId: String(dischargeSummaryId),
      sourceOutboxEventId: event.id,
      canonicalTimelineEventId: event.payload?.canonical_timeline_event_id || null,
      canonicalAuditEventId: event.payload?.canonical_audit_event_id || null,
      actor,
      occurredAt,
      idempotencyKey: `inpatient:${admission.id}:summary:${dischargeSummaryId}:reference`,
      metadata: { event_type: event.event_type },
    });
  }

  if (diagnosticIdentity) {
    await loadInpatientDiagnosticResourceTx({
      tx,
      tenantId,
      admission,
      identity: diagnosticIdentity,
    });
    await appendPathwayResourceReferenceTx(tx, {
      tenantId,
      pathwayInstanceId: pathway.id,
      patientUid: String(admission.patient_uid),
      resourceType: diagnosticIdentity.resourceType,
      relationshipKind: 'child_action',
      evidenceState: 'open',
      resourceId: diagnosticIdentity.resourceId,
      sourceOutboxEventId: event.id,
      canonicalTimelineEventId: event.payload?.canonical_timeline_event_id || null,
      canonicalAuditEventId: event.payload?.canonical_audit_event_id || null,
      actor,
      occurredAt: diagnosticIdentity.occurredAt,
      idempotencyKey: [
        'inpatient',
        admission.id,
        'diagnostic',
        diagnosticIdentity.resourceType,
        diagnosticIdentity.resourceId,
        'reference',
      ].join(':'),
      metadata: {
        admission_id: Number(admission.id),
        admission_lineage_version: 1,
        linkage_basis: 'explicit_admission_resource_link_v1',
      },
    });
  }

  const executed = await executePathwayCommand({
    tenantId,
    pathwayInstanceId: pathway.id,
    idempotencyKey: `inpatient:${admission.id}:event:${event.id}`,
    signal: {
      kind: event.event_type.replaceAll('.', '_'),
      payload: { admission_id: Number(admission.id) },
    },
    actor,
    registry: runtimeRegistry,
    activationEvidenceCapability,
    tx,
  });
  if (executed.instance?.clinical_status === 'completed') {
    const rootReference = await currentRootReferenceTx(
      tx,
      tenantId,
      pathway.id,
      admission.patient_uid,
    );
    if (!rootReference) {
      throw AppError.conflict(
        'Inpatient pathway root reference is unavailable',
        'INPATIENT_PATHWAY_ROOT_REFERENCE_MISSING',
      );
    }
    await supersedePathwayResourceReferenceTx(tx, {
      tenantId,
      pathwayInstanceId: pathway.id,
      patientUid: String(admission.patient_uid),
      supersededReferenceId: rootReference.id,
      evidenceState: 'completed',
      sourceOutboxEventId: event.id,
      canonicalTimelineEventId: event.payload?.canonical_timeline_event_id || null,
      canonicalAuditEventId: event.payload?.canonical_audit_event_id || null,
      actor,
      occurredAt,
      idempotencyKey: `inpatient:${admission.id}:root-reference:completed`,
      metadata: {
        event_type: event.event_type,
        readmission_linked: admission.prior_admission_id != null,
      },
    });
  }
  return Object.freeze({
    ...boundedOutcome({ consumerKey, generation, event, mode, admission }),
    pathway_instance_id: String(pathway.id),
    pathway_replayed: pathway.replayed === true,
    command_replayed: executed.replayed === true,
  });
}

export async function inpatientPathwayProjectorHandler(context) {
  return projectInpatientPathwayEvent(context);
}

export default inpatientPathwayProjectorHandler;
