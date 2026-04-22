import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  createTenant,
  getTenantById,
  listTenants,
  updateTenant,
} from '../../services/tenant/tenantService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text.toLowerCase() : null;
}

async function safeAudit(req, action, resourceId, before, after) {
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (uid, role, action, resource, resource_id, metadata, ip_address, user_agent, created_at)
       VALUES ($1::uuid, $2, $3, 'tenant', $4, $5::jsonb, $6, $7, NOW())`,
      uuidOrNull(req.user?.uid),
      req.user?.role || null,
      action,
      String(resourceId),
      JSON.stringify({
        before,
        after,
        actor: {
          uid: req.user?.uid || null,
          role: req.user?.role || null,
        },
      }),
      req.ip || null,
      String(req.headers['user-agent'] || '').slice(0, 500) || null
    );
  } catch (err) {
    logger.warn('Tenant audit write failed', { action, resourceId, error: err?.message });
  }
}

router.get('/', async (req, res, next) => {
  try {
    const result = await listTenants({
      status: req.query.status || null,
      region: req.query.region || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Tenants retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/:tenantId', async (req, res, next) => {
  try {
    const tenant = await getTenantById(req.params.tenantId);
    if (!tenant) return next(Object.assign(new Error('Tenant not found'), { statusCode: 404 }));
    return success(res, tenant, 'Tenant retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const tenant = await createTenant(req.body || {});
    await safeAudit(req, 'TENANT_CREATED', tenant.id, null, tenant);
    return success(res, tenant, 'Tenant created', 201);
  } catch (err) {
    return next(err);
  }
});

router.patch('/:tenantId', async (req, res, next) => {
  try {
    const before = await getTenantById(req.params.tenantId);
    const tenant = await updateTenant(req.params.tenantId, req.body || {});
    await safeAudit(req, 'TENANT_UPDATED', tenant.id, before, tenant);
    return success(res, tenant, 'Tenant updated');
  } catch (err) {
    return next(err);
  }
});

export default router;
