// src/routes/admin/integrationGateRoutes.js
//
// SUPER_ADMIN-only "Integrations & Gates" console read (slate B1), mounted
// under /api/v1/admin/integration-gates (behind the ADMIN role + step-up +
// IP-allowlist stack in app.js; the route-level requireRole narrows it to
// SUPER_ADMIN like the sibling entitlement mutation). Read-only: flips go
// through the existing mutation endpoints, never through this surface.
// Never returns secret values — presence booleans only (enforced in
// integrationGateService, pinned by integrationGateRoutes.test.js).

import express from 'express';
import { markRouterDomain } from '../../config/openapiDomain.js';
import logger from '../../logging/logger.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { listIntegrationGates } from '../../services/integrations/integrationGateService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = markRouterDomain(express.Router(), 'integration');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get('/', requireRole('SUPER_ADMIN'), async (req, res) => {
  const rawTenantId = String(req.query.tenantId || '').trim().toLowerCase();
  if (rawTenantId && !UUID_RE.test(rawTenantId)) {
    return error(res, 'tenantId must be a UUID', 400);
  }
  try {
    const report = await listIntegrationGates({
      tenantId: rawTenantId || null,
      limit: req.query.limit,
    });
    return success(res, report, 'Integration gate states retrieved');
  } catch (err) {
    logger.error(`Integration gates read error: ${err.message}`);
    return error(res, 'Failed to retrieve integration gate states', 500);
  }
});

export default router;
