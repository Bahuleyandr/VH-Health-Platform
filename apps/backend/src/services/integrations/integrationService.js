/**
 * Integration registry CRUD (Phase A3 PR1).
 *
 * Manages the top-level integrations table — one row per
 * (tenant, vendor) pairing — plus a writeIntegrationLog helper used
 * by every other piece of the integration stack to land audit rows.
 *
 * Credentials, subscriptions, deliveries, and mappings each have their
 * own service file; they all reference integrations.id.
 *
 * Decision-support only: the registry never auto-emits webhooks. The
 * dispatcher in PR2 polls event_outbox + webhook_subscriptions and
 * writes to webhook_deliveries; admins inspect / pause / replay
 * through the admin routes.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

export const INTEGRATION_STATUSES = ['active', 'paused', 'failed', 'archived'];

export const LOG_TYPES = [
  'config_change', 'auth_refresh', 'webhook_send', 'webhook_receive',
  'mapping_sync', 'health_check', 'error',
];

export const LOG_SEVERITIES = ['debug', 'info', 'warn', 'error'];

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const NAME_MAX = 160;
const DESC_MAX = 4000;
const TYPE_MAX = 80;

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max) {
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

function normalizeStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (!INTEGRATION_STATUSES.includes(text)) {
    throw AppError.badRequest(
      `status must be one of: ${INTEGRATION_STATUSES.join(', ')}`,
    );
  }
  return text;
}

function normalizeJsonObject(value, label) {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createIntegration({
  tenantId = null,
  name,
  description = null,
  integrationType,
  config = {},
  metadata = {},
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanName = safeText(name, NAME_MAX);
  if (!cleanName) throw AppError.badRequest('name is required');
  const cleanType = safeText(integrationType, TYPE_MAX);
  if (!cleanType) throw AppError.badRequest('integration_type is required');
  const cleanDesc = safeText(description, DESC_MAX);
  const cleanConfig = normalizeJsonObject(config, 'config');
  const cleanMetadata = normalizeJsonObject(metadata, 'metadata');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO integrations
         (tenant_id, name, description, integration_type, status,
          config, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, 'active', $5::jsonb, $6::jsonb, $7::uuid)
       RETURNING id, tenant_id, name, description, integration_type,
                 status, config, metadata, created_by, created_at, updated_at`,
      tid, cleanName, cleanDesc, cleanType,
      JSON.stringify(cleanConfig), JSON.stringify(cleanMetadata), createdBy,
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(`An integration named "${cleanName}" already exists for this tenant`);
    }
    throw err;
  }
}

export async function listIntegrations({
  tenantId = null,
  status = null,
  integrationType = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  const normalizedStatus = status ? normalizeStatus(status) : null;
  if (normalizedStatus) {
    params.push(normalizedStatus);
    filters.push(`status = $${params.length}`);
  }
  if (integrationType) {
    params.push(safeText(integrationType, TYPE_MAX));
    filters.push(`integration_type = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, name, description, integration_type, status,
              config, metadata, created_by, created_at, updated_at,
              (SELECT COUNT(*)::int
                 FROM webhook_subscriptions ws
                WHERE ws.integration_id = i.id
                  AND ws.tenant_id = i.tenant_id
                  AND ws.is_active = true) AS active_subscription_count
       FROM integrations i
       WHERE ${filters.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { integrations: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { integrations: [], count: 0 };
    throw err;
  }
}

export async function getIntegration({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const intId = normalizeId(id, 'integration id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, name, description, integration_type, status,
            config, metadata, created_by, created_at, updated_at,
            (SELECT COUNT(*)::int
               FROM webhook_subscriptions ws
              WHERE ws.integration_id = i.id
                AND ws.tenant_id = i.tenant_id
                AND ws.is_active = true) AS active_subscription_count,
            (SELECT COUNT(*)::int
               FROM integration_credentials ic
              WHERE ic.integration_id = i.id
                AND ic.tenant_id = i.tenant_id) AS credential_count
     FROM integrations i
     WHERE i.id = $1 AND i.tenant_id = $2::uuid
     LIMIT 1`,
    intId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Integration not found');
  return rows[0];
}

export async function updateIntegration({
  tenantId = null,
  id,
  name = undefined,
  description = undefined,
  integrationType = undefined,
  status = undefined,
  config = undefined,
  metadata = undefined,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const intId = normalizeId(id, 'integration id');
  const updates = [];
  const params = [];
  if (name !== undefined) {
    const v = safeText(name, NAME_MAX);
    if (!v) throw AppError.badRequest('name cannot be empty');
    params.push(v);
    updates.push(`name = $${params.length}`);
  }
  if (description !== undefined) {
    params.push(safeText(description, DESC_MAX));
    updates.push(`description = $${params.length}`);
  }
  if (integrationType !== undefined) {
    const v = safeText(integrationType, TYPE_MAX);
    if (!v) throw AppError.badRequest('integration_type cannot be empty');
    params.push(v);
    updates.push(`integration_type = $${params.length}`);
  }
  if (status !== undefined) {
    params.push(normalizeStatus(status));
    updates.push(`status = $${params.length}`);
  }
  if (config !== undefined) {
    params.push(JSON.stringify(normalizeJsonObject(config, 'config')));
    updates.push(`config = $${params.length}::jsonb`);
  }
  if (metadata !== undefined) {
    params.push(JSON.stringify(normalizeJsonObject(metadata, 'metadata')));
    updates.push(`metadata = $${params.length}::jsonb`);
  }
  if (!updates.length) {
    return getIntegration({ tenantId: tid, id: intId });
  }
  updates.push('updated_at = NOW()');
  params.push(intId);
  params.push(tid);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE integrations
       SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
       RETURNING id, tenant_id, name, description, integration_type, status,
                 config, metadata, created_by, created_at, updated_at`,
      ...params,
    );
    if (!rows[0]) throw AppError.notFound('Integration not found');
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict('An integration with that name already exists for this tenant');
    }
    throw err;
  }
}

export async function archiveIntegration({ tenantId = null, id } = {}) {
  return updateIntegration({ tenantId, id, status: 'archived' });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/**
 * Append-only event log per integration. Best-effort: never throws on
 * schema-missing or DB-down so failed log writes don't cascade into
 * the caller's flow.
 */
export async function writeIntegrationLog({
  tenantId = null,
  integrationId = null,
  logType,
  severity = 'info',
  message = null,
  payload = {},
} = {}) {
  if (!LOG_TYPES.includes(String(logType))) {
    throw AppError.badRequest(`log_type must be one of: ${LOG_TYPES.join(', ')}`);
  }
  if (!LOG_SEVERITIES.includes(String(severity))) {
    throw AppError.badRequest(`severity must be one of: ${LOG_SEVERITIES.join(', ')}`);
  }
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO integration_logs
         (tenant_id, integration_id, log_type, severity, message, payload)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, tenant_id, integration_id, log_type, severity, message, payload, created_at`,
      tid, integrationId ? Number.parseInt(integrationId, 10) : null,
      logType, severity, safeText(message, 4000),
      JSON.stringify(payload || {}),
    );
    return rows[0];
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.warn('integration_logs insert failed', { error: err.message });
    return null;
  }
}

export async function listIntegrationLogs({
  tenantId = null,
  integrationId = null,
  severity = null,
  logType = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (integrationId) {
    params.push(normalizeId(integrationId, 'integration id'));
    filters.push(`integration_id = $${params.length}`);
  }
  if (severity) {
    if (!LOG_SEVERITIES.includes(String(severity))) {
      throw AppError.badRequest(`severity must be one of: ${LOG_SEVERITIES.join(', ')}`);
    }
    params.push(severity);
    filters.push(`severity = $${params.length}`);
  }
  if (logType) {
    if (!LOG_TYPES.includes(String(logType))) {
      throw AppError.badRequest(`log_type must be one of: ${LOG_TYPES.join(', ')}`);
    }
    params.push(logType);
    filters.push(`log_type = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, integration_id, log_type, severity, message, payload, created_at
       FROM integration_logs
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { logs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { logs: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  INTEGRATION_STATUSES,
  LOG_SEVERITIES,
  LOG_TYPES,
};

export default {
  archiveIntegration,
  createIntegration,
  getIntegration,
  listIntegrations,
  listIntegrationLogs,
  updateIntegration,
  writeIntegrationLog,
};
