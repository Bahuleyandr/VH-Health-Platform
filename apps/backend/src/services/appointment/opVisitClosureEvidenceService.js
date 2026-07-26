import { createHash, randomUUID } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { isClinical } from '../../utils/roleHelpers.js';
import {
  recordCanonicalClinicalEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import {
  CARE_PATHWAY_KEYS,
  PATHWAY_MODES,
} from '../pathways/pathwayMode.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  appendAppointmentStatusHistoryTx,
  lockAppointmentForLifecycleTx,
} from './appointmentLifecycleService.js';
import { resolveOpPathwayModeTx } from './opPathwayWorkService.js';

const OP_PATHWAY_KEY = CARE_PATHWAY_KEYS.OP;
const CLOSURE_BASES = Object.freeze([
  'all_required_work_completed',
  'named_ownership_accepted',
  'accepted_transfer',
]);
const CLOSURE_BASIS_SET = new Set(CLOSURE_BASES);
const AUTHORABLE_NEXT_STEP_FIELDS = Object.freeze([
  'label',
  'explanation',
  'due_date',
  'status',
  'patient_action',
  'route_token',
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
const NEXT_STEP_STATUS_SET = new Set(NEXT_STEP_STATUSES);
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
const NEXT_STEP_ROUTE_TOKEN_SET = new Set(NEXT_STEP_ROUTE_TOKENS);
const MAX_NEXT_STEPS = 32;
const MAX_NEXT_STEPS_BYTES = 32_768;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function uuid(value, label, { required = false } = {}) {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  if (!normalized && !required) return null;
  if (!UUID_RE.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'OP_CLOSURE_EVIDENCE_INVALID');
  }
  return normalized;
}

function integer(value, label, { required = false } = {}) {
  if ((value == null || value === '') && !required) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(
      `${label} must be a positive integer`,
      'OP_CLOSURE_EVIDENCE_INVALID',
    );
  }
  return parsed;
}

function text(value, max, label, { required = false } = {}) {
  const normalized = value == null ? '' : String(value).trim();
  if (!normalized && required) {
    throw AppError.badRequest(`${label} is required`, 'OP_CLOSURE_EVIDENCE_INVALID');
  }
  if (normalized.length > max) {
    throw AppError.badRequest(`${label} is too long`, 'OP_CLOSURE_EVIDENCE_INVALID');
  }
  return normalized || null;
}

function date(value, label) {
  const normalized = text(value, 10, label);
  if (!normalized) return null;
  if (!DATE_RE.test(normalized)) {
    throw AppError.badRequest(`${label} must be YYYY-MM-DD`, 'OP_CLOSURE_EVIDENCE_INVALID');
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw AppError.badRequest(`${label} must be a valid date`, 'OP_CLOSURE_EVIDENCE_INVALID');
  }
  return normalized;
}

function timestamp(value, label) {
  if (value == null || value === '') return null;
  const normalized = text(value, 80, label, { required: true });
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest(`${label} must be an ISO timestamp`, 'OP_CLOSURE_EVIDENCE_INVALID');
  }
  return parsed.toISOString();
}

function enumValue(value, allowed, label, { defaultValue = null } = {}) {
  const normalized = text(value, 80, label);
  if (!normalized) return defaultValue;
  const lowered = normalized.toLowerCase();
  if (!allowed.has(lowered)) {
    throw AppError.badRequest(`${label} is not allowed`, 'OP_CLOSURE_EVIDENCE_INVALID');
  }
  return lowered;
}

function patientNextSteps(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_NEXT_STEPS) {
    throw AppError.badRequest(
      `patient_safe_next_steps must contain 1-${MAX_NEXT_STEPS} items`,
      'OP_CLOSURE_EVIDENCE_INVALID',
    );
  }
  const normalized = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw AppError.badRequest(
        `patient_safe_next_steps[${index}] must be an object`,
        'OP_CLOSURE_EVIDENCE_INVALID',
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
        { defaultValue: 'planned' },
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
      'OP_CLOSURE_EVIDENCE_INVALID',
    );
  }
  return normalized;
}

function normalizeInput(input = {}) {
  if (typeof input.follow_up_required !== 'boolean') {
    throw AppError.badRequest(
      'follow_up_required must be true or false',
      'OP_CLOSURE_EVIDENCE_INVALID',
    );
  }
  const followUpPlanId = integer(input.follow_up_plan_id, 'follow_up_plan_id');
  if (input.follow_up_required && !followUpPlanId) {
    throw AppError.badRequest(
      'follow_up_plan_id is required when follow_up_required is true',
      'OP_CLOSURE_FOLLOW_UP_REQUIRED',
    );
  }
  if (!input.follow_up_required && followUpPlanId) {
    throw AppError.badRequest(
      'follow_up_plan_id must be omitted when follow_up_required is false',
      'OP_CLOSURE_FOLLOW_UP_INVALID',
    );
  }

  const closureBasis = text(input.closure_basis, 40, 'closure_basis', { required: true });
  if (!CLOSURE_BASIS_SET.has(closureBasis)) {
    throw AppError.badRequest(
      `closure_basis must be one of: ${CLOSURE_BASES.join(', ')}`,
      'OP_CLOSURE_EVIDENCE_INVALID',
    );
  }
  const acceptedHandoffId = uuid(input.accepted_handoff_id, 'accepted_handoff_id');
  if (closureBasis === 'accepted_transfer' && !acceptedHandoffId) {
    throw AppError.badRequest(
      'accepted_handoff_id is required for accepted_transfer',
      'OP_CLOSURE_HANDOFF_REQUIRED',
    );
  }
  if (closureBasis !== 'accepted_transfer' && acceptedHandoffId) {
    throw AppError.badRequest(
      'accepted_handoff_id is only valid for accepted_transfer',
      'OP_CLOSURE_HANDOFF_INVALID',
    );
  }
  return {
    followUpRequired: input.follow_up_required,
    followUpPlanId,
    patientSafeNextSteps: patientNextSteps(
      input.patient_safe_next_steps ?? input.patient_next_steps,
    ),
    closureBasis,
    acceptedHandoffId,
    occurredAt: timestamp(input.occurred_at, 'occurred_at'),
    suppliedIdempotencyKey: input.idempotency_key == null
      ? null
      : text(input.idempotency_key, 220, 'idempotency_key', { required: true }),
  };
}

function payloadFingerprint(normalized) {
  return createHash('sha256')
    .update(JSON.stringify({
      follow_up_required: normalized.followUpRequired,
      follow_up_plan_id: normalized.followUpPlanId,
      patient_safe_next_steps: normalized.patientSafeNextSteps,
      closure_basis: normalized.closureBasis,
      accepted_handoff_id: normalized.acceptedHandoffId,
      occurred_at: normalized.occurredAt,
    }))
    .digest('hex');
}

function responseRow(row, { mode, replayed = false } = {}) {
  return {
    mode,
    replayed,
    closure_evidence: {
      id: row.id,
      revision: Number(row.evidence_revision),
      clinician_uid: row.clinician_uid,
      follow_up_required: row.follow_up_required === true,
      follow_up_plan_id: row.follow_up_plan_id == null ? null : Number(row.follow_up_plan_id),
      patient_next_steps: Array.isArray(row.patient_safe_next_steps)
        ? row.patient_safe_next_steps
        : [],
      closure_basis: row.closure_basis,
      accepted_handoff_id: row.accepted_handoff_id || null,
      source_status_history_id: String(row.source_status_history_id),
      occurred_at: row.occurred_at,
      recorded_at: row.recorded_at,
    },
  };
}

async function existingIdempotencyTx(tx, tenantId, idempotencyKey) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, appointment_id, patient_uid, evidence_revision, clinician_uid,
            follow_up_required, follow_up_plan_id, patient_safe_next_steps,
            closure_basis, accepted_handoff_id, source_status_history_id,
            occurred_at, recorded_at
       FROM op_visit_closure_evidence
      WHERE tenant_id = $1::uuid
        AND idempotency_key = $2::text
      LIMIT 1`,
    tenantId,
    idempotencyKey,
  );
  return rows[0] || null;
}

async function validateClinicianTx(tx, { tenantId, clinicianUid } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT clinician.uid, clinician.id, clinician.name, clinician.role,
            clinician.is_active,
            NULLIF(BTRIM(tenant.settings -> 'branding' ->> 'supportEmail'), '')
              AS safe_contact
       FROM users AS clinician
       JOIN tenants AS tenant
         ON tenant.id = clinician.tenant_id
      WHERE clinician.tenant_id = $1::uuid
        AND clinician.uid = $2::uuid
      LIMIT 1`,
    tenantId,
    clinicianUid,
  );
  const clinician = rows[0];
  if (!clinician || clinician.is_active !== true || !isClinical(clinician.role)) {
    throw AppError.forbidden(
      'An active clinician identity is required to record visit closure evidence',
      'OP_CLOSURE_CLINICIAN_REQUIRED',
    );
  }
  return clinician;
}

async function loadOpPathwayTx(tx, {
  tenantId,
  patientUid,
  appointmentId,
} = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, owning_clinician_uid, clinical_status
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND pathway_key = $3::text
        AND source_episode_type = 'appointment'
        AND source_episode_id = $4::text
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    OP_PATHWAY_KEY,
    String(appointmentId),
  );
  return rows[0] || null;
}

async function acceptedCoveringHandoffTx(tx, {
  tenantId,
  patientUid,
  pathwayInstanceId,
  clinicianUid,
} = {}) {
  if (!pathwayInstanceId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM care_handoff_instances
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND sending_pathway_instance_id = $3::uuid
        AND receiving_pathway_instance_id = $3::uuid
        AND handoff_type = 'covering_clinician_reassignment'
        AND source_resource_type = 'care_pathway_instance'
        AND source_resource_id = $3::text
        AND status = 'accepted'
        AND accepted_at IS NOT NULL
        AND intended_recipient_uid = $4::uuid
        AND accepted_by_uid = $4::uuid
      ORDER BY accepted_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    pathwayInstanceId,
    clinicianUid,
  );
  return rows[0] || null;
}

async function authorizeClosureActorTx(tx, {
  tenantId,
  appointment,
  clinicianUid,
} = {}) {
  const pathway = await loadOpPathwayTx(tx, {
    tenantId,
    patientUid: appointment.patient_uid,
    appointmentId: appointment.id,
  });
  const expectedOwnerUid = pathway?.owning_clinician_uid || appointment.doctor_uid;
  if (
    expectedOwnerUid
    && String(expectedOwnerUid).toLowerCase() === String(clinicianUid).toLowerCase()
  ) {
    return { pathway, authority: 'current_owner', coveringHandoff: null };
  }
  const coveringHandoff = await acceptedCoveringHandoffTx(tx, {
    tenantId,
    patientUid: appointment.patient_uid,
    pathwayInstanceId: pathway?.id,
    clinicianUid,
  });
  if (!coveringHandoff) {
    throw AppError.forbidden(
      'Only the current OP owner or the exact accepted covering clinician may record closure evidence',
      'OP_CLOSURE_OWNER_REQUIRED',
    );
  }
  return { pathway, authority: 'accepted_covering_clinician', coveringHandoff };
}

async function validateFollowUpTx(tx, {
  tenantId,
  patientUid,
  appointmentId,
  followUpPlanId,
} = {}) {
  if (!followUpPlanId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM follow_up_plans
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND id = $3::integer
        AND origin_kind = 'consultation'
        AND origin_resource_type = 'appointment'
        AND origin_resource_id = $4::integer::text
        AND status IN ('open', 'scheduled')
      LIMIT 1`,
    tenantId,
    patientUid,
    followUpPlanId,
    appointmentId,
  );
  if (!rows[0]) {
    throw AppError.badRequest(
      'follow_up_plan_id is not an open or scheduled plan originating from this appointment',
      'OP_CLOSURE_FOLLOW_UP_INVALID',
    );
  }
  return Number(rows[0].id);
}

async function validateAcceptedTransferTx(tx, {
  tenantId,
  appointment,
  clinicianUid,
  acceptedHandoffId,
} = {}) {
  if (!acceptedHandoffId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT handoff.id
       FROM care_handoff_instances AS handoff
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = handoff.tenant_id
        AND pathway.id = handoff.sending_pathway_instance_id
        AND pathway.patient_uid = handoff.patient_uid
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.id = $2::uuid
        AND handoff.patient_uid = $3::uuid
        AND handoff.handoff_type = 'op_to_inpatient_transfer'
        AND handoff.source_resource_type = 'appointment'
        AND handoff.source_resource_id = $4::text
        AND handoff.status = 'accepted'
        AND handoff.accepted_at IS NOT NULL
        AND handoff.sender_uid = $5::uuid
        AND handoff.intended_recipient_uid IS NOT NULL
        AND handoff.intended_recipient_uid <> $5::uuid
        AND handoff.accepted_by_uid = handoff.intended_recipient_uid
        AND pathway.pathway_key = $6::text
        AND pathway.source_episode_type = 'appointment'
        AND pathway.source_episode_id = $4::text
      LIMIT 1
      FOR SHARE OF handoff, pathway`,
    tenantId,
    acceptedHandoffId,
    appointment.patient_uid,
    String(appointment.id),
    clinicianUid,
    OP_PATHWAY_KEY,
  );
  if (!rows[0]) {
    throw AppError.badRequest(
      'accepted_handoff_id must be the exact accepted OP transfer for this appointment and clinician',
      'OP_CLOSURE_HANDOFF_INVALID',
    );
  }
  return rows[0].id;
}

function decoratePatientNextSteps(patientSafeNextSteps, clinician) {
  return patientSafeNextSteps.map((step) => ({
    ...step,
    responsible_clinician_display_name: clinician.name || null,
    responsible_clinician_role: clinician.role || null,
    safe_contact: clinician.safe_contact || null,
  }));
}

function authorablePatientNextSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.map((step) => Object.fromEntries(
    AUTHORABLE_NEXT_STEP_FIELDS.map((field) => [field, step?.[field] ?? null]),
  ));
}

function idempotentPayloadMatches(existing, {
  appointment,
  clinicianUid,
  normalized,
} = {}) {
  if (
    String(existing.appointment_id) !== String(appointment.id)
    || String(existing.patient_uid).toLowerCase() !== String(appointment.patient_uid).toLowerCase()
    || String(existing.clinician_uid).toLowerCase() !== String(clinicianUid).toLowerCase()
    || (existing.follow_up_required === true) !== normalized.followUpRequired
    || Number(existing.follow_up_plan_id || 0) !== Number(normalized.followUpPlanId || 0)
    || existing.closure_basis !== normalized.closureBasis
    || String(existing.accepted_handoff_id || '') !== String(normalized.acceptedHandoffId || '')
  ) {
    return false;
  }
  if (
    JSON.stringify(authorablePatientNextSteps(existing.patient_safe_next_steps))
    !== JSON.stringify(authorablePatientNextSteps(normalized.patientSafeNextSteps))
  ) {
    return false;
  }
  if (normalized.occurredAt) {
    const existingOccurredAt = new Date(existing.occurred_at);
    if (
      Number.isNaN(existingOccurredAt.getTime())
      || existingOccurredAt.toISOString() !== normalized.occurredAt
    ) {
      return false;
    }
  }
  return true;
}

export async function recordOpVisitClosureEvidence({
  tenantId,
  appointmentId,
  clinicianUid,
  input = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const actorUid = uuid(clinicianUid, 'clinician_uid', { required: true });
  const normalized = normalizeInput(input);
  return setTenantTx(tid, async (tx) => {
    const appointment = await lockAppointmentForLifecycleTx(tx, {
      tenantId: tid,
      appointmentId,
    });
    const mode = await resolveOpPathwayModeTx(tx, tid);
    if (mode === PATHWAY_MODES.OFF) {
      throw AppError.conflict(
        'OP pathway closure evidence is unavailable while the pathway is off',
        'OP_PATHWAY_MODE_OFF',
      );
    }

    const clinician = await validateClinicianTx(tx, {
      tenantId: tid,
      clinicianUid: actorUid,
    });
    await authorizeClosureActorTx(tx, {
      tenantId: tid,
      appointment,
      clinicianUid: actorUid,
    });

    const idempotencyKey = normalized.suppliedIdempotencyKey
      || `op-closure:${appointment.id}:${actorUid}:${payloadFingerprint(normalized)}`;
    const existing = await existingIdempotencyTx(tx, tid, idempotencyKey);
    if (existing) {
      if (!idempotentPayloadMatches(existing, {
        appointment,
        clinicianUid: actorUid,
        normalized,
      })) {
        throw AppError.conflict(
          'idempotency_key is already bound to different closure evidence',
          'OP_CLOSURE_IDEMPOTENCY_REUSED',
        );
      }
      return responseRow(existing, { mode, replayed: true });
    }

    await validateFollowUpTx(tx, {
      tenantId: tid,
      patientUid: appointment.patient_uid,
      appointmentId: appointment.id,
      followUpPlanId: normalized.followUpPlanId,
    });
    await validateAcceptedTransferTx(tx, {
      tenantId: tid,
      appointment,
      clinicianUid: actorUid,
      acceptedHandoffId: normalized.acceptedHandoffId,
    });

    const revisionRows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(evidence_revision), 0)::integer + 1 AS next_revision
         FROM op_visit_closure_evidence
        WHERE tenant_id = $1::uuid
          AND appointment_id = $2::integer`,
      tid,
      Number(appointment.id),
    );
    const evidenceRevision = Number(revisionRows[0].next_revision);
    const statusHistory = await appendAppointmentStatusHistoryTx(tx, {
      tenantId: tid,
      appointmentId: appointment.id,
      fromStatus: appointment.status,
      toStatus: appointment.status,
      actorId: clinician.id,
      actorRole: clinician.role,
      reason: `OP visit closure evidence revision ${evidenceRevision} recorded`,
    });
    const evidenceId = randomUUID();
    const patientSafeNextSteps = decoratePatientNextSteps(
      normalized.patientSafeNextSteps,
      clinician,
    );
    const canonical = await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: appointment.patient_uid,
      eventType: 'appointment.closure_evidence_recorded',
      eventStatus: 'recorded',
      sourceTable: 'op_visit_closure_evidence',
      sourceId: evidenceId,
      resourceType: 'op_visit_closure_evidence',
      resourceId: evidenceId,
      actorUid,
      actorRole: clinician.role,
      occurredAt: normalized.occurredAt,
      summary: 'Outpatient visit disposition and next steps recorded',
      payload: {
        appointment_id: Number(appointment.id),
        appointment_uid: appointment.uid || null,
        patient_uid: appointment.patient_uid,
        evidence_revision: evidenceRevision,
        follow_up_required: normalized.followUpRequired,
        follow_up_plan_id: normalized.followUpPlanId,
        closure_basis: normalized.closureBasis,
        accepted_handoff_id: normalized.acceptedHandoffId,
        source_status_history_id: statusHistory.id,
      },
      beforeState: null,
      afterState: {
        evidence_revision: evidenceRevision,
        closure_basis: normalized.closureBasis,
      },
      timelineIdempotencyKey: `op_visit_closure_evidence:${evidenceId}:timeline`,
      auditIdempotencyKey: `op_visit_closure_evidence:${evidenceId}:audit`,
    }, { db: tx, strict: true });
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO op_visit_closure_evidence
         (id, tenant_id, appointment_id, patient_uid, evidence_revision,
          clinician_uid, follow_up_required, follow_up_plan_id,
          patient_safe_next_steps, closure_basis, accepted_handoff_id,
          source_status_history_id, canonical_timeline_event_id,
          canonical_audit_event_id, occurred_at, idempotency_key)
       VALUES
         ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::integer,
          $6::uuid, $7::boolean, $8::integer,
          $9::jsonb, $10::text, $11::uuid,
          $12::bigint, $13::uuid,
          $14::uuid, COALESCE($15::timestamptz, NOW()), $16::text)
       RETURNING id, appointment_id, patient_uid, evidence_revision, clinician_uid,
                 follow_up_required, follow_up_plan_id, patient_safe_next_steps,
                 closure_basis, accepted_handoff_id, source_status_history_id,
                 occurred_at, recorded_at`,
      evidenceId,
      tid,
      Number(appointment.id),
      appointment.patient_uid,
      evidenceRevision,
      actorUid,
      normalized.followUpRequired,
      normalized.followUpPlanId,
      JSON.stringify(patientSafeNextSteps),
      normalized.closureBasis,
      normalized.acceptedHandoffId,
      statusHistory.id,
      canonical.timeline.id,
      canonical.audit.id,
      normalized.occurredAt,
      idempotencyKey,
    );
    const row = inserted[0];
    if (!row) {
      throw AppError.internal(
        'OP visit closure evidence was not recorded',
        'OP_CLOSURE_EVIDENCE_REQUIRED',
      );
    }
    const outbox = await publishEvent({
      eventType: 'appointment.closure_evidence_recorded',
      aggregateType: 'appointment',
      aggregateId: String(appointment.id),
      patientUid: appointment.patient_uid,
      payload: {
        appointment_id: Number(appointment.id),
        appointment_uid: appointment.uid || null,
        patient_uid: appointment.patient_uid,
        tenant_id: tid,
        closure_evidence_id: row.id,
        evidence_revision: evidenceRevision,
        source_status_history_id: statusHistory.id,
        canonical_timeline_event_id: canonical.timeline.id,
        canonical_audit_event_id: canonical.audit.id,
        source: 'closure_evidence',
      },
      tx,
      tenantId: tid,
    });
    if (!outbox) {
      throw AppError.internal(
        'OP visit closure outbox event was not recorded',
        'APPOINTMENT_OUTBOX_REQUIRED',
      );
    }
    return responseRow(row, { mode, replayed: false });
  });
}

export const __testing__ = Object.freeze({
  AUTHORABLE_NEXT_STEP_FIELDS,
  CLOSURE_BASES,
  NEXT_STEP_ROUTE_TOKENS,
  NEXT_STEP_STATUSES,
  authorablePatientNextSteps,
  decoratePatientNextSteps,
  idempotentPayloadMatches,
  normalizeInput,
  patientNextSteps,
  payloadFingerprint,
  responseRow,
  validateFollowUpTx,
});

export default {
  recordOpVisitClosureEvidence,
};
