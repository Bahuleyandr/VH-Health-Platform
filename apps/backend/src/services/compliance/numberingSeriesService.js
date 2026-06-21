/**
 * Numbering series service (Phase E2).
 *
 * First-class per-tenant counters with printf-style format templates.
 * Replaces ad-hoc `COUNT(*)+1` patterns. The atomic bump uses
 * `UPDATE ... SET current_value = current_value + 1 RETURNING` so
 * concurrent callers never collide.
 *
 * Supported format placeholders:
 *   {YYYY}, {YY}, {MM}, {DD}, {SEQ}
 * Example: format_template `INV-{YYYY}-{SEQ}`, padding 6 → `INV-2026-000042`
 *
 * Migration 128.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const SHORT_MAX = 255;

export const NS_STATUSES = ['active', 'paused', 'archived'];
export const RESET_CADENCES = ['never', 'yearly', 'monthly', 'daily'];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max = SHORT_MAX) {
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

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

const RETURNING = `id, tenant_id, code, display_name, format_template,
  current_value, starting_value, padding, reset_cadence, last_reset_at,
  status, metadata, created_at, updated_at`;

export async function upsertNumberingSeries({
  tenantId = null, id = null,
  code, displayName, formatTemplate,
  startingValue = 0, padding = 0,
  resetCadence = 'never', status = 'active', metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(code, 80);
  if (!cleanCode) throw AppError.badRequest('code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanTpl = safeText(formatTemplate, 120);
  if (!cleanTpl) throw AppError.badRequest('format_template is required');
  const start = normalizeInt(startingValue, 'starting_value', { min: 0, max: 1_000_000_000_000 }) || 0;
  const pad = normalizeInt(padding, 'padding', { min: 0, max: 20 }) || 0;
  const cadence = normalizeEnum(resetCadence, RESET_CADENCES, 'reset_cadence') || 'never';
  const cleanStatus = normalizeEnum(status, NS_STATUSES, 'status') || 'active';

  try {
    if (id) {
      const seriesId = normalizeId(id, 'numbering_series id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE numbering_series SET
           code = $1, display_name = $2, format_template = $3,
           starting_value = $4, padding = $5, reset_cadence = $6,
           status = $7, metadata = $8::jsonb, updated_at = NOW()
         WHERE id = $9 AND tenant_id = $10::uuid
         RETURNING ${RETURNING}`,
        cleanCode, cleanName, cleanTpl, start, pad, cadence, cleanStatus,
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
        seriesId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Numbering series not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO numbering_series
         (tenant_id, code, display_name, format_template,
          current_value, starting_value, padding, reset_cadence,
          status, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $5, $6, $7, $8, $9::jsonb)
       RETURNING ${RETURNING}`,
      tid, cleanCode, cleanName, cleanTpl, start, pad, cadence, cleanStatus,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('code already exists for this tenant');
    throw err;
  }
}

function applyFormat(template, seq, padding, now = new Date()) {
  const yyyy = String(now.getUTCFullYear());
  const yy = yyyy.slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const seqText = padding > 0
    ? String(seq).padStart(padding, '0')
    : String(seq);
  return template
    .replaceAll('{YYYY}', yyyy)
    .replaceAll('{YY}', yy)
    .replaceAll('{MM}', mm)
    .replaceAll('{DD}', dd)
    .replaceAll('{SEQ}', seqText);
}

function isResetDue(cadence, lastResetAt, now = new Date()) {
  if (cadence === 'never' || !lastResetAt) return cadence !== 'never' && !lastResetAt;
  const last = new Date(lastResetAt);
  if (cadence === 'yearly') return last.getUTCFullYear() !== now.getUTCFullYear();
  if (cadence === 'monthly') {
    return last.getUTCFullYear() !== now.getUTCFullYear()
      || last.getUTCMonth() !== now.getUTCMonth();
  }
  if (cadence === 'daily') {
    return last.getUTCFullYear() !== now.getUTCFullYear()
      || last.getUTCMonth() !== now.getUTCMonth()
      || last.getUTCDate() !== now.getUTCDate();
  }
  return false;
}

/**
 * Atomically bump the counter and return the formatted next number.
 * Concurrent callers do not collide because the UPDATE...RETURNING is
 * row-locking; the cadence reset is also atomic in the same UPDATE.
 */
export async function getNextNumber({ tenantId = null, code, now = new Date() } = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(code, 80);
  if (!cleanCode) throw AppError.badRequest('code is required');

  const series = await prisma.$queryRawUnsafe(
    `SELECT ${RETURNING} FROM numbering_series
     WHERE tenant_id = $1::uuid AND code = $2 AND status = 'active'`,
    tid, cleanCode,
  );
  if (!series[0]) throw AppError.notFound(`Numbering series not found or paused: ${cleanCode}`);
  const row = series[0];

  const resetDue = isResetDue(row.reset_cadence, row.last_reset_at, now);
  const updateSql = resetDue
    ? `UPDATE numbering_series
         SET current_value = $1::bigint + 1,
             last_reset_at = NOW(),
             updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3::uuid
         RETURNING current_value`
    : `UPDATE numbering_series
         SET current_value = current_value + 1,
             updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING current_value`;
  const updateArgs = resetDue
    ? [Number(row.starting_value), row.id, tid]
    : [row.id, tid];

  const updated = await prisma.$queryRawUnsafe(updateSql, ...updateArgs);
  if (!updated[0]) throw AppError.notFound('Numbering series disappeared mid-bump');
  const seq = Number(updated[0].current_value);
  const formatted = applyFormat(row.format_template, seq, row.padding, now);

  return {
    code: cleanCode,
    sequence: seq,
    formatted,
    series_id: row.id,
  };
}

export async function listNumberingSeries({
  tenantId = null, status = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, NS_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${RETURNING} FROM numbering_series
       WHERE ${filters.join(' AND ')}
       ORDER BY code
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { series: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { series: [], count: 0 };
    throw err;
  }
}

export const __testing__ = { applyFormat, isResetDue, NS_STATUSES, RESET_CADENCES };

export default {
  upsertNumberingSeries,
  getNextNumber,
  listNumberingSeries,
};
