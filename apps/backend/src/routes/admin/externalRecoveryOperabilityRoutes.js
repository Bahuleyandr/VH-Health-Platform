import express from 'express';

import { markRouterDomain } from '../../config/openapiDomain.js';
import { ADMIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import {
  authorizeResume,
  listWorkbench,
  registerOffset
} from '../../controllers/downtime/externalRecoveryOperabilityController.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';

const router = markRouterDomain(express.Router(), 'downtime');

// Reassert the closed technical-admin set at the exact command surface even
// though /api/v1/admin already carries the same authenticated control plane.
router.use(requireRole(...ADMIN_ROUTE_ROLES));

router.get('/workbench', listWorkbench);
router.post('/offsets', registerOffset);
router.post('/offsets/:offsetId/resume-authorizations', authorizeResume);

export default router;
