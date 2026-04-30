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

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

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
  return options.tenantId || DEFAULT_TENANT_ID;
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

  try {
    const rows = await prisma.$queryRawUnsafe(
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
      maybeUuid(createdBy, 'created_by'),
    );
    const plan = rows[0];

    // Append a 'created' review-log row best-effort.
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO care_plan_review_log
           (tenant_id, care_plan_id, reviewer_uid, event_kind, notes, payload)
         VALUES ($1::uuid, $2, $3::uuid, 'created', $4, $5::jsonb)`,
        tid, plan.id, maybeUuid(createdBy, 'created_by'),
        cleanName, JSON.stringify({ plan_kind: plan.plan_kind, status: plan.status }),
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
    return plan;
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

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE care_plans SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${PLAN_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Care plan not found');

  // Log the event.
  try {
    const eventKind = (() => {
      if (cleanNext === 'paused') return 'paused';
      if (cleanNext === 'active' && current.status === 'paused') return 'resumed';
      if (cleanNext === 'completed') return 'completed';
      if (cleanNext === 'cancelled') return 'cancelled';
      if (cleanNext === 'superseded') return 'superseded';
      return 'updated';
    })();
    await prisma.$queryRawUnsafe(
      `INSERT INTO care_plan_review_log
         (tenant_id, care_plan_id, reviewer_uid, event_kind, notes, payload)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb)`,
      tid, planId,
      maybeUuid(reviewerUid, 'reviewer_uid'),
      eventKind,
      safeText(notes),
      JSON.stringify({ from: current.status, to: cleanNext }),
    );
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }
  return rows[0];
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
    const rows = await prisma.$queryRawUnsafe(
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
    return rows[0];
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
    const rows = await prisma.$queryRawUnsafe(
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
    return rows[0];
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
     SET status = $1,
         completion_count = completion_count + (CASE WHEN $2 AND $1 = 'completed' THEN 1 ELSE 0 END),
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
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanUid = maybeUuid(patientUid, 'patient_uid', { required: true });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO follow_up_plans
         (tenant_id, patient_uid, origin_kind,
          origin_resource_type, origin_resource_id, encounter_id,
          doctor_uid, facility_id, care_plan_id,
          due_at, appointment_status, reason,
          reminder_offsets_minutes, status, metadata, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6,
               $7::uuid, $8, $9, $10::timestamptz, 'pending', $11,
               $12::int[], 'open', $13::jsonb, $14::uuid)
       RETURNING ${FOLLOWUP_RETURNING}`,
      tid, cleanUid,
      normalizeEnum(originKind, FOLLOWUP_ORIGINS, 'origin_kind', { required: true }),
      safeText(originResourceType, 60),
      safeText(originResourceId, 120),
      encounterId ? normalizeId(encounterId, 'encounter_id') : null,
      maybeUuid(doctorUid, 'doctor_uid'),
      facilityId ? normalizeId(facilityId, 'facility_id') : null,
      carePlanId ? normalizeId(carePlanId, 'care_plan_id') : null,
      normalizeTimestamp(dueAt, 'due_at'),
      safeText(reason),
      normalizeIntArray(reminderOffsetsMinutes, 'reminder_offsets_minutes', { min: 1, max: 60 * 24 * 365 }),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
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
  appendReviewLog,
  listReviewLog,
};
