import { randomUUID } from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { signDocumentTx } from '../clinical/documentIntegrityService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
import {
  createPendingResultOwnerActionTaskTx,
  createPendingResultTrackingTaskTx,
  reassignPendingResultTasksForAcceptedCoveringHandoffTx,
  settlePendingResultTasksFromDiagnosticActionTx,
  settlePendingResultTasksFromOwnerCrossSignTx,
  supersedePendingResultOwnerActionTaskFromGenerationTx,
} from '../workflow/taskService.js';
import { isRegisteredWorkflowSystemActor } from '../workflow/workflowRuntimeRegistry.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { sha256ClinicalJson } from '../diagnostics/diagnosticClassification.js';
import { isInpatientPendingResultPhysicianRole } from './inpatientPendingResultPolicy.js';

export const INPATIENT_PENDING_RESULT_TYPES = Object.freeze([
  'investigation',
  'lab_result',
  'radiology_order',
  'anatomical_pathology_case',
  'diagnostic_result_generation',
]);

const PENDING_RESULT_TYPE_SET = new Set(INPATIENT_PENDING_RESULT_TYPES);
const CONTACT_EVENT_KINDS = new Set(['attempt', 'outcome']);
const CONTACT_SOURCES = new Set(['manual', 'registered_policy']);
const CONTACT_CHANNELS = new Set([
  'phone',
  'sms',
  'email',
  'patient_portal',
  'in_person',
  'video',
  'other',
]);
const INPATIENT_EVIDENCE_PRIVILEGED_ROLES = new Set([
  'SUPER_ADMIN',
  'MEDICAL_SUPERINTENDENT',
]);
const PENDING_RESULT_CROSS_SIGN_ATTESTATION =
  'I attest that I reviewed this complete signed diagnostic generation and the recorded diagnostic disposition as the named discharge follow-up physician.';
const PENDING_RESULT_CROSS_SIGN_INPUT_KEYS = new Set([
  'generation_id',
  'diagnostic_action_id',
  'generation_snapshot_sha256',
  'attested',
  'idempotencyKey',
]);

function normalizedText(value, label, { required = false, max = 240 } = {}) {
  const text = value == null ? '' : String(value).trim();
  if (required && !text) throw AppError.badRequest(`${label} is required`);
  return text ? text.slice(0, max) : null;
}

function normalizedId(value, label) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return id;
}

function normalizedUuid(value, label, required = true) {
  const id = String(value || '').trim().toLowerCase();
  if (!id && !required) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return id;
}

function normalizedIdempotencyKey(value, code) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!isValidIdempotencyKey(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      code,
    );
  }
  return key;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function currentReferenceClause(alias = 'reference') {
  return `${alias}.evidence_state <> 'superseded'
    AND NOT EXISTS (
      SELECT 1
        FROM care_pathway_resource_references AS successor
       WHERE successor.tenant_id = ${alias}.tenant_id
         AND successor.superseded_reference_id = ${alias}.id
    )`;
}

async function admissionContextTx(tx, tenantId, admissionId, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, status,
            admitting_doctor, attending_doctor, admitted_at,
            source_appointment_id, source_pathway_instance_id, source_handoff_id
       FROM admissions
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
      LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}`,
    tenantId,
    admissionId,
  );
  if (!rows[0]) throw AppError.notFound('Admission not found');
  return rows[0];
}

async function pathwayContextTx(tx, tenantId, admission) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, workflow_run_id, patient_uid, owning_clinician_uid,
            clinical_status
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND pathway_key = $3::text
        AND source_episode_type = 'admission'
        AND source_episode_id = $4::text
      ORDER BY
        CASE clinical_status
          WHEN 'active' THEN 0
          WHEN 'planned' THEN 1
          WHEN 'on_hold' THEN 2
          ELSE 3
        END,
        created_at DESC,
        id DESC
      LIMIT 1`,
    tenantId,
    admission.patient_uid,
    CARE_PATHWAY_KEYS.INPATIENT,
    String(admission.id),
  );
  return rows[0] || null;
}

export async function resolveInpatientPathwayModeTx(tx, tenantId) {
  return resolvePathwayModeTx({
    tx,
    tenantId: requireTenantId(tenantId),
    pathwayKey: CARE_PATHWAY_KEYS.INPATIENT,
  });
}

export async function publishInpatientSourceEventTx({
  tx,
  tenantId,
  eventType,
  admission,
  payload = {},
  aggregateType = 'admission',
  aggregateId = null,
  mode = null,
}) {
  const tid = requireTenantId(tenantId || admission?.tenant_id);
  const pathwayMode = mode || await resolveInpatientPathwayModeTx(tx, tid);
  if (pathwayMode === PATHWAY_MODES.OFF) return null;
  return publishEvent({
    eventType,
    aggregateType,
    aggregateId: aggregateId ?? admission?.id,
    patientUid: admission?.patient_uid || null,
    tenantId: tid,
    tx,
    payload: {
      admission_id: admission?.id == null ? null : Number(admission.id),
      ...payload,
    },
  });
}

const INPATIENT_DIAGNOSTIC_SOURCE_RESOLVERS = Object.freeze({
  investigation: Object.freeze({
    cast: 'integer',
    table: 'investigations',
  }),
  lab_result: Object.freeze({
    cast: 'integer',
    table: 'lab_results',
  }),
  radiology_order: Object.freeze({
    cast: 'integer',
    table: 'radiology_orders',
  }),
  anatomical_pathology_case: Object.freeze({
    cast: 'bigint',
    table: 'ap_cases',
  }),
  diagnostic_result_generation: Object.freeze({
    cast: 'uuid',
    table: 'diagnostic_result_generations',
  }),
});

function normalizedDiagnosticResourceId(resourceType, value) {
  if (resourceType === 'diagnostic_result_generation') {
    return normalizedUuid(value, 'resource_id');
  }
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
    throw AppError.badRequest('resource_id must be a positive identifier');
  }
  return text;
}

/**
 * Publish the single admission diagnostic-lineage source event from the same
 * transaction that persists the authoritative diagnostic row. The closed
 * resolver proves the row's explicit admission, tenant, and patient identity;
 * it never infers admission membership from patient/time proximity.
 */
export async function publishInpatientDiagnosticResourceLinkedTx({
  tx,
  tenantId,
  admissionId,
  patientUid,
  resourceType,
  resourceId,
  canonicalTimelineEventId = null,
  canonicalAuditEventId = null,
  occurredAt = null,
}) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    throw AppError.internal(
      'Inpatient diagnostic lineage requires a transaction client',
      'INPATIENT_DIAGNOSTIC_LINEAGE_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const type = String(resourceType || '').trim().toLowerCase();
  const resolver = INPATIENT_DIAGNOSTIC_SOURCE_RESOLVERS[type];
  if (!resolver || !PENDING_RESULT_TYPE_SET.has(type)) {
    throw AppError.badRequest(
      'resource_type is not supported for inpatient diagnostic lineage',
      'INPATIENT_DIAGNOSTIC_RESOURCE_TYPE_INVALID',
    );
  }
  const admission = await admissionContextTx(
    tx,
    tid,
    normalizedId(admissionId, 'admission_id'),
    { lock: true },
  );
  if (
    type !== 'diagnostic_result_generation'
    && !['admitted', 'transferred'].includes(String(admission.status || '').toLowerCase())
  ) {
    throw AppError.conflict(
      'New diagnostic sources may be linked only while the admission is active',
      'INPATIENT_DIAGNOSTIC_ADMISSION_NOT_ACTIVE',
    );
  }
  const uid = normalizedUuid(patientUid, 'patient_uid');
  if (String(admission.patient_uid).toLowerCase() !== uid) {
    throw AppError.conflict(
      'Diagnostic resource patient does not match the admission',
      'INPATIENT_DIAGNOSTIC_PATIENT_MISMATCH',
    );
  }
  const sourceId = normalizedDiagnosticResourceId(type, resourceId);
  const sourceRows = await tx.$queryRawUnsafe(
    `SELECT resource.id::text AS resource_id
       FROM ${resolver.table} AS resource
      WHERE resource.tenant_id = $1::uuid
        AND resource.id = $2::${resolver.cast}
        AND resource.patient_uid = $3::uuid
        AND resource.admission_id = $4::integer
      LIMIT 1
      FOR SHARE`,
    tid,
    sourceId,
    uid,
    Number(admission.id),
  );
  if (!sourceRows[0]) {
    throw AppError.conflict(
      'Diagnostic resource is not explicitly linked to this admission',
      'INPATIENT_DIAGNOSTIC_ADMISSION_LINEAGE_REQUIRED',
    );
  }

  const timelineId = canonicalTimelineEventId == null
    ? null
    : normalizedUuid(canonicalTimelineEventId, 'canonical_timeline_event_id');
  const auditId = canonicalAuditEventId == null
    ? null
    : normalizedUuid(canonicalAuditEventId, 'canonical_audit_event_id');
  const occurred = occurredAt == null ? new Date() : new Date(occurredAt);
  if (Number.isNaN(occurred.getTime())) {
    throw AppError.badRequest('occurred_at must be a valid timestamp');
  }
  return publishInpatientSourceEventTx({
    tx,
    tenantId: tid,
    eventType: 'admission.diagnostic_resource_linked',
    admission,
    payload: {
      patient_uid: uid,
      resource_type: type,
      resource_id: sourceId,
      canonical_timeline_event_id: timelineId,
      canonical_audit_event_id: auditId,
      occurred_at: occurred.toISOString(),
      admission_lineage_version: 1,
    },
  });
}

async function assertSameTenantPhysicianTx(tx, tenantId, physicianUid, label = 'physician') {
  const uid = normalizedUuid(physicianUid, label);
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, name, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND status = 'active'
        AND is_deleted IS FALSE
        AND deleted_at IS NULL
      LIMIT 1`,
    tenantId,
    uid,
  );
  const row = rows[0];
  if (!row || !isInpatientPendingResultPhysicianRole(row.role)) {
    throw AppError.badRequest(
      `${label} must be an active physician in the admission tenant`,
      'INPATIENT_PRIMARY_PHYSICIAN_INVALID',
    );
  }
  return row;
}

async function currentPrimaryAssignmentTx(tx, tenantId, admissionId, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT assignment.id, assignment.assignment_version,
            assignment.physician_uid, assignment.assignment_source,
            assignment.accepted_handoff_id, assignment.supersedes_assignment_id,
            assignment.assigned_by_uid, assignment.assigned_at,
            physician.name AS physician_name, physician.role AS physician_role,
            physician.is_active AS physician_is_active,
            physician.status AS physician_status,
            physician.is_deleted AS physician_is_deleted,
            physician.deleted_at AS physician_deleted_at
       FROM inpatient_primary_physician_assignments AS assignment
       JOIN users AS physician
         ON physician.tenant_id = assignment.tenant_id
        AND physician.uid = assignment.physician_uid
      WHERE assignment.tenant_id = $1::uuid
        AND assignment.admission_id = $2::integer
      ORDER BY assignment.assignment_version DESC
      LIMIT 1
      ${lock ? 'FOR UPDATE OF assignment' : ''}`,
    tenantId,
    admissionId,
  );
  return rows[0] || null;
}

async function ownerAssignmentConvergenceTx({
  tx,
  tenantId,
  admission,
  pathway,
  assignment,
}) {
  const pathwayOwnerMatches = Boolean(
    pathway?.owning_clinician_uid
    && assignment?.physician_uid
    && String(pathway.owning_clinician_uid).toLowerCase()
      === String(assignment.physician_uid).toLowerCase(),
  );
  const admissionAttendingMatches = Boolean(
    admission?.attending_doctor
    && assignment?.physician_uid
    && String(admission.attending_doctor).toLowerCase()
      === String(assignment.physician_uid).toLowerCase(),
  );
  const assignmentVersion = Number(assignment?.assignment_version || 0);
  let acceptedHandoffApplied = assignmentVersion === 1
    && assignment?.assignment_source !== 'accepted_covering_handoff'
    && !assignment?.accepted_handoff_id
    && !assignment?.supersedes_assignment_id;
  if (
    assignmentVersion > 1
    && assignment?.assignment_source === 'accepted_covering_handoff'
    && assignment?.accepted_handoff_id
    && assignment?.supersedes_assignment_id
    && pathway?.id
  ) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT 1
         FROM care_handoff_instances AS handoff
         JOIN inpatient_primary_physician_assignments AS previous_assignment
           ON previous_assignment.tenant_id = handoff.tenant_id
          AND previous_assignment.id = $6::uuid
          AND previous_assignment.admission_id = $4::integer
          AND previous_assignment.patient_uid = $3::uuid
        WHERE handoff.tenant_id = $1::uuid
          AND handoff.id = $2::uuid
          AND handoff.patient_uid = $3::uuid
          AND handoff.handoff_type = 'covering_clinician_reassignment'
          AND handoff.status = 'accepted'
          AND handoff.accepted_at IS NOT NULL
          AND handoff.sender_uid = previous_assignment.physician_uid
          AND handoff.intended_recipient_uid = $5::uuid
          AND handoff.accepted_by_uid = $5::uuid
          AND handoff.sending_pathway_instance_id = $7::uuid
          AND handoff.receiving_pathway_instance_id = $7::uuid
          AND handoff.source_resource_type = 'care_pathway_instance'
          AND handoff.source_resource_id = $7::uuid::text
        LIMIT 1
        FOR SHARE OF handoff, previous_assignment`,
      tenantId,
      assignment.accepted_handoff_id,
      admission.patient_uid,
      admission.id,
      assignment.physician_uid,
      assignment.supersedes_assignment_id,
      pathway.id,
    );
    acceptedHandoffApplied = rows.length === 1;
  }
  return Object.freeze({
    pathway_owner_matches_assignment: pathwayOwnerMatches,
    admission_attending_matches_assignment: admissionAttendingMatches,
    accepted_handoff_applied: acceptedHandoffApplied,
  });
}

async function assertAccountableEvidenceActorTx({
  tx,
  tenantId,
  admissionId,
  actorUid,
  actorRole,
  assignment = null,
  allowRegisteredSystem = false,
  registeredSystemActor = false,
}) {
  if (allowRegisteredSystem && registeredSystemActor) return assignment;
  const uid = normalizedUuid(actorUid, 'actor uid');
  const current = assignment || await currentPrimaryAssignmentTx(
    tx,
    tenantId,
    admissionId,
  );
  if (
    !current
    || current.physician_is_active !== true
    || current.physician_status !== 'active'
    || current.physician_is_deleted === true
    || current.physician_deleted_at != null
    || !isInpatientPendingResultPhysicianRole(current.physician_role)
  ) {
    throw AppError.forbidden(
      'The current primary physician assignment is not clinically viable',
      'INPATIENT_PRIMARY_PHYSICIAN_UNAVAILABLE',
    );
  }
  const actorRows = await tx.$queryRawUnsafe(
    `SELECT uid, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND status = 'active'
        AND is_deleted IS FALSE
        AND deleted_at IS NULL
      LIMIT 1
      FOR SHARE`,
    tenantId,
    uid,
  );
  const liveActor = actorRows[0];
  if (!liveActor) {
    throw AppError.forbidden(
      'The evidence recorder account is no longer active',
      'INPATIENT_EVIDENCE_ACTOR_UNAVAILABLE',
    );
  }
  const liveRole = String(liveActor.role || '').trim().toUpperCase();
  const claimedRole = String(actorRole || '').trim().toUpperCase();
  if (
    current.physician_uid === uid
    && isInpatientPendingResultPhysicianRole(liveRole)
  ) {
    return current;
  }
  if (
    INPATIENT_EVIDENCE_PRIVILEGED_ROLES.has(liveRole)
    && claimedRole === liveRole
  ) return current;
  throw AppError.forbidden(
    'Not authorized to record inpatient discharge evidence',
    'INPATIENT_EVIDENCE_FORBIDDEN',
  );
}

export async function establishInitialPrimaryPhysicianTx({
  tx,
  admission,
  actorUid,
  actorRole = null,
  mode = null,
}) {
  const tenantId = requireTenantId(admission?.tenant_id);
  const pathwayMode = mode || await resolveInpatientPathwayModeTx(tx, tenantId);
  if (pathwayMode === PATHWAY_MODES.OFF) {
    return { mode: pathwayMode, assignment: null };
  }

  const existing = await currentPrimaryAssignmentTx(tx, tenantId, admission.id);
  if (existing) return { mode: pathwayMode, assignment: existing };

  const source = admission.attending_doctor
    ? 'attending_physician'
    : 'admitting_physician';
  const physicianUid = admission.attending_doctor || admission.admitting_doctor;
  if (!physicianUid) {
    if (pathwayMode === PATHWAY_MODES.ACTIVE) {
      throw AppError.conflict(
        'Active inpatient pathways require an exact named primary physician',
        'INPATIENT_PRIMARY_PHYSICIAN_REQUIRED',
      );
    }
    return { mode: pathwayMode, assignment: null };
  }
  await assertSameTenantPhysicianTx(tx, tenantId, physicianUid, 'primary physician');

  const assignmentId = randomUUID();
  const canonical = await recordCanonicalClinicalEvent({
    tenantId,
    patientUid: admission.patient_uid,
    encounterId: admission.encounter_id,
    eventType: 'admission.primary_physician.assigned',
    eventStatus: 'assigned',
    sourceTable: 'inpatient_primary_physician_assignments',
    sourceId: assignmentId,
    resourceType: 'inpatient_primary_physician_assignments',
    resourceId: assignmentId,
    actorUid,
    actorRole,
    visibleToPatient: false,
    summary: 'Primary physician assigned for inpatient care',
    payload: {
      admission_id: Number(admission.id),
      physician_uid: physicianUid,
      assignment_version: 1,
      assignment_source: source,
    },
    timelineIdempotencyKey: `inpatient-primary:${tenantId}:${admission.id}:1:timeline`,
    auditIdempotencyKey: `inpatient-primary:${tenantId}:${admission.id}:1:audit`,
  }, { db: tx, strict: true });

  let rows = await tx.$queryRawUnsafe(
    `INSERT INTO inpatient_primary_physician_assignments
       (id, tenant_id, admission_id, patient_uid, assignment_version,
        physician_uid, assignment_source, accepted_handoff_id,
        supersedes_assignment_id, assigned_by_uid, assigned_at,
        canonical_timeline_event_id, canonical_audit_event_id,
        idempotency_key, recorded_at)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, 1,
        $5::uuid, $6::text, NULL, NULL, $7::uuid, NOW(),
        $8::uuid, $9::uuid, $10::text, NOW())
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING *`,
    assignmentId,
    tenantId,
    admission.id,
    admission.patient_uid,
    physicianUid,
    source,
    actorUid,
    canonical.timeline.id,
    canonical.audit.id,
    `initial:${admission.id}`,
  );
  if (!rows[0]) {
    rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM inpatient_primary_physician_assignments
        WHERE tenant_id = $1::uuid
          AND idempotency_key = $2::text
        LIMIT 1`,
      tenantId,
      `initial:${admission.id}`,
    );
  }
  return { mode: pathwayMode, assignment: rows[0] };
}

async function acceptedCoveringHandoffTx({
  tx,
  tenantId,
  admission,
  physicianUid,
  handoffId,
  priorPhysicianUid,
  actorUid,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT handoff.id, handoff.accepted_by_uid, handoff.intended_recipient_uid,
            handoff.accepted_at
       FROM care_handoff_instances AS handoff
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = handoff.tenant_id
        AND pathway.id = handoff.sending_pathway_instance_id
        AND pathway.patient_uid = handoff.patient_uid
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.id = $2::uuid
        AND handoff.patient_uid = $3::uuid
        AND handoff.handoff_type = 'covering_clinician_reassignment'
        AND handoff.status = 'accepted'
        AND handoff.accepted_at IS NOT NULL
        AND handoff.sender_uid = $7::uuid
        AND handoff.accepted_by_uid = $4::uuid
        AND handoff.intended_recipient_uid = $4::uuid
        AND handoff.source_resource_type = 'care_pathway_instance'
        AND handoff.source_resource_id = handoff.sending_pathway_instance_id::text
        AND $8::uuid IN (handoff.sender_uid, handoff.accepted_by_uid)
        AND pathway.pathway_key = $5::text
        AND pathway.source_episode_type = 'admission'
        AND pathway.source_episode_id = $6::text
      LIMIT 1
      FOR SHARE OF handoff`,
    tenantId,
    handoffId,
    admission.patient_uid,
    physicianUid,
    CARE_PATHWAY_KEYS.INPATIENT,
    String(admission.id),
    priorPhysicianUid,
    actorUid,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Attending changes in active mode require the accepted covering-clinician handoff for this admission and physician',
      'INPATIENT_ACCEPTED_COVERING_HANDOFF_REQUIRED',
    );
  }
  return rows[0];
}

export async function recordPrimaryPhysicianChangeTx({
  tx,
  admission,
  physicianUid,
  acceptedHandoffId = null,
  actorUid,
  actorRole = null,
  mode = null,
}) {
  const tenantId = requireTenantId(admission?.tenant_id);
  const pathwayMode = mode || await resolveInpatientPathwayModeTx(tx, tenantId);
  if (pathwayMode === PATHWAY_MODES.OFF) {
    return { mode: pathwayMode, assignment: null };
  }
  const physician = await assertSameTenantPhysicianTx(
    tx,
    tenantId,
    physicianUid,
    'attending physician',
  );
  let prior = await currentPrimaryAssignmentTx(tx, tenantId, admission.id, { lock: true });
  if (!prior) {
    const initial = await establishInitialPrimaryPhysicianTx({
      tx,
      admission,
      actorUid,
      actorRole,
      mode: pathwayMode,
    });
    if (initial.assignment?.physician_uid === physician.uid) return initial;
    prior = initial.assignment;
    if (!prior) {
      throw AppError.conflict(
        'A current primary physician assignment is required before reassignment',
        'INPATIENT_PRIMARY_PHYSICIAN_REQUIRED',
      );
    }
  }
  if (
    String(prior.physician_uid || '').toLowerCase()
    === String(physician.uid || '').toLowerCase()
  ) {
    return {
      mode: pathwayMode,
      assignment: prior,
      idempotent_replay: true,
    };
  }

  if (!acceptedHandoffId) {
    if (pathwayMode === PATHWAY_MODES.ACTIVE) {
      throw AppError.conflict(
        'Attending changes in active mode require an accepted covering-clinician handoff',
        'INPATIENT_ACCEPTED_COVERING_HANDOFF_REQUIRED',
      );
    }
    return { mode: pathwayMode, assignment: prior, evidence_suppressed: true };
  }
  const handoffUid = normalizedUuid(acceptedHandoffId, 'accepted_handoff_id');
  await acceptedCoveringHandoffTx({
    tx,
    tenantId,
    admission,
    physicianUid: physician.uid,
    handoffId: handoffUid,
    priorPhysicianUid: prior.physician_uid,
    actorUid,
  });

  const version = Number(prior?.assignment_version || 0) + 1;
  const assignmentId = randomUUID();
  const canonical = await recordCanonicalClinicalEvent({
    tenantId,
    patientUid: admission.patient_uid,
    encounterId: admission.encounter_id,
    eventType: 'admission.primary_physician.reassigned',
    eventStatus: 'accepted',
    sourceTable: 'inpatient_primary_physician_assignments',
    sourceId: assignmentId,
    resourceType: 'inpatient_primary_physician_assignments',
    resourceId: assignmentId,
    actorUid,
    actorRole,
    visibleToPatient: false,
    summary: 'Primary physician coverage accepted',
    payload: {
      admission_id: Number(admission.id),
      physician_uid: physician.uid,
      assignment_version: version,
      accepted_handoff_id: handoffUid,
      supersedes_assignment_id: prior?.id || null,
    },
    timelineIdempotencyKey: `inpatient-primary:${tenantId}:${admission.id}:${version}:timeline`,
    auditIdempotencyKey: `inpatient-primary:${tenantId}:${admission.id}:${version}:audit`,
  }, { db: tx, strict: true });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO inpatient_primary_physician_assignments
       (id, tenant_id, admission_id, patient_uid, assignment_version,
        physician_uid, assignment_source, accepted_handoff_id,
        supersedes_assignment_id, assigned_by_uid, assigned_at,
        canonical_timeline_event_id, canonical_audit_event_id,
        idempotency_key, recorded_at)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::integer,
        $6::uuid, 'accepted_covering_handoff', $7::uuid,
        $8::uuid, $9::uuid, NOW(), $10::uuid, $11::uuid, $12::text, NOW())
     RETURNING *`,
    assignmentId,
    tenantId,
    admission.id,
    admission.patient_uid,
    version,
    physician.uid,
    handoffUid,
    prior.id,
    actorUid,
    canonical.timeline.id,
    canonical.audit.id,
    `covering:${handoffUid}`,
  );
  const liveHandoffs = await tx.$queryRawUnsafe(
    `SELECT id, task_id
       FROM discharge_pending_result_handoffs
      WHERE tenant_id = $1::uuid
        AND admission_id = $2::integer
        AND patient_uid = $3::uuid
        AND handoff_state IN ('pending', 'result_available')
      FOR UPDATE`,
    tenantId,
    admission.id,
    admission.patient_uid,
  );
  if (liveHandoffs.length) {
    await reassignPendingResultTasksForAcceptedCoveringHandoffTx({
      tenantId,
      admissionId: admission.id,
      patientUid: admission.patient_uid,
      priorAssignmentId: prior.id,
      assignmentId: rows[0].id,
      acceptedHandoffId: handoffUid,
      priorPhysicianUid: prior.physician_uid,
      physicianUid: physician.uid,
      actorUid,
      tx,
    });
    await tx.$queryRawUnsafe(
      `UPDATE discharge_pending_result_handoffs
          SET primary_physician_assignment_id = $4::uuid,
              named_physician_uid = $5::uuid,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::integer
          AND patient_uid = $3::uuid
          AND handoff_state IN ('pending', 'result_available')`,
      tenantId,
      admission.id,
      admission.patient_uid,
      rows[0].id,
      physician.uid,
    );
  }
  return { mode: pathwayMode, assignment: rows[0] };
}

async function listCurrentReferencesTx(tx, tenantId, admission, pathway) {
  if (!pathway) return [];
  return tx.$queryRawUnsafe(
    `SELECT reference.id, reference.resource_type, reference.resource_id,
            reference.relationship_kind, reference.evidence_state,
            reference.accepted_owner_uid, reference.task_id,
            reference.handoff_id, reference.metadata, reference.recorded_at
       FROM care_pathway_resource_references AS reference
      WHERE reference.tenant_id = $1::uuid
        AND reference.pathway_instance_id = $2::uuid
        AND reference.patient_uid = $3::uuid
        AND reference.relationship_kind = 'child_action'
        AND reference.resource_type = ANY($4::text[])
        AND ${currentReferenceClause('reference')}
      ORDER BY reference.recorded_at ASC, reference.id ASC`,
    tenantId,
    pathway.id,
    admission.patient_uid,
    INPATIENT_PENDING_RESULT_TYPES,
  );
}

async function loadAdmissionSourceRowsTx(tx, tenantId, admission) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM (
         SELECT 'investigation'::text AS source_type,
                source.id::text AS source_id,
                source.status::text AS status,
                source.test_name::text AS patient_safe_label,
                UPPER(COALESCE(source.status, '')) IN ('COMPLETED', 'CANCELLED')
                  AS terminal,
                FALSE AS requires_safety_action,
                FALSE AS safety_action_complete
           FROM investigations AS source
          WHERE source.tenant_id = $1::uuid
            AND source.admission_id = $2::integer
            AND source.patient_uid = $3::uuid
         UNION ALL
         SELECT 'lab_result',
                source.id::text,
                source.status::text,
                source.test_name::text,
                (
                  LOWER(COALESCE(source.status, '')) IN
                    ('final', 'corrected', 'amended', 'verified')
                  AND source.signed_off_at IS NOT NULL
                ),
                FALSE,
                FALSE
           FROM lab_results AS source
          WHERE source.tenant_id = $1::uuid
            AND source.admission_id = $2::integer
            AND source.patient_uid = $3::uuid
         UNION ALL
         SELECT 'radiology_order',
                source.id::text,
                source.status::text,
                TRIM(CONCAT_WS(' ', source.modality, source.body_part)),
                (
                  LOWER(COALESCE(source.status, '')) = 'cancelled'
                  OR source.report_signed_off_at IS NOT NULL
                ),
                FALSE,
                FALSE
           FROM radiology_orders AS source
          WHERE source.tenant_id = $1::uuid
            AND source.admission_id = $2::integer
            AND source.patient_uid = $3::uuid
         UNION ALL
         SELECT 'anatomical_pathology_case',
                source.id::text,
                source.status::text,
                'Anatomical pathology case ' || source.case_number,
                LOWER(COALESCE(source.status, '')) IN
                  ('signed', 'signed_out', 'amended', 'cancelled', 'closed'),
                FALSE,
                FALSE
           FROM ap_cases AS source
          WHERE source.tenant_id = $1::uuid
            AND source.admission_id = $2::integer
            AND source.patient_uid = $3::uuid
         UNION ALL
         SELECT 'diagnostic_result_generation',
                source.id::text,
                source.classification::text,
                'Diagnostic result',
                (
                  source.classification = 'normal'
                  OR EXISTS (
                    SELECT 1
                      FROM diagnostic_result_actions AS action
                     WHERE action.tenant_id = source.tenant_id
                       AND action.generation_id = source.id
                       AND action.action_kind IN (
                         'doctor_disposition',
                         'generation_superseded'
                       )
                  )
                ),
                source.classification IN ('critical', 'abnormal', 'indeterminate'),
                EXISTS (
                  SELECT 1
                    FROM diagnostic_result_actions AS action
                   WHERE action.tenant_id = source.tenant_id
                     AND action.generation_id = source.id
                     AND action.action_kind IN (
                       'doctor_disposition',
                       'generation_superseded'
                     )
                )
           FROM diagnostic_result_generations AS source
          WHERE source.tenant_id = $1::uuid
            AND source.admission_id = $2::integer
            AND source.patient_uid = $3::uuid
       ) AS exact_source
      ORDER BY exact_source.source_type, exact_source.source_id
      LIMIT 501`,
    tenantId,
    admission.id,
    admission.patient_uid,
  );
  if (rows.length > 500) {
    throw AppError.conflict(
      'Inpatient diagnostic lineage exceeds its bounded collector batch',
      'INPATIENT_DIAGNOSTIC_LINEAGE_LIMIT_EXCEEDED',
    );
  }
  return new Map(rows.map((row) => [
    `${row.source_type}:${row.source_id}`,
    row,
  ]));
}

async function listHandoffsTx(tx, tenantId, admissionId) {
  return tx.$queryRawUnsafe(
    `SELECT handoff.*, physician.name AS physician_name,
            physician.role AS physician_role
       FROM discharge_pending_result_handoffs AS handoff
       JOIN users AS physician
         ON physician.tenant_id = handoff.tenant_id
        AND physician.uid = handoff.named_physician_uid
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.admission_id = $2::integer
        AND handoff.handoff_state <> 'superseded'
      ORDER BY handoff.created_at ASC, handoff.id ASC`,
    tenantId,
    admissionId,
  );
}

function shapePendingResult(reference, source, handoff, assignment) {
  const blockerCodes = [];
  if (!source) blockerCodes.push('PENDING_RESULT_SOURCE_UNRESOLVED');
  if (source?.requires_safety_action === true && source?.safety_action_complete !== true) {
    blockerCodes.push('DIAGNOSTIC_SAFETY_ACTION_REQUIRED');
  }
  if (!assignment) blockerCodes.push('PRIMARY_PHYSICIAN_ASSIGNMENT_MISSING');
  if (!handoff) {
    blockerCodes.push('PENDING_RESULT_HANDOFF_MISSING');
  } else {
    if (String(handoff.primary_physician_assignment_id) !== String(assignment?.id || '')) {
      blockerCodes.push('PENDING_RESULT_ASSIGNMENT_STALE');
    }
    if (String(handoff.named_physician_uid) !== String(assignment?.physician_uid || '')) {
      blockerCodes.push('PENDING_RESULT_NAMED_OWNER_INVALID');
    }
    if (!handoff.discharge_summary_id
        || !handoff.summary_included_at
        || !handoff.summary_inclusion_timeline_event_id) {
      blockerCodes.push('PENDING_RESULT_SUMMARY_INCLUSION_MISSING');
    }
  }
  return {
    resource_reference_id: reference.id,
    source_type: reference.resource_type,
    source_id: reference.resource_id,
    patient_safe_label: handoff?.patient_safe_label
      || source?.patient_safe_label
      || 'Pending diagnostic result',
    current_status: source?.status || 'unresolved',
    exact_lineage: Boolean(source),
    evidence_state: reference.evidence_state,
    primary_physician: assignment
      ? {
          assignment_id: assignment.id,
          uid: assignment.physician_uid,
          display_name: assignment.physician_name,
          role: assignment.physician_role,
        }
      : null,
    named_owner: assignment
      ? {
          uid: assignment.physician_uid,
          display_name: assignment.physician_name,
          role: assignment.physician_role,
        }
      : null,
    handoff: handoff
      ? {
          id: handoff.id,
          state: handoff.handoff_state,
          task_id: Number(handoff.task_id),
          named_physician_uid: handoff.named_physician_uid,
          named_physician_name: handoff.physician_name,
          summary_id: handoff.discharge_summary_id == null
            ? null
            : Number(handoff.discharge_summary_id),
          summary_included_at: handoff.summary_included_at,
          resolution_generation_id: handoff.resolution_generation_id,
        }
      : null,
    handoff_complete_warning: Boolean(handoff) && blockerCodes.length === 0,
    handoff_complete: Boolean(handoff) && blockerCodes.length === 0,
    summary_included: Boolean(
      handoff?.discharge_summary_id
      && handoff?.summary_included_at
      && handoff?.summary_inclusion_timeline_event_id
    ),
    blocking: blockerCodes.length > 0,
    blocker_codes: blockerCodes,
  };
}

function shapePendingResultHandoffMutation(row) {
  if (!row) return null;
  return {
    id: row.id,
    admission_id: Number(row.admission_id),
    resource_reference_id: row.resource_reference_id,
    source_type: row.source_type,
    source_id: row.source_id,
    patient_safe_label: row.patient_safe_label,
    result_status: row.result_status,
    primary_physician_assignment_id: row.primary_physician_assignment_id,
    named_physician_uid: row.named_physician_uid,
    task_id: row.task_id,
    handoff_state: row.handoff_state,
    discharge_summary_id: row.discharge_summary_id == null
      ? null
      : Number(row.discharge_summary_id),
    summary_included_at: row.summary_included_at || null,
    resolution_generation_id: row.resolution_generation_id || null,
    resolution_action_id: row.resolution_action_id || null,
    resolved_at: row.resolved_at || null,
    resolved_by_uid: row.resolved_by_uid || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function shapePendingResultActionTask(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    task_kind: row.task_kind,
    title: row.title,
    description: row.description || null,
    status: row.status,
    assigned_to_uid: row.assigned_to_uid || null,
    related_resource_type: row.related_resource_type,
    related_resource_id: row.related_resource_id,
    parent_task_id: row.parent_task_id == null ? null : Number(row.parent_task_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function shapePendingResultOwnerAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    handoff_id: row.handoff_id,
    generation_id: row.generation_id,
    predecessor_generation_id: row.predecessor_generation_id || null,
    predecessor_owner_action_id: row.predecessor_owner_action_id || null,
    predecessor_resolution_action_id: row.predecessor_resolution_action_id || null,
    rearm_source_action_id: row.rearm_source_action_id || null,
    task_id: Number(row.task_id),
    owner_uid: row.owner_uid,
    recorded_at: row.recorded_at,
  };
}

function pendingResultActionTaskResourceId({
  handoffId,
  generationId,
  predecessorOwnerActionId = null,
  rearmSourceActionId = null,
}) {
  return rearmSourceActionId
    ? `${handoffId}:${generationId}:${predecessorOwnerActionId}`
    : `${handoffId}:${generationId}`;
}

function shapePostDischargeContact(row) {
  if (!row) return null;
  return {
    id: row.id,
    admission_id: Number(row.admission_id),
    event_kind: row.event_kind,
    contact_source: row.contact_source,
    contact_channel: row.contact_channel,
    outcome_code: row.outcome_code || null,
    patient_safe_summary: row.patient_safe_summary || null,
    policy_rule_code: row.policy_rule_code || null,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
  };
}

function assertPostDischargeContactReplay(row, {
  admissionId,
  patientUid,
  eventKind,
  contactSource,
  channel,
  outcomeCode,
  policyRuleCode,
  patientSafeSummary,
  actorUid,
  systemKey,
  hasExplicitOccurredAt,
  occurredAt,
}) {
  if (
    !row
    || Number(row.admission_id) !== admissionId
    || row.patient_uid !== patientUid
    || row.event_kind !== eventKind
    || row.contact_source !== contactSource
    || row.contact_channel !== channel
    || (row.outcome_code || null) !== outcomeCode
    || (row.policy_rule_code || null) !== policyRuleCode
    || (row.patient_safe_summary || null) !== patientSafeSummary
    || (row.recorded_by_uid || null) !== actorUid
    || (row.recorded_by_system_key || null) !== systemKey
    || (
      hasExplicitOccurredAt
      && new Date(row.occurred_at).getTime() !== occurredAt.getTime()
    )
  ) {
    throw AppError.conflict(
      'Post-discharge contact idempotency key was reused with different content',
      'POST_DISCHARGE_CONTACT_IDEMPOTENCY_CONFLICT',
    );
  }
  return row;
}

function assertExactPendingResultActionTask(task, {
  handoff,
  generationId,
  predecessorGenerationId = null,
  predecessorOwnerActionId = null,
  predecessorResolutionActionId = null,
  rearmSourceActionId = null,
  requireLive = true,
}) {
  const liveStatuses = new Set(['open', 'in_progress', 'blocked', 'overdue']);
  if (
    !task
    || task.task_kind !== 'review'
    || task.related_resource_type !== 'discharge_pending_result_action'
    || task.related_resource_id !== pendingResultActionTaskResourceId({
      handoffId: handoff.id,
      generationId,
      predecessorOwnerActionId,
      rearmSourceActionId,
    })
    || Number(task.parent_task_id) !== Number(handoff.task_id)
    || task.patient_uid !== handoff.patient_uid
    || task.assigned_to_uid !== handoff.named_physician_uid
    || task.assigned_to_role != null
    || task.created_by == null
    || task.metadata?.task_contract !== 'discharge_pending_result_action_v1'
    || String(task.metadata?.handoff_id || '') !== String(handoff.id)
    || String(task.metadata?.generation_id || '') !== String(generationId)
    || String(task.metadata?.predecessor_generation_id || '')
      !== String(predecessorGenerationId || '')
    || String(task.metadata?.predecessor_owner_action_id || '')
      !== String(predecessorOwnerActionId || '')
    || String(task.metadata?.predecessor_resolution_action_id || '')
      !== String(predecessorResolutionActionId || '')
    || String(task.metadata?.rearm_source_action_id || '')
      !== String(rearmSourceActionId || '')
    || (requireLive && !liveStatuses.has(task.status))
  ) {
    throw AppError.conflict(
      'The result-available action task does not match the exact handoff, owner, and generation',
      'INPATIENT_PENDING_RESULT_ACTION_TASK_CONFLICT',
    );
  }
  return task;
}

async function loadExactPendingResultActionTaskTx({
  tx,
  tenantId,
  handoff,
  generationId,
  predecessorGenerationId = null,
  predecessorOwnerActionId = null,
  predecessorResolutionActionId = null,
  rearmSourceActionId = null,
  requireLive = true,
}) {
  const resourceId = pendingResultActionTaskResourceId({
    handoffId: handoff.id,
    generationId,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
  });
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, workflow_run_id, workflow_step_id, parent_task_id,
            task_kind, title, description, patient_uid,
            related_resource_type, related_resource_id, status,
            assigned_to_uid, assigned_to_role, created_by,
            metadata, created_at, updated_at
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = 'discharge_pending_result_action'
        AND related_resource_id = $2::text
      ORDER BY id ASC
      LIMIT 2
      FOR SHARE`,
    tenantId,
    resourceId,
  );
  if (rows.length > 1) {
    throw AppError.conflict(
      'More than one action task exists for the exact pending-result generation',
      'INPATIENT_PENDING_RESULT_ACTION_TASK_CONFLICT',
    );
  }
  return rows[0]
    ? assertExactPendingResultActionTask(rows[0], {
        handoff,
        generationId,
        predecessorGenerationId,
        predecessorOwnerActionId,
        predecessorResolutionActionId,
        rearmSourceActionId,
        requireLive,
      })
    : null;
}

async function ensurePendingResultActionTaskTx({
  tx,
  tenantId,
  handoff,
  generationId,
  createdBy,
  predecessorGenerationId = null,
  predecessorOwnerActionId = null,
  predecessorResolutionActionId = null,
  rearmSourceActionId = null,
}) {
  const provenanceUid = normalizedUuid(createdBy, 'result generation actor uid');
  const existing = await loadExactPendingResultActionTaskTx({
    tx,
    tenantId,
    handoff,
    generationId,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
  });
  if (existing) return existing;
  const created = await createPendingResultOwnerActionTaskTx({
    tenantId,
    handoffId: handoff.id,
    generationId,
    admissionId: handoff.admission_id,
    patientUid: handoff.patient_uid,
    parentTaskId: handoff.task_id,
    patientSafeLabel: handoff.patient_safe_label,
    sourceType: handoff.source_type,
    sourceId: handoff.source_id,
    ownerUid: handoff.named_physician_uid,
    createdBy: provenanceUid,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
    rearmReason: rearmSourceActionId ? 'doctor_reopened'
      : predecessorGenerationId ? 'corrected_generation' : null,
    tx,
  });
  if (created) {
    return assertExactPendingResultActionTask(created, {
      handoff,
      generationId,
      predecessorGenerationId,
      predecessorOwnerActionId,
      predecessorResolutionActionId,
      rearmSourceActionId,
    });
  }
  const winner = await loadExactPendingResultActionTaskTx({
    tx,
    tenantId,
    handoff,
    generationId,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
  });
  if (!winner) {
    throw AppError.conflict(
      'The result-available action task could not be proven after a concurrent insert',
      'INPATIENT_PENDING_RESULT_ACTION_TASK_CONFLICT',
    );
  }
  return winner;
}

async function appendPendingResultAvailableEvidenceTx({
  tx,
  tenantId,
  admission,
  handoff,
  generationId,
  predecessorGenerationId = null,
  predecessorOwnerActionId = null,
  predecessorResolutionActionId = null,
  rearmSourceActionId = null,
  actionTask,
  actorUid,
  actorRole,
}) {
  const rearmed = Boolean(predecessorOwnerActionId);
  const evidenceKey = rearmSourceActionId
    ? `${generationId}:reopen:${rearmSourceActionId}`
    : generationId;
  const canonical = await recordCanonicalClinicalEvent({
    tenantId,
    patientUid: admission.patient_uid,
    encounterId: admission.encounter_id,
    eventType: 'discharge.pending_result_available',
    eventStatus: rearmed ? 'result_rearmed' : 'result_available',
    sourceTable: 'discharge_pending_result_handoffs',
    sourceId: handoff.id,
    resourceType: 'diagnostic_result_generation',
    resourceId: generationId,
    actorUid,
    actorRole,
    visibleToPatient: false,
    summary: 'Pending result became available to its named physician',
    payload: {
      admission_id: Number(admission.id),
      handoff_id: handoff.id,
      generation_id: generationId,
      predecessor_generation_id: predecessorGenerationId,
      predecessor_owner_action_id: predecessorOwnerActionId,
      predecessor_resolution_action_id: predecessorResolutionActionId,
      rearm_source_action_id: rearmSourceActionId,
      action_task_id: Number(actionTask.id),
      tracking_task_id: Number(handoff.task_id),
    },
    timelineIdempotencyKey:
      `pending-result-available:${tenantId}:${handoff.id}:${evidenceKey}:timeline`,
    auditIdempotencyKey:
      `pending-result-available:${tenantId}:${handoff.id}:${evidenceKey}:audit`,
  }, { db: tx, strict: true });
  const event = await publishEvent({
    eventType: 'discharge.pending_result_available',
    aggregateType: 'discharge_pending_result_handoff',
    aggregateId: handoff.id,
    patientUid: admission.patient_uid,
    tenantId,
    tx,
    payload: {
      admission_id: Number(admission.id),
      handoff_id: handoff.id,
      generation_id: generationId,
      predecessor_generation_id: predecessorGenerationId,
      predecessor_owner_action_id: predecessorOwnerActionId,
      predecessor_resolution_action_id: predecessorResolutionActionId,
      rearm_source_action_id: rearmSourceActionId,
      action_task_id: Number(actionTask.id),
      tracking_task_id: Number(handoff.task_id),
      canonical_timeline_event_id: canonical.timeline.id,
      canonical_audit_event_id: canonical.audit.id,
      admission_lineage_version: 1,
    },
  });
  if (!event?.id) {
    throw AppError.internal(
      'Pending-result availability event could not be appended',
      'INPATIENT_PENDING_RESULT_AVAILABLE_EVENT_REQUIRED',
    );
  }
  return { canonical, event };
}

function assertPendingResultOwnerAction(row, {
  handoff,
  generationId,
  predecessorGenerationId,
  predecessorOwnerActionId,
  predecessorResolutionActionId,
  rearmSourceActionId,
  actionTask,
  evidence,
}) {
  if (
    !row
    || String(row.handoff_id) !== String(handoff.id)
    || Number(row.admission_id) !== Number(handoff.admission_id)
    || String(row.patient_uid) !== String(handoff.patient_uid)
    || String(row.generation_id) !== String(generationId)
    || String(row.predecessor_generation_id || '')
      !== String(predecessorGenerationId || '')
    || String(row.predecessor_owner_action_id || '')
      !== String(predecessorOwnerActionId || '')
    || String(row.predecessor_resolution_action_id || '')
      !== String(predecessorResolutionActionId || '')
    || String(row.rearm_source_action_id || '')
      !== String(rearmSourceActionId || '')
    || Number(row.task_id) !== Number(actionTask.id)
    || String(row.owner_uid) !== String(handoff.named_physician_uid)
    || String(row.source_outbox_event_id) !== String(evidence.event.id)
    || String(row.canonical_timeline_event_id)
      !== String(evidence.canonical.timeline.id)
    || String(row.canonical_audit_event_id)
      !== String(evidence.canonical.audit.id)
  ) {
    throw AppError.conflict(
      'Pending-result owner-action evidence does not match its exact handoff and generation',
      'INPATIENT_PENDING_RESULT_OWNER_ACTION_CONFLICT',
    );
  }
  return row;
}

async function appendPendingResultOwnerActionTx({
  tx,
  tenantId,
  handoff,
  generationId,
  predecessorGenerationId = null,
  predecessorOwnerActionId = null,
  predecessorResolutionActionId = null,
  rearmSourceActionId = null,
  actionTask,
  evidence,
}) {
  const id = randomUUID();
  const idempotencyKey = rearmSourceActionId
    ? `pending-result-owner-action:${handoff.id}:${generationId}:reopen:${rearmSourceActionId}`
    : `pending-result-owner-action:${handoff.id}:${generationId}`;
  let rows = await tx.$queryRawUnsafe(
    `INSERT INTO discharge_pending_result_owner_actions
       (id, tenant_id, handoff_id, admission_id, patient_uid,
         generation_id, predecessor_generation_id,
         predecessor_owner_action_id, predecessor_resolution_action_id,
         rearm_source_action_id, task_id, owner_uid,
        source_outbox_event_id, canonical_timeline_event_id,
        canonical_audit_event_id, recorded_at, idempotency_key, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
         $11::integer, $12::uuid,
         $13::bigint, $14::uuid, $15::uuid, NOW(), $16::text, $17::jsonb)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING *`,
    id,
    tenantId,
    handoff.id,
    handoff.admission_id,
    handoff.patient_uid,
    generationId,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
    Number(actionTask.id),
    handoff.named_physician_uid,
    evidence.event.id,
    evidence.canonical.timeline.id,
    evidence.canonical.audit.id,
    idempotencyKey,
    json({
      source_type: handoff.source_type,
      source_id: handoff.source_id,
      relationship_kind: 'child_action',
      correlation_contract: 'pending_result_owner_action_v2',
      predecessor_owner_action_id: predecessorOwnerActionId,
      predecessor_resolution_action_id: predecessorResolutionActionId,
      rearm_source_action_id: rearmSourceActionId,
    }),
  );
  if (!rows[0]) {
    rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM discharge_pending_result_owner_actions
        WHERE tenant_id = $1::uuid
          AND idempotency_key = $2::text
        LIMIT 2
        FOR SHARE`,
      tenantId,
      idempotencyKey,
    );
  }
  if (rows.length !== 1) {
    throw AppError.conflict(
      'Pending-result owner-action evidence could not be proven after replay',
      'INPATIENT_PENDING_RESULT_OWNER_ACTION_CONFLICT',
    );
  }
  return assertPendingResultOwnerAction(rows[0], {
    handoff,
    generationId,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
    actionTask,
    evidence,
  });
}

function shapeUnprojectedSource(source, assignment) {
  const blockerCodes = ['PENDING_RESULT_REFERENCE_MISSING'];
  if (source.requires_safety_action === true && source.safety_action_complete !== true) {
    blockerCodes.push('DIAGNOSTIC_SAFETY_ACTION_REQUIRED');
  }
  return {
    resource_reference_id: null,
    source_type: source.source_type,
    source_id: source.source_id,
    patient_safe_label: source.patient_safe_label || 'Pending diagnostic result',
    current_status: source.status || 'unresolved',
    exact_lineage: true,
    evidence_state: null,
    primary_physician: assignment
      ? {
          assignment_id: assignment.id,
          uid: assignment.physician_uid,
          display_name: assignment.physician_name,
          role: assignment.physician_role,
        }
      : null,
    named_owner: assignment
      ? {
          uid: assignment.physician_uid,
          display_name: assignment.physician_name,
          role: assignment.physician_role,
        }
      : null,
    handoff: null,
    handoff_complete_warning: false,
    handoff_complete: false,
    summary_included: false,
    blocking: true,
    blocker_codes: blockerCodes,
  };
}

async function collectPendingResultsTx(tx, tenantId, admission, pathway, assignment) {
  const [references, rootRows, sourceRows] = await Promise.all([
    listCurrentReferencesTx(tx, tenantId, admission, pathway),
    pathway
      ? tx.$queryRawUnsafe(
        `SELECT reference.id
           FROM care_pathway_resource_references AS reference
          WHERE reference.tenant_id = $1::uuid
            AND reference.pathway_instance_id = $2::uuid
            AND reference.patient_uid = $3::uuid
            AND reference.resource_type = 'admission'
            AND reference.resource_id = $4::text
            AND reference.relationship_kind = 'closure_evidence'
            AND ${currentReferenceClause('reference')}
          LIMIT 1`,
        tenantId,
        pathway.id,
        admission.patient_uid,
        String(admission.id),
      )
      : [],
    loadAdmissionSourceRowsTx(tx, tenantId, admission),
  ]);
  const handoffs = await listHandoffsTx(tx, tenantId, admission.id);
  const handoffByReference = new Map(
    handoffs.map((handoff) => [String(handoff.resource_reference_id), handoff]),
  );
  const items = references
    .map((reference) => {
      const source = sourceRows.get(`${reference.resource_type}:${reference.resource_id}`) || null;
      if (source?.terminal === true) {
        return null;
      }
      return shapePendingResult(
        reference,
        source,
        handoffByReference.get(String(reference.id)) || null,
        assignment,
      );
    })
    .filter(Boolean);
  const referenceKeys = new Set(
    references.map((reference) => `${reference.resource_type}:${reference.resource_id}`),
  );
  const missingReferences = [...sourceRows.entries()]
    .filter(([key]) => !referenceKeys.has(key))
    .map(([, source]) => shapeUnprojectedSource(source, assignment));
  const unresolvedReferences = references.filter(
    (reference) => !sourceRows.has(`${reference.resource_type}:${reference.resource_id}`),
  );
  items.push(...missingReferences);
  return {
    projection_ready: Boolean(
      pathway
      && rootRows[0]
      && missingReferences.length === 0
      && unresolvedReferences.length === 0
    ),
    pathway_instance_id: pathway?.id || null,
    references_found: references.length,
    references_expected: sourceRows.size,
    missing_reference_count: missingReferences.length,
    unresolved_reference_count: unresolvedReferences.length,
    reconciliation_debt: [
      ...missingReferences.map((item) => ({
        code: 'PENDING_RESULT_REFERENCE_MISSING',
        source_type: item.source_type,
        source_id: item.source_id,
      })),
      ...unresolvedReferences.map((reference) => ({
        code: 'PENDING_RESULT_SOURCE_UNRESOLVED',
        source_type: reference.resource_type,
        source_id: reference.resource_id,
      })),
    ],
    items,
  };
}

async function activeDischargeEvidenceTx(tx, tenantId, admission, pendingProjection) {
  const [summaryRows, recRows, followupRows, exceptionRows] = await Promise.all([
    tx.$queryRawUnsafe(
      `SELECT summary.id, summary.status, summary.signed_by, summary.signed_at,
              closure.patient_guardian_instructions_section_id,
              closure.escalation_contact_section_id,
              closure.required_equipment_home_care_section_id,
              closure.discharge_destination_section_id,
              closure.transport_plan_section_id
         FROM discharge_summaries AS summary
         LEFT JOIN LATERAL (
           SELECT
             MAX(section.id) FILTER (
               WHERE LOWER(section.section_key) = 'patient_guardian_instructions'
                 AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                 AND STRPOS(LOWER(section.body), '[placeholder') = 0
             ) AS patient_guardian_instructions_section_id,
             MAX(section.id) FILTER (
               WHERE LOWER(section.section_key) = 'escalation_contact'
                 AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                 AND STRPOS(LOWER(section.body), '[placeholder') = 0
             ) AS escalation_contact_section_id,
             MAX(section.id) FILTER (
               WHERE LOWER(section.section_key) = 'required_equipment_home_care'
                 AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                 AND STRPOS(LOWER(section.body), '[placeholder') = 0
             ) AS required_equipment_home_care_section_id,
             MAX(section.id) FILTER (
               WHERE LOWER(section.section_key) = 'discharge_destination'
                 AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                 AND STRPOS(LOWER(section.body), '[placeholder') = 0
             ) AS discharge_destination_section_id,
             MAX(section.id) FILTER (
               WHERE LOWER(section.section_key) = 'transport_plan'
                 AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                 AND STRPOS(LOWER(section.body), '[placeholder') = 0
             ) AS transport_plan_section_id
            FROM discharge_summary_sections AS section
           WHERE section.discharge_summary_id = summary.id
         ) AS closure ON TRUE
        WHERE summary.tenant_id = $1::uuid
          AND summary.admission_id = $2::integer
          AND summary.patient_uid = $3::uuid
          AND summary.status IN ('signed', 'delivered')
          AND summary.signed_by IS NOT NULL
          AND summary.signed_at IS NOT NULL
        ORDER BY summary.signed_at DESC, summary.id DESC
        LIMIT 1`,
      tenantId,
      admission.id,
      admission.patient_uid,
    ),
    tx.$queryRawUnsafe(
      `SELECT id, status, completed_by, completed_at
         FROM medication_reconciliations
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::integer
          AND patient_uid = $3::uuid
          AND rec_type = 'discharge'
          AND status = 'completed'
          AND completed_by IS NOT NULL
          AND completed_at IS NOT NULL
          AND jsonb_typeof(metadata -> 'take_home_list') = 'array'
        ORDER BY completed_at DESC, id DESC
        LIMIT 1`,
      tenantId,
      admission.id,
      admission.patient_uid,
    ),
    tx.$queryRawUnsafe(
      `SELECT plan.id, plan.appointment_id, plan.status,
              plan.appointment_status, appointment.status AS booked_status
         FROM follow_up_plans AS plan
         JOIN appointments AS appointment
           ON appointment.tenant_id = plan.tenant_id
          AND appointment.id = plan.appointment_id
         JOIN users AS appointment_patient
           ON appointment_patient.tenant_id = appointment.tenant_id
          AND appointment_patient.id = appointment.patient_id
          AND appointment_patient.uid = plan.patient_uid
        WHERE plan.tenant_id = $1::uuid
          AND plan.patient_uid = $2::uuid
          AND plan.origin_kind = 'admission'
          AND plan.origin_resource_type = 'admission'
          AND plan.origin_resource_id = $3::text
          AND plan.appointment_id IS NOT NULL
          AND plan.status IN ('open', 'scheduled')
          AND LOWER(COALESCE(plan.appointment_status, '')) NOT IN
              ('cancelled', 'canceled', 'no_show')
          AND UPPER(COALESCE(appointment.status, '')) NOT IN
              ('CANCELLED', 'CANCELED', 'NO_SHOW')
        ORDER BY plan.created_at DESC, plan.id DESC
        LIMIT 1`,
      tenantId,
      admission.patient_uid,
      String(admission.id),
    ),
    tx.$queryRawUnsafe(
      `SELECT timeline.id AS timeline_event_id, audit.id AS audit_event_id,
              timeline.payload ->> 'reason' AS reason
         FROM clinical_timeline_events AS timeline
         JOIN clinical_audit_events AS audit
           ON audit.tenant_id = timeline.tenant_id
          AND audit.patient_uid = timeline.patient_uid
          AND audit.action = 'discharge.follow_up_exception_recorded'
          AND audit.resource_type = 'admission'
          AND audit.resource_id = $3::text
          AND NULLIF(audit.metadata ->> 'reason', '') IS NOT NULL
        WHERE timeline.tenant_id = $1::uuid
          AND timeline.patient_uid = $2::uuid
          AND timeline.event_type = 'discharge.follow_up_exception_recorded'
          AND timeline.resource_type = 'admission'
          AND timeline.resource_id = $3::text
          AND NULLIF(timeline.payload ->> 'reason', '') IS NOT NULL
        ORDER BY timeline.occurred_at DESC, timeline.id DESC
        LIMIT 1`,
      tenantId,
      admission.patient_uid,
      String(admission.id),
    ),
  ]);
  const signedSummary = summaryRows[0] || null;
  const closureSection = (column, sectionKey) => (
    signedSummary?.[column]
      ? {
          discharge_summary_id: signedSummary.id,
          section_id: signedSummary[column],
          section_key: sectionKey,
        }
      : null
  );
  return {
    structured_signed_summary: signedSummary
      ? {
          id: signedSummary.id,
          status: signedSummary.status,
          signed_by: signedSummary.signed_by,
          signed_at: signedSummary.signed_at,
        }
      : null,
    patient_guardian_instructions: closureSection(
      'patient_guardian_instructions_section_id',
      'patient_guardian_instructions',
    ),
    escalation_contact: closureSection(
      'escalation_contact_section_id',
      'escalation_contact',
    ),
    required_equipment_home_care: closureSection(
      'required_equipment_home_care_section_id',
      'required_equipment_home_care',
    ),
    discharge_destination: closureSection(
      'discharge_destination_section_id',
      'discharge_destination',
    ),
    transport_plan: closureSection(
      'transport_plan_section_id',
      'transport_plan',
    ),
    formal_discharge_medication_reconciliation: recRows[0] || null,
    admission_scoped_follow_up: followupRows[0] || null,
    audited_follow_up_exception: exceptionRows[0] || null,
    pending_results: pendingProjection,
  };
}

function activeEvidenceBlockers(evidence, { ownerConvergence } = {}) {
  const blockers = [];
  if (
    ownerConvergence?.pathway_owner_matches_assignment !== true
    || ownerConvergence?.admission_attending_matches_assignment !== true
    || ownerConvergence?.accepted_handoff_applied !== true
  ) {
    blockers.push({
      type: 'INPATIENT_OWNER_ASSIGNMENT_DIVERGED',
      message: 'Apply the accepted pathway-owner handoff to the admission attending and primary assignment before final discharge.',
    });
  }
  if (!evidence.structured_signed_summary) {
    blockers.push({
      type: 'STRUCTURED_SUMMARY_NOT_SIGNED',
      message: 'Active inpatient discharge requires one signed structured discharge summary for this admission.',
    });
  } else {
    if (!evidence.patient_guardian_instructions) {
      blockers.push({
        type: 'PATIENT_GUARDIAN_INSTRUCTIONS_REQUIRED',
        message: 'The signed discharge summary must contain durable patient or guardian instructions.',
      });
    }
    if (!evidence.escalation_contact) {
      blockers.push({
        type: 'ESCALATION_CONTACT_REQUIRED',
        message: 'The signed discharge summary must name the escalation contact or service.',
      });
    }
    if (!evidence.required_equipment_home_care) {
      blockers.push({
        type: 'EQUIPMENT_HOME_CARE_PLAN_REQUIRED',
        message: 'The signed discharge summary must record required equipment or home care, including an explicit none-required entry.',
      });
    }
    if (!evidence.discharge_destination) {
      blockers.push({
        type: 'DISCHARGE_DESTINATION_REQUIRED',
        message: 'The signed discharge summary must record the discharge destination.',
      });
    }
    if (!evidence.transport_plan) {
      blockers.push({
        type: 'TRANSPORT_PLAN_REQUIRED',
        message: 'The signed discharge summary must record the transport plan.',
      });
    }
  }
  if (!evidence.formal_discharge_medication_reconciliation) {
    blockers.push({
      type: 'FORMAL_DISCHARGE_MEDICATION_RECONCILIATION_REQUIRED',
      message: 'Complete the formal discharge medication reconciliation for this admission.',
    });
  }
  if (!evidence.admission_scoped_follow_up && !evidence.audited_follow_up_exception) {
    blockers.push({
      type: 'ADMISSION_FOLLOW_UP_OR_EXCEPTION_REQUIRED',
      message: 'Book an admission-scoped follow-up or record an explicit audited exception.',
    });
  }
  if (!evidence.pending_results.projection_ready) {
    blockers.push({
      type: 'PENDING_RESULT_PROJECTION_NOT_READY',
      message: 'Exact pending-result lineage has not been projected for this admission.',
    });
  }
  const itemBlockers = evidence.pending_results.items.filter((item) => item.blocking);
  if (itemBlockers.length) {
    blockers.push({
      type: 'PENDING_RESULT_HANDOFF_INCOMPLETE',
      message: `${itemBlockers.length} pending result handoff(s) lack exact lineage, the current named physician, or signed-summary inclusion.`,
      items: itemBlockers,
    });
  }
  return blockers;
}

export async function getInpatientDischargeEvidenceTx(admissionId, options = {}) {
  const id = normalizedId(admissionId, 'admission_id');
  const tenantId = requireTenantId(options.tenantId);
  const tx = options.tx;
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'Inpatient discharge evidence requires a transaction client',
      'INPATIENT_DISCHARGE_EVIDENCE_TX_REQUIRED',
    );
  }
  const admission = await admissionContextTx(tx, tenantId, id);
  const mode = await resolveInpatientPathwayModeTx(tx, tenantId);
  if (mode === PATHWAY_MODES.OFF) {
    return {
      mode,
      active_blockers: [],
      evidence: null,
      pending_results: {
        projection_ready: false,
        pathway_instance_id: null,
        references_found: 0,
        references_expected: 0,
        missing_reference_count: 0,
        unresolved_reference_count: 0,
        reconciliation_debt: [],
        items: [],
      },
    };
  }
  const pathway = await pathwayContextTx(tx, tenantId, admission);
  const assignment = await currentPrimaryAssignmentTx(tx, tenantId, id);
  const ownerConvergence = await ownerAssignmentConvergenceTx({
    tx,
    tenantId,
    admission,
    pathway,
    assignment,
  });
  const pendingResults = await collectPendingResultsTx(
    tx,
    tenantId,
    admission,
    pathway,
    assignment,
  );
  const evidence = await activeDischargeEvidenceTx(
    tx,
    tenantId,
    admission,
    pendingResults,
  );
  return {
    mode,
    primary_physician_assignment: assignment,
    pending_results: pendingResults,
    evidence,
    active_blockers: activeEvidenceBlockers(evidence, { ownerConvergence }),
  };
}

export async function getInpatientDischargeEvidence(admissionId, options = {}) {
  const tenantId = requireTenantId(options.tenantId);
  return setTenantTx(tenantId, (tx) => getInpatientDischargeEvidenceTx(
    admissionId,
    { tenantId, tx },
  ));
}

async function assertCurrentAdmissionReferenceTx({
  tx,
  tenantId,
  admission,
  referenceId,
  sourceType,
  sourceId,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT reference.*, pathway.workflow_run_id, pathway.id AS pathway_instance_id
       FROM care_pathway_resource_references AS reference
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = reference.tenant_id
        AND pathway.id = reference.pathway_instance_id
        AND pathway.patient_uid = reference.patient_uid
      WHERE reference.tenant_id = $1::uuid
        AND reference.id = $2::uuid
        AND reference.patient_uid = $3::uuid
        AND reference.relationship_kind = 'child_action'
        AND reference.resource_type = $4::text
        AND reference.resource_id = $5::text
        AND pathway.pathway_key = $6::text
        AND pathway.source_episode_type = 'admission'
        AND pathway.source_episode_id = $7::text
        AND ${currentReferenceClause('reference')}
      LIMIT 1
      FOR SHARE OF reference, pathway`,
    tenantId,
    referenceId,
    admission.patient_uid,
    sourceType,
    sourceId,
    CARE_PATHWAY_KEYS.INPATIENT,
    String(admission.id),
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Pending result does not have a current exact resource reference for this admission',
      'INPATIENT_PENDING_RESULT_LINEAGE_REQUIRED',
    );
  }
  return rows[0];
}

export async function recordPendingResultHandoff(admissionId, input = {}, actor = {}) {
  if (Object.hasOwn(input, 'metadata')) {
    throw AppError.badRequest(
      'metadata is not accepted for public pending-result handoffs',
      'INPATIENT_PENDING_RESULT_METADATA_NOT_ALLOWED',
    );
  }
  const id = normalizedId(admissionId, 'admission_id');
  const tenantId = requireTenantId(actor.tenantId);
  const sourceType = normalizedText(input.source_type, 'source_type', { required: true, max: 60 });
  if (!PENDING_RESULT_TYPE_SET.has(sourceType)) {
    throw AppError.badRequest(
      `source_type must be one of: ${INPATIENT_PENDING_RESULT_TYPES.join(', ')}`,
    );
  }
  const sourceId = normalizedText(input.source_id, 'source_id', { required: true, max: 160 });
  const referenceId = normalizedUuid(input.resource_reference_id, 'resource_reference_id');
  const actorUid = normalizedUuid(actor.uid, 'actor uid');
  const idempotencyKey = normalizedText(
    input.idempotency_key || `${sourceType}:${sourceId}`,
    'idempotency_key',
    { required: true, max: 200 },
  );

  return setTenantTx(tenantId, async (tx) => {
    const admission = await admissionContextTx(tx, tenantId, id, { lock: true });
    if (!['admitted', 'transferred'].includes(String(admission.status || '').toLowerCase())) {
      throw AppError.conflict(
        'Pending-result handoffs may be created only while the admission is active',
        'INPATIENT_PENDING_RESULT_ADMISSION_NOT_ACTIVE',
      );
    }
    const mode = await resolveInpatientPathwayModeTx(tx, tenantId);
    if (mode !== PATHWAY_MODES.ACTIVE) {
      throw AppError.conflict(
        'Pending-result handoffs may be authored only while the inpatient pathway is active',
        'INPATIENT_PATHWAY_ACTIVE_REQUIRED',
      );
    }
    const assignment = await currentPrimaryAssignmentTx(tx, tenantId, id, { lock: true });
    if (!assignment) {
      throw AppError.conflict(
        'A current named primary physician is required before recording a pending-result handoff',
        'INPATIENT_PRIMARY_PHYSICIAN_REQUIRED',
      );
    }
    await assertAccountableEvidenceActorTx({
      tx,
      tenantId,
      admissionId: id,
      actorUid,
      actorRole: actor.role,
      assignment,
    });
    const reference = await assertCurrentAdmissionReferenceTx({
      tx,
      tenantId,
      admission,
      referenceId,
      sourceType,
      sourceId,
    });
    const sourceMap = await loadAdmissionSourceRowsTx(tx, tenantId, admission);
    const source = sourceMap.get(`${sourceType}:${sourceId}`);
    if (!source) {
      throw AppError.conflict(
        'The referenced pending-result source does not exist for this tenant and patient',
        'INPATIENT_PENDING_RESULT_SOURCE_INVALID',
      );
    }
    const label = normalizedText(
      input.patient_safe_label || source.patient_safe_label,
      'patient_safe_label',
      { required: true, max: 240 },
    );
    const existingRows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM discharge_pending_result_handoffs
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::integer
          AND source_type = $3::text
          AND source_id = $4::text
        LIMIT 1
        FOR SHARE`,
      tenantId,
      id,
      sourceType,
      sourceId,
    );
    if (existingRows[0]) {
      const existing = existingRows[0];
      if (
        existing.idempotency_key !== idempotencyKey
        || String(existing.resource_reference_id) !== String(reference.id)
        || String(existing.primary_physician_assignment_id) !== String(assignment.id)
        || String(existing.named_physician_uid) !== String(assignment.physician_uid)
        || String(existing.created_by_uid) !== actorUid
        || existing.patient_safe_label !== label
      ) {
        throw AppError.conflict(
          'Pending-result handoff already exists with different evidence',
          'INPATIENT_PENDING_RESULT_IDEMPOTENCY_CONFLICT',
        );
      }
      if (
        sourceType === 'diagnostic_result_generation'
        && existing.resolution_generation_id == null
      ) {
        const linked = await linkPendingResultOwnerActionsForGenerationTx({
          tx,
          tenantId,
          generationId: sourceId,
        });
        return linked.find((entry) => entry.handoff?.id === existing.id)?.handoff
          || shapePendingResultHandoffMutation(existing);
      }
      return shapePendingResultHandoffMutation(existing);
    }
    if (source.terminal === true) {
      throw AppError.conflict(
        'A terminal diagnostic source cannot be recorded as pending at discharge',
        'INPATIENT_PENDING_RESULT_SOURCE_TERMINAL',
      );
    }
    const handoffId = randomUUID();
    const task = await createPendingResultTrackingTaskTx({
      tenantId,
      handoffId,
      admissionId: id,
      patientUid: admission.patient_uid,
      sourceType,
      sourceId,
      patientSafeLabel: label,
      ownerUid: assignment.physician_uid,
      createdBy: actorUid,
      tx,
    });
    if (!task) {
      throw AppError.conflict(
        'An open tracking task already exists for this pending-result handoff',
        'INPATIENT_PENDING_RESULT_TASK_CONFLICT',
      );
    }
    let rows = await tx.$queryRawUnsafe(
      `INSERT INTO discharge_pending_result_handoffs
         (id, tenant_id, admission_id, patient_uid, resource_reference_id,
          source_type, source_id, patient_safe_label, result_status,
          primary_physician_assignment_id, named_physician_uid,
          task_id, handoff_state, created_by_uid, idempotency_key, metadata)
       VALUES
         ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
          $6::text, $7::text, $8::text, $9::text,
          $10::uuid, $11::uuid, $12::integer, 'pending',
          $13::uuid, $14::text, $15::jsonb)
       ON CONFLICT (tenant_id, admission_id, source_type, source_id)
       DO NOTHING
       RETURNING *`,
      handoffId,
      tenantId,
      id,
      admission.patient_uid,
      reference.id,
      sourceType,
      sourceId,
      label,
      source.status,
      assignment.id,
      assignment.physician_uid,
      task.id,
      actorUid,
      idempotencyKey,
      json({}),
    );
    if (!rows[0]) {
      rows = await tx.$queryRawUnsafe(
        `SELECT *
           FROM discharge_pending_result_handoffs
          WHERE tenant_id = $1::uuid
            AND admission_id = $2::integer
            AND source_type = $3::text
            AND source_id = $4::text
          LIMIT 1`,
        tenantId,
        id,
        sourceType,
        sourceId,
      );
    }
    const handoff = rows[0];
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: admission.patient_uid,
      encounterId: admission.encounter_id,
      eventType: 'discharge.pending_result_handoff_recorded',
      eventStatus: 'pending',
      sourceTable: 'discharge_pending_result_handoffs',
      sourceId: handoff.id,
      resourceType: sourceType,
      resourceId: sourceId,
      actorUid,
      actorRole: actor.role,
      visibleToPatient: false,
      summary: 'Pending result responsibility recorded',
      payload: {
        admission_id: id,
        handoff_id: handoff.id,
        resource_reference_id: reference.id,
        source_type: sourceType,
        source_id: sourceId,
        named_physician_uid: assignment.physician_uid,
      },
      timelineIdempotencyKey: `pending-result-handoff:${tenantId}:${handoff.id}:timeline`,
      auditIdempotencyKey: `pending-result-handoff:${tenantId}:${handoff.id}:audit`,
    }, { db: tx, strict: true });
    await publishInpatientSourceEventTx({
      tx,
      tenantId,
      mode,
      eventType: 'discharge.pending_result_handoff_recorded',
      admission,
      aggregateType: 'discharge_pending_result_handoff',
      aggregateId: handoff.id,
      payload: {
        handoff_id: handoff.id,
        resource_reference_id: reference.id,
        source_type: sourceType,
        source_id: sourceId,
      },
    });
    if (sourceType === 'diagnostic_result_generation') {
      const linked = await linkPendingResultOwnerActionsForGenerationTx({
        tx,
        tenantId,
        generationId: sourceId,
      });
      return linked.find((entry) => entry.handoff?.id === handoff.id)?.handoff
        || shapePendingResultHandoffMutation(handoff);
    }
    return shapePendingResultHandoffMutation(handoff);
  });
}

export async function recordPendingResultSummaryInclusion(
  admissionId,
  handoffId,
  input = {},
  actor = {},
) {
  const id = normalizedId(admissionId, 'admission_id');
  const tenantId = requireTenantId(actor.tenantId);
  const hid = normalizedUuid(handoffId, 'handoff_id');
  const summaryId = normalizedId(input.discharge_summary_id, 'discharge_summary_id');
  const actorUid = normalizedUuid(actor.uid, 'actor uid');
  return setTenantTx(tenantId, async (tx) => {
    const admission = await admissionContextTx(tx, tenantId, id);
    const rows = await tx.$queryRawUnsafe(
      `SELECT handoff.*
         FROM discharge_pending_result_handoffs AS handoff
        WHERE handoff.tenant_id = $1::uuid
          AND handoff.id = $2::uuid
          AND handoff.admission_id = $3::integer
          AND handoff.patient_uid = $4::uuid
          AND handoff.handoff_state <> 'superseded'
        LIMIT 1
        FOR UPDATE`,
      tenantId,
      hid,
      id,
      admission.patient_uid,
    );
    const handoff = rows[0];
    if (!handoff) throw AppError.notFound('Pending-result handoff not found');
    await assertAccountableEvidenceActorTx({
      tx,
      tenantId,
      admissionId: id,
      actorUid,
      actorRole: actor.role,
    });
    if (handoff.discharge_summary_id != null) {
      if (Number(handoff.discharge_summary_id) !== summaryId) {
        throw AppError.conflict(
          'Pending-result summary inclusion cannot replace the recorded signed summary without explicit supersession evidence',
          'INPATIENT_PENDING_RESULT_SUMMARY_SUPERSESSION_REQUIRED',
        );
      }
      if (
        handoff.summary_included_at
        && handoff.summary_inclusion_timeline_event_id
      ) {
        return shapePendingResultHandoffMutation(handoff);
      }
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
      summaryId,
      id,
      admission.patient_uid,
    );
    if (!summaryRows[0]) {
      throw AppError.conflict(
        'Pending-result inclusion must name the signed structured summary for this admission',
        'INPATIENT_SIGNED_STRUCTURED_SUMMARY_REQUIRED',
      );
    }
    const signedEventRows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND event_type = 'discharge_summary.signed'
          AND source_table = 'discharge_summaries'
          AND source_id = $3::text
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
      tenantId,
      admission.patient_uid,
      String(summaryId),
    );
    if (!signedEventRows[0]) {
      throw AppError.conflict(
        'The structured summary has no exact canonical signed event',
        'INPATIENT_SIGNED_SUMMARY_EVENT_REQUIRED',
      );
    }
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: admission.patient_uid,
      encounterId: admission.encounter_id,
      eventType: 'discharge.pending_result.summary_included',
      eventStatus: 'included',
      sourceTable: 'discharge_pending_result_handoffs',
      sourceId: hid,
      resourceType: 'discharge_summary',
      resourceId: String(summaryId),
      actorUid,
      actorRole: actor.role,
      visibleToPatient: true,
      summary: handoff.patient_safe_label,
      payload: {
        admission_id: id,
        handoff_id: hid,
        discharge_summary_id: summaryId,
        patient_safe_label: handoff.patient_safe_label,
      },
      timelineIdempotencyKey: `pending-result-summary:${tenantId}:${hid}:${summaryId}:timeline`,
      auditIdempotencyKey: `pending-result-summary:${tenantId}:${hid}:${summaryId}:audit`,
    }, { db: tx, strict: true });
    const updated = await tx.$queryRawUnsafe(
      `UPDATE discharge_pending_result_handoffs
          SET discharge_summary_id = $5::integer,
              summary_included_at = NOW(),
              summary_inclusion_timeline_event_id = $6::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND admission_id = $3::integer
          AND patient_uid = $4::uuid
        RETURNING *`,
      tenantId,
      hid,
      id,
      admission.patient_uid,
      summaryId,
      signedEventRows[0].id,
    );
    return shapePendingResultHandoffMutation(updated[0]);
  });
}

export async function recordFollowUpException(admissionId, input = {}, actor = {}) {
  const id = normalizedId(admissionId, 'admission_id');
  const tenantId = requireTenantId(actor.tenantId);
  const actorUid = normalizedUuid(actor.uid, 'actor uid');
  const reason = normalizedText(input.reason, 'reason', { required: true, max: 1000 });
  const idempotencyKey = normalizedText(
    input.idempotency_key,
    'idempotency_key',
    { required: true, max: 200 },
  );
  return setTenantTx(tenantId, async (tx) => {
    const admission = await admissionContextTx(tx, tenantId, id);
    const mode = await resolveInpatientPathwayModeTx(tx, tenantId);
    if (mode !== PATHWAY_MODES.ACTIVE) {
      throw AppError.conflict(
        'Follow-up exceptions may be recorded only while the inpatient pathway is active',
        'INPATIENT_PATHWAY_ACTIVE_REQUIRED',
      );
    }
    await assertAccountableEvidenceActorTx({
      tx,
      tenantId,
      admissionId: id,
      actorUid,
      actorRole: actor.role,
    });
    const timelineIdempotencyKey =
      `follow-up-exception:${tenantId}:${id}:${idempotencyKey}:timeline`;
    const replayRows = await tx.$queryRawUnsafe(
      `SELECT id, actor_uid, payload ->> 'reason' AS reason
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND idempotency_key = $3::text
        LIMIT 1
        FOR SHARE`,
      tenantId,
      admission.patient_uid,
      timelineIdempotencyKey,
    );
    if (
      replayRows[0]
      && (
        replayRows[0].reason !== reason
        || String(replayRows[0].actor_uid || '') !== actorUid
      )
    ) {
      throw AppError.conflict(
        'Follow-up exception idempotency key was reused with different evidence',
        'INPATIENT_FOLLOW_UP_EXCEPTION_IDEMPOTENCY_CONFLICT',
      );
    }
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: admission.patient_uid,
      encounterId: admission.encounter_id,
      eventType: 'discharge.follow_up_exception_recorded',
      eventStatus: 'recorded',
      sourceTable: 'admissions',
      sourceId: String(id),
      resourceType: 'admission',
      resourceId: String(id),
      actorUid,
      actorRole: actor.role,
      visibleToPatient: false,
      summary: 'Discharge follow-up exception recorded',
      payload: { admission_id: id, reason },
      metadata: { admission_id: id, reason },
      timelineIdempotencyKey,
      auditIdempotencyKey: `follow-up-exception:${tenantId}:${id}:${idempotencyKey}:audit`,
    }, { db: tx, strict: true });
    return {
      admission_id: id,
      reason,
      canonical_timeline_event_id: canonical.timeline.id,
      canonical_audit_event_id: canonical.audit.id,
    };
  });
}

export async function recordPostDischargeContact(admissionId, input = {}, actor = {}) {
  if (Object.hasOwn(input, 'metadata') || Object.hasOwn(input, 'recorded_by_system_key')) {
    throw AppError.badRequest(
      'Internal recorder identity and metadata are not accepted in contact input',
      'POST_DISCHARGE_CONTACT_METADATA_NOT_ALLOWED',
    );
  }
  const id = normalizedId(admissionId, 'admission_id');
  const tenantId = requireTenantId(actor.tenantId);
  const eventKind = normalizedText(input.event_kind, 'event_kind', { required: true, max: 20 });
  const contactSource = normalizedText(input.contact_source, 'contact_source', {
    required: true,
    max: 30,
  });
  const channel = normalizedText(input.contact_channel, 'contact_channel', {
    required: true,
    max: 30,
  });
  if (!CONTACT_EVENT_KINDS.has(eventKind)) {
    throw AppError.badRequest('event_kind must be attempt or outcome');
  }
  if (!CONTACT_SOURCES.has(contactSource)) {
    throw AppError.badRequest('contact_source must be manual or registered_policy');
  }
  if (!CONTACT_CHANNELS.has(channel)) {
    throw AppError.badRequest(`Unsupported contact_channel: ${channel}`);
  }
  const outcomeCode = normalizedText(input.outcome_code, 'outcome_code', { max: 80 });
  const policyRuleCode = normalizedText(input.policy_rule_code, 'policy_rule_code', { max: 120 });
  if (eventKind === 'outcome' && !outcomeCode) {
    throw AppError.badRequest('outcome_code is required for an outcome event');
  }
  if (eventKind === 'attempt' && outcomeCode) {
    throw AppError.badRequest('outcome_code is not allowed for an attempt event');
  }
  if (contactSource === 'registered_policy' && !policyRuleCode) {
    throw AppError.badRequest('policy_rule_code is required for a registered-policy contact');
  }
  if (contactSource === 'manual' && policyRuleCode) {
    throw AppError.badRequest('policy_rule_code is not allowed for a manual contact');
  }
  const actorUid = actor.uid ? normalizedUuid(actor.uid, 'actor uid') : null;
  const registeredSystemActor = isRegisteredWorkflowSystemActor(actor.systemActor);
  const systemKey = registeredSystemActor
    ? normalizedText(actor.systemActor.systemKey, 'registered system key', {
        required: true,
        max: 120,
      })
    : null;
  if (Boolean(actorUid) === Boolean(systemKey)) {
    throw AppError.badRequest('Exactly one recorder identity is required');
  }
  if (contactSource === 'registered_policy' && !registeredSystemActor) {
    throw AppError.forbidden(
      'Registered-policy contacts require a sealed workflow system actor',
      'POST_DISCHARGE_CONTACT_POLICY_ACTOR_REQUIRED',
    );
  }
  if (contactSource === 'manual' && registeredSystemActor) {
    throw AppError.badRequest('A sealed workflow system actor cannot record a manual contact');
  }
  const patientSafeSummary = normalizedText(
    input.patient_safe_summary,
    'patient_safe_summary',
    { max: 500 },
  );
  const hasExplicitOccurredAt = Object.hasOwn(input, 'occurred_at')
    && input.occurred_at !== null
    && input.occurred_at !== '';
  const occurredAt = input.occurred_at ? new Date(input.occurred_at) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw AppError.badRequest('occurred_at is invalid');
  const idempotencyKey = normalizedText(
    input.idempotency_key,
    'idempotency_key',
    { required: true, max: 200 },
  );
  return setTenantTx(tenantId, async (tx) => {
    const admission = await admissionContextTx(tx, tenantId, id, { lock: true });
    if (['lama', 'expired'].includes(admission.status)) {
      throw AppError.conflict(
        'Exceptional departures cannot use the ordinary post-discharge contact path',
        'POST_DISCHARGE_CONTACT_EXCEPTIONAL_DEPARTURE',
      );
    }
    if (admission.status !== 'discharged') {
      throw AppError.conflict(
        'Post-discharge contact evidence requires a completed discharge',
        'POST_DISCHARGE_CONTACT_TOO_EARLY',
      );
    }
    await assertAccountableEvidenceActorTx({
      tx,
      tenantId,
      admissionId: id,
      actorUid,
      actorRole: actor.role,
      allowRegisteredSystem: contactSource === 'registered_policy',
      registeredSystemActor,
    });
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0)) IS NULL
              AS lock_acquired`,
      `post-discharge-contact:${tenantId}:${idempotencyKey}`,
    );
    const replayRows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM post_discharge_contact_events
        WHERE tenant_id = $1::uuid
          AND idempotency_key = $2::text
        LIMIT 1
        FOR SHARE`,
      tenantId,
      idempotencyKey,
    );
    if (replayRows[0]) {
      const replay = assertPostDischargeContactReplay(replayRows[0], {
        admissionId: id,
        patientUid: admission.patient_uid,
        eventKind,
        contactSource,
        channel,
        outcomeCode,
        policyRuleCode,
        patientSafeSummary,
        actorUid,
        systemKey,
        hasExplicitOccurredAt,
        occurredAt,
      });
      return shapePostDischargeContact(replay);
    }
    const contactId = randomUUID();
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: admission.patient_uid,
      encounterId: admission.encounter_id,
      eventType: 'post_discharge.contact_recorded',
      eventStatus: eventKind,
      sourceTable: 'post_discharge_contact_events',
      sourceId: contactId,
      resourceType: 'post_discharge_contact_events',
      resourceId: contactId,
      actorUid,
      actorRole: actor.role || (systemKey ? 'SYSTEM' : null),
      visibleToPatient: false,
      summary: 'Post-discharge contact recorded',
      occurredAt,
      payload: {
        admission_id: id,
        contact_event_id: contactId,
        event_kind: eventKind,
        contact_source: contactSource,
        contact_channel: channel,
        outcome_code: outcomeCode,
        policy_rule_code: policyRuleCode,
      },
      timelineIdempotencyKey: `post-discharge-contact:${tenantId}:${idempotencyKey}:timeline`,
      auditIdempotencyKey: `post-discharge-contact:${tenantId}:${idempotencyKey}:audit`,
    }, { db: tx, strict: true });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO post_discharge_contact_events
         (id, tenant_id, admission_id, patient_uid, event_kind,
          contact_source, contact_channel, outcome_code, patient_safe_summary,
          policy_rule_code, recorded_by_uid, recorded_by_system_key,
          canonical_timeline_event_id, canonical_audit_event_id,
          occurred_at, recorded_at, idempotency_key, metadata)
       VALUES
         ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::text,
          $6::text, $7::text, $8::text, $9::text, $10::text,
          $11::uuid, $12::text, $13::uuid, $14::uuid,
          $15::timestamptz, NOW(), $16::text, $17::jsonb)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      contactId,
      tenantId,
      id,
      admission.patient_uid,
      eventKind,
      contactSource,
      channel,
      outcomeCode,
       patientSafeSummary,
      policyRuleCode,
      actorUid,
      systemKey,
      canonical.timeline.id,
      canonical.audit.id,
      occurredAt,
      idempotencyKey,
      json({}),
    );
    if (!rows[0]) {
      const conflictRows = await tx.$queryRawUnsafe(
        `SELECT *
           FROM post_discharge_contact_events
          WHERE tenant_id = $1::uuid
            AND idempotency_key = $2::text
          LIMIT 1`,
        tenantId,
        idempotencyKey,
      );
      const winner = assertPostDischargeContactReplay(conflictRows[0], {
        admissionId: id,
        patientUid: admission.patient_uid,
        eventKind,
        contactSource,
        channel,
        outcomeCode,
        policyRuleCode,
        patientSafeSummary,
        actorUid,
        systemKey,
        hasExplicitOccurredAt,
        occurredAt,
      });
      return shapePostDischargeContact(winner);
    }
    const event = rows[0];
    await publishInpatientSourceEventTx({
      tx,
      tenantId,
      eventType: 'post_discharge.contact_recorded',
      admission,
      aggregateType: 'post_discharge_contact',
      aggregateId: event.id,
      payload: {
        contact_event_id: event.id,
        event_kind: eventKind,
      },
    });
    return shapePostDischargeContact(event);
  });
}

export async function listPostDischargeContacts(admissionId, options = {}) {
  const id = normalizedId(admissionId, 'admission_id');
  const tenantId = requireTenantId(options.tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const admission = await admissionContextTx(tx, tenantId, id);
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, admission_id, event_kind, contact_source,
               contact_channel, outcome_code, patient_safe_summary,
               policy_rule_code, occurred_at, recorded_at
         FROM post_discharge_contact_events
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::integer
          AND patient_uid = $3::uuid
        ORDER BY occurred_at DESC, id DESC`,
      tenantId,
      id,
      admission.patient_uid,
    );
    return rows.map(shapePostDischargeContact);
  });
}

async function loadAuthoritativeGenerationTx({
  tx,
  tenantId,
  generationId,
  admissionId = null,
  patientUid = null,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT generation.id, generation.tenant_id, generation.patient_uid,
            generation.admission_id, generation.source_kind,
            generation.source_episode_key, generation.source_version,
            generation.predecessor_generation_id,
            generation.signer_uid, generation.signer_role
       FROM diagnostic_result_generations AS generation
      WHERE generation.tenant_id = $1::uuid
        AND generation.id = $2::uuid
        AND ($3::integer IS NULL OR generation.admission_id = $3::integer)
        AND ($4::uuid IS NULL OR generation.patient_uid = $4::uuid)
      LIMIT 1
      FOR SHARE OF generation`,
    tenantId,
    generationId,
    admissionId,
    patientUid,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Diagnostic result generation does not match the admission and patient',
      'INPATIENT_PENDING_RESULT_GENERATION_MISMATCH',
    );
  }
  const successorRows = await tx.$queryRawUnsafe(
    `SELECT successor.id
       FROM diagnostic_result_generations AS successor
      WHERE successor.tenant_id = $1::uuid
        AND successor.patient_uid = $2::uuid
        AND successor.predecessor_generation_id = $3::uuid
      LIMIT 1
      FOR SHARE OF successor`,
    tenantId,
    rows[0].patient_uid,
    generationId,
  );
  if (successorRows[0]) {
    throw AppError.conflict(
      'Only the latest authoritative diagnostic generation may own pending-result action',
      'INPATIENT_PENDING_RESULT_GENERATION_NOT_CURRENT',
    );
  }
  return rows[0];
}

async function assertGenerationResolvesHandoffSourceTx({
  tx,
  tenantId,
  generation,
  handoff,
}) {
  const rows = await tx.$queryRawUnsafe(
    `WITH RECURSIVE generation_ancestry AS (
       SELECT current.id, current.predecessor_generation_id,
              current.source_kind, current.source_episode_key
         FROM diagnostic_result_generations AS current
        WHERE current.tenant_id = $1::uuid
          AND current.id = $2::uuid
          AND current.patient_uid = $3::uuid
          AND current.admission_id = $4::integer
       UNION ALL
       SELECT predecessor.id, predecessor.predecessor_generation_id,
              predecessor.source_kind, predecessor.source_episode_key
         FROM diagnostic_result_generations AS predecessor
         JOIN generation_ancestry AS child
           ON predecessor.tenant_id = $1::uuid
          AND predecessor.id = child.predecessor_generation_id
          AND predecessor.patient_uid = $3::uuid
          AND predecessor.admission_id = $4::integer
          AND predecessor.source_kind = child.source_kind
          AND predecessor.source_episode_key = child.source_episode_key
     )
     SELECT generation.id
       FROM diagnostic_result_generations AS generation
      WHERE generation.tenant_id = $1::uuid
        AND generation.id = $2::uuid
        AND generation.patient_uid = $3::uuid
        AND generation.admission_id = $4::integer
        AND (
          ($5::text = 'investigation'
            AND generation.investigation_id::text = $6::text)
          OR ($5::text = 'radiology_order'
            AND generation.radiology_order_id::text = $6::text)
          OR ($5::text = 'diagnostic_result_generation'
            AND EXISTS (
              SELECT 1
                FROM generation_ancestry AS ancestor
               WHERE ancestor.id::text = $6::text
            ))
          OR ($5::text = 'lab_result'
            AND EXISTS (
              SELECT 1
                FROM diagnostic_result_generation_items AS item
               WHERE item.tenant_id = generation.tenant_id
                 AND item.generation_id = generation.id
                 AND item.patient_uid = generation.patient_uid
                 AND item.source_table = 'lab_results'
                 AND item.source_row_id = $6::text
            ))
          OR ($5::text = 'anatomical_pathology_case'
            AND EXISTS (
              SELECT 1
                FROM ap_reports AS report
               WHERE report.tenant_id = generation.tenant_id
                 AND report.id = generation.ap_report_id
                 AND report.ap_case_id::text = $6::text
            ))
        )
      LIMIT 1`,
    tenantId,
    generation.id,
    handoff.patient_uid,
    handoff.admission_id,
    handoff.source_type,
    handoff.source_id,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Diagnostic result generation does not resolve the exact handed-off source',
      'INPATIENT_PENDING_RESULT_GENERATION_MISMATCH',
    );
  }
}

async function loadCurrentPendingResultOwnerActionTx({
  tx,
  tenantId,
  handoff,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT action.*, task.status AS task_status,
            task.related_resource_type, task.related_resource_id,
            task.patient_uid AS task_patient_uid,
            task.assigned_to_uid, task.assigned_to_role,
            task.parent_task_id, task.created_by,
            task.task_kind, task.title, task.description,
            task.metadata AS task_metadata,
            task.created_at AS task_created_at,
            task.updated_at AS task_updated_at
       FROM discharge_pending_result_owner_actions AS action
       JOIN tasks AS task
         ON task.tenant_id = action.tenant_id
        AND task.id = action.task_id
      WHERE action.tenant_id = $1::uuid
        AND action.handoff_id = $2::uuid
        AND action.admission_id = $3::integer
        AND action.patient_uid = $4::uuid
         AND NOT EXISTS (
           SELECT 1
             FROM discharge_pending_result_owner_actions AS successor
            WHERE successor.tenant_id = action.tenant_id
              AND successor.handoff_id = action.handoff_id
              AND successor.predecessor_owner_action_id = action.id
         )
      ORDER BY action.recorded_at DESC, action.id DESC
      LIMIT 2
      FOR SHARE OF action, task`,
    tenantId,
    handoff.id,
    handoff.admission_id,
    handoff.patient_uid,
  );
  if (rows.length > 1) {
    throw AppError.conflict(
      'Pending-result handoff has more than one current owner action',
      'INPATIENT_PENDING_RESULT_OWNER_ACTION_CONFLICT',
    );
  }
  return rows[0] || null;
}

function ownerActionTaskRow(ownerAction) {
  if (!ownerAction) return null;
  return {
    id: ownerAction.task_id,
    task_kind: ownerAction.task_kind,
    title: ownerAction.title,
    description: ownerAction.description,
    status: ownerAction.task_status,
    patient_uid: ownerAction.task_patient_uid,
    assigned_to_uid: ownerAction.assigned_to_uid,
    assigned_to_role: ownerAction.assigned_to_role,
    created_by: ownerAction.created_by,
    metadata: ownerAction.task_metadata,
    related_resource_type: ownerAction.related_resource_type,
    related_resource_id: ownerAction.related_resource_id,
    parent_task_id: ownerAction.parent_task_id,
    created_at: ownerAction.task_created_at,
    updated_at: ownerAction.task_updated_at,
  };
}

async function correlatePendingResultGenerationTx({
  tx,
  tenantId,
  admission,
  handoff,
  generation,
  actorUid,
  actorRole,
  rearmSourceActionId = null,
}) {
  await assertGenerationResolvesHandoffSourceTx({
    tx,
    tenantId,
    generation,
    handoff,
  });
  const currentOwnerAction = await loadCurrentPendingResultOwnerActionTx({
    tx,
    tenantId,
    handoff,
  });
  const isDoctorReopen = Boolean(rearmSourceActionId);
  if (
    currentOwnerAction
    && String(currentOwnerAction.generation_id) === String(generation.id)
    && !isDoctorReopen
  ) {
    const currentTask = assertExactPendingResultActionTask(
      ownerActionTaskRow(currentOwnerAction),
      {
        handoff,
        generationId: generation.id,
        predecessorGenerationId: currentOwnerAction.predecessor_generation_id,
        predecessorOwnerActionId: currentOwnerAction.predecessor_owner_action_id,
        predecessorResolutionActionId:
          currentOwnerAction.predecessor_resolution_action_id,
        rearmSourceActionId: currentOwnerAction.rearm_source_action_id,
        requireLive: false,
      },
    );
    return {
      handoff: shapePendingResultHandoffMutation(handoff),
      action_task: shapePendingResultActionTask(currentTask),
      owner_action: shapePendingResultOwnerAction(currentOwnerAction),
      ordering_owner_obligation_preserved: true,
    };
  }
  if (!currentOwnerAction && handoff.resolution_generation_id) {
    throw AppError.conflict(
      'The result-available handoff is missing its append-only owner-action anchor',
      'INPATIENT_PENDING_RESULT_OWNER_ACTION_CONFLICT',
    );
  }

  const predecessorOwnerActionId = currentOwnerAction?.id || null;
  const predecessorGenerationId = isDoctorReopen
    ? null
    : currentOwnerAction?.generation_id || null;
  const predecessorResolutionActionId = handoff.resolution_action_id || null;
  if (isDoctorReopen && (
    !currentOwnerAction
    || String(currentOwnerAction.generation_id) !== String(generation.id)
    || handoff.handoff_state !== 'resolved'
    || !predecessorResolutionActionId
    || currentOwnerAction.task_status !== 'completed'
  )) {
    throw AppError.conflict(
      'Doctor-reopened pending-result work requires the exact resolved current owner action',
      'INPATIENT_PENDING_RESULT_REARM_NOT_ACTIONABLE',
    );
  }
  if (!isDoctorReopen && (
    (predecessorGenerationId
      && String(generation.predecessor_generation_id || '')
        !== String(predecessorGenerationId))
    || (!predecessorGenerationId && generation.predecessor_generation_id)
  )) {
    throw AppError.conflict(
      'Corrected pending-result action must directly supersede the current owner generation',
      'INPATIENT_PENDING_RESULT_GENERATION_SUPERSESSION_REQUIRED',
    );
  }

  let updatedHandoff = handoff;
  if (!currentOwnerAction) {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE discharge_pending_result_handoffs
          SET handoff_state = 'result_available',
              result_status = 'available',
              resolution_generation_id = $5::uuid,
              updated_at = GREATEST(
                clock_timestamp(),
                updated_at + INTERVAL '1 microsecond'
              )
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND admission_id = $3::integer
          AND patient_uid = $4::uuid
          AND handoff_state = 'pending'
          AND resolution_generation_id IS NULL
        RETURNING *`,
      tenantId,
      handoff.id,
      handoff.admission_id,
      handoff.patient_uid,
      generation.id,
    );
    if (!updated[0]) {
      throw AppError.conflict(
        'Pending-result generation correlation lost its fill-once handoff claim',
        'INPATIENT_PENDING_RESULT_GENERATION_CAS_CONFLICT',
      );
    }
    updatedHandoff = {
      ...updated[0],
      signer_uid: handoff.signer_uid,
      signer_role: handoff.signer_role,
      admission_encounter_id: handoff.admission_encounter_id,
    };
  } else if (handoff.handoff_state === 'resolved') {
    if (currentOwnerAction.task_status !== 'completed' || !predecessorResolutionActionId) {
      throw AppError.conflict(
        'Resolved pending-result work lacks its completed predecessor receipt',
        'INPATIENT_PENDING_RESULT_REARM_NOT_ACTIONABLE',
      );
    }
    const trackingTask = await createPendingResultTrackingTaskTx({
      tenantId,
      handoffId: handoff.id,
      admissionId: handoff.admission_id,
      patientUid: handoff.patient_uid,
      sourceType: handoff.source_type,
      sourceId: handoff.source_id,
      patientSafeLabel: handoff.patient_safe_label,
      ownerUid: handoff.named_physician_uid,
      createdBy: actorUid,
      predecessorTrackingTaskId: Number(handoff.task_id),
      rearmReason: isDoctorReopen ? 'doctor_reopened' : 'corrected_generation',
      tx,
    });
    if (!trackingTask) {
      throw AppError.conflict(
        'Pending-result tracking task could not be rearmed',
        'INPATIENT_PENDING_RESULT_REARM_TASK_CONFLICT',
      );
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE discharge_pending_result_handoffs
          SET handoff_state = 'result_available',
              result_status = 'available',
              task_id = $7::integer,
              resolved_at = NULL,
              resolved_by_uid = NULL,
              resolution_action_id = NULL,
              updated_at = GREATEST(
                clock_timestamp(),
                updated_at + INTERVAL '1 microsecond'
              )
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND admission_id = $3::integer
          AND patient_uid = $4::uuid
          AND handoff_state = 'resolved'
          AND task_id = $5::integer
          AND resolution_action_id = $6::uuid
          AND EXISTS (
            SELECT 1
              FROM tasks AS predecessor_tracking
             WHERE predecessor_tracking.tenant_id =
                   discharge_pending_result_handoffs.tenant_id
               AND predecessor_tracking.id = $5::integer
               AND predecessor_tracking.status = 'completed'
          )
        RETURNING *`,
      tenantId,
      handoff.id,
      handoff.admission_id,
      handoff.patient_uid,
      Number(handoff.task_id),
      predecessorResolutionActionId,
      Number(trackingTask.id),
    );
    if (!updated[0]) {
      throw AppError.conflict(
        'Pending-result handoff changed before rearm',
        'INPATIENT_PENDING_RESULT_REARM_CAS_CONFLICT',
      );
    }
    updatedHandoff = {
      ...updated[0],
      signer_uid: handoff.signer_uid,
      signer_role: handoff.signer_role,
      admission_encounter_id: handoff.admission_encounter_id,
    };
  } else {
    if (isDoctorReopen || handoff.handoff_state !== 'result_available') {
      throw AppError.conflict(
        'Pending-result work is not in a rearmable state',
        'INPATIENT_PENDING_RESULT_REARM_NOT_ACTIONABLE',
      );
    }
    const liveTaskStatuses = new Set(['open', 'in_progress', 'blocked', 'overdue']);
    if (liveTaskStatuses.has(currentOwnerAction.task_status)) {
      await supersedePendingResultOwnerActionTaskFromGenerationTx({
        tenantId,
        id: Number(currentOwnerAction.task_id),
        handoffId: handoff.id,
        generationId: predecessorGenerationId,
        supersedingGenerationId: generation.id,
        patientUid: handoff.patient_uid,
        ownerUid: handoff.named_physician_uid,
        parentTaskId: handoff.task_id,
        actorUid,
        tx,
      });
    } else if (currentOwnerAction.task_status !== 'completed') {
      throw AppError.conflict(
        'The predecessor pending-result owner action is not live or completed',
        'INPATIENT_PENDING_RESULT_OWNER_ACTION_CONFLICT',
      );
    }
  }

  const actionTask = await ensurePendingResultActionTaskTx({
    tx,
    tenantId,
    handoff: updatedHandoff,
    generationId: generation.id,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
    createdBy: actorUid,
  });

  const evidence = await appendPendingResultAvailableEvidenceTx({
    tx,
    tenantId,
    admission,
    handoff: updatedHandoff,
    generationId: generation.id,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
    actionTask,
    actorUid,
    actorRole,
  });
  const ownerAction = await appendPendingResultOwnerActionTx({
    tx,
    tenantId,
    handoff: updatedHandoff,
    generationId: generation.id,
    predecessorGenerationId,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
    actionTask,
    evidence,
  });
  return {
    handoff: shapePendingResultHandoffMutation(updatedHandoff),
    action_task: shapePendingResultActionTask(actionTask),
    owner_action: shapePendingResultOwnerAction(ownerAction),
    ordering_owner_obligation_preserved: true,
  };
}

export async function linkPendingResultOwnerActionsForGenerationTx({
  tx,
  tenantId,
  generationId,
  rearmSourceActionId = null,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'Pending-result generation correlation requires a transaction client',
      'INPATIENT_PENDING_RESULT_CORRELATION_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const gid = normalizedUuid(generationId, 'generation_id');
  const rearmActionId = normalizedUuid(
    rearmSourceActionId,
    'rearm_source_action_id',
    false,
  );
  const generation = await loadAuthoritativeGenerationTx({
    tx,
    tenantId: tid,
    generationId: gid,
  });
  let rearmAction = null;
  if (rearmActionId) {
    const rearmRows = await tx.$queryRawUnsafe(
      `SELECT id, actor_uid, actor_role
         FROM diagnostic_result_actions
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND generation_id = $3::uuid
          AND patient_uid = $4::uuid
          AND action_kind = 'doctor_reopened'
          AND actor_uid IS NOT NULL
          AND canonical_timeline_event_id IS NOT NULL
          AND canonical_audit_event_id IS NOT NULL
        LIMIT 2
        FOR SHARE`,
      tid,
      rearmActionId,
      gid,
      generation.patient_uid,
    );
    if (rearmRows.length !== 1) {
      throw AppError.conflict(
        'Pending-result rearm requires the exact authoritative doctor-reopened action',
        'INPATIENT_PENDING_RESULT_REARM_SOURCE_INVALID',
      );
    }
    [rearmAction] = rearmRows;
  }
  const handoffs = await tx.$queryRawUnsafe(
    `WITH RECURSIVE exact_generation AS (
       SELECT generation.*
         FROM diagnostic_result_generations AS generation
        WHERE generation.tenant_id = $1::uuid
          AND generation.id = $2::uuid
          AND generation.admission_id IS NOT NULL
        LIMIT 1
     ),
     generation_ancestry AS (
       SELECT generation.id, generation.predecessor_generation_id,
              generation.tenant_id, generation.patient_uid,
              generation.admission_id, generation.source_kind,
              generation.source_episode_key
         FROM exact_generation AS generation
       UNION ALL
       SELECT predecessor.id, predecessor.predecessor_generation_id,
              predecessor.tenant_id, predecessor.patient_uid,
              predecessor.admission_id, predecessor.source_kind,
              predecessor.source_episode_key
         FROM diagnostic_result_generations AS predecessor
         JOIN generation_ancestry AS child
           ON predecessor.tenant_id = child.tenant_id
          AND predecessor.id = child.predecessor_generation_id
          AND predecessor.patient_uid = child.patient_uid
          AND predecessor.admission_id = child.admission_id
          AND predecessor.source_kind = child.source_kind
          AND predecessor.source_episode_key = child.source_episode_key
     ),
     exact_sources(resource_type, resource_id) AS (
       SELECT 'diagnostic_result_generation'::text, ancestor.id::text
         FROM generation_ancestry AS ancestor
       UNION ALL
       SELECT 'investigation'::text, generation.investigation_id::text
         FROM exact_generation AS generation
        WHERE generation.investigation_id IS NOT NULL
       UNION ALL
       SELECT 'radiology_order'::text, generation.radiology_order_id::text
         FROM exact_generation AS generation
        WHERE generation.radiology_order_id IS NOT NULL
       UNION ALL
       SELECT 'lab_result'::text, item.source_row_id
         FROM exact_generation AS generation
         JOIN diagnostic_result_generation_items AS item
           ON item.tenant_id = generation.tenant_id
          AND item.generation_id = generation.id
          AND item.patient_uid = generation.patient_uid
          AND item.source_table = 'lab_results'
       UNION ALL
       SELECT 'anatomical_pathology_case'::text, report.ap_case_id::text
         FROM exact_generation AS generation
         JOIN ap_reports AS report
           ON report.tenant_id = generation.tenant_id
          AND report.id = generation.ap_report_id
        WHERE generation.ap_report_id IS NOT NULL
     )
     SELECT handoff.*, pathway.workflow_run_id,
            generation.signer_uid, generation.signer_role,
            admission.encounter_id AS admission_encounter_id
       FROM exact_generation AS generation
       JOIN admissions AS admission
         ON admission.tenant_id = generation.tenant_id
        AND admission.id = generation.admission_id
        AND admission.patient_uid = generation.patient_uid
       JOIN discharge_pending_result_handoffs AS handoff
         ON handoff.tenant_id = generation.tenant_id
        AND handoff.admission_id = generation.admission_id
        AND handoff.patient_uid = generation.patient_uid
         AND (
           ($4::uuid IS NULL
             AND handoff.handoff_state IN (
               'pending',
               'result_available',
               'resolved'
             ))
           OR ($4::uuid IS NOT NULL AND handoff.handoff_state = 'resolved')
         )
       JOIN exact_sources AS source
         ON source.resource_type = handoff.source_type
        AND source.resource_id = handoff.source_id
       JOIN care_pathway_resource_references AS reference
         ON reference.tenant_id = handoff.tenant_id
        AND reference.id = handoff.resource_reference_id
        AND reference.patient_uid = handoff.patient_uid
        AND reference.resource_type = handoff.source_type
        AND reference.resource_id = handoff.source_id
        AND reference.relationship_kind = 'child_action'
        AND ${currentReferenceClause('reference')}
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = reference.tenant_id
        AND pathway.id = reference.pathway_instance_id
        AND pathway.patient_uid = reference.patient_uid
        AND pathway.pathway_key = $3::text
        AND pathway.source_episode_type = 'admission'
        AND pathway.source_episode_id = generation.admission_id::text
      ORDER BY handoff.created_at ASC, handoff.id ASC
      FOR UPDATE OF handoff`,
    tid,
    gid,
    CARE_PATHWAY_KEYS.INPATIENT,
    rearmActionId,
  );

  const linked = [];
  for (const handoff of handoffs) {
    linked.push(await correlatePendingResultGenerationTx({
      tx,
      tenantId: tid,
      admission: {
        id: handoff.admission_id,
        patient_uid: handoff.patient_uid,
        encounter_id: handoff.admission_encounter_id,
      },
      handoff,
      generation,
      actorUid: rearmAction?.actor_uid || handoff.signer_uid,
      actorRole: rearmAction?.actor_role || handoff.signer_role,
      rearmSourceActionId: rearmActionId,
    }));
  }
  return linked;
}

export async function rearmPendingResultOwnerActionsForDiagnosticReopenTx({
  tx,
  tenantId,
  generationId,
  doctorReopenedActionId,
} = {}) {
  return linkPendingResultOwnerActionsForGenerationTx({
    tx,
    tenantId,
    generationId,
    rearmSourceActionId: doctorReopenedActionId,
  });
}

export async function settlePendingResultOwnerActionsForDiagnosticActionTx({
  tx,
  tenantId,
  diagnosticActionId,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'Pending-result diagnostic settlement requires a transaction client',
      'INPATIENT_PENDING_RESULT_SETTLEMENT_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const actionId = normalizedUuid(diagnosticActionId, 'diagnostic_action_id');
  const rows = await tx.$queryRawUnsafe(
    `SELECT handoff.*,
            admission.encounter_id,
            owner_action.id AS owner_action_id,
            owner_action.generation_id,
            owner_action.task_id AS action_task_id,
            diagnostic_action.action_kind,
            diagnostic_action.actor_uid,
            diagnostic_action.actor_role,
            diagnostic_action.signature_id,
            diagnostic_action.generation_snapshot_sha256
       FROM diagnostic_result_actions AS diagnostic_action
       JOIN discharge_pending_result_owner_actions AS owner_action
         ON owner_action.tenant_id = diagnostic_action.tenant_id
        AND owner_action.generation_id = diagnostic_action.generation_id
        AND owner_action.patient_uid = diagnostic_action.patient_uid
       JOIN discharge_pending_result_handoffs AS handoff
         ON handoff.tenant_id = owner_action.tenant_id
        AND handoff.id = owner_action.handoff_id
        AND handoff.admission_id = owner_action.admission_id
        AND handoff.patient_uid = owner_action.patient_uid
       JOIN admissions AS admission
         ON admission.tenant_id = handoff.tenant_id
        AND admission.id = handoff.admission_id
        AND admission.patient_uid = handoff.patient_uid
      WHERE diagnostic_action.tenant_id = $1::uuid
        AND diagnostic_action.id = $2::uuid
        AND diagnostic_action.action_kind IN (
              'doctor_disposition',
              'normal_auto_closed'
            )
        AND (
          diagnostic_action.action_kind = 'normal_auto_closed'
          OR (
            diagnostic_action.action_kind = 'doctor_disposition'
            AND diagnostic_action.signature_id IS NOT NULL
            AND diagnostic_action.actor_uid = handoff.named_physician_uid
            AND diagnostic_action.actor_uid = owner_action.owner_uid
          )
        )
        AND (
          (
            handoff.handoff_state = 'result_available'
            AND handoff.resolution_action_id IS NULL
            AND handoff.resolved_at IS NULL
            AND handoff.resolved_by_uid IS NULL
          )
          OR (
            handoff.handoff_state = 'resolved'
            AND handoff.resolution_action_id = diagnostic_action.id
            AND (
              (
                diagnostic_action.action_kind = 'normal_auto_closed'
                AND handoff.resolved_by_uid IS NULL
              )
              OR handoff.resolved_by_uid = diagnostic_action.actor_uid
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM discharge_pending_result_owner_actions AS successor
           WHERE successor.tenant_id = owner_action.tenant_id
             AND successor.handoff_id = owner_action.handoff_id
             AND successor.predecessor_owner_action_id = owner_action.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM diagnostic_result_generations AS successor_generation
           WHERE successor_generation.tenant_id = diagnostic_action.tenant_id
             AND successor_generation.patient_uid = diagnostic_action.patient_uid
             AND successor_generation.admission_id = handoff.admission_id
             AND successor_generation.predecessor_generation_id =
                   diagnostic_action.generation_id
        )
      ORDER BY handoff.id
      FOR UPDATE OF diagnostic_action, owner_action, handoff`,
    tid,
    actionId,
  );
  const settled = [];
  for (const row of rows) {
    const resolvedByUid = row.action_kind === 'doctor_disposition'
      ? row.actor_uid
      : null;
    if (row.handoff_state !== 'resolved') {
      const eventStatus = row.action_kind === 'normal_auto_closed'
        ? 'normal_auto_closed'
        : 'ordering_owner_disposition';
      const canonical = await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid: row.patient_uid,
        encounterId: row.encounter_id,
        eventType: 'discharge.pending_result_resolved',
        eventStatus,
        sourceTable: 'diagnostic_result_actions',
        sourceId: actionId,
        resourceType: 'discharge_pending_result_handoff',
        resourceTable: 'discharge_pending_result_handoffs',
        resourceId: row.id,
        actorUid: resolvedByUid,
        actorRole: resolvedByUid ? row.actor_role : null,
        visibleToPatient: false,
        summary: row.action_kind === 'normal_auto_closed'
          ? 'Normal pending result auto-closed after authoritative release'
          : 'Named discharge owner recorded the authoritative result disposition',
        payload: {
          admission_id: Number(row.admission_id),
          handoff_id: row.id,
          generation_id: row.generation_id,
          owner_action_id: row.owner_action_id,
          action_task_id: Number(row.action_task_id),
          tracking_task_id: Number(row.task_id),
          resolution_action_id: actionId,
        },
        afterState: {
          handoff_state: 'resolved',
          resolution_action_id: actionId,
          generation_snapshot_sha256: row.generation_snapshot_sha256,
        },
        tags: ['inpatient', 'discharge', 'pending_result', eventStatus],
        timelineIdempotencyKey:
          `pending-result-resolved:${tid}:${row.id}:${actionId}:timeline`,
        auditIdempotencyKey:
          `pending-result-resolved:${tid}:${row.id}:${actionId}:audit`,
      }, { db: tx, strict: true });
      if (!canonical?.timeline?.id || !canonical?.audit?.id) {
        throw AppError.internal(
          'Pending-result diagnostic settlement canonical evidence is unavailable',
          'INPATIENT_PENDING_RESULT_SETTLEMENT_EVIDENCE_REQUIRED',
        );
      }
      const event = await publishEvent({
        eventType: 'discharge.pending_result_resolved',
        aggregateType: 'discharge_pending_result_handoff',
        aggregateId: row.id,
        patientUid: row.patient_uid,
        tenantId: tid,
        tx,
        payload: {
          admission_id: Number(row.admission_id),
          handoff_id: row.id,
          generation_id: row.generation_id,
          owner_action_id: row.owner_action_id,
          action_task_id: Number(row.action_task_id),
          tracking_task_id: Number(row.task_id),
          resolution_action_id: actionId,
          canonical_timeline_event_id: canonical.timeline.id,
          canonical_audit_event_id: canonical.audit.id,
          admission_lineage_version: 1,
        },
      });
      if (!event?.id) {
        throw AppError.internal(
          'Pending-result diagnostic settlement outbox evidence is unavailable',
          'INPATIENT_PENDING_RESULT_SETTLEMENT_EVIDENCE_REQUIRED',
        );
      }
      const updated = await tx.$queryRawUnsafe(
        `UPDATE discharge_pending_result_handoffs
            SET handoff_state = 'resolved',
                result_status = $7::text,
                resolved_at = clock_timestamp(),
                resolved_by_uid = $5::uuid,
                resolution_action_id = $6::uuid,
                updated_at = GREATEST(
                  clock_timestamp(),
                  updated_at + INTERVAL '1 microsecond'
                )
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND admission_id = $3::integer
            AND patient_uid = $4::uuid
            AND handoff_state = 'result_available'
            AND resolution_action_id IS NULL
            AND resolved_at IS NULL
            AND resolved_by_uid IS NULL
          RETURNING id`,
        tid,
        row.id,
        Number(row.admission_id),
        row.patient_uid,
        resolvedByUid,
        actionId,
        row.action_kind === 'normal_auto_closed' ? 'normal' : 'reviewed',
      );
      if (!updated[0]) {
        throw AppError.conflict(
          'Pending-result handoff changed before diagnostic settlement',
          'INPATIENT_PENDING_RESULT_SETTLEMENT_CONFLICT',
        );
      }
    }
    const tasks = await settlePendingResultTasksFromDiagnosticActionTx({
      tenantId: tid,
      handoffId: row.id,
      generationId: row.generation_id,
      ownerActionId: row.owner_action_id,
      diagnosticActionId: actionId,
      actionTaskId: Number(row.action_task_id),
      trackingTaskId: Number(row.task_id),
      patientUid: row.patient_uid,
      tx,
    });
    settled.push(Object.freeze({
      handoff_id: row.id,
      generation_id: row.generation_id,
      owner_action_id: row.owner_action_id,
      resolution_action_id: actionId,
      resolved_by_uid: resolvedByUid,
      action_task_id: tasks.action_task_id,
      tracking_task_id: tasks.tracking_task_id,
      replayed: row.handoff_state === 'resolved' && tasks.replayed,
    }));
  }
  return settled;
}

function pendingResultCrossSignReceipt(row, {
  replayed,
  currentHandoffState = null,
} = {}) {
  return Object.freeze({
    id: String(row.id),
    admission_id: Number(row.admission_id),
    handoff_id: String(row.handoff_id),
    generation_id: String(row.generation_id),
    diagnostic_action_id: String(row.predecessor_action_id),
    pathway_instance_id: String(row.pathway_instance_id),
    owner_action_id: String(row.owner_action_id),
    action_task_id: Number(row.task_id),
    tracking_task_id: Number(row.tracking_task_id),
    signature_id: String(row.signature_id),
    resolution_action_id: String(row.id),
    handoff_state: 'resolved',
    current_handoff_state: currentHandoffState || row.current_handoff_state || 'resolved',
    generation_snapshot_sha256: row.generation_snapshot_sha256,
    request_sha256: row.request_sha256,
    canonical_timeline_event_id: String(row.canonical_timeline_event_id),
    canonical_audit_event_id: String(row.canonical_audit_event_id),
    replayed,
  });
}

async function loadPendingResultCrossSignReplayTx({
  tx,
  tenantId,
  idempotencyKey,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT action.*,
            handoff.id AS handoff_id,
            handoff.admission_id,
            tracking_task.id AS tracking_task_id,
            handoff.handoff_state AS current_handoff_state,
            owner_action.id AS owner_action_id
       FROM diagnostic_result_actions AS action
       JOIN discharge_pending_result_owner_actions AS owner_action
         ON owner_action.tenant_id = action.tenant_id
         AND owner_action.task_id = action.task_id
         AND owner_action.generation_id = action.generation_id
         AND owner_action.patient_uid = action.patient_uid
       JOIN tasks AS action_task
         ON action_task.tenant_id = owner_action.tenant_id
         AND action_task.id = owner_action.task_id
         AND action_task.parent_task_id IS NOT NULL
        AND action_task.related_resource_type =
              'discharge_pending_result_action'
        AND action_task.related_resource_id = CASE
              WHEN owner_action.rearm_source_action_id IS NOT NULL
                THEN owner_action.handoff_id::text
                  || ':' || owner_action.generation_id::text
                  || ':' || owner_action.predecessor_owner_action_id::text
              ELSE owner_action.handoff_id::text
                || ':' || owner_action.generation_id::text
            END
       JOIN tasks AS tracking_task
         ON tracking_task.tenant_id = action_task.tenant_id
        AND tracking_task.id = action_task.parent_task_id
        AND tracking_task.parent_task_id IS NULL
        AND tracking_task.related_resource_type =
              'discharge_pending_result_handoff'
        AND tracking_task.related_resource_id = owner_action.handoff_id::text
       JOIN discharge_pending_result_handoffs AS handoff
         ON handoff.tenant_id = owner_action.tenant_id
         AND handoff.id = owner_action.handoff_id
        AND handoff.admission_id = owner_action.admission_id
        AND handoff.patient_uid = owner_action.patient_uid
      WHERE action.tenant_id = $1::uuid
         AND action.idempotency_key = $2::text
       LIMIT 2
       FOR SHARE OF action, owner_action, action_task, tracking_task, handoff`,
    tenantId,
    idempotencyKey,
  );
  if (rows.length > 1) {
    throw AppError.conflict(
      'Pending-result cross-sign idempotency evidence is ambiguous',
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_IDEMPOTENCY_CONFLICT',
    );
  }
  return rows[0] || null;
}

async function authorizePendingResultCrossSignActorTx({
  tx,
  tenantId,
  admissionId,
  handoffId,
  actorUid,
  actorRole,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT handoff.*,
            admission.encounter_id,
            pathway.id AS pathway_instance_id,
            actor.name AS actor_name,
            actor.role AS actor_role,
            actor.is_active AS actor_is_active,
            actor.status AS actor_status,
            actor.is_deleted AS actor_is_deleted,
            actor.deleted_at AS actor_deleted_at
       FROM discharge_pending_result_handoffs AS handoff
       JOIN admissions AS admission
         ON admission.tenant_id = handoff.tenant_id
        AND admission.id = handoff.admission_id
        AND admission.patient_uid = handoff.patient_uid
       JOIN care_pathway_resource_references AS reference
         ON reference.tenant_id = handoff.tenant_id
        AND reference.id = handoff.resource_reference_id
        AND reference.patient_uid = handoff.patient_uid
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = reference.tenant_id
        AND pathway.id = reference.pathway_instance_id
        AND pathway.patient_uid = reference.patient_uid
        AND pathway.pathway_key = $6::text
        AND pathway.source_episode_type = 'admission'
        AND pathway.source_episode_id = handoff.admission_id::text
       JOIN users AS actor
         ON actor.tenant_id = handoff.tenant_id
        AND actor.uid = $5::uuid
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.id = $2::uuid
        AND handoff.admission_id = $3::integer
        AND handoff.named_physician_uid = $4::uuid
      LIMIT 2
      FOR UPDATE OF handoff`,
    tenantId,
    handoffId,
    admissionId,
    actorUid,
    actorUid,
    CARE_PATHWAY_KEYS.INPATIENT,
  );
  const row = rows.length === 1 ? rows[0] : null;
  const liveRole = String(row?.actor_role || '').trim().toUpperCase();
  const claimedRole = String(actorRole || '').trim().toUpperCase();
  if (
    !row
    || row.actor_is_active !== true
    || row.actor_status !== 'active'
    || row.actor_is_deleted === true
    || row.actor_deleted_at != null
    || !isInpatientPendingResultPhysicianRole(liveRole)
    || liveRole !== claimedRole
  ) {
    throw AppError.forbidden(
      'Only the live named discharge follow-up physician may cross-sign this pending result',
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_FORBIDDEN',
    );
  }
  return row;
}

async function loadPendingResultCrossSignContextTx({
  tx,
  tenantId,
  handoff,
  generationId,
  diagnosticActionId,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT owner_action.*,
            generation.snapshot_sha256,
            generation.classification,
            generation.signer_uid,
            generation.signer_role,
            action_task.status AS action_task_status,
            action_task.task_kind AS action_task_kind,
            action_task.parent_task_id AS action_parent_task_id,
            action_task.patient_uid AS action_patient_uid,
            action_task.related_resource_type AS action_resource_type,
            action_task.related_resource_id AS action_resource_id,
            action_task.assigned_to_uid AS action_assigned_to_uid,
            action_task.assigned_to_role AS action_assigned_to_role,
            action_task.workflow_run_id AS action_workflow_run_id,
            action_task.workflow_step_id AS action_workflow_step_id,
            action_task.workflow_sla_instance_id AS action_sla_id,
            action_task.sla_completion_semantics AS action_sla_semantics,
            tracking_task.status AS tracking_task_status,
            tracking_task.task_kind AS tracking_task_kind,
            tracking_task.parent_task_id AS tracking_parent_task_id,
            tracking_task.patient_uid AS tracking_patient_uid,
            tracking_task.related_resource_type AS tracking_resource_type,
            tracking_task.related_resource_id AS tracking_resource_id,
            tracking_task.assigned_to_uid AS tracking_assigned_to_uid,
            tracking_task.assigned_to_role AS tracking_assigned_to_role,
            tracking_task.workflow_run_id AS tracking_workflow_run_id,
            tracking_task.workflow_step_id AS tracking_workflow_step_id,
            tracking_task.workflow_sla_instance_id AS tracking_sla_id,
            tracking_task.sla_completion_semantics AS tracking_sla_semantics,
            prior_action.id AS diagnostic_action_id,
            prior_action.action_kind AS diagnostic_action_kind,
            prior_action.disposition AS diagnostic_disposition,
            prior_action.signature_id AS diagnostic_signature_id,
            prior_action.occurred_at AS diagnostic_action_occurred_at
       FROM discharge_pending_result_owner_actions AS owner_action
       JOIN diagnostic_result_generations AS generation
         ON generation.tenant_id = owner_action.tenant_id
        AND generation.id = owner_action.generation_id
        AND generation.patient_uid = owner_action.patient_uid
        AND generation.admission_id = owner_action.admission_id
       JOIN tasks AS action_task
         ON action_task.tenant_id = owner_action.tenant_id
        AND action_task.id = owner_action.task_id
       JOIN tasks AS tracking_task
         ON tracking_task.tenant_id = owner_action.tenant_id
        AND tracking_task.id = $6::integer
       JOIN diagnostic_result_actions AS prior_action
         ON prior_action.tenant_id = owner_action.tenant_id
        AND prior_action.id = $7::uuid
        AND prior_action.generation_id = owner_action.generation_id
        AND prior_action.patient_uid = owner_action.patient_uid
      WHERE owner_action.tenant_id = $1::uuid
        AND owner_action.handoff_id = $2::uuid
        AND owner_action.admission_id = $3::integer
        AND owner_action.patient_uid = $4::uuid
        AND owner_action.generation_id = $5::uuid
        AND prior_action.action_kind = 'doctor_disposition'
        AND prior_action.signature_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM discharge_pending_result_owner_actions AS successor
           WHERE successor.tenant_id = owner_action.tenant_id
             AND successor.handoff_id = owner_action.handoff_id
             AND successor.predecessor_owner_action_id = owner_action.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM diagnostic_result_generations AS successor_generation
           WHERE successor_generation.tenant_id = generation.tenant_id
             AND successor_generation.patient_uid = generation.patient_uid
             AND successor_generation.admission_id = generation.admission_id
             AND successor_generation.predecessor_generation_id = generation.id
        )
      LIMIT 2
      FOR UPDATE OF owner_action, generation, action_task,
                    tracking_task, prior_action`,
    tenantId,
    handoff.id,
    handoff.admission_id,
    handoff.patient_uid,
    generationId,
    handoff.task_id,
    diagnosticActionId,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      'The named-owner cross-sign does not match the current authoritative diagnostic result obligation',
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_NOT_ACTIONABLE',
    );
  }
  return rows[0];
}

function assertPendingResultCrossSignTasks({ handoff, context, generationId, actorUid }) {
  const expectedActionResourceId = context.rearm_source_action_id != null
    ? `${handoff.id}:${generationId}:${context.predecessor_owner_action_id}`
    : `${handoff.id}:${generationId}`;
  const liveStatuses = new Set(['open', 'in_progress', 'blocked', 'overdue']);
  const actionTaskExact = (
    context.action_task_kind === 'review'
    && Number(context.action_parent_task_id) === Number(handoff.task_id)
    && context.action_patient_uid === handoff.patient_uid
    && context.action_resource_type === 'discharge_pending_result_action'
    && context.action_resource_id === expectedActionResourceId
    && context.action_assigned_to_uid === actorUid
    && context.action_assigned_to_role == null
    && context.action_workflow_run_id == null
    && context.action_workflow_step_id == null
    && context.action_sla_id == null
    && context.action_sla_semantics === 'none'
    && liveStatuses.has(context.action_task_status)
  );
  const trackingTaskExact = (
    context.tracking_task_kind === 'follow_up'
    && context.tracking_parent_task_id == null
    && context.tracking_patient_uid === handoff.patient_uid
    && context.tracking_resource_type === 'discharge_pending_result_handoff'
    && context.tracking_resource_id === handoff.id
    && context.tracking_assigned_to_uid === actorUid
    && context.tracking_assigned_to_role == null
    && context.tracking_workflow_run_id == null
    && context.tracking_workflow_step_id == null
    && context.tracking_sla_id == null
    && context.tracking_sla_semantics === 'none'
    && liveStatuses.has(context.tracking_task_status)
  );
  if (!actionTaskExact || !trackingTaskExact) {
    throw AppError.conflict(
      'The named-owner cross-sign tasks do not match the current handoff and generation',
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_TASK_CONFLICT',
    );
  }
}

export async function recordPendingResultOwnerCrossSign(
  admissionId,
  handoffId,
  input = {},
  actor = {},
) {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).some((key) => !PENDING_RESULT_CROSS_SIGN_INPUT_KEYS.has(key))
  ) {
    throw AppError.badRequest(
      'Pending-result cross-sign request contains unsupported fields',
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_INPUT_INVALID',
    );
  }
  const id = normalizedId(admissionId, 'admission_id');
  const tenantId = requireTenantId(actor.tenantId);
  const hid = normalizedUuid(handoffId, 'handoff_id');
  const generationId = normalizedUuid(input.generation_id, 'generation_id');
  const diagnosticActionId = normalizedUuid(
    input.diagnostic_action_id,
    'diagnostic_action_id',
  );
  const actorUid = normalizedUuid(actor.uid, 'actor uid');
  const idempotencyKey = normalizedIdempotencyKey(
    input.idempotencyKey,
    'INPATIENT_PENDING_RESULT_CROSS_SIGN_IDEMPOTENCY_KEY_INVALID',
  );
  if (input.attested !== true) {
    throw AppError.badRequest(
      'Explicit named-owner review attestation is required',
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_ATTESTATION_REQUIRED',
    );
  }
  const attestedHash = String(input.generation_snapshot_sha256 || '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(attestedHash)) {
    throw AppError.badRequest(
      'generation_snapshot_sha256 must be a SHA-256 hash',
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_INPUT_INVALID',
    );
  }
  const requestSha256 = sha256ClinicalJson({
    admission_id: id,
    handoff_id: hid,
    generation_id: generationId,
    diagnostic_action_id: diagnosticActionId,
    generation_snapshot_sha256: attestedHash,
    attestation: PENDING_RESULT_CROSS_SIGN_ATTESTATION,
  });

  return setTenantTx(tenantId, async (tx) => {
    const handoff = await authorizePendingResultCrossSignActorTx({
      tx,
      tenantId,
      admissionId: id,
      handoffId: hid,
      actorUid,
      actorRole: actor.role,
    });

    const existing = await loadPendingResultCrossSignReplayTx({
      tx,
      tenantId,
      idempotencyKey,
    });
    if (existing) {
      if (
        existing.action_kind !== 'discharge_owner_cross_sign'
        || String(existing.handoff_id) !== hid
        || Number(existing.admission_id) !== id
        || String(existing.generation_id) !== generationId
        || String(existing.predecessor_action_id) !== diagnosticActionId
        || String(existing.actor_uid) !== actorUid
        || existing.downstream_resource_type !== 'discharge_pending_result_handoff'
        || existing.downstream_resource_id !== hid
        || existing.generation_snapshot_sha256 !== attestedHash
        || existing.request_sha256 !== requestSha256
      ) {
        throw AppError.conflict(
          'Pending-result cross-sign idempotency key was reused with different content',
          'INPATIENT_PENDING_RESULT_CROSS_SIGN_IDEMPOTENCY_CONFLICT',
        );
      }
      return pendingResultCrossSignReceipt(existing, {
        replayed: true,
        currentHandoffState: handoff.handoff_state,
      });
    }
    if (
      handoff.handoff_state !== 'result_available'
      || handoff.resolution_action_id != null
      || handoff.resolved_at != null
      || handoff.resolved_by_uid != null
    ) {
      throw AppError.conflict(
        'Pending-result handoff is not awaiting named-owner cross-sign',
        'INPATIENT_PENDING_RESULT_CROSS_SIGN_NOT_ACTIONABLE',
      );
    }
    const context = await loadPendingResultCrossSignContextTx({
      tx,
      tenantId,
      handoff,
      generationId,
      diagnosticActionId,
    });
    if (context.snapshot_sha256 !== attestedHash) {
      throw AppError.conflict(
        'Attested diagnostic generation hash is stale',
        'INPATIENT_PENDING_RESULT_CROSS_SIGN_GENERATION_STALE',
      );
    }
    assertPendingResultCrossSignTasks({
      handoff,
      context,
      generationId,
      actorUid,
    });

    const actionId = randomUUID();
    const signatureId = randomUUID();
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: handoff.patient_uid,
      encounterId: handoff.encounter_id,
      eventType: 'discharge.pending_result_resolved',
      eventStatus: 'owner_cross_signed',
      sourceTable: 'diagnostic_result_actions',
      sourceId: actionId,
      resourceType: 'discharge_pending_result_handoff',
      resourceTable: 'discharge_pending_result_handoffs',
      resourceId: hid,
      actorUid,
      actorRole: handoff.actor_role,
      visibleToPatient: false,
      summary: 'Named discharge follow-up physician reviewed the available result',
      payload: {
        admission_id: id,
        handoff_id: hid,
        generation_id: generationId,
        diagnostic_action_id: diagnosticActionId,
        owner_action_id: context.id,
        action_task_id: Number(context.task_id),
        tracking_task_id: Number(handoff.task_id),
        signature_id: signatureId,
      },
      afterState: {
        handoff_state: 'resolved',
        resolution_action_id: actionId,
        generation_snapshot_sha256: attestedHash,
        request_sha256: requestSha256,
      },
      tags: ['inpatient', 'discharge', 'pending_result', 'owner_cross_sign'],
      timelineIdempotencyKey: `pending-result-cross-sign:${tenantId}:${actionId}:timeline`,
      auditIdempotencyKey: `pending-result-cross-sign:${tenantId}:${actionId}:audit`,
    }, { db: tx, strict: true });
    if (!canonical?.timeline?.id || !canonical?.audit?.id) {
      throw AppError.internal(
        'Pending-result cross-sign canonical evidence is unavailable',
        'INPATIENT_PENDING_RESULT_CROSS_SIGN_EVIDENCE_REQUIRED',
      );
    }
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO diagnostic_result_actions
         (id, tenant_id, patient_uid, generation_id, pathway_instance_id,
          task_id, action_kind, generation_snapshot_sha256,
          actor_uid, actor_role, downstream_resource_type,
          downstream_resource_id, idempotency_key, request_sha256,
          predecessor_action_id, signature_id,
          canonical_timeline_event_id, canonical_audit_event_id)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::integer, 'discharge_owner_cross_sign', $7::text,
          $8::uuid, $9::text, 'discharge_pending_result_handoff',
          $10::text, $11::text, $12::text,
          $13::uuid, $14::uuid, $15::uuid, $16::uuid)
       RETURNING *`,
      actionId,
      tenantId,
      handoff.patient_uid,
      generationId,
      handoff.pathway_instance_id,
      Number(context.task_id),
      attestedHash,
      actorUid,
      handoff.actor_role,
      hid,
      idempotencyKey,
      requestSha256,
      diagnosticActionId,
      signatureId,
      canonical.timeline.id,
      canonical.audit.id,
    );
    await signDocumentTx({
      documentType: 'diagnostic_result_action',
      documentId: actionId,
      statement: PENDING_RESULT_CROSS_SIGN_ATTESTATION,
      signatureId,
      canonicalAuditEventId: canonical.audit.id,
      canonicalAuditResourceTable: 'discharge_pending_result_handoffs',
      canonicalAuditResourceId: hid,
    }, {
      actorUid,
      actorRole: handoff.actor_role,
      actorName: handoff.actor_name,
    }, { tx });
    const event = await publishEvent({
      eventType: 'discharge.pending_result_resolved',
      aggregateType: 'discharge_pending_result_handoff',
      aggregateId: hid,
      patientUid: handoff.patient_uid,
      tenantId,
      tx,
      payload: {
        admission_id: id,
        handoff_id: hid,
        generation_id: generationId,
        diagnostic_action_id: diagnosticActionId,
        resolution_action_id: actionId,
        owner_action_id: context.id,
        action_task_id: Number(context.task_id),
        tracking_task_id: Number(handoff.task_id),
        canonical_timeline_event_id: canonical.timeline.id,
        canonical_audit_event_id: canonical.audit.id,
        admission_lineage_version: 1,
      },
    });
    if (!event?.id) {
      throw AppError.internal(
        'Pending-result cross-sign outbox evidence is unavailable',
        'INPATIENT_PENDING_RESULT_CROSS_SIGN_EVIDENCE_REQUIRED',
      );
    }
    const resolvedRows = await tx.$queryRawUnsafe(
      `UPDATE discharge_pending_result_handoffs
          SET handoff_state = 'resolved',
              result_status = 'reviewed',
              resolved_at = clock_timestamp(),
              resolved_by_uid = $5::uuid,
              resolution_action_id = $6::uuid,
              updated_at = GREATEST(
                clock_timestamp(),
                updated_at + INTERVAL '1 microsecond'
              )
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND admission_id = $3::integer
          AND patient_uid = $4::uuid
          AND named_physician_uid = $5::uuid
          AND handoff_state = 'result_available'
          AND resolution_action_id IS NULL
          AND resolved_at IS NULL
          AND resolved_by_uid IS NULL
        RETURNING *`,
      tenantId,
      hid,
      id,
      handoff.patient_uid,
      actorUid,
      actionId,
    );
    if (!resolvedRows[0]) {
      throw AppError.conflict(
        'Pending-result handoff changed before named-owner settlement',
        'INPATIENT_PENDING_RESULT_CROSS_SIGN_CONFLICT',
      );
    }
    await settlePendingResultTasksFromOwnerCrossSignTx({
      tenantId,
      handoffId: hid,
      generationId,
      ownerActionId: context.id,
      crossSignActionId: actionId,
      actionTaskId: Number(context.task_id),
      trackingTaskId: Number(handoff.task_id),
      patientUid: handoff.patient_uid,
      actorUid,
      tx,
    });
    return pendingResultCrossSignReceipt({
      ...inserted[0],
      handoff_id: hid,
      admission_id: id,
      tracking_task_id: Number(handoff.task_id),
      owner_action_id: context.id,
      current_handoff_state: 'resolved',
    }, { replayed: false });
  });
}

export async function recordPendingResultAvailable(
  admissionId,
  handoffId,
  input = {},
  actor = {},
) {
  const id = normalizedId(admissionId, 'admission_id');
  const tenantId = requireTenantId(actor.tenantId);
  const hid = normalizedUuid(handoffId, 'handoff_id');
  const generationId = normalizedUuid(input.generation_id, 'generation_id');
  const actorUid = normalizedUuid(actor.uid, 'actor uid');
  return setTenantTx(tenantId, async (tx) => {
    const admission = await admissionContextTx(tx, tenantId, id);
    const rows = await tx.$queryRawUnsafe(
      `SELECT handoff.*, reference.pathway_instance_id, pathway.workflow_run_id
         FROM discharge_pending_result_handoffs AS handoff
         JOIN care_pathway_resource_references AS reference
           ON reference.tenant_id = handoff.tenant_id
          AND reference.id = handoff.resource_reference_id
          AND reference.patient_uid = handoff.patient_uid
          AND reference.resource_type = handoff.source_type
          AND reference.resource_id = handoff.source_id
          AND reference.relationship_kind = 'child_action'
          AND ${currentReferenceClause('reference')}
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = reference.tenant_id
          AND pathway.id = reference.pathway_instance_id
          AND pathway.patient_uid = reference.patient_uid
          AND pathway.pathway_key = $5::text
          AND pathway.source_episode_type = 'admission'
          AND pathway.source_episode_id = ($3::integer)::text
        WHERE handoff.tenant_id = $1::uuid
          AND handoff.id = $2::uuid
          AND handoff.admission_id = $3::integer
          AND handoff.patient_uid = $4::uuid
          AND handoff.handoff_state IN ('pending', 'result_available')
        LIMIT 1
        FOR UPDATE OF handoff`,
      tenantId,
      hid,
      id,
      admission.patient_uid,
      CARE_PATHWAY_KEYS.INPATIENT,
    );
    const handoff = rows[0];
    if (!handoff) throw AppError.notFound('Pending-result handoff not found');
    await assertAccountableEvidenceActorTx({
      tx,
      tenantId,
      admissionId: id,
      actorUid,
      actorRole: actor.role,
    });
    const generation = await loadAuthoritativeGenerationTx({
      tx,
      tenantId,
      generationId,
      admissionId: id,
      patientUid: admission.patient_uid,
    });
    return correlatePendingResultGenerationTx({
      tx,
      tenantId,
      admission,
      handoff,
      generation,
      actorUid,
      actorRole: actor.role,
    });
  });
}

export default {
  establishInitialPrimaryPhysicianTx,
  getInpatientDischargeEvidence,
  getInpatientDischargeEvidenceTx,
  linkPendingResultOwnerActionsForGenerationTx,
  listPostDischargeContacts,
  publishInpatientDiagnosticResourceLinkedTx,
  publishInpatientSourceEventTx,
  rearmPendingResultOwnerActionsForDiagnosticReopenTx,
  recordFollowUpException,
  recordPendingResultAvailable,
  recordPendingResultOwnerCrossSign,
  recordPendingResultHandoff,
  recordPendingResultSummaryInclusion,
  recordPostDischargeContact,
  recordPrimaryPhysicianChangeTx,
  resolveInpatientPathwayModeTx,
  settlePendingResultOwnerActionsForDiagnosticActionTx,
};
