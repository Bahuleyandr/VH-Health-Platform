import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  createTenant,
  getTenantById,
  listTenants,
  updateTenant,
} from '../../services/tenant/tenantService.js';
import {
  listInteropSecretsForTenant,
  upsertInteropSecret,
} from '../../services/interop/tenantInteropSecretService.js';
import {
  getAdminNHCXConfig,
  updateNHCXConfigForTenant,
  upsertNHCXSecret,
} from '../../services/nhcx/nhcxTenantConfigService.js';
import {
  getTenantKekRewrapJob,
  startTenantKekRewrapJob,
} from '../../services/security/tenantKekRewrapService.js';
import {
  getTenantBrandKit,
  updateTenantBrandKit,
} from '../../services/tenant/brandKitService.js';
import {
  getEscalationRecipientRankings,
  replaceEscalationRecipientRankings,
} from '../../services/workflow/escalationRecipientRankingService.js';
import { success } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';

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

async function requireTenant(tenantId) {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw AppError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
  return tenant;
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

router.get('/:tenantId/interop-secrets', async (req, res, next) => {
  try {
    await requireTenant(req.params.tenantId);
    const secrets = await listInteropSecretsForTenant(req.params.tenantId);
    return success(res, { secrets, count: secrets.length }, 'Interop secrets retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/:tenantId/brand-kit', async (req, res, next) => {
  try {
    const tenant = await requireTenant(req.params.tenantId);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const brandKit = await getTenantBrandKit(req.params.tenantId, { tenant, baseUrl });
    return success(res, { brandKit }, 'Tenant brand kit retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/:tenantId/brand-kit', async (req, res, next) => {
  try {
    const before = await getTenantBrandKit(req.params.tenantId);
    const brandKit = await updateTenantBrandKit(req.params.tenantId, req.body || {});
    if (!brandKit) throw AppError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
    await safeAudit(req, 'TENANT_BRAND_KIT_UPDATED', req.params.tenantId, before, brandKit);
    return success(res, { brandKit }, 'Tenant brand kit updated');
  } catch (err) {
    return next(err);
  }
});

router.post('/:tenantId/interop-secrets', async (req, res, next) => {
  try {
    await requireTenant(req.params.tenantId);
    const row = await upsertInteropSecret({
      tenantId: req.params.tenantId,
      kind: req.body?.kind,
      senderIdentifier: req.body?.senderIdentifier ?? req.body?.sender_identifier,
      secret: req.body?.secret,
    });
    await safeAudit(req, 'TENANT_INTEROP_SECRET_UPSERTED', req.params.tenantId, null, {
      id: row?.id,
      kind: row?.kind,
      sender_identifier: row?.sender_identifier,
      status: row?.status,
      has_secret: row?.has_secret === true,
    });
    return success(res, row, 'Interop secret stored', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/:tenantId/escalation-recipient-rankings', async (req, res, next) => {
  try {
    const ranking = await getEscalationRecipientRankings(req.params.tenantId);
    return success(res, ranking, 'Escalation recipient rankings retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/:tenantId/escalation-recipient-rankings', async (req, res, next) => {
  try {
    const ranking = await replaceEscalationRecipientRankings({
      tenantId: req.params.tenantId,
      mappings: req.body?.mappings,
      presenceWindowMinutes: req.body?.presenceWindowMinutes,
      actorUid: req.user?.uid,
      actorRole: req.user?.rawRole || req.user?.role,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return success(res, ranking, 'Escalation recipient rankings replaced');
  } catch (err) {
    return next(err);
  }
});

router.get('/:tenantId/nhcx-config', async (req, res, next) => {
  try {
    await requireTenant(req.params.tenantId);
    const result = await getAdminNHCXConfig(req.params.tenantId);
    return success(res, result, 'NHCX configuration retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/:tenantId/nhcx-config', async (req, res, next) => {
  try {
    await requireTenant(req.params.tenantId);
    const before = await getAdminNHCXConfig(req.params.tenantId);
    const config = await updateNHCXConfigForTenant(req.params.tenantId, req.body || {});
    await safeAudit(req, 'TENANT_NHCX_CONFIG_UPDATED', req.params.tenantId, before.config, config);
    return success(res, config, 'NHCX configuration updated');
  } catch (err) {
    return next(err);
  }
});

router.post('/:tenantId/nhcx-secrets', async (req, res, next) => {
  try {
    await requireTenant(req.params.tenantId);
    const row = await upsertNHCXSecret({
      tenantId: req.params.tenantId,
      kind: req.body?.kind,
      participantCode: req.body?.participantCode ?? req.body?.participant_code,
      secret: req.body?.secret,
    });
    await safeAudit(req, 'TENANT_NHCX_SECRET_UPSERTED', req.params.tenantId, null, {
      id: row?.id,
      kind: row?.kind,
      sender_identifier: row?.sender_identifier,
      status: row?.status,
      has_secret: row?.has_secret === true,
    });
    return success(res, row, 'NHCX secret stored', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/:tenantId/kek-rotation-jobs', async (req, res, next) => {
  try {
    await requireTenant(req.params.tenantId);
    const job = startTenantKekRewrapJob({
      tenantId: req.params.tenantId,
      requestedBy: req.user?.uid || null,
    });
    await safeAudit(req, 'TENANT_KEK_REWRAP_JOB_STARTED', req.params.tenantId, null, {
      job_id: job.job_id,
      status: job.status,
      requested_by: job.requested_by,
    });
    return success(res, job, 'Tenant KEK re-wrap job queued', 202);
  } catch (err) {
    return next(err);
  }
});

router.get('/:tenantId/kek-rotation-jobs/:jobId', async (req, res, next) => {
  try {
    await requireTenant(req.params.tenantId);
    const job = getTenantKekRewrapJob({
      tenantId: req.params.tenantId,
      jobId: req.params.jobId,
    });
    return success(res, job, 'Tenant KEK re-wrap job retrieved');
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
