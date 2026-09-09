import { requireTenantId } from '../../services/tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { relayAppError } from '../../utils/responseHelper.js';

export function requestTenantId(req) {
  const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId || req.tenant?.id;
  if (!tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  return requireTenantId(tenantId);
}

export function requireStaffAdminTenant(req, res, next) {
  try {
    requestTenantId(req);
    return next();
  } catch (err) {
    return relayAppError(res, err);
  }
}
