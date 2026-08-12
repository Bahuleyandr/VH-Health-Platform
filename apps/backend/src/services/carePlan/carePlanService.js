/**
 * CarePlan / FollowUpPlan service (Phase C3).
 *
 * Manages the five tables added in migration 122:
 *   - care_plans            (top-level plan record)
 *   - care_plan_goals       (measurable goals)
 *   - care_plan_activities  (actionable items, scheduled)
 *   - follow_up_plans       (visit-specific follow-up; usually one-off)
 *   - care_plan_review_log  (append-only review history)
 *
 * Decision-support only: no auto-cancellation, no auto-completion. All
 * status transitions are explicit. The patient-facing flag gates
 * patient-app visibility; backend never auto-publishes.
 */

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { publishOpChildResourceLinkedTx } from '../appointment/opChildResourceEventService.js';
import { recordAppointmentCreatedEvidenceTx } from '../appointment/appointmentLifecycleService.js';
import { lockAppointmentPatientIdentity } from '../appointment/appointmentPatientIdentityService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const PLAN_KINDS = [
  'general', 'chronic_disease', 'post_surgical', 'palliative',
  'pediatric', 'pregnancy', 'mental_health', 'rehab', 'preventive',
  'oncology', 'transplant', 'other',
];
export const PLAN_STATUSES = ['draft', 'active', 'paused', 'completed', 'cancelled', 'archived', 'on_hold', 'superseded'];
export const GOAL_KINDS = [
  'clinical_target', 'lifestyle', 'medication_adherence', 'symptom_control',
  'self_management', 'education', 'screening', 'milestone', 'other',
];
export const GOAL_STATUSES = ['planned', 'in_progress', 'achieved', 'not_achieved', 'cancelled', 'on_hold'];
export const PRIORITIES = ['low', 'normal', 'high', 'critical'];
export const ACTIVITY_KINDS = [
  'task', 'medication', 'investigation', 'procedure', 'observation',
  'education', 'lifestyle', 'follow_up', 'self_check', 'other',
];
export const ACTIVITY_SCHEDULES = ['one_time', 'daily', 'weekly', 'monthly', 'on_event', 'as_needed'];
export const ACTIVITY_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled', 'overdue', 'skipped'];
export const FOLLOWUP_ORIGINS = [
  'consultation', 'discharge', 'ot_case', 'er_visit', 'admission',
  'investigation', 'teleconsult', 'manual', 'other',
];
export const FOLLOWUP_STATUSES = ['open', 'scheduled', 'completed', 'cancelled', 'overdue', 'lost_to_followup'];
export const FOLLOWUP_APPT_STATUSES = ['pending', 'scheduled', 'completed', 'cancelled', 'no_show'];
export const REVIEW_LOG_KINDS = [
  'created', 'reviewed', 'updated', 'goal_added', 'goal_completed',
  'activity_added', 'paused', 'resumed', 'completed', 'cancelled',
  'superseded', 'comment',
];

const PLAN_TRANSITIONS = {
  draft: ['active', 'cancelled', 'archived'],
  active: ['paused', 'on_hold', 'completed', 'cancelled', 'superseded'],
  paused: ['active', 'cancelled'],
  on_hold: ['active', 'cancelled'],
  completed: ['archived'],
  cancelled: ['archived'],
  superseded: ['archived'],
  archived: [],
};

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid', { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a YYYY-MM-DD date`);
  }
  return text;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function shouldBookFollowUpAppointment({ originKind, dueAt, doctorUid, bookAppointment }) {
  if (!dueAt || !doctorUid) return false;
  if (bookAppointment === false) return false;
  return bookAppointment === true || originKind === 'discharge';
}

async function reserveFollowUpAppointment({
  db = prisma,
  tenantId,
  patientUid,
  doctorUid,
  dueAt,
  reason = null,
  createdBy = null,
}) {
  const patient = await lockAppointmentPatientIdentity(db, {
    tenantId,
    patientUid,
  });
  const doctorRows = await db.$queryRawUnsafe(
      `SELECT u.id, u.name, COALESCE(dept.name, d.department) AS department
         FROM users u
         LEFT JOIN doctors d
           ON d.user_id = u.id
          AND d.tenant_id = u.tenant_id
          AND d.is_active = true
         LEFT JOIN departments dept
           ON dept.id = d.department_id
          AND dept.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1::uuid
          AND u.uid = $2::uuid
          AND u.role = 'DOCTOR'
          AND u.is_active = true
        LIMIT 1`,
      tenantId,
      doctorUid,
    );

  const doctor = doctorRows[0];
  if (!doctor) throw AppError.badRequest('Cannot book follow-up appointment: doctor_uid is not an active DOCTOR');

  const conflicts = await db.$queryRawUnsafe(
      `SELECT id
       FROM appointments
      WHERE tenant_id = $1::uuid
        AND doctor_id = $2::int
        AND DATE(appointment_date) = ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
        AND appointment_time = to_char($3::timestamptz AT TIME ZONE 'Asia/Kolkata', 'HH24:MI')
        AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
      LIMIT 1`,
    tenantId,
    Number(doctor.id),
    dueAt,
  );
  if (conflicts.length > 0) {
    throw AppError.conflict(
      'Cannot book follow-up appointment: selected doctor slot is already booked',
      'FOLLOW_UP_SLOT_CONFLICT',
      { conflicting_appointment_id: conflicts[0].id },
    );
  }

  const appointments = await db.$queryRawUnsafe(
    `INSERT INTO appointments
       (phone, patient_id, patient_name, doctor_id, doctor_name,
        appointment_date, appointment_time, reason, notes, status,
        department, visit_type, created_by, tenant_id, created_at, updated_at)
     VALUES
       ($1, $2::int, $3, $4::int, $5,
        ($6::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,
        to_char($6::timestamptz AT TIME ZONE 'Asia/Kolkata', 'HH24:MI'),
        $7, $8, 'SCHEDULED',
        $9, 'FOLLOW_UP', $10::uuid, $11::uuid, NOW(), NOW())
     RETURNING id, uid, status, tenant_id, created_at`,
    patient.phone || '',
    Number(patient.id),
    patient.name || null,
    Number(doctor.id),
    doctor.name || '',
    dueAt,
    reason || 'Discharge follow-up',
    'Booked from discharge follow-up plan',
    doctor.department || null,
    createdBy,
    tenantId,
  );
  return appointments[0];
}

function normalizeIntArray(value, label, { min = 0, max = 1_000_000 } = {}) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array of integers`);
  return value.map((v) => {
    const parsed = Number.parseInt(v, 10);
    if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} entries must be integers`);
    if (parsed < min) throw AppError.badRequest(`${label} entries must be >= ${min}`);
    if (parsed > max) throw AppError.badRequest(`${label} entries must be <= ${max}`);
    return parsed;
  });
}

// ---------------------------------------------------------------------------
// Canonical clinical timeline / audit emission
// ---------------------------------------------------------------------------

// Build the timeline + audit idempotency-key pair for a care-plan detail row.
// Insert-once creation sites use `created`; the amendable transition site
// includes the target status + row timestamp so a repeat transition to the same
// status is not silently absorbed by the ON CONFLICT (idempotency_key) writer.
function canonicalKeys(sourceTable, sourceId, suffix) {
  return {
    timelineIdempotencyKey: `${sourceTable}:${sourceId}:${suffix}`,
    auditIdempotencyKey: `${sourceTable}:${sourceId}:audit:${suffix}`,
  };
}

// Emit the canonical clinical timeline + audit event for a care-plan clinical
// write, ATOMIC with the detail-row write it accompanies
// (docs/CANONICAL_CLINICAL_TIMELINE.md). Always called with the enclosing
// transaction handle (`tx`): recordCanonicalClinicalEvent then requires both the
// timeline and audit rows, narrows its swallow to the canonical-table-absent
// (SQLSTATE 42P01) case, and re-throws every other fault — so a genuine
// canonical failure aborts the caller's tx and the detail write rolls back
// rather than leaving a detail row with no timeline/audit row.
function emitCarePlanCanonicalEvent(tx, {
  tenantId,
  patientUid,
  eventType,
  eventStatus = null,
  sourceTable,
  sourceId,
  resourceType,
  actorUid = null,
  actorRole = null,
  summary,
  payload = {},
  beforeState = null,
  afterState = null,
  tags = ['care_plan'],
  keySuffix = 'created',
}) {
  if (!patientUid || sourceId === null || sourceId === undefined) return null;
  const id = String(sourceId);
  return recordCanonicalClinicalEvent({
    tenantId,
    patientUid,
    eventType,
    eventStatus,
    sourceTable,
    sourceId: id,
    resourceType,
    resourceId: id,
    actorUid,
    actorRole,
    summary,
    payload,
    beforeState,
    afterState,
    tags,
    ...canonicalKeys(sourceTable, id, keySuffix),
  }, { db: tx });
}

// Resolve the care plan's owning patient inside the same tx — care_plan_goals
// and care_plan_activities carry a nullable patient_uid, but care_plans.patient_uid
// is always set (createCarePlan requires it), so the timeline event can always
// be attributed to a patient.
async function resolveCarePlanPatientUid(db, tenantId, carePlanId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT patient_uid FROM care_plans WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    carePlanId, tenantId,
  );
  return rows[0]?.patient_uid || null;
}

// ---------------------------------------------------------------------------
// care_plans
// ---------------------------------------------------------------------------

const PLAN_RETURNING = `id, tenant_id, patient_uid, plan_kind, primary_condition,
  primary_condition_icd10, display_name, description, status,
  start_date, target_end_date, actual_end_date,
  primary_doctor_uid, care_team_role, encounter_id, facility_id,
  is_patient_visible, metadata, created_by, superseded_by_id,
  created_at, updated_at`;

export async function createCarePlan({
  tenantId = null,
  patientUid,
  planKind = 'general',
  primaryCondition = null,
  primaryConditionIcd10 = null,
  displayName,
  description = null,
  status = 'draft',
  startDate = null,
  targetEndDate = null,
  primaryDoctorUid = null,
  careTeamRole = null,
  encounterId = null,
  facilityId = null,
  isPatientVisible = false,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanUid = maybeUuid(patientUid, 'patient_uid', { required: true });
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');

  const actorUid = maybeUuid(createdBy, 'created_by');
  try {
    return await setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO care_plans
           (tenant_id, patient_uid, plan_kind, primary_condition, primary_condition_icd10,
            display_name, description, status,
            start_date, target_end_date,
            primary_doctor_uid, care_team_role, encounter_id, facility_id,
            is_patient_visible, metadata, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
                 $9::date, $10::date,
                 $11::uuid, $12, $13, $14,
                 $15, $16::jsonb, $17::uuid)
         RETURNING ${PLAN_RETURNING}`,
        tid, cleanUid,
        normalizeEnum(planKind, PLAN_KINDS, 'plan_kind') || 'general',
        safeText(primaryCondition, SHORT_MAX),
        safeText(primaryConditionIcd10, 20),
        cleanName, safeText(description),
        normalizeEnum(status, PLAN_STATUSES, 'status') || 'draft',
        normalizeDate(startDate, 'start_date'),
        normalizeDate(targetEndDate, 'target_end_date'),
        maybeUuid(primaryDoctorUid, 'primary_doctor_uid'),
        safeText(careTeamRole, 80),
        encounterId ? normalizeId(encounterId, 'encounter_id') : null,
        facilityId ? normalizeId(facilityId, 'facility_id') : null,
        normalizeBoolean(isPatientVisible, false),
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
        actorUid,
      );
      const plan = rows[0];

      // Append the 'created' review-log row atomically with the plan (was a
      // separate best-effort insert on plain prisma before the canonical fix).
      await tx.$queryRawUnsafe(
        `INSERT INTO care_plan_review_log
           (tenant_id, care_plan_id, reviewer_uid, event_kind, notes, payload)
         VALUES ($1::uuid, $2, $3::uuid, 'created', $4, $5::jsonb)`,
        tid, plan.id, actorUid,
        cleanName, JSON.stringify({ plan_kind: plan.plan_kind, status: plan.status }),
      );

      // Canonical clinical timeline + audit — atomic with the plan write.
      await emitCarePlanCanonicalEvent(tx, {
        tenantId: tid,
        patientUid: plan.patient_uid,
        eventType: 'care_plan.created',
        eventStatus: plan.status,
        sourceTable: 'care_plans',
        sourceId: plan.id,
        resourceType: 'care_plan',
        actorUid,
        summary: `Care plan created: ${plan.display_name || cleanName}`,
        payload: {
          care_plan_id: plan.id,
          plan_kind: plan.plan_kind,
          status: plan.status,
          primary_condition: plan.primary_condition || null,
          primary_doctor_uid: plan.primary_doctor_uid || null,
          is_patient_visible: plan.is_patient_visible,
        },
        afterState: { status: plan.status },
        keySuffix: 'created',
      });

      return plan;
    });
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listCarePlans({
  tenantId = null, patientUid = null, status = null, planKind = null,
  doctorUid = null, isPatientVisible = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (status) {
    params.push(normalizeEnum(status, PLAN_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (planKind) {
    params.push(normalizeEnum(planKind, PLAN_KINDS, 'plan_kind'));
    filters.push(`plan_kind = $${params.length}`);
  }
  if (doctorUid) {
    params.push(maybeUuid(doctorUid, 'doctor_uid'));
    filters.push(`primary_doctor_uid = $${params.length}::uuid`);
  }
  if (isPatientVisible !== null) {
    params.push(normalizeBoolean(isPatientVisible));
    filters.push(`is_patient_visible = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PLAN_RETURNING} FROM care_plans
       WHERE ${filters.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { care_plans: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { care_plans: [], count: 0 };
    throw err;
  }
}

export async function getCarePlanBundle({ tenantId = null, id } = {}) {
  const plan = await getCarePlan({ tenantId, id });
  const [goals, activities, reviewLog] = await Promise.all([
    listGoals({ tenantId, carePlanId: plan.id }),
    listActivities({ tenantId, carePlanId: plan.id }),
    listReviewLog({ tenantId, carePlanId: plan.id, limit: 20 }),
  ]);
  return {
    care_plan: plan,
    goals: goals.goals,
    activities: activities.activities,
    review_log: reviewLog.entries,
  };
}

export async function listCarePlanBundlesForPatient({
  tenantId = null,
  patientUid,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const result = await listCarePlans({ tenantId, patientUid, status, limit });
  const carePlans = await Promise.all(
    result.care_plans.map(async (plan) => {
      const [goals, activities] = await Promise.all([
        listGoals({ tenantId, carePlanId: plan.id }),
        listActivities({ tenantId, carePlanId: plan.id }),
      ]);
      return {
        ...plan,
        goals: goals.goals,
        activities: activities.activities,
      };
    }),
  );
  return { care_plans: carePlans, count: carePlans.length };
}

export async function getCarePlan({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(id, 'care_plan id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${PLAN_RETURNING} FROM care_plans
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    planId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Care plan not found');
  return rows[0];
}

export async function transitionCarePlan({
  tenantId = null, id, nextStatus, reviewerUid = null, notes = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(id, 'care_plan id');
  const cleanNext = normalizeEnum(nextStatus, PLAN_STATUSES, 'next_status', { required: true });

  const current = await getCarePlan({ tenantId: tid, id: planId });
  const allowed = PLAN_TRANSITIONS[current.status] || [];
  if (!allowed.includes(cleanNext)) {
    throw AppError.invalidTransition(current.status, cleanNext, allowed);
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanNext];
  if (cleanNext === 'completed' || cleanNext === 'cancelled') {
    params.push(new Date().toISOString().slice(0, 10));
    updates.push(`actual_end_date = $${params.length}::date`);
  }
  params.push(planId);
  params.push(tid);

  const actorUid = maybeUuid(reviewerUid, 'reviewer_uid');
  const eventKind = (() => {
    if (cleanNext === 'paused') return 'paused';
    if (cleanNext === 'active' && current.status === 'paused') return 'resumed';
    if (cleanNext === 'completed') return 'completed';
    if (cleanNext === 'cancelled') return 'cancelled';
    if (cleanNext === 'superseded') return 'superseded';
    return 'updated';
  })();

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE care_plans SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
       RETURNING ${PLAN_RETURNING}`,
      ...params,
    );
    if (!rows[0]) throw AppError.notFound('Care plan not found');
    const updated = rows[0];

    // Log the transition atomically with the status change.
    await tx.$queryRawUnsafe(
      `INSERT INTO care_plan_review_log
         (tenant_id, care_plan_id, reviewer_uid, event_kind, notes, payload)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb)`,
      tid, planId, actorUid, eventKind,
      safeText(notes),
      JSON.stringify({ from: current.status, to: cleanNext }),
    );

    // Canonical clinical timeline + audit — atomic with the transition. A care
    // plan is amendable (multiple transitions per row), so the key carries the
    // target status + row timestamp per the idempotency-key discipline.
    await emitCarePlanCanonicalEvent(tx, {
      tenantId: tid,
      patientUid: updated.patient_uid,
      eventType: 'care_plan.transitioned',
      eventStatus: cleanNext,
      sourceTable: 'care_plans',
      sourceId: updated.id,
      resourceType: 'care_plan',
      actorUid,
      summary: `Care plan ${current.status} -> ${cleanNext}`,
      payload: {
        care_plan_id: updated.id,
        from: current.status,
        to: cleanNext,
        event_kind: eventKind,
        notes: safeText(notes),
      },
      beforeState: { status: current.status },
      afterState: { status: cleanNext },
      keySuffix: `transitioned:${cleanNext}:${updated.updated_at?.toISOString?.() || Date.now()}`,
    });

    return updated;
  });
}

export async function setCarePlanVisibility({
  tenantId = null, id, isPatientVisible, reviewerUid = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(id, 'care_plan id');
  const flag = normalizeBoolean(isPatientVisible, false);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE care_plans
     SET is_patient_visible = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid
     RETURNING ${PLAN_RETURNING}`,
    flag, planId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Care plan not found');
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO care_plan_review_log
         (tenant_id, care_plan_id, reviewer_uid, event_kind, payload)
       VALUES ($1::uuid, $2, $3::uuid, 'updated', $4::jsonb)`,
      tid, planId, maybeUuid(reviewerUid, 'reviewer_uid'),
      JSON.stringify({ is_patient_visible: flag }),
    );
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// care_plan_goals
// ---------------------------------------------------------------------------

const GOAL_RETURNING = `id, tenant_id, care_plan_id, patient_uid, goal_kind,
  description, measurement_label, measurement_unit,
  baseline_value, target_value, current_value,
  target_due_date, achieved_at, priority, status,
  metadata, created_at, updated_at`;

export async function createGoal({
  tenantId = null,
  carePlanId,
  patientUid = null,
  goalKind = 'clinical_target',
  description,
  measurementLabel = null,
  measurementUnit = null,
  baselineValue = null,
  targetValue = null,
  currentValue = null,
  targetDueDate = null,
  priority = 'normal',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(carePlanId, 'care_plan_id');
  const cleanDescription = safeText(description);
  if (!cleanDescription) throw AppError.badRequest('description is required');

  try {
    return await setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO care_plan_goals
           (tenant_id, care_plan_id, patient_uid, goal_kind, description,
            measurement_label, measurement_unit,
            baseline_value, target_value, current_value,
            target_due_date, priority, status, metadata)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
                 $11::date, $12, 'planned', $13::jsonb)
         RETURNING ${GOAL_RETURNING}`,
        tid, planId, maybeUuid(patientUid, 'patient_uid'),
        normalizeEnum(goalKind, GOAL_KINDS, 'goal_kind') || 'clinical_target',
        cleanDescription,
        safeText(measurementLabel, 120), safeText(measurementUnit, 40),
        safeText(baselineValue, 120), safeText(targetValue, 120), safeText(currentValue, 120),
        normalizeDate(targetDueDate, 'target_due_date'),
        normalizeEnum(priority, PRIORITIES, 'priority') || 'normal',
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      );
      const goal = rows[0];

      // Canonical clinical timeline + audit — atomic with the goal write. The
      // goal's patient_uid is nullable; fall back to the owning care plan.
      const goalPatientUid = goal.patient_uid
        || await resolveCarePlanPatientUid(tx, tid, planId);
      await emitCarePlanCanonicalEvent(tx, {
        tenantId: tid,
        patientUid: goalPatientUid,
        eventType: 'care_plan.goal.created',
        eventStatus: goal.status,
        sourceTable: 'care_plan_goals',
        sourceId: goal.id,
        resourceType: 'care_plan_goal',
        summary: `Care plan goal added: ${(goal.description || '').slice(0, 120)}`,
        payload: {
          care_plan_id: planId,
          care_plan_goal_id: goal.id,
          goal_kind: goal.goal_kind,
          status: goal.status,
          priority: goal.priority,
        },
        afterState: { status: goal.status },
        tags: ['care_plan', 'goal'],
        keySuffix: 'created',
      });

      return goal;
    });
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid care_plan_id');
    throw err;
  }
}

export async function updateGoalProgress({
  tenantId = null, id, currentValue = null, status = null, achievedAt = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const goalId = normalizeId(id, 'goal id');
  const updates = ['updated_at = NOW()'];
  const params = [];
  if (currentValue !== null) {
    params.push(safeText(currentValue, 120));
    updates.push(`current_value = $${params.length}`);
  }
  if (status !== null) {
    params.push(normalizeEnum(status, GOAL_STATUSES, 'status'));
    updates.push(`status = $${params.length}`);
    if (status === 'achieved') {
      params.push(achievedAt ? normalizeTimestamp(achievedAt, 'achieved_at') : new Date().toISOString());
      updates.push(`achieved_at = $${params.length}::timestamptz`);
    }
  }
  if (params.length === 0) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT ${GOAL_RETURNING} FROM care_plan_goals
       WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      goalId, tid,
    );
    if (!existing[0]) throw AppError.notFound('Goal not found');
    return existing[0];
  }
  params.push(goalId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE care_plan_goals SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${GOAL_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Goal not found');
  return rows[0];
}

export async function listGoals({
  tenantId = null, carePlanId = null, status = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (carePlanId) {
    params.push(normalizeId(carePlanId, 'care_plan_id'));
    filters.push(`care_plan_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, GOAL_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${GOAL_RETURNING} FROM care_plan_goals
       WHERE ${filters.join(' AND ')}
       ORDER BY priority DESC, target_due_date NULLS LAST, created_at
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { goals: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { goals: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// care_plan_activities
// ---------------------------------------------------------------------------

const ACTIVITY_RETURNING = `id, tenant_id, care_plan_id, related_goal_id, patient_uid,
  activity_kind, title, description,
  schedule_kind, schedule_payload, scheduled_start, scheduled_end, next_due_at,
  assigned_to_uid, assigned_to_role, status, completion_count, expected_count,
  is_patient_facing, task_id, metadata, created_at, updated_at`;

export async function createActivity({
  tenantId = null,
  carePlanId,
  relatedGoalId = null,
  patientUid = null,
  activityKind = 'task',
  title,
  description = null,
  scheduleKind = 'one_time',
  schedulePayload = null,
  scheduledStart = null,
  scheduledEnd = null,
  nextDueAt = null,
  assignedToUid = null,
  assignedToRole = null,
  expectedCount = null,
  isPatientFacing = true,
  taskId = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(carePlanId, 'care_plan_id');
  const cleanTitle = safeText(title, SHORT_MAX);
  if (!cleanTitle) throw AppError.badRequest('title is required');

  try {
    return await setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO care_plan_activities
           (tenant_id, care_plan_id, related_goal_id, patient_uid,
            activity_kind, title, description,
            schedule_kind, schedule_payload, scheduled_start, scheduled_end, next_due_at,
            assigned_to_uid, assigned_to_role, status, expected_count,
            is_patient_facing, task_id, metadata)
         VALUES ($1::uuid, $2, $3, $4::uuid,
                 $5, $6, $7,
                 $8, $9::jsonb, $10::timestamptz, $11::timestamptz, $12::timestamptz,
                 $13::uuid, $14, 'planned', $15,
                 $16, $17, $18::jsonb)
         RETURNING ${ACTIVITY_RETURNING}`,
        tid, planId,
        relatedGoalId ? normalizeId(relatedGoalId, 'related_goal_id') : null,
        maybeUuid(patientUid, 'patient_uid'),
        normalizeEnum(activityKind, ACTIVITY_KINDS, 'activity_kind') || 'task',
        cleanTitle, safeText(description),
        normalizeEnum(scheduleKind, ACTIVITY_SCHEDULES, 'schedule_kind') || 'one_time',
        JSON.stringify(normalizeJsonObject(schedulePayload, 'schedule_payload')),
        normalizeTimestamp(scheduledStart, 'scheduled_start'),
        normalizeTimestamp(scheduledEnd, 'scheduled_end'),
        normalizeTimestamp(nextDueAt, 'next_due_at'),
        maybeUuid(assignedToUid, 'assigned_to_uid'),
        safeText(assignedToRole, 80),
        normalizeInt(expectedCount, 'expected_count', { min: 0, max: 10000 }),
        normalizeBoolean(isPatientFacing, true),
        taskId ? normalizeId(taskId, 'task_id') : null,
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      );
      const activity = rows[0];

      // Canonical clinical timeline + audit — atomic with the activity write.
      // The activity's patient_uid is nullable; fall back to the owning plan.
      const activityPatientUid = activity.patient_uid
        || await resolveCarePlanPatientUid(tx, tid, planId);
      await emitCarePlanCanonicalEvent(tx, {
        tenantId: tid,
        patientUid: activityPatientUid,
        eventType: 'care_plan.activity.created',
        eventStatus: activity.status,
        sourceTable: 'care_plan_activities',
        sourceId: activity.id,
        resourceType: 'care_plan_activity',
        actorUid: maybeUuid(assignedToUid, 'assigned_to_uid'),
        summary: `Care plan activity added: ${activity.title || cleanTitle}`,
        payload: {
          care_plan_id: planId,
          care_plan_activity_id: activity.id,
          activity_kind: activity.activity_kind,
          schedule_kind: activity.schedule_kind,
          status: activity.status,
          is_patient_facing: activity.is_patient_facing,
        },
        afterState: { status: activity.status },
        tags: ['care_plan', 'activity'],
        keySuffix: 'created',
      });

      return activity;
    });
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid care_plan_id or related_goal_id');
    throw err;
  }
}

export async function recordActivityCompletion({
  tenantId = null, id, status = 'completed', incrementCount = true,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const activityId = normalizeId(id, 'activity id');
  const cleanStatus = normalizeEnum(status, ACTIVITY_STATUSES, 'status') || 'completed';
  const flagInc = normalizeBoolean(incrementCount, true);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE care_plan_activities
     SET status = $1::text,
         completion_count = completion_count + (CASE WHEN $2 AND $1::text = 'completed' THEN 1 ELSE 0 END),
         updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4::uuid
     RETURNING ${ACTIVITY_RETURNING}`,
    cleanStatus, flagInc, activityId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Activity not found');
  return rows[0];
}

export async function listActivities({
  tenantId = null, carePlanId = null, status = null, patientUid = null,
  dueWithinHours = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (carePlanId) {
    params.push(normalizeId(carePlanId, 'care_plan_id'));
    filters.push(`care_plan_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, ACTIVITY_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (dueWithinHours !== null && dueWithinHours !== undefined) {
    const hours = normalizeInt(dueWithinHours, 'due_within_hours', { min: 0, max: 24 * 365 });
    params.push(hours);
    filters.push(`next_due_at IS NOT NULL AND next_due_at <= NOW() + ($${params.length}::int * INTERVAL '1 hour')`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${ACTIVITY_RETURNING} FROM care_plan_activities
       WHERE ${filters.join(' AND ')}
       ORDER BY next_due_at NULLS LAST, created_at
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { activities: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { activities: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// follow_up_plans
// ---------------------------------------------------------------------------

const FOLLOWUP_RETURNING = `id, tenant_id, patient_uid, origin_kind,
  origin_resource_type, origin_resource_id, encounter_id,
  doctor_uid, facility_id, care_plan_id,
  due_at, appointment_id, appointment_status, reason,
  reminder_offsets_minutes, reminder_last_sent_at,
  status, closed_at, closure_outcome, metadata,
  created_by, created_at, updated_at`;

export async function createFollowUp({
  tenantId = null,
  patientUid,
  originKind,
  originResourceType = null,
  originResourceId = null,
  encounterId = null,
  doctorUid = null,
  facilityId = null,
  carePlanId = null,
  dueAt = null,
  reason = null,
  reminderOffsetsMinutes = null,
  metadata = null,
  createdBy = null,
  bookAppointment = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanUid = maybeUuid(patientUid, 'patient_uid', { required: true });
  const cleanOriginKind = normalizeEnum(originKind, FOLLOWUP_ORIGINS, 'origin_kind', { required: true });
  const cleanDoctorUid = maybeUuid(doctorUid, 'doctor_uid');
  const cleanDueAt = normalizeTimestamp(dueAt, 'due_at');
  const cleanMetadata = normalizeJsonObject(metadata, 'metadata');
  const cleanReason = safeText(reason);
  const cleanOriginResourceType = safeText(originResourceType, 60)?.toLowerCase() || null;
  const cleanOriginResourceId = safeText(originResourceId, 120);
  const originAppointmentId = cleanOriginResourceType === 'appointment'
    ? normalizeId(cleanOriginResourceId, 'origin_resource_id')
    : null;
  const wantsAppointment = shouldBookFollowUpAppointment({
    originKind: cleanOriginKind,
    dueAt: cleanDueAt,
    doctorUid: cleanDoctorUid,
    bookAppointment,
  });

  const insertFollowUp = async (db, appointment = null) => {
    const appointmentId = appointment?.id ?? null;
    const rowStatus = appointmentId ? 'scheduled' : 'open';
    const appointmentStatus = appointmentId ? 'scheduled' : 'pending';
    const rowMetadata = appointmentId
      ? {
          ...cleanMetadata,
          auto_booked_appointment: true,
          appointment_id: appointmentId,
          booking_source: 'discharge_follow_up',
        }
      : cleanMetadata;
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO follow_up_plans
         (tenant_id, patient_uid, origin_kind,
          origin_resource_type, origin_resource_id, encounter_id,
          doctor_uid, facility_id, care_plan_id,
          due_at, appointment_id, appointment_status, reason,
          reminder_offsets_minutes, status, metadata, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6,
               $7::uuid, $8, $9, $10::timestamptz, $11::int, $12, $13,
               $14::int[], $15, $16::jsonb, $17::uuid)
       RETURNING ${FOLLOWUP_RETURNING}`,
      tid, cleanUid,
      cleanOriginKind,
      cleanOriginResourceType,
      cleanOriginResourceId,
      encounterId ? normalizeId(encounterId, 'encounter_id') : null,
      cleanDoctorUid,
      facilityId ? normalizeId(facilityId, 'facility_id') : null,
      carePlanId ? normalizeId(carePlanId, 'care_plan_id') : null,
      cleanDueAt,
      appointmentId,
      appointmentStatus,
      cleanReason,
      normalizeIntArray(reminderOffsetsMinutes, 'reminder_offsets_minutes', { min: 1, max: 60 * 24 * 365 }),
      rowStatus,
      JSON.stringify(rowMetadata),
      maybeUuid(createdBy, 'created_by'),
    );
    const followUp = rows[0];
    if (!followUp?.id) {
      throw AppError.internal(
        'Follow-up plan was not recorded',
        'FOLLOW_UP_PLAN_REQUIRED',
      );
    }
    if (originAppointmentId) {
      const child = await publishOpChildResourceLinkedTx(db, {
        tenantId: tid,
        appointmentId: originAppointmentId,
        patientUid: cleanUid,
        resourceType: 'follow_up_plan',
        resourceId: followUp.id,
        source: 'carePlan.createFollowUp',
      });
      const followUpEvent = await publishEvent({
        eventType: 'appointment.follow_up_recorded',
        aggregateType: 'appointment',
        aggregateId: String(originAppointmentId),
        patientUid: cleanUid,
        payload: {
          appointment_id: originAppointmentId,
          appointment_uid: child.linked.appointment_uid,
          patient_uid: cleanUid,
          tenant_id: tid,
          follow_up_plan_id: Number(followUp.id),
          source: 'carePlan.createFollowUp',
        },
        tx: db,
        tenantId: tid,
      });
      if (!followUpEvent) {
        throw AppError.internal(
          'Appointment follow-up event was not recorded',
          'APPOINTMENT_FOLLOW_UP_OUTBOX_REQUIRED',
        );
      }
    }

    // Canonical clinical timeline + audit — atomic with the follow-up write on
    // the same db handle (the caller's tx when passed, else the setTenantTx tx).
    // 'follow-up' is a workflow the canonical-timeline doc names explicitly.
    await emitCarePlanCanonicalEvent(db, {
      tenantId: tid,
      patientUid: cleanUid,
      eventType: 'care_plan.follow_up.created',
      eventStatus: followUp.status,
      sourceTable: 'follow_up_plans',
      sourceId: followUp.id,
      resourceType: 'follow_up_plan',
      actorUid: maybeUuid(createdBy, 'created_by'),
      summary: `Follow-up created (${cleanOriginKind})`,
      payload: {
        follow_up_plan_id: followUp.id,
        origin_kind: cleanOriginKind,
        origin_resource_type: cleanOriginResourceType,
        origin_resource_id: cleanOriginResourceId,
        due_at: cleanDueAt,
        doctor_uid: cleanDoctorUid,
        appointment_id: followUp.appointment_id || null,
        appointment_status: followUp.appointment_status || null,
        care_plan_id: followUp.care_plan_id || null,
        reason: cleanReason,
        status: followUp.status,
      },
      afterState: { status: followUp.status },
      tags: ['care_plan', 'follow_up'],
      keySuffix: 'created',
    });

    return followUp;
  };

  try {
    const createInTransaction = async (db) => {
      if (!wantsAppointment) {
        return insertFollowUp(db);
      }
      const appointment = await reserveFollowUpAppointment({
        db,
        tenantId: tid,
        patientUid: cleanUid,
        doctorUid: cleanDoctorUid,
        dueAt: cleanDueAt,
        reason: cleanReason,
        createdBy: maybeUuid(createdBy, 'created_by'),
      });
      await recordAppointmentCreatedEvidenceTx(db, {
        tenantId: tid,
        appointment: {
          ...appointment,
          patient_uid: cleanUid,
        },
        actorUid: maybeUuid(createdBy, 'created_by'),
        source: 'carePlan.createFollowUp',
      });
      return insertFollowUp(db, appointment);
    };
    if (tx !== null) {
      if (typeof tx?.$queryRawUnsafe !== 'function') {
        throw AppError.internal(
          'Follow-up transaction client is invalid',
          'FOLLOW_UP_TX_REQUIRED',
        );
      }
      return createInTransaction(tx);
    }
    return setTenantTx(tid, createInTransaction);
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function transitionFollowUp({
  tenantId = null, id, nextStatus, closureOutcome = null, appointmentId = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const fId = normalizeId(id, 'follow_up_plan id');
  const cleanStatus = normalizeEnum(nextStatus, FOLLOWUP_STATUSES, 'next_status', { required: true });
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'completed' || cleanStatus === 'cancelled' || cleanStatus === 'lost_to_followup') {
    params.push(new Date().toISOString());
    updates.push(`closed_at = $${params.length}::timestamptz`);
    if (closureOutcome) {
      params.push(safeText(closureOutcome, 60));
      updates.push(`closure_outcome = $${params.length}`);
    }
  }
  if (appointmentId !== null && appointmentId !== undefined) {
    params.push(normalizeId(appointmentId, 'appointment_id'));
    updates.push(`appointment_id = $${params.length}`);
  }
  if (cleanStatus === 'scheduled') {
    params.push('scheduled');
    updates.push(`appointment_status = $${params.length}`);
  }
  params.push(fId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE follow_up_plans SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${FOLLOWUP_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Follow-up plan not found');
  return rows[0];
}

export async function listFollowUps({
  tenantId = null, patientUid = null, status = null, originKind = null,
  doctorUid = null, overdueOnly = false, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (status) {
    params.push(normalizeEnum(status, FOLLOWUP_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (originKind) {
    params.push(normalizeEnum(originKind, FOLLOWUP_ORIGINS, 'origin_kind'));
    filters.push(`origin_kind = $${params.length}`);
  }
  if (doctorUid) {
    params.push(maybeUuid(doctorUid, 'doctor_uid'));
    filters.push(`doctor_uid = $${params.length}::uuid`);
  }
  if (overdueOnly) {
    filters.push(`status = 'open' AND due_at IS NOT NULL AND due_at < NOW()`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${FOLLOWUP_RETURNING} FROM follow_up_plans
       WHERE ${filters.join(' AND ')}
       ORDER BY due_at NULLS LAST, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { follow_ups: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { follow_ups: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// care_plan_review_log
// ---------------------------------------------------------------------------

export async function appendReviewLog({
  tenantId = null,
  carePlanId,
  reviewerUid = null,
  reviewerRole = null,
  eventKind,
  notes = null,
  payload = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(carePlanId, 'care_plan_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO care_plan_review_log
         (tenant_id, care_plan_id, reviewer_uid, reviewer_role,
          event_kind, notes, payload)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb)
       RETURNING id, tenant_id, care_plan_id, reviewer_uid, reviewer_role,
                 event_kind, notes, payload, created_at`,
      tid, planId, maybeUuid(reviewerUid, 'reviewer_uid'),
      safeText(reviewerRole, 80),
      normalizeEnum(eventKind, REVIEW_LOG_KINDS, 'event_kind', { required: true }),
      safeText(notes),
      JSON.stringify(normalizeJsonObject(payload, 'payload')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid care_plan_id');
    throw err;
  }
}

export async function listReviewLog({
  tenantId = null, carePlanId, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(carePlanId, 'care_plan_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, care_plan_id, reviewer_uid, reviewer_role,
              event_kind, notes, payload, created_at
       FROM care_plan_review_log
       WHERE tenant_id = $1::uuid AND care_plan_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      tid, planId, normalizeLimit(limit),
    );
    return { entries: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { entries: [], count: 0 };
    throw err;
  }
}

export async function getPatientWhatsNext({
  tenantId = null,
  patientUid,
  limit = 20,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanUid = maybeUuid(patientUid, 'patient_uid', { required: true });
  const safeLimit = normalizeLimit(limit, 20, 50);
  try {
    const [goalRows, followUpRows, edNextStepRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT
           g.id,
           g.care_plan_id,
           cp.display_name AS care_plan_name,
           cp.plan_kind,
           g.goal_kind,
           g.description,
           g.measurement_label,
           g.measurement_unit,
           g.target_value,
           g.current_value,
           g.target_due_date,
           g.priority,
           g.status,
           g.updated_at
         FROM care_plan_goals g
         JOIN care_plans cp
           ON cp.id = g.care_plan_id
          AND cp.tenant_id = g.tenant_id
        WHERE g.tenant_id = $1::uuid
          AND COALESCE(g.patient_uid, cp.patient_uid) = $2::uuid
          AND cp.status = 'active'
          AND cp.is_patient_visible = TRUE
          AND g.status IN ('planned', 'in_progress', 'on_hold')
        ORDER BY
          CASE g.priority
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            ELSE 3
          END,
          g.target_due_date NULLS LAST,
          g.updated_at DESC
        LIMIT $3::int`,
        tid,
        cleanUid,
        safeLimit,
      ),
      prisma.$queryRawUnsafe(
        `SELECT
           f.id,
           f.care_plan_id,
           cp.display_name AS care_plan_name,
           f.origin_kind,
           f.due_at,
           f.appointment_id,
           f.appointment_status,
           f.reason,
           f.status,
           f.updated_at
         FROM follow_up_plans f
         LEFT JOIN care_plans cp
           ON cp.id = f.care_plan_id
          AND cp.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1::uuid
          AND f.patient_uid = $2::uuid
          AND f.status IN ('open', 'scheduled', 'overdue')
        ORDER BY f.due_at NULLS LAST, f.updated_at DESC
        LIMIT $3::int`,
        tid,
        cleanUid,
        safeLimit,
      ),
      prisma.$queryRawUnsafe(
        `WITH latest_ed_closure AS (
           SELECT DISTINCT ON (evidence.emergency_visit_id)
                  evidence.emergency_visit_id,
                  evidence.closure_kind,
                  evidence.patient_safe_next_steps,
                  evidence.occurred_at,
                  visit.status AS visit_status
             FROM ed_closure_evidence AS evidence
             JOIN emergency_visits AS visit
               ON visit.tenant_id = evidence.tenant_id
              AND visit.id = evidence.emergency_visit_id
              AND visit.patient_uid = evidence.patient_uid
            WHERE evidence.tenant_id = $1::uuid
              AND evidence.patient_uid = $2::uuid
              AND evidence.patient_visibility_status = 'released'
              AND evidence.closure_kind IN (
                'discharge',
                'left_against_medical_advice',
                'lwbs'
              )
            ORDER BY evidence.emergency_visit_id,
                     evidence.evidence_revision DESC
         )
         SELECT step.value ->> 'label' AS label,
                NULLIF(step.value ->> 'explanation', '') AS explanation,
                NULLIF(step.value ->> 'due_date', '') AS due_date,
                COALESCE(NULLIF(step.value ->> 'status', ''), 'planned') AS status,
                NULLIF(step.value ->> 'patient_action', '') AS patient_action,
                NULLIF(
                  step.value ->> 'responsible_clinician_display_name',
                  ''
                ) AS responsible_clinician_display_name,
                NULLIF(
                  step.value ->> 'responsible_clinician_role',
                  ''
                ) AS responsible_clinician_role,
                NULLIF(step.value ->> 'safe_contact', '') AS safe_contact,
                NULLIF(step.value ->> 'route_token', '') AS route_token
           FROM latest_ed_closure AS closure
           CROSS JOIN LATERAL jsonb_array_elements(
             closure.patient_safe_next_steps
           ) WITH ORDINALITY AS step(value, ordering)
          WHERE (
            closure.visit_status = 'discharged'
            AND closure.closure_kind = 'discharge'
          )
          OR (
            closure.visit_status = 'left_against_advice'
            AND closure.closure_kind = 'left_against_medical_advice'
          )
          OR (
            closure.visit_status = 'lwbs'
            AND closure.closure_kind = 'lwbs'
          )
          ORDER BY closure.occurred_at DESC, step.ordering
          LIMIT $3::int`,
        tid,
        cleanUid,
        safeLimit,
      ),
    ]);
    // ED next steps come only from the latest released revision whose live ED
    // terminal state still matches that revision's exact closure branch.
    const nextSteps = edNextStepRows;
    return {
      goals: goalRows,
      follow_ups: followUpRows,
      next_steps: nextSteps,
      count: goalRows.length + followUpRows.length + nextSteps.length,
    };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        goals: [],
        follow_ups: [],
        next_steps: [],
        count: 0,
      };
    }
    throw err;
  }
}

export const __testing__ = {
  PLAN_TRANSITIONS,
  PLAN_KINDS,
  PLAN_STATUSES,
  GOAL_KINDS,
  ACTIVITY_KINDS,
  FOLLOWUP_STATUSES,
};

export default {
  createCarePlan,
  listCarePlans,
  getCarePlanBundle,
  listCarePlanBundlesForPatient,
  getCarePlan,
  transitionCarePlan,
  setCarePlanVisibility,
  createGoal,
  updateGoalProgress,
  listGoals,
  createActivity,
  recordActivityCompletion,
  listActivities,
  createFollowUp,
  transitionFollowUp,
  listFollowUps,
  getPatientWhatsNext,
  appendReviewLog,
  listReviewLog,
};
