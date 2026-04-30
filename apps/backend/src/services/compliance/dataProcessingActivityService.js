/**
 * DataProcessingActivity service (Phase E1).
 *
 * Article 30 GDPR record of processing activities. Every formal
 * processing activity (patient registration, lab orders, billing,
 * etc.) gets one row recording purpose, lawful basis, retention,
 * cross-border transfers and DPIA status.
 *
 * Migration 127.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const LAWFUL_BASES = [
  'consent', 'contract', 'legal_obligation',
  'vital_interests', 'public_task', 'legitimate_interests',
];
export const DPA_STATUSES = ['active', 'paused', 'archived'];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
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

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
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

function normalizeStringArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be an array of strings`);
  }
  return value.map((entry) => safeText(entry, SHORT_MAX)).filter(Boolean);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

const RETURNING = `id, tenant_id, activity_code, display_name, description,
  purposes, data_subject_categories, personal_data_categories, special_category_data,
  recipient_categories, cross_border_transfers, cross_border_destinations,
  cross_border_safeguards, retention_period_days, retention_basis, security_measures,
  lawful_basis, legitimate_interests_assessment,
  dpia_required, dpia_completed_at, dpia_reference,
  status, metadata, created_by, created_at, updated_at`;

export async function upsertDataProcessingActivity({
  tenantId = null, id = null,
  activityCode, displayName, description = null,
  purposes,
  dataSubjectCategories = null, personalDataCategories = null, specialCategoryData = null,
  recipientCategories = null,
  crossBorderTransfers = false, crossBorderDestinations = null, crossBorderSafeguards = null,
  retentionPeriodDays = null, retentionBasis = null,
  securityMeasures = null,
  lawfulBasis,
  legitimateInterestsAssessment = null,
  dpiaRequired = false, dpiaCompletedAt = null, dpiaReference = null,
  status = 'active', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(activityCode, 80);
  if (!cleanCode) throw AppError.badRequest('activity_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanPurposes = safeText(purposes);
  if (!cleanPurposes) throw AppError.badRequest('purposes is required');
  const cleanLawful = normalizeEnum(lawfulBasis, LAWFUL_BASES, 'lawful_basis', { required: true });
  const dpiaCompletedIso = dpiaCompletedAt ? new Date(String(dpiaCompletedAt)).toISOString() : null;

  const args = [
    cleanCode, cleanName, safeText(description),
    cleanPurposes,
    normalizeStringArray(dataSubjectCategories, 'data_subject_categories'),
    normalizeStringArray(personalDataCategories, 'personal_data_categories'),
    normalizeStringArray(specialCategoryData, 'special_category_data'),
    normalizeStringArray(recipientCategories, 'recipient_categories'),
    normalizeBoolean(crossBorderTransfers, false),
    normalizeStringArray(crossBorderDestinations, 'cross_border_destinations'),
    safeText(crossBorderSafeguards),
    normalizeInt(retentionPeriodDays, 'retention_period_days', { min: 0, max: 365 * 200 }),
    safeText(retentionBasis),
    safeText(securityMeasures),
    cleanLawful,
    safeText(legitimateInterestsAssessment),
    normalizeBoolean(dpiaRequired, false),
    dpiaCompletedIso,
    safeText(dpiaReference, SHORT_MAX),
    normalizeEnum(status, DPA_STATUSES, 'status') || 'active',
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];

  try {
    if (id) {
      const dpaId = normalizeId(id, 'data_processing_activity id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE data_processing_activities SET
           activity_code = $1, display_name = $2, description = $3,
           purposes = $4,
           data_subject_categories = $5, personal_data_categories = $6, special_category_data = $7,
           recipient_categories = $8,
           cross_border_transfers = $9, cross_border_destinations = $10, cross_border_safeguards = $11,
           retention_period_days = $12, retention_basis = $13,
           security_measures = $14,
           lawful_basis = $15,
           legitimate_interests_assessment = $16,
           dpia_required = $17, dpia_completed_at = $18::timestamptz, dpia_reference = $19,
           status = $20, metadata = $21::jsonb, updated_at = NOW()
         WHERE id = $22 AND tenant_id = $23::uuid
         RETURNING ${RETURNING}`,
        ...args, dpaId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Data processing activity not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO data_processing_activities
         (tenant_id, activity_code, display_name, description, purposes,
          data_subject_categories, personal_data_categories, special_category_data,
          recipient_categories,
          cross_border_transfers, cross_border_destinations, cross_border_safeguards,
          retention_period_days, retention_basis, security_measures,
          lawful_basis, legitimate_interests_assessment,
          dpia_required, dpia_completed_at, dpia_reference,
          status, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::timestamptz, $20, $21, $22::jsonb, $23::uuid)
       RETURNING ${RETURNING}`,
      tid, ...args, maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('activity_code already exists for this tenant');
    throw err;
  }
}

export async function listDataProcessingActivities({
  tenantId = null, status = null, lawfulBasis = null,
  dpiaRequired = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, DPA_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (lawfulBasis) {
    params.push(normalizeEnum(lawfulBasis, LAWFUL_BASES, 'lawful_basis'));
    filters.push(`lawful_basis = $${params.length}`);
  }
  if (dpiaRequired !== null) {
    params.push(normalizeBoolean(dpiaRequired));
    filters.push(`dpia_required = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${RETURNING} FROM data_processing_activities
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { activities: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { activities: [], count: 0 };
    throw err;
  }
}

export async function getDataProcessingActivity({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const dpaId = normalizeId(id, 'data_processing_activity id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${RETURNING} FROM data_processing_activities
       WHERE id = $1 AND tenant_id = $2::uuid`,
      dpaId, tid,
    );
    if (!rows[0]) throw AppError.notFound('Data processing activity not found');
    return rows[0];
  } catch (err) {
    if (isMissingSchemaError(err)) throw AppError.notFound('Data processing activity not found');
    throw err;
  }
}

export async function archiveDataProcessingActivity({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const dpaId = normalizeId(id, 'data_processing_activity id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE data_processing_activities
     SET status = 'archived', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status <> 'archived'
     RETURNING ${RETURNING}`,
    dpaId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Data processing activity not found or already archived');
  return rows[0];
}

export const __testing__ = { LAWFUL_BASES, DPA_STATUSES };

export default {
  upsertDataProcessingActivity,
  listDataProcessingActivities,
  getDataProcessingActivity,
  archiveDataProcessingActivity,
};
