/**
 * Clinical assessment service (Phase F2).
 *
 * Three first-class clinical assessment surfaces:
 *   - pain_assessments        (NRS / Wong-Baker FACES / FLACC / PAINAD / VAS)
 *   - fall_risk_assessments   (Morse / Hendrich II / Johns Hopkins / STRATIFY / Humpty Dumpty)
 *   - growth_charts           (WHO 0-5 / IAP 5-18 / CDC 2-20 / Fenton)
 *
 * Migration 131.
 *
 * Each assessment is append-only — corrections are new rows, not
 * mutations. Listing returns most-recent-first per patient.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const PAIN_SCALES = ['NRS', 'WONG_BAKER_FACES', 'FLACC', 'PAINAD', 'VAS'];
export const PAIN_CONTEXTS = ['rest', 'movement', 'on_pressure', 'with_breathing'];
export const FALL_SCALES = ['MORSE', 'HENDRICH_II', 'JOHNS_HOPKINS', 'STRATIFY', 'HUMPTY_DUMPTY'];
export const FALL_RISK_LEVELS = ['low', 'medium', 'high', 'very_high'];
export const GROWTH_DATASETS = ['WHO_0_5', 'IAP_5_18', 'CDC_2_20', 'FENTON'];
export const GROWTH_CLASSIFICATIONS = [
  'normal', 'overweight', 'obesity', 'stunting', 'wasting',
  'moderate_acute_malnutrition', 'severe_acute_malnutrition',
];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function requireUuid(value, label) {
  const out = maybeUuid(value, label);
  if (!out) throw AppError.badRequest(`${label} is required`);
  return out;
}

function normalizeId(value, label = 'id') {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
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

function normalizeJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON array`);
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

function normalizeNumber(value, label, { min = null, max = null, required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Pain assessments
// ---------------------------------------------------------------------------

const PAIN_RETURNING = `id, tenant_id, patient_uid, encounter_id,
  scale, score, location, character, context, interventions, notes,
  recorded_by, recorded_at, metadata, created_at, updated_at`;

export async function recordPainAssessment({
  tenantId = null, patientUid, encounterId = null,
  scale, score, location = null, characterStr = null, context = null,
  interventions = null, notes = null,
  recordedBy = null, recordedAt = null, metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanScale = normalizeEnum(scale, PAIN_SCALES, 'scale', { required: true });
  const cleanScore = normalizeNumber(score, 'score', { min: 0, max: 10, required: true });
  const cleanContext = normalizeEnum(context, PAIN_CONTEXTS, 'context');
  const recordedAtIso = recordedAt ? new Date(String(recordedAt)).toISOString() : null;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pain_assessments
       (tenant_id, patient_uid, encounter_id, scale, score, location,
        character, context, interventions, notes, recorded_by, recorded_at, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::uuid, COALESCE($12::timestamptz, NOW()), $13::jsonb)
     RETURNING ${PAIN_RETURNING}`,
    tid, requireUuid(patientUid, 'patient_uid'),
    normalizeId(encounterId, 'encounter_id'),
    cleanScale, cleanScore, safeText(location, SHORT_MAX), safeText(characterStr, 80),
    cleanContext,
    JSON.stringify(normalizeJsonArray(interventions, 'interventions')),
    safeText(notes), maybeUuid(recordedBy, 'recorded_by'),
    recordedAtIso,
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  );
  return rows[0];
}

export async function listPainAssessments({
  tenantId = null, patientUid = null, encounterId = null,
  minScore = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (encounterId) {
    params.push(normalizeId(encounterId, 'encounter_id'));
    filters.push(`encounter_id = $${params.length}`);
  }
  if (minScore !== null && minScore !== undefined) {
    params.push(normalizeNumber(minScore, 'min_score', { min: 0, max: 10 }));
    filters.push(`score >= $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PAIN_RETURNING} FROM pain_assessments
       WHERE ${filters.join(' AND ')}
       ORDER BY recorded_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { assessments: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { assessments: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fall-risk assessments
// ---------------------------------------------------------------------------

const FALL_RETURNING = `id, tenant_id, patient_uid, encounter_id,
  scale, score, risk_level, factors, interventions, notes,
  recorded_by, recorded_at, metadata, created_at, updated_at`;

export async function recordFallRiskAssessment({
  tenantId = null, patientUid, encounterId = null,
  scale, score, riskLevel, factors = null, interventions = null, notes = null,
  recordedBy = null, recordedAt = null, metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanScale = normalizeEnum(scale, FALL_SCALES, 'scale', { required: true });
  const cleanScore = normalizeNumber(score, 'score', { min: 0, max: 200, required: true });
  const cleanRisk = normalizeEnum(riskLevel, FALL_RISK_LEVELS, 'risk_level', { required: true });
  const recordedAtIso = recordedAt ? new Date(String(recordedAt)).toISOString() : null;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO fall_risk_assessments
       (tenant_id, patient_uid, encounter_id, scale, score, risk_level,
        factors, interventions, notes, recorded_by, recorded_at, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::uuid, COALESCE($11::timestamptz, NOW()), $12::jsonb)
     RETURNING ${FALL_RETURNING}`,
    tid, requireUuid(patientUid, 'patient_uid'),
    normalizeId(encounterId, 'encounter_id'),
    cleanScale, Math.round(cleanScore), cleanRisk,
    JSON.stringify(normalizeJsonObject(factors, 'factors')),
    JSON.stringify(normalizeJsonArray(interventions, 'interventions')),
    safeText(notes), maybeUuid(recordedBy, 'recorded_by'),
    recordedAtIso,
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  );
  return rows[0];
}

export async function listFallRiskAssessments({
  tenantId = null, patientUid = null, encounterId = null,
  riskLevel = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (encounterId) {
    params.push(normalizeId(encounterId, 'encounter_id'));
    filters.push(`encounter_id = $${params.length}`);
  }
  if (riskLevel) {
    params.push(normalizeEnum(riskLevel, FALL_RISK_LEVELS, 'risk_level'));
    filters.push(`risk_level = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${FALL_RETURNING} FROM fall_risk_assessments
       WHERE ${filters.join(' AND ')}
       ORDER BY recorded_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { assessments: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { assessments: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Growth charts
// ---------------------------------------------------------------------------

const GROWTH_RETURNING = `id, tenant_id, patient_uid, encounter_id,
  reference_dataset, age_in_days, height_cm, weight_kg,
  head_circumference_cm, mid_upper_arm_circumference_cm, bmi,
  percentiles, z_scores, classification, notes,
  recorded_by, recorded_at, metadata, created_at, updated_at`;

export async function recordGrowthChart({
  tenantId = null, patientUid, encounterId = null,
  referenceDataset, ageInDays,
  heightCm = null, weightKg = null,
  headCircumferenceCm = null, midUpperArmCircumferenceCm = null,
  bmi = null,
  percentiles = null, zScores = null, classification = null, notes = null,
  recordedBy = null, recordedAt = null, metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanRef = normalizeEnum(referenceDataset, GROWTH_DATASETS, 'reference_dataset', { required: true });
  const ageDays = normalizeNumber(ageInDays, 'age_in_days', { min: 0, max: 365 * 25, required: true });
  const cleanClass = classification
    ? normalizeEnum(classification, GROWTH_CLASSIFICATIONS, 'classification')
    : null;
  const recordedAtIso = recordedAt ? new Date(String(recordedAt)).toISOString() : null;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO growth_charts
       (tenant_id, patient_uid, encounter_id, reference_dataset, age_in_days,
        height_cm, weight_kg, head_circumference_cm, mid_upper_arm_circumference_cm,
        bmi, percentiles, z_scores, classification, notes,
        recorded_by, recorded_at, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5,
             $6, $7, $8, $9,
             $10, $11::jsonb, $12::jsonb, $13, $14,
             $15::uuid, COALESCE($16::timestamptz, NOW()), $17::jsonb)
     RETURNING ${GROWTH_RETURNING}`,
    tid, requireUuid(patientUid, 'patient_uid'),
    normalizeId(encounterId, 'encounter_id'),
    cleanRef, Math.round(ageDays),
    normalizeNumber(heightCm, 'height_cm', { min: 0, max: 300 }),
    normalizeNumber(weightKg, 'weight_kg', { min: 0, max: 600 }),
    normalizeNumber(headCircumferenceCm, 'head_circumference_cm', { min: 0, max: 100 }),
    normalizeNumber(midUpperArmCircumferenceCm, 'mid_upper_arm_circumference_cm', { min: 0, max: 100 }),
    normalizeNumber(bmi, 'bmi', { min: 0, max: 200 }),
    JSON.stringify(normalizeJsonObject(percentiles, 'percentiles')),
    JSON.stringify(normalizeJsonObject(zScores, 'z_scores')),
    cleanClass, safeText(notes), maybeUuid(recordedBy, 'recorded_by'),
    recordedAtIso,
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  );
  return rows[0];
}

export async function listGrowthCharts({
  tenantId = null, patientUid = null, encounterId = null,
  referenceDataset = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (encounterId) {
    params.push(normalizeId(encounterId, 'encounter_id'));
    filters.push(`encounter_id = $${params.length}`);
  }
  if (referenceDataset) {
    params.push(normalizeEnum(referenceDataset, GROWTH_DATASETS, 'reference_dataset'));
    filters.push(`reference_dataset = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${GROWTH_RETURNING} FROM growth_charts
       WHERE ${filters.join(' AND ')}
       ORDER BY recorded_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { charts: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { charts: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  PAIN_SCALES, PAIN_CONTEXTS,
  FALL_SCALES, FALL_RISK_LEVELS,
  GROWTH_DATASETS, GROWTH_CLASSIFICATIONS,
};

export default {
  recordPainAssessment,
  listPainAssessments,
  recordFallRiskAssessment,
  listFallRiskAssessments,
  recordGrowthChart,
  listGrowthCharts,
};
