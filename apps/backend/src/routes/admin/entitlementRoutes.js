import express from 'express';
import logger from '../../logging/logger.js';
import {
  getEntitlementCatalog,
  getTenantEntitlementSummary,
  listEntitlementAuditEvents,
  upsertTenantEntitlement
} from '../../services/entitlements/entitlementService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeTenantId(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  return UUID_RE.test(value) ? value : null;
}

function parseOptionalDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

router.get('/catalog', async (_req, res) => {
  try {
    const catalog = await getEntitlementCatalog();
    return success(
      res,
      {
        packages: catalog.packages,
        features: catalog.features
      },
      'Entitlement catalog retrieved'
    );
  } catch (err) {
    logger.error(`Entitlement catalog error: ${err.message}`);
    return error(res, 'Failed to retrieve entitlement catalog', 500);
  }
});

router.get('/current', async (req, res) => {
  try {
    const summary = await getTenantEntitlementSummary(req.tenantId);
    return success(res, summary, 'Current tenant entitlement summary retrieved');
  } catch (err) {
    logger.error(`Current entitlement summary error: ${err.message}`);
    return error(res, 'Failed to retrieve current tenant entitlement summary', 500);
  }
});

router.get('/tenants/:tenantId', async (req, res) => {
  const tenantId = normalizeTenantId(req.params.tenantId);
  if (!tenantId) return error(res, 'Valid tenantId is required', 400);

  try {
    const summary = await getTenantEntitlementSummary(tenantId);
    return success(res, summary, 'Tenant entitlement summary retrieved');
  } catch (err) {
    logger.error(`Tenant entitlement summary error: ${err.message}`);
    return error(res, 'Failed to retrieve tenant entitlement summary', 500);
  }
});

router.put('/tenants/:tenantId', async (req, res) => {
  const tenantId = normalizeTenantId(req.params.tenantId);
  if (!tenantId) return error(res, 'Valid tenantId is required', 400);

  try {
    const body = req.body || {};
    const row = await upsertTenantEntitlement({
      tenantId,
      packageKey: String(body.packageKey || body.package_key || '').trim(),
      status: String(body.status || 'active').trim(),
      expiresAt: parseOptionalDate(body.expiresAt ?? body.expires_at),
      graceEndsAt: parseOptionalDate(body.graceEndsAt ?? body.grace_ends_at),
      source: String(body.source || 'admin').trim(),
      actorUid: req.user?.uid || null,
      actorRole: req.user?.rawRole || req.user?.role || null,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
    });
    return success(res, row, 'Tenant entitlement updated');
  } catch (err) {
    logger.error(`Tenant entitlement update error: ${err.message}`);
    return error(
      res,
      err.statusCode && err.statusCode < 500 ? err.message : 'Failed to update tenant entitlement',
      err.statusCode || 500,
      err.details
    );
  }
});

router.get('/tenants/:tenantId/audit', async (req, res) => {
  const tenantId = normalizeTenantId(req.params.tenantId);
  if (!tenantId) return error(res, 'Valid tenantId is required', 400);

  try {
    const events = await listEntitlementAuditEvents(tenantId, { limit: req.query.limit });
    return success(res, events, 'Tenant entitlement audit events retrieved');
  } catch (err) {
    logger.error(`Tenant entitlement audit list error: ${err.message}`);
    return error(res, 'Failed to retrieve tenant entitlement audit events', 500);
  }
});

export default router;
