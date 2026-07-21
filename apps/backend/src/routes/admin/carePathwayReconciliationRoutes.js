import express from 'express';

import { listPathwayReconciliationEvidence } from '../../services/pathways/pathwayReconciliationReadService.js';
import { AppError } from '../../utils/AppError.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();
const ALLOWED_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

function role(req) {
  return String(req.user?.rawRole || req.user?.role || '').trim().toUpperCase();
}

function requireAdmin(req, _res, next) {
  if (!ALLOWED_ROLES.has(role(req))) {
    return next(AppError.forbidden('Admin access required', 'ADMIN_ACCESS_REQUIRED'));
  }
  if (req.get('x-tenant-id') && role(req) !== 'SUPER_ADMIN') {
    return next(AppError.forbidden('Admin access required', 'ADMIN_ACCESS_REQUIRED'));
  }
  return next();
}

function rejectQueryTenant(req) {
  if (req.query.tenant_id !== undefined || req.query.tenantId !== undefined) {
    throw AppError.badRequest(
      'Use the audited SUPER_ADMIN x-tenant-id override for cross-tenant access',
      'PATHWAY_RECONCILIATION_TENANT_QUERY_FORBIDDEN',
    );
  }
}

async function list(req, res, next, view) {
  try {
    rejectQueryTenant(req);
    const data = await listPathwayReconciliationEvidence({
      tenantId: req.tenantId,
      pathwayKey: req.query.pathway_key,
      view,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return success(res, data, 'Care pathway reconciliation evidence retrieved');
  } catch (error) {
    return next(error);
  }
}

router.use(requireAdmin);
router.get('/', (req, res, next) => list(req, res, next, 'latest'));
router.get('/history', (req, res, next) => list(req, res, next, 'history'));

export default router;
