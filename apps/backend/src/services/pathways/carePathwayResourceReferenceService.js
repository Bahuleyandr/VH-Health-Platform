import { AppError } from '../../utils/AppError.js';
import { isRegisteredWorkflowSystemActor } from '../workflow/workflowRuntimeRegistry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]+$/;
const PG_INT4_MAX = 2147483647;
const PG_INT8_MAX = 9223372036854775807n;

export const CARE_PATHWAY_RESOURCE_TYPES = Object.freeze([
  'appointment',
  'admission',
  'e_prescription',
  'clinical_order',
  'investigation',
  'lab_result',
  'radiology_order',
  'anatomical_pathology_case',
  'diagnostic_result_generation',
  'referral',
  'follow_up_plan',
  'clinical_note',
  'discharge_summary',
  'discharge_consult',
]);

export const CARE_PATHWAY_RESOURCE_RELATIONSHIP_KINDS = Object.freeze([
  'child_action',
  'closure_evidence',
]);

export const CARE_PATHWAY_RESOURCE_EVIDENCE_STATES = Object.freeze([
  'open',
  'completed',
  'ownership_accepted',
  'superseded',
]);

const RESOURCE_TYPE_SET = new Set(CARE_PATHWAY_RESOURCE_TYPES);
const RELATIONSHIP_KIND_SET = new Set(CARE_PATHWAY_RESOURCE_RELATIONSHIP_KINDS);
const EVIDENCE_STATE_SET = new Set(CARE_PATHWAY_RESOURCE_EVIDENCE_STATES);

const RESOURCE_RESOLVERS = Object.freeze({
  appointment: Object.freeze({
    idKind: 'int4',
    sql: `SELECT patient.uid::text AS patient_uid
            FROM appointments AS resource
            JOIN users AS patient
              ON patient.tenant_id = resource.tenant_id
             AND patient.id = resource.patient_id
             AND patient.role = 'PATIENT'
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE OF resource, patient`,
  }),
  admission: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM admissions AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  e_prescription: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM e_prescriptions AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  clinical_order: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM clinical_orders AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  investigation: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM investigations AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  lab_result: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM lab_results AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  radiology_order: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM radiology_orders AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  anatomical_pathology_case: Object.freeze({
    idKind: 'int8',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM ap_cases AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::bigint
           LIMIT 1
           FOR SHARE`,
  }),
  diagnostic_result_generation: Object.freeze({
    idKind: 'uuid',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM diagnostic_result_generations AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::uuid
           LIMIT 1
           FOR SHARE`,
  }),
  referral: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM referrals AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  follow_up_plan: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM follow_up_plans AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  clinical_note: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM clinical_notes AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  discharge_summary: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM discharge_summaries AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
  discharge_consult: Object.freeze({
    idKind: 'int4',
    sql: `SELECT resource.patient_uid::text AS patient_uid
            FROM discharge_consults AS resource
           WHERE resource.tenant_id = $1::uuid
             AND resource.id = $2::integer
           LIMIT 1
           FOR SHARE`,
  }),
});

const REFERENCE_COLUMNS = `id, tenant_id, pathway_instance_id, patient_uid,
  resource_type, relationship_kind, evidence_state, resource_id,
  accepted_owner_uid, task_id, handoff_id, source_outbox_event_id,
  canonical_timeline_event_id, canonical_audit_event_id, actor_uid,
  actor_system_key, occurred_at, recorded_at, idempotency_key,
  superseded_reference_id, metadata`;

function requireTx(tx) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    throw AppError.internal(
      'Care pathway resource references require a transaction client',
      'CARE_PATHWAY_RESOURCE_REFERENCE_TX_REQUIRED',
    );
  }
  return tx;
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(
      `${label} must be a UUID`,
      'CARE_PATHWAY_RESOURCE_REFERENCE_INPUT_INVALID',
    );
  }
  return text;
}

function optionalUuid(value, label) {
  return value == null || value === '' ? null : requireUuid(value, label);
}

function requireEnum(value, allowed, label, code) {
  const text = String(value || '').trim().toLowerCase();
  if (!allowed.has(text)) {
    throw AppError.badRequest(`${label} is unsupported`, code);
  }
  return text;
}

function normalizeInt4(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw AppError.badRequest(
      `${label} must be a positive integer`,
      'CARE_PATHWAY_RESOURCE_REFERENCE_INPUT_INVALID',
    );
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > PG_INT4_MAX) {
    throw AppError.badRequest(
      `${label} must be a positive PostgreSQL integer`,
      'CARE_PATHWAY_RESOURCE_REFERENCE_INPUT_INVALID',
    );
  }
  return String(parsed);
}

function normalizeInt8(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw AppError.badRequest(
      `${label} must be a positive bigint`,
      'CARE_PATHWAY_RESOURCE_REFERENCE_INPUT_INVALID',
    );
  }
  const parsed = BigInt(text);
  if (parsed <= 0n || parsed > PG_INT8_MAX) {
    throw AppError.badRequest(
      `${label} must be a positive PostgreSQL bigint`,
      'CARE_PATHWAY_RESOURCE_REFERENCE_INPUT_INVALID',
    );
  }
  return parsed.toString();
}

function normalizeResourceId(value, idKind) {
  if (idKind === 'uuid') return requireUuid(value, 'resourceId');
  if (idKind === 'int8') return normalizeInt8(value, 'resourceId');
  return normalizeInt4(value, 'resourceId');
}

function optionalPositiveInt4(value, label) {
  return value == null || value === '' ? null : Number(normalizeInt4(value, label));
}

function optionalPositiveInt8(value, label) {
  return value == null || value === '' ? null : normalizeInt8(value, label);
}

function requireIdempotencyKey(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 200 || !IDEMPOTENCY_RE.test(text)) {
    throw AppError.badRequest(
      'idempotencyKey must be 1-200 characters [A-Za-z0-9_.:-]',
      'CARE_PATHWAY_RESOURCE_REFERENCE_IDEMPOTENCY_INVALID',
    );
  }
  return text;
}

function normalizeOccurredAt(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest(
      'occurredAt must be a valid timestamp',
      'CARE_PATHWAY_RESOURCE_REFERENCE_INPUT_INVALID',
    );
  }
  return parsed.toISOString();
}

function normalizeMetadata(value) {
  const metadata = value ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw AppError.badRequest(
      'metadata must be a JSON object',
      'CARE_PATHWAY_RESOURCE_REFERENCE_INPUT_INVALID',
    );
  }
  return metadata;
}

function normalizeActor({ actorUid, actor }) {
  const uid = optionalUuid(actorUid, 'actorUid');
  const hasSystemActor = actor != null;
  if ((uid == null) === !hasSystemActor) {
    throw AppError.badRequest(
      'Exactly one of actorUid or a registered system actor is required',
      'CARE_PATHWAY_RESOURCE_REFERENCE_ACTOR_INVALID',
    );
  }
  if (hasSystemActor && !isRegisteredWorkflowSystemActor(actor)) {
    throw AppError.forbidden(
      'Care pathway resource-reference system actor is not registered',
      'CARE_PATHWAY_RESOURCE_REFERENCE_SYSTEM_ACTOR_NOT_REGISTERED',
    );
  }
  return {
    actorUid: uid,
    actorSystemKey: hasSystemActor ? actor.systemKey : null,
  };
}

function normalizeReferenceInput(input = {}) {
  const resourceType = requireEnum(
    input.resourceType,
    RESOURCE_TYPE_SET,
    'resourceType',
    'CARE_PATHWAY_RESOURCE_TYPE_UNSUPPORTED',
  );
  const resolver = RESOURCE_RESOLVERS[resourceType];
  const relationshipKind = requireEnum(
    input.relationshipKind,
    RELATIONSHIP_KIND_SET,
    'relationshipKind',
    'CARE_PATHWAY_RESOURCE_RELATIONSHIP_UNSUPPORTED',
  );
  const evidenceState = requireEnum(
    input.evidenceState,
    EVIDENCE_STATE_SET,
    'evidenceState',
    'CARE_PATHWAY_RESOURCE_EVIDENCE_STATE_UNSUPPORTED',
  );
  const actor = normalizeActor(input);
  const acceptedOwnerUid = optionalUuid(input.acceptedOwnerUid, 'acceptedOwnerUid');
  const taskId = optionalPositiveInt4(input.taskId, 'taskId');
  const handoffId = optionalUuid(input.handoffId, 'handoffId');
  const supersededReferenceId = optionalUuid(
    input.supersededReferenceId,
    'supersededReferenceId',
  );

  if (
    evidenceState === 'ownership_accepted'
    && (!acceptedOwnerUid || (!taskId && !handoffId))
  ) {
    throw AppError.badRequest(
      'ownership_accepted evidence requires an accepted owner and task or handoff',
      'CARE_PATHWAY_RESOURCE_REFERENCE_OWNERSHIP_INVALID',
    );
  }
  if (evidenceState === 'superseded' && !supersededReferenceId) {
    throw AppError.badRequest(
      'superseded evidence requires supersededReferenceId',
      'CARE_PATHWAY_RESOURCE_REFERENCE_SUPERSESSION_INVALID',
    );
  }

  return Object.freeze({
    tenantId: requireUuid(input.tenantId, 'tenantId'),
    pathwayInstanceId: requireUuid(input.pathwayInstanceId, 'pathwayInstanceId'),
    patientUid: requireUuid(input.patientUid, 'patientUid'),
    resourceType,
    relationshipKind,
    evidenceState,
    resourceId: normalizeResourceId(input.resourceId, resolver.idKind),
    acceptedOwnerUid,
    taskId,
    handoffId,
    sourceOutboxEventId: optionalPositiveInt8(
      input.sourceOutboxEventId,
      'sourceOutboxEventId',
    ),
    canonicalTimelineEventId: optionalUuid(
      input.canonicalTimelineEventId,
      'canonicalTimelineEventId',
    ),
    canonicalAuditEventId: optionalUuid(
      input.canonicalAuditEventId,
      'canonicalAuditEventId',
    ),
    ...actor,
    occurredAt: normalizeOccurredAt(input.occurredAt),
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
    supersededReferenceId,
    metadata: normalizeMetadata(input.metadata),
  });
}

function stableJson(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rowTimestamp(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nullableText(value) {
  return value == null ? null : String(value);
}

function nullableLowerText(value) {
  const text = nullableText(value);
  return text == null ? null : text.toLowerCase();
}

function rowMatchesInput(row, input) {
  return (
    String(row.tenant_id).toLowerCase() === input.tenantId
    && String(row.pathway_instance_id).toLowerCase() === input.pathwayInstanceId
    && String(row.patient_uid).toLowerCase() === input.patientUid
    && row.resource_type === input.resourceType
    && row.relationship_kind === input.relationshipKind
    && row.evidence_state === input.evidenceState
    && String(row.resource_id) === input.resourceId
    && nullableLowerText(row.accepted_owner_uid)
      === nullableLowerText(input.acceptedOwnerUid)
    && nullableText(row.task_id) === nullableText(input.taskId)
    && nullableLowerText(row.handoff_id) === nullableLowerText(input.handoffId)
    && nullableText(row.source_outbox_event_id) === nullableText(input.sourceOutboxEventId)
    && nullableLowerText(row.canonical_timeline_event_id)
      === nullableLowerText(input.canonicalTimelineEventId)
    && nullableLowerText(row.canonical_audit_event_id)
      === nullableLowerText(input.canonicalAuditEventId)
    && nullableLowerText(row.actor_uid) === nullableLowerText(input.actorUid)
    && nullableText(row.actor_system_key) === nullableText(input.actorSystemKey)
    && rowTimestamp(row.occurred_at) === input.occurredAt
    && nullableLowerText(row.superseded_reference_id)
      === nullableLowerText(input.supersededReferenceId)
    && stableJson(row.metadata ?? {}) === stableJson(input.metadata)
  );
}

function sqlState(error) {
  return error?.meta?.code || error?.code || error?.cause?.code || null;
}

export async function resolvePathwayResourceTx(tx, {
  tenantId,
  patientUid,
  resourceType,
  resourceId,
} = {}) {
  requireTx(tx);
  const tenant = requireUuid(tenantId, 'tenantId');
  const patient = requireUuid(patientUid, 'patientUid');
  const type = requireEnum(
    resourceType,
    RESOURCE_TYPE_SET,
    'resourceType',
    'CARE_PATHWAY_RESOURCE_TYPE_UNSUPPORTED',
  );
  const resolver = RESOURCE_RESOLVERS[type];
  const id = normalizeResourceId(resourceId, resolver.idKind);
  const rows = await tx.$queryRawUnsafe(resolver.sql, tenant, id);
  const resolvedPatientUid = String(rows[0]?.patient_uid || '').trim().toLowerCase();
  if (rows.length !== 1 || resolvedPatientUid !== patient) {
    throw AppError.conflict(
      'Care pathway resource is unavailable for this tenant and patient',
      'CARE_PATHWAY_RESOURCE_UNAVAILABLE',
    );
  }
  return Object.freeze({
    tenantId: tenant,
    patientUid: patient,
    resourceType: type,
    resourceId: id,
  });
}

export const resolveCarePathwayResourceTx = resolvePathwayResourceTx;

function ownershipEvidenceInvalid(message) {
  return AppError.conflict(
    message,
    'CARE_PATHWAY_RESOURCE_REFERENCE_OWNERSHIP_INVALID',
  );
}

async function validateOwnershipEvidenceTx(tx, input) {
  if (input.evidenceState !== 'ownership_accepted') return;

  if (input.taskId) {
    const taskRows = await tx.$queryRawUnsafe(
      `SELECT task.id
         FROM tasks AS task
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = task.tenant_id
          AND pathway.workflow_run_id = task.workflow_run_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::integer
          AND task.patient_uid = $3::uuid
          AND pathway.id = $4::uuid
          AND pathway.patient_uid = $3::uuid
          AND task.related_resource_type = $5::text
          AND task.related_resource_id = $6::text
          AND task.assigned_to_uid = $7::uuid
          AND task.assigned_to_role IS NULL
          AND task.status = 'completed'
          AND task.completed_at IS NOT NULL
        LIMIT 1
        FOR SHARE OF task, pathway`,
      input.tenantId,
      input.taskId,
      input.patientUid,
      input.pathwayInstanceId,
      input.resourceType,
      input.resourceId,
      input.acceptedOwnerUid,
    );
    if (!taskRows[0]) {
      throw ownershipEvidenceInvalid(
        'Ownership task does not match this pathway, patient, resource, owner, or accepted status',
      );
    }
  }

  if (input.handoffId) {
    const handoffRows = await tx.$queryRawUnsafe(
      `SELECT handoff.id
         FROM care_handoff_instances AS handoff
        WHERE handoff.tenant_id = $1::uuid
          AND handoff.id = $2::uuid
          AND handoff.patient_uid = $3::uuid
          AND handoff.sending_pathway_instance_id = $4::uuid
          AND handoff.source_resource_type = $5::text
          AND handoff.source_resource_id = $6::text
          AND handoff.recipient_kind = 'user'
          AND handoff.intended_recipient_uid = $7::uuid
          AND handoff.accepted_by_uid = $7::uuid
          AND handoff.status IN ('accepted', 'completed', 'closed_loop')
          AND handoff.accepted_at IS NOT NULL
          AND (
            $8::integer IS NULL
            OR handoff.task_id = $8::integer
          )
        LIMIT 1
        FOR SHARE`,
      input.tenantId,
      input.handoffId,
      input.patientUid,
      input.pathwayInstanceId,
      input.resourceType,
      input.resourceId,
      input.acceptedOwnerUid,
      input.taskId,
    );
    if (!handoffRows[0]) {
      throw ownershipEvidenceInvalid(
        'Ownership handoff does not match this pathway, patient, resource, recipient, or accepted status',
      );
    }
  }
}

export async function appendPathwayResourceReferenceTx(tx, input = {}) {
  requireTx(tx);
  const normalized = normalizeReferenceInput(input);
  await resolvePathwayResourceTx(tx, normalized);
  await validateOwnershipEvidenceTx(tx, normalized);

  let inserted;
  try {
    inserted = await tx.$queryRawUnsafe(
      `INSERT INTO care_pathway_resource_references (
         id, tenant_id, pathway_instance_id, patient_uid, resource_type,
         relationship_kind, evidence_state, resource_id, accepted_owner_uid,
         task_id, handoff_id, source_outbox_event_id,
         canonical_timeline_event_id, canonical_audit_event_id, actor_uid,
         actor_system_key, occurred_at, recorded_at, idempotency_key,
         superseded_reference_id, metadata
       )
       VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::text,
         $5::text, $6::text, $7::text, $8::uuid, $9::integer, $10::uuid,
         $11::bigint, $12::uuid, $13::uuid, $14::uuid, $15::text,
         $16::timestamptz, clock_timestamp(), $17::text, $18::uuid, $19::jsonb
       )
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING ${REFERENCE_COLUMNS}`,
      normalized.tenantId,
      normalized.pathwayInstanceId,
      normalized.patientUid,
      normalized.resourceType,
      normalized.relationshipKind,
      normalized.evidenceState,
      normalized.resourceId,
      normalized.acceptedOwnerUid,
      normalized.taskId,
      normalized.handoffId,
      normalized.sourceOutboxEventId,
      normalized.canonicalTimelineEventId,
      normalized.canonicalAuditEventId,
      normalized.actorUid,
      normalized.actorSystemKey,
      normalized.occurredAt,
      normalized.idempotencyKey,
      normalized.supersededReferenceId,
      JSON.stringify(normalized.metadata),
    );
  } catch (error) {
    if (sqlState(error) === '23505') {
      throw AppError.conflict(
        'Care pathway resource reference already exists',
        'CARE_PATHWAY_RESOURCE_REFERENCE_DUPLICATE',
      );
    }
    throw error;
  }

  if (inserted[0]) {
    return Object.freeze({ ...inserted[0], replayed: false });
  }

  const replayRows = await tx.$queryRawUnsafe(
    `SELECT ${REFERENCE_COLUMNS}
       FROM care_pathway_resource_references
      WHERE tenant_id = $1::uuid
        AND idempotency_key = $2::text
      LIMIT 1
      FOR SHARE`,
    normalized.tenantId,
    normalized.idempotencyKey,
  );
  const replay = replayRows[0];
  if (!replay || !rowMatchesInput(replay, normalized)) {
    throw AppError.conflict(
      'Care pathway resource reference idempotency key conflicts with another request',
      'CARE_PATHWAY_RESOURCE_REFERENCE_IDEMPOTENCY_CONFLICT',
    );
  }
  return Object.freeze({ ...replay, replayed: true });
}

export async function supersedePathwayResourceReferenceTx(tx, input = {}) {
  requireTx(tx);
  const tenantId = requireUuid(input.tenantId, 'tenantId');
  const pathwayInstanceId = requireUuid(
    input.pathwayInstanceId,
    'pathwayInstanceId',
  );
  const patientUid = requireUuid(input.patientUid, 'patientUid');
  const supersededReferenceId = requireUuid(
    input.supersededReferenceId,
    'supersededReferenceId',
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${REFERENCE_COLUMNS}
       FROM care_pathway_resource_references AS reference
      WHERE reference.tenant_id = $1::uuid
        AND reference.id = $2::uuid
        AND reference.pathway_instance_id = $3::uuid
        AND reference.patient_uid = $4::uuid
        AND NOT EXISTS (
          SELECT 1
            FROM care_pathway_resource_references AS successor
           WHERE successor.tenant_id = reference.tenant_id
             AND successor.superseded_reference_id = reference.id
        )
      LIMIT 1
      FOR SHARE OF reference`,
    tenantId,
    supersededReferenceId,
    pathwayInstanceId,
    patientUid,
  );
  const previous = rows[0];
  if (!previous) {
    throw AppError.conflict(
      'Current care pathway resource reference is unavailable',
      'CARE_PATHWAY_RESOURCE_REFERENCE_SUPERSEDED',
    );
  }
  return appendPathwayResourceReferenceTx(tx, {
    ...input,
    tenantId,
    pathwayInstanceId,
    patientUid,
    resourceType: previous.resource_type,
    relationshipKind: previous.relationship_kind,
    resourceId: previous.resource_id,
    acceptedOwnerUid: input.acceptedOwnerUid ?? previous.accepted_owner_uid,
    taskId: input.taskId ?? previous.task_id,
    handoffId: input.handoffId ?? previous.handoff_id,
    supersededReferenceId,
  });
}

export const __testing__ = Object.freeze({
  RESOURCE_RESOLVERS,
  normalizeReferenceInput,
  rowMatchesInput,
  validateOwnershipEvidenceTx,
});
