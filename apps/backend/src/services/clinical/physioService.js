// src/services/clinical/physioService.js
//
// NL6-11: physiotherapy and rehabilitation foundation.
// Referral intake reuses consultation/discharge follow_up_plans; therapy plans
// reuse care_plans(plan_kind='rehab'); assessment, session, and outcome writes
// emit patient-visible canonical timeline rows in the same transaction.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ASSESSMENT_KINDS = [
  'initial', 'reassessment', 'discharge_readiness', 'functional_capacity', 'other',
];
export const MOBILITY_STATUSES = [
  'not_assessed', 'bed_bound', 'assisted_transfer', 'walker_supported', 'independent', 'restricted',
];
export const SESSION_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled', 'no_show'];
export const SESSION_TYPES = [
  'therapy', 'mobilisation', 'breathing_exercises', 'gait_training', 'post_op_rehab',
  'cardiac_rehab', 'neuro_rehab', 'education', 'discharge_training', 'other',
];
export const SCORE_KINDS = ['functional', 'pain', 'rom', 'gait', 'endurance', 'strength', 'custom'];
const FOLLOW_UP_ORIGINS = ['consultation', 'discharge'];
const ACTIVE_FOLLOW_UP_STATUSES = ['open', 'scheduled', 'overdue'];
const ACTIVE_PLAN_STATUSES = ['draft', 'active', 'on_hold', 'paused'];

const tenantOr = (tenantId) => requireTenantId(tenantId);

function safeText(value, max = null, fallback = null) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return fallback;
  return max ? text.slice(0, max) : text;
}

function jsonObject(value, field = 'metadata') {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${field} must be an object`, 'PHYSIO_JSON_OBJECT_INVALID');
  }
  return value;
}

function cleanUuid(value, field, { required = false } = {}) {
  const text = safeText(value);
  if (!text) {
    if (required) throw AppError.badRequest(`${field} required`, 'PHYSIO_UUID_REQUIRED');
    return null;
  }
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(`${field} must be a UUID`, 'PHYSIO_UUID_INVALID');
  }
  return text;
}

function cleanId(value, field, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${field} required`, 'PHYSIO_ID_REQUIRED');
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'PHYSIO_ID_INVALID');
  }
  return parsed;
}

function cleanInt(value, field, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    throw AppError.badRequest(`${field} must be an integer`, 'PHYSIO_INTEGER_INVALID');
  }
  if ((min !== null && parsed < min) || (max !== null && parsed > max)) {
    throw AppError.badRequest(`${field} must be between ${min} and ${max}`, 'PHYSIO_INTEGER_RANGE');
  }
  return parsed;
}

function cleanNumber(value, field, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw AppError.badRequest(`${field} must be numeric`, 'PHYSIO_NUMBER_INVALID');
  }
  if ((min !== null && parsed < min) || (max !== null && parsed > max)) {
    throw AppError.badRequest(`${field} must be between ${min} and ${max}`, 'PHYSIO_NUMBER_RANGE');
  }
  return Math.round(parsed * 100) / 100;
}

function cleanTimestamp(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw AppError.badRequest(`${field} must be a valid timestamp`, 'PHYSIO_TIMESTAMP_INVALID');
  }
  return d.toISOString();
}

function cleanDate(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw AppError.badRequest(`${field} must be a valid date`, 'PHYSIO_DATE_INVALID');
  }
  return d.toISOString().slice(0, 10);
}

function normalizeEnum(value, allowed, field, fallback = null) {
  const text = safeText(value);
  if (!text) return fallback;
  const normalized = text.toLowerCase();
  if (!allowed.includes(normalized)) {
    throw AppError.badRequest(`${field} must be one of: ${allowed.join(', ')}`, 'PHYSIO_ENUM_INVALID');
  }
  return normalized;
}

function asPlain(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(asPlain);
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    const isPlainObject = prototype === Object.prototype || prototype === null;
    if (!isPlainObject && typeof value.toString === 'function') {
      const text = value.toString();
      if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asPlain(v)]));
  }
  return value;
}

export function normalizeMeasureEntries(value, field = 'measures') {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${field} must be an array`, 'PHYSIO_MEASURE_ARRAY_REQUIRED');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw AppError.badRequest(`${field}[${index}] must be an object`, 'PHYSIO_MEASURE_OBJECT_REQUIRED');
    }
    const normalized = { ...entry };
    const label = safeText(entry.label || entry.joint || entry.movement || entry.exercise || entry.test, 120);
    if (!label) {
      throw AppError.badRequest(`${field}[${index}] requires label, joint, movement, exercise, or test`, 'PHYSIO_MEASURE_LABEL_REQUIRED');
    }
    normalized.label = label;
    if (entry.degrees !== undefined && entry.degrees !== null && entry.degrees !== '') {
      normalized.degrees = cleanNumber(entry.degrees, `${field}[${index}].degrees`, { min: 0, max: 360 });
    }
    if (entry.pain_score !== undefined && entry.pain_score !== null && entry.pain_score !== '') {
      normalized.pain_score = cleanInt(entry.pain_score, `${field}[${index}].pain_score`, { min: 0, max: 10 });
    }
    if (entry.sets !== undefined && entry.sets !== null && entry.sets !== '') {
      normalized.sets = cleanInt(entry.sets, `${field}[${index}].sets`, { min: 0, max: 200 });
    }
    if (entry.reps !== undefined && entry.reps !== null && entry.reps !== '') {
      normalized.reps = cleanInt(entry.reps, `${field}[${index}].reps`, { min: 0, max: 1000 });
    }
    if (entry.duration_minutes !== undefined && entry.duration_minutes !== null && entry.duration_minutes !== '') {
      normalized.duration_minutes = cleanInt(entry.duration_minutes, `${field}[${index}].duration_minutes`, { min: 0, max: 480 });
    }
    return normalized;
  });
}

function normalizeTextArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${field} must be an array`, 'PHYSIO_TEXT_ARRAY_REQUIRED');
  }
  return value.map((entry, index) => {
    const text = safeText(entry, 240);
    if (!text) {
      throw AppError.badRequest(`${field}[${index}] must not be empty`, 'PHYSIO_TEXT_ARRAY_EMPTY');
    }
    return text;
  });
}

export function computeOutcomeTrend(rows = [], scoreKind = 'functional') {
  const ordered = [...rows]
    .map((row) => ({ ...row, score_value: Number(row.score_value) }))
    .filter((row) => Number.isFinite(row.score_value))
    .sort((a, b) => new Date(a.scored_at).getTime() - new Date(b.scored_at).getTime());
  if (!ordered.length) {
    return {
      score_kind: scoreKind,
      count: 0,
      first_score: null,
      latest_score: null,
      change: null,
      direction: 'insufficient_data',
      points: [],
    };
  }
  const first = ordered[0].score_value;
  const latest = ordered[ordered.length - 1].score_value;
  const change = Math.round((latest - first) * 100) / 100;
  const improved = scoreKind === 'pain' ? change < 0 : change > 0;
  const declined = scoreKind === 'pain' ? change > 0 : change < 0;
  return {
    score_kind: scoreKind,
    count: ordered.length,
    first_score: first,
    latest_score: latest,
    change,
    direction: improved ? 'improved' : declined ? 'declined' : 'unchanged',
    points: ordered.map((row) => ({
      id: row.id,
      score_value: row.score_value,
      score_label: row.score_label,
      score_unit: row.score_unit,
      scored_at: row.scored_at,
      session_id: row.session_id,
      assessment_id: row.assessment_id,
    })),
  };
}

async function assertPatient(db, tenantId, patientUid) {
  const uid = cleanUuid(patientUid, 'patient_uid', { required: true });
  const rows = await db.$queryRawUnsafe(
    `SELECT uid, name
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    uid,
  );
  if (!rows[0]) throw AppError.notFound('Patient not found', 'PHYSIO_PATIENT_NOT_FOUND');
  return rows[0];
}

async function getFollowUp(db, tenantId, followUpPlanId, patientUid = null) {
  const id = cleanId(followUpPlanId, 'follow_up_plan_id', { required: true });
  const rows = await db.$queryRawUnsafe(
    `SELECT id, patient_uid, origin_kind, origin_resource_type, origin_resource_id,
            encounter_id, care_plan_id, due_at, reason, status, metadata
       FROM follow_up_plans
      WHERE id = $1
        AND tenant_id = $2::uuid
      LIMIT 1`,
    id,
    tenantOr(tenantId),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Follow-up plan not found', 'PHYSIO_FOLLOW_UP_NOT_FOUND');
  if (!FOLLOW_UP_ORIGINS.includes(row.origin_kind)) {
    throw AppError.badRequest('Physio referral intake must originate from consultation or discharge follow-up', 'PHYSIO_FOLLOW_UP_ORIGIN_INVALID');
  }
  if (patientUid && String(row.patient_uid) !== String(patientUid)) {
    throw AppError.badRequest('Follow-up plan belongs to a different patient', 'PHYSIO_FOLLOW_UP_PATIENT_MISMATCH');
  }
  return asPlain(row);
}

async function getRehabCarePlan(db, tenantId, carePlanId, patientUid = null) {
  const id = cleanId(carePlanId, 'care_plan_id', { required: true });
  const rows = await db.$queryRawUnsafe(
    `SELECT id, patient_uid, display_name, status, plan_kind, encounter_id, metadata
       FROM care_plans
      WHERE id = $1
        AND tenant_id = $2::uuid
      LIMIT 1`,
    id,
    tenantOr(tenantId),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Care plan not found', 'PHYSIO_CARE_PLAN_NOT_FOUND');
  if (row.plan_kind !== 'rehab') {
    throw AppError.badRequest('care_plan_id must reference a rehab care plan', 'PHYSIO_CARE_PLAN_KIND_INVALID');
  }
  if (patientUid && String(row.patient_uid) !== String(patientUid)) {
    throw AppError.badRequest('Care plan belongs to a different patient', 'PHYSIO_CARE_PLAN_PATIENT_MISMATCH');
  }
  return asPlain(row);
}

async function getAssessment(db, tenantId, assessmentId, patientUid = null) {
  const id = cleanId(assessmentId, 'assessment_id', { required: true });
  const rows = await db.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, follow_up_plan_id, care_plan_id, baseline_outcome_score
       FROM physio_assessments
      WHERE id = $1
        AND tenant_id = $2::uuid
      LIMIT 1`,
    id,
    tenantOr(tenantId),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Physio assessment not found', 'PHYSIO_ASSESSMENT_NOT_FOUND');
  if (patientUid && String(row.patient_uid) !== String(patientUid)) {
    throw AppError.badRequest('Assessment belongs to a different patient', 'PHYSIO_ASSESSMENT_PATIENT_MISMATCH');
  }
  return asPlain(row);
}

export async function createAssessment(input = {}, actor = {}) {
  const tenantId = tenantOr(input.tenantId);
  const patientUid = cleanUuid(input.patientUid || input.patient_uid, 'patient_uid', { required: true });
  const followUpPlanId = cleanId(input.followUpPlanId || input.follow_up_plan_id, 'follow_up_plan_id');
  const carePlanId = cleanId(input.carePlanId || input.care_plan_id, 'care_plan_id');
  const encounterId = cleanId(input.encounterId || input.encounter_id, 'encounter_id');
  const assessmentKind = normalizeEnum(input.assessmentKind || input.assessment_kind, ASSESSMENT_KINDS, 'assessment_kind', 'initial');
  const mobilityStatus = normalizeEnum(input.mobilityStatus || input.mobility_status, MOBILITY_STATUSES, 'mobility_status', 'not_assessed');
  const painScore = cleanInt(input.painScore ?? input.pain_score, 'pain_score', { min: 0, max: 10 });
  const baselineOutcomeScore = cleanNumber(input.baselineOutcomeScore ?? input.baseline_outcome_score, 'baseline_outcome_score', { min: 0, max: 100 });
  const assessedAt = cleanTimestamp(input.assessedAt || input.assessed_at, 'assessed_at');
  const metadata = jsonObject(input.metadata, 'metadata');

  await assertPatient(prisma, tenantId, patientUid);
  if (followUpPlanId) await getFollowUp(prisma, tenantId, followUpPlanId, patientUid);
  if (carePlanId) await getRehabCarePlan(prisma, tenantId, carePlanId, patientUid);

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO physio_assessments
         (tenant_id, patient_uid, encounter_id, follow_up_plan_id, referral_id, care_plan_id,
          assessment_kind, mobility_status, pain_score, rom_measures, strength_measures,
          functional_limitations, precautions, goals_text, baseline_outcome_score,
          notes, metadata, assessed_by, assessed_at)
       VALUES
         ($1::uuid, $2::uuid, $3, $4, $5, $6,
          $7, $8, $9, $10::jsonb, $11::jsonb,
          $12::jsonb, $13, $14, $15,
          $16, $17::jsonb, $18::uuid, COALESCE($19::timestamptz, NOW()))
       RETURNING *`,
      tenantId,
      patientUid,
      encounterId,
      followUpPlanId,
      cleanId(input.referralId || input.referral_id, 'referral_id'),
      carePlanId,
      assessmentKind,
      mobilityStatus,
      painScore,
      JSON.stringify(normalizeMeasureEntries(input.romMeasures || input.rom_measures, 'rom_measures')),
      JSON.stringify(normalizeMeasureEntries(input.strengthMeasures || input.strength_measures, 'strength_measures')),
      JSON.stringify(normalizeTextArray(input.functionalLimitations || input.functional_limitations, 'functional_limitations')),
      safeText(input.precautions),
      safeText(input.goalsText || input.goals_text),
      baselineOutcomeScore,
      safeText(input.notes),
      JSON.stringify(metadata),
      cleanUuid(actor.actorUid, 'actor_uid'),
      assessedAt,
    );
    const assessment = asPlain(rows[0]);

    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType: 'physio.assessment_recorded',
      sourceTable: 'physio_assessments',
      sourceId: String(assessment.id),
      resourceTable: 'physio_assessments',
      resourceId: String(assessment.id),
      actorUid: actor.actorUid || null,
      actorRole: actor.actorRole || null,
      summary: `Physiotherapy assessment recorded${painScore !== null ? `; pain ${painScore}/10` : ''}`,
      visibleToPatient: true,
      payload: {
        assessment_kind: assessmentKind,
        mobility_status: mobilityStatus,
        pain_score: painScore,
        follow_up_plan_id: followUpPlanId,
        care_plan_id: carePlanId,
      },
    }, { db: tx });

    return assessment;
  });
}

export async function createTherapyPlan(input = {}, actor = {}) {
  const tenantId = tenantOr(input.tenantId);
  const patientUid = cleanUuid(input.patientUid || input.patient_uid, 'patient_uid', { required: true });
  const followUpPlanId = cleanId(input.followUpPlanId || input.follow_up_plan_id, 'follow_up_plan_id');
  const assessmentId = cleanId(input.assessmentId || input.assessment_id, 'assessment_id');
  const startDate = cleanDate(input.startDate || input.start_date, 'start_date');
  const targetEndDate = cleanDate(input.targetEndDate || input.target_end_date, 'target_end_date');
  const status = normalizeEnum(input.status, ['draft', 'active'], 'status', 'active');
  const displayName = safeText(input.displayName || input.display_name, 255, 'Physiotherapy rehabilitation plan');
  const metadata = jsonObject(input.metadata, 'metadata');

  await assertPatient(prisma, tenantId, patientUid);
  const followUp = followUpPlanId ? await getFollowUp(prisma, tenantId, followUpPlanId, patientUid) : null;
  const assessment = assessmentId ? await getAssessment(prisma, tenantId, assessmentId, patientUid) : null;
  const encounterId = cleanId(input.encounterId || input.encounter_id || assessment?.encounter_id || followUp?.encounter_id, 'encounter_id');

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO care_plans
         (tenant_id, patient_uid, plan_kind, primary_condition, primary_condition_icd10,
          display_name, description, status, start_date, target_end_date,
          primary_doctor_uid, care_team_role, encounter_id, is_patient_visible,
          metadata, created_by)
       VALUES
         ($1::uuid, $2::uuid, 'rehab', $3, $4,
          $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9::date,
          $10::uuid, 'PHYSIOTHERAPIST', $11, TRUE,
          $12::jsonb, $13::uuid)
       RETURNING *`,
      tenantId,
      patientUid,
      safeText(input.primaryCondition || input.primary_condition, 255, 'Physiotherapy rehabilitation'),
      safeText(input.primaryConditionIcd10 || input.primary_condition_icd10, 20),
      displayName,
      safeText(input.description),
      status,
      startDate,
      targetEndDate,
      cleanUuid(input.primaryDoctorUid || input.primary_doctor_uid || actor.actorUid, 'primary_doctor_uid'),
      encounterId,
      JSON.stringify({
        ...metadata,
        physio_assessment_id: assessmentId,
        follow_up_plan_id: followUpPlanId,
        referral_id: cleanId(input.referralId || input.referral_id, 'referral_id'),
        goal_summary: safeText(input.goalSummary || input.goal_summary),
      }),
      cleanUuid(actor.actorUid, 'actor_uid'),
    );
    const plan = asPlain(rows[0]);

    await tx.$queryRawUnsafe(
      `INSERT INTO care_plan_review_log
         (tenant_id, care_plan_id, reviewer_uid, reviewer_role, event_kind, notes, payload)
       VALUES ($1::uuid, $2, $3::uuid, $4, 'created', $5, $6::jsonb)`,
      tenantId,
      plan.id,
      cleanUuid(actor.actorUid, 'actor_uid'),
      safeText(actor.actorRole, 80),
      'Physiotherapy rehab plan started',
      JSON.stringify({ source: 'physio', assessment_id: assessmentId, follow_up_plan_id: followUpPlanId }),
    );

    if (assessmentId) {
      await tx.$queryRawUnsafe(
        `UPDATE physio_assessments
            SET care_plan_id = $1, updated_at = NOW()
          WHERE id = $2
            AND tenant_id = $3::uuid`,
        plan.id,
        assessmentId,
        tenantId,
      );
    }
    if (followUpPlanId) {
      await tx.$queryRawUnsafe(
        `UPDATE follow_up_plans
            SET care_plan_id = $1, updated_at = NOW()
          WHERE id = $2
            AND tenant_id = $3::uuid`,
        plan.id,
        followUpPlanId,
        tenantId,
      );
    }

    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType: 'physio.therapy_plan_started',
      sourceTable: 'care_plans',
      sourceId: String(plan.id),
      resourceTable: 'care_plans',
      resourceId: String(plan.id),
      actorUid: actor.actorUid || null,
      actorRole: actor.actorRole || null,
      summary: `Physiotherapy rehab plan started: ${plan.display_name}`,
      visibleToPatient: true,
      payload: {
        care_plan_id: plan.id,
        assessment_id: assessmentId,
        follow_up_plan_id: followUpPlanId,
      },
    }, { db: tx });

    return plan;
  });
}

export async function recordSession(input = {}, actor = {}) {
  const tenantId = tenantOr(input.tenantId);
  const carePlanId = cleanId(input.carePlanId || input.care_plan_id, 'care_plan_id', { required: true });
  const sessionStatus = normalizeEnum(input.sessionStatus || input.session_status, SESSION_STATUSES, 'session_status', 'completed');
  const sessionType = normalizeEnum(input.sessionType || input.session_type, SESSION_TYPES, 'session_type', 'therapy');
  const plan = await getRehabCarePlan(prisma, tenantId, carePlanId);
  const patientUid = cleanUuid(input.patientUid || input.patient_uid || plan.patient_uid, 'patient_uid', { required: true });
  if (String(plan.patient_uid) !== String(patientUid)) {
    throw AppError.badRequest('Session patient does not match rehab care plan', 'PHYSIO_SESSION_PATIENT_MISMATCH');
  }
  await assertPatient(prisma, tenantId, patientUid);
  const assessmentId = cleanId(input.assessmentId || input.assessment_id, 'assessment_id');
  const followUpPlanId = cleanId(input.followUpPlanId || input.follow_up_plan_id, 'follow_up_plan_id');
  if (assessmentId) await getAssessment(prisma, tenantId, assessmentId, patientUid);
  if (followUpPlanId) await getFollowUp(prisma, tenantId, followUpPlanId, patientUid);
  const outcomeScore = cleanNumber(input.outcomeScore ?? input.outcome_score, 'outcome_score', { min: 0, max: 100 });
  const completedAt = cleanTimestamp(input.completedAt || input.completed_at, 'completed_at')
    || (sessionStatus === 'completed' ? new Date().toISOString() : null);

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO physio_sessions
         (tenant_id, patient_uid, care_plan_id, assessment_id, follow_up_plan_id,
          session_status, session_type, scheduled_for, started_at, completed_at,
          therapist_uid, duration_minutes, pain_score_before, pain_score_after,
          rom_entries, exercise_entries, gait_balance_entries, assistive_device,
          response_to_treatment, home_program, next_steps, outcome_score, notes, metadata)
       VALUES
         ($1::uuid, $2::uuid, $3, $4, $5,
          $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz,
          $11::uuid, $12, $13, $14,
          $15::jsonb, $16::jsonb, $17::jsonb, $18,
          $19, $20, $21, $22, $23, $24::jsonb)
       RETURNING *`,
      tenantId,
      patientUid,
      carePlanId,
      assessmentId,
      followUpPlanId,
      sessionStatus,
      sessionType,
      cleanTimestamp(input.scheduledFor || input.scheduled_for, 'scheduled_for'),
      cleanTimestamp(input.startedAt || input.started_at, 'started_at'),
      completedAt,
      cleanUuid(input.therapistUid || input.therapist_uid || actor.actorUid, 'therapist_uid'),
      cleanInt(input.durationMinutes ?? input.duration_minutes, 'duration_minutes', { min: 1, max: 480 }),
      cleanInt(input.painScoreBefore ?? input.pain_score_before, 'pain_score_before', { min: 0, max: 10 }),
      cleanInt(input.painScoreAfter ?? input.pain_score_after, 'pain_score_after', { min: 0, max: 10 }),
      JSON.stringify(normalizeMeasureEntries(input.romEntries || input.rom_entries, 'rom_entries')),
      JSON.stringify(normalizeMeasureEntries(input.exerciseEntries || input.exercise_entries, 'exercise_entries')),
      JSON.stringify(normalizeMeasureEntries(input.gaitBalanceEntries || input.gait_balance_entries, 'gait_balance_entries')),
      safeText(input.assistiveDevice || input.assistive_device, 120),
      safeText(input.responseToTreatment || input.response_to_treatment),
      safeText(input.homeProgram || input.home_program),
      safeText(input.nextSteps || input.next_steps),
      outcomeScore,
      safeText(input.notes),
      JSON.stringify(jsonObject(input.metadata, 'metadata')),
    );
    const session = asPlain(rows[0]);

    let outcome = null;
    if (outcomeScore !== null) {
      const outcomeRows = await tx.$queryRawUnsafe(
        `INSERT INTO physio_outcome_scores
           (tenant_id, patient_uid, care_plan_id, assessment_id, session_id,
            score_kind, score_label, score_value, score_unit, recorded_by, metadata)
         VALUES
           ($1::uuid, $2::uuid, $3, $4, $5,
            'functional', 'Session outcome score', $6, 'score', $7::uuid, $8::jsonb)
         RETURNING *`,
        tenantId,
        patientUid,
        carePlanId,
        assessmentId,
        session.id,
        outcomeScore,
        cleanUuid(actor.actorUid, 'actor_uid'),
        JSON.stringify({ source: 'physio_session' }),
      );
      outcome = asPlain(outcomeRows[0]);
    }

    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType: sessionStatus === 'completed' ? 'physio.session_completed' : 'physio.session_recorded',
      sourceTable: 'physio_sessions',
      sourceId: String(session.id),
      resourceTable: 'physio_sessions',
      resourceId: String(session.id),
      actorUid: actor.actorUid || null,
      actorRole: actor.actorRole || null,
      summary: `Physiotherapy session ${sessionStatus}${outcomeScore !== null ? `; outcome ${outcomeScore}` : ''}`,
      visibleToPatient: true,
      payload: {
        care_plan_id: carePlanId,
        assessment_id: assessmentId,
        follow_up_plan_id: followUpPlanId,
        outcome_score: outcomeScore,
      },
    }, { db: tx });

    return { session, outcome };
  });
}

export async function recordOutcomeScore(input = {}, actor = {}) {
  const tenantId = tenantOr(input.tenantId);
  const carePlanId = cleanId(input.carePlanId || input.care_plan_id, 'care_plan_id', { required: true });
  const plan = await getRehabCarePlan(prisma, tenantId, carePlanId);
  const patientUid = cleanUuid(input.patientUid || input.patient_uid || plan.patient_uid, 'patient_uid', { required: true });
  if (String(plan.patient_uid) !== String(patientUid)) {
    throw AppError.badRequest('Outcome patient does not match rehab care plan', 'PHYSIO_OUTCOME_PATIENT_MISMATCH');
  }
  const scoreKind = normalizeEnum(input.scoreKind || input.score_kind, SCORE_KINDS, 'score_kind', 'functional');
  const scoreValue = cleanNumber(input.scoreValue ?? input.score_value, 'score_value', {
    min: 0,
    max: scoreKind === 'pain' ? 10 : scoreKind === 'custom' ? null : 100,
  });
  if (scoreValue === null) throw AppError.badRequest('score_value required', 'PHYSIO_SCORE_REQUIRED');
  const assessmentId = cleanId(input.assessmentId || input.assessment_id, 'assessment_id');
  const sessionId = cleanId(input.sessionId || input.session_id, 'session_id');
  if (assessmentId) await getAssessment(prisma, tenantId, assessmentId, patientUid);

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO physio_outcome_scores
         (tenant_id, patient_uid, care_plan_id, assessment_id, session_id,
          score_kind, score_label, score_value, score_unit, scored_at,
          recorded_by, notes, metadata)
       VALUES
         ($1::uuid, $2::uuid, $3, $4, $5,
          $6, $7, $8, $9, COALESCE($10::timestamptz, NOW()),
          $11::uuid, $12, $13::jsonb)
       RETURNING *`,
      tenantId,
      patientUid,
      carePlanId,
      assessmentId,
      sessionId,
      scoreKind,
      safeText(input.scoreLabel || input.score_label, 160, scoreKind === 'pain' ? 'Pain score' : 'Functional outcome score'),
      scoreValue,
      safeText(input.scoreUnit || input.score_unit, 40, scoreKind === 'pain' ? '0-10' : 'score'),
      cleanTimestamp(input.scoredAt || input.scored_at, 'scored_at'),
      cleanUuid(actor.actorUid, 'actor_uid'),
      safeText(input.notes),
      JSON.stringify(jsonObject(input.metadata, 'metadata')),
    );
    const outcome = asPlain(rows[0]);

    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType: 'physio.outcome_score_recorded',
      sourceTable: 'physio_outcome_scores',
      sourceId: String(outcome.id),
      resourceTable: 'physio_outcome_scores',
      resourceId: String(outcome.id),
      actorUid: actor.actorUid || null,
      actorRole: actor.actorRole || null,
      summary: `Physiotherapy outcome recorded: ${outcome.score_label} ${outcome.score_value}`,
      visibleToPatient: true,
      payload: {
        care_plan_id: carePlanId,
        assessment_id: assessmentId,
        session_id: sessionId,
        score_kind: scoreKind,
        score_value: scoreValue,
      },
    }, { db: tx });

    return outcome;
  });
}

export async function getOutcomeTrend({ tenantId, carePlanId, patientUid = null, scoreKind = 'functional', limit = 100 } = {}) {
  const tid = tenantOr(tenantId);
  const plan = await getRehabCarePlan(prisma, tid, carePlanId, patientUid);
  const cleanKind = normalizeEnum(scoreKind, SCORE_KINDS, 'score_kind', 'functional');
  const safeLimit = Math.max(1, Math.min(cleanInt(limit, 'limit') || 100, 500));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, score_label, score_value, score_unit, scored_at, assessment_id, session_id
       FROM physio_outcome_scores
      WHERE tenant_id = $1::uuid
        AND care_plan_id = $2
        AND score_kind = $3
      ORDER BY scored_at ASC, id ASC
      LIMIT $4`,
    tid,
    plan.id,
    cleanKind,
    safeLimit,
  );
  return computeOutcomeTrend(asPlain(rows), cleanKind);
}

export async function listWorklist({ tenantId, limit = 50 } = {}) {
  const tid = tenantOr(tenantId);
  const safeLimit = Math.max(1, Math.min(cleanInt(limit, 'limit') || 50, 200));
  const rows = await prisma.$queryRawUnsafe(
    `WITH follow_up_work AS (
       SELECT
         f.id AS follow_up_plan_id,
         f.patient_uid,
         u.name AS patient_name,
         f.origin_kind,
         f.origin_resource_type,
         f.origin_resource_id,
         f.due_at,
         f.status AS follow_up_status,
         f.reason,
         cp.id AS care_plan_id,
         cp.display_name AS care_plan_name,
         a.id AS latest_assessment_id,
         s.id AS latest_session_id,
         s.session_status AS latest_session_status,
         o.score_value AS latest_outcome_score,
         'follow_up' AS source_kind
       FROM follow_up_plans f
       JOIN users u
         ON u.tenant_id = f.tenant_id
        AND u.uid = f.patient_uid
       LEFT JOIN care_plans cp
         ON cp.tenant_id = f.tenant_id
        AND cp.id = f.care_plan_id
       LEFT JOIN LATERAL (
         SELECT id
           FROM physio_assessments pa
          WHERE pa.tenant_id = f.tenant_id
            AND pa.follow_up_plan_id = f.id
          ORDER BY pa.assessed_at DESC, pa.id DESC
          LIMIT 1
       ) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, session_status
           FROM physio_sessions ps
          WHERE ps.tenant_id = f.tenant_id
            AND (ps.follow_up_plan_id = f.id OR ps.care_plan_id = f.care_plan_id)
          ORDER BY ps.created_at DESC, ps.id DESC
          LIMIT 1
       ) s ON TRUE
       LEFT JOIN LATERAL (
         SELECT score_value
           FROM physio_outcome_scores po
          WHERE po.tenant_id = f.tenant_id
            AND po.care_plan_id = f.care_plan_id
          ORDER BY po.scored_at DESC, po.id DESC
          LIMIT 1
       ) o ON TRUE
       WHERE f.tenant_id = $1::uuid
         AND f.status = ANY($2::text[])
         AND f.origin_kind = ANY($3::text[])
         AND (
           cp.plan_kind = 'rehab'
           OR LOWER(COALESCE(f.reason, '')) LIKE '%physio%'
           OR LOWER(COALESCE(f.metadata::text, '')) LIKE '%physio%'
           OR LOWER(COALESCE(f.metadata::text, '')) LIKE '%rehab%'
         )
     ),
     plan_work AS (
       SELECT
         NULL::integer AS follow_up_plan_id,
         cp.patient_uid,
         u.name AS patient_name,
         'manual'::text AS origin_kind,
         'care_plans'::text AS origin_resource_type,
         cp.id::text AS origin_resource_id,
         NULL::timestamptz AS due_at,
         cp.status AS follow_up_status,
         cp.description AS reason,
         cp.id AS care_plan_id,
         cp.display_name AS care_plan_name,
         a.id AS latest_assessment_id,
         s.id AS latest_session_id,
         s.session_status AS latest_session_status,
         o.score_value AS latest_outcome_score,
         'care_plan' AS source_kind
       FROM care_plans cp
       JOIN users u
         ON u.tenant_id = cp.tenant_id
        AND u.uid = cp.patient_uid
       LEFT JOIN LATERAL (
         SELECT id
           FROM physio_assessments pa
          WHERE pa.tenant_id = cp.tenant_id
            AND pa.care_plan_id = cp.id
          ORDER BY pa.assessed_at DESC, pa.id DESC
          LIMIT 1
       ) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, session_status
           FROM physio_sessions ps
          WHERE ps.tenant_id = cp.tenant_id
            AND ps.care_plan_id = cp.id
          ORDER BY ps.created_at DESC, ps.id DESC
          LIMIT 1
       ) s ON TRUE
       LEFT JOIN LATERAL (
         SELECT score_value
           FROM physio_outcome_scores po
          WHERE po.tenant_id = cp.tenant_id
            AND po.care_plan_id = cp.id
          ORDER BY po.scored_at DESC, po.id DESC
          LIMIT 1
       ) o ON TRUE
       WHERE cp.tenant_id = $1::uuid
         AND cp.plan_kind = 'rehab'
         AND cp.status = ANY($4::text[])
         AND NOT EXISTS (
           SELECT 1
             FROM follow_up_plans f
            WHERE f.tenant_id = cp.tenant_id
              AND f.care_plan_id = cp.id
         )
     )
     SELECT *
       FROM (
         SELECT * FROM follow_up_work
         UNION ALL
         SELECT * FROM plan_work
       ) w
      ORDER BY due_at NULLS LAST, patient_name, care_plan_id NULLS LAST
      LIMIT $5`,
    tid,
    ACTIVE_FOLLOW_UP_STATUSES,
    FOLLOW_UP_ORIGINS,
    ACTIVE_PLAN_STATUSES,
    safeLimit,
  );
  return { items: asPlain(rows), count: rows.length };
}

export async function getPatientSummary({ tenantId, patientUid } = {}) {
  const tid = tenantOr(tenantId);
  const uid = cleanUuid(patientUid, 'patient_uid', { required: true });
  await assertPatient(prisma, tid, uid);
  const [assessments, sessions, outcomes] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT * FROM physio_assessments
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        ORDER BY assessed_at DESC, id DESC
        LIMIT 10`,
      tid,
      uid,
    ),
    prisma.$queryRawUnsafe(
      `SELECT * FROM physio_sessions
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT 20`,
      tid,
      uid,
    ),
    prisma.$queryRawUnsafe(
      `SELECT * FROM physio_outcome_scores
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        ORDER BY scored_at DESC, id DESC
        LIMIT 20`,
      tid,
      uid,
    ),
  ]);
  return {
    patient_uid: uid,
    assessments: asPlain(assessments),
    sessions: asPlain(sessions),
    outcomes: asPlain(outcomes),
  };
}

export async function getAdminProgress({ tenantId, status = null, limit = 50 } = {}) {
  const tid = tenantOr(tenantId);
  const safeLimit = Math.max(1, Math.min(cleanInt(limit, 'limit') || 50, 200));
  const cleanStatus = status ? safeText(status, 30) : null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       cp.id AS care_plan_id,
       cp.patient_uid,
       u.name AS patient_name,
       cp.display_name,
       cp.status,
       cp.start_date,
       cp.target_end_date,
       cp.created_at,
       COALESCE(a.assessment_count, 0)::int AS assessment_count,
       COALESCE(s.session_count, 0)::int AS session_count,
       COALESCE(s.completed_session_count, 0)::int AS completed_session_count,
       o.score_value AS latest_outcome_score,
       o.score_kind AS latest_outcome_kind,
       o.scored_at AS latest_outcome_at
     FROM care_plans cp
     JOIN users u
       ON u.tenant_id = cp.tenant_id
      AND u.uid = cp.patient_uid
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS assessment_count
         FROM physio_assessments pa
        WHERE pa.tenant_id = cp.tenant_id
          AND pa.care_plan_id = cp.id
     ) a ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS session_count,
              COUNT(*) FILTER (WHERE session_status = 'completed') AS completed_session_count
         FROM physio_sessions ps
        WHERE ps.tenant_id = cp.tenant_id
          AND ps.care_plan_id = cp.id
     ) s ON TRUE
     LEFT JOIN LATERAL (
       SELECT score_value, score_kind, scored_at
         FROM physio_outcome_scores po
        WHERE po.tenant_id = cp.tenant_id
          AND po.care_plan_id = cp.id
        ORDER BY po.scored_at DESC, po.id DESC
        LIMIT 1
     ) o ON TRUE
     WHERE cp.tenant_id = $1::uuid
       AND cp.plan_kind = 'rehab'
       AND ($2::text IS NULL OR cp.status = $2)
     ORDER BY cp.updated_at DESC, cp.id DESC
     LIMIT $3`,
    tid,
    cleanStatus,
    safeLimit,
  );
  return { plans: asPlain(rows), count: rows.length };
}

export const _internal = {
  normalizeMeasureEntries,
  computeOutcomeTrend,
};
