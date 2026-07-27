import { createHash, randomUUID } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { isClinical } from '../../utils/roleHelpers.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  createEdClosureReviewTaskTx,
  transitionTask,
} from '../workflow/taskService.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_CODE_RE = /^[a-z][a-z0-9_]{0,79}$/;
const MAX_NEXT_STEPS = 32;
const MAX_NEXT_STEPS_BYTES = 32_768;

export const ED_CLOSURE_KINDS = Object.freeze([
  'discharge',
  'left_against_medical_advice',
  'lwbs',
  'external_transfer',
  'death',
]);
export const ED_RECOVERY_EVENT_KINDS = Object.freeze(['attempt', 'outcome']);
export const ED_RECOVERY_CHANNELS = Object.freeze([
  'phone',
  'sms',
  'email',
  'patient_portal',
  'in_person',
  'video',
  'other',
]);
const IDENTITY_STATUSES = Object.freeze([
  'verified',
  'temporary_identity_retained',
  'merge_requested',
  'merged',
]);
const NEXT_STEP_STATUSES = Object.freeze([
  'planned',
  'open',
  'scheduled',
  'pending',
  'in_progress',
  'ready',
  'completed',
  'cancelled',
  'on_hold',
  'overdue',
]);
const NEXT_STEP_ROUTE_TOKENS = Object.freeze([
  'home',
  'health',
  'appointments',
  'book_appointment',
  'investigations',
  'lab_results',
  'diagnostic_results',
  'referrals',
  'discharge_summaries',
  'messages',
]);
const CLOSURE_KIND_SET = new Set(ED_CLOSURE_KINDS);
const RECOVERY_KIND_SET = new Set(ED_RECOVERY_EVENT_KINDS);
const RECOVERY_CHANNEL_SET = new Set(ED_RECOVERY_CHANNELS);
const IDENTITY_STATUS_SET = new Set(IDENTITY_STATUSES);
const NEXT_STEP_STATUS_SET = new Set(NEXT_STEP_STATUSES);
const NEXT_STEP_ROUTE_TOKEN_SET = new Set(NEXT_STEP_ROUTE_TOKENS);
const AUTHORABLE_NEXT_STEP_FIELDS = Object.freeze([
  'label',
  'explanation',
  'due_date',
  'status',
  'patient_action',
  'route_token',
]);

function uuid(value, label, { required = false } = {}) {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  if (!normalized && !required) return null;
  if (!UUID_RE.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'ED_CLOSURE_EVIDENCE_INVALID');
  }
  return normalized;
}

function positiveInteger(value, label, { required = false } = {}) {
  if ((value == null || value === '') && !required) return null;
  const normalized = String(value).trim();
  const parsed = Number.parseInt(normalized, 10);
  if (!/^[1-9]\d*$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    throw AppError.badRequest(
      `${label} must be a positive integer`,
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  return parsed;
}

function text(value, max, label, { required = false } = {}) {
  const normalized = value == null ? '' : String(value).trim();
  if (!normalized && required) {
    throw AppError.badRequest(`${label} is required`, 'ED_CLOSURE_EVIDENCE_INVALID');
  }
  if (normalized.length > max) {
    throw AppError.badRequest(`${label} is too long`, 'ED_CLOSURE_EVIDENCE_INVALID');
  }
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw AppError.badRequest(
        `${label} contains control characters`,
        'ED_CLOSURE_EVIDENCE_INVALID',
      );
    }
  }
  return normalized || null;
}

function timestamp(value, label) {
  if (value == null || value === '') return null;
  const normalized = text(value, 80, label, { required: true });
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest(
      `${label} must be an ISO timestamp`,
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  return parsed.toISOString();
}

function timestampsMatch(storedValue, normalizedValue, { optional = false } = {}) {
  if (optional && normalizedValue == null) return true;
  if (storedValue == null || normalizedValue == null) {
    return storedValue == null && normalizedValue == null;
  }
  return new Date(storedValue).toISOString() === new Date(normalizedValue).toISOString();
}

function date(value, label) {
  if (value == null || value === '') return null;
  const normalized = text(value, 10, label, { required: true });
  if (!DATE_RE.test(normalized)) {
    throw AppError.badRequest(
      `${label} must be YYYY-MM-DD`,
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw AppError.badRequest(
      `${label} must be a valid date`,
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  return normalized;
}

function enumValue(value, allowed, label, { required = false, fallback = null } = {}) {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  if (!normalized) {
    if (required) {
      throw AppError.badRequest(`${label} is required`, 'ED_CLOSURE_EVIDENCE_INVALID');
    }
    return fallback;
  }
  if (!allowed.has(normalized)) {
    throw AppError.badRequest(`${label} is not allowed`, 'ED_CLOSURE_EVIDENCE_INVALID');
  }
  return normalized;
}

function canonicalCode(value, label, { required = false } = {}) {
  const normalized = text(value, 80, label, { required });
  if (!normalized) return null;
  const lowered = normalized.toLowerCase();
  if (!CANONICAL_CODE_RE.test(lowered)) {
    throw AppError.badRequest(
      `${label} must be a canonical lower_snake_case code`,
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  return lowered;
}

function patientNextSteps(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    throw AppError.badRequest(
      'patient_safe_next_steps must be an array',
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  if ((!allowEmpty && value.length < 1) || value.length > MAX_NEXT_STEPS) {
    throw AppError.badRequest(
      `patient_safe_next_steps must contain ${allowEmpty ? '0' : '1'}-${MAX_NEXT_STEPS} items`,
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  const normalized = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw AppError.badRequest(
        `patient_safe_next_steps[${index}] must be an object`,
        'ED_CLOSURE_EVIDENCE_INVALID',
      );
    }
    return {
      label: text(
        item.label,
        180,
        `patient_safe_next_steps[${index}].label`,
        { required: true },
      ),
      explanation: text(
        item.explanation,
        1_200,
        `patient_safe_next_steps[${index}].explanation`,
      ),
      due_date: date(item.due_date, `patient_safe_next_steps[${index}].due_date`),
      status: enumValue(
        item.status,
        NEXT_STEP_STATUS_SET,
        `patient_safe_next_steps[${index}].status`,
        { fallback: 'planned' },
      ),
      patient_action: text(
        item.patient_action,
        500,
        `patient_safe_next_steps[${index}].patient_action`,
      ),
      route_token: enumValue(
        item.route_token,
        NEXT_STEP_ROUTE_TOKEN_SET,
        `patient_safe_next_steps[${index}].route_token`,
      ),
    };
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_NEXT_STEPS_BYTES) {
    throw AppError.badRequest(
      'patient_safe_next_steps is too large',
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  return normalized;
}

function normalizeClosureInput(input = {}) {
  const closureKind = enumValue(
    input.closure_kind,
    CLOSURE_KIND_SET,
    'closure_kind',
    { required: true },
  );
  const isDeath = closureKind === 'death';
  if (typeof input.follow_up_required !== 'boolean' && !isDeath) {
    throw AppError.badRequest(
      'follow_up_required must be true or false',
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }
  const followUpRequired = isDeath ? false : input.follow_up_required;
  const followUpPlanId = positiveInteger(input.follow_up_plan_id, 'follow_up_plan_id');
  const noFollowUpReason = text(
    input.no_follow_up_reason,
    2_000,
    'no_follow_up_reason',
  );
  if (followUpRequired && !followUpPlanId) {
    throw AppError.badRequest(
      'follow_up_plan_id is required when follow_up_required is true',
      'ED_CLOSURE_FOLLOW_UP_REQUIRED',
    );
  }
  if (!isDeath && !followUpRequired && !noFollowUpReason) {
    throw AppError.badRequest(
      'no_follow_up_reason is required when follow_up_required is false',
      'ED_CLOSURE_FOLLOW_UP_DECISION_REQUIRED',
    );
  }
  if (
    (followUpRequired && noFollowUpReason)
    || (!followUpRequired && followUpPlanId)
    || (isDeath && (followUpPlanId || noFollowUpReason))
  ) {
    throw AppError.badRequest(
      'follow-up fields do not match the recorded follow_up_required decision',
      'ED_CLOSURE_FOLLOW_UP_INVALID',
    );
  }

  const medicationReconciliationId = uuid(
    input.medication_reconciliation_id,
    'medication_reconciliation_id',
  );
  const medicationNotApplicableReason = text(
    input.medication_not_applicable_reason,
    2_000,
    'medication_not_applicable_reason',
  );
  if (
    !isDeath
    && Boolean(medicationReconciliationId) === Boolean(medicationNotApplicableReason)
  ) {
    throw AppError.badRequest(
      'provide either a completed medication_reconciliation_id or a not-applicable reason',
      'ED_CLOSURE_MEDICATION_DECISION_REQUIRED',
    );
  }
  if (isDeath && (medicationReconciliationId || medicationNotApplicableReason)) {
    throw AppError.badRequest(
      'death closure does not accept medication reconciliation fields',
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }

  const isRecovery = ['left_against_medical_advice', 'lwbs'].includes(closureKind);
  const riskClassificationCode = canonicalCode(
    input.risk_classification_code,
    'risk_classification_code',
    { required: isRecovery },
  );
  const riskSummary = text(input.risk_summary, 4_000, 'risk_summary', {
    required: isRecovery,
  });
  if (!isRecovery && (riskClassificationCode || riskSummary)) {
    throw AppError.badRequest(
      'risk fields are only valid for LAMA or LWBS closure',
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }

  const isExternal = closureKind === 'external_transfer';
  const acceptedHandoffId = uuid(input.accepted_handoff_id, 'accepted_handoff_id', {
    required: isExternal,
  });
  const receivingFacilityName = text(
    input.receiving_facility_name,
    240,
    'receiving_facility_name',
    { required: isExternal },
  );
  const receivingFacilityReference = text(
    input.receiving_facility_reference,
    160,
    'receiving_facility_reference',
  );
  const receivingConfirmedBy = text(
    input.receiving_confirmed_by,
    240,
    'receiving_confirmed_by',
    { required: isExternal },
  );
  const receivingConfirmedAt = timestamp(
    input.receiving_confirmed_at,
    'receiving_confirmed_at',
  );
  const clinicalSummaryResourceType = canonicalCode(
    input.clinical_summary_resource_type,
    'clinical_summary_resource_type',
    { required: isExternal },
  );
  const clinicalSummaryResourceId = text(
    input.clinical_summary_resource_id,
    160,
    'clinical_summary_resource_id',
    { required: isExternal },
  );
  const clinicalSummarySentAt = timestamp(
    input.clinical_summary_sent_at,
    'clinical_summary_sent_at',
  );
  const ambulanceRequestId = positiveInteger(
    input.ambulance_request_id,
    'ambulance_request_id',
  );
  const transportReference = text(
    input.transport_reference,
    160,
    'transport_reference',
  );
  const transportConfirmedAt = timestamp(
    input.transport_confirmed_at,
    'transport_confirmed_at',
  );
  if (
    isExternal
    && (
      !receivingConfirmedAt
      || !clinicalSummarySentAt
      || (!ambulanceRequestId && !transportReference)
      || !transportConfirmedAt
    )
  ) {
    throw AppError.badRequest(
      'external transfer requires receiving, clinical-summary, and transport confirmation',
      'ED_CLOSURE_EXTERNAL_TRANSFER_INCOMPLETE',
    );
  }
  if (
    !isExternal
    && [
      acceptedHandoffId,
      receivingFacilityName,
      receivingFacilityReference,
      receivingConfirmedBy,
      receivingConfirmedAt,
      clinicalSummaryResourceType,
      clinicalSummaryResourceId,
      clinicalSummarySentAt,
      ambulanceRequestId,
      transportReference,
      transportConfirmedAt,
    ].some(value => value !== null)
  ) {
    throw AppError.badRequest(
      'external-transfer fields are only valid for external transfer closure',
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }

  const deathRecordId = positiveInteger(input.death_record_id, 'death_record_id', {
    required: isDeath,
  });
  const mlcRecordId = positiveInteger(input.mlc_record_id, 'mlc_record_id');
  if (!isDeath && (deathRecordId || mlcRecordId)) {
    throw AppError.badRequest(
      'death and MLC records are only valid for death closure',
      'ED_CLOSURE_EVIDENCE_INVALID',
    );
  }

  const identityResolutionStatus = enumValue(
    input.identity_resolution_status,
    IDENTITY_STATUS_SET,
    'identity_resolution_status',
    { required: true },
  );
  const identityResolutionReason = text(
    input.identity_resolution_reason,
    2_000,
    'identity_resolution_reason',
  );
  const patientMergeRequestId = positiveInteger(
    input.patient_merge_request_id,
    'patient_merge_request_id',
  );
  if (
    (identityResolutionStatus === 'verified'
      && (identityResolutionReason || patientMergeRequestId))
    || (identityResolutionStatus === 'temporary_identity_retained'
      && (!identityResolutionReason || patientMergeRequestId))
    || (['merge_requested', 'merged'].includes(identityResolutionStatus)
      && !patientMergeRequestId)
  ) {
    throw AppError.badRequest(
      'identity evidence fields do not match identity_resolution_status',
      'ED_CLOSURE_IDENTITY_INVALID',
    );
  }

  return {
    closureKind,
    followUpRequired,
    followUpPlanId,
    noFollowUpReason: isDeath ? null : noFollowUpReason,
    patientSafeNextSteps: patientNextSteps(
      input.patient_safe_next_steps ?? input.patient_next_steps ?? [],
      { allowEmpty: isDeath },
    ),
    medicationReconciliationId,
    medicationNotApplicableReason,
    riskClassificationCode,
    riskSummary,
    acceptedHandoffId,
    receivingFacilityName,
    receivingFacilityReference,
    receivingConfirmedBy,
    receivingConfirmedAt,
    clinicalSummaryResourceType,
    clinicalSummaryResourceId,
    clinicalSummarySentAt,
    ambulanceRequestId,
    transportReference,
    transportConfirmedAt,
    deathRecordId,
    mlcRecordId,
    identityResolutionStatus,
    identityResolutionReason,
    patientMergeRequestId,
    patientVisibilityStatus:
      ['discharge', 'left_against_medical_advice', 'lwbs'].includes(closureKind)
        ? 'released'
        : 'hidden',
    occurredAt: timestamp(input.occurred_at, 'occurred_at'),
    suppliedIdempotencyKey: input.idempotency_key == null
      ? null
      : text(input.idempotency_key, 220, 'idempotency_key', { required: true }),
  };
}

function normalizeRecoveryInput(input = {}) {
  const eventKind = enumValue(
    input.event_kind,
    RECOVERY_KIND_SET,
    'event_kind',
    { required: true },
  );
  const contactChannel = enumValue(
    input.contact_channel,
    RECOVERY_CHANNEL_SET,
    'contact_channel',
    { required: true },
  );
  const outcomeCode = canonicalCode(input.outcome_code, 'outcome_code', {
    required: eventKind === 'outcome',
  });
  if (eventKind === 'attempt' && outcomeCode) {
    throw AppError.badRequest(
      'outcome_code is only valid for an outcome event',
      'ED_RECOVERY_EVIDENCE_INVALID',
    );
  }
  return {
    eventKind,
    contactChannel,
    outcomeCode,
    patientSafeSummary: text(
      input.patient_safe_summary,
      2_000,
      'patient_safe_summary',
    ),
    staffNotes: text(input.staff_notes, 4_000, 'staff_notes'),
    occurredAt: timestamp(input.occurred_at, 'occurred_at'),
    suppliedIdempotencyKey: input.idempotency_key == null
      ? null
      : text(input.idempotency_key, 220, 'idempotency_key', { required: true }),
  };
}

function authorablePatientNextSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.map(step => Object.fromEntries(
    AUTHORABLE_NEXT_STEP_FIELDS.map(field => [field, step?.[field] ?? null]),
  ));
}

function decoratePatientNextSteps(value, clinician) {
  return value.map(step => ({
    ...step,
    responsible_clinician_display_name: clinician.name || null,
    responsible_clinician_role: clinician.role || null,
    safe_contact: clinician.safe_contact || null,
  }));
}

function closureFingerprint(normalized) {
  return createHash('sha256')
    .update(JSON.stringify({
      ...normalized,
      suppliedIdempotencyKey: undefined,
    }))
    .digest('hex');
}

function recoveryFingerprint(normalized, closureEvidenceId) {
  return createHash('sha256')
    .update(JSON.stringify({
      closure_evidence_id: closureEvidenceId,
      ...normalized,
      suppliedIdempotencyKey: undefined,
    }))
    .digest('hex');
}

async function resolveEmergencyModeTx(tx, tenantId) {
  return resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.EMERGENCY,
  });
}

async function lockVisitAndActorTx(tx, {
  tenantId,
  emergencyVisitId,
  actorUid,
} = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT visit.id,
            visit.patient_uid,
            visit.encounter_id,
            visit.attending_doctor_uid,
            visit.status,
            visit.disposition,
            visit.is_mlc,
            visit.created_at,
            visit.updated_at,
            patient.is_unidentified,
            actor.id AS actor_id,
            actor.name AS actor_name,
            actor.role AS actor_role,
            actor.is_active AS actor_is_active,
            actor.status AS actor_status,
            actor.is_deleted AS actor_is_deleted,
            actor.deleted_at AS actor_deleted_at,
            NULLIF(BTRIM(tenant.settings -> 'branding' ->> 'supportEmail'), '')
              AS safe_contact
       FROM emergency_visits AS visit
       JOIN users AS patient
         ON patient.tenant_id = visit.tenant_id
        AND patient.uid = visit.patient_uid
       JOIN tenants AS tenant
         ON tenant.id = visit.tenant_id
       LEFT JOIN users AS actor
         ON actor.tenant_id = visit.tenant_id
        AND actor.uid = $3::uuid
      WHERE visit.tenant_id = $1::uuid
        AND visit.id = $2::integer
      LIMIT 1
      FOR UPDATE OF visit`,
    tenantId,
    emergencyVisitId,
    actorUid,
  );
  const row = rows[0];
  const authorized = row
    && row.actor_is_active === true
    && row.actor_status === 'active'
    && row.actor_is_deleted !== true
    && row.actor_deleted_at === null
    && isClinical(row.actor_role)
    && String(row.attending_doctor_uid || '').toLowerCase() === actorUid;
  if (!authorized) {
    throw AppError.forbidden(
      'Not authorized to record ED closure or recovery evidence',
      'ED_CLOSURE_FORBIDDEN',
    );
  }
  return {
    ...row,
    clinician: {
      id: Number(row.actor_id),
      uid: actorUid,
      name: row.actor_name || null,
      role: row.actor_role || null,
      safe_contact: row.safe_contact || null,
    },
  };
}

function assertClosureStage(visit, closureKind) {
  const allowedByKind = {
    discharge: new Set(['in_treatment', 'awaiting_disposition', 'discharged']),
    left_against_medical_advice: new Set([
      'in_treatment',
      'awaiting_disposition',
      'left_against_advice',
    ]),
    lwbs: new Set([
      'arriving',
      'in_triage',
      'awaiting_treatment',
      'in_treatment',
      'awaiting_disposition',
      'lwbs',
    ]),
    external_transfer: new Set(['awaiting_disposition', 'transferred']),
    death: new Set([
      'arriving',
      'in_triage',
      'awaiting_treatment',
      'in_treatment',
      'awaiting_disposition',
      'expired',
    ]),
  };
  if (!allowedByKind[closureKind].has(visit.status)) {
    throw AppError.conflict(
      `ED ${closureKind} evidence is not valid from visit status ${visit.status}`,
      'ED_CLOSURE_STAGE_INVALID',
    );
  }
}

async function existingClosureTx(tx, tenantId, idempotencyKey) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM ed_closure_evidence
      WHERE tenant_id = $1::uuid
        AND idempotency_key = $2::text
      LIMIT 1`,
    tenantId,
    idempotencyKey,
  );
  return rows[0] || null;
}

function closurePayloadMatches(row, {
  visit,
  actorUid,
  normalized,
} = {}) {
  return (
    Number(row.emergency_visit_id) === Number(visit.id)
    && String(row.patient_uid).toLowerCase() === String(visit.patient_uid).toLowerCase()
    && String(row.encounter_id).toLowerCase() === String(visit.encounter_id).toLowerCase()
    && String(row.clinician_uid).toLowerCase() === actorUid
    && row.closure_kind === normalized.closureKind
    && (row.follow_up_required === true) === normalized.followUpRequired
    && Number(row.follow_up_plan_id || 0) === Number(normalized.followUpPlanId || 0)
    && String(row.no_follow_up_reason || '') === String(normalized.noFollowUpReason || '')
    && JSON.stringify(authorablePatientNextSteps(row.patient_safe_next_steps))
      === JSON.stringify(authorablePatientNextSteps(normalized.patientSafeNextSteps))
    && String(row.medication_reconciliation_id || '')
      === String(normalized.medicationReconciliationId || '')
    && String(row.medication_not_applicable_reason || '')
      === String(normalized.medicationNotApplicableReason || '')
    && String(row.risk_classification_code || '')
      === String(normalized.riskClassificationCode || '')
    && String(row.risk_summary || '') === String(normalized.riskSummary || '')
    && String(row.accepted_handoff_id || '') === String(normalized.acceptedHandoffId || '')
    && String(row.receiving_facility_name || '')
      === String(normalized.receivingFacilityName || '')
    && String(row.receiving_facility_reference || '')
      === String(normalized.receivingFacilityReference || '')
    && String(row.receiving_confirmed_by || '')
      === String(normalized.receivingConfirmedBy || '')
    && timestampsMatch(row.receiving_confirmed_at, normalized.receivingConfirmedAt)
    && String(row.clinical_summary_resource_type || '')
      === String(normalized.clinicalSummaryResourceType || '')
    && String(row.clinical_summary_resource_id || '')
      === String(normalized.clinicalSummaryResourceId || '')
    && timestampsMatch(row.clinical_summary_sent_at, normalized.clinicalSummarySentAt)
    && Number(row.ambulance_request_id || 0) === Number(normalized.ambulanceRequestId || 0)
    && String(row.transport_reference || '') === String(normalized.transportReference || '')
    && timestampsMatch(row.transport_confirmed_at, normalized.transportConfirmedAt)
    && Number(row.death_record_id || 0) === Number(normalized.deathRecordId || 0)
    && Number(row.mlc_record_id || 0) === Number(normalized.mlcRecordId || 0)
    && row.identity_resolution_status === normalized.identityResolutionStatus
    && String(row.identity_resolution_reason || '')
      === String(normalized.identityResolutionReason || '')
    && Number(row.patient_merge_request_id || 0)
      === Number(normalized.patientMergeRequestId || 0)
    && timestampsMatch(row.occurred_at, normalized.occurredAt, { optional: true })
  );
}

function closureResponse(row, { mode, replayed = false } = {}) {
  return {
    mode,
    replayed,
    closure_evidence: {
      ...row,
      emergency_visit_id: Number(row.emergency_visit_id),
      evidence_revision: Number(row.evidence_revision),
      follow_up_plan_id: row.follow_up_plan_id == null
        ? null
        : Number(row.follow_up_plan_id),
      ambulance_request_id: row.ambulance_request_id == null
        ? null
        : Number(row.ambulance_request_id),
      death_record_id: row.death_record_id == null ? null : Number(row.death_record_id),
      mlc_record_id: row.mlc_record_id == null ? null : Number(row.mlc_record_id),
      patient_merge_request_id: row.patient_merge_request_id == null
        ? null
        : Number(row.patient_merge_request_id),
      patient_next_steps: Array.isArray(row.patient_safe_next_steps)
        ? row.patient_safe_next_steps
        : [],
    },
    __patient_uid: row.patient_uid,
  };
}

export async function recordEdClosureEvidence({
  tenantId,
  emergencyVisitId,
  clinicianUid,
  input = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const visitId = positiveInteger(
    emergencyVisitId,
    'emergency_visit_id',
    { required: true },
  );
  const actorUid = uuid(clinicianUid, 'clinician_uid', { required: true });
  const normalized = normalizeClosureInput(input);

  return setTenantTx(tid, async tx => {
    const mode = await resolveEmergencyModeTx(tx, tid);
    if (mode === PATHWAY_MODES.OFF) {
      throw AppError.conflict(
        'ED closure evidence is unavailable while the pathway is off',
        'ED_PATHWAY_MODE_OFF',
      );
    }
    const visit = await lockVisitAndActorTx(tx, {
      tenantId: tid,
      emergencyVisitId: visitId,
      actorUid,
    });
    assertClosureStage(visit, normalized.closureKind);

    const idempotencyKey = normalized.suppliedIdempotencyKey
      || `ed-closure:${visit.id}:${actorUid}:${closureFingerprint(normalized)}`;
    const existing = await existingClosureTx(tx, tid, idempotencyKey);
    if (existing) {
      if (!closurePayloadMatches(existing, { visit, actorUid, normalized })) {
        throw AppError.conflict(
          'idempotency_key is already bound to different ED closure evidence',
          'ED_CLOSURE_IDEMPOTENCY_REUSED',
        );
      }
      return closureResponse(existing, { mode, replayed: true });
    }

    const revisionRows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(evidence_revision), 0)::integer + 1 AS next_revision
         FROM ed_closure_evidence
        WHERE tenant_id = $1::uuid
          AND emergency_visit_id = $2::integer`,
      tid,
      visitId,
    );
    const evidenceRevision = Number(revisionRows[0].next_revision);
    const evidenceId = randomUUID();
    const patientSafeNextSteps = decoratePatientNextSteps(
      normalized.patientSafeNextSteps,
      visit.clinician,
    );
    const occurredAt = normalized.occurredAt || new Date().toISOString();
    const canonical = await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: visit.patient_uid,
      encounterId: visit.encounter_id,
      eventType: 'emergency.closure_evidence_recorded',
      eventStatus: 'recorded',
      sourceTable: 'ed_closure_evidence',
      sourceId: evidenceId,
      resourceType: 'ed_closure_evidence',
      resourceId: evidenceId,
      actorUid,
      actorRole: visit.clinician.role,
      occurredAt,
      summary: `Emergency ${normalized.closureKind} closure evidence recorded`,
      payload: {
        emergency_visit_id: visitId,
        evidence_revision: evidenceRevision,
        closure_kind: normalized.closureKind,
        follow_up_required: normalized.followUpRequired,
        follow_up_plan_id: normalized.followUpPlanId,
        accepted_handoff_id: normalized.acceptedHandoffId,
        death_record_id: normalized.deathRecordId,
        mlc_record_id: normalized.mlcRecordId,
        identity_resolution_status: normalized.identityResolutionStatus,
      },
      beforeState: null,
      afterState: {
        evidence_revision: evidenceRevision,
        closure_kind: normalized.closureKind,
        patient_visibility_status: normalized.patientVisibilityStatus,
      },
      timelineIdempotencyKey: `ed_closure_evidence:${evidenceId}:timeline`,
      auditIdempotencyKey: `ed_closure_evidence:${evidenceId}:audit`,
    }, { db: tx, strict: true });

    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO ed_closure_evidence
         (id, tenant_id, emergency_visit_id, patient_uid, encounter_id,
          evidence_revision, closure_kind, clinician_uid,
          follow_up_required, follow_up_plan_id, no_follow_up_reason,
          patient_safe_next_steps, medication_reconciliation_id,
          medication_not_applicable_reason, risk_classification_code,
          risk_summary, accepted_handoff_id, receiving_facility_name,
          receiving_facility_reference, receiving_confirmed_by,
          receiving_confirmed_at, clinical_summary_resource_type,
          clinical_summary_resource_id, clinical_summary_sent_at,
          ambulance_request_id, transport_reference, transport_confirmed_at,
          death_record_id, mlc_record_id, identity_resolution_status,
          identity_resolution_reason, patient_merge_request_id,
          patient_visibility_status, canonical_timeline_event_id,
          canonical_audit_event_id, occurred_at, idempotency_key)
       VALUES
         ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
          $6::integer, $7::text, $8::uuid,
          $9::boolean, $10::integer, $11::text,
          $12::jsonb, $13::uuid,
          $14::text, $15::text,
          $16::text, $17::uuid, $18::text,
          $19::text, $20::text,
          $21::timestamptz, $22::text,
          $23::text, $24::timestamptz,
          $25::integer, $26::text, $27::timestamptz,
          $28::integer, $29::integer, $30::text,
          $31::text, $32::integer,
          $33::text, $34::uuid,
          $35::uuid, $36::timestamptz, $37::text)
       RETURNING *`,
      evidenceId,
      tid,
      visitId,
      visit.patient_uid,
      visit.encounter_id,
      evidenceRevision,
      normalized.closureKind,
      actorUid,
      normalized.followUpRequired,
      normalized.followUpPlanId,
      normalized.noFollowUpReason,
      JSON.stringify(patientSafeNextSteps),
      normalized.medicationReconciliationId,
      normalized.medicationNotApplicableReason,
      normalized.riskClassificationCode,
      normalized.riskSummary,
      normalized.acceptedHandoffId,
      normalized.receivingFacilityName,
      normalized.receivingFacilityReference,
      normalized.receivingConfirmedBy,
      normalized.receivingConfirmedAt,
      normalized.clinicalSummaryResourceType,
      normalized.clinicalSummaryResourceId,
      normalized.clinicalSummarySentAt,
      normalized.ambulanceRequestId,
      normalized.transportReference,
      normalized.transportConfirmedAt,
      normalized.deathRecordId,
      normalized.mlcRecordId,
      normalized.identityResolutionStatus,
      normalized.identityResolutionReason,
      normalized.patientMergeRequestId,
      normalized.patientVisibilityStatus,
      canonical.timeline.id,
      canonical.audit.id,
      occurredAt,
      idempotencyKey,
    );
    const row = inserted[0];
    if (!row) {
      throw AppError.internal(
        'ED closure evidence was not recorded',
        'ED_CLOSURE_EVIDENCE_REQUIRED',
      );
    }
    const outbox = await publishEvent({
      eventType: 'emergency.visit.closure_evidence_recorded',
      aggregateType: 'emergency_visit',
      aggregateId: String(visitId),
      patientUid: visit.patient_uid,
      payload: {
        tenant_id: tid,
        patient_uid: visit.patient_uid,
        encounter_id: visit.encounter_id,
        emergency_visit_id: visitId,
        closure_evidence_id: evidenceId,
        evidence_revision: evidenceRevision,
        closure_kind: normalized.closureKind,
        canonical_timeline_event_id: canonical.timeline.id,
        canonical_audit_event_id: canonical.audit.id,
      },
      tx,
      tenantId: tid,
    });
    if (!outbox) {
      throw AppError.internal(
        'ED closure outbox event was not recorded',
        'EMERGENCY_OUTBOX_REQUIRED',
      );
    }
    return closureResponse(row, { mode, replayed: false });
  });
}

async function latestClosureTx(tx, tenantId, visitId, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM ed_closure_evidence
      WHERE tenant_id = $1::uuid
        AND emergency_visit_id = $2::integer
      ORDER BY evidence_revision DESC
      LIMIT 1
      ${lock ? 'FOR SHARE' : ''}`,
    tenantId,
    visitId,
  );
  return rows[0] || null;
}

async function existingRecoveryTx(tx, tenantId, idempotencyKey) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM ed_recovery_contact_events
      WHERE tenant_id = $1::uuid
        AND idempotency_key = $2::text
      LIMIT 1`,
    tenantId,
    idempotencyKey,
  );
  return rows[0] || null;
}

function recoveryResponse(row, { mode, replayed = false } = {}) {
  return {
    mode,
    replayed,
    recovery_contact: {
      ...row,
      emergency_visit_id: Number(row.emergency_visit_id),
    },
    __patient_uid: row.patient_uid,
  };
}

export async function recordEdRecoveryContact({
  tenantId,
  emergencyVisitId,
  clinicianUid,
  input = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const visitId = positiveInteger(
    emergencyVisitId,
    'emergency_visit_id',
    { required: true },
  );
  const actorUid = uuid(clinicianUid, 'clinician_uid', { required: true });
  const normalized = normalizeRecoveryInput(input);

  return setTenantTx(tid, async tx => {
    const mode = await resolveEmergencyModeTx(tx, tid);
    if (mode === PATHWAY_MODES.OFF) {
      throw AppError.conflict(
        'ED recovery evidence is unavailable while the pathway is off',
        'ED_PATHWAY_MODE_OFF',
      );
    }
    const visit = await lockVisitAndActorTx(tx, {
      tenantId: tid,
      emergencyVisitId: visitId,
      actorUid,
    });
    if (!['left_against_advice', 'lwbs'].includes(visit.status)) {
      throw AppError.conflict(
        'ED recovery evidence is only valid after a LAMA or LWBS departure',
        'ED_RECOVERY_STAGE_INVALID',
      );
    }
    const closure = await latestClosureTx(tx, tid, visitId, { lock: true });
    const expectedClosureKind = visit.status === 'lwbs'
      ? 'lwbs'
      : 'left_against_medical_advice';
    if (!closure || closure.closure_kind !== expectedClosureKind) {
      throw AppError.conflict(
        'The latest exact LAMA/LWBS closure evidence is required before recovery contact',
        'ED_RECOVERY_CLOSURE_REQUIRED',
      );
    }

    const idempotencyKey = normalized.suppliedIdempotencyKey
      || `ed-recovery:${visit.id}:${actorUid}:${
        recoveryFingerprint(normalized, closure.id)
      }`;
    const existing = await existingRecoveryTx(tx, tid, idempotencyKey);
    if (existing) {
      const matches = Number(existing.emergency_visit_id) === visitId
        && String(existing.closure_evidence_id).toLowerCase() === String(closure.id).toLowerCase()
        && String(existing.recorded_by_uid).toLowerCase() === actorUid
        && existing.event_kind === normalized.eventKind
        && existing.contact_channel === normalized.contactChannel
        && String(existing.outcome_code || '') === String(normalized.outcomeCode || '')
        && String(existing.patient_safe_summary || '')
          === String(normalized.patientSafeSummary || '')
        && String(existing.staff_notes || '') === String(normalized.staffNotes || '')
        && timestampsMatch(existing.occurred_at, normalized.occurredAt, {
          optional: true,
        });
      if (!matches) {
        throw AppError.conflict(
          'idempotency_key is already bound to different ED recovery evidence',
          'ED_RECOVERY_IDEMPOTENCY_REUSED',
        );
      }
      return recoveryResponse(existing, { mode, replayed: true });
    }

    if (normalized.eventKind === 'outcome') {
      const attempts = await tx.$queryRawUnsafe(
        `SELECT id
           FROM ed_recovery_contact_events
          WHERE tenant_id = $1::uuid
            AND emergency_visit_id = $2::integer
            AND closure_evidence_id = $3::uuid
            AND event_kind = 'attempt'
          LIMIT 1
          FOR SHARE`,
        tid,
        visitId,
        closure.id,
      );
      if (!attempts[0]) {
        throw AppError.conflict(
          'Record at least one contact attempt before the clinician recovery outcome',
          'ED_RECOVERY_ATTEMPT_REQUIRED',
        );
      }
    }

    const eventId = randomUUID();
    const occurredAt = normalized.occurredAt || new Date().toISOString();
    const canonical = await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: visit.patient_uid,
      encounterId: visit.encounter_id,
      eventType: 'emergency.recovery_contact_recorded',
      eventStatus: normalized.eventKind,
      sourceTable: 'ed_recovery_contact_events',
      sourceId: eventId,
      resourceType: 'ed_recovery_contact_event',
      resourceId: eventId,
      actorUid,
      actorRole: visit.clinician.role,
      occurredAt,
      summary: normalized.eventKind === 'attempt'
        ? 'Emergency recovery contact attempt recorded'
        : 'Emergency recovery outcome recorded',
      payload: {
        emergency_visit_id: visitId,
        closure_evidence_id: closure.id,
        event_kind: normalized.eventKind,
        contact_channel: normalized.contactChannel,
        outcome_code: normalized.outcomeCode,
      },
      beforeState: null,
      afterState: {
        event_kind: normalized.eventKind,
        outcome_code: normalized.outcomeCode,
      },
      timelineIdempotencyKey: `ed_recovery_contact:${eventId}:timeline`,
      auditIdempotencyKey: `ed_recovery_contact:${eventId}:audit`,
    }, { db: tx, strict: true });

    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO ed_recovery_contact_events
         (id, tenant_id, emergency_visit_id, closure_evidence_id,
          patient_uid, encounter_id, event_kind, contact_channel,
          outcome_code, patient_safe_summary, staff_notes, recorded_by_uid,
          canonical_timeline_event_id, canonical_audit_event_id, occurred_at,
          idempotency_key)
       VALUES
         ($1::uuid, $2::uuid, $3::integer, $4::uuid,
          $5::uuid, $6::uuid, $7::text, $8::text,
          $9::text, $10::text, $11::text, $12::uuid,
          $13::uuid, $14::uuid, $15::timestamptz,
          $16::text)
       RETURNING *`,
      eventId,
      tid,
      visitId,
      closure.id,
      visit.patient_uid,
      visit.encounter_id,
      normalized.eventKind,
      normalized.contactChannel,
      normalized.outcomeCode,
      normalized.patientSafeSummary,
      normalized.staffNotes,
      actorUid,
      canonical.timeline.id,
      canonical.audit.id,
      occurredAt,
      idempotencyKey,
    );
    const row = inserted[0];
    if (!row) {
      throw AppError.internal(
        'ED recovery evidence was not recorded',
        'ED_RECOVERY_EVIDENCE_REQUIRED',
      );
    }
    const outbox = await publishEvent({
      eventType: 'emergency.visit.recovery_contact_recorded',
      aggregateType: 'emergency_visit',
      aggregateId: String(visitId),
      patientUid: visit.patient_uid,
      payload: {
        tenant_id: tid,
        patient_uid: visit.patient_uid,
        encounter_id: visit.encounter_id,
        emergency_visit_id: visitId,
        closure_evidence_id: closure.id,
        recovery_contact_event_id: eventId,
        event_kind: normalized.eventKind,
        canonical_timeline_event_id: canonical.timeline.id,
        canonical_audit_event_id: canonical.audit.id,
      },
      tx,
      tenantId: tid,
    });
    if (!outbox) {
      throw AppError.internal(
        'ED recovery outbox event was not recorded',
        'EMERGENCY_OUTBOX_REQUIRED',
      );
    }
    return recoveryResponse(row, { mode, replayed: false });
  });
}

export async function loadEdContinuityEvidenceTx({
  tx,
  tenantId,
  emergencyVisitId,
} = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT visit.id,
            visit.patient_uid,
            visit.encounter_id,
            visit.attending_doctor_uid,
            visit.status AS visit_status,
            visit.disposition,
            visit.disposition_at,
            visit.departure_at,
            visit.is_mlc,
            patient.is_unidentified,
            closure.id AS closure_evidence_id,
            closure.evidence_revision,
            closure.closure_kind,
            closure.clinician_uid AS closure_clinician_uid,
            closure.patient_visibility_status,
            closure.identity_resolution_status,
            closure.accepted_handoff_id,
            closure.death_record_id,
            closure.mlc_record_id,
            closure.recorded_at AS closure_recorded_at,
            COALESCE(recovery.attempt_count, 0)::integer AS recovery_attempt_count,
            recovery.latest_outcome_code,
            recovery.latest_outcome_at,
            handoff.id AS handoff_id,
            handoff.status AS handoff_status,
            handoff.accepted_at AS handoff_accepted_at,
            handoff.accepted_by_uid,
            handoff.intended_recipient_role,
            handoff.metadata ->> 'destination' AS destination,
            admission.id AS admission_id,
            admission.bed_id AS admission_bed_id,
            admission.bed_pending_since,
            death.status AS death_status,
            death.certified_at AS death_certified_at,
            custody.latest_event_type AS latest_custody_event_type,
            custody.latest_event_at AS latest_custody_event_at,
            custody.has_receive AS custody_has_receive,
            custody.has_release AS custody_has_release,
            mlc.status AS mlc_status,
            mlc_review.completeness_status AS mlc_completeness_status,
            mlc_review.certification_blocked AS mlc_certification_blocked,
            merge_request.id AS merge_request_id,
            merge_request.status AS merge_request_status
       FROM emergency_visits AS visit
       JOIN users AS patient
         ON patient.tenant_id = visit.tenant_id
        AND patient.uid = visit.patient_uid
       LEFT JOIN LATERAL (
         SELECT candidate.*
           FROM ed_closure_evidence AS candidate
          WHERE candidate.tenant_id = visit.tenant_id
            AND candidate.emergency_visit_id = visit.id
          ORDER BY candidate.evidence_revision DESC
          LIMIT 1
       ) AS closure ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (
                  WHERE event.event_kind = 'attempt'
                )::integer AS attempt_count,
                (
                  ARRAY_AGG(event.outcome_code ORDER BY event.occurred_at DESC, event.id DESC)
                    FILTER (WHERE event.event_kind = 'outcome')
                )[1] AS latest_outcome_code,
                MAX(event.occurred_at) FILTER (
                  WHERE event.event_kind = 'outcome'
                ) AS latest_outcome_at
           FROM ed_recovery_contact_events AS event
          WHERE event.tenant_id = visit.tenant_id
            AND event.emergency_visit_id = visit.id
            AND (
              closure.id IS NULL
              OR event.closure_evidence_id = closure.id
            )
       ) AS recovery ON TRUE
       LEFT JOIN LATERAL (
         SELECT candidate.*
           FROM care_handoff_instances AS candidate
          WHERE candidate.tenant_id = visit.tenant_id
            AND candidate.patient_uid = visit.patient_uid
            AND candidate.handoff_type = 'ed_destination_handoff'
            AND candidate.source_resource_type = 'emergency_visit'
            AND candidate.source_resource_id = visit.id::text
          ORDER BY candidate.requested_at DESC, candidate.id DESC
          LIMIT 1
       ) AS handoff ON TRUE
       LEFT JOIN LATERAL (
         SELECT candidate.id,
                candidate.bed_id,
                candidate.bed_pending_since
           FROM admissions AS candidate
          WHERE candidate.tenant_id = visit.tenant_id
            AND candidate.patient_uid = visit.patient_uid
            AND candidate.from_er_visit_id = visit.id
          ORDER BY candidate.admitted_at DESC, candidate.id DESC
          LIMIT 1
       ) AS admission ON TRUE
       LEFT JOIN death_records AS death
         ON death.id = closure.death_record_id
        AND death.tenant_id = visit.tenant_id
        AND death.patient_uid = visit.patient_uid
       LEFT JOIN LATERAL (
         SELECT (
                  ARRAY_AGG(event.event_type ORDER BY event.event_at DESC, event.id DESC)
                )[1] AS latest_event_type,
                (
                  ARRAY_AGG(event.event_at ORDER BY event.event_at DESC, event.id DESC)
                )[1] AS latest_event_at,
                BOOL_OR(event.event_type = 'receive') AS has_receive,
                BOOL_OR(event.event_type = 'release') AS has_release
           FROM body_custody_events AS event
          WHERE event.tenant_id = visit.tenant_id
            AND event.death_record_id = death.id
       ) AS custody ON TRUE
       LEFT JOIN mlc_records AS mlc
         ON mlc.id = closure.mlc_record_id
        AND mlc.tenant_id = visit.tenant_id
        AND mlc.patient_uid = visit.patient_uid
        AND mlc.emergency_visit_id = visit.id
       LEFT JOIN mlc_completeness_reviews AS mlc_review
         ON mlc_review.tenant_id = mlc.tenant_id
        AND mlc_review.mlc_record_id = mlc.id
       LEFT JOIN LATERAL (
         SELECT request.id,
                request.status
           FROM patient_merge_requests AS request
          WHERE request.tenant_id = visit.tenant_id
            AND visit.patient_uid IN (
              request.primary_uid,
              request.secondary_uid
            )
          ORDER BY request.created_at DESC, request.id DESC
          LIMIT 1
       ) AS merge_request ON TRUE
      WHERE visit.tenant_id = $1::uuid
        AND visit.id = $2::integer
      LIMIT 1
      FOR SHARE OF visit`,
    tenantId,
    emergencyVisitId,
  );
  const row = rows[0];
  if (!row) return null;

  const acceptedHandoffValid = Boolean(
    row.handoff_id
    && row.handoff_status === 'accepted'
    && row.handoff_accepted_at
    && row.accepted_by_uid
    && row.intended_recipient_role,
  );
  const latestClosureMatches = {
    discharged: 'discharge',
    left_against_advice: 'left_against_medical_advice',
    lwbs: 'lwbs',
    transferred: 'external_transfer',
    expired: 'death',
  }[row.visit_status] === row.closure_kind;
  const recoveryComplete = Boolean(
    row.recovery_attempt_count > 0
    && row.latest_outcome_code
    && row.latest_outcome_at,
  );
  const deathCertified = Boolean(
    row.death_record_id
    && ['certified', 'submitted_to_registrar', 'registered'].includes(row.death_status)
    && row.death_certified_at,
  );
  const mortuaryCustodyRecorded = row.custody_has_receive === true
    && row.custody_has_release === true;
  const mlcComplete = !row.is_mlc || Boolean(
    row.mlc_record_id
    && ['certified', 'closed'].includes(row.mlc_status)
    && ['complete', 'certified', 'closed'].includes(row.mlc_completeness_status)
    && row.mlc_certification_blocked === false,
  );
  const identityResolved = row.is_unidentified !== true
    || row.identity_resolution_status === 'temporary_identity_retained'
    || (
      ['merge_requested', 'merged'].includes(row.identity_resolution_status)
      && row.merge_request_id
      && (
        (row.identity_resolution_status === 'merge_requested'
          && ['requested', 'approved'].includes(row.merge_request_status))
        || (row.identity_resolution_status === 'merged'
          && row.merge_request_status === 'executed')
      )
    );

  let branchClosureComplete = false;
  if (row.visit_status === 'admitted') {
    branchClosureComplete = acceptedHandoffValid && Boolean(row.admission_id);
  } else if (row.visit_status === 'transferred') {
    branchClosureComplete = acceptedHandoffValid
      && row.destination === 'external_transfer'
      && latestClosureMatches;
  } else if (row.visit_status === 'discharged') {
    branchClosureComplete = latestClosureMatches;
  } else if (['left_against_advice', 'lwbs'].includes(row.visit_status)) {
    branchClosureComplete = latestClosureMatches && recoveryComplete;
  } else if (row.visit_status === 'expired') {
    branchClosureComplete = latestClosureMatches
      && deathCertified
      && mortuaryCustodyRecorded
      && mlcComplete;
  }

  return {
    ...row,
    emergency_visit_id: Number(row.id),
    evidence_revision: row.evidence_revision == null
      ? null
      : Number(row.evidence_revision),
    recovery_attempt_count: Number(row.recovery_attempt_count || 0),
    admission_id: row.admission_id == null ? null : Number(row.admission_id),
    admission_bed_id: row.admission_bed_id == null
      ? null
      : Number(row.admission_bed_id),
    death_record_id: row.death_record_id == null
      ? null
      : Number(row.death_record_id),
    mlc_record_id: row.mlc_record_id == null ? null : Number(row.mlc_record_id),
    merge_request_id: row.merge_request_id == null
      ? null
      : Number(row.merge_request_id),
    accepted_handoff_valid: acceptedHandoffValid,
    latest_closure_matches_branch: latestClosureMatches,
    recovery_complete: recoveryComplete,
    death_certified: deathCertified,
    mortuary_custody_recorded: mortuaryCustodyRecorded,
    mlc_complete: mlcComplete,
    identity_resolved_or_attested: identityResolved,
    bed_pending: Boolean(row.admission_id && !row.admission_bed_id && row.bed_pending_since),
    branch_closure_complete: branchClosureComplete && identityResolved,
  };
}

export async function getEdContinuity({
  tenantId,
  emergencyVisitId,
} = {}) {
  const tid = requireTenantId(tenantId);
  const visitId = positiveInteger(
    emergencyVisitId,
    'emergency_visit_id',
    { required: true },
  );
  return setTenantTx(tid, async tx => {
    const mode = await resolveEmergencyModeTx(tx, tid);
    const continuity = await loadEdContinuityEvidenceTx({
      tx,
      tenantId: tid,
      emergencyVisitId: visitId,
    });
    if (!continuity) throw AppError.notFound('Emergency visit not found');
    const [closureHistory, recoveryContacts] = await Promise.all([
      tx.$queryRawUnsafe(
        `SELECT *
           FROM ed_closure_evidence
          WHERE tenant_id = $1::uuid
            AND emergency_visit_id = $2::integer
          ORDER BY evidence_revision DESC`,
        tid,
        visitId,
      ),
      tx.$queryRawUnsafe(
        `SELECT *
           FROM ed_recovery_contact_events
          WHERE tenant_id = $1::uuid
            AND emergency_visit_id = $2::integer
          ORDER BY occurred_at DESC, id DESC`,
        tid,
        visitId,
      ),
    ]);
    return {
      mode,
      continuity,
      closure_history: closureHistory,
      recovery_contacts: recoveryContacts,
      __patient_uid: continuity.patient_uid,
    };
  });
}

export async function reconcileEdClosureTaskTx({
  tx,
  tenantId,
  emergencyVisitId,
  pathwayInstanceId,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'ED closure task reconciliation requires a transaction',
      'ED_CLOSURE_TASK_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const visitId = positiveInteger(
    emergencyVisitId,
    'emergency_visit_id',
    { required: true },
  );
  const pathwayId = uuid(pathwayInstanceId, 'pathway_instance_id', {
    required: true,
  });
  const continuity = await loadEdContinuityEvidenceTx({
    tx,
    tenantId: tid,
    emergencyVisitId: visitId,
  });
  if (!continuity) {
    throw AppError.conflict(
      'ED closure task source visit is unavailable',
      'ED_CLOSURE_TASK_SOURCE_MISSING',
    );
  }
  const shouldMaterialize = continuity.visit_status === 'awaiting_disposition'
    || [
      'admitted',
      'discharged',
      'transferred',
      'left_against_advice',
      'lwbs',
      'expired',
    ].includes(continuity.visit_status);
  if (!shouldMaterialize) return { continuity, task: null };

  let taskRows = await tx.$queryRawUnsafe(
    `SELECT id, status, task_kind, assigned_to_uid, assigned_to_role,
            related_resource_type, related_resource_id, due_at,
            workflow_sla_instance_id, sla_completion_semantics, metadata
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = 'emergency_visit_closure'
        AND related_resource_id = $2::integer::text
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE`,
    tid,
    visitId,
  );
  let task = taskRows[0] || null;
  let supersedesTaskId = null;
  if (
    task
    && (
      task.status === 'cancelled'
      || (
        task.status === 'completed'
        && !continuity.branch_closure_complete
      )
    )
  ) {
    supersedesTaskId = Number(task.id);
    task = null;
  }
  if (!task) {
    task = await createEdClosureReviewTaskTx({
      tenantId: tid,
      pathwayInstanceId: pathwayId,
      emergencyVisitId: visitId,
      patientUid: continuity.patient_uid,
      assignedToUid: continuity.attending_doctor_uid,
      encounterId: continuity.encounter_id,
      supersedesTaskId,
      evidenceRevision: continuity.evidence_revision,
      tx,
    });
    if (!task) {
      taskRows = await tx.$queryRawUnsafe(
        `SELECT id, status, task_kind, assigned_to_uid, assigned_to_role,
                related_resource_type, related_resource_id, due_at,
                workflow_sla_instance_id, sla_completion_semantics, metadata
           FROM tasks
          WHERE tenant_id = $1::uuid
            AND related_resource_type = 'emergency_visit_closure'
            AND related_resource_id = $2::integer::text
            AND status IN ('open', 'in_progress', 'blocked', 'overdue')
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        tid,
        visitId,
      );
      task = taskRows[0] || null;
    }
  }
  if (!task) {
    throw AppError.conflict(
      'ED closure review task could not be materialized',
      'ED_CLOSURE_TASK_REQUIRED',
    );
  }
  const exactBinding = task.task_kind === 'ed_closure_review'
    && String(task.assigned_to_uid || '').toLowerCase()
      === String(continuity.attending_doctor_uid || '').toLowerCase()
    && task.assigned_to_role === null
    && task.related_resource_type === 'emergency_visit_closure'
    && String(task.related_resource_id) === String(visitId)
    && task.due_at === null
    && task.workflow_sla_instance_id === null
    && task.sla_completion_semantics === 'none'
    && task.metadata?.task_contract === 'ed_closure_review_v1'
    && String(task.metadata?.canonical_encounter_id || '').toLowerCase()
      === String(continuity.encounter_id || '').toLowerCase()
    && String(task.metadata?.care_pathway_instance_id || '').toLowerCase()
      === pathwayId;
  if (!exactBinding) {
    throw AppError.conflict(
      'ED closure review task binding is invalid',
      'ED_CLOSURE_TASK_BINDING_INVALID',
    );
  }

  if (
    continuity.branch_closure_complete
    && ['open', 'in_progress', 'blocked', 'overdue'].includes(task.status)
  ) {
    if (task.status === 'blocked') {
      task = await transitionTask({
        tenantId: tid,
        id: task.id,
        nextStatus: 'in_progress',
        tx,
      });
    }
    task = await transitionTask({
      tenantId: tid,
      id: task.id,
      nextStatus: 'completed',
      tx,
    });
  }
  return { continuity, task };
}

export const __testing__ = Object.freeze({
  AUTHORABLE_NEXT_STEP_FIELDS,
  IDENTITY_STATUSES,
  NEXT_STEP_ROUTE_TOKENS,
  NEXT_STEP_STATUSES,
  authorablePatientNextSteps,
  closureFingerprint,
  closurePayloadMatches,
  normalizeClosureInput,
  normalizeRecoveryInput,
  patientNextSteps,
  recoveryFingerprint,
});

export default {
  getEdContinuity,
  reconcileEdClosureTaskTx,
  recordEdClosureEvidence,
  recordEdRecoveryContact,
};
