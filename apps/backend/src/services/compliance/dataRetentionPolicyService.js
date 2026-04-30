/**
 * Data retention policy service (Phase E2).
 *
 * First-class config for how long each table's rows are kept and what
 * happens at expiry (`erase` / `anonymise` / `archive`). Replaces ad-hoc
 * retention constants. Optional FK to a DataProcessingActivity (E1) so
 * the lawful basis is auditable.
 *
 * Erasure / archival jobs (e.g. dataErasureService, the future scheduled
 * sweeps) consult `getRetentionForTable` instead of hard-coded TTLs.
 *
 * Migration 128.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const RETENTION_ACTIONS = ['erase', 'anonymise', 'archive'];
export const RETENTION_STATUSES = ['active', 'paused', 'archived'];

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

function normalizeInt(value, label, { min = null, max = null, required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

const RETURNING = `id, tenant_id, policy_code, applies_to_table, display_name,
  description, retention_days, action, basis, legal_hold_aware,
  data_processing_activity_id, status, metadata, created_by,
  created_at, updated_at`;

export async function upsertDataRetentionPolicy({
  tenantId = null, id = null,
  policyCode, appliesToTable, displayName, description = null,
  retentionDays, action = 'erase', basis,
  legalHoldAware = true,
  dataProcessingActivityId = null,
  status = 'active', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(policyCode, 80);
  if (!cleanCode) throw AppError.badRequest('policy_code is required');
  const cleanTable = safeText(appliesToTable, 120);
  if (!cleanTable) throw AppError.badRequest('applies_to_table is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const days = normalizeInt(retentionDays, 'retention_days', { min: 0, max: 365 * 200, required: true });
  const cleanAction = normalizeEnum(action, RETENTION_ACTIONS, 'action') || 'erase';
  const cleanBasis = safeText(basis);
  if (!cleanBasis) throw AppError.badRequest('basis is required');
  const cleanStatus = normalizeEnum(status, RETENTION_STATUSES, 'status') || 'active';
  const dpaId = dataProcessingActivityId
    ? normalizeId(dataProcessingActivityId, 'data_processing_activity_id')
    : null;

  try {
    if (id) {
      const policyId = normalizeId(id, 'data_retention_policy id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE data_retention_policies SET
           policy_code = $1, applies_to_table = $2, display_name = $3,
           description = $4, retention_days = $5, action = $6,
           basis = $7, legal_hold_aware = $8,
           data_processing_activity_id = $9,
           status = $10, metadata = $11::jsonb, updated_at = NOW()
         WHERE id = $12 AND tenant_id = $13::uuid
         RETURNING ${RETURNING}`,
        cleanCode, cleanTable, cleanName, safeText(description),
        days, cleanAction, cleanBasis,
        normalizeBoolean(legalHoldAware, true),
        dpaId, cleanStatus,
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
        policyId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Data retention policy not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO data_retention_policies
         (tenant_id, policy_code, applies_to_table, display_name, description,
          retention_days, action, basis, legal_hold_aware,
          data_processing_activity_id, status, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::uuid)
       RETURNING ${RETURNING}`,
      tid, cleanCode, cleanTable, cleanName, safeText(description),
      days, cleanAction, cleanBasis,
      normalizeBoolean(legalHoldAware, true),
      dpaId, cleanStatus,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('policy_code or applies_to_table collides for this tenant');
    throw err;
  }
}

export async function listDataRetentionPolicies({
  tenantId = null, status = null, action = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, RETENTION_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (action) {
    params.push(normalizeEnum(action, RETENTION_ACTIONS, 'action'));
    filters.push(`action = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${RETURNING} FROM data_retention_policies
       WHERE ${filters.join(' AND ')}
       ORDER BY applies_to_table
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { policies: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { policies: [], count: 0 };
    throw err;
  }
}

/**
 * Lookup the active retention policy for a given table.
 * Returns null if no active policy exists or schema is missing.
 */
export async function getRetentionForTable({ tenantId = null, appliesToTable } = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTable = safeText(appliesToTable, 120);
  if (!cleanTable) throw AppError.badRequest('applies_to_table is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${RETURNING} FROM data_retention_policies
       WHERE tenant_id = $1::uuid AND applies_to_table = $2 AND status = 'active'
       LIMIT 1`,
      tid, cleanTable,
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function archiveRetentionPolicy({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const policyId = normalizeId(id, 'data_retention_policy id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE data_retention_policies
     SET status = 'archived', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status <> 'archived'
     RETURNING ${RETURNING}`,
    policyId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Data retention policy not found or already archived');
  return rows[0];
}

export const __testing__ = { RETENTION_ACTIONS, RETENTION_STATUSES };

export default {
  upsertDataRetentionPolicy,
  listDataRetentionPolicies,
  getRetentionForTable,
  archiveRetentionPolicy,
};
