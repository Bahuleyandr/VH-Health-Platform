import express from 'express';

import rbacConfig from '../../config/rbacConfig.js';
import {
  getClientReadiness,
  getFacilityClientReadiness,
} from '../../controllers/health/clientReadinessController.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import { getRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import tenantContextMiddleware from '../../middleware/tenantContextMiddleware.js';
import tenantRlsMiddleware from '../../middleware/tenantRlsMiddleware.js';
import validateApiKey from '../../middleware/validateApiKey.js';

const router = express.Router();

router.get(
  '/client-readiness',
  validateApiKey,
  jwtAuth,
  tenantContextMiddleware,
  tenantRlsMiddleware,
  requireRole(...rbacConfig.clientReadinessRoutes),
  getRateLimiter('clientReadiness'),
  getClientReadiness,
);

router.post(
  '/client-readiness/v2',
  validateApiKey,
  jwtAuth,
  tenantContextMiddleware,
  tenantRlsMiddleware,
  requireRole(...rbacConfig.staffRoutes),
  getRateLimiter('clientReadiness'),
  getFacilityClientReadiness,
);

export default router;
